/**
 * Detect the best supported recording MIME type for MediaRecorder.
 *
 * Prefers WebM/Opus (best quality-to-size), falls back to plain WebM,
 * then MP4 (Safari). Returns empty string if none are supported,
 * which lets MediaRecorder pick its own default.
 *
 * Called by:
 * - `toggleRecording()` in `./use-voice-recorder.ts` when starting a new recording
 *
 * @module mic-to-mp3/recorder-mime
 */

/**
 * @returns The best supported MIME type string, or empty string if none detected
 */
export function detectRecorderMimeType(): string {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }

  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}
