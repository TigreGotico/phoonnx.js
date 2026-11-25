import type * as ort from "onnxruntime-web";
import type { SuperResolutionEngine, SuperResolutionOptions } from "./superres.js";

/** A voice entry from the phoonnx voice registry. */
export interface VoiceEntry {
  /** Unique identifier, e.g. "phoonnx_eu-ES_dii_espeak" */
  id: string;
  /** HuggingFace repo, e.g. "OpenVoiceOS/phoonnx_eu-ES_dii_espeak" */
  repo: string;
  /** Voice name, e.g. "Dii" or "Miro" */
  voice: string;
  /** BCP-47 language code */
  lang: string;
  /** Human-readable language label */
  langLabel: string;
  /** Tokenizer path to use */
  phonemeType: "unicode" | "espeak" | (string & {});
  /** Filename of the ONNX model inside the repo */
  onnx: string;
  /** Filename of the phoonnx JSON config */
  config: string;
  /** Filename of the piper-compatible JSON config, or null */
  piperConfig: string | null;
  /** espeak-ng language code (e.g. "eu"), or null for unicode voices */
  espeakVoice: string | null;
  /** Native sample rate of the model */
  sampleRate: number;
  /** Sample text in the voice's language */
  sampleText: string;
  /** Whether the ONNX model is drop-in compatible with piper / Home Assistant */
  haCompatible: boolean;
}

/** Raw JSON config loaded from HuggingFace alongside the ONNX model. */
export interface VoiceConfig {
  phoneme_id_map: Record<string, number | number[]>;
  /** Whether the voice was trained with clause punctuation. */
  keep_punctuation?: boolean;
  /** Present in the config that phoonnx writes. */
  phoonnx_version?: string;
  /** Present in a piper config. */
  piper_version?: string;
  alphabet?: string;
  phoneme_type?: string;
  inference?: {
    noise_scale?: number;
    length_scale?: number;
    noise_w?: number;
  };
  audio?: { sample_rate?: number };
  sample_rate?: number;
}

/** Symbol to token id. A symbol that reads as several ids, such as a precomposed letter, maps to all of them. */
export type IdMap = Record<string, number | number[]>;

/** A fully loaded voice, ready to synthesize. */
export interface LoadedVoice {
  entry: VoiceEntry;
  session: ort.InferenceSession;
  config: VoiceConfig;
  /** phoneme_id_map as the tokenizers read it (see voiceIdMap). */
  idMap: IdMap;
  sampleRate: number;
  /** "webgpu" if the GPU backend was available, "wasm" otherwise. */
  provider: string;
  /** Whether the voice keeps clause punctuation, as its config says. Default false. */
  keepPunctuation?: boolean;
  /** The voice's own tokenizer, used when synthesize() gets none. */
  tokenize?: Tokenizer;
  /**
   * Scale the audio of each model run to a peak of 1. A tokenizer that returns
   * one id list per sentence gives one run per sentence, as in Python phoonnx;
   * a flat id list gives one run for the whole text.
   */
  normalizeAudio?: boolean;
}

/**
 * Text to token ids. A flat array is one model input; an array of arrays is
 * one model input per sentence, and the audio of each is joined in order.
 */
export type Tokenizer = (
  text: string,
  idMap: IdMap,
) => number[] | number[][] | Promise<number[] | number[][]>;

/** One voice of Python phoonnx's voice index (`phoonnx/voice_index/*.json`). */
export interface IndexVoiceEntry {
  voice_id: string;
  lang: string;
  model_url: string;
  config_url?: string | null;
  vocab_url?: string | null;
  tokenizer_config_url?: string | null;
  tokens_url?: string | null;
  phoneme_map_url?: string | null;
  dictionary_url?: string | null;
  phoneme_type?: string | null;
  phonemizer_model?: string | null;
  phonemizer_lang?: string | null;
  alphabet?: string | null;
  engine?: string | null;
  display_name?: string | null;
  aux_model_urls?: Record<string, string> | null;
  [field: string]: unknown;
}

/** Per-phoneme timing entry (requires an alignment-enabled ONNX model). */
export interface PhonemeAlignment {
  phoneme: string;
  /** Number of audio samples occupied by this phoneme. */
  numSamples: number;
}

/** Result of a single synthesize() call. */
export interface SynthesisResult {
  /** Raw float32 PCM samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Per-phoneme alignments, or null if the model doesn't expose them. */
  alignments: PhonemeAlignment[] | null;
}

/** Options for loadVoice(). */
export interface LoadVoiceOptions {
  /**
   * Base URL for the onnxruntime-web WASM assets.
   * Defaults to the jsDelivr CDN for the version bundled as a peer dep.
   * Override to self-host: `{ wasmPaths: "/assets/ort/" }`.
   */
  wasmPaths?: string;
  /** Number of WASM threads. Defaults to 1 (avoids COOP/COEP requirement). */
  numThreads?: number;
  /** Called with (fraction 0–1, status label) during download/init. */
  onProgress?: (frac: number, label: string) => void;
  /**
   * Base URL for HuggingFace file downloads.
   * Defaults to "https://huggingface.co". Override for mirrors or proxies.
   */
  hfBase?: string;
  /**
   * Try the WebGPU execution provider first (it's faster). Defaults to true.
   * WebGPU is validated with a warmup run; on any error (create or run) it
   * falls back to single-threaded WASM. Set false to force WASM/CPU.
   */
  webgpu?: boolean;
  /**
   * Scale the audio of each model run to a peak of 1 (see
   * {@link LoadedVoice.normalizeAudio}). Defaults to true. Set false to get the
   * model's raw output level.
   */
  normalizeAudio?: boolean;
}

/** Options for synthesize(). */
export interface SynthesizeOptions {
  noiseScale?: number;
  lengthScale?: number;
  noiseW?: number;
  /** Request per-phoneme alignment output (requires a patched ONNX model). */
  includeAlignments?: boolean;
  /**
   * Upscale the audio to 48 kHz with an `audiosronnx` bandwidth-extension
   * model. Off by default. When true, the audio of each model run goes through
   * the model after peak normalization, and the {@link SynthesisResult} carries
   * 48 kHz audio. If the model can't be fetched or run, the result keeps the
   * voice's native rate. Python phoonnx: `SynthesisConfig.super_resolution`.
   */
  superResolution?: boolean;
  /**
   * The `audiosronnx` engine. Defaults to "novasr". Ignored unless
   * `superResolution` is true. Python phoonnx:
   * `SynthesisConfig.super_resolution_model`.
   */
  superResolutionModel?: SuperResolutionEngine;
  /**
   * Download and runtime options for the engine. The engine loads once per
   * voice and engine name, so these apply when it first loads.
   */
  superResolutionOptions?: SuperResolutionOptions;
}
