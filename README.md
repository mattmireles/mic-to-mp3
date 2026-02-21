# 🎙️🤖 Mic-to-Mp3

Record microphone audio in the browser and get MP3 bytes with no server-side transcoding.

Encoding happens in the user's browser (worker-first). You send finished MP3 bytes straight to your API. No FFmpeg server, no transcoding lambda, no media queue.

```txt
Primary path: getUserMedia -> Web Audio PCM capture -> lamejs (incremental in Worker) -> flush -> Uint8Array
Fallback path: getUserMedia -> MediaRecorder -> decodeAudioData -> lamejs -> Uint8Array
```

## Why this exists

Most browser recording flows stop at a `MediaRecorder` blob (`audio/webm`). To get MP3, the typical path is uploading raw audio to a server that runs FFmpeg or a cloud transcoding service. That means standing up infrastructure, paying for compute, and handling failure modes for something that the browser can do locally.

This library eliminates the server from the equation:

- Capture mic audio in browser JavaScript (framework-agnostic core + React hook)
- Transcode to mono MP3 entirely in the browser (worker-first, incremental when supported)
- Return `Uint8Array` bytes ready to POST to your LLM or API

No transcoding server. No cloud function. No extra infra to deploy, scale, or pay for.

It keeps the architecture intentionally simple:

- Small dependency surface (`lamejs` only — no native binaries, no WASM blobs)
- Worker-first encoding with main-thread fallback
- Live incremental encoding plus robust MediaRecorder/decode fallback
- Framework-agnostic core controller and thin React adapter

## Design principles

This repo follows practical client transcoding lessons documented in [Client Transcoding Guide](./Client-transcoding-guide.md):

- Keep CPU-heavy work off the main thread whenever possible
- Treat resource lifecycle cleanup as mandatory, not optional
- Use explicit fallback paths for browser and environment differences
- Prefer reliable, debuggable pipelines over clever abstractions

For this package specifically:

- We optimize for voice-note style audio and LLM upload workflows
- We do not try to be a general media framework

## Install

```bash
npm install mic-to-mp3
```

React is optional. Use:

- `mic-to-mp3/core` for vanilla JS or non-React frameworks
- `mic-to-mp3/react` for hook-focused usage

## Quick start (React)

```tsx
import { useVoiceRecorder } from "mic-to-mp3/react";

export function VoiceRecorder() {
  const recorder = useVoiceRecorder({
    onRecordingComplete: (mp3Data, metadata) => {
      console.log("duration:", metadata.durationSec);
      console.log("bytes:", metadata.sizeBytes);

      const blob = new Blob([mp3Data], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "recording.mp3";
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <div>
      <button
        type="button"
        onClick={recorder.toggleRecording}
        disabled={recorder.isProcessing}
      >
        {recorder.isRecording ? "Stop" : "Record"}
      </button>

      {recorder.isRecording && <p>{recorder.elapsed}s</p>}
      {recorder.isProcessing && <p>Encoding...</p>}
      {recorder.error && <p>{recorder.error}</p>}
    </div>
  );
}
```

## Quick start (vanilla JS)

```ts
import { createVoiceRecorder } from "mic-to-mp3/core";

const recorder = createVoiceRecorder({
  onRecordingComplete: async (mp3Data, metadata) => {
    console.log("duration:", metadata.durationSec);
    console.log("bytes:", metadata.sizeBytes);
    await fetch("/api/transcribe", {
      method: "POST",
      body: new File([mp3Data], "voice.mp3", { type: "audio/mpeg" }),
    });
  },
});

document.getElementById("toggle")?.addEventListener("click", () => {
  void recorder.toggleRecording();
});
```

## LLM upload example (React)

