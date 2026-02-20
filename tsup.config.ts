import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["react", "lamejs"],
    treeshake: true,
  },
  {
    entry: ["src/transcode.worker.ts"],
    format: ["esm"],
    sourcemap: false,
    noExternal: [/(.*)/],
    external: ["lamejs"],
    outDir: "dist",
  },
]);
