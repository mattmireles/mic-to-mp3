/**
 * Framework-agnostic entrypoint for mic-to-mp3.
 *
 * Import from `mic-to-mp3/core` when you want to avoid a React dependency.
 *
 * @module mic-to-mp3/core
 */

export { createVoiceRecorder, VoiceRecorder } from "./voice-recorder-core";
export { DEFAULTS } from "./constants";

export type {
  RecordingMetadata,
  VoiceRecorderController,
  VoiceRecorderOptions,
  VoiceRecorderState,
} from "./types";
