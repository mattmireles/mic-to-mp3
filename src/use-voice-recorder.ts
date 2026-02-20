/**
 * React hook for browser voice recording with MP3 transcoding.
 *
 * This is the primary public API of the library. Consumers import `useVoiceRecorder`
 * from the package entry point (`./index.ts`). The hook orchestrates the full
 * recording lifecycle:
 *
 * 1. `navigator.mediaDevices.getUserMedia()` — mic capture
 * 2. `MediaRecorder` — records audio chunks (prefers webm/opus via `./recorder-mime.ts`)
 * 3. `decodeToPcm()` from `./decode-pcm.ts` — decodes blob to Float32 PCM via AudioContext
 * 4. `encodeToMp3()` from `./encode-worker.ts` — encodes PCM to MP3 via Web Worker
 *    (falls back to main-thread encoding automatically)
 * 5. Calls the consumer's `onRecordingComplete` callback with the MP3 Uint8Array
 *
 * Called by:
 * - External consumers via the package's public API
 * - Re-exported from `./index.ts`
 *
 * STATE LIFECYCLE:
 *
 * React state (useState) — drives UI rendering:
 * - `isRecording`: false → true (on start) → false (on stop or unmount)
 * - `isProcessing`: false → true (on stop, during decode+encode) → false (on complete/error)
 * - `elapsed`: 0 → incremented every ELAPSED_POLL_MS while recording → 0 on next start
 * - `error`: null → error string (on failure) → null (on next attempt or clearError)
 * - `audioLevels`: [] → 40-bin frequency array (while recording) → [] (on stop)
 *
 * Ref state (useRef) — mutable across renders without triggering re-render:
 * - `mediaRecorderRef`: null → MediaRecorder (on start) → null (after onstop fires)
 * - `streamRef`: null → MediaStream (on start) → null (after releaseStream)
 * - `stopInProgressRef`: false → true (stop begins) → false (after onstop or error).
 *   Guards against double-stop race conditions if the user clicks stop rapidly.
 * - `startTimeRef`: 0 → Date.now() (recording starts). Used by the elapsed timer.
 * - `timerRef`: null → setInterval handle (on start) → null (on stop or unmount)
 * - `mountedRef`: true (on mount) → false (on unmount). Prevents setState after unmount.
 * - `audioContextRef`: null → AudioContext (analyser start) → null (analyser stop)
 * - `animFrameRef`: 0 → requestAnimationFrame ID (during recording) → 0 (on stop)
 *
 * @module web-voice-recorder-to-mp3/use-voice-recorder
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { DEFAULTS } from "./constants";
import type { VoiceRecorderOptions, VoiceRecorderHook } from "./types";
import { detectRecorderMimeType } from "./recorder-mime";
import { decodeToPcm } from "./decode-pcm";
import { encodeToMp3 } from "./encode-worker";

/** Number of frequency bins sampled from the AnalyserNode for the waveform visualizer. */
const ANALYSER_BAR_COUNT = 40;

/** AnalyserNode FFT size — must be a power of 2. 128 → 64 frequency bins (we take 40). */
const ANALYSER_FFT_SIZE = 128;

/**
 * AnalyserNode smoothing constant for live waveform visualization.
 *
 * Range: 0.0 (no smoothing, raw FFT) to 1.0 (maximum smoothing, slow response).
 * 0.6 provides moderate smoothing that reduces visual jitter while staying
 * responsive to changes in the user's voice. Values below 0.4 are too jittery;
 * above 0.8 feel sluggish and lag behind actual speech.
 */
const ANALYSER_SMOOTHING = 0.6;

/**
 * Elapsed-time poll interval in milliseconds.
 *
 * 250ms = 4 UI updates per second. Fast enough to feel responsive,
 * slow enough to avoid excessive React re-renders. Also used to check
 * whether maxDuration has been reached.
 */
const ELAPSED_POLL_MS = 250;

/**
 * MediaRecorder.start() timeslice in milliseconds.
 *
 * Fires ondataavailable every 1 second. Shorter slices increase event overhead
 * and GC pressure. Longer slices delay data availability and slow error
 * detection if encoding fails mid-recording.
 */
const RECORDER_TIMESLICE_MS = 1000;

/**
 * Record audio from the user's microphone and transcode it to MP3.
 *
 * @example
 * ```tsx
 * const recorder = useVoiceRecorder({
 *   onRecordingComplete: (mp3Data, metadata) => {
 *     // Upload mp3Data, play it back, store it - your call.
 *     const blob = new Blob([mp3Data], { type: "audio/mpeg" });
 *     console.log(`Got ${metadata.durationSec}s MP3, ${metadata.sizeBytes} bytes`);
 *   },
 *   maxDuration: 120,  // optional: 2 minutes max
 *   bitrate: 128,      // optional: higher quality
 * });
 *
 * return (
 *   <button onClick={recorder.toggleRecording}>
 *     {recorder.isRecording ? "Stop" : "Record"}
 *   </button>
 * );
 * ```
 */
