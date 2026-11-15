import * as ort from "onnxruntime-web";
import type {
  VoiceEntry,
  VoiceConfig,
  LoadedVoice,
  LoadVoiceOptions,
  SynthesizeOptions,
  SynthesisResult,
  PhonemeAlignment,
  Tokenizer,
} from "./types.js";
import { fetchCached } from "./cache.js";
import { flattenIdMap, tokenizeUnicode } from "./tokenize.js";
import { encodeWav, reconstructAlignments } from "./audio.js";
import { loadSuperResolution } from "./superres.js";

const DEFAULT_ORT_VERSION = "1.20.1";

function defaultWasmPaths(): string {
  // Match the WASM version to the onnxruntime-web JS that's actually loaded.
  // Hardcoding a version mismatches the consumer's installed JS glue and throws
  // "t.getValue is not a function" (the glue and wasm export different symbols).
  const version = ort.env?.versions?.web ?? DEFAULT_ORT_VERSION;
  return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
}

function hfUrl(base: string, repo: string, file: string): string {
  return `${base}/${repo}/resolve/main/${file}`;
}

/**
 * Read an output tensor's float32 data, EP-agnostically. WebGPU outputs may live
 * in a GPU buffer (location "gpu-buffer"); those must be downloaded with
 * getData(). WASM/CPU tensors expose `.data` directly.
 */
async function readFloat32(tensor: ort.Tensor): Promise<Float32Array> {
  const t = tensor as ort.Tensor & {
    location?: string;
    getData?: (release?: boolean) => Promise<unknown>;
  };
  if (t.location && t.location !== "cpu" && typeof t.getData === "function") {
    return (await t.getData(true)) as Float32Array;
  }
  return tensor.data as Float32Array;
}

/**
 * Build the ONNX feeds for one id sequence. It knows every input name of the
 * phoonnx VITS adapter (piper/phoonnx, MMS and Hugging Face exports) and keeps
 * the ones the model declares. `scales` follows the rank the model declares, and
 * a declared speaker or language id is 0, as in Python phoonnx.
 */
function buildFeeds(
  session: ort.InferenceSession,
  ids: number[],
  [noiseScale, lengthScale, noiseW]: number[],
): Record<string, ort.Tensor> {
  const int64 = (values: number[], dims: number[]) =>
    new ort.Tensor("int64", BigInt64Array.from(values, BigInt), dims);
  const float32 = (values: number[], dims: number[]) =>
    new ort.Tensor("float32", Float32Array.from(values), dims);

  const scalesMeta = (session as { inputMetadata?: readonly InferenceInputMetadata[] })
    .inputMetadata?.find((m) => m.name === "scales");
  const scalesDims = (scalesMeta?.shape?.length ?? 1) >= 2 ? [1, 3] : [3];

  const all: Record<string, () => ort.Tensor> = {
    input: () => int64(ids, [1, ids.length]),
    input_lengths: () => int64([ids.length], [1]),
    x: () => int64(ids, [1, ids.length]),
    x_length: () => int64([ids.length], [1]),
    input_ids: () => int64(ids, [1, ids.length]),
    attention_mask: () => int64(ids.map(() => 1), [1, ids.length]),
    scales: () => float32([noiseScale, lengthScale, noiseW], scalesDims),
    noise_scale: () => float32([noiseScale], [1]),
    noise_scale_w: () => float32([noiseW], [1]),
    length_scale: () => float32([lengthScale], [1]),
    sid: () => int64([0], [1]),
    langid: () => int64([0], [1]),
  };
  const feeds: Record<string, ort.Tensor> = {};
  for (const name of session.inputNames) if (all[name]) feeds[name] = all[name]();
  return feeds;
}

interface InferenceInputMetadata {
  name: string;
  shape?: readonly unknown[];
}

/**
 * Tiny inference to confirm an execution provider can run this op graph AND that
 * its output can be read back (the WebGPU EP can pass create+run but fail when
 * the output buffer is read). Any throw here triggers the WASM fallback.
 */
