/**
 * React hook for browser voice recording with MP3 transcoding.
 *
 * Manages the full lifecycle: mic capture -> decode -> encode (Web Worker) -> callback.
 * Encoding runs off the main thread via Web Worker with automatic fallback to
 * main-thread encoding if the worker can't be created.
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

/** AnalyserNode FFT size - must be a power of 2. 128 -> 64 frequency bins (we take 40). */
const ANALYSER_FFT_SIZE = 128;

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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopInProgressRef = useRef(false);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  /** Web Audio nodes for live frequency analysis. Separate from the MediaRecorder pipeline. */
  const audioContextRef = useRef<AudioContext | null>(null);
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
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
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
      }, 250);
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

      recorder.start(1000);
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
