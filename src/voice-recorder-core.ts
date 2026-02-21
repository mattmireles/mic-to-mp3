/**
 * Framework-agnostic voice recorder core.
 *
 * This module contains the full recording lifecycle with no React dependency.
 * The React hook in `./use-voice-recorder.ts` is a thin adapter over this core.
 *
 * Primary pipeline:
 * 1. `getUserMedia()` acquires microphone stream
 * 2. `MediaRecorder` captures browser-native chunks for robust fallback decoding
 * 3. Web Audio captures live PCM and streams it to an incremental MP3 encoder
 * 4. On stop, live encoder flushes immediately when available
 * 5. If live path fails, fallback decodes MediaRecorder chunks then one-shot encodes
 *
 * Why dual capture (MediaRecorder + Web Audio)?
 * - Live PCM path minimizes stop latency via incremental encoding
 * - MediaRecorder path preserves compatibility on browsers where live PCM capture
 *   is unavailable or unstable
 *
 * @module mic-to-mp3/voice-recorder-core
 */

import { DEFAULTS } from "./constants";
import { decodeToPcm } from "./decode-pcm";
import { createMp3EncodeSession, encodeToMp3 } from "./encode-worker";
import type { IncrementalMp3EncoderSession } from "./encode-main-thread";
import { detectRecorderMimeType } from "./recorder-mime";
import type {
  RecordingMetadata,
  VoiceRecorderController,
  VoiceRecorderOptions,
  VoiceRecorderState,
} from "./types";

/** Number of analyser bars exposed for UI visualizations. */
const ANALYSER_BAR_COUNT = 40;

/** Analyser FFT size (must be power of 2). */
const ANALYSER_FFT_SIZE = 128;

/** Smoothing factor for analyser frequency output. */
const ANALYSER_SMOOTHING = 0.6;

/**
 * Throttle visualizer updates to 15 FPS.
 *
 * React or framework UI layers don't benefit from 60 FPS state churn for a
 * simple audio meter. 15 FPS is visually smooth enough and significantly
 * reduces allocations/re-renders.
 */
const LEVEL_UPDATE_INTERVAL_MS = 66;

/** Poll interval for elapsed time UI and max-duration enforcement. */
const ELAPSED_POLL_MS = 250;

/** MediaRecorder chunk cadence for fallback blob capture. */
const RECORDER_TIMESLICE_MS = 1000;

/**
 * ScriptProcessorNode buffer size.
 *
 * 4096 balances CPU overhead and message frequency while recording speech.
 */
const PROCESSOR_BUFFER_SIZE = 4096;

/** Default recorder state before any recording starts. */
const INITIAL_STATE: VoiceRecorderState = {
  isRecording: false,
  isProcessing: false,
  elapsed: 0,
  error: null,
  audioLevels: [],
};

/**
 * Create a framework-agnostic recorder controller.
 *
 * @example
 * ```ts
 * const recorder = createVoiceRecorder({
 *   onRecordingComplete: (mp3Data, metadata) => {
 *     // upload bytes, play blob, etc.
 *   },
 * });
 *
 * await recorder.start();
 * recorder.stop();
 * recorder.destroy();
 * ```
 */
export function createVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorderController {
  return new VoiceRecorder(options);
}

/**
 * Vanilla recorder controller implementation.
 *
 * Exposes `subscribe()` so UI frameworks can bind state without coupling core
 * logic to any specific rendering model.
 */
export class VoiceRecorder implements VoiceRecorderController {
  private state: VoiceRecorderState = { ...INITIAL_STATE };
  private options: VoiceRecorderOptions;
  private readonly listeners = new Set<(state: VoiceRecorderState) => void>();

  /** Stop/start race-condition guard. */
  private stopInProgress = false;
  private destroyed = false;

  /** Active MediaRecorder and stream. */
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;

  /** MediaRecorder fallback artifacts. */
  private recordingChunks: Blob[] = [];
  private recordingMimeType = "audio/webm";

  /** Live incremental encoding state. */
  private liveEncoderSession: IncrementalMp3EncoderSession | null = null;
  private livePcmFrameCount = 0;
  private liveCaptureSampleRate = 0;

  /**
   * Tracks whether live capture was successfully started.
   * If false, stop-time processing uses MediaRecorder decode fallback.
   */
  private liveCaptureActive = false;

