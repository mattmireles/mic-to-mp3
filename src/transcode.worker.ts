/// <reference lib="webworker" />

export {};

/**
 * MP3 transcoding worker.
 *
 * Supports both:
 * - Streaming session protocol (`init` -> many `append` -> `flush`)
 * - Legacy one-shot protocol (`{ pcmData, sampleRate, targetRate, bitrate }`)
 *
 * Streaming mode enables incremental encoding while recording, so stop latency
 * is usually reduced to only the final encoder flush.
 *
 * @module mic-to-mp3/transcode.worker
 */

import { downsample, floatTo16BitPCM } from "./audio-utils";
import { loadLameJs, type LameJsModule } from "./load-lamejs";

/** lamejs frame size in PCM samples per encodeBuffer call. */
const LAME_FRAME_SIZE = 1152;

/** Legacy one-shot payload shape used by older encode clients. */
interface LegacyTranscodeMessage {
  pcmData: Float32Array;
  sampleRate: number;
  targetRate: number;
  bitrate: number;
}

/** Streaming worker command protocol. */
type StreamingCommand =
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

/**
 * Internal session state for streaming mode.
 */
interface StreamingSessionState {
  encoder: InstanceType<LameJsModule["Mp3Encoder"]>;
  sampleRate: number;
  targetRate: number;
  mp3Chunks: Int8Array[];
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let session: StreamingSessionState | null = null;

/**
 * Append PCM chunk into an active streaming session.
 */
function appendChunkToSession(activeSession: StreamingSessionState, pcmData: Float32Array) {
  const resampled = downsample(
    pcmData,
    activeSession.sampleRate,
    activeSession.targetRate
  );
  const samples = floatTo16BitPCM(resampled);

  for (let i = 0; i < samples.length; i += LAME_FRAME_SIZE) {
    const frame = samples.subarray(i, i + LAME_FRAME_SIZE);
    const mp3Chunk = activeSession.encoder.encodeBuffer(frame);
    if (mp3Chunk.length > 0) {
      activeSession.mp3Chunks.push(mp3Chunk);
    }
  }
}

/**
 * Finalize an active streaming session and return contiguous MP3 bytes.
 */
function flushSession(activeSession: StreamingSessionState): Uint8Array {
  const finalChunk = activeSession.encoder.flush();
  if (finalChunk.length > 0) {
    activeSession.mp3Chunks.push(finalChunk);
  }

  const totalSize = activeSession.mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const mp3Data = new Uint8Array(totalSize);

  let offset = 0;
  for (const chunk of activeSession.mp3Chunks) {
    mp3Data.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.length;
  }

  return mp3Data;
}

/**
 * Run one-shot encoding for backward compatibility.
 */
async function encodeLegacyMessage(message: LegacyTranscodeMessage): Promise<Uint8Array> {
  const lamejs = await loadLameJs();
  const encoder = new lamejs.Mp3Encoder(1, message.targetRate, message.bitrate);

  const tempSession: StreamingSessionState = {
    encoder,
    sampleRate: message.sampleRate,
    targetRate: message.targetRate,
    mp3Chunks: [],
  };

  appendChunkToSession(tempSession, message.pcmData);
  return flushSession(tempSession);
}

workerScope.onmessage = async (
  event: MessageEvent<StreamingCommand | LegacyTranscodeMessage>
) => {
  try {
    const data = event.data;

    if (data && typeof data === "object" && "type" in data) {
      if (data.type === "init") {
        const lamejs = await loadLameJs();
        session = {
          encoder: new lamejs.Mp3Encoder(1, data.targetRate, data.bitrate),
          sampleRate: data.sampleRate,
          targetRate: data.targetRate,
          mp3Chunks: [],
        };

        workerScope.postMessage({ type: "ready" });
        return;
      }

      if (data.type === "append") {
        if (!session) {
          throw new Error("Encoder session is not initialized.");
        }

        appendChunkToSession(session, data.pcmData);
        return;
      }

      if (data.type === "flush") {
        if (!session) {
          throw new Error("Encoder session is not initialized.");
        }

        const mp3Data = flushSession(session);
        session = null;
        workerScope.postMessage({ type: "flushed", mp3Data }, [mp3Data.buffer]);
        return;
      }

      if (data.type === "close") {
        session = null;
        return;
      }
    }

    const legacy = data as LegacyTranscodeMessage;
    const mp3Data = await encodeLegacyMessage(legacy);
    workerScope.postMessage({ mp3Data }, [mp3Data.buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Encoding failed",
    });
  }
};
