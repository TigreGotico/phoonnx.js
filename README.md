# phoonnx.js

In-browser VITS text-to-speech inference with [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web). No server. No API. Models run entirely in your browser.

Implements the same tokenizer paths as the Python [phoonnx](https://github.com/TigreGotico/phoonnx) library:

| Phonemizer | Voices | Notes |
|---|---|---|
| `unicode` | Miro & Dii unicode voices | NFD normalization + per-codepoint id lookup |
| `espeak` | Miro & Dii espeak voices, piper, Home Assistant | espeak-ng WASM → IPA → id lookup |

The espeak voices are **drop-in compatible with piper / Home Assistant** — the same `.onnx` file works in both.

Live demo: [tigregotico.pt/demo](https://tigregotico.pt/demo)

---

## Install

Installed straight from GitHub (not published to npm):

```bash
npm install github:TigreGotico/phoonnx.js onnxruntime-web
```

---

## Usage

### Unicode voices (no extra dependency)

```ts
import { loadVoice, synthesizeWav } from "phoonnx";
import { getVoice } from "phoonnx/voices";

const entry = getVoice("phoonnx_eu-ES_dii_unicode")!;
const voice = await loadVoice(entry, {
  onProgress: (frac, label) => console.log(label, frac),
});

const blob = await synthesizeWav(voice, "Kaixo mundua!");
const audio = new Audio(URL.createObjectURL(blob));
audio.play();
```

### espeak voices (piper / Home Assistant compatible)

```ts
import { loadVoice, synthesize, encodeWav } from "phoonnx";
import { makeEspeakTokenizer } from "phoonnx/espeak";
import { getVoice } from "phoonnx/voices";

// In a Vite/Astro project:
import espeakFactory from "espeak-ng";
import espeakWasmUrl from "espeak-ng/dist/espeak-ng.wasm?url";

const tokenize = makeEspeakTokenizer(espeakFactory, espeakWasmUrl);

const entry = getVoice("phoonnx_eu-ES_dii_espeak")!;
const voice = await loadVoice(entry);

const result = await synthesize(voice, "Kaixo mundua!", {
  tokenize: (text, idMap) => tokenize(text, idMap, entry.espeakVoice!),
});
const blob = encodeWav(result.samples, result.sampleRate);
```

### Browse all voices

```ts
import { voices, getVoicesByLang, getHaCompatibleVoices } from "phoonnx/voices";

console.log(voices.length); // 30+

const euVoices = getVoicesByLang("eu");   // Basque
const haVoices = getHaCompatibleVoices(); // piper/HA-compatible
```

---

## API

### `loadVoice(entry, options?)`

Downloads the ONNX model + config from HuggingFace (cached in CacheStorage),
creates an onnxruntime-web session (WebGPU if available, WASM fallback), and
returns a `LoadedVoice`.

```ts
interface LoadVoiceOptions {
  wasmPaths?: string;   // ort WASM CDN base, default: jsDelivr
  numThreads?: number;  // default: 1 (avoids COOP/COEP requirement)
  onProgress?: (frac: number, label: string) => void;
  hfBase?: string;      // HuggingFace base URL, default: https://huggingface.co
}
```

### `synthesize(voice, text, options?)`

Returns a `SynthesisResult`:

```ts
interface SynthesisResult {
  samples: Float32Array;             // float32 PCM [-1, 1]
  sampleRate: number;
  alignments: PhonemeAlignment[] | null;  // per-phoneme timings if supported
}
```

Options:

```ts
interface SynthesizeOptions {
  noiseScale?: number;      // default: from model config (0.667)
  lengthScale?: number;     // default: from model config (1.0)
  noiseW?: number;          // default: from model config (0.8)
  includeAlignments?: boolean;  // request per-phoneme timing output
  tokenize?: (text: string, idMap: Record<string, number>) => number[] | Promise<number[]>;
}
```

### `synthesizeWav(voice, text, options?)`

Shorthand for `synthesize` → `encodeWav` → `Blob`.

### `encodeWav(samples, sampleRate)`

Encode a `Float32Array` to a 16-bit PCM WAV `Blob`.

### `tokenizeUnicode(text, idMap)`

The unicode tokenizer: strip punctuation → NFD normalize → per-codepoint
phoneme_id_map lookup → intersperse blank → wrap BOS/EOS.

---

## Voice registry

`phoonnx/voices` exports the Miro & Dii voice list as a typed `VoiceEntry[]`:

```ts
interface VoiceEntry {
  id: string;
  repo: string;        // HuggingFace repo
  voice: "Miro" | "Dii";
  lang: string;        // BCP-47
  langLabel: string;
  phonemeType: "unicode" | "espeak";
  onnx: string;        // filename in repo
  config: string;
  piperConfig: string | null;
  espeakVoice: string | null;
  sampleRate: number;
  sampleText: string;
  haCompatible: boolean;
}
```

---

## Phoneme alignment

Models exported with `phoonnx-train export-onnx --add-phoneme-alignment` expose
per-phoneme timing. Pass `includeAlignments: true` to `synthesize()`:

```ts
const result = await synthesize(voice, "Hello!", { includeAlignments: true });
if (result.alignments) {
  for (const { phoneme, numSamples } of result.alignments) {
    const ms = numSamples / result.sampleRate * 1000;
    console.log(phoneme, ms.toFixed(0) + "ms");
  }
}
```

Typical use-cases: visemes / lip-sync, karaoke word highlighting, subtitle generation.

---

## Self-hosting WASM assets

By default the onnxruntime-web WASM is loaded from jsDelivr CDN. To self-host:

```ts
const voice = await loadVoice(entry, {
  wasmPaths: "/assets/ort/",  // must end with /
});
```

Copy the files from `node_modules/onnxruntime-web/dist/ort-wasm*.{wasm,mjs}` to your `/assets/ort/` directory.

---

## License

Apache-2.0 — same as the Python phoonnx library.
