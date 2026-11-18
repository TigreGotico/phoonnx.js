// Browser test: phoonnx.js in headless Chromium against Python phoonnx.
//
//   node test/browser/run.mjs [--audio dir] [--texts tsv]
//        [cases.json] [reference.json] [out.json] [name ...]
//
// For each case it opens a fresh browser context (a cold start: no HTTP or
// Cache Storage reuse), fetches the voice from Python phoonnx's voice index,
// loads it with loadIndexVoice, and compares the token ids of each sentence
// with the ids reference_ids.py computed with Python phoonnx. It records the
// bytes downloaded per host, the time to a ready voice, and the audio.
//
// The stages "reject", "leak" and "offline" check how loadIndexVoice handles
// an unsupported phoneme type, repeated loads and a failed package install.
// The stage "legacy" checks that the unicode and espeak tokenizers return the
// same ids as the build in .baseline/.
//
// With no names it runs every case without probePackages and the stages
// reject, leak, offline, builtin and raw. Names select case types and stages. The
// process exits with code 1 when a case or stage fails. PHOONNX_DIST selects
// the build under test (default /dist).
//
// --audio writes the audio of each case and of the "builtin" stage to
// <dir>/<voice id, "/" as "__">.wav. --texts reads a TSV with the columns
// voice and text, and speaks that text instead of the case text. A case with
// a replaced text has no reference ids, so its ids are not compared. The
// "builtin" stage speaks the built-in voices of the TSV, or two default ones,
// through loadVoice, and checks that each reaches a peak of 1. The "raw" stage
// loads a voice through loadVoice and loadIndexVoice with normalizeAudio false,
// and checks that neither scales the audio.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const argv = process.argv.slice(2);
const option = (flag) => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const audioDir = option("--audio");
const textsPath = option("--texts");
const spokenTexts = new Map(textsPath
  ? (await readFile(textsPath, "utf8")).trim().split("\n").slice(1).map((line) => line.split("\t"))
  : []);
const [
  casesPath = here("cases.json"),
  refPath = here("reference.json"),
  outPath = here("results.json"),
  ...only
] = argv;
const runs = (name, byDefault) => (only.length ? only.includes(name) : byDefault);
const dist = process.env.PHOONNX_DIST ?? "/dist";
const wasmPaths = "/node_modules/onnxruntime-web/dist/";
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const reference = JSON.parse(await readFile(refPath, "utf8"));
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = {};
const failures = [];

function check(name, ok, detail) {
  console.log(`${name}\t${ok ? "PASS" : "FAIL"}\t${detail}`);
  if (!ok) failures.push(name);
}

async function saveAudio(voiceId, res) {
  if (!audioDir || !res.wav) return;
  await mkdir(audioDir, { recursive: true });
  res.audioPath = `${audioDir}/${voiceId.replaceAll("/", "__")}.wav`;
  await writeFile(res.audioPath, Buffer.from(res.wav, "base64"));
  delete res.wav;
}

const pinsOf = (voiceId) =>
  Object.fromEntries(Object.entries(reference[voiceId]?.versions ?? {}).filter(([, v]) => v));

