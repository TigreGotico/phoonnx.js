# Getting started

<!-- agent-hint
covers: how to install phoonnx.js and speak a first sentence in a web page
source: package.json, src/voice.ts:loadVoice, src/voice.ts:synthesizeWav, src/voices.ts:getVoice
generated: no
verify: none, checked by reading src/voice.ts:synthesizeWav and src/voices.ts:getVoice
see: docs/browser.md, docs/node.md
-->

This page takes you from an empty folder to a web page that speaks a sentence. You need Node with npm, a browser, and Python 3 for a local web server.

## Steps

1. Make a project folder:

   ```bash
   mkdir phoonnx-hello && cd phoonnx-hello
   npm init -y
   ```

2. Install phoonnx.js from GitHub, together with onnxruntime-web:

   ```bash
   npm install --allow-git=root github:TigreGotico/phoonnx.js onnxruntime-web
   ```

   phoonnx.js is not on the npm registry. npm 12 refuses a git dependency unless `--allow-git` permits it. npm builds the `dist/` folder of the package during the install.

3. Save this page as `index.html`:

   ```html
   <!doctype html>
   <meta charset="utf-8">
   <title>phoonnx.js first voice</title>
   <script type="importmap">
   {
     "imports": {
       "onnxruntime-web": "./node_modules/onnxruntime-web/dist/ort.bundle.min.mjs",
       "phoonnx": "./node_modules/phoonnx/dist/index.js",
       "phoonnx/voices": "./node_modules/phoonnx/dist/voices.js"
     }
   }
   </script>
   <button id="speak" disabled>Speak</button>
   <script type="module">
   import { loadVoice, synthesizeWav } from "phoonnx";
   import { getVoice } from "phoonnx/voices";

   const entry = getVoice("phoonnx_oc_dii_unicode");
   const voice = await loadVoice(entry, {
     onProgress: (frac, label) => console.log(label, frac.toFixed(2)),
   });
   console.log("provider:", voice.provider);

   const button = document.getElementById("speak");
   button.disabled = false;
   button.onclick = async () => {
     const blob = await synthesizeWav(voice, entry.sampleText);
     console.log("text:", entry.sampleText);
     console.log("wav type:", blob.type);
     await new Audio(URL.createObjectURL(blob)).play();
     console.log("playing");
   };
   </script>
   ```

   The import map tells the browser where the `phoonnx` and `onnxruntime-web` modules are. A bundler such as Vite does this step for you.

4. Start a web server in the folder:

   ```bash
   python3 -m http.server 8000
   ```

5. Open `http://localhost:8000/`, open the browser console, and click **Speak** when the button is active. The console shows:

   ```text
   initializing 1.00
   No available adapters.
   provider: wasm
   text: Adieu! Aquesta votz parla dins ton navegador.
   wav type: audio/wav
   playing
   ```

   The first load downloads the voice model, about 63 MB, from Hugging Face. The browser keeps it in Cache Storage, and a reload does not download it again. The `downloading` progress lines are left out above. The `No available adapters.` warning comes from onnxruntime-web in a browser with no WebGPU, and the library then uses WASM.

## Next steps

- [Using a voice in the browser](browser.md) adds the espeak voices and the voices of the Python phoonnx voice index.
- [Using a voice in Node](node.md) runs the same voices in a Node script and writes WAV files.
- [API reference](api.md) lists every option.

---
[Index](index.md) · [← Documentation index](index.md) · [Using a voice in the browser →](browser.md)
