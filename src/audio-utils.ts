/**
 * Pure DSP utilities for audio sample conversion.
 *
 * Used by both the Web Worker and the main-thread fallback encoder.
 *
 * @module web-voice-recorder-to-mp3/audio-utils
 */

/**
 * Downsample audio data with linear interpolation.
 * No-ops if fromRate === toRate.
 */
export function downsample(
  buffer: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    result[i] = buffer[index] + frac * ((buffer[index + 1] || 0) - buffer[index]);
  }

  return result;
}

/**
 * Convert Float32 PCM (-1..1) to Int16 PCM expected by the MP3 encoder.
 */
export function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
