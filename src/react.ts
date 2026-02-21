/**
 * React-focused entrypoint for mic-to-mp3.
 *
 * Import from `mic-to-mp3/react` for hook-only usage.
 *
 * @module mic-to-mp3/react
 */

export { useVoiceRecorder } from "./use-voice-recorder";
export { DEFAULTS } from "./constants";

export type {
  RecordingMetadata,
  VoiceRecorderHook,
  VoiceRecorderOptions,
  VoiceRecorderState,
} from "./types";