async function warmup(session: ort.InferenceSession): Promise<void> {
  const results = await session.run(buildFeeds(session, [1, 0, 2], [0.667, 1, 0.8]));
  await readFloat32(results[session.outputNames[0]]);
}

/**
 * Download (and cache) an ONNX model and create its inference session.
 *
 * It tries WebGPU (faster) first and validates it with a tiny warmup run: the
 * EP can create a session that then fails or returns silence on an
 * unsupported VITS op. Any error (create OR run) falls back to
 * single-threaded WASM (CPU).
 */
export async function createSession(
  onnxUrl: string,
  options: LoadVoiceOptions = {},
): Promise<{ session: ort.InferenceSession; provider: string }> {
  const {
    wasmPaths = defaultWasmPaths(),
    numThreads = 1,
    onProgress,
    webgpu = true,
  } = options;

  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = numThreads;

  const onnxBuf = await fetchCached(onnxUrl, (received, total) =>
    onProgress?.(total ? received / total : 0, `downloading ${(received / 1e6).toFixed(1)} MB`),
  );
  onProgress?.(1, "initializing");

  if (webgpu) {
    try {
      const gpu = await ort.InferenceSession.create(onnxBuf, {
        executionProviders: ["webgpu"],
      });
      await warmup(gpu);
      return { session: gpu, provider: "webgpu" };
    } catch {
      // fall through to WASM
    }
  }
  const session = await ort.InferenceSession.create(onnxBuf, {
    executionProviders: ["wasm"],
  });
  return { session, provider: "wasm" };
}

/**
 * Download, cache, and initialize a phoonnx voice.
 *
 * The ONNX model is downloaded once and stored in CacheStorage; subsequent
 * calls for the same voice return immediately without a network round-trip.
 */
export async function loadVoice(
  entry: VoiceEntry,
  options: LoadVoiceOptions = {},
): Promise<LoadedVoice> {
  const { hfBase = "https://huggingface.co", normalizeAudio = true } = options;

  const cfgBuf = await fetchCached(hfUrl(hfBase, entry.repo, entry.config));
  const config: VoiceConfig = JSON.parse(new TextDecoder().decode(cfgBuf));
  const { session, provider } = await createSession(
    hfUrl(hfBase, entry.repo, entry.onnx),
    options,
  );

  return {
    entry,
    session,
    config,
    idMap: flattenIdMap(config.phoneme_id_map),
    sampleRate: config.audio?.sample_rate ?? config.sample_rate ?? entry.sampleRate,
    provider,
    normalizeAudio,
  };
}

/**
 * Synthesize speech from text using a loaded voice.
 *
 * Returns a {@link SynthesisResult} containing raw float32 samples, sample
 * rate, and optionally per-phoneme alignment timings (when the model was
 * exported with `--add-phoneme-alignment`).
 *
 * The tokenizer is `options.tokenize`, else the voice's own (voices from
 * `phoonnx/pyodide`), else tokenizeUnicode for "unicode" voices. For the
 * espeak phonemizer path, pass `tokenize` explicitly using `tokenizeEspeak`
 * from `phoonnx/espeak`. A tokenizer that returns one id list per sentence
 * runs the model once per sentence and joins the audio.
 */