```tsx
import { useVoiceRecorder } from "mic-to-mp3/react";

export function UploadToLLM() {
  const recorder = useVoiceRecorder({
    onRecordingComplete: async (mp3Data) => {
      const file = new File([mp3Data], "voice.mp3", { type: "audio/mpeg" });
      const body = new FormData();
      body.append("audio", file);

      await fetch("/api/transcribe", {
        method: "POST",
        body,
      });
    },
  });

  return (
    <button type="button" onClick={recorder.toggleRecording}>
      {recorder.isRecording ? "Stop" : "Record"}
    </button>
  );
}
```

## API

### `createVoiceRecorder(options): VoiceRecorderController`

Framework-agnostic controller API (import from `mic-to-mp3/core`).

Controller methods:

| Method | Type | Description |
| --- | --- | --- |
| `start` | `() => Promise<void>` | Start recording |
| `stop` | `() => void` | Stop recording and finalize |
| `toggleRecording` | `() => Promise<void>` | Convenience start/stop toggle |
| `clearError` | `() => void` | Clear current error |
| `destroy` | `() => void` | Release resources (stream, timers, context, worker) |
| `getState` | `() => VoiceRecorderState` | Read current state snapshot |
| `subscribe` | `(listener) => () => void` | Subscribe to state changes |
| `updateOptions` | `(options) => void` | Update callbacks/limits without recreating |

### `useVoiceRecorder(options): VoiceRecorderHook`

