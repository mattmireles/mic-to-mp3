/**
 * Main-thread MP3 encoding implementation.
 *
 * This module provides two APIs:
 * - `createMainThreadEncodeSession()` for incremental chunk-by-chunk encoding
 * - `encodeOnMainThread()` for one-shot encoding (legacy compatibility)
 *
 * Called by:
 * - `createMp3EncodeSession()` in `./encode-worker.ts` as worker fallback
 * - `encodeToMp3()` in `./encode-worker.ts` for one-shot fallback
 *
 * Calls:
 * - `downsample()` and `floatTo16BitPCM()` from `./audio-utils.ts`
 * - `loadLameJs()` from `./load-lamejs.ts`
 *
 * @module mic-to-mp3/encode-main-thread
 */

import { downsample, floatTo16BitPCM } from "./audio-utils";
import { loadLameJs, type LameJsModule } from "./load-lamejs";

/** lamejs processes 1152 PCM samples per MP3 frame. */
const LAME_FRAME_SIZE = 1152;

/**
 * Incremental MP3 encoder session contract.
 *
 * Implemented by:
 * - `MainThreadEncodeSession` in this module
 * - `WorkerEncodeSession` in `./encode-worker.ts`
 */
export interface IncrementalMp3EncoderSession {
  /** Queue a PCM chunk for encoding. */
  appendPcm: (pcmData: Float32Array) => void;
  /** Flush pending chunks and finalize the MP3 output. */
  flush: () => Promise<Uint8Array>;
  /** Release session resources. Safe to call multiple times. */
  close: () => void;
}

/**
 * Main-thread incremental encoder.
 *
 * Uses an internal promise chain (`pending`) so append calls preserve ordering.
 * This mirrors worker message-order semantics without introducing async races.
 */
class MainThreadEncodeSession implements IncrementalMp3EncoderSession {
  private encoder: InstanceType<LameJsModule["Mp3Encoder"]> | null = null;
  private readonly mp3Chunks: Int8Array[] = [];
  private pending: Promise<void> = Promise.resolve();
  private fatalError: Error | null = null;
  private closed = false;
  private readonly initPromise: Promise<void>;

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate: number,
    private readonly bitrate: number
  ) {
    this.initPromise = this.initialize();
  }

  /** Load lamejs and create the Mp3Encoder instance. */
  private async initialize(): Promise<void> {
    const lamejs = await loadLameJs();
    this.encoder = new lamejs.Mp3Encoder(1, this.targetRate, this.bitrate);
  }

  /** Await initialization so caller sees setup failures early. */
  async ensureReady(): Promise<void> {
    await this.initPromise;
  }

  appendPcm(pcmData: Float32Array): void {
    if (this.closed || this.fatalError) return;

    /**
     * Copy chunk data immediately because callers often transfer/reuse buffers
     * after append. Encoding always reads from this owned copy.
     */
    const chunkCopy = new Float32Array(pcmData.length);
    chunkCopy.set(pcmData);

    this.pending = this.pending
      .then(async () => {
        await this.initPromise;
        if (!this.encoder) {
          throw new Error("MP3 encoder is not initialized.");
        }

        const resampled = downsample(chunkCopy, this.sourceRate, this.targetRate);
        const samples = floatTo16BitPCM(resampled);

        for (let i = 0; i < samples.length; i += LAME_FRAME_SIZE) {
          const frame = samples.subarray(i, i + LAME_FRAME_SIZE);
          const mp3Chunk = this.encoder.encodeBuffer(frame);
          if (mp3Chunk.length > 0) {
            this.mp3Chunks.push(mp3Chunk);
          }
        }
      })
      .catch((error: unknown) => {
        this.fatalError =
          error instanceof Error ? error : new Error("Failed to encode PCM chunk.");
      });
  }

  async flush(): Promise<Uint8Array> {
    if (this.closed) {
      throw new Error("Encoder session is already closed.");
    }

    await this.initPromise;
    await this.pending;

    if (this.fatalError) {
      throw this.fatalError;
    }

    if (!this.encoder) {
      throw new Error("MP3 encoder is not initialized.");
    }

    const finalChunk = this.encoder.flush();
    if (finalChunk.length > 0) {
      this.mp3Chunks.push(finalChunk);
    }

    const totalSize = this.mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const mp3Data = new Uint8Array(totalSize);

    let offset = 0;
    for (const chunk of this.mp3Chunks) {
      mp3Data.set(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        offset
      );
      offset += chunk.length;
    }

    this.closed = true;
    return mp3Data;
  }

  close(): void {
    this.closed = true;
    this.encoder = null;
    this.mp3Chunks.length = 0;
  }
}

/**
 * Create a main-thread incremental MP3 session.
 *
 * @param sourceRate - Input PCM sample rate (Hz)
 * @param targetRate - Output MP3 sample rate (Hz)
 * @param bitrate - MP3 bitrate (kbps)
 */
export async function createMainThreadEncodeSession(
  sourceRate: number,
  targetRate: number,
  bitrate: number
): Promise<IncrementalMp3EncoderSession> {
  const session = new MainThreadEncodeSession(sourceRate, targetRate, bitrate);
  await session.ensureReady();
  return session;
}

/**
 * One-shot PCM -> MP3 encoding on the main thread.
 *
 * Maintains compatibility with existing callers while internally using the
 * incremental session implementation.
 */
export async function encodeOnMainThread(
  pcmData: Float32Array,
  sampleRate: number,
  targetRate: number,
  bitrate: number
): Promise<Uint8Array> {
  const session = await createMainThreadEncodeSession(sampleRate, targetRate, bitrate);
  session.appendPcm(pcmData);
  try {
    return await session.flush();
  } finally {
    session.close();
  }
}
