import * as ort from "onnxruntime-web";
import type {
  VoiceEntry,
  VoiceConfig,
  LoadedVoice,
  LoadVoiceOptions,
  SynthesizeOptions,
  SynthesisResult,
  PhonemeAlignment,
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
 * Tiny inference to confirm an execution provider can run this op graph AND that
 * its output can be read back (the WebGPU EP can pass create+run but fail when
 * the output buffer is read). Any throw here triggers the WASM fallback.
 */
async function warmup(session: ort.InferenceSession): Promise<void> {
  const ids = [1, 0, 2];
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([0.667, 1, 0.8]), [3]),
  };
  const wanted = new Set(session.inputNames);
  for (const k of Object.keys(feeds)) if (!wanted.has(k)) delete feeds[k];
  const results = await session.run(feeds);
  await readFloat32(results[session.outputNames[0]]);
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
  const {
    wasmPaths = defaultWasmPaths(),
    numThreads = 1,
    onProgress,
    hfBase = "https://huggingface.co",
    webgpu = true,
  } = options;

  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = numThreads;

  const cfgUrl = hfUrl(hfBase, entry.repo, entry.config);
  const onnxUrl = hfUrl(hfBase, entry.repo, entry.onnx);

  const cfgBuf = await fetchCached(cfgUrl);
  const config: VoiceConfig = JSON.parse(new TextDecoder().decode(cfgBuf));

  const onnxBuf = await fetchCached(onnxUrl, (received, total) =>
    onProgress?.(total ? received / total : 0, `downloading ${(received / 1e6).toFixed(1)} MB`),
  );
  onProgress?.(1, "initializing");

  // Try WebGPU (faster), but validate it with a tiny warmup run — the EP can
  // create a session that then fails or returns silence on an unsupported VITS
  // op. Any error (create OR run) falls back to single-threaded WASM (CPU).
  let session: ort.InferenceSession | undefined;
  let provider = "wasm";
  if (webgpu) {
    try {
      const gpu = await ort.InferenceSession.create(onnxBuf, {
        executionProviders: ["webgpu"],
      });
      await warmup(gpu);
      session = gpu;
      provider = "webgpu";
    } catch {
      session = undefined;
    }
  }
  if (!session) {
    session = await ort.InferenceSession.create(onnxBuf, {
      executionProviders: ["wasm"],
    });
    provider = "wasm";
  }

  return {
    entry,
    session,
    config,
    idMap: flattenIdMap(config.phoneme_id_map),
    sampleRate: config.audio?.sample_rate ?? config.sample_rate ?? entry.sampleRate,
    provider,
  };
}

/**
 * Synthesize speech from text using a loaded voice.
 *
 * Returns a {@link SynthesisResult} containing raw float32 samples, sample
 * rate, and optionally per-phoneme alignment timings (when the model was
 * exported with `--add-phoneme-alignment`).
 *
 * For the espeak phonemizer path, pass `tokenize` explicitly using
 * `tokenizeEspeak` from `phoonnx/espeak`.
 */
export async function synthesize(
  voice: LoadedVoice,
  text: string,
  options: SynthesizeOptions & {
    /** Override the tokenizer. Defaults to tokenizeUnicode for "unicode" voices. */
    tokenize?: (text: string, idMap: Record<string, number>) => number[] | Promise<number[]>;
  } = {},
): Promise<SynthesisResult> {
  const {
    noiseScale,
    lengthScale,
    noiseW,
    includeAlignments = false,
    tokenize,
    superResolution,
  } = options;

  let ids: number[];
  if (tokenize) {
    ids = await tokenize(text, voice.idMap);
  } else if (voice.entry.phonemeType === "unicode") {
    ids = tokenizeUnicode(text, voice.idMap);
  } else {
    throw new Error(
      `Voice "${voice.entry.id}" uses phonemeType "${voice.entry.phonemeType}". ` +
      `Pass a tokenize function (see phoonnx/espeak for the espeak-ng path).`,
    );
  }

  if (ids.length <= 3) {
    throw new Error("Nothing to synthesize — text produced no phoneme tokens.");
  }

  const inf = voice.config.inference ?? {};
  const scales = Float32Array.from([
    noiseScale ?? inf.noise_scale ?? 0.667,
    lengthScale ?? inf.length_scale ?? 1.0,
    noiseW ?? inf.noise_w ?? 0.8,
  ]);

  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", scales, [3]),
  };

  // Only pass inputs declared by the model (different exports differ).
  const wanted = new Set(voice.session.inputNames);
  for (const k of Object.keys(feeds)) if (!wanted.has(k)) delete feeds[k];

  const results = await voice.session.run(feeds);
  const audioTensor = results[voice.session.outputNames[0]];
  let samples = await readFloat32(audioTensor);
  let sampleRate = voice.sampleRate;

  // Optional post-synthesis super-resolution (48 kHz upscaling). Off by default.
  // Lazily loads the SR ONNX model on first use and degrades gracefully to the
  // voice's native sample rate if the model can't be fetched or run.
  const sr = loadSuperResolution(superResolution);
  if (sr) {
    try {
      const up = await sr.upscale(samples, sampleRate);
      samples = up.samples;
      sampleRate = up.sampleRate;
    } catch (err) {
      const warn = superResolution?.logger?.warn ?? console.warn;
      warn(
        `[phoonnx] super-resolution (${sr.engine}) failed (${err}); ` +
        `returning native ${sampleRate} Hz audio.`,
      );
    }
  }

  let alignments: PhonemeAlignment[] | null = null;
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
    // Durations are in native-rate samples; if SR changed the rate, rescale so
    // numSamples stays consistent with the returned (upscaled) sampleRate.
    const scale = sampleRate / voice.sampleRate;
    alignments = raw
      ? raw.map((r) => ({ phoneme: r.phoneme, numSamples: Math.round(r.numSamples * scale) }))
      : null;
  }

  return { samples, sampleRate, alignments };
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
