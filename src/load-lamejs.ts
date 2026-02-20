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
 * Called by:
 * - `./transcode.worker.ts` — Web Worker encoding path
 * - `./encode-main-thread.ts` — main-thread fallback encoding path
 *
 * @module web-voice-recorder-to-mp3/load-lamejs
 */

/**
 * Shape of a lamejs Mp3Encoder instance.
 *
 * Used internally by both encoding paths to type-check the encoder object
 * returned from `loadLameJs()`.
 */
interface LameMp3Encoder {
  encodeBuffer(left: Int16Array): Int8Array;
  flush(): Int8Array;
}

/**
 * Normalized module shape for the lamejs library.
 *
 * Different bundlers expose lamejs differently (named export, default export,
 * or CJS `module.exports`). `loadLameJs()` resolves whichever shape is present
 * into this stable interface.
 */
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

/**
 * Pre-create the global bindings that lamejs's CJS source assigns to without declaring.
 * Must be called before `import("lamejs")` to prevent `ReferenceError` in strict mode.
 */
function installLameJsGlobalShims() {
  const globalScope = globalThis as Record<string, unknown>;
  for (const key of LAMEJS_GLOBAL_SHIMS) {
    if (!(key in globalScope)) {
      globalScope[key] = undefined;
    }
  }
}

/**
 * Dynamically import lamejs and normalize its export shape across bundlers.
 *
 * Tries three export shapes in order: named exports, default export, and
 * CJS `module.exports`. Returns the first one that contains `Mp3Encoder`.
 *
 * @returns Normalized LameJsModule with an `Mp3Encoder` constructor
 * @throws {Error} If no valid export shape is found ("Failed to load MP3 encoder.")
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
