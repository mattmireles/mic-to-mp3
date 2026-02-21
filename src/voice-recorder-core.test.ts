/**
 * VoiceRecorder core controller tests.
 *
 * Covers framework-agnostic usage without React and validates that the
 * MediaRecorder decode/encode fallback path remains functional.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { createVoiceRecorder } from "./voice-recorder-core";
import * as decodePcm from "./decode-pcm";
import * as encodeWorker from "./encode-worker";
import type { RecordingMetadata } from "./types";

describe("createVoiceRecorder", () => {
  let mockRecorder: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    state: string;
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null;
    onstop: (() => void) | null;
  };

  beforeEach(() => {
    mockRecorder = {
      start: vi.fn(),
      stop: vi.fn(function (this: typeof mockRecorder) {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
        this.onstop?.();
      }),
      state: "recording",
      mimeType: "audio/webm;codecs=opus",
      ondataavailable: null,
      onstop: null,
    };

    function MediaRecorderConstructor() {
      return mockRecorder;
    }

    (MediaRecorderConstructor as unknown as { isTypeSupported: ReturnType<typeof vi.fn> }).isTypeSupported =
      vi.fn(() => true);

    vi.stubGlobal("MediaRecorder", MediaRecorderConstructor);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(() =>
          Promise.resolve({
            getTracks: () => [{ stop: vi.fn() }],
          })
        ),
      },
    });

    vi.spyOn(decodePcm, "decodeToPcm").mockResolvedValue({
      channelData: new Float32Array(44100),
      sampleRate: 44100,
      durationSec: 1,
    });

    vi.spyOn(encodeWorker, "encodeToMp3").mockResolvedValue(new Uint8Array(512));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records and emits MP3 bytes through the core controller", async () => {
    let receivedBytes: Uint8Array | null = null;
    let receivedMetadata: RecordingMetadata | null = null;

    const recorder = createVoiceRecorder({
      onRecordingComplete: (mp3Data, metadata) => {
        receivedBytes = mp3Data;
        receivedMetadata = metadata;
      },
    });

    await recorder.start();
    recorder.stop();

    await waitFor(() => {
      expect(receivedBytes).not.toBeNull();
      expect(receivedMetadata).not.toBeNull();
    });

    expect(receivedBytes!.byteLength).toBe(512);
    expect(receivedMetadata!.sizeBytes).toBe(512);
    expect(receivedMetadata!.mimeType).toBe("audio/mpeg");

    recorder.destroy();
  });

  it("does not call onRecordingComplete after destroy during in-flight processing", async () => {
    vi.spyOn(encodeWorker, "encodeToMp3").mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(new Uint8Array(256));
          }, 30);
        })
    );

    const onRecordingComplete = vi.fn();

    const recorder = createVoiceRecorder({
      onRecordingComplete,
    });

    await recorder.start();
    recorder.stop();
    recorder.destroy();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onRecordingComplete).not.toHaveBeenCalled();
  });
});
