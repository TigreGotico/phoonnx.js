# Using a voice in the browser

<!-- agent-hint
covers: how to load the unicode, espeak and Python-index voices in a web page, browse the built-in voices, and self-host the WASM files
source: src/voice.ts, src/voices.ts, src/espeak.ts, src/pyodide.ts, src/python/frontend.py, demo/src/main.ts
generated: no
verify: npm run build >/dev/null && diff <(node --input-type=module -e "$(awk -v n=5 '/^\140\140\140/{f=0} $0=="\140\140\140js"{c++} $0=="\140\140\140js"&&c==n{f=2} f==1{print} f==2{f=1}' docs/browser.md)" 2>&1) <(awk -v n=4 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' docs/browser.md)
see: docs/getting-started.md, docs/node.md, docs/api.md
-->

This page shows how to use each kind of voice in a web page. It starts with the import setup, then gives one example for each phoneme type.

## Import the package

A bundler such as Vite resolves the `phoonnx`, `phoonnx/voices`, `phoonnx/espeak` and `phoonnx/pyodide` imports from `node_modules`. The demo in `demo/` uses Vite. Exclude `onnxruntime-web` from the dependency pre-bundling, as `demo/vite.config.js` does:

```js
optimizeDeps: {
  exclude: ["onnxruntime-web"],
},
```

A page with no bundler needs an import map. The examples on this page run in this page, served from the project folder:

```html
<!doctype html>
<meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "onnxruntime-web": "./node_modules/onnxruntime-web/dist/ort.bundle.min.mjs",
    "phoonnx": "./node_modules/phoonnx/dist/index.js",
    "phoonnx/voices": "./node_modules/phoonnx/dist/voices.js",
    "phoonnx/espeak": "./node_modules/phoonnx/dist/espeak.js",
    "phoonnx/pyodide": "./node_modules/phoonnx/dist/pyodide.js",
    "espeak-ng": "./node_modules/espeak-ng/dist/espeak-ng.js"
  }
}
</script>
<script type="module">
  // the example code goes here
</script>
```

Serve the folder over HTTP, for example with `python3 -m http.server 8000`.

The outputs on this page come from headless Chromium. It has no GPU adapter, so onnxruntime-web prints `No available adapters.` and `loadVoice` uses WASM. In a browser with WebGPU, `voice.provider` is `webgpu`.

## A unicode voice

A unicode voice needs no extra package. `synthesizeWav` returns a WAV `Blob` that an `<audio>` element can play:

```js
import { loadVoice, synthesizeWav } from "phoonnx";
import { getVoice } from "phoonnx/voices";

const entry = getVoice("phoonnx_oc_dii_unicode");
const voice = await loadVoice(entry, {
  onProgress: (frac, label) => console.log(label, frac.toFixed(2)),
});

const blob = await synthesizeWav(voice, entry.sampleText);
console.log("provider:", voice.provider, "text:", entry.sampleText);
console.log("wav type:", blob.type);
const audio = new Audio(URL.createObjectURL(blob));
```

```text
initializing 1.00
No available adapters.
provider: wasm text: Adieu! Aquesta votz parla dins ton navegador.
wav type: audio/wav
```

`onProgress` also reports each step of the download, as `downloading 12.3 MB` labels. The output above leaves those lines out. The browser keeps the model in Cache Storage, so the next load of the voice does not download it again.

## An espeak voice

An espeak voice needs the espeak-ng WebAssembly build, which is GPL-3.0-or-later:

```bash
npm install espeak-ng
```

`makeEspeakTokenizer` takes the espeak-ng module and the URL of its WASM file. Pass the tokenizer to `synthesize`, with the espeak-ng voice of the entry and the punctuation setting of the voice:

```js
import espeakFactory from "espeak-ng";
import { loadVoice, synthesize, encodeWav } from "phoonnx";
import { makeEspeakTokenizer } from "phoonnx/espeak";
import { getVoice } from "phoonnx/voices";

const tokenize = makeEspeakTokenizer(espeakFactory, "./node_modules/espeak-ng/dist/espeak-ng.wasm");

const entry = getVoice("phoonnx_eu-ES_dii_espeak");
const voice = await loadVoice(entry);

const ids = await tokenize("Kaixo mundua. Zer moduz?", voice.idMap, entry.espeakVoice);
console.log("sentences:", ids.length, "first ids:", ids[0].slice(0, 8).join(" "));

const result = await synthesize(voice, "Kaixo mundua. Zer moduz?", {
  tokenize: (text, idMap) =>
    tokenize(text, idMap, entry.espeakVoice, { keepPunctuation: voice.keepPunctuation }),
});
const blob = encodeWav(result.samples, result.sampleRate);
console.log("provider:", voice.provider, "sample rate:", result.sampleRate, "wav type:", blob.type);
```

```text
No available adapters.
sentences: 2 first ids: 1 0 23 0 120 0 14 0
provider: wasm sample rate: 22050 wav type: audio/wav
```

The tokenizer returns one id list for each sentence. `synthesize` runs the model once for each list and joins the audio. For this voice, each list starts with the BOS id `1`, and the blank id `0` follows each symbol id.

With Vite, import the WASM URL as an asset, as `demo/src/main.ts` does:

```ts
import espeakWasmUrl from "espeak-ng/dist/espeak-ng.wasm?url";
const tokenize = makeEspeakTokenizer(espeakFactory, espeakWasmUrl);
```

## A voice from the Python voice index

`phoonnx/pyodide` loads the single-graph VITS voices of the voice index of Python phoonnx. The token ids of these voices come from the Python front end in [Pyodide](https://pyodide.org). The front end is phoonnx, scriptconv and the phonemizer of the voice. The front end splits the text into sentences, expands numbers, dates and abbreviations, and phonemizes, as Python phoonnx does. The model still runs in onnxruntime-web.

```js
import { synthesizeWav } from "phoonnx";
import { fetchVoiceIndex, loadIndexVoice } from "phoonnx/pyodide";

const index = await fetchVoiceIndex();
const voice = await loadIndexVoice(index.get("facebook/mms-tts-por-Portuguese"), {
  onProgress: (frac, label) => { if (!label.startsWith("downloading")) console.log(label); },
});
const blob = await synthesizeWav(voice, "Olá! Esta voz fala no teu navegador.");
console.log("phoneme type:", voice.entry.phonemeType, "sample rate:", voice.sampleRate);
console.log("wav type:", blob.type);
```

```text
loading Python
installing the phoonnx front end
Python ready
initializing
No available adapters.
loading the text front end
phoneme type: graphemes sample rate: 16000
wav type: audio/wav
```

The output leaves out the two summary lines of Pyodide, `Loading …` and `Loaded …`, and a WARNING line with a time stamp from the Python phoonnx log. The front end does not load onnxruntime, and phoonnx logs that.

Pyodide loads only when a voice needs it. The first such voice downloads Pyodide from the jsDelivr CDN and the Python wheels from PyPI, and the browser caches them. The phoneme types with a front end are the keys of `PHONEME_TYPE_PACKAGES`: `graphemes`, `vosk`, `tugaphone`, `cotovia` and `ahotts`. The `tugaphone`, `cotovia` and `ahotts` types install more packages when their first voice loads. The `cotovia` and `ahotts` types install pycotovia, ahotts-g2p and scriptconv-copyleft. pycotovia and ahotts-g2p are GPL-3.0-or-later. On PyPI, scriptconv-copyleft declares the licence expression `Apache-2.0 AND GPL-3.0-only AND GPL-3.0-or-later AND CC-BY-4.0`.

One Pyodide runtime serves every voice on the page. The first call that loads it fixes `indexURL`, `extraPackages` and `pins`. Later calls ignore these three options.

## Browse the built-in voices

`phoonnx/voices` holds the built-in voices: the Miro and Dii voices, and the pt-PT voices Voice 3 and Voice 4. The language tags carry a region, so a lookup by `eu` finds nothing and a lookup by `eu-ES` finds the Basque voices:

```js
import { voices, getVoicesByLang, getHaCompatibleVoices, getVoicesBySpeaker } from "phoonnx/voices";

console.log("voices:", voices.length);
console.log("eu:", getVoicesByLang("eu").length, "eu-ES:", getVoicesByLang("eu-ES").map((v) => v.id).join(", "));
console.log("Home Assistant:", getHaCompatibleVoices().length, "Dii:", getVoicesBySpeaker("Dii").length);
```

```text
voices: 36
eu: 0 eu-ES: phoonnx_eu-ES_dii_espeak, phoonnx_eu-ES_miro_espeak
Home Assistant: 27 Dii: 14
```

## Self-host the WASM files

By default, `loadVoice` loads the onnxruntime-web WASM files from jsDelivr, for the version of onnxruntime-web that the page loaded. To serve them yourself, copy `node_modules/onnxruntime-web/dist/ort-wasm*.{wasm,mjs}` into a folder of your site, and pass its URL:

```js
import { loadVoice, synthesize } from "phoonnx";
import { getVoice } from "phoonnx/voices";

const voice = await loadVoice(getVoice("phoonnx_an_dii_unicode"), {
  wasmPaths: "/node_modules/onnxruntime-web/dist/",
});
await synthesize(voice, "Bienvenius.");
const wasm = performance.getEntriesByType("resource").map((r) => r.name).filter((n) => n.includes("ort-wasm"));
console.log(wasm.join("\n"));
```

```text
No available adapters.
http://localhost:8010/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs
http://localhost:8010/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm
```

The URLs in the output carry the address of the server. The value must end with `/`. Give a path from the site root or a full URL. onnxruntime-web resolves a relative path against its own module URL, so `./node_modules/onnxruntime-web/dist/` becomes `node_modules/onnxruntime-web/dist/node_modules/onnxruntime-web/dist/` and the load fails with `no available backend found`.

`numThreads` sets the number of WASM threads. The default of 1 needs no special headers. More threads need a cross-origin isolated page, with the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers.

---
[Index](index.md) · [← Getting started](getting-started.md) · [Using a voice in Node →](node.md)
