# AGENTS.md

Contributor guidance for `mic-to-mp3`.

## Prime Directive

Simpler is better.

This is a focused browser-audio library. Keep changes direct, testable, and easy to reason about.

## Scope

`mic-to-mp3` is for:

- Recording microphone audio in browsers
- Producing MP3 bytes client-side
- Worker-first encoding with reliable fallbacks
- Voice-note workflows (LLM upload, transcription, messaging)

Out of scope:

- Server-side transcoding infrastructure
- General-purpose media framework features
- Complex DSP chains bundled into core

## Architecture Orientation

Start with:

- `README.md`
- `Client-transcoding-guide.md`
- `src/voice-recorder-core.ts` (framework-agnostic engine)
- `src/use-voice-recorder.ts` (React adapter)

## Engineering Principles

- Prefer clear separation of concerns over convenience abstractions.
- Avoid god modules; keep files small and focused.
- Keep fallback paths explicit and well documented.
- Favor predictable behavior under browser API inconsistencies.
- Preserve backward compatibility unless explicitly planning a breaking release.

## Documentation Standards

- Use JSDoc on non-trivial functions and stateful logic.
- Explicitly document cross-file call flows.
- Replace magic numbers with named constants and rationale.
- Keep README examples runnable and minimal.

## Testing Expectations

Before publishing, run:

- `npm run test`
- `npm run typecheck`
- `npm run build`

When changing recording/encoding flows, add or update tests for:

- Worker failures and fallback behavior
- Stop/start race protection
- Size-limit and decode-error handling
- Strict Mode behavior for React adapter

## Release Hygiene

- Ensure package exports and docs stay aligned.
- Do not include unrelated project instructions or credentials.
- Keep this repository self-contained and standalone.
