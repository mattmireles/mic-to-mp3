# 🎙️🤖 Mic-to-Mp3

Record microphone audio in the browser and get MP3 bytes — no server-side transcoding required.

All encoding happens in the user's browser via a Web Worker. You send the finished MP3 straight to your API. No FFmpeg server, no transcoding lambda, no audio pipeline to maintain.

```txt
getUserMedia -> MediaRecorder -> AudioContext.decodeAudioData -> lamejs (Web Worker) -> Uint8Array
```

## Why this exists

Most browser recording flows stop at a `MediaRecorder` blob (`audio/webm`). To get MP3, the typical path is uploading raw audio to a server that runs FFmpeg or a cloud transcoding service. That means standing up infrastructure, paying for compute, and handling failure modes for something that the browser can do locally.

This library eliminates the server from the equation:

- Capture mic audio in React
- Transcode to mono MP3 entirely in the browser (Web Worker, no UI jank)
- Return `Uint8Array` bytes ready to POST to your LLM or API

No transcoding server. No cloud function. No extra infra to deploy, scale, or pay for.

It keeps the architecture intentionally simple:

- Small dependency surface (`lamejs` only — no native binaries, no WASM blobs)
- Worker-first encoding to avoid UI freezes
- Main-thread fallback if workers are blocked
- Clean hook API with explicit error states

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

Peer requirement:

- `react >= 18`

## Quick start

```tsx
import { useVoiceRecorder } from "mic-to-mp3";

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

## LLM upload example

```tsx
import { useVoiceRecorder } from "mic-to-mp3";

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

### `useVoiceRecorder(options): VoiceRecorderHook`

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onRecordingComplete` | `(mp3Data: Uint8Array, metadata: RecordingMetadata) => void` | required | Called after decode and MP3 encode finish |
| `maxDuration` | `number` | `600` | Auto-stop limit in seconds |
| `maxSizeBytes` | `number` | `25 * 1024 * 1024` | Fails if encoded MP3 exceeds this size |
| `bitrate` | `number` | `64` | MP3 bitrate in kbps |
| `sampleRate` | `number` | `44100` | Decode target sample rate in Hz |

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
2. Record chunks with `MediaRecorder` (prefers `audio/webm;codecs=opus`, falls back as needed)
3. Decode to PCM with `AudioContext.decodeAudioData()`
4. Encode PCM to MP3 with `lamejs` in a dedicated worker
5. Return `Uint8Array` bytes via `onRecordingComplete`

If worker creation fails (CSP, unsupported environment, bundler mismatch), the library automatically falls back to main-thread encoding.

## Browser and runtime requirements

- Secure context for `getUserMedia` (HTTPS or localhost)
- Browser support for `MediaRecorder`, `AudioContext`, and `Web Worker`
- React 18+

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

- Encoding is batch-style after stop, not streaming during recording
- MP3 output is mono
- When fallback runs on main thread, UI can stutter during encoding
- The hook blocks rapid stop/start races to protect data integrity
- Mic resources are released on stop and unmount

## Error handling

Common user-facing errors:

- `Microphone access denied. Please allow mic access and try again.`
- `Recording too short. Hold for at least one second.`
- `Couldn't decode recording. Try again or use a different browser.`
- `Recording is too large. Try a shorter message.`

## Limitations

- React hook API only (no vanilla JS wrapper yet)
- Browser-only package (not for Node.js runtime)
- No container muxing features (MP4/WebM output is out of scope)
- No advanced DSP pipeline (noise suppression, AGC, VAD) built in

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

Publish safety gate:

- `prepublishOnly` runs typecheck, tests, and build before publish

Release commands:

```bash
npm publish --dry-run
npm publish
```

## Contributing

Issues and PRs are welcome.

- Bug reports: [GitHub Issues](https://github.com/mattmireles/mic-to-mp3/issues)
- Source: [GitHub Repository](https://github.com/mattmireles/mic-to-mp3)

When contributing, prefer simple and explicit solutions over abstraction-heavy rewrites.

## License

MIT
