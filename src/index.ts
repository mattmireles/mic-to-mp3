/**
 * web-voice-recorder-to-mp3
 *
 * Record audio in the browser, transcode to MP3 off the main thread, get bytes.
 *
 * Pipeline: getUserMedia -> MediaRecorder -> AudioContext.decodeAudioData -> lamejs (Web Worker) -> Uint8Array
 *
 * @example
 * ```tsx
 * import { useVoiceRecorder } from "web-voice-recorder-to-mp3";
 *
 * function VoiceButton() {
 *   const recorder = useVoiceRecorder({
 *     onRecordingComplete: (mp3Data, metadata) => {
 *       const blob = new Blob([mp3Data], { type: "audio/mpeg" });
 *       // Upload blob, play it, store it — your call.
 *     },
 *   });
 *
 *   return (
 *     <button onClick={recorder.toggleRecording}>
 *       {recorder.isRecording ? "Stop" : "Record"}
 *     </button>
 *   );
 * }
 * ```
 *
 * @module web-voice-recorder-to-mp3
 */

export { useVoiceRecorder } from "./use-voice-recorder";
export { DEFAULTS } from "./constants";

export type {
  VoiceRecorderOptions,
  VoiceRecorderHook,
  RecordingMetadata,
} from "./types";
