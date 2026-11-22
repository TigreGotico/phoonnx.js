# API reference

<!-- agent-hint
covers: every name that the four entry points export, with its options and return type
source: src/index.ts, src/types.ts, src/voice.ts, src/tokenize.ts, src/audio.ts, src/cache.ts, src/voices.ts, src/espeak.ts, src/pyodide.ts, src/superres.ts
generated: no
verify: npm run build >/dev/null && ! grep -h '^export' dist/index.d.ts dist/voices.d.ts dist/espeak.d.ts dist/pyodide.d.ts | sed 's/^export \(type \)\?{//' | sed 's/}.*//' | tr ',' '\n' | sed 's/.* as //' | tr -d ' ' | grep -vxFf <(grep -o '[A-Za-z_][A-Za-z0-9_]*' docs/api.md | sort -u) | grep .
see: docs/browser.md, docs/node.md, docs/super-resolution.md
-->

This page lists what each entry point of the package exports. The how-to pages show the same functions in working examples.

The package has four entry points. Each one ships as ESM and CommonJS with type declarations:

| Import | Holds |
|---|---|
| `phoonnx` | Voice loading, synthesis, the unicode tokenizer, WAV encoding, super-resolution |
| `phoonnx/voices` | The built-in voice registry |
| `phoonnx/espeak` | The espeak-ng tokenizer. You supply the `espeak-ng` package |
| `phoonnx/pyodide` | The Python front end and the voice index of Python phoonnx |

## phoonnx

### loadVoice(entry, options?)

`loadVoice` downloads the config and the ONNX model of a `VoiceEntry` from Hugging Face, and creates an onnxruntime-web session. It returns a `Promise<LoadedVoice>`.

```ts
interface LoadVoiceOptions {
  wasmPaths?: string;        // onnxruntime-web WASM base URL. Default: jsDelivr, for the loaded onnxruntime-web version
  numThreads?: number;       // WASM threads. Default 1, which needs no COOP/COEP headers
  onProgress?: (frac: number, label: string) => void;
  hfBase?: string;           // Hugging Face base URL. Default "https://huggingface.co"
  webgpu?: boolean;          // try WebGPU first. Default true
  normalizeAudio?: boolean;  // scale the audio of each model run to a peak of 1. Default true
}
```

With `webgpu: true`, `loadVoice` creates a WebGPU session and runs a short warm-up inference. If the creation or the warm-up fails, it uses the WASM backend. `LoadedVoice.provider` is `"webgpu"` or `"wasm"`.

The downloads go through `fetchCached`. When the runtime has Cache Storage, as a browser has, a second load of the same voice reads the files from the `phoonnx-voices` cache. Node has no Cache Storage, so each load downloads the files again.

### synthesize(voice, text, options?)

`synthesize` turns text into audio. It returns a `Promise<SynthesisResult>`:

```ts
interface SynthesisResult {
  samples: Float32Array;                  // mono PCM in [-1, 1]
  sampleRate: number;
  alignments: PhonemeAlignment[] | null;  // per-phoneme durations, or null
}
```

```ts
interface SynthesizeOptions {
  noiseScale?: number;          // default: the voice config, else 0.667
  lengthScale?: number;         // default: the voice config, else 1.0. A larger value speaks slower
  noiseW?: number;              // default: the voice config, else 0.8
  includeAlignments?: boolean;  // read per-phoneme durations from the second model output
  tokenize?: Tokenizer;         // text to token ids
  superResolution?: boolean;    // upscale to 48 kHz. Default false
  superResolutionModel?: "novasr" | "hifiganbwe" | "lavasr" | "apbwe";  // default "novasr"
  superResolutionOptions?: SuperResolutionOptions;
}
```

`synthesize` picks the tokenizer in this order:

1. `options.tokenize`.
2. `voice.tokenize`, which `loadIndexVoice` sets.
3. `tokenizeUnicode`, when `voice.entry.phonemeType` is `"unicode"`.

For any other voice with no tokenizer, `synthesize` throws an error that names the phoneme type. A tokenizer returns one flat id list, or one id list for each sentence. With a list for each sentence, the model runs once for each sentence, and `synthesize` joins the audio in order. With `normalizeAudio`, each run is scaled to a peak of 1 before the join. If the text gives no token ids, `synthesize` throws `Nothing to synthesize — text produced no phoneme tokens.`

[Audio super-resolution](super-resolution.md) describes the three `superResolution` options.

### synthesizeWav(voice, text, options?)

`synthesizeWav` calls `synthesize` and returns the audio as a WAV `Blob`. It takes the same options.

### encodeWav(samples, sampleRate)

