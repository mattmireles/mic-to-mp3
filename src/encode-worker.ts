/**
 * Worker-first incremental MP3 encoding with automatic fallback.
 *
 * This module provides two APIs:
 * - `createMp3EncodeSession()` for incremental append/flush encoding
 * - `encodeToMp3()` for one-shot compatibility (implemented on top of session API)
 *
 * Worker creation/execution failures fall back to
 * `createMainThreadEncodeSession()` from `./encode-main-thread.ts`.
 *
 * Called by:
 * - `VoiceRecorder` in `./voice-recorder-core.ts` for live incremental encoding
 * - Legacy one-shot call sites via `encodeToMp3()`
 *
 * @module mic-to-mp3/encode-worker
 */

import {
  createMainThreadEncodeSession,
  type IncrementalMp3EncoderSession,
} from "./encode-main-thread";

/** Timeout for worker init handshake before fallback to main-thread encoding. */
const WORKER_READY_TIMEOUT_MS = 5000;

/** Message from main thread to worker. */
type WorkerCommand =
  | {
      type: "init";
      sampleRate: number;
      targetRate: number;
      bitrate: number;
    }
  | {
      type: "append";
      pcmData: Float32Array;
    }
  | {
      type: "flush";
    }
  | {
      type: "close";
    };

/** Message from worker back to main thread. */
type WorkerEvent =
  | { type: "ready" }
  | { type: "flushed"; mp3Data: Uint8Array }
  | { type: "error"; error: string };

/**
 * Worker-backed incremental encoder session.
 *
 * PCM append calls are fire-and-forget message posts. Ordering is guaranteed by
 * the browser's worker message queue. `flush()` resolves when the worker sends
 * back the finalized MP3 bytes.
 */
class WorkerEncodeSession implements IncrementalMp3EncoderSession {
  private fatalError: Error | null = null;
  private flushResolver:
    | {
        resolve: (value: Uint8Array) => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;
  private closed = false;

  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason?: unknown) => void) | null = null;

  private readonly readyPromise: Promise<void> = new Promise((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  constructor(private readonly worker: Worker) {
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = this.handleWorkerError;
  }

  private handleMessage = (event: MessageEvent<WorkerEvent>) => {
    const data = event.data;
    if (!data || typeof data !== "object" || !("type" in data)) {
      return;
    }

    if (data.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (data.type === "flushed") {
      this.flushResolver?.resolve(data.mp3Data);
      this.flushResolver = null;
      return;
    }

    if (data.type === "error") {
      this.handleFatalError(new Error(data.error));
    }
  };

  private handleWorkerError = (event: ErrorEvent) => {
    this.handleFatalError(
      new Error(event.message || "Worker-based MP3 encoding failed.")
    );
  };

  private handleFatalError(error: Error): void {
    this.fatalError = error;

    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;

    this.flushResolver?.reject(error);
    this.flushResolver = null;
  }

  async initialize(
    sampleRate: number,
    targetRate: number,
    bitrate: number
  ): Promise<void> {
    this.worker.postMessage({
      type: "init",
      sampleRate,
      targetRate,
      bitrate,
    } satisfies WorkerCommand);

    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error("MP3 worker initialization timed out."));
        }, WORKER_READY_TIMEOUT_MS);
      }),
    ]);

    if (this.fatalError) {
      throw this.fatalError;
    }
  }

  appendPcm(pcmData: Float32Array): void {
    if (this.closed || this.fatalError) return;

    this.worker.postMessage(
      {
        type: "append",
        pcmData,
      } satisfies WorkerCommand,
      [pcmData.buffer]
    );
  }

  flush(): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(new Error("Encoder session is already closed."));
    }

    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }

    if (this.flushResolver) {
      return Promise.reject(new Error("flush() is already in progress."));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.flushResolver = { resolve, reject };
      this.worker.postMessage({ type: "flush" } satisfies WorkerCommand);
    });
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    try {
      this.worker.postMessage({ type: "close" } satisfies WorkerCommand);
    } catch {
      /* Worker might already be terminated; ignore */
    }

    this.worker.terminate();
    this.flushResolver?.reject(new Error("Encoder session closed before flush completed."));
    this.flushResolver = null;
  }
}

/**
 * Create an incremental MP3 session.
 *
 * Worker path is attempted first. If worker setup fails for any reason
 * (CSP, unsupported runtime, bundler behavior), this function logs a warning
 * and returns a main-thread session instead.
 */
export async function createMp3EncodeSession(
  sampleRate: number,
  targetRate: number,
  bitrate: number
): Promise<IncrementalMp3EncoderSession> {
  let session: WorkerEncodeSession | null = null;
  try {
    const worker = new Worker(new URL("./transcode.worker.js", import.meta.url));
    session = new WorkerEncodeSession(worker);
    await session.initialize(sampleRate, targetRate, bitrate);
    return session;
  } catch (constructErr) {
    session?.close();
    console.warn(
      "[mic-to-mp3] Worker session unavailable, using main-thread encoder:",
      constructErr
    );
    return createMainThreadEncodeSession(sampleRate, targetRate, bitrate);
  }
}

/**
 * One-shot PCM -> MP3 helper.
 *
 * Preserves the existing API surface while internally using the incremental
 * session abstraction.
 */
export async function encodeToMp3(
  pcmData: Float32Array,
  sampleRate: number,
  targetRate: number,
  bitrate: number
): Promise<Uint8Array> {
  const session = await createMp3EncodeSession(sampleRate, targetRate, bitrate);
  session.appendPcm(pcmData);

  try {
    return await session.flush();
  } finally {
    session.close();
  }
}
