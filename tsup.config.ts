import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    voices: "src/voices.ts",
    espeak: "src/espeak.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // peer deps — don't bundle them
  external: ["onnxruntime-web", "espeak-ng"],
  treeshake: true,
  splitting: false,
});
