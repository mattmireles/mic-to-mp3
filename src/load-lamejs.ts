/**
 * LameJS Loader with Browser-Bundler Compatibility Shims
 *
 * The `lamejs` package ships CommonJS source that writes several globals
 * (e.g. `MPEGMode = require(...)`) without declarations. Some ESM bundlers
 * execute that code in strict mode, which throws `ReferenceError`.
 *
 * We pre-create those bindings on `globalThis` before importing, then resolve
 * the exported module shape (`named`, `default`, or `module.exports`) into a
 * stable encoder API.
 *
 * @module web-voice-recorder-to-mp3/load-lamejs
 */

interface LameMp3Encoder {
  encodeBuffer(left: Int16Array): Int8Array;
  flush(): Int8Array;
}

export interface LameJsModule {
  Mp3Encoder: new (
    channels: number,
    sampleRate: number,
    kbps: number
  ) => LameMp3Encoder;
}

/**
 * Undeclared assignment targets used internally by lamejs's CJS source.
 */
const LAMEJS_GLOBAL_SHIMS = [
  "Lame",
  "Presets",
  "GainAnalysis",
  "QuantizePVT",
  "Quantize",
  "Takehiro",
  "Reservoir",
  "MPEGMode",
  "BitStream",
] as const;

function installLameJsGlobalShims() {
  const globalScope = globalThis as Record<string, unknown>;
  for (const key of LAMEJS_GLOBAL_SHIMS) {
    if (!(key in globalScope)) {
      globalScope[key] = undefined;
    }
  }
}

/**
 * Load lamejs and normalize its export shape across bundlers.
 */
export async function loadLameJs(): Promise<LameJsModule> {
  installLameJsGlobalShims();

  const imported = await import("lamejs");
  let commonJsExport: unknown;
  try {
    commonJsExport = (imported as unknown as { "module.exports"?: unknown })["module.exports"];
  } catch {
    commonJsExport = undefined;
  }
  const candidates = [
    imported,
    (imported as unknown as { default?: unknown }).default,
    commonJsExport,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "Mp3Encoder" in candidate &&
      typeof (candidate as { Mp3Encoder?: unknown }).Mp3Encoder === "function"
    ) {
      return candidate as LameJsModule;
    }
  }

  throw new Error("Failed to load MP3 encoder.");
}
