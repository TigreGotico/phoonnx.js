# Using a voice in Node

<!-- agent-hint
covers: how to run the unicode, espeak and Pyodide voices in Node, and what Node needs that a browser does not
source: src/voice.ts:loadVoice, src/voice.ts:createSession, src/cache.ts:fetchCached, src/espeak.ts:makeEspeakTokenizer, src/pyodide.ts:loadIndexVoice
generated: no
verify: npm install --no-save pyodide@314.0.8 >/dev/null && npm run build >/dev/null && diff <(node --input-type=module -e "$(awk -v n=1 '/^\140\140\140/{f=0} $0=="\140\140\140js"{c++} $0=="\140\140\140js"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md)" 2>&1) <(awk -v n=1 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md) && diff <(node --input-type=module -e "$(awk -v n=2 '/^\140\140\140/{f=0} $0=="\140\140\140js"{c++} $0=="\140\140\140js"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md)" 2>&1) <(awk -v n=2 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md) && diff <(node --input-type=module -e "$(awk -v n=3 '/^\140\140\140/{f=0} $0=="\140\140\140js"{c++} $0=="\140\140\140js"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md)" 2>&1 | grep -v -e '^Didn.t find' -e '^Package ' -e ' - WARNING - ') <(awk -v n=3 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' docs/node.md) && rm out.wav espeak.wav mms.wav
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
const peak = result.samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
console.log("text:", entry.sampleText);
console.log("peak:", peak);

const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("out.wav", Buffer.from(await wav.arrayBuffer()));
console.log("out.wav:", wav.type, (wav.size - 44) / result.samples.length, "bytes per sample");
```

```text
provider: wasm sample rate: 22050
text: Olá! Esta voz corre no teu navegador, sem servidores.
peak: 1
out.wav: audio/wav 2 bytes per sample
```

`synthesize` scales the audio of each sentence to a peak of 1, so `peak` is 1. `encodeWav` writes a 44-byte header and 16-bit samples. It returns a `Blob`, and `Buffer.from(await blob.arrayBuffer())` turns it into bytes for `writeFile`.

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

const text = "Hello! This voice runs in Node. It reads three sentences.";
const options = { keepPunctuation: voice.keepPunctuation };
const ids = await tokenize(text, voice.idMap, entry.espeakVoice, options);
console.log("espeak voice:", entry.espeakVoice, "keepPunctuation:", voice.keepPunctuation);
console.log("sentences:", ids.length, "first ids:", ids[0].slice(0, 8).join(" "));

const result = await synthesize(voice, text, {
  tokenize: (t, idMap) => tokenize(t, idMap, entry.espeakVoice, options),
});
const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("espeak.wav", Buffer.from(await wav.arrayBuffer()));
console.log("espeak.wav:", wav.type, result.sampleRate, "Hz");
```

```text
espeak voice: en-gb-x-rp keepPunctuation: true
sentences: 3 first ids: 1 0 20 0 59 0 24 0
espeak.wav: audio/wav 22050 Hz
```

The text has three sentence ends, and the tokenizer gives three sentences. A space after `.`, `?` or `!` ends a sentence, as in Python phoonnx. A space after `!` does not end the sentence when a lowercase letter follows, as in `Yahoo! and Microsoft`.

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
const entry = index.get("facebook/mms-tts-por-Portuguese");
console.log("phoneme type:", entry.phoneme_type);

const voice = await loadIndexVoice(entry, { wasmPaths, indexURL, webgpu: false });
const result = await synthesize(voice, "Olá! Tenho 3 gatos.");
const wav = encodeWav(result.samples, result.sampleRate);
await writeFile("mms.wav", Buffer.from(await wav.arrayBuffer()));
console.log("mms.wav:", wav.type, result.sampleRate, "Hz");
```

```text
phoneme type: graphemes
Loading micropip, numpy, python-dateutil, pytz, regex, six
Loaded micropip, numpy, python-dateutil, pytz, regex, six
mms.wav: audio/wav 16000 Hz
```

Pyodide prints one `Loading` line and one `Loaded` line. On the first run, it also prints two lines for each package that it downloads from the jsDelivr CDN, and it keeps a copy in `node_modules/pyodide/`. Python phoonnx logs a WARNING line, with a time stamp, because the front end does not load onnxruntime. The output above leaves out the download lines and the WARNING line.

---
[Index](index.md) · [← Using a voice in the browser](browser.md) · [API reference →](api.md)