React adapter over `createVoiceRecorder()` (import from `mic-to-mp3/react`).

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onRecordingComplete` | `(mp3Data: Uint8Array, metadata: RecordingMetadata) => void` | required | Called after MP3 finalization |
| `maxDuration` | `number` | `600` | Auto-stop limit in seconds |
| `maxSizeBytes` | `number` | `25 * 1024 * 1024` | Fails if encoded MP3 exceeds this size |
| `bitrate` | `number` | `64` | MP3 bitrate in kbps |
| `sampleRate` | `number` | `44100` | Target MP3 sample rate in Hz |

#### Return value (`VoiceRecorderHook`)

| Property | Type | Description |
| --- | --- | --- |
| `isRecording` | `boolean` | Mic is currently recording |
| `isProcessing` | `boolean` | Decode and encode are running |
| `elapsed` | `number` | Elapsed recording seconds |
| `error` | `string \| null` | User-facing error message |
| `audioLevels` | `number[]` | 40 frequency bins (0-255) for visualization |
| `toggleRecording` | `() => void` | Start or stop recording |
| `clearError` | `() => void` | Clear current error |

### `RecordingMetadata`

```ts
{
  durationSec: number;      // Rounded from decoded AudioBuffer duration
  sizeBytes: number;        // MP3 file size
  mimeType: "audio/mpeg";   // Always audio/mpeg
}
```

## Waveform visualization

```tsx
function Waveform({ levels }: { levels: number[] }) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "end", height: 40 }}>
      {levels.map((level, i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: Math.max(2, (level / 255) * 40),
            backgroundColor: "#3b82f6",
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}
```

## Architecture

1. Request mic access using `navigator.mediaDevices.getUserMedia({ audio: true })`
2. Start live Web Audio PCM capture (ScriptProcessor path) and stream chunks to a worker-backed incremental MP3 session
3. In parallel, capture `MediaRecorder` chunks as a compatibility fallback
4. On stop, flush incremental encoder for immediate MP3 completion when live path is active
5. If live path is unavailable or fails, fallback to `decodeAudioData()` + one-shot MP3 encoding
6. Return `Uint8Array` bytes via `onRecordingComplete`

Fallback layers:

- Worker unavailable -> main-thread incremental encoder
- Live PCM capture unavailable -> MediaRecorder + decode fallback
- MediaRecorder unavailable -> live PCM path only (if supported)

## Browser and runtime requirements

- Secure context for `getUserMedia` (HTTPS or localhost)
- Browser support for `AudioContext` and microphone permissions
- `MediaRecorder` improves fallback reliability but is not strictly required
- `Web Worker` improves responsiveness but is not strictly required
- React 18+ only when using the hook API

## Bundler requirements

The package uses the worker URL pattern:

```ts
new Worker(new URL("./transcode.worker.js", import.meta.url));
```

Use a bundler/runtime that supports this pattern (for example, Next.js with webpack 5, Vite, or webpack 5 directly).

## Performance and reliability guidance

Recommended defaults for voice workflows:

- `bitrate: 64` for low bandwidth and transcription use cases
- `bitrate: 96` or `128` when audio quality matters more than size
- Keep `maxDuration` and `maxSizeBytes` bounded for predictable UX

Operational notes:

- Live path incrementally encodes while recording when Web Audio PCM capture is available
- Fallback path is batch decode + encode after stop
- MP3 output is mono
- When fallback runs on main thread, UI can stutter during encoding
- Start/stop races are guarded to protect data integrity
- Mic resources are released on stop and destroy/unmount

## Error handling

Common user-facing errors:

- `Microphone access denied. Please allow mic access and try again.`
- `Recording too short. Hold for at least one second.`
- `Couldn't decode recording. Try again or use a different browser.`
- `Recording is too large. Try a shorter message.`

## Limitations

- Browser-only package (not for Node.js runtime)
- No container muxing features (MP4/WebM output is out of scope)
- No advanced DSP pipeline (noise suppression, AGC, VAD) built in
- Browser media APIs still vary across platforms; test critical UX on your target devices

## Privacy and security

- All transcoding happens locally in the user's browser — audio never touches your servers for processing
- No network call is made by this library
- Data leaves the browser only if your `onRecordingComplete` callback sends it

## Comparison with other approaches

Server-side transcoding (FFmpeg on your backend, AWS MediaConvert, etc.):

- The standard approach — upload raw audio, transcode on the server, return MP3
- Requires backend infrastructure: a transcoding service, queue, storage, and error handling
- Adds latency (upload raw blob, wait for server, download result)
- Scales with compute cost per recording
- This library eliminates that entire layer — the browser does the work and your server receives finished MP3 bytes

`MediaRecorder` blob only (no transcoding):

- Simplest implementation — just grab the blob and upload it
- But you get `audio/webm` or `audio/ogg` depending on browser, not MP3
- Your backend or LLM still has to deal with format conversion somewhere

FFmpeg.wasm (client-side):

- Extremely flexible — can do anything FFmpeg can
- But ~3MB+ WASM payload and higher CPU/memory overhead for simple voice notes
- Overkill when all you need is mic-to-MP3

WebCodecs-first stacks:

- Excellent for hardware-accelerated video pipelines
- Usually unnecessary complexity for basic MP3 voice capture

## Development

Scripts:

- `npm run dev` or `pnpm dev`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run harness`
- `npm run harness:serve`

Publish safety gate:

- `prepublishOnly` runs typecheck, tests, and build before publish

Release commands:

```bash
npm publish --dry-run
npm publish
```

## Browser compatibility harness

Run the local harness server:

```bash
npm run harness
```

Open [http://localhost:4173/harness/](http://localhost:4173/harness/) in each target browser.

The harness provides:

- Environment capability checks (`getUserMedia`, `AudioContext`, `MediaRecorder`, `Worker`, MIME support)
- Live recording and MP3 generation with the same `createVoiceRecorder()` pipeline used in production
- Run history with timing metrics (`stop -> done`, processing duration, file size)
- JSON export for sharing test results

Recommended validation matrix:

- Chrome (latest) on macOS or Windows
- Firefox (latest) on macOS or Windows
- Safari (latest) on macOS
- iOS Safari (current iOS release)
- Android Chrome (current Android release)

If `dist/` is already built, you can skip rebuild and just serve:

```bash
npm run harness:serve
```

## Contributing

Issues and PRs are welcome.

- Bug reports: [GitHub Issues](https://github.com/mattmireles/mic-to-mp3/issues)
- Source: [GitHub Repository](https://github.com/mattmireles/mic-to-mp3)

When contributing, prefer simple and explicit solutions over abstraction-heavy rewrites.

## License

MIT
