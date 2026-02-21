# CLAUDE.md

Project instructions for AI contributors working in `mic-to-mp3`.

## Core Rule

Simpler is better.

## What this library is

`mic-to-mp3` is a browser-side microphone recorder that outputs MP3 bytes.

Primary goals:

- Worker-first encoding
- Incremental/live encoding when available
- Robust fallback behavior across browser environments
- Minimal API surface with clear contracts

## Preferred Architecture

- Framework-agnostic core in `src/voice-recorder-core.ts`
- Thin React wrapper in `src/use-voice-recorder.ts`
- Small utility modules with single responsibilities

## Coding Guidance

- Keep files focused and under control; split logic instead of growing monoliths.
- Be explicit about browser edge cases (MediaRecorder, AudioContext, Worker support).
- Handle failures with deterministic fallbacks.
- Avoid unnecessary abstractions and optional complexity.

## Documentation Guidance

- Add JSDoc for stateful and non-trivial behavior.
- Document call relationships between files.
- Keep README/API docs synchronized with exports and behavior.

## Validation Checklist

Run before finalizing work:

- `npm run test`
- `npm run typecheck`
- `npm run build`

## Repository Hygiene

Keep guidance in this repo specific to this package.

Do not include unrelated app instructions (auth, database migrations, login credentials, etc.) in package docs.
