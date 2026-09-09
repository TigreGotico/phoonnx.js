/**
 * Optional post-synthesis audio super-resolution (48 kHz upscaling).
 *
 * Mirrors the Python `phoonnx` integration of `audiosronnx`: an optional, lazily
 * loaded stage that runs a synthesized Float32 waveform through an ONNX
 * bandwidth-extension model and returns 48 kHz audio. It is off by default and
 * degrades gracefully — if a model can't be fetched or run, the caller keeps the
 * voice's native-rate audio.
 *
 * The neural cores are the four `audiosronnx` ONNX graphs on HuggingFace; the
 * pre/post DSP that wraps them (resampling, STFT/ISTFT, mel, spectral merge) is
 * ported to JS in {@link module:dsp} and verified numerically against the Python
 * reference.
 *
 * In-browser suitability of the engines differs a lot by model size:
 *   - novasr     (~0.05 MB) : lightest, recommended for the browser. 16 kHz in.
 *   - hifiganbwe (~4 MB)    : light, any input rate.
 *   - lavasr     (~52 MB)   : default; two graphs + full spectral pipeline.
 *   - apbwe      (~120 MB)  : highest accuracy but heavy — impractical for most
 *                             browsers; prefer it only server-side / in Node.
 */
import * as ort from "onnxruntime-web";

import { fetchCached } from "./cache.js";
import {
  kaiserResample, resample, torchStft, torchIstft,
  scipyStft, scipyIstft, buildMelFilterbank, spectralMerge, type Spectrogram,
} from "./dsp.js";

export type SuperResolutionEngine = "lavasr" | "novasr" | "hifiganbwe" | "apbwe";

/** Config mirroring the Python `SynthesisConfig.super_resolution` shape. */
export interface SuperResolutionConfig {
  /** Master switch. Off (undefined/false) means no SR stage runs. */
  enabled?: boolean;
  /** Engine alias. Defaults to "lavasr" (matches the Python default). */
  engine?: SuperResolutionEngine;
  /** LavaSR only: run the optional UL-UNAS denoiser first (default false). */
  denoise?: boolean;
  /** LavaSR only: preserve the original band below this cutoff (Hz). */
  cutoffHz?: number | null;
  /** HuggingFace base URL for model downloads. Default https://huggingface.co. */
  hfBase?: string;
  /** onnxruntime-web WASM asset base (defaults to the same CDN loadVoice uses). */
  wasmPaths?: string;
  /** Try WebGPU first for the SR graphs, falling back to WASM. Default true. */
  webgpu?: boolean;
  /** Progress callback during model download/init. */
  onProgress?: (frac: number, label: string) => void;
  /** Optional console-like sink for graceful-degradation warnings. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

const HF_DEFAULT = "https://huggingface.co";
const OUT_SR = 48000;

interface EngineMeta {
  repo: string;
  revision: string;
  files: string[];
  approxMB: number;
  description: string;
}

const ENGINES: Record<SuperResolutionEngine, EngineMeta> = {
  lavasr: {
    repo: "TigreGotico/audiosronnx-lavasr",
    revision: "b3df8a262cf44e59bf84a40b7084f4479ca566b4",
    files: ["backbone.onnx", "spec_head.onnx"], // denoiser fetched only when denoise=true
    approxMB: 52,
    description: "LavaSR: Vocos bandwidth extension + spectral merge. Any 8-48 kHz -> 48 kHz.",
  },
  novasr: {
    repo: "TigreGotico/audiosronnx-novasr",
    revision: "5d92bf1488aae6d92356ef5951c7ef9bf9f9801b",
    files: ["novasr.onnx"],
    approxMB: 0.05,
    description: "NovaSR: tiny conv1d generator, 16 kHz -> 48 kHz. Lightest; browser-friendly.",
  },
  hifiganbwe: {
    repo: "TigreGotico/audiosronnx-hifiganbwe",
    revision: "d617931bce0671703b0ac0fbe14cf37d243e5f8c",
    files: ["hifiganbwe_wavenet.onnx"],
    approxMB: 4,
    description: "HiFi-GAN+: WaveNet bandwidth extension, any input -> 48 kHz.",
  },
  apbwe: {
    repo: "TigreGotico/audiosronnx-apbwe",
    revision: "22d116972f09802273d9e26851f004da0bfbd58a",
    files: ["apbwe.onnx"],
    approxMB: 120,
    description: "AP-BWE: dual-ConvNeXt amplitude-phase BWE. Highest accuracy; heavy (~120 MB).",
  },
};

// LavaSR DSP constants (must match the exported graph's training front-end).
const ENH_SR = 44100, ENH_NFFT = 2048, ENH_HOP = 512, ENH_MELS = 80;
const DEN_SR = 16000, DEN_NFFT = 512, DEN_HOP = 256, DEN_CHUNK = 63;
// AP-BWE constants.
const AP_LR_SR = 12000, AP_NFFT = 1024, AP_HOP = 80, AP_WIN = 320;
// HiFi-GAN+ receptive field (2 stacks x 8 layers, dilation base 3, kernel 3).
const HIFI_RF = 13120;

function tf32(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor("float32", data, dims);
}

function toF64(x: Float32Array): Float64Array {
  const out = new Float64Array(x.length);
  out.set(x);
  return out;
}

/**
 * A loaded super-resolution engine. Sessions are created on the first
 * {@link upscale} call and reused afterwards.
 */
export class SuperResolution {
  readonly engine: SuperResolutionEngine;
  private meta: EngineMeta;
  private cfg: SuperResolutionConfig;
  private sessions: Record<string, ort.InferenceSession> = {};
  private loaded = false;
  private melFb: Float64Array | null = null;

