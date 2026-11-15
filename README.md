# phoonnx.js

phoonnx.js runs VITS text-to-speech models in the browser with [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web). It needs no server and no API. Every model runs inside the browser.

It uses the same tokenizer paths as the Python [phoonnx](https://github.com/TigreGotico/phoonnx) library:

| Phonemizer | Voices | Notes |
|---|---|---|
| `unicode` | Miro & Dii unicode voices | NFD normalization + per-codepoint id lookup |
| `espeak` | Miro & Dii espeak voices, piper, Home Assistant | espeak-ng WASM → IPA → id lookup |
| `graphemes`, `vosk`, `tugaphone`, `cotovia`, `ahotts` | Meta MMS, Coqui grapheme VITS, vosk-tts, Miro & Dii tugaphone, Galician and Basque Coqui VITS | Python phoonnx front end in Pyodide (`phoonnx/pyodide`) |

The espeak voices work with piper and Home Assistant without changes. The same `.onnx` file runs in all three.

Live demo: [tigregotico.pt/demo](https://tigregotico.pt/demo)

---

## Install

phoonnx.js is not on npm. Install it straight from GitHub:

```bash
npm install github:TigreGotico/phoonnx.js onnxruntime-web
```

---

## Usage

### Unicode voices (no extra dependency)

```ts
import { loadVoice, synthesizeWav } from "phoonnx";
import { getVoice } from "phoonnx/voices";

const entry = getVoice("phoonnx_oc_dii_unicode")!;
const voice = await loadVoice(entry, {
  onProgress: (frac, label) => console.log(label, frac),
});

const blob = await synthesizeWav(voice, entry.sampleText);
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

### Voices from the Python phoonnx voice index (Pyodide front end)

`phoonnx/pyodide` loads single-graph VITS voices from the voice index of Python
phoonnx. For these voices the token ids come from the Python front end itself:
phoonnx, scriptconv and the voice's phonemizer, run in
[Pyodide](https://pyodide.org). The front end splits the text into sentences,
expands numbers, dates and abbreviations, and phonemizes, as Python phoonnx
does. The model still runs in onnxruntime-web.

```ts
import { synthesizeWav } from "phoonnx";
import { fetchVoiceIndex, loadIndexVoice } from "phoonnx/pyodide";

const index = await fetchVoiceIndex();   // VITS voices, by voice_id
const voice = await loadIndexVoice(index.get("facebook/mms-tts-por-Portuguese")!);
const blob = await synthesizeWav(voice, "Olá! Esta voz fala no teu navegador.");
```

Pyodide loads only when a voice needs it. The first such voice downloads
about 10 MB of Pyodide from the jsDelivr CDN and about 17 MB of Python wheels
from PyPI; `tugaphone` voices add about 20 MB more. The browser caches these
files. The phoneme types with a front end are the keys of
`PHONEME_TYPE_PACKAGES`: `graphemes`, `vosk`, `tugaphone`, `cotovia` and `ahotts`.
The `cotovia` and `ahotts` types install GPL-3.0-or-later packages (pycotovia and
ahotts-g2p) from PyPI at runtime.

Options, in addition to those of `loadVoice`:

```ts
interface PyodideFrontendOptions {
  indexURL?: string;                  // Pyodide base URL, default: jsDelivr
  extraPackages?: string[];           // more PyPI requirements
  pins?: Record<string, string>;      // exact versions, e.g. { scriptconv: "0.0.4a85" }
  onProgress?: (frac: number, label: string) => void;
}
```

One Pyodide runtime serves every voice on the page. The first call that loads
it fixes `indexURL`, `extraPackages` and `pins`. Later calls ignore these three
options.

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

Downloads the ONNX model and config from HuggingFace, caches them in CacheStorage,
and creates an onnxruntime-web session. It uses WebGPU when available and falls
back to WASM. It returns a `LoadedVoice`.

```ts
interface LoadVoiceOptions {
  wasmPaths?: string;   // ort WASM CDN base, default: jsDelivr
  numThreads?: number;  // default: 1 (avoids COOP/COEP requirement)
  onProgress?: (frac: number, label: string) => void;
  hfBase?: string;      // HuggingFace base URL, default: https://huggingface.co
  webgpu?: boolean;     // try WebGPU first, default: true
  normalizeAudio?: boolean;  // peak-normalize each model run, default: true
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

Shorthand that chains `synthesize`, `encodeWav`, and `Blob` creation.

### `encodeWav(samples, sampleRate)`

Encodes a `Float32Array` to a 16-bit PCM WAV `Blob`.

### `tokenizeUnicode(text, idMap)`

The unicode tokenizer. It strips punctuation, applies NFD normalization, looks up
each codepoint in the phoneme_id_map, intersperses a blank token, then wraps the
result with BOS and EOS markers.

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

Use this for visemes and lip-sync, karaoke word highlighting, or subtitle generation.

---

## Browser test

`npm run test:browser` runs the voices of `test/browser/cases.json` in headless
Chromium with Playwright. It compares their token ids with the Python phoonnx
ids in `test/browser/reference.json`, and installs the package versions that the
reference records. It also checks that `loadIndexVoice` rejects an unsupported
phoneme type before any download, keeps one copy of each voice file over
repeated loads, and passes a failed package install to the caller with no
unhandled rejection. The command exits with code 1 when a check fails.

The full form is `npm run test:browser -- [--audio dir] [--texts tsv]
[cases.json] [reference.json] [out.json] [name ...]`. A name selects a case type
or a stage. The cases with `probePackages` test phoneme types that phoonnx.js
does not ship, and run only when you name their type. The `legacy` stage checks
that the unicode and espeak tokenizers return the same ids as a build of the
base branch in `.baseline/`.

`--audio dir` saves the audio of each voice as a 16-bit WAV file in `dir`, with
`/` in the voice id written as `__`. `--texts tsv` reads a file with the columns
`voice` and `text`, and speaks that text in place of the case text. The ids of
a replaced text are not compared, because the reference does not have them. The
`builtin` stage speaks the built-in voices of that file through `loadVoice`, or
two default built-in voices, and checks that each reaches a peak of 1. The `raw`
stage loads a voice through `loadVoice` and `loadIndexVoice` with
`normalizeAudio: false`, and checks that neither scales the audio.

`python test/browser/reference_ids.py test/browser/cases.json
test/browser/reference.json` writes the reference file. Run it in a Python
environment with phoonnx, scriptconv and the phonemizer packages of the cases.

---

## Self-hosting WASM assets

The default setup loads the onnxruntime-web WASM files from the jsDelivr CDN. To self-host them:

```ts
const voice = await loadVoice(entry, {
  wasmPaths: "/assets/ort/",  // must end with /
});
```

Copy the files from `node_modules/onnxruntime-web/dist/ort-wasm*.{wasm,mjs}` to your `/assets/ort/` directory.

---

## Related projects

- [phoonnx](https://github.com/TigreGotico/phoonnx) — the Python library this project mirrors.

## License

Apache-2.0, the same license as the Python phoonnx library.
