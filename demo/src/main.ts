import { loadVoice, synthesizeWav, type LoadedVoice } from "phoonnx";
import { voices, type VoiceEntry } from "phoonnx/voices";
import { makeEspeakTokenizer } from "phoonnx/espeak";

// espeak-ng WASM — Vite resolves the ?url to the built asset path
// @ts-expect-error no types for espeak-ng emscripten module
import espeakFactory from "espeak-ng";
import espeakWasmUrl from "espeak-ng/dist/espeak-ng.wasm?url";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const voiceSel   = document.getElementById("voice")         as HTMLSelectElement;
const badgesEl   = document.getElementById("voice-badges")  as HTMLDivElement;
const textEl     = document.getElementById("text")          as HTMLTextAreaElement;
const synthBtn   = document.getElementById("synth")         as HTMLButtonElement;
const statusEl   = document.getElementById("status")        as HTMLSpanElement;
const progressWrap = document.getElementById("progress-wrap") as HTMLDivElement;
const progressBar  = document.getElementById("progress-bar")  as HTMLDivElement;
const resultEl   = document.getElementById("result")        as HTMLDivElement;
const playerEl   = document.getElementById("player")        as HTMLAudioElement;
const downloadEl = document.getElementById("download")      as HTMLAnchorElement;
const providerBadge = document.getElementById("provider-badge") as HTMLSpanElement;

// ---------------------------------------------------------------------------
// Build voice dropdown
// ---------------------------------------------------------------------------
const byId = new Map<string, VoiceEntry>(voices.map((v) => [v.id, v]));

// Group by speaker
const groups: Record<string, VoiceEntry[]> = {};
for (const v of voices) {
  (groups[v.voice] ??= []).push(v);
}
for (const [speaker, items] of Object.entries(groups)) {
  const og = document.createElement("optgroup");
  og.label = speaker;
  for (const v of items) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.langLabel;
    og.append(opt);
  }
  voiceSel.append(og);
}

function updateBadges(entry: VoiceEntry) {
  badgesEl.innerHTML = "";
  const add = (text: string, cls?: string) => {
    const b = document.createElement("span");
    b.className = "badge" + (cls ? " " + cls : "");
    b.textContent = text;
    badgesEl.append(b);
  };
  add(entry.lang);
  if (entry.phonemeType === "espeak") add("eSpeak", "espeak");
  if (entry.haCompatible) add("Home Assistant compatible", "ha");
}

function prefill(entry: VoiceEntry) {
  textEl.value = entry.sampleText;
  updateBadges(entry);
}

voiceSel.addEventListener("change", () => {
  const e = byId.get(voiceSel.value);
  if (e) prefill(e);
});

const first = byId.get(voiceSel.value);
if (first) prefill(first);

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------
const voiceCache = new Map<string, LoadedVoice>();
const espeakTokenize = makeEspeakTokenizer(espeakFactory, espeakWasmUrl);

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
}

function setProgress(frac: number) {
  if (frac <= 0 || frac >= 1) {
    progressWrap.style.display = "none";
  } else {
    progressWrap.style.display = "block";
    progressBar.style.width = `${Math.round(frac * 100)}%`;
  }
}

synthBtn.addEventListener("click", async () => {
  const entry = byId.get(voiceSel.value);
  if (!entry) return;
  const text = textEl.value.trim();
  if (!text) return;

  synthBtn.disabled = true;
  resultEl.style.display = "none";
  setProgress(0);

  try {
    let voice = voiceCache.get(entry.id);
    if (!voice) {
      setStatus("downloading voice…");
      voice = await loadVoice(entry, {
        onProgress(frac, label) {
          setStatus(label);
          setProgress(frac);
        },
      });
      voiceCache.set(entry.id, voice);
      setProgress(1);
    }

    setStatus("synthesizing…");

    const tokenize =
      entry.phonemeType === "espeak"
        ? (t: string, idMap: Record<string, number>) =>
            espeakTokenize(t, idMap, entry.espeakVoice!)
        : undefined;

    const blob = await synthesizeWav(voice, text, { tokenize });

    const url = URL.createObjectURL(blob);
    playerEl.src = url;
    downloadEl.href = url;
    downloadEl.download = `${entry.id}.wav`;
    resultEl.style.display = "block";
    providerBadge.textContent = voice.provider;
    providerBadge.className = "badge" + (voice.provider === "webgpu" ? " gpu" : "");
    setStatus(`done · ${voice.provider}`);
    setProgress(1);
    playerEl.play().catch(() => {});
  } catch (err) {
    setStatus((err as Error).message || "synthesis failed", true);
    setProgress(1);
  } finally {
    synthBtn.disabled = false;
  }
});
