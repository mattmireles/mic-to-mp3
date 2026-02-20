/**
 * Type declarations for the `lamejs` package.
 *
 * lamejs ships without TypeScript types. This ambient module declaration
 * provides type safety for the subset of the API we use (Mp3Encoder).
 *
 * The runtime loading and bundler compatibility logic lives in `./load-lamejs.ts`,
 * which also defines a `LameMp3Encoder` interface mirroring these types for
 * the normalized module shape.
 */
declare module "lamejs" {
  class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  export { Mp3Encoder };
  export default { Mp3Encoder };
}
