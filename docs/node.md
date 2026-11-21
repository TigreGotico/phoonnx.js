# Using a voice in Node

<!-- agent-hint
covers: how to run the unicode, espeak and Pyodide voices in Node, and what Node needs that a browser does not
source: src/voice.ts:loadVoice, src/voice.ts:createSession, src/cache.ts:fetchCached, src/espeak.ts:makeEspeakTokenizer, src/pyodide.ts:loadIndexVoice
generated: no
verify: run each script on this page with node in a project that installed phoonnx, espeak-ng and pyodide. Then compare the output with the text block under it
see: docs/browser.md, docs/api.md
-->

This page shows how to run phoonnx.js voices in a Node script. The library code is the same as in a browser, but Node needs local paths in place of the default CDN URLs:

1. Set `wasmPaths` to the local `onnxruntime-web/dist/` folder as a `file:` URL. Node cannot import the default jsDelivr URL, and `loadVoice` fails with `no available backend found`.
2. Give a file path for the espeak-ng WASM file, and for the Pyodide folder.

onnxruntime-web has no WebGPU in Node, so `loadVoice` uses WASM. The examples set `webgpu: false` to skip the WebGPU attempt. Without it, the result is the same.

Node has no Cache Storage. Each `loadVoice` call downloads the model again, about 63 MB for a built-in voice. Keep the `LoadedVoice` object for the life of the process.

The examples run as ES modules. Set `"type": "module"` in `package.json`, or name the files `.mjs`.

## A unicode voice

A unicode voice needs no extra package:

```js
import { writeFile } from "node:fs/promises";
import { loadVoice, synthesize, encodeWav } from "phoonnx";
import { getVoice } from "phoonnx/voices";

const entry = getVoice("phoonnx_pt-PT_miro_unicode");
const wasmPaths = new URL("./node_modules/onnxruntime-web/dist/", import.meta.url).href;
const voice = await loadVoice(entry, { wasmPaths, webgpu: false });
console.log("provider:", voice.provider, "sample rate:", voice.sampleRate);

const result = await synthesize(voice, entry.sampleText);
console.log("text:", entry.sampleText);
console.log("seconds:", (result.samples.length / result.sampleRate).toFixed(2));

const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("out.wav", Buffer.from(await wav.arrayBuffer()));
console.log("wrote out.wav,", wav.size, "bytes");
```

```text
provider: wasm sample rate: 22050
text: Olá! Esta voz corre no teu navegador, sem servidores.
seconds: 3.34
wrote out.wav, 147500 bytes
```

The duration and the file size change a little from run to run, because VITS adds random noise to each synthesis. `encodeWav` returns a `Blob`. `Buffer.from(await blob.arrayBuffer())` turns it into bytes for `writeFile`.

## An espeak voice

Install the espeak-ng WebAssembly build. It is GPL-3.0-or-later:

```bash
npm install espeak-ng
```

In Node, `makeEspeakTokenizer` takes the file path of `espeak-ng.wasm`:

```js
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import espeakFactory from "espeak-ng";
import { loadVoice, synthesize, encodeWav } from "phoonnx";
import { makeEspeakTokenizer } from "phoonnx/espeak";
import { getVoice } from "phoonnx/voices";

const wasmPaths = new URL("./node_modules/onnxruntime-web/dist/", import.meta.url).href;
const espeakWasm = fileURLToPath(new URL("./node_modules/espeak-ng/dist/espeak-ng.wasm", import.meta.url));
const tokenize = makeEspeakTokenizer(espeakFactory, espeakWasm);

const entry = getVoice("pipertts_en-GB_miro");
const voice = await loadVoice(entry, { wasmPaths, webgpu: false });

const text = "Hello! This voice runs in Node. It reads two sentences.";
const ids = await tokenize(text, voice.idMap, entry.espeakVoice);
console.log("espeak voice:", entry.espeakVoice, "sentences:", ids.length);

const result = await synthesize(voice, text, {
  tokenize: (t, idMap) =>
    tokenize(t, idMap, entry.espeakVoice, { keepPunctuation: voice.keepPunctuation }),
});
console.log("keepPunctuation:", voice.keepPunctuation);
console.log("seconds:", (result.samples.length / result.sampleRate).toFixed(2));

const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("espeak.wav", Buffer.from(await wav.arrayBuffer()));
console.log("wrote espeak.wav,", wav.size, "bytes");
```

```text
espeak voice: en-gb-x-rp sentences: 2
keepPunctuation: true
seconds: 4.40
wrote espeak.wav, 194092 bytes
```

The text has three sentence ends, but the tokenizer gives two sentences. A space after `.` or `?` ends a sentence, as in Python phoonnx, so `Hello! This voice runs in Node.` is one sentence.

## A voice from the Python voice index

`phoonnx/pyodide` runs the Python phoonnx front end in Pyodide. In Node, install the Pyodide package at the version that `PYODIDE_VERSION` names, and pass its folder as a file path in `indexURL`:

```bash
npm install pyodide@314.0.8
```

```js
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { synthesize, encodeWav } from "phoonnx";
import { fetchVoiceIndex, loadIndexVoice } from "phoonnx/pyodide";

const wasmPaths = new URL("./node_modules/onnxruntime-web/dist/", import.meta.url).href;
const indexURL = fileURLToPath(new URL("./node_modules/pyodide/", import.meta.url));

const index = await fetchVoiceIndex();
console.log("VITS voices in the index:", index.size);

const voice = await loadIndexVoice(index.get("facebook/mms-tts-por-Portuguese"), {
  wasmPaths,
  indexURL,
  pins: { phoonnx: "1.113.10a2" },
  webgpu: false,
  onProgress: (frac, label) => console.log(label),
});
const result = await synthesize(voice, "Olá! Tenho 3 gatos.");
console.log("phoneme type:", voice.entry.phonemeType, "sample rate:", result.sampleRate);
console.log("seconds:", (result.samples.length / result.sampleRate).toFixed(2));
const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("mms.wav", Buffer.from(await wav.arrayBuffer()));
console.log("wrote mms.wav,", wav.size, "bytes");
```

```text
VITS voices in the index: 1539
loading Python
Loading micropip, numpy, python-dateutil, pytz, regex, six
Loaded micropip, numpy, python-dateutil, pytz, regex, six
installing the phoonnx front end
Python ready
initializing
loading the text front end
2026-11-21 20:39:51.447 - OVOS - phoonnx.providers:available_providers:94 - WARNING - could not query onnxruntime providers: phoonnx.js front end: this call needs a package it does not load
phoneme type: graphemes sample rate: 16000
seconds: 2.13
wrote mms.wav, 68140 bytes
```

Pyodide also prints two lines for each package that it downloads from the jsDelivr CDN, and it keeps a copy in `node_modules/pyodide/`. The output above leaves those lines out. The WARNING line comes from the Python phoonnx log. The pin on `phoonnx` is necessary: [Using a voice in the browser](browser.md#the-phoonnx-pin) explains why.

---
[Index](index.md) · [← Using a voice in the browser](browser.md) · [API reference →](api.md)