async function withPage(fn, setup) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const bytes = {};
  const wheels = [];
  const net = { requests: 0 };
  page.on("request", () => { net.requests += 1; });
  await page.addInitScript(() => {
    window.wavBase64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
  });
  await setup?.(context, page);
  page.on("requestfinished", async (req) => {
    const host = new URL(req.url()).host;
    if (req.url().endsWith(".whl")) wheels.push(req.url().split("/").pop());
    const sizes = await req.sizes().catch(() => null);
    if (sizes) bytes[host] = (bytes[host] ?? 0) + sizes.responseBodySize;
  });
  const logs = [];
  page.on("console", (m) => logs.push(m.text().slice(0, 400)));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${origin}/test/browser/blank.html`);
  try {
    return { ...(await fn(page, net)), bytes, wheels, logs: logs.slice(-15) };
  } catch (e) {
    return { error: String(e).slice(0, 2000), bytes, wheels, logs: logs.slice(-15) };
  } finally {
    await context.close();
  }
}

for (const testCase of cases) {
  if (!runs(testCase.type, !testCase.probePackages)) continue;
  const ref = reference[testCase.voice_id] ?? {};
  // Install the package versions the reference used, so both sides run the same code.
  const pins = pinsOf(testCase.voice_id);
  const text = spokenTexts.get(testCase.voice_id) ?? testCase.text;
  const res = await withPage((page) => page.evaluate(async ({ testCase, text, pins, dist, wasmPaths, audio }) => {
    const t0 = performance.now();
    const { synthesize, encodeWav } = await import(`${dist}/index.js`);
    const pyodide = await import(`${dist}/pyodide.js`);
    // Probes for phoneme types phoonnx.js does not ship (licence or native code).
    Object.assign(pyodide.PHONEME_TYPE_PACKAGES, testCase.probePackages ?? {});
    const index = await pyodide.fetchVoiceIndex();
    const entry = index.get(testCase.voice_id);
    if (!entry) throw new Error(`not in the VITS index: ${testCase.voice_id}`);
    const stages = {};
    const voice = await pyodide.loadIndexVoice(entry, {
      webgpu: false,
      wasmPaths,
      pins,
      onProgress: (_f, label) => { stages[label.startsWith("downloading") ? "downloading" : label] ??= performance.now() - t0; },
    });
    const tReady = performance.now();
    const ids = await voice.tokenize(text, voice.idMap);
    const tIds = performance.now();
    const result = await synthesize(voice, text);
    const tAudio = performance.now();
    let peak = 0, sumSq = 0;
    for (const s of result.samples) { peak = Math.max(peak, Math.abs(s)); sumSq += s * s; }
    const wav = encodeWav(result.samples, result.sampleRate);
    const frontend = await pyodide.loadPyodideFrontend();
    const versions = frontend.versions();
    return {
      ids,
      samples: result.samples.length,
      sampleRate: result.sampleRate,
      peak,
      rms: Math.sqrt(sumSq / result.samples.length),
      wavBytes: wav.size,
      wavHeader: new TextDecoder().decode(new Uint8Array(await wav.slice(0, 4).arrayBuffer())),
      provider: voice.provider,
      ms: { ready: tReady - t0, textToIds: tIds - tReady, synthesize: tAudio - tIds, stages },
      versions: Object.fromEntries(Object.keys(pins).map((n) => [n, versions[n]])),
      wav: audio ? await window.wavBase64(wav) : undefined,
    };
  }, { testCase, text, pins, dist, wasmPaths, audio: Boolean(audioDir) }));
  await saveAudio(testCase.voice_id, res);
  // The GPL-3.0-or-later packages install only for a voice of their own type.
  const gplWheels = res.wheels.filter((w) => /^(pycotovia|ahotts_g2p)-/.test(w));
  res.lazyInstall = ["cotovia", "ahotts"].includes(testCase.type) || gplWheels.length === 0;
  res.text = text;
  if (!res.error && text !== testCase.text) {
    res.idsEqual = "not compared";
    res.versionsMatch = Object.entries(pins).every(([k, v]) => res.versions[k] === v);
  } else if (!res.error) {
    res.idsEqual = JSON.stringify(res.ids) === JSON.stringify(ref.ids);
    res.referenceVersions = ref.versions;
    res.versionsMatch = Object.entries(pins).every(([k, v]) => res.versions[k] === v);
  }
  results[testCase.voice_id] = { type: testCase.type, ...res };
  const brief = res.error ? `ERROR ${res.error.split("\n")[0]}` :
    `idsEqual=${res.idsEqual} versionsMatch=${res.versionsMatch} lazyInstall=${res.lazyInstall} samples=${res.samples} peak=${res.peak.toFixed(3)} rms=${res.rms.toFixed(4)} ready=${(res.ms.ready / 1000).toFixed(1)}s`;
  const ok = testCase.expectError
    ? Boolean(res.error)
    : !res.error && res.idsEqual !== false && res.versionsMatch && res.lazyInstall;
  check(`${testCase.type}\t${testCase.voice_id}`, ok, brief);
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

// A voice whose phoneme type has no browser front end rejects before any download.
if (runs("reject", true)) {
  const res = await withPage(async (page, net) => {
    await page.evaluate(async ({ dist }) => {
      const pyodide = await import(`${dist}/pyodide.js`);
      const index = await pyodide.fetchVoiceIndex();
      window.unsupported = [...index.values()].find((e) => e.phoneme_type === "unicode");
    }, { dist });
    net.requests = 0;
    const out = await page.evaluate(async ({ dist, wasmPaths }) => {
      const pyodide = await import(`${dist}/pyodide.js`);
      const call = pyodide.loadIndexVoice(window.unsupported, { webgpu: false, wasmPaths });
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ outcome: "pending" }), 5000));
      return Promise.race([
        call.then(() => ({ outcome: "resolved" }), (e) => ({ outcome: "rejected", message: String(e) })),
        timeout,
      ]).then((r) => ({ ...r, voiceId: window.unsupported.voice_id }));
    }, { dist, wasmPaths });
    return { ...out, requests: net.requests };
  });
  results.reject = res;
  check("reject", !res.error && res.outcome === "rejected" && res.requests === 0,
    res.error ?? `${res.voiceId} outcome=${res.outcome} requests=${res.requests} ${res.message ?? ""}`);
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

// Loading the same voice three times keeps one copy of each file in the Pyodide FS.
if (runs("leak", true)) {
  const voiceId = "coqui/bg-cv-vits";
  const res = await withPage((page) => page.evaluate(async ({ dist, wasmPaths, voiceId, pins }) => {
    const pyodide = await import(`${dist}/pyodide.js`);
    const entry = (await pyodide.fetchVoiceIndex()).get(voiceId);
    for (let i = 0; i < 3; i++) await pyodide.loadIndexVoice(entry, { webgpu: false, wasmPaths, pins });
    const fs = (await pyodide.loadPyodideFrontend()).pyodide.FS;
    const files = fs.readdir("/phoonnx-js/files").filter((n) => n !== "." && n !== "..");
    const urls = new Set(Object.entries(entry)
      .filter(([f, u]) => f.endsWith("_url") && f !== "model_url" && typeof u === "string")
      .map(([, u]) => u));
    return { files, urls: urls.size };
  }, { dist, wasmPaths, voiceId, pins: pinsOf(voiceId) }));
  results.leak = res;
  check("leak", !res.error && res.files.length === res.urls,
    res.error ?? `${voiceId} loads=3 urls=${res.urls} files=${res.files.length} ${JSON.stringify(res.files)}`);
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

// A failed package install reaches the caller and raises no unhandled rejection.
// The model download waits 20 s, so the front end fails while it runs.
if (runs("offline", true)) {
  const voiceId = "coqui/bg-cv-vits";
  const res = await withPage((page) => page.evaluate(async ({ dist, wasmPaths, voiceId }) => {
    const pyodide = await import(`${dist}/pyodide.js`);
    const entry = (await pyodide.fetchVoiceIndex()).get(voiceId);
    let outcome = "resolved", message;
    try {
      await pyodide.loadIndexVoice(entry, { webgpu: false, wasmPaths });
    } catch (e) {
      outcome = "rejected";
      message = String(e).slice(0, 300);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { outcome, message, unhandled: window.unhandled };
  }, { dist, wasmPaths, voiceId }), async (context, page) => {
    await context.route(/^https:\/\/(pypi\.org|files\.pythonhosted\.org)\//, (route) => route.abort());
    await context.route((url) => url.pathname.endsWith(".onnx"), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      await route.continue();
    });
    await page.addInitScript(() => {
      window.unhandled = [];
      addEventListener("unhandledrejection", (e) => window.unhandled.push(String(e.reason).slice(0, 200)));
    });
  });
  results.offline = res;
  check("offline", !res.error && res.outcome === "rejected" && res.unhandled.length === 0,
    res.error ?? `${voiceId} outcome=${res.outcome} unhandled=${res.unhandled.length} ${res.message ?? ""}`);
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

if (runs("legacy", false)) {
  const texts = JSON.parse(await readFile(new URL("./legacy-texts.json", import.meta.url), "utf8"));
  results.legacy = await withPage((page) => page.evaluate(async ({ texts, dist }) => {
    const now = await import(`${dist}/index.js`);
    const before = await import("/.baseline/index.js");
    const espeakNow = await import(`${dist}/espeak.js`);
    const espeakBefore = await import("/.baseline/espeak.js");
    const { default: espeakFactory } = await import("/node_modules/espeak-ng/dist/espeak-ng.js");
    const { voices } = await import(`${dist}/voices.js`);
    const wasm = "/node_modules/espeak-ng/dist/espeak-ng.wasm";
    const out = { unicode: [], espeak: [] };
    for (const v of voices) {
      const cfg = await (await fetch(`https://huggingface.co/${v.repo}/resolve/main/${v.config}`)).json();
      const idMap = now.flattenIdMap(cfg.phoneme_id_map);
      const keep = now.keepsPunctuation(cfg);
      for (const text of [v.sampleText, ...texts]) {
        if (v.phonemeType === "unicode") {
          const a = await now.tokenizeUnicode(text, idMap, { keepPunctuation: keep });
          const b = [before.tokenizeUnicode(text, idMap)];
          out.unicode.push({ id: v.id, text, equal: JSON.stringify(a) === JSON.stringify(b), n: a.length });
        } else {
          const a = await espeakNow.tokenizeEspeak(text, v.espeakVoice, idMap, espeakFactory, wasm, { keepPunctuation: keep });
          const b = [await espeakBefore.tokenizeEspeak(text, v.espeakVoice, idMap, espeakFactory, wasm)];
          out.espeak.push({ id: v.id, text, equal: JSON.stringify(a) === JSON.stringify(b), n: a.length });
        }
      }
    }
    // existing voices end to end through the unchanged loadVoice path
    const e2e = [];
    const ortOptions = { webgpu: false, wasmPaths: "/node_modules/onnxruntime-web/dist/" };
    for (const id of ["phoonnx_oc_dii_unicode", "phoonnx_eu-ES_dii_espeak"]) {
      const entry = voices.find((v) => v.id === id);
      const voice = await now.loadVoice(entry, ortOptions);
      const tokenize = entry.phonemeType === "espeak"
        ? (text, idMap) => espeakNow.tokenizeEspeak(text, entry.espeakVoice, idMap, espeakFactory, wasm, { keepPunctuation: voice.keepPunctuation })
        : undefined;
      const r = await now.synthesize(voice, entry.sampleText, { tokenize });
      let peak = 0;
      for (const s of r.samples) peak = Math.max(peak, Math.abs(s));
      e2e.push({ id, samples: r.samples.length, peak });
    }
    return { ...out, e2e };
  }, { texts, dist }));
  const l = results.legacy;
  const equal = (xs) => xs.filter((x) => x.equal).length;
  check("legacy",
    !l.error && equal(l.unicode) === l.unicode.length && equal(l.espeak) === l.espeak.length,
    l.error ?? `unicode ${equal(l.unicode)}/${l.unicode.length} equal\tespeak ${equal(l.espeak)}/${l.espeak.length} equal\te2e ${JSON.stringify(l.e2e)}`);
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