`encodeWav` encodes mono `Float32Array` samples as a 16-bit PCM WAV `Blob` of type `audio/wav`. It clips each sample to [-1, 1].

### tokenizeUnicode(text, idMap, options?)

`tokenizeUnicode` is the tokenizer of the unicode voices. It returns a `Promise<number[][]>`, one id list for each sentence.

The text splits into paragraphs, sentences and clauses with the rules of Python phoonnx. Each clause loses its punctuation. With `options.keepPunctuation: true`, each clause keeps its clause symbol, one of `. ? ! , : ;`.

The sentence split is the split of quebra_frases `sentence_tokenize`. A sentence ends at a space after a sentence mark of any script, such as `.`, `?`, `!`, `।` or `؟`. A Chinese or Japanese mark (`。`, `？`, `！`) ends a sentence with no space after it. A `.` after an abbreviation (`Dr.`, `e.g.`) or after an ordinal before a lowercase word (`3. de maio`) does not end the sentence. Closing quotes and brackets after the mark stay with the sentence (`« Òc ! » E` splits after `»`).

Each NFD codepoint becomes an id from the `phoneme_id_map` of the voice. A character that the map does not hold takes the ids of its decomposition, or the id of its lowercase form. If neither is in the map, the character is dropped. A blank id goes between the ids, and the BOS and EOS ids wrap each list.

Python phoonnx expands numbers, dates and abbreviations into words before this step, and it applies the phonetic spellings of the language. `tokenizeUnicode` does neither, so a text with digits gives other ids than Python phoonnx gives. The voices of `phoonnx/pyodide` run the Python front end, which does both steps.

### keepsPunctuation(config) and flattenIdMap(map)

`keepsPunctuation` reads a voice config as Python phoonnx reads it, and returns whether the voice keeps clause punctuation. `loadVoice` stores the result in `LoadedVoice.keepPunctuation`.

`flattenIdMap` turns a `phoneme_id_map` into a map from symbol to one id. A Piper config holds `{ "a": [14] }` and a phoonnx config holds `{ "a": 14 }`. Both give `{ a: 14 }`.

### Lower-level functions

| Function | What it does |
|---|---|
| `createSession(onnxUrl, options?)` | Downloads one ONNX model and creates its session, with the WebGPU and WASM steps of `loadVoice`. Returns `{ session, provider }` |
| `fetchCached(url, onProgress?)` | Fetches a URL into an `ArrayBuffer` through Cache Storage, when the runtime has it |
| `reconstructAlignments(ids, durations, hopLength, idxToChar, blankId, bosId, eosId)` | Folds the durations of the blank, BOS and EOS tokens into the real phonemes. `synthesize` calls it for `includeAlignments` |
| `loadSuperResolution(engine?, options?)` | Builds a `SuperResolution` engine, or returns `null` for an unknown name |
| `availableSuperResolutionEngines()` | Lists the super-resolution engines with their repository and size |

### Types

`phoonnx` also exports the types `VoiceEntry`, `VoiceConfig`, `LoadedVoice`, `LoadVoiceOptions`, `SynthesizeOptions`, `SynthesisResult`, `PhonemeAlignment`, `Tokenizer`, `IndexVoiceEntry`, `TokenizeOptions`, `SuperResolutionOptions` and `SuperResolutionEngine`, and the class `SuperResolution`.

```ts
type Tokenizer = (
  text: string,
  idMap: Record<string, number>,
) => number[] | number[][] | Promise<number[] | number[][]>;

interface LoadedVoice {
  entry: VoiceEntry;
  session: ort.InferenceSession;
  config: VoiceConfig;
  idMap: Record<string, number>;   // the flattened phoneme_id_map
  sampleRate: number;
  provider: string;                // "webgpu" or "wasm"
  keepPunctuation?: boolean;
  tokenize?: Tokenizer;            // the voice's own tokenizer, if any
  normalizeAudio?: boolean;
}
```

## phoonnx/voices

`phoonnx/voices` holds the built-in voices as a `VoiceEntry[]`. These are the Miro and Dii voices that TigreGóticoLda trained, and the pt-PT espeak voices Voice 3 and Voice 4:

| Export | Returns |
|---|---|
| `voices` | All built-in voices |
| `getVoice(id)` | The voice with that `id`, or `undefined` |
| `getVoicesByLang(lang)` | The voices whose `lang` is exactly `lang`. The tags have a region where the voice has one, such as `eu-ES` |
| `getVoicesBySpeaker(speaker)` | The voices whose `voice` is `speaker`, such as `"Miro"` or `"Dii"` |
| `getHaCompatibleVoices()` | The voices with `haCompatible: true`, which Piper and Home Assistant load |

