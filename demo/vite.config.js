import { defineConfig } from "vite";

export default defineConfig({
  // Deployed at https://tigregotico.github.io/phoonnx.js/
  base: "/phoonnx.js/",
  build: {
    outDir: "dist",
    // onnxruntime-web ships its own wasm assets; don't inline them
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  server: {
    headers: {
      // WebGPU needs these; single-threaded WASM works without them
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