  constructor(engine: SuperResolutionEngine, cfg: SuperResolutionConfig) {
    this.engine = engine;
    this.meta = ENGINES[engine];
    this.cfg = cfg;
  }

  /** Static metadata (repo, size, description) for an engine alias. */
  static describe(engine: SuperResolutionEngine): EngineMeta & { engine: SuperResolutionEngine } {
    return { engine, ...ENGINES[engine] };
  }

  private hfUrl(file: string): string {
    const base = this.cfg.hfBase ?? HF_DEFAULT;
    return `${base}/${this.meta.repo}/resolve/${this.meta.revision}/${file}`;
  }

  private async makeSession(buf: ArrayBuffer): Promise<ort.InferenceSession> {
    if (this.cfg.webgpu !== false) {
      try {
        return await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"] });
      } catch {
        // fall through to WASM
      }
    }
    return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  }

  private async ensureModels(): Promise<void> {
    if (this.loaded) return;
    if (this.cfg.wasmPaths) ort.env.wasm.wasmPaths = this.cfg.wasmPaths;
    const files = [...this.meta.files];
    if (this.engine === "lavasr" && this.cfg.denoise) files.push("denoiser_core.onnx");

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buf = await fetchCached(this.hfUrl(file), (received, total) =>
        this.cfg.onProgress?.(
          total ? (i + received / total) / files.length : 0,
          `downloading ${this.engine}/${file} (${(received / 1e6).toFixed(1)} MB)`,
        ),
      );
      this.sessions[file] = await this.makeSession(buf);
    }
    this.cfg.onProgress?.(1, `initialized ${this.engine}`);
    this.loaded = true;
  }

