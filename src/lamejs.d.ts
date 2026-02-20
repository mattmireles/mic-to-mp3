declare module "lamejs" {
  class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  export { Mp3Encoder };
  export default { Mp3Encoder };
}