  /** Timer state for elapsed duration updates and max-duration checks. */
  private startTimeMs = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /** Audio graph nodes for analyser + live PCM capture. */
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silentGainNode: GainNode | null = null;
  private analyserFrameId = 0;
  private lastLevelUpdateAt = 0;

  /** Ensures stop finalization runs at most once per recording. */
  private finalizePromise: Promise<void> | null = null;

  constructor(options: VoiceRecorderOptions) {
    this.options = options;
  }

  updateOptions(options: VoiceRecorderOptions): void {
    this.options = options;
  }

  getState(): VoiceRecorderState {
    return {
      ...this.state,
      audioLevels: [...this.state.audioLevels],
    };
  }

  subscribe(listener: (state: VoiceRecorderState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  clearError = (): void => {
    this.setState({ error: null });
  };

  toggleRecording = async (): Promise<void> => {
    if (this.state.isRecording) {
      this.stop();
      return;
    }

    await this.start();
  };

  start = async (): Promise<void> => {
    if (
      this.destroyed ||
      this.state.isRecording ||
      this.state.isProcessing ||
      this.stopInProgress
    ) {
      return;
    }

    const mediaDevices =
      typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

    if (!mediaDevices?.getUserMedia) {
      this.setState({
        error: "Microphone recording is not supported in this environment.",
      });
      return;
    }

    this.setState({ error: null, elapsed: 0 });
    this.recordingChunks = [];
    this.recordingMimeType = "audio/webm";
    this.livePcmFrameCount = 0;
    this.liveCaptureSampleRate = 0;
    this.liveCaptureActive = false;

    let stream: MediaStream | null = null;

    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
      if (this.destroyed) {
        this.releaseStream(stream);
        return;
      }

      this.stream = stream;
      this.setState({ isRecording: true, isProcessing: false, elapsed: 0, error: null });
      this.startElapsedTimer();

      const hasMediaRecorder = this.startMediaRecorder(stream);

      if (!hasMediaRecorder) {
        await this.startAudioPipeline(stream);
        if (!this.liveCaptureActive) {
          throw new Error(
            "This browser does not support the required audio recording features."
          );
        }
      } else {
        /**
         * Live PCM capture is optional when MediaRecorder fallback is available.
         * Failure here should not block recording.
         */
        void this.startAudioPipeline(stream).catch(() => {
          /* live path is best-effort when fallback recorder is active */
        });
      }
    } catch (error) {
      if (stream) {
        this.releaseStream(stream);
      }

      this.stopElapsedTimer();
      this.stopAudioPipeline();
      this.closeEncoderSession();
      this.mediaRecorder = null;
      this.stopInProgress = false;
      this.setState({ isRecording: false, isProcessing: false });

      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.setState({
          error: "Microphone access denied. Please allow mic access and try again.",
        });
      } else if (error instanceof Error && error.message) {
        this.setState({ error: error.message });
      } else {
        this.setState({ error: "Could not access microphone." });
      }
    }
  };

  stop = (): void => {
    if (this.destroyed || !this.state.isRecording || this.stopInProgress) {
      return;
    }

    this.stopInProgress = true;
    this.setState({ isRecording: false, isProcessing: true });
    this.stopElapsedTimer();
    this.stopAudioPipeline();

    const recorder = this.mediaRecorder;
    if (!recorder) {
      void this.finalizeRecording();
      return;
    }

    if (recorder.state !== "recording") {
      this.mediaRecorder = null;
      void this.finalizeRecording();
      return;
    }

    try {
      recorder.stop();
    } catch {
      this.mediaRecorder = null;
      void this.finalizeRecording();
    }
  };