// Built-in voices of the --texts TSV, or two default ones, through loadVoice.
if (runs("builtin", true)) {
  const caseIds = new Set(cases.map((c) => c.voice_id));
  const ids = [...spokenTexts.keys()].filter((id) => !caseIds.has(id));
  for (const id of ids.length ? ids : ["phoonnx_oc_dii_unicode", "phoonnx_eu-ES_dii_espeak"]) {
    const res = await withPage((page) => page.evaluate(async ({ id, text, dist, wasmPaths, audio }) => {
      const { loadVoice, synthesize, encodeWav } = await import(`${dist}/index.js`);
      const { tokenizeEspeak } = await import(`${dist}/espeak.js`);
      const { default: espeakFactory } = await import("/node_modules/espeak-ng/dist/espeak-ng.js");
      const { voices } = await import(`${dist}/voices.js`);
      const entry = voices.find((v) => v.id === id);
      if (!entry) throw new Error(`not a built-in voice: ${id}`);
      const voice = await loadVoice(entry, { webgpu: false, wasmPaths });
      const tokenize = entry.phonemeType === "espeak"
        ? (t, idMap) => tokenizeEspeak(t, entry.espeakVoice, idMap, espeakFactory, "/node_modules/espeak-ng/dist/espeak-ng.wasm", { keepPunctuation: voice.keepPunctuation })
        : undefined;
      const spoken = text ?? entry.sampleText;
      const r = await synthesize(voice, spoken, { tokenize });
      let peak = 0, sumSq = 0;
      for (const s of r.samples) { peak = Math.max(peak, Math.abs(s)); sumSq += s * s; }
      return {
        text: spoken,
        phonemeType: entry.phonemeType,
        samples: r.samples.length,
        sampleRate: r.sampleRate,
        peak,
        rms: Math.sqrt(sumSq / r.samples.length),
        wav: audio ? await window.wavBase64(encodeWav(r.samples, r.sampleRate)) : undefined,
      };
    }, { id, text: spokenTexts.get(id), dist, wasmPaths, audio: Boolean(audioDir) }));
    await saveAudio(id, res);
    results[id] = { type: "builtin", ...res };
    // loadVoice peak-normalizes each model run by default
    check(`builtin\t${id}`, !res.error && res.samples > 0 && res.peak > 0.99,
      res.error ?? `${res.phonemeType} samples=${res.samples} peak=${res.peak.toFixed(3)} rms=${res.rms.toFixed(4)}`);
    await writeFile(outPath, JSON.stringify(results, null, 1));
  }
}