export function useVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorderHook {
  const {
    onRecordingComplete,
    maxDuration = DEFAULTS.MAX_DURATION_SEC,
    maxSizeBytes = DEFAULTS.MAX_SIZE_BYTES,
    bitrate = DEFAULTS.TARGET_BITRATE,
    sampleRate = DEFAULTS.SAMPLE_RATE,
  } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>([]);

  /** Active MediaRecorder. null → MediaRecorder (on start) → null (after onstop). */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  /** Active mic MediaStream. null → MediaStream (on start) → null (after releaseStream). */
  const streamRef = useRef<MediaStream | null>(null);
  /**
   * Double-stop race condition guard.
   * Prevents processRecording from firing twice if the user clicks stop rapidly.
   * false → true (stop begins) → false (after onstop fires or error).
   */
  const stopInProgressRef = useRef(false);
  /** Recording start timestamp (Date.now()). Used by the elapsed-time interval. */
  const startTimeRef = useRef<number>(0);
  /** Handle for the elapsed-time setInterval. null when not recording. */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Component mount status. true on mount, false on unmount.
   * All async callbacks check this before calling setState to prevent
   * React "setState on unmounted component" warnings.
   */
  const mountedRef = useRef(true);

  /** Web Audio nodes for live frequency analysis. Separate from the MediaRecorder pipeline. */
  const audioContextRef = useRef<AudioContext | null>(null);
  /** requestAnimationFrame handle for the analyser loop. 0 when inactive. */
  const animFrameRef = useRef<number>(0);

  /**
   * Stop all tracks for a stream. If no stream is provided, stops the current active stream.
   */
  const releaseStream = useCallback((stream?: MediaStream | null) => {
    const targetStream = stream ?? streamRef.current;
    if (!targetStream) return;

    targetStream.getTracks().forEach((track) => track.stop());

    if (streamRef.current === targetStream) {
      streamRef.current = null;
    }
  }, []);

  /**
   * Starts live frequency analysis from the mic stream.
   * Creates an AudioContext -> MediaStreamSource -> AnalyserNode pipeline,
   * then pumps frequency data into `audioLevels` state via requestAnimationFrame.
   * This is purely for visualization - it does not affect the MediaRecorder capture.
   */
  const startAnalyser = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      /**
       * iOS Safari starts AudioContext in "suspended" state. The user gesture
       * that triggered toggleRecording() is lost after the async getUserMedia()
       * call, so the context won't auto-resume. This fire-and-forget resume()
       * unlocks the audio graph so getByteFrequencyData() returns real data
       * instead of all zeros. No-ops on browsers that don't suspend.
       */
      void ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
      source.connect(analyser);

      audioContextRef.current = ctx;

      const freqData = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!mountedRef.current) return;
        analyser.getByteFrequencyData(freqData);
        setAudioLevels(Array.from(freqData.slice(0, ANALYSER_BAR_COUNT)));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    } catch {
      /* AnalyserNode is best-effort; visualization degrades gracefully */
    }
  }, []);

  /** Tears down the analyser pipeline and clears audio levels. */
  const stopAnalyser = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setAudioLevels([]);
  }, []);

  /**
   * Gracefully stop the active MediaRecorder.
   *
   * Guards against double-stop via `stopInProgressRef`. When the recorder stops,
   * its `onstop` handler (wired in `toggleRecording`) fires `processRecording`
   * to begin the decode → encode pipeline.
   *
   * Called by:
   * - `toggleRecording()` when the user clicks stop
   * - The elapsed-time effect when `maxDuration` is reached
   *
   * Triggers:
   * - `recorder.stop()` → `recorder.onstop` → `processRecording()`
   * - On error: sets user-facing error message and cleans up refs
   */
  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording" || stopInProgressRef.current) return;

    stopInProgressRef.current = true;
    setIsProcessing(true);
    setIsRecording(false);
    stopAnalyser();

    try {
      recorder.stop();
    } catch {
      stopInProgressRef.current = false;
      setIsProcessing(false);
      setError("Couldn't stop recording. Please try again.");
      mediaRecorderRef.current = null;
      releaseStream();
    }
  }, [releaseStream, stopAnalyser]);

  /**
   * Run the full decode → encode → validate pipeline after recording stops.
   *
   * Called exclusively by the `recorder.onstop` handler (wired in `toggleRecording`).
   *
   * Pipeline:
   * 1. Assemble chunks into a Blob
   * 2. `decodeToPcm()` from `./decode-pcm.ts` — decode to Float32 PCM via AudioContext
   * 3. `encodeToMp3()` from `./encode-worker.ts` — encode to MP3 via Web Worker
   * 4. Validate MP3 size against `maxSizeBytes`
   * 5. Call `onRecordingComplete` with the MP3 Uint8Array and metadata
   *
   * Error handling: each step can fail independently. Decode failures show a
   * browser-specific message; size violations show a user-friendly limit message;
   * all other errors are caught and surfaced via the `error` state.
   *
   * @param chunks - Blob array accumulated from MediaRecorder.ondataavailable events
   * @param mimeType - MIME type used by MediaRecorder (e.g. "audio/webm;codecs=opus")
   */
  const processRecording = useCallback(async (chunks: Blob[], mimeType: string) => {
    if (mountedRef.current) {
      setIsProcessing(true);
      setError(null);
    }

    try {
      if (chunks.length === 0) {
        if (mountedRef.current) {
          setError("Recording too short. Hold for at least one second.");
        }
        return;
      }

      const audioBlob = new Blob(chunks, { type: mimeType || "audio/webm" });

      let channelData: Float32Array;
      let decodedSampleRate: number;
      let durationSec: number;
      try {
        const decoded = await decodeToPcm(audioBlob, sampleRate);
        channelData = decoded.channelData;
        decodedSampleRate = decoded.sampleRate;
        durationSec = decoded.durationSec;
      } catch {
        if (mountedRef.current) {
          setError("Couldn't decode recording. Try again or use a different browser.");
        }
        return;
      }
      if (!mountedRef.current) return;

      const mp3Data = await encodeToMp3(channelData, decodedSampleRate, sampleRate, bitrate);
      if (!mountedRef.current) return;

      if (mp3Data.byteLength > maxSizeBytes) {
        if (mountedRef.current) {
          setError("Recording is too large. Try a shorter message.");
        }
        return;
      }

      onRecordingComplete(mp3Data, {
        durationSec,
        sizeBytes: mp3Data.byteLength,
        mimeType: "audio/mpeg",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to process recording";
      if (mountedRef.current) {
        setError(message);
      }
    } finally {
      stopInProgressRef.current = false;
      if (mountedRef.current) {
        setIsProcessing(false);
      }
    }
  }, [onRecordingComplete, sampleRate, bitrate, maxSizeBytes]);

  useEffect(() => {
    /**
     * Keep mountedRef accurate under React Strict Mode.
     * In development, React runs effect cleanup immediately after first mount.
     * Without resetting to true here, mountedRef stays false forever and async
     * pipeline early-returns after decode, leaving "Processing..." stuck on screen.
     */
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      stopInProgressRef.current = false;

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      stopAnalyser();

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        /**
         * Unmount should release mic resources immediately and must not trigger
         * post-stop processing callbacks for a component that no longer exists.
         */
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          /* best-effort cleanup */
        }
      }
      mediaRecorderRef.current = null;
      releaseStream();
    };
  }, [releaseStream, stopAnalyser]);

  useEffect(() => {
    if (isRecording) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsed(sec);
        if (sec >= maxDuration) {
          stopRecording();
        }
      }, ELAPSED_POLL_MS);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRecording, maxDuration, stopRecording]);

  /**
   * Start or stop recording — the main user-facing action.
   *
   * When starting:
   * 1. Requests mic access via `navigator.mediaDevices.getUserMedia()`
   * 2. Detects best MIME type via `detectRecorderMimeType()` from `./recorder-mime.ts`
   * 3. Creates MediaRecorder, wires `ondataavailable` and `onstop` handlers
   * 4. Starts the analyser pipeline for live waveform visualization
   *
   * When stopping:
   * - Delegates to `stopRecording()`
   *
   * Error handling:
   * - `NotAllowedError` (DOMException): user denied mic permission → specific message
   * - Other errors: generic mic access failure message
   * - If component unmounts during getUserMedia: stream is released, no state updates
   */
  const toggleRecording = useCallback(async () => {
    if (isProcessing || stopInProgressRef.current) return;

    if (isRecording) {
      stopRecording();
      return;
    }

    setError(null);
    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        releaseStream(stream);
        return;
      }

      const mimeType = detectRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const recordingChunks: Blob[] = [];
      const recordingMimeType = recorder.mimeType || mimeType || "audio/webm";

      mediaRecorderRef.current = recorder;
      streamRef.current = stream;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordingChunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        mediaRecorderRef.current = null;
        releaseStream(streamRef.current ?? stream);
        void processRecording(recordingChunks, recordingMimeType);
      };

      recorder.start(RECORDER_TIMESLICE_MS);
      startAnalyser(stream);
      setElapsed(0);
      setIsRecording(true);
    } catch (err) {
      if (stream) {
        releaseStream(stream);
      }
      stopInProgressRef.current = false;
      setIsProcessing(false);
      if (!mountedRef.current) return;

      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone access denied. Please allow mic access and try again.");
      } else {
        setError("Could not access microphone.");
      }
    }
  }, [isRecording, isProcessing, stopRecording, startAnalyser, processRecording, releaseStream]);

  const clearError = useCallback(() => setError(null), []);

  return {
    isRecording,
    isProcessing,
    elapsed,
    error,
    audioLevels,
    toggleRecording,
    clearError,
  };
}
