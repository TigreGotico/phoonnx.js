# phoonnx.js: agent guide

phoonnx.js is a TypeScript library that runs phoonnx and Piper VITS voices with onnxruntime-web, in a browser or in Node. For a text with no digits, dates, abbreviations or words that the language respells, its unicode and espeak tokenizers give the same token ids as the Python phoonnx library. They do not expand numbers or apply phonetic spellings ([api.md](docs/api.md#tokenizeunicodetext-idmap-options)). The documentation index is [docs/index.md](docs/index.md).

## Repository map

| Path | Holds |
|---|---|
| `src/index.ts` | The exports of `phoonnx` |
| `src/voice.ts` | `loadVoice`, `createSession`, `synthesize`, `synthesizeWav` |
| `src/tokenize.ts`, `src/frontend.ts` | The unicode tokenizer, and the paragraph, sentence and clause split of Python phoonnx |
| `src/espeak.ts` | The `phoonnx/espeak` entry point |
| `src/pyodide.ts`, `src/python/frontend.py` | The `phoonnx/pyodide` entry point and the Python front end that runs in Pyodide |
| `src/voices.ts`, `src/voices-data.json` | The `phoonnx/voices` entry point and the built-in voices |
| `src/superres.ts`, `src/dsp.ts` | Super-resolution engines and their signal processing |
| `src/audio.ts`, `src/cache.ts`, `src/types.ts` | WAV encoding and alignments, the Cache Storage fetch, the shared types |
| `tsup.config.ts` | The build of the four entry points into `dist/`, ESM and CommonJS |
| `test/*.test.ts`, `test/fixtures/` | Node unit tests and their reference values |
| `test/browser/` | The headless browser test against Python phoonnx |
| `demo/` | The Vite demo site that deploys to GitHub Pages |
| `docs/` | The documentation |

## Setup and tests

```bash
npm install
npm run typecheck
npm run build
npm test
```

The root has no lock file. `npm install` resolves the newest versions in the ranges of `package.json`. `npm test` downloads the token-id fixture of Python phoonnx from GitHub, unless `PHOONNX_ID_FIXTURE` names a local copy ([testing.md](docs/testing.md)).

The browser test needs a build and the Playwright Chromium:

```bash
npx playwright install chromium
npm run test:browser
```

## Hard rules

1. The unicode and espeak tokenizers give the token ids of Python phoonnx for each row of the shared fixture. `test/id_parity.test.ts` checks these rows, which hold no digits. Python phoonnx owns that fixture, and `test/id_parity_fixture.mjs` pins its commit ([testing.md](docs/testing.md#the-ci-checks)).
2. The super-resolution DSP matches the Python `audiosronnx` values. `test/dsp.test.ts` checks them against `test/fixtures/dsp_fixtures.json`, which `test/fixtures/gen_fixtures.py` writes ([super-resolution.md](docs/super-resolution.md#engines)).
3. `onnxruntime-web` is a peer dependency, and the caller supplies `espeak-ng`. `tsup.config.ts` keeps both out of the bundle ([api.md](docs/api.md)).
4. Super-resolution is off by default, and its default engine is `novasr`, as in Python phoonnx. A failed or unknown engine gives native-rate audio and a warning. `test/superres.test.ts` and `test/synthesize.test.ts` check this ([super-resolution.md](docs/super-resolution.md#how-it-runs)).
5. `loadIndexVoice` accepts only single-graph VITS voices whose phoneme type is a key of `PHONEME_TYPE_PACKAGES`, and it rejects the rest before any download. The `reject` stage of the browser test checks this ([api.md](docs/api.md#phoonnxpyodide)).
6. `test/browser/reference.json` comes from `test/browser/reference_ids.py`, run with Python phoonnx ([testing.md](docs/testing.md#the-browser-test)).

## Before a push

Run the four commands of the setup, which are the CI steps of `.github/workflows/ci.yml`. If the change touches `src/pyodide.ts`, `src/python/frontend.py` or a tokenizer, also run `npm run test:browser`. If it touches `demo/`, run `npm run build` in `demo/` after the root build.
