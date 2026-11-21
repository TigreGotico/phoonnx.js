# Audio super-resolution

<!-- agent-hint
covers: how to upscale the audio of a voice to 48 kHz, the four engines, their options, and what happens when an engine fails
source: src/superres.ts, src/voice.ts:synthesize, src/types.ts:SynthesizeOptions, test/synthesize.test.ts, test/superres.test.ts
generated: no
verify: npm test (the super-resolution tests), and run the example on this page with node in a project that installed phoonnx. Then compare the output with the text block
see: docs/api.md, docs/testing.md
-->

This page shows how to upscale the audio of a voice to 48 kHz. The upscaling runs the audio through an [TigreGotico/audiosronnx](https://github.com/TigreGotico/audiosronnx) ONNX model after synthesis.

## Turn it on

Super-resolution is off by default. Turn it on for one call with `superResolution: true`. This Node script compares the two outputs:

```js
import { loadVoice, synthesize, availableSuperResolutionEngines } from "phoonnx";
import { getVoice } from "phoonnx/voices";

for (const e of availableSuperResolutionEngines()) {
  console.log(e.engine, e.approxMB, "MB", e.repo);
}

const wasmPaths = new URL("./node_modules/onnxruntime-web/dist/", import.meta.url).href;
const voice = await loadVoice(getVoice("phoonnx_pt-PT_miro_unicode"), { wasmPaths, webgpu: false });

const native = await synthesize(voice, "Olá mundo.");
const upscaled = await synthesize(voice, "Olá mundo.", { superResolution: true });
console.log("native:", native.sampleRate, "Hz,", native.samples.length, "samples");
console.log("upscaled:", upscaled.sampleRate, "Hz,", upscaled.samples.length, "samples");

const unknown = await synthesize(voice, "Olá mundo.", {
  superResolution: true,
  superResolutionModel: "nosuchengine",
});
console.log("unknown engine:", unknown.sampleRate, "Hz");
```

```text
lavasr 52 MB TigreGotico/audiosronnx-lavasr
novasr 0.05 MB TigreGotico/audiosronnx-novasr
hifiganbwe 4 MB TigreGotico/audiosronnx-hifiganbwe
apbwe 120 MB TigreGotico/audiosronnx-apbwe
native: 22050 Hz, 19456 samples
upscaled: 48000 Hz, 44024 samples
[phoonnx] unknown super-resolution engine "nosuchengine"; known: lavasr, novasr, hifiganbwe, apbwe. Falling back to native audio.
unknown engine: 22050 Hz
```

The sample counts change from run to run, because VITS adds random noise to each synthesis.

## How it runs

The model runs once for each sentence, after the peak normalization of that sentence. The model files download from Hugging Face at a fixed revision the first time a voice uses the engine. In a browser, Cache Storage keeps them. Each voice loads an engine once for each engine name, and later calls use the same engine.

If the model cannot download or run, `synthesize` logs a warning and returns the whole text at the native sample rate of the voice. An unknown engine name also gives a warning and native-rate audio, as the example shows. Python phoonnx raises an error for an unknown engine name.

The alignments of an upscaled result are in samples at 48 kHz.

## Engines

The neural part of each engine is one or two ONNX graphs. The signal processing around it, such as resampling, STFT, the mel filterbank and the spectral merge, is written in TypeScript. `test/dsp.test.ts` compares it with the Python reference values in `test/fixtures/dsp_fixtures.json`.

| `superResolutionModel` | Input rate | Download | Model |
|---|---|---|---|
| `novasr` (default) | 16 kHz | about 0.05 MB | A small conv1d generator, one pass in the time domain |
| `hifiganbwe` | any | about 4 MB | WaveNet bandwidth extension |
| `lavasr` | 8 to 48 kHz | about 52 MB | Two graphs (Vocos) and a spectral merge with the original band |
| `apbwe` | any | about 120 MB | Dual-ConvNeXt amplitude and phase bandwidth extension |

All engines give 48 kHz audio. The download size matters most in a browser. `apbwe` is a 120 MB download.

## Options

`superResolutionOptions` holds the download and engine options. They apply when the engine first loads for a voice:

```ts
interface SuperResolutionOptions {
  denoise?: boolean;          // lavasr only: run the UL-UNAS denoiser first. Default false
  cutoffHz?: number | null;   // lavasr only: keep the original band below this frequency
  hfBase?: string;            // Hugging Face base URL
  wasmPaths?: string;         // onnxruntime-web WASM base URL
  webgpu?: boolean;           // try WebGPU for the engine graphs. Default true
  onProgress?: (frac: number, label: string) => void;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}
```

`logger.warn` receives the failure warnings. Without a logger, they go to `console.warn`.

## Python phoonnx

Python phoonnx has the same option in its `SynthesisConfig`:

| phoonnx.js option | Python `SynthesisConfig` field | Effective default |
|---|---|---|
| `superResolution` | `super_resolution` | off |
| `superResolutionModel` | `super_resolution_model` | `"novasr"` |

The Python field `super_resolution_model` defaults to `None`, and Python phoonnx then loads `"novasr"`.

---
[Index](index.md) · [← API reference](api.md) · [The demo site →](demo.md)
