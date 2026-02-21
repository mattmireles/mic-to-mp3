/**
 * React adapter for the framework-agnostic voice recorder core.
 *
 * This hook intentionally contains minimal logic. It delegates all recording,
 * encoding, lifecycle, and fallback behavior to `VoiceRecorder` in
 * `./voice-recorder-core.ts` and only maps controller state into React state.
 *
 * Called by:
 * - Package consumers that prefer a React Hook API
 *
 * Calls:
 * - `createVoiceRecorder()` in `./voice-recorder-core.ts`
 *
 * @module mic-to-mp3/use-voice-recorder
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceRecorder } from "./voice-recorder-core";
import type {
  VoiceRecorderController,
  VoiceRecorderHook,
  VoiceRecorderOptions,
  VoiceRecorderState,
} from "./types";

/** Initial hook state before controller subscription emits first snapshot. */
const INITIAL_HOOK_STATE: VoiceRecorderState = {
  isRecording: false,
  isProcessing: false,
  elapsed: 0,
  error: null,
  audioLevels: [],
};

/**
 * Record voice audio and receive MP3 bytes when complete.
 *
 * The hook subscribes to a shared recorder controller instance and re-renders
 * when controller state changes.
 */
export function useVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorderHook {
  const controllerRef = useRef<VoiceRecorderController | null>(null);
  const [state, setState] = useState<VoiceRecorderState>(INITIAL_HOOK_STATE);

  /**
   * Keep controller options current without recreating the recorder instance.
   * This keeps `onRecordingComplete` fresh across renders.
   */
  useEffect(() => {
    controllerRef.current?.updateOptions(options);
  }, [
    options,
    options.onRecordingComplete,
    options.maxDuration,
    options.maxSizeBytes,
    options.bitrate,
    options.sampleRate,
  ]);

  /**
   * Single subscription for the lifetime of this hook instance.
   */
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller) {
      return;
    }

    const nextController = createVoiceRecorder(options);
    controllerRef.current = nextController;
    setState(nextController.getState());

    const unsubscribe = nextController.subscribe((nextState) => {
      setState(nextState);
    });

    return () => {
      unsubscribe();
      nextController.destroy();
      if (controllerRef.current === nextController) {
        controllerRef.current = null;
      }
    };
  }, []);

  const toggleRecording = useCallback(() => {
    void controllerRef.current?.toggleRecording();
  }, []);

  const clearError = useCallback(() => {
    controllerRef.current?.clearError();
  }, []);

  return {
    ...state,
    toggleRecording,
    clearError,
  };
}
