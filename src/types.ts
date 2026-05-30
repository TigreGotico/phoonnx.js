import type * as ort from "onnxruntime-web";

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
  phonemeType: "unicode" | "espeak";
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
  inference?: {
    noise_scale?: number;
    length_scale?: number;
    noise_w?: number;
  };
  audio?: { sample_rate?: number };
  sample_rate?: number;
}

/** A fully loaded voice, ready to synthesize. */
export interface LoadedVoice {
  entry: VoiceEntry;
  session: ort.InferenceSession;
  config: VoiceConfig;
  /** phoneme_id_map flattened to char → int (piper uses [id], phoonnx uses id). */
  idMap: Record<string, number>;
  sampleRate: number;
  /** "webgpu" if the GPU backend was available, "wasm" otherwise. */
  provider: string;
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
}

/** Options for synthesize(). */
export interface SynthesizeOptions {
  noiseScale?: number;
  lengthScale?: number;
  noiseW?: number;
  /** Request per-phoneme alignment output (requires a patched ONNX model). */
  includeAlignments?: boolean;
}
