/**
 * Worker-based MP3 encoder with automatic main-thread fallback.
 *
 * Attempts to encode PCM audio to MP3 via a Web Worker (off main thread).
 * If the worker can't be created (CSP, bundler issues) or fails at runtime,
 * falls back to `encodeOnMainThread()` from `./encode-main-thread.ts` transparently.
 *
 * Called by:
 * - `processRecording()` in `./use-voice-recorder.ts` after PCM decoding completes
 *
 * Calls:
 * - `./transcode.worker.ts` — spawned as a Web Worker for off-thread encoding
 * - `encodeOnMainThread()` from `./encode-main-thread.ts` — fallback path
 *
 * Worker message protocol:
 * - Out: `{ pcmData, sampleRate, targetRate, bitrate }` (Float32Array transferred)
 * - In:  `{ mp3Data: Uint8Array }` on success, `{ error: string }` on failure
 *
 * @module web-voice-recorder-to-mp3/encode-worker
 */

import { encodeOnMainThread } from "./encode-main-thread";

/**
 * Encode PCM Float32Array to MP3 Uint8Array.
 *
 * Tries Web Worker first for non-blocking encoding, automatically
 * falls back to main-thread encoding if the worker can't be created
 * or errors during encoding.
 *
 * @param pcmData - Mono Float32 PCM samples (-1..1) from `decodeToPcm()`
 * @param sampleRate - Source sample rate of the PCM data (Hz)
 * @param targetRate - Target MP3 sample rate (Hz), typically 44100
 * @param bitrate - MP3 encoding bitrate (kbps), typically 64
 * @returns MP3 file as a Uint8Array
 */
export async function encodeToMp3(
  pcmData: Float32Array,
  sampleRate: number,
  targetRate: number,
  bitrate: number
): Promise<Uint8Array> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./transcode.worker.js", import.meta.url));
  } catch (constructErr) {
    console.warn("[voice-recorder] Worker creation failed, falling back to main thread:", constructErr);
    return encodeOnMainThread(pcmData, sampleRate, targetRate, bitrate);
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;

    const resolveOnce = (data: Uint8Array) => {
      if (settled) return;
      settled = true;
      resolve(data);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const fallbackToMainThread = async (reason: unknown) => {
      console.warn(
        "[voice-recorder] Worker encoding failed, falling back to main thread:",
        reason
      );
      try {
        const mp3Data = await encodeOnMainThread(pcmData, sampleRate, targetRate, bitrate);
        resolveOnce(mp3Data);
      } catch (fallbackErr) {
        rejectOnce(
          fallbackErr instanceof Error
            ? fallbackErr
            : new Error("Main-thread encoding failed")
        );
      }
    };

    worker.onmessage = (e: MessageEvent) => {
      worker.terminate();
      if (e.data.error) {
        void fallbackToMainThread(new Error(e.data.error));
      } else {
        resolveOnce(e.data.mp3Data as Uint8Array);
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      void fallbackToMainThread(
        new Error(err.message || "Worker encoding failed")
      );
    };

    worker.postMessage({
      pcmData,
      sampleRate,
      targetRate,
      bitrate,
    });
  });
}
