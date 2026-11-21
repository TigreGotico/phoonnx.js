# phoonnx.js documentation

<!-- agent-hint
covers: the reading order of every page in docs/, with what each page gives the reader
source: docs/*.md
generated: no
verify: diff <(ls docs | grep -v '^index.md$' | sort) <(grep -o '^[0-9]*\. \[[^]]*\]([^)]*)' docs/index.md | sed 's/.*(\(.*\))/\1/' | sort)
see: README.md, docs/getting-started.md
-->

This index lists the pages of the phoonnx.js documentation in reading order.
phoonnx.js runs phoonnx and Piper VITS voices with onnxruntime-web, in a browser or in Node.

1. [Getting started](getting-started.md): install the library from GitHub and make a web page speak a first sentence.
2. [Using a voice in the browser](browser.md): load unicode, espeak and Python-index voices in a page, browse the built-in voices, and self-host the WASM files.
3. [Using a voice in Node](node.md): run the same voices in a Node script, with the local paths that Node needs, and write WAV files.
4. [API reference](api.md): every export of `phoonnx`, `phoonnx/voices`, `phoonnx/espeak` and `phoonnx/pyodide`, with the options and the phoneme alignments.
5. [Audio super-resolution](super-resolution.md): upscale the audio to 48 kHz with one of four engines.
6. [The demo site](demo.md): run, build and deploy the Vite demo in `demo/`.
7. [Testing](testing.md): the CI checks, the unit tests, and the browser test against Python phoonnx.

Contributors start at [AGENTS.md](../AGENTS.md), which gives the repository map and the checks to run before a push.

---
[Index](index.md) · [← README](../README.md) · [Getting started →](getting-started.md)
