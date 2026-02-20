/**
 * Detect the best supported recording MIME type for MediaRecorder.
 *
 * Prefers WebM/Opus (best quality-to-size), falls back to plain WebM,
 * then MP4 (Safari). Returns empty string if none are supported,
 * which lets MediaRecorder pick its own default.
 *
 * @module web-voice-recorder-to-mp3/recorder-mime
 */

export function detectRecorderMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}