```ts
interface VoiceEntry {
  id: string;                  // e.g. "phoonnx_eu-ES_dii_espeak"
  repo: string;                // Hugging Face repository
  voice: string;               // "Miro", "Dii", "Voice 3" or "Voice 4"
  lang: string;                // BCP-47 tag
  langLabel: string;
  phonemeType: string;         // "unicode" or "espeak" for the built-in voices
  onnx: string;                // model file name in the repository
  config: string;              // phoonnx config file name
  piperConfig: string | null;
  espeakVoice: string | null;  // espeak-ng voice, e.g. "eu", or null for unicode voices
  sampleRate: number;
  sampleText: string;          // a sentence in the language of the voice
  haCompatible: boolean;
}
```

## phoonnx/espeak

`makeEspeakTokenizer(espeakFactory, wasmUrl)` binds the espeak-ng WebAssembly module and returns a function:

```ts
(text: string, idMap: Record<string, number>, espeakVoice?: string, options?: TokenizeOptions)
  => Promise<number[][]>
```

`espeakFactory` is the default export of the `espeak-ng` package. `wasmUrl` is the location of `espeak-ng.wasm`: a URL in a browser, a file path in Node. Without `espeakVoice`, the function throws an error. The sentence, clause and punctuation rules are the rules of `tokenizeUnicode`. espeak-ng reads each clause alone and gives its IPA symbols. As with `tokenizeUnicode`, the text does not get the number expansion and phonetic spellings of Python phoonnx.

`tokenizeEspeak(text, espeakVoice, idMap, espeakFactory, wasmUrl, options?)` is the same tokenizer with all arguments in one call.

## phoonnx/pyodide

| Export | What it does |
|---|---|
| `fetchVoiceIndex(base?, files?)` | Downloads the voice index files of Python phoonnx and returns the single-graph VITS voices as a `Map` keyed by `voice_id` |
| `loadIndexVoice(entry, options?)` | Loads one index voice. The token ids come from the Python front end in Pyodide |
| `loadPyodideFrontend(options?)` | Loads Pyodide and the front-end packages. Every call on the page shares the first instance |
| `isVitsEntry(entry)` | Whether phoonnx.js can run an index entry: a VITS engine with one graph |
| `PHONEME_TYPE_PACKAGES` | The phoneme types with a front end, and the extra PyPI packages each type installs |
| `VITS_INDEX_FILES`, `VOICE_INDEX_BASE` | The index files that `fetchVoiceIndex` reads, and their base URL on the `dev` branch of phoonnx |
| `PYODIDE_VERSION` | The Pyodide release that the front end loads by default |

`loadIndexVoice` takes `LoadIndexVoiceOptions`: the `LoadVoiceOptions` and these options:

```ts
interface PyodideFrontendOptions {
  indexURL?: string;                  // Pyodide base. Default: jsDelivr, for PYODIDE_VERSION
  extraPackages?: string[];           // more PyPI requirements
  pins?: Record<string, string>;      // exact versions, e.g. { scriptconv: "0.0.4a85" }
  onProgress?: (frac: number, label: string) => void;
}
```

micropip installs each PyPI package without a pin at its newest release, prereleases included. micropip, numpy, regex, python-dateutil, pytz and six come from the Pyodide distribution of `PYODIDE_VERSION` instead. They install at the version of that distribution, and `pins` cannot change them. `loadPyodideFrontend` returns a `PyodideFrontend`, and its `loadVoice` returns the `FrontendVoiceInfo` that the Python front end read from the voice config. The first call that loads Pyodide fixes `indexURL`, `extraPackages` and `pins`. Later calls ignore these three options.

`loadIndexVoice` throws an error before any download when the entry is not a single-graph VITS voice, or when its phoneme type is not a key of `PHONEME_TYPE_PACKAGES`.

## Phoneme alignments

A model exported with `python -m phoonnx_train.export_onnx model.ckpt --config config.json --add-phoneme-alignment` has a second output that holds the duration of each token. With `includeAlignments: true`, `synthesize` turns it into one `{ phoneme, numSamples }` entry for each phoneme:

```ts
const result = await synthesize(voice, "Hello!", { includeAlignments: true });
for (const { phoneme, numSamples } of result.alignments ?? []) {
  console.log(phoneme, Math.round(numSamples / result.sampleRate * 1000) + " ms");
}
```

A model with one output gives `alignments: null`. The model of `phoonnx_pt-PT_miro_unicode` has one output, `output`, so it gives `null`. Use alignments for lip sync, word highlights or subtitles.

---
[Index](index.md) · [← Using a voice in Node](node.md) · [Audio super-resolution →](super-resolution.md)