  /**
   * Upscale mono float32 `samples` at `sampleRate` to 48 kHz.
   * Returns `{ samples, sampleRate: 48000 }`.
   */
  async upscale(
    samples: Float32Array, sampleRate: number,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (samples.length === 0) return { samples: new Float32Array(0), sampleRate: OUT_SR };
    await this.ensureModels();
    const x = toF64(samples);
    let out: Float64Array;
    switch (this.engine) {
      case "novasr": out = await this.upNova(x, sampleRate); break;
      case "hifiganbwe": out = await this.upHifi(x, sampleRate); break;
      case "apbwe": out = await this.upApbwe(x, sampleRate); break;
      default: out = await this.upLava(x, sampleRate); break;
    }
    const f32 = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) f32[i] = Math.max(-1, Math.min(1, out[i]));
    return { samples: f32, sampleRate: OUT_SR };
  }

  // ---- engine cores (ports of audiosronnx `_upscale_array`) ---------------- //

  private async run(file: string, feeds: Record<string, ort.Tensor>): Promise<ort.Tensor[]> {
    const sess = this.sessions[file];
    const results = await sess.run(feeds);
    return sess.outputNames.map((n) => results[n]);
  }

  private input0(file: string): string {
    return this.sessions[file].inputNames[0];
  }

  private async upNova(x: Float64Array, sr: number): Promise<Float64Array> {
    const r = resample(x, sr, DEN_SR);
    const f32 = Float32Array.from(r);
    const out = await this.run("novasr.onnx", { [this.input0("novasr.onnx")]: tf32(f32, [1, 1, f32.length]) });
    return toF64(out[0].data as Float32Array);
  }

  private async upHifi(x: Float64Array, sr: number): Promise<Float64Array> {
    const up = kaiserResample(x, sr, OUT_SR);
    const pad = HIFI_RF >> 1;
    const p = new Float32Array(up.length + 2 * pad);
    for (let i = 0; i < up.length; i++) p[pad + i] = up[i];
    const out = await this.run("hifiganbwe_wavenet.onnx", {
      [this.input0("hifiganbwe_wavenet.onnx")]: tf32(p, [1, 1, p.length]),
    });
    const y = out[0].data as Float32Array;
    const res = new Float64Array(up.length);
    for (let i = 0; i < up.length; i++) res[i] = Math.tanh(y[pad + i]);
    return res;
  }

  private async upApbwe(x: Float64Array, sr: number): Promise<Float64Array> {
    const lr = kaiserResample(x, sr, AP_LR_SR);
    const nb = kaiserResample(lr, AP_LR_SR, OUT_SR);
    const spec = torchStft(nb, AP_NFFT, AP_HOP, AP_WIN);
    const logAmp = new Float32Array(spec.re.length);
    const pha = new Float32Array(spec.re.length);
    for (let i = 0; i < spec.re.length; i++) {
      const mag = Math.hypot(spec.re[i], spec.im[i]);
      logAmp[i] = Math.log(mag + 1e-4);
      pha[i] = Math.atan2(spec.im[i], spec.re[i]);
    }
    const names = this.sessions["apbwe.onnx"].inputNames;
    const dims = [1, spec.nFreq, spec.nFrames];
    const out = await this.run("apbwe.onnx", {
      [names[0]]: tf32(logAmp, dims),
      [names[1]]: tf32(pha, dims),
    });
    const logAmpWb = out[0].data as Float32Array; // [1, F, T]
    const phaWb = out[1].data as Float32Array;
    const re = new Float64Array(spec.re.length);
    const im = new Float64Array(spec.re.length);
    for (let i = 0; i < re.length; i++) {
      const amp = Math.exp(logAmpWb[i]);
      re[i] = amp * Math.cos(phaWb[i]);
      im[i] = amp * Math.sin(phaWb[i]);
    }
    const wbSpec: Spectrogram = { re, im, nFreq: spec.nFreq, nFrames: spec.nFrames };
    return torchIstft(wbSpec, AP_NFFT, AP_HOP, AP_WIN, true, nb.length);
  }

  private async upLava(x: Float64Array, sr: number): Promise<Float64Array> {
    let cutoff = this.cfg.cutoffHz;
    if (cutoff == null) cutoff = Math.min(sr, 16000) / 2.0;

    let wave16 = resample(x, sr, DEN_SR);
    if (this.cfg.denoise && this.sessions["denoiser_core.onnx"]) {
      wave16 = await this.runDenoiser(wave16);
    }
    const enhIn = resample(wave16, DEN_SR, ENH_SR);
    const enhanced = await this.runEnhancer(enhIn);
    let merged = spectralMerge(enhIn, enhanced, ENH_SR, cutoff, 1024);
    merged = resample(merged, ENH_SR, OUT_SR);
    return merged;
  }

  private async runEnhancer(waveform: Float64Array): Promise<Float64Array> {
    if (!this.melFb) this.melFb = buildMelFilterbank(ENH_SR, ENH_NFFT, ENH_MELS, 0.0, 8000.0);
    const spec = scipyStft(waveform, ENH_NFFT, ENH_HOP);
    const nFreq = spec.nFreq, nFrames = spec.nFrames;
    // mel = log(max(mel_fb @ |spec|, 1e-5))  -> [1, nMels, nFrames]
    const mel = new Float32Array(ENH_MELS * nFrames);
    for (let m = 0; m < ENH_MELS; m++) {
      for (let t = 0; t < nFrames; t++) {
        let acc = 0;
        for (let k = 0; k < nFreq; k++) {
          acc += this.melFb[m * nFreq + k] * Math.hypot(spec.re[k * nFrames + t], spec.im[k * nFrames + t]);
        }
        mel[m * nFrames + t] = Math.log(Math.max(acc, 1e-5));
      }
    }
    const hidden = (await this.run("backbone.onnx", {
      [this.input0("backbone.onnx")]: tf32(mel, [1, ENH_MELS, nFrames]),
    }))[0];
    const head = await this.run("spec_head.onnx", {
      [this.input0("spec_head.onnx")]: hidden,
    });
    // head outputs real, imag, each [1, F, T]
    const real = head[0].data as Float32Array;
    const imag = head[1].data as Float32Array;
    const fdims = head[0].dims;
    const F = fdims[fdims.length - 2];
    const T = fdims[fdims.length - 1];
    const re = new Float64Array(F * T);
    const im = new Float64Array(F * T);
    re.set(real.subarray(0, F * T));
    im.set(imag.subarray(0, F * T));
    const enhSpec: Spectrogram = { re, im, nFreq: F, nFrames: T };
    return torchIstftForLava(enhSpec, ENH_NFFT, ENH_HOP, waveform.length);
  }

  private async runDenoiser(waveform: Float64Array): Promise<Float64Array> {
    const spec = scipyStftComplexForDenoiser(waveform);
    const F = spec.nFreq, T = spec.nFrames;
    // den_in: [1, 2, T, F]  (channels = real/imag, then transpose(T, F))
    const stride = Math.max(1, DEN_CHUNK >> 1);
    const outR = new Float64Array(T * F);
    const outI = new Float64Array(T * F);
    const weights = new Float64Array(T);
    const window = new Float64Array(DEN_CHUNK);
    for (let i = 0; i < DEN_CHUNK; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (DEN_CHUNK - 1));
    const name = this.sessions["denoiser_core.onnx"].inputNames[0];

    for (let start = 0; start < T; start += stride) {
      const end = Math.min(start + DEN_CHUNK, T);
      const valid = end - start;
      const chunk = new Float32Array(2 * DEN_CHUNK * F);
      for (let ci = 0; ci < 2; ci++) {
        for (let tt = 0; tt < valid; tt++) {
          for (let f = 0; f < F; f++) {
            // spec is freq-major [F, T]; denoiser input is [1, 2, T, F]
            const src = ci === 0 ? spec.re[f * T + (start + tt)] : spec.im[f * T + (start + tt)];
            chunk[(ci * DEN_CHUNK + tt) * F + f] = src;
          }
        }
      }
      const res = (await this.run("denoiser_core.onnx", {
        [name]: tf32(chunk, [1, 2, DEN_CHUNK, F]),
      }))[0].data as Float32Array;
      for (let tt = 0; tt < valid; tt++) {
        const w = window[tt];
        for (let f = 0; f < F; f++) {
          outR[(start + tt) * F + f] += res[(0 * DEN_CHUNK + tt) * F + f] * w;
          outI[(start + tt) * F + f] += res[(1 * DEN_CHUNK + tt) * F + f] * w;
        }
        weights[start + tt] += w;
      }
      if (end >= T) break;
    }
    // spec_out = (out[0,0] + 1j out[0,1]).T  -> freq-major [F, T]
    const re = new Float64Array(F * T);
    const im = new Float64Array(F * T);
    for (let tt = 0; tt < T; tt++) {
      const wn = Math.max(weights[tt], 1e-6);
      for (let f = 0; f < F; f++) {
        re[f * T + tt] = outR[tt * F + f] / wn;
        im[f * T + tt] = outI[tt * F + f] / wn;
      }
    }
    const denSpec: Spectrogram = { re, im, nFreq: F, nFrames: T };
    return torchIstftForLava(denSpec, DEN_NFFT, DEN_HOP, waveform.length);
  }
}

