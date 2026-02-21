/**
 * Public TypeScript interfaces for mic-to-mp3.
 *
 * These types define the contract between the library and its consumers.
 * They are re-exported from:
 * - `./index.ts` for backward-compatible package root imports
 * - `./core.ts` for framework-agnostic imports
 * - `./react.ts` for hook-only imports
 *
 * Used by:
 * - `VoiceRecorder` in `./voice-recorder-core.ts` — implements controller/state contracts
 * - `useVoiceRecorder()` in `./use-voice-recorder.ts` — adapts controller state to React
 * - External consumers — for type-safe usage of either API
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
 * Shared recorder state used by both the vanilla controller and the React hook.
 *
 * State transitions are driven by `VoiceRecorder` in `./voice-recorder-core.ts`
 * and observed via:
 * - `subscribe()` on `VoiceRecorderController` (vanilla usage)
 * - `useVoiceRecorder()` state updates (React usage)
 */
export interface VoiceRecorderState {
  /** True while microphone capture is active. */
  isRecording: boolean;
  /** True while final decode/encode/flush work is running. */
  isProcessing: boolean;
  /** Elapsed recording time in seconds. */
  elapsed: number;
  /** User-friendly error message, or null. */
  error: string | null;
  /** Live frequency data (0-255 per bar) for optional waveform visualization. */
  audioLevels: number[];
}

/**
 * Framework-agnostic recorder controller API.
 *
 * Created by:
 * - `createVoiceRecorder()` in `./voice-recorder-core.ts`
 *
 * Consumed by:
 * - Vanilla JS apps directly
 * - `useVoiceRecorder()` in `./use-voice-recorder.ts` as a thin adapter
 */
export interface VoiceRecorderController {
  /**
   * Start microphone capture.
   * No-op if already recording or currently processing.
   */
  start: () => Promise<void>;

  /**
   * Stop recording and begin finalization.
   * No-op if not currently recording.
   */
  stop: () => void;

  /**
   * Convenience toggle for start/stop behavior.
   */
  toggleRecording: () => Promise<void>;

  /**
   * Clear the current error message.
   */
  clearError: () => void;

  /**
   * Tear down all resources (timers, streams, AudioContext, workers).
   * Must be called when a vanilla consumer is done with the recorder.
   */
  destroy: () => void;

  /**
   * Update options without recreating the controller.
   * Primarily used by the React adapter to keep callbacks current.
   */
  updateOptions: (options: VoiceRecorderOptions) => void;

  /**
   * Read the current recorder state snapshot.
   */
  getState: () => VoiceRecorderState;

  /**
   * Subscribe to state changes.
   *
   * @param listener - Called after every internal state update
   * @returns Unsubscribe function
   */
  subscribe: (listener: (state: VoiceRecorderState) => void) => () => void;
}

/**
 * Return value of the `useVoiceRecorder()` React hook.
 */
export interface VoiceRecorderHook extends VoiceRecorderState {
  /** Start or stop recording. */
  toggleRecording: () => void;
  /** Clear the current error message. */
  clearError: () => void;
}
