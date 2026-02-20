/**
 * Decode browser-recorded audio blob into mono PCM channel data.
 *
 * Pins AudioContext to the target sample rate so the browser's high-quality
 * internal resampler handles rate conversion (e.g. 48000 Hz capture on mobile)
 * before we receive the PCM data. This eliminates the need for a second
 * linear-interpolation downsample pass in the encoder.
 *
 * Returns the duration from the decoded AudioBuffer (rounded to whole
 * seconds) rather than relying on wall-clock timing.
 *
 * Called by:
 * - `processRecording()` in `./use-voice-recorder.ts` after MediaRecorder stops
 *
 * The output feeds into:
 * - `encodeToMp3()` in `./encode-worker.ts` for PCM → MP3 transcoding
 *
 * @module mic-to-mp3/decode-pcm
 */

/**
 * Decode an audio Blob to mono Float32 PCM at the target sample rate.
 *
 * Creates a temporary AudioContext pinned to `targetSampleRate`, decodes the
 * blob, mixes stereo to mono if needed, and closes the context.
 *
 * @param blob - Audio blob from MediaRecorder (webm, mp4, etc.)
 * @param targetSampleRate - Desired output sample rate in Hz (e.g. 44100)
 * @returns Object with `channelData` (mono Float32Array), `sampleRate`, and `durationSec`
 */
export async function decodeToPcm(
  blob: Blob,
  targetSampleRate: number
): Promise<{ channelData: Float32Array; sampleRate: number; durationSec: number }> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: targetSampleRate });
  let audioBuffer: AudioBuffer;

  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close();
  }

  let channelData: Float32Array;
  if (audioBuffer.numberOfChannels > 1) {
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    channelData = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      channelData[i] = (left[i] + right[i]) / 2;
    }
  } else {
    channelData = audioBuffer.getChannelData(0);
  }

  return {
    channelData,
    sampleRate: audioBuffer.sampleRate,
    durationSec: Math.round(audioBuffer.duration),
  };
}