export async function synthesize(
  voice: LoadedVoice,
  text: string,
  options: SynthesizeOptions & {
    /** Override the tokenizer. */
    tokenize?: Tokenizer;
  } = {},
): Promise<SynthesisResult> {
  const {
    noiseScale,
    lengthScale,
    noiseW,
    includeAlignments = false,
    superResolution,
  } = options;

  const tokenize = options.tokenize ?? voice.tokenize;
  let tokens: number[] | number[][];
  if (tokenize) {
    tokens = await tokenize(text, voice.idMap);
  } else if (voice.entry.phonemeType === "unicode") {
    tokens = tokenizeUnicode(text, voice.idMap);
  } else {
    throw new Error(
      `Voice "${voice.entry.id}" uses phonemeType "${voice.entry.phonemeType}". ` +
      `Pass a tokenize function (see phoonnx/espeak for the espeak-ng path).`,
    );
  }

  const sentences = isNested(tokens) ? tokens.filter((ids) => ids.length > 0) : [tokens];
  if (sentences.length === 0 || (!isNested(tokens) && tokens.length <= 3)) {
    throw new Error("Nothing to synthesize — text produced no phoneme tokens.");
  }

  const inf = voice.config.inference ?? {};
  const scales = [
    noiseScale ?? inf.noise_scale ?? 0.667,
    lengthScale ?? inf.length_scale ?? 1.0,
    noiseW ?? inf.noise_w ?? 0.8,
  ];

  const sr = loadSuperResolution(superResolution);
  const chunks: Float32Array[] = [];
  let sampleRate = voice.sampleRate;
  let alignments: PhonemeAlignment[] | null = null;
  for (const ids of sentences) {
    const results = await voice.session.run(buildFeeds(voice.session, ids, scales));
    const audioTensor = results[voice.session.outputNames[0]];
    let samples = await readFloat32(audioTensor);
    if (voice.normalizeAudio) samples = peakNormalize(samples);
    if (sr) {
      try {
        const up = await sr.upscale(samples, voice.sampleRate);
        samples = up.samples;
        sampleRate = up.sampleRate;
      } catch (err) {
        const warn = superResolution?.logger?.warn ?? console.warn;
        warn(
          `[phoonnx] super-resolution (${sr.engine}) failed (${err}); ` +
          `returning native ${voice.sampleRate} Hz audio.`,
        );
      }
    }
    chunks.push(samples);

    if (includeAlignments && voice.session.outputNames.length > 1) {
      const durTensor = results[voice.session.outputNames[1]];
      const rawDurations = durTensor.data as Float32Array;
      const hopLength = 256; // standard VITS hop size

      // Build reverse id map from the voice's phoneme_id_map.
      const idxToChar = new Map<number, string>();
      for (const [ch, id] of Object.entries(voice.idMap)) idxToChar.set(id, ch);

      const blankId = voice.idMap["_"] ?? 0;
      const bosId = voice.idMap["^"] ?? 1;
      const eosId = voice.idMap["$"] ?? 2;

      const raw = reconstructAlignments(
        ids, rawDurations, hopLength, idxToChar, blankId, bosId, eosId,
      );
      if (raw) alignments = [...(alignments ?? []), ...raw];
    }
  }

  // Durations are in native-rate samples; if SR changed the rate, rescale so
  // numSamples stays consistent with the returned (upscaled) sampleRate.
  const scale = sampleRate / voice.sampleRate;
  if (alignments && scale !== 1) {
    alignments = alignments.map((r) => ({ phoneme: r.phoneme, numSamples: Math.round(r.numSamples * scale) }));
  }

  return { samples: concat(chunks), sampleRate, alignments };
}

function isNested(tokens: number[] | number[][]): tokens is number[][] {
  return tokens.length > 0 && Array.isArray(tokens[0]);
}

/** Scale to a peak of 1, as Python phoonnx's default level_audio does. */
function peakNormalize(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak < 1e-8) return new Float32Array(samples.length);
  return samples.map((s) => Math.max(-1, Math.min(1, s / peak)));
}

function concat(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Convenience wrapper: synthesize and return a WAV Blob ready to play.
 *
 * ```ts
 * const blob = await synthesizeWav(voice, "Hello world");
 * audio.src = URL.createObjectURL(blob);
 * ```
 */
export async function synthesizeWav(
  voice: LoadedVoice,
  text: string,
  options?: Parameters<typeof synthesize>[2],
): Promise<Blob> {
  const { samples, sampleRate } = await synthesize(voice, text, options);
  return encodeWav(samples, sampleRate);
}
