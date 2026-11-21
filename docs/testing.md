# Testing

<!-- agent-hint
covers: the checks that CI runs, the Node unit tests, the headless browser test against Python phoonnx, and how the reference files are made
source: package.json:scripts, .github/workflows/ci.yml, test/*.test.ts, test/id_parity_fixture.mjs, test/browser/run.mjs, test/browser/reference_ids.py, test/fixtures/gen_fixtures.py
generated: no
verify: npm test 2>&1 | grep '^ℹ' | grep -v duration_ms | diff - <(awk -v n=1 '/^\140\140\140/{f=0} $0=="\140\140\140text"{c++} $0=="\140\140\140text"&&c==n{f=2} f==1{print} f==2{f=1}' docs/testing.md)
see: docs/api.md, AGENTS.md
-->

This page lists the tests of phoonnx.js and the command for each one. It also says where the reference values come from.

## The CI checks

`.github/workflows/ci.yml` runs these commands on each pull request and on each push to `dev`, with Node 26:

```bash
npm install
npm run typecheck
npm run build
npm test
```

`npm test` runs the Node unit tests in `test/*.test.ts` with `node --import tsx --test`. The summary lines of a run, without the `duration_ms` line, are:

```text
ℹ tests 36
ℹ suites 0
ℹ pass 36
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

| File | What it checks |
|---|---|
| `test/id_parity.test.ts` | The unicode and espeak tokenizers give the same token ids as Python phoonnx, for each row of the shared fixture |
| `test/frontend.test.ts` | The clause split follows Python scriptconv, and long inputs split in linear time |
| `test/dsp.test.ts` | The super-resolution DSP matches the Python values in `test/fixtures/dsp_fixtures.json` |
| `test/superres.test.ts` | The engine registry, the default engine and the warning for an unknown engine |
| `test/synthesize.test.ts` | Super-resolution inside `synthesize`, with stub ONNX sessions |

Python phoonnx owns the token-id fixture: `tests/fixtures/id_parity.json` in TigreGotico/phoonnx. `test/id_parity_fixture.mjs` downloads it at the commit in `PHOONNX_COMMIT`. To use a local copy, set `PHOONNX_ID_FIXTURE` to its path.

`python test/fixtures/gen_fixtures.py` writes `test/fixtures/dsp_fixtures.json` from the `audiosronnx` Python package. The docstring of the script gives the venv commands.

## The browser test

`npm run test:browser` runs `test/browser/run.mjs`. It starts a local web server for the repository and opens each case of `test/browser/cases.json` in headless Chromium with Playwright, in a fresh browser context. It loads the voice with `loadIndexVoice` and compares the token ids of each sentence with the ids of Python phoonnx in `test/browser/reference.json`. The front end installs the package versions that the reference records. The command exits with code 1 when a check fails. CI does not run it.

Without names, the command runs every case without `probePackages`, and the stages `reject`, `leak`, `offline`, `builtin` and `raw`:

| Stage | What it checks |
|---|---|
| `reject` | `loadIndexVoice` rejects an unsupported phoneme type before any download |
| `leak` | Repeated loads keep one copy of each voice file |
| `offline` | A failed package install reaches the caller, with no unhandled rejection |
| `builtin` | Built-in voices load through `loadVoice` and reach a peak of 1 |
| `raw` | With `normalizeAudio: false`, neither `loadVoice` nor `loadIndexVoice` scales the audio |
| `legacy` | The unicode and espeak tokenizers return the same ids as a build of the base branch in `.baseline/`. It runs only when you name it |

The full form is:

```bash
npm run test:browser -- [--audio dir] [--texts tsv] [cases.json] [reference.json] [out.json] [name ...]
```

A name selects a case type, such as `graphemes`, or a stage. The cases with `probePackages` test phoneme types that phoonnx.js does not ship, and they run only when you name their type. `--audio dir` saves the audio of each voice as a 16-bit WAV file in `dir`, with `/` in the voice id written as `__`. `--texts tsv` reads a file with the columns `voice` and `text`, and speaks that text in place of the case text. The ids of a replaced text are not compared, because the reference does not have them. `PHOONNX_DIST` selects the build under test, `/dist` by default.

The command reads the first three positional arguments as the three paths, so a name comes after all three. `npm run test:browser -- reject` reads `reject` as the path of the cases file and fails with `ENOENT`. To run the `graphemes` cases and the `reject` stage, give the three default paths first:

```bash
npm run test:browser -- test/browser/cases.json test/browser/reference.json test/browser/results.json graphemes reject
```

The output is:

```text
graphemes	facebook/mms-tts-eng-English	PASS	idsEqual=true versionsMatch=true lazyInstall=true samples=84480 peak=1.000 rms=0.1348 ready=21.4s
graphemes	facebook/mms-tts-por-Portuguese	PASS	idsEqual=true versionsMatch=true lazyInstall=true samples=55296 peak=1.000 rms=0.1636 ready=17.1s
graphemes	coqui/bg-cv-vits	PASS	idsEqual=true versionsMatch=true lazyInstall=true samples=23296 peak=1.000 rms=0.1957 ready=17.0s
reject	PASS	OpenVoiceOS/phoonnx_oc_miro_unicode outcome=rejected requests=0 Error: phoneme type "unicode" has no browser front end in phoonnx.js
ALL PASSED
```

The sample counts, the RMS values and the `ready` times change from run to run. `idsEqual=true` says that the token ids match the reference. `versionsMatch=true` says that the front end installed the package versions that the reference records.

`python test/browser/reference_ids.py test/browser/cases.json test/browser/reference.json` writes the reference file. Run it in a Python environment with phoonnx, scriptconv and the phonemizer packages of the cases.

---
[Index](index.md) · [← The demo site](demo.md)
