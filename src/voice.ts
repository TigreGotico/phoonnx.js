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

const DEFAULT_ORT_VERSION = "1.20.1";

function defaultWasmPaths(): string {
  return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${DEFAULT_ORT_VERSION}/dist/`;
}

function hfUrl(base: string, repo: string, file: string): string {
  return `${base}/${repo}/resolve/main/${file}`;
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

  // These VITS models are tiny (~15.6M params); single-threaded WASM (CPU) is
  // plenty and is the only reliable onnxruntime-web backend for them (the
  // WebGPU EP does not support every VITS op).
  const session = await ort.InferenceSession.create(onnxBuf, {
    executionProviders: ["wasm"],
  });
  const provider = "wasm";

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
  const samples = audioTensor.data as Float32Array;

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
    alignments = raw ? raw.map((r) => ({ phoneme: r.phoneme, numSamples: r.numSamples })) : null;
  }

  return { samples, sampleRate: voice.sampleRate, alignments };
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