// normalizeAudio false keeps the model's raw level on both load paths.
if (runs("raw", true)) {
  const res = await withPage((page) => page.evaluate(async ({ dist, wasmPaths, pins }) => {
    const { loadVoice, synthesize } = await import(`${dist}/index.js`);
    const { voices } = await import(`${dist}/voices.js`);
    const pyodide = await import(`${dist}/pyodide.js`);
    const peakOf = (samples) => samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    const builtin = await loadVoice(voices.find((v) => v.id === "phoonnx_oc_dii_unicode"),
      { webgpu: false, wasmPaths, normalizeAudio: false });
    const entry = (await pyodide.fetchVoiceIndex()).get("coqui/bg-cv-vits");
    const index = await pyodide.loadIndexVoice(entry, { webgpu: false, wasmPaths, pins, normalizeAudio: false });
    return {
      loadVoice: { flag: builtin.normalizeAudio, peak: peakOf((await synthesize(builtin, builtin.entry.sampleText)).samples) },
      loadIndexVoice: { flag: index.normalizeAudio, peak: peakOf((await synthesize(index, "Добър ден.")).samples) },
    };
  }, { dist, wasmPaths, pins: pinsOf("coqui/bg-cv-vits") }));
  results.raw = res;
  for (const path of ["loadVoice", "loadIndexVoice"]) {
    const r = res[path];
    // peak normalization makes the loudest sample exactly 1
    check(`raw\t${path}`, !res.error && r.flag === false && r.peak > 0 && r.peak !== 1,
      res.error ?? `normalizeAudio=${r.flag} peak=${r.peak.toFixed(3)}`);
  }
  await writeFile(outPath, JSON.stringify(results, null, 1));
}

await browser.close();
server.close();
console.log(failures.length ? `FAILED ${failures.length}: ${failures.join(", ")}` : "ALL PASSED");
if (failures.length) process.exitCode = 1;
