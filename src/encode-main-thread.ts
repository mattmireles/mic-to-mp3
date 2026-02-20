/**
 * Main-thread MP3 encoding fallback.
 *
 * Used when Web Worker creation fails (e.g. CSP restrictions, unsupported
 * environment, or bundler incompatibility with worker URLs).
 *
 * Same encoding logic as `./transcode.worker.ts`, but runs on the main thread.
 * This blocks the UI during encoding — the worker path in `./encode-worker.ts`
 * is always attempted first.
 *
 * Called by:
 * - `encodeToMp3()` in `./encode-worker.ts` when worker creation or execution fails
 *
 * Calls:
 * - `downsample()` and `floatTo16BitPCM()` from `./audio-utils.ts` — PCM conversion
 * - `loadLameJs()` from `./load-lamejs.ts` — dynamic import of the MP3 encoder
 *
 * @module mic-to-mp3/encode-main-thread
 */

import { downsample, floatTo16BitPCM } from "./audio-utils";
import { loadLameJs } from "./load-lamejs";

/**
 * Encode PCM Float32 samples to MP3 on the main thread.
 *
 * Mirrors the encoding logic in `./transcode.worker.ts`. Blocks the UI
 * during encoding but produces identical MP3 output.
 *
 * @param pcmData - Mono Float32 PCM samples (-1..1)
 * @param sampleRate - Source sample rate of the PCM data (Hz)
 * @param targetRate - Target MP3 sample rate (Hz)
 * @param bitrate - MP3 encoding bitrate (kbps)
 * @returns MP3 file as a Uint8Array
 */
export async function encodeOnMainThread(
  pcmData: Float32Array,
  sampleRate: number,
  targetRate: number,
  bitrate: number
): Promise<Uint8Array> {
  const lamejs = await loadLameJs();
  const resampled = downsample(pcmData, sampleRate, targetRate);
  const samples = floatTo16BitPCM(resampled);

  const encoder = new lamejs.Mp3Encoder(1, targetRate, bitrate);

  /** lamejs processes 1152 samples at a time. */
  const CHUNK_SIZE = 1152;
  const mp3Chunks: Int8Array[] = [];

  for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
    const chunk = samples.subarray(i, i + CHUNK_SIZE);
    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
  }

  const finalBuf = encoder.flush();
  if (finalBuf.length > 0) mp3Chunks.push(finalBuf);

  /**
   * Concatenate encoded chunks into a single contiguous Uint8Array.
   * lamejs returns Int8Array chunks that may share an underlying ArrayBuffer,
   * so we use (buffer, byteOffset, byteLength) to extract the correct slice.
   */
  const totalSize = mp3Chunks.reduce((sum, c) => sum + c.length, 0);
  const mp3Data = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    mp3Data.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.length;
  }

  return mp3Data;
}
