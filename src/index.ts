/**
 * mic-to-mp3 root entrypoint.
 *
 * Backward-compatible root exports include the React hook plus the new
 * framework-agnostic controller API.
 *
 * For environment-specific imports:
 * - `mic-to-mp3/core` (no React dependency)
 * - `mic-to-mp3/react` (hook-focused)
 *
 * @module mic-to-mp3
 */

export { useVoiceRecorder } from "./use-voice-recorder";
export { createVoiceRecorder, VoiceRecorder } from "./voice-recorder-core";
export { DEFAULTS } from "./constants";

export type {
  RecordingMetadata,
  VoiceRecorderController,
  VoiceRecorderHook,
  VoiceRecorderOptions,
  VoiceRecorderState,
} from "./types";
