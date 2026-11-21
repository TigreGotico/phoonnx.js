# phoonnx.js

<!-- agent-hint
covers: what phoonnx.js does, how to install it, a first example, and where each topic lives in docs/
source: package.json, src/index.ts, src/voices-data.json, src/pyodide.ts:PHONEME_TYPE_PACKAGES
generated: no
verify: npm run build >/dev/null && diff <(node --input-type=module -e "$(awk -v n=1 '/^\140\140\140/{f=0} $0=="\140\140\140js"{c++} $0=="\140\140\140js"&&c==n{f=2} f==1{print} f==2{f=1}' README.md)" 2>&1) <(awk -v n=1 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' README.md) && rm out.wav
see: docs/index.md, docs/getting-started.md
-->

phoonnx.js runs VITS text-to-speech voices with [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web), in a browser or in Node. The model runs on the machine of the user, so the library needs no speech server and no API key.

Its unicode and espeak tokenizers split the text into sentences as the Python [TigreGotico/phoonnx](https://github.com/TigreGotico/phoonnx) library does. For a text with no digits, dates, abbreviations or words that the language respells, they give the same token ids. They do not expand numbers or apply phonetic spellings, so other text can give other ids ([api.md](docs/api.md#tokenizeunicodetext-idmap-options)). The Pyodide voices run the Python front end, which does both steps. The phoneme type of a voice selects the tokenizer:

| Phoneme type | Voices | Tokenizer |
|---|---|---|
| `unicode` | The Miro and Dii unicode voices | NFD normalization, then one id for each codepoint |
| `espeak` | The Miro and Dii espeak voices and the pt-PT voices Voice 3 and Voice 4. Each one also loads in Piper | espeak-ng in WebAssembly turns the text into IPA, then one id for each symbol |
| `graphemes`, `vosk`, `tugaphone`, `cotovia`, `ahotts` | Meta MMS, Coqui grapheme VITS, vosk-tts, Miro and Dii tugaphone, and the Galician, Basque and Spanish VITS voices of Proxecto Nós and HiTZ | The Python phoonnx front end, run in [Pyodide](https://pyodide.org) |

The same `.onnx` file of an espeak voice runs in phoonnx.js, in Python phoonnx, in Piper and in Home Assistant.

## Install

phoonnx.js is not on the npm registry. Install it from GitHub, together with its peer dependency `onnxruntime-web`:

```bash
npm install --allow-git=root github:TigreGotico/phoonnx.js onnxruntime-web
```

npm 12 refuses a git dependency unless `--allow-git` permits it. The install builds the `dist/` folder from the `dev` branch.

## First example

This Node script loads a built-in voice and writes a WAV file. Save it as `out.mjs` in the folder of the install, and run `node out.mjs`:

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

The voice model downloads from Hugging Face. [Getting started](docs/getting-started.md) gives the same steps for a browser page.

## Documentation

The [documentation index](docs/index.md) lists every page in reading order:

- [Getting started](docs/getting-started.md): install the library and speak a first sentence.
- [Using a voice in the browser](docs/browser.md) and [Using a voice in Node](docs/node.md).
- [API reference](docs/api.md) and [Audio super-resolution](docs/super-resolution.md).
- [The demo site](docs/demo.md) and [Testing](docs/testing.md).

The demo in `demo/` runs at [tigregotico.github.io/phoonnx.js](https://tigregotico.github.io/phoonnx.js/).

## Related projects

- [TigreGotico/phoonnx](https://github.com/TigreGotico/phoonnx): the Python library that phoonnx.js follows. Its voice index lists the voices that `phoonnx/pyodide` loads.
- [TigreGotico/audiosronnx](https://github.com/TigreGotico/audiosronnx): the super-resolution models that the `superResolution` option runs.

## License

Apache-2.0, the same license as the Python phoonnx library. The `espeak-ng` package that the espeak voices need is GPL-3.0-or-later. The `cotovia` and `ahotts` front ends install GPL-3.0-or-later Python packages at runtime.
