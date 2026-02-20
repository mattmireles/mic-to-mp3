/**
 * Default configuration values for the voice recorder.
 *
 * These can all be overridden via VoiceRecorderOptions.
 *
 * @module web-voice-recorder-to-mp3/constants
 */

export const DEFAULTS = {
  /** Max recording duration: 10 minutes. */
  MAX_DURATION_SEC: 600,
  /** Max MP3 file size: 25MB. */
  MAX_SIZE_BYTES: 25 * 1024 * 1024,
  /** MP3 encoding bitrate: 64 kbps mono. */
  TARGET_BITRATE: 64,
  /**
   * Canonical sample rate (Hz).
   *
   * Pinning AudioContext to 44100 Hz lets the browser's high-quality internal
   * resampler normalize capture rates (e.g. 48000 Hz on mobile) before we
   * receive the PCM data — eliminating a second linear-interpolation pass.
   */
  SAMPLE_RATE: 44100,
} as const;
