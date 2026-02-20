/**
 * Main-thread MP3 encoding fallback.
 *
 * Used when Web Worker creation fails (e.g. CSP restrictions, unsupported
 * environment, or bundler incompatibility with worker URLs).
 *
 * Same logic as the worker, but runs synchronously on the main thread.
 * This will block the UI during encoding — the worker path is preferred.
 *
 * @module web-voice-recorder-to-mp3/encode-main-thread
 */

import { downsample, floatTo16BitPCM } from "./audio-utils";
import { loadLameJs } from "./load-lamejs";

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

  const totalSize = mp3Chunks.reduce((sum, c) => sum + c.length, 0);
  const mp3Data = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    mp3Data.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.length;
  }

  return mp3Data;
}
