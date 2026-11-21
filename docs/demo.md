# The demo site

<!-- agent-hint
covers: what the demo in demo/ does, how to run and build it, and where it deploys
source: demo/src/main.ts, demo/index.html, demo/vite.config.js, demo/package.json, .github/workflows/pages.yml
generated: no
verify: npm install && npm run build, then in demo/ run npm install && npm run build && npx vite preview, open `http://localhost:4173/phoonnx.js/` and synthesize a unicode and an espeak voice
see: docs/browser.md, docs/testing.md
-->

This page describes the demo web app in `demo/`. It shows the built-in voices in a browser, and it is the reference for using phoonnx.js with Vite.

## What the demo does

The page lists the 36 built-in voices, grouped by speaker. You pick a voice, edit the sample text, and click **Synthesize**. The page plays the audio and offers it as a WAV download. The sliders set the speed, which is the inverse of `lengthScale`, and the volume. The advanced section sets `noiseScale` and `noiseW`.

`demo/src/main.ts` uses `loadVoice`, `synthesize` and `encodeWav` from `phoonnx`, and `makeEspeakTokenizer` from `phoonnx/espeak` for the espeak voices. It keeps each loaded voice in a `Map`, so a second synthesis with the same voice does not load it again.

## Run it

The demo depends on the package in the repository root through `"phoonnx": "file:.."`. Build the root package first, then the demo. These are the steps of `.github/workflows/pages.yml`:

```bash
npm install
npm run build
cd demo
npm install
npm run build
```

`npm run build` in `demo/` writes the site to `demo/dist/`. To serve the build, run `npx vite preview` in `demo/` and open `http://localhost:4173/phoonnx.js/`. For a development server with reload, run `npm run dev` in `demo/`.

A headless Chromium run of the built demo, which selects a unicode and an espeak voice and clicks **Synthesize**, gives:

```text
title: phoonnx — Voices Demo (Miro & Dii)
voices in the menu: 36
phoonnx_gl-ES_miro_unicode text: Ola! Esta voz fala directamente no teu navegador.
phoonnx_gl-ES_miro_unicode status: done · wasm
phoonnx_gl-ES_miro_unicode download name: phoonnx_gl-ES_miro_unicode.wav
pipertts_en-GB_dii text: Hello! This voice runs entirely in your browser.
pipertts_en-GB_dii status: done · wasm
pipertts_en-GB_dii download name: pipertts_en-GB_dii.wav
```

## Deployment

`.github/workflows/pages.yml` builds the demo on each push to `dev` and deploys `demo/dist/` to GitHub Pages. `demo/vite.config.js` sets the base path to `/phoonnx.js/`. The site is at [tigregotico.github.io/phoonnx.js](https://tigregotico.github.io/phoonnx.js/).

---
[Index](index.md) · [← Audio super-resolution](super-resolution.md) · [Testing →](testing.md)