  destroy = (): void => {
    if (this.destroyed) return;

    this.destroyed = true;
    this.stopInProgress = false;

    this.stopElapsedTimer();
    this.stopAudioPipeline();
    this.closeEncoderSession();

    const recorder = this.mediaRecorder;
    if (recorder && recorder.state === "recording") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* best-effort cleanup */
      }
    }
    this.mediaRecorder = null;

    this.releaseStream();
    this.listeners.clear();
  };

  /**
   * Merge partial state and notify subscribers.
   */
  private setState(partial: Partial<VoiceRecorderState>): void {
    if (this.destroyed) return;

    this.state = {
      ...this.state,
      ...partial,
    };

    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /**
   * Start MediaRecorder fallback capture.
   *
   * Returns `true` when MediaRecorder capture started successfully.
   * Returns `false` when MediaRecorder is unavailable in this environment.
   */
  private startMediaRecorder(stream: MediaStream): boolean {
    if (typeof MediaRecorder === "undefined") {
      return false;
    }

    const mimeType = detectRecorderMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    this.recordingMimeType = recorder.mimeType || mimeType || "audio/webm";
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.recordingChunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      this.mediaRecorder = null;
      void this.finalizeRecording();
    };

    recorder.start(RECORDER_TIMESLICE_MS);
    return true;
  }

  /**
   * Start elapsed timer and max-duration auto-stop checks.
   */
  private startElapsedTimer(): void {
    const { maxDuration = DEFAULTS.MAX_DURATION_SEC } = this.options;

    this.stopElapsedTimer();
    this.startTimeMs = Date.now();

    this.elapsedTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTimeMs) / 1000);
      if (elapsed !== this.state.elapsed) {
        this.setState({ elapsed });
      }

      if (elapsed >= maxDuration) {
        this.stop();
      }
    }, ELAPSED_POLL_MS);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  /**
   * Build Web Audio graph for both:
   * - analyser visualization (`audioLevels`)
   * - live PCM capture -> incremental MP3 encoding
   */
  private async startAudioPipeline(stream: MediaStream): Promise<void> {
    try {
      const {
        sampleRate = DEFAULTS.SAMPLE_RATE,
        bitrate = DEFAULTS.TARGET_BITRATE,
      } = this.options;

      const audioContext = new AudioContext({ sampleRate });
      this.audioContext = audioContext;

      /**
       * iOS Safari often starts AudioContext suspended even after a user gesture.
       * Resume best-effort so analyser/processor callbacks receive data.
       */
      void audioContext.resume().catch(() => {});

      const source = audioContext.createMediaStreamSource(stream);
      this.sourceNode = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
      source.connect(analyser);
      this.analyserNode = analyser;

      this.startAnalyserLoop(analyser);

      const createScriptProcessor =
        audioContext.createScriptProcessor?.bind(audioContext) ??
        (audioContext as AudioContext & {
          createJavaScriptNode?: AudioContext["createScriptProcessor"];
        }).createJavaScriptNode?.bind(audioContext);

      if (!createScriptProcessor) {
        return;
      }

      const encoderSession = await createMp3EncodeSession(
        audioContext.sampleRate,
        sampleRate,
        bitrate
      );

      if (!this.state.isRecording || this.destroyed || this.stopInProgress) {
        encoderSession.close();
        return;
      }

      this.liveEncoderSession = encoderSession;
      this.liveCaptureSampleRate = audioContext.sampleRate;

      const processor = createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      this.processorNode = processor;

      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      this.silentGainNode = silentGain;

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.state.isRecording || this.stopInProgress || this.destroyed) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        if (input.length === 0) return;

        const chunk = new Float32Array(input.length);
        chunk.set(input);

        this.livePcmFrameCount += chunk.length;
        this.liveEncoderSession?.appendPcm(chunk);
      };

      this.liveCaptureActive = true;
    } catch {
      /**
       * Live path is best-effort.
       * Recording can still succeed through MediaRecorder + decode fallback.
       */
      this.liveCaptureActive = false;
    }
  }

  /**
   * Start analyser render loop with frame-rate throttling.
   */
  private startAnalyserLoop(analyser: AnalyserNode): void {
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    this.lastLevelUpdateAt = 0;

    const tick = () => {
      if (this.destroyed || !this.analyserNode) {
        return;
      }

      const now = Date.now();
      if (now - this.lastLevelUpdateAt >= LEVEL_UPDATE_INTERVAL_MS) {
        analyser.getByteFrequencyData(freqData);
        this.setState({
          audioLevels: Array.from(freqData.subarray(0, ANALYSER_BAR_COUNT)),
        });
        this.lastLevelUpdateAt = now;
      }

      this.analyserFrameId = requestAnimationFrame(tick);
    };

    this.analyserFrameId = requestAnimationFrame(tick);
  }

  /**
   * Stop and tear down the Web Audio graph.
   */
  private stopAudioPipeline(): void {
    if (this.analyserFrameId) {
      cancelAnimationFrame(this.analyserFrameId);
      this.analyserFrameId = 0;
    }

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {
        /* best-effort cleanup */
      }
      this.processorNode = null;
    }

    if (this.silentGainNode) {
      try {
        this.silentGainNode.disconnect();
      } catch {
        /* best-effort cleanup */
      }
      this.silentGainNode = null;
    }

    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        /* best-effort cleanup */
      }
      this.analyserNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* best-effort cleanup */
      }
      this.sourceNode = null;
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.setState({ audioLevels: [] });
  }

  /**
   * Finalize recording output.
   *
   * Priority order:
   * 1. Flush live incremental encoder if active and has data
   * 2. Fallback to MediaRecorder blob -> decode -> one-shot encode
   */
  private async finalizeRecording(): Promise<void> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }

    this.finalizePromise = this.runFinalizeRecording().finally(() => {
      this.finalizePromise = null;
    });

    return this.finalizePromise;
  }

  private async runFinalizeRecording(): Promise<void> {
    const {
      onRecordingComplete,
      sampleRate = DEFAULTS.SAMPLE_RATE,
      bitrate = DEFAULTS.TARGET_BITRATE,
      maxSizeBytes = DEFAULTS.MAX_SIZE_BYTES,
    } = this.options;

    let mp3Data: Uint8Array | null = null;
    let metadata: RecordingMetadata | null = null;

    try {
      if (this.liveEncoderSession && this.livePcmFrameCount > 0) {
        try {
          mp3Data = await this.liveEncoderSession.flush();
          const duration =
            this.liveCaptureSampleRate > 0
              ? Math.round(this.livePcmFrameCount / this.liveCaptureSampleRate)
              : 0;

          metadata = {
            durationSec: duration,
            sizeBytes: mp3Data.byteLength,
            mimeType: "audio/mpeg",
          };
        } catch {
          mp3Data = null;
          metadata = null;
        }
      }

      if (!mp3Data) {
        if (this.recordingChunks.length === 0) {
          this.setState({ error: "Recording too short. Hold for at least one second." });
          return;
        }

        const recordingBlob = new Blob(this.recordingChunks, {
          type: this.recordingMimeType || "audio/webm",
        });

        let decoded:
          | {
              channelData: Float32Array;
              sampleRate: number;
              durationSec: number;
            }
          | undefined;

        try {
          decoded = await decodeToPcm(recordingBlob, sampleRate);
        } catch {
          this.setState({
            error: "Couldn't decode recording. Try again or use a different browser.",
          });
          return;
        }

        mp3Data = await encodeToMp3(
          decoded.channelData,
          decoded.sampleRate,
          sampleRate,
          bitrate
        );

        metadata = {
          durationSec: decoded.durationSec,
          sizeBytes: mp3Data.byteLength,
          mimeType: "audio/mpeg",
        };
      }

      if (mp3Data.byteLength > maxSizeBytes) {
        this.setState({ error: "Recording is too large. Try a shorter message." });
        return;
      }

      if (!metadata) {
        throw new Error("Recording metadata was not created.");
      }

      /**
       * `destroy()` is treated as terminal cancellation for vanilla and React
       * adapters. If teardown happens while async finalize work is in flight,
       * do not invoke user callbacks after destruction.
       */
      if (this.destroyed) {
        return;
      }

      onRecordingComplete(mp3Data, metadata);
      this.setState({ error: null });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process recording";
      this.setState({ error: message });
    } finally {
      this.recordingChunks = [];
      this.stopInProgress = false;
      this.closeEncoderSession();
      this.releaseStream();
      this.setState({ isProcessing: false });
    }
  }

  /**
   * Stop active tracks and clear `this.stream` when appropriate.
   */
  private releaseStream(stream?: MediaStream | null): void {
    const target = stream ?? this.stream;
    if (!target) return;

    target.getTracks().forEach((track) => track.stop());

    if (!stream || this.stream === stream) {
      this.stream = null;
    }
  }

  /**
   * Close and drop active live encoder session.
   */
  private closeEncoderSession(): void {
    if (this.liveEncoderSession) {
      this.liveEncoderSession.close();
      this.liveEncoderSession = null;
    }
    this.liveCaptureActive = false;
    this.livePcmFrameCount = 0;
    this.liveCaptureSampleRate = 0;
  }
}
