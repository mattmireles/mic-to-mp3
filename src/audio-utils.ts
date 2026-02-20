/**
 * Pure DSP utilities for audio sample conversion.
 *
 * Stateless functions shared by both encoding paths. No side effects,
 * no imports from other project files — safe to run in any context.
 *
 * Called by:
 * - `./transcode.worker.ts` — Web Worker encoding path
 * - `./encode-main-thread.ts` — main-thread fallback encoding path
 *
 * @module mic-to-mp3/audio-utils
 */

/**
 * Downsample audio data with linear interpolation.
 * No-ops if fromRate === toRate.
 *
 * @param buffer - Source Float32 PCM samples
 * @param fromRate - Source sample rate (Hz)
 * @param toRate - Target sample rate (Hz)
 * @returns New Float32Array at the target rate, or the original buffer if rates match
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
    // For the last sample, (buffer[index + 1] || 0) handles past-end access gracefully
    result[i] = buffer[index] + frac * ((buffer[index + 1] || 0) - buffer[index]);
  }

  return result;
}

/**
 * Convert Float32 PCM (-1..1) to Int16 PCM expected by the lamejs MP3 encoder.
 *
 * Clamps input to [-1, 1] then scales to the Int16 range.
 * Negative values scale by 0x8000 (32768, the most negative Int16 value).
 * Positive values scale by 0x7FFF (32767, the most positive Int16 value).
 * The asymmetry is inherent to two's complement signed integers.
 *
 * @param float32 - Source Float32 PCM samples in the range [-1, 1]
 * @returns New Int16Array with values in the range [-32768, 32767]
 */
export function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