/**
 * LavaSR uses scipy.signal.istft (spectrum scaling) for its ISTFT, then trims to
 * a target length. Wraps {@link scipyIstft} with the length fit.
 */
function torchIstftForLava(spec: Spectrogram, nFft: number, hop: number, targetLen: number): Float64Array {
  const y = scipyIstft(spec, nFft, hop);
  if (y.length === targetLen) return y;
  if (y.length > targetLen) return y.slice(0, targetLen);
  const out = new Float64Array(targetLen);
  out.set(y);
  return out;
}

/** Denoiser front-end STFT (scipy, freq-major complex [F, T]) at DEN params. */
function scipyStftComplexForDenoiser(waveform: Float64Array): Spectrogram {
  return scipyStft(waveform, DEN_NFFT, DEN_HOP);
}

/**
 * Build an SR engine from a {@link SuperResolutionConfig}. Returns `null` when SR
 * is disabled. Never throws for a bad engine name — logs and returns `null` so
 * synthesis degrades gracefully to native-rate audio (mirrors the Python side).
 */
export function loadSuperResolution(cfg?: SuperResolutionConfig): SuperResolution | null {
  if (!cfg?.enabled) return null;
  const engine = (cfg.engine ?? "lavasr") as SuperResolutionEngine;
  if (!(engine in ENGINES)) {
    (cfg.logger?.warn ?? console.warn)(
      `[phoonnx] unknown super-resolution engine "${engine}"; ` +
      `known: ${Object.keys(ENGINES).join(", ")}. Falling back to native audio.`,
    );
    return null;
  }
  return new SuperResolution(engine, cfg);
}

/** All registered SR engines with their metadata. */
export function availableSuperResolutionEngines(): Array<EngineMeta & { engine: SuperResolutionEngine }> {
  return (Object.keys(ENGINES) as SuperResolutionEngine[]).map((e) => SuperResolution.describe(e));
}
