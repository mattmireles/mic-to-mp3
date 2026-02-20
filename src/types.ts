/**
 * Public TypeScript interfaces for mic-to-mp3.
 *
 * These types define the contract between the library and its consumers.
 * They are re-exported from `./index.ts` as the package's public API surface.
 *
 * Used by:
 * - `useVoiceRecorder()` in `./use-voice-recorder.ts` — implements these interfaces
 * - External consumers — for type-safe usage of the hook
 *
 * @module mic-to-mp3/types
 */

/**
 * Configuration options for the voice recorder.
 * All fields are optional — sensible defaults are provided.
 */
export interface VoiceRecorderOptions {
  /**
   * Called when recording is complete and MP3 encoding is finished.
   * Receives the raw MP3 bytes and metadata about the recording.
   */
  onRecordingComplete: (mp3Data: Uint8Array, metadata: RecordingMetadata) => void;

  /**
   * Max recording duration in seconds. Recording auto-stops at this limit.
   * @default 600 (10 minutes)
   */
  maxDuration?: number;

  /**
   * Max MP3 file size in bytes. If the encoded MP3 exceeds this, an error is raised.
   * @default 26214400 (25MB)
   */
  maxSizeBytes?: number;

  /**
   * MP3 encoding bitrate in kbps.
   * @default 64
   */
  bitrate?: number;

  /**
   * Target sample rate in Hz. AudioContext will resample to this rate before encoding.
   * @default 44100
   */
  sampleRate?: number;
}

/**
 * Metadata about the completed recording.
 */
export interface RecordingMetadata {
  /** Duration in whole seconds (rounded from AudioBuffer.duration). */
  durationSec: number;
  /** MP3 file size in bytes. */
  sizeBytes: number;
  /** MIME type — always "audio/mpeg". */
  mimeType: "audio/mpeg";
}

/**
 * Return value of the useVoiceRecorder hook.
 */
export interface VoiceRecorderHook {
  /** True while the MediaRecorder is capturing audio. */
  isRecording: boolean;
  /** True during the decode → encode pipeline after recording stops. */
  isProcessing: boolean;
  /** Elapsed recording time in seconds. */
  elapsed: number;
  /** User-friendly error message, or null. */
  error: string | null;
  /** Live frequency data (0–255 per bar) from the microphone. Empty when not recording. */
  audioLevels: number[];
  /** Start or stop recording. */
  toggleRecording: () => void;
  /** Clear the current error message. */
  clearError: () => void;
}
