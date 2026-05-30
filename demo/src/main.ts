import "./style.css";
import { loadVoice, synthesize, encodeWav, type LoadedVoice } from "phoonnx";
import { voices, type VoiceEntry } from "phoonnx/voices";
import { makeEspeakTokenizer } from "phoonnx/espeak";
// @ts-expect-error — emscripten module ships no types
import espeakFactory from "espeak-ng";
import espeakWasmUrl from "espeak-ng/dist/espeak-ng.wasm?url";

// ── theme toggle (persisted) ───────────────────────────────────────────────
const root = document.documentElement;
if (localStorage.getItem("phoonnx-theme") === "light") root.classList.remove("dark");
document.getElementById("theme-toggle")!.addEventListener("click", () => {
  root.classList.toggle("dark");
  localStorage.setItem("phoonnx-theme", root.classList.contains("dark") ? "dark" : "light");
});

// ── voice dropdown: Dii first, then Miro, then extras ──────────────────────
const VOICE_ORDER: Record<string, number> = { Dii: 0, Miro: 1, "Voice 3": 2, "Voice 4": 3 };
const VOICE_LABELS: Record<string, string> = { Miro: "Miro (male)", Dii: "Dii (female)" };
const sorted = [...voices].sort(
  (a, b) =>
    (VOICE_ORDER[a.voice] ?? 9) - (VOICE_ORDER[b.voice] ?? 9) ||
    a.langLabel.localeCompare(b.langLabel),
);
const byId = new Map<string, VoiceEntry>(voices.map((v) => [v.id, v]));
const sel = document.getElementById("voice") as HTMLSelectElement;
const groupsSeen = new Map<string, HTMLOptGroupElement>();
for (const v of sorted) {
  let og = groupsSeen.get(v.voice);
  if (!og) {
    og = document.createElement("optgroup");
    og.label = VOICE_LABELS[v.voice] || v.voice;
    groupsSeen.set(v.voice, og);
    sel.append(og);
  }
  const opt = document.createElement("option");
  opt.value = v.id;
  opt.textContent = `${v.langLabel} · ${v.haCompatible ? "eSpeak (Home Assistant)" : "Unicode"}`;
  og.append(opt);
}

// ── refs ───────────────────────────────────────────────────────────────────
const textEl = document.getElementById("text") as HTMLTextAreaElement;
const btn = document.getElementById("synth") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLSpanElement;
const result = document.getElementById("result") as HTMLDivElement;
const player = document.getElementById("player") as HTMLAudioElement;
const download = document.getElementById("download") as HTMLAnchorElement;
const speed = document.getElementById("speed") as HTMLInputElement;
const volume = document.getElementById("volume") as HTMLInputElement;
const noise = document.getElementById("noise") as HTMLInputElement;
const noisew = document.getElementById("noisew") as HTMLInputElement;
const reset = document.getElementById("reset") as HTMLButtonElement;

const espeakTokenize = makeEspeakTokenizer(espeakFactory, espeakWasmUrl);
const cache = new Map<string, LoadedVoice>();
const DEFAULTS = { speed: "1", volume: "1", noise: "0.667", noisew: "0.8" };

function syncLabels() {
  (document.getElementById("speedVal") as HTMLElement).textContent = `${(+speed.value).toFixed(2)}×`;
  (document.getElementById("volumeVal") as HTMLElement).textContent = `${Math.round(+volume.value * 100)}%`;
  (document.getElementById("noiseVal") as HTMLElement).textContent = (+noise.value).toFixed(3);
  (document.getElementById("noisewVal") as HTMLElement).textContent = (+noisew.value).toFixed(3);
}
for (const el of [speed, volume, noise, noisew]) el.addEventListener("input", syncLabels);
reset.addEventListener("click", () => {
  speed.value = DEFAULTS.speed;
  volume.value = DEFAULTS.volume;
  noise.value = DEFAULTS.noise;
  noisew.value = DEFAULTS.noisew;
  syncLabels();
});
syncLabels();

function prefill() {
  const v = byId.get(sel.value);
  if (v) textEl.value = v.sampleText;
}
sel.addEventListener("change", prefill);
prefill();

btn.addEventListener("click", async () => {
  const entry = byId.get(sel.value);
  if (!entry) return;
  const text = textEl.value.trim();
  if (!text) return;
  btn.disabled = true;
  try {
    let loaded = cache.get(entry.id);
    if (!loaded) {
      status.textContent = "loading voice…";
      loaded = await loadVoice(entry, {
        onProgress: (frac, label) => {
          status.textContent = `${label}${frac ? ` — ${Math.round(frac * 100)}%` : ""}`;
        },
      });
      cache.set(entry.id, loaded);
    }
    status.textContent = "synthesizing…";
    const tokenize =
      entry.phonemeType === "espeak"
        ? (t: string, idMap: Record<string, number>) =>
            espeakTokenize(t, idMap, entry.espeakVoice ?? undefined)
        : undefined;
    const { samples, sampleRate } = await synthesize(loaded, text, {
      lengthScale: 1 / +speed.value,
      noiseScale: +noise.value,
      noiseW: +noisew.value,
      tokenize,
    });
    const vol = +volume.value;
    const out =
      vol !== 1 ? Float32Array.from(samples, (s) => Math.max(-1, Math.min(1, s * vol))) : samples;
    const blob = encodeWav(out, sampleRate);
    const url = URL.createObjectURL(blob);
    player.src = url;
    download.href = url;
    download.download = `${entry.id}.wav`;
    result.classList.remove("hidden");
    status.textContent = `done · ${loaded.provider}`;
    player.play().catch(() => {});
  } catch (err) {
    status.textContent = (err as Error).message || "synthesis failed";
  } finally {
    btn.disabled = false;
  }
});
