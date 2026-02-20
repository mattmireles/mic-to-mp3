/**
 * useVoiceRecorder hook tests.
 *
 * Covers:
 * - Empty chunks: stopping before first chunk shows "Recording too short" error
 * - clearError clears error state
 * - Decode failure shows user-friendly message
 * - Happy path: full record -> decode -> encode -> callback
 * - Worker fallback: worker construction failure -> main-thread encode
 * - Max size exceeded: MP3 exceeds maxSizeBytes
 * - Unmount cleanup releases mic resources
 * - Stop/restart race is blocked
 *
 * Mocks: getUserMedia, MediaRecorder, AudioContext, Worker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { useVoiceRecorder } from "./use-voice-recorder";
import type { RecordingMetadata } from "./types";
import * as decodePcm from "./decode-pcm";
import * as encodeWorker from "./encode-worker";

let lastMp3Data: Uint8Array | null = null;
let lastMetadata: RecordingMetadata | null = null;

function TestWrapper({ maxSizeBytes }: { maxSizeBytes?: number } = {}) {
  const recorder = useVoiceRecorder({
    onRecordingComplete: (mp3Data, metadata) => {
      lastMp3Data = mp3Data;
      lastMetadata = metadata;
    },
    maxSizeBytes,
  });
  return (
    <div>
      <button type="button" onClick={recorder.toggleRecording} data-testid="toggle">
        {recorder.isRecording ? "Stop" : "Record"}
      </button>
      {recorder.error && <span data-testid="error">{recorder.error}</span>}
      {recorder.isProcessing && <span data-testid="processing">Processing...</span>}
      <button type="button" onClick={recorder.clearError} data-testid="clear-error">
        Clear
      </button>
    </div>
  );
}

describe("useVoiceRecorder", () => {
  let mockRecorder: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    state: string;
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null;
    onstop: (() => void) | null;
  };
  let streamTracks: { stop: ReturnType<typeof vi.fn> }[];

  beforeEach(() => {
    lastMp3Data = null;
    lastMetadata = null;
    streamTracks = [{ stop: vi.fn() }];
    mockRecorder = {
      start: vi.fn(),
      stop: vi.fn(function (this: typeof mockRecorder) {
        this.state = "inactive";
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
            getTracks: () => streamTracks,
          }),
        ),
      },
    });

    function WorkerConstructor(
      this: { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((e: MessageEvent) => void) | null },
    ) {
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.onmessage = null;
    }
    vi.stubGlobal("Worker", WorkerConstructor);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows error when recording stopped before any chunk (empty chunks)", async () => {
    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent(/Recording too short/i);
    });
  });

  it("clearError clears the error message", async () => {
    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId("error")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("clear-error"));

    await waitFor(() => {
      expect(screen.queryByTestId("error")).not.toBeInTheDocument();
    });
  });

  it("shows decode error when AudioContext.decodeAudioData fails", async () => {
    vi.spyOn(decodePcm, "decodeToPcm").mockRejectedValue(new Error("Decode failed"));

    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["fake"], { type: "audio/webm" }) });
      this.onstop?.();
    });

    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent(/Couldn't decode recording/i);
    });
  });

  it("completes happy path: record -> decode -> encode -> callback", async () => {
    vi.spyOn(decodePcm, "decodeToPcm").mockResolvedValue({
      channelData: new Float32Array(44100),
      sampleRate: 44100,
      durationSec: 1,
    });
    vi.spyOn(encodeWorker, "encodeToMp3").mockResolvedValue(new Uint8Array(500));

    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
      this.onstop?.();
    });

    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(lastMp3Data).not.toBeNull();
      expect(lastMetadata).not.toBeNull();
    });

    expect(lastMp3Data!.byteLength).toBe(500);
    expect(lastMetadata!.mimeType).toBe("audio/mpeg");
    expect(lastMetadata!.sizeBytes).toBe(500);
    expect(lastMetadata!.durationSec).toBe(1);
  });

  it("does not get stuck in processing under React Strict Mode", async () => {
    vi.spyOn(decodePcm, "decodeToPcm").mockResolvedValue({
      channelData: new Float32Array(44100),
      sampleRate: 44100,
      durationSec: 1,
    });
    vi.spyOn(encodeWorker, "encodeToMp3").mockResolvedValue(new Uint8Array(500));

    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
      this.onstop?.();
    });

    render(
      <StrictMode>
        <TestWrapper />
      </StrictMode>,
    );

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.queryByTestId("processing")).not.toBeInTheDocument();
      expect(lastMp3Data).not.toBeNull();
    });
  });

  it("falls back to main thread when Worker constructor throws", async () => {
    vi.stubGlobal("Worker", function WorkerThatThrows() {
      throw new Error("Workers not supported");
    });

    vi.spyOn(decodePcm, "decodeToPcm").mockResolvedValue({
      channelData: new Float32Array(100),
      sampleRate: 44100,
      durationSec: 0,
    });

    vi.mock("lamejs", () => ({
      default: {
        Mp3Encoder: class {
          encodeBuffer() { return new Int8Array([0x49, 0x44, 0x33]); }
          flush() { return new Int8Array([0xff, 0xfb]); }
        },
      },
      Mp3Encoder: class {
        encodeBuffer() { return new Int8Array([0x49, 0x44, 0x33]); }
        flush() { return new Int8Array([0xff, 0xfb]); }
      },
    }));

    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
      this.onstop?.();
    });

    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(lastMp3Data).not.toBeNull();
    });

    expect(lastMetadata!.mimeType).toBe("audio/mpeg");
  });

  it("shows error when MP3 exceeds maxSizeBytes", async () => {
    vi.spyOn(decodePcm, "decodeToPcm").mockResolvedValue({
      channelData: new Float32Array(100),
      sampleRate: 44100,
      durationSec: 1,
    });
    vi.spyOn(encodeWorker, "encodeToMp3").mockResolvedValue(new Uint8Array(26 * 1024 * 1024));

    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
      this.onstop?.();
    });

    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent(/too large/i);
    });

    expect(lastMp3Data).toBeNull();
  });

  it("releases mic resources on unmount while recording", async () => {
    const { unmount } = render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());

    unmount();

    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(streamTracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it("blocks immediate restart while stop is in progress", async () => {
    mockRecorder.stop = vi.fn(function (this: typeof mockRecorder) {
      this.state = "inactive";
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
        this.onstop?.();
      }, 25);
    });

    render(<TestWrapper />);

    const toggle = screen.getByTestId("toggle");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());

    await userEvent.click(toggle);
    await userEvent.click(toggle);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
