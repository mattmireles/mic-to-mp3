import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/core.ts", "src/react.ts"],
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
