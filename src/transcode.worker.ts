/// <reference lib="webworker" />

export {};

/**
 * MP3 Transcoding Web Worker
 *
 * Runs the CPU-heavy parts of voice recording off the main thread:
 * 1. Downsample PCM from source sample rate to target rate
 * 2. Convert Float32 to Int16
 * 3. Encode Int16 to MP3 via lamejs
 *
 * WHY A WORKER?
 * lamejs encoding is CPU-bound and can freeze the UI for 2–10 seconds
 * on 5–10 minute recordings. Moving it here keeps the main thread
 * responsive during encoding.
 *
 * MESSAGE PROTOCOL:
 * In:  { pcmData: Float32Array, sampleRate: number, targetRate: number, bitrate: number }
 * Out: { mp3Data: Uint8Array } (transferred back, zero-copy)
 * Err: { error: string }
 *
 * @module mic-to-mp3/transcode.worker
 */

import { downsample, floatTo16BitPCM } from "./audio-utils";
import { loadLameJs } from "./load-lamejs";

/** Inbound message shape from `encodeToMp3()` in `./encode-worker.ts`. */
interface TranscodeMessage {
  pcmData: Float32Array;
  sampleRate: number;
  targetRate: number;
  bitrate: number;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (e: MessageEvent<TranscodeMessage>) => {
  try {
    const { pcmData, sampleRate, targetRate, bitrate } = e.data;

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
      if (mp3buf.length > 0) {
        mp3Chunks.push(mp3buf);
      }
    }

    const finalBuf = encoder.flush();
    if (finalBuf.length > 0) {
      mp3Chunks.push(finalBuf);
    }

    const totalSize = mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const mp3Data = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of mp3Chunks) {
      mp3Data.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
      offset += chunk.length;
    }

    workerScope.postMessage({ mp3Data }, [mp3Data.buffer]);
  } catch (err) {
    workerScope.postMessage({
      error: err instanceof Error ? err.message : "Encoding failed",
    });
  }
};
