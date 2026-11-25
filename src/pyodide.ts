/**
 * Python text front end for phoonnx.js — optional entry point.
 *
 * Import from `phoonnx/pyodide`. Voices whose phoneme type has no JavaScript
 * tokenizer get their token ids from the Python phoonnx front end (phoonnx,
 * scriptconv and the phonemizer the voice names), run in Pyodide. Pyodide and
 * the Python packages download on first use, from the Pyodide CDN and PyPI.
 * The ONNX model still runs in onnxruntime-web.
 *
 * @example
 * ```ts
 * import { synthesizeWav } from "phoonnx";
 * import { fetchVoiceIndex, loadIndexVoice } from "phoonnx/pyodide";
 *
 * const index = await fetchVoiceIndex();
 * const voice = await loadIndexVoice(index.get("facebook/mms-tts-por-Portuguese")!);
 * const blob = await synthesizeWav(voice, "Olá! Esta voz fala no teu navegador.");
 * ```
 */
import type {
  IndexVoiceEntry,
  LoadedVoice,
  LoadVoiceOptions,
  VoiceConfig,
} from "./types.js";
import { fetchCached } from "./cache.js";
import { createSession } from "./voice.js";
import { voiceIdMap } from "./tokenize.js";
import frontendSource from "./python/frontend.py";

/** Pyodide release the front end is tested with. */
export const PYODIDE_VERSION = "314.0.8";

const DEFAULT_PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Raw voice index files of Python phoonnx, on its `dev` branch. */
export const VOICE_INDEX_BASE =
  "https://raw.githubusercontent.com/TigreGotico/phoonnx/dev/phoonnx/voice_index/";

/** The voice index files that hold single-graph VITS voices. */
export const VITS_INDEX_FILES = [
  "OVOS.json", "MMS.json", "proxectonos.json", "piper.json", "phonikud.json",
  "neurlang.json", "mimic3.json", "transformers_community.json",
  "piper_community.json", "coqui_community.json", "vits2.json",
  "coqui_vits.json", "vosk.json", "ghananlp.json",
];

/** Index engines whose models are single-graph VITS: tokens in, waveform out. */
const VITS_ENGINES = new Set(["piper", "mimic3", "coqui", "phoonnx", "transformers", "vosk"]);

/**
 * Packages every front end needs. They are pure-Python wheels from PyPI,
 * installed without their declared dependencies: the front end imports only
 * these. Pyodide builds numpy and regex itself.
 */
const BASE_PACKAGES = [
  "phoonnx", "scriptconv", "quebra-frases", "linguatag", "langcodes",
  "ovos-number-parser", "unicode-rbnf", "ovos-date-parser", "chronologia",
  "ovos-spec-tools", "ovos-utils", "dateparser", "tzlocal", "numtag", "text2spoken",
];
const PYODIDE_PACKAGES = ["numpy", "regex", "python-dateutil", "pytz"];

/**
 * Extra PyPI packages per phoneme type, installed when the first voice of
 * that type loads. A phoneme type that is not a key here has no browser route
 * in phoonnx.js. pycotovia (`cotovia`), ahotts-g2p (`ahotts`) and
 * scriptconv-copyleft are GPL-3.0-or-later.
 */
export const PHONEME_TYPE_PACKAGES: Record<string, string[]> = {
  graphemes: [],
  vosk: [],
  tugaphone: [
    "tugaphone", "silabificador", "tugalex", "bifonia", "orthography2ipa", "o2i-lexicons",
    "desacordo-ortografico",
  ],
  cotovia: ["pycotovia", "scriptconv-copyleft"],
  ahotts: ["ahotts-g2p", "scriptconv-copyleft"],
};

function hasFrontend(phonemeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(PHONEME_TYPE_PACKAGES, phonemeType);
}

/** Options for {@link loadPyodideFrontend}. */
export interface PyodideFrontendOptions {
  /** Base URL of the Pyodide distribution. Defaults to the jsDelivr CDN. */
  indexURL?: string;
  /** More PyPI requirements to install. */
  extraPackages?: string[];
  /**
   * Exact versions for some packages, e.g. `{ scriptconv: "0.0.4a85" }`.
   * Every other package installs at its newest release, prereleases included.
   */
  pins?: Record<string, string>;
  /** Called with (fraction 0–1, status label) while Pyodide loads. */
  onProgress?: (frac: number, label: string) => void;
}

/** Minimal view of the Pyodide API that the front end uses. */
interface PyProxy {
  toJs(options?: { dict_converter?: typeof Object.fromEntries }): unknown;
  destroy(): void;
}
interface PyCallable extends PyProxy {
  (...args: unknown[]): PyProxy;
  callKwargs(...args: unknown[]): Promise<unknown>;
}
interface Pyodide {
  loadPackage(names: string[]): Promise<void>;
  pyimport(name: string): Record<string, PyCallable>;
  runPython(code: string): unknown;
  toPy(value: unknown): PyProxy;
  globals: { get(name: string): PyCallable };
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
}

/** Voice settings the Python front end resolved. */
export interface FrontendVoiceInfo {
  sample_rate: number;
  noise_scale: number;
  length_scale: number;
  noise_w_scale: number;
  num_speakers: number;
  phoneme_type: string;
  lang_code: string;
}

/** The Python front end, loaded in Pyodide. */
export interface PyodideFrontend {
  /** The Pyodide instance, for callers that need it. */
  pyodide: unknown;
  /** Install the packages a phoneme type needs (once per type). */
  ensurePhonemeType(phonemeType: string): Promise<void>;
  /**
   * Load a voice index entry under `key`. `files` maps each URL of the entry
   * (except `model_url`) to its bytes.
   */
  loadVoice(
    key: string,
    entry: IndexVoiceEntry,
    files: Record<string, ArrayBuffer>,
  ): Promise<FrontendVoiceInfo>;
  /** Token ids of each sentence of `text`, as Python phoonnx makes them. */
  textToIds(key: string, text: string): number[][];
  /** Version of every installed Python distribution, by lowercase dashed name. */
  versions(): Record<string, string>;
}

let shared: Promise<PyodideFrontend> | undefined;

/**
 * Load Pyodide and the base front-end packages. The front end is shared:
 * later calls return the same instance and ignore their options.
 */
export function loadPyodideFrontend(
  options: PyodideFrontendOptions = {},
): Promise<PyodideFrontend> {
  shared ??= createFrontend(options).catch((err) => {
    shared = undefined;
    throw err;
  });
  return shared;
}

async function createFrontend(options: PyodideFrontendOptions): Promise<PyodideFrontend> {
  const { indexURL = DEFAULT_PYODIDE_URL, extraPackages = [], pins = {}, onProgress } = options;

  onProgress?.(0, "loading Python");
  const { loadPyodide } = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<Pyodide>;
  };
  const py = await loadPyodide({ indexURL });
  await py.loadPackage(["micropip", ...PYODIDE_PACKAGES]);
  const micropip = py.pyimport("micropip");

  const install = async (packages: string[]) => {
    if (packages.length === 0) return;
    const requirements = packages.map((name) => (pins[name] ? `${name}==${pins[name]}` : name));
    await micropip.install.callKwargs(requirements, { deps: false, pre: true });
  };
  onProgress?.(0.5, "installing the phoonnx front end");
  await install([...BASE_PACKAGES, ...extraPackages]);

  py.runPython(frontendSource);
  const loadVoicePy = py.globals.get("load_voice");
  const textToIdsPy = py.globals.get("text_to_ids");
  onProgress?.(1, "Python ready");

  const ready = new Map<string, Promise<void>>();
  const written = new Map<string, string>();

  return {
    pyodide: py,

    ensurePhonemeType(phonemeType) {
      if (!hasFrontend(phonemeType)) {
        return Promise.reject(new Error(
          `phoneme type "${phonemeType}" has no browser front end in phoonnx.js`,
        ));
      }
      let done = ready.get(phonemeType);
      if (!done) {
        done = install(PHONEME_TYPE_PACKAGES[phonemeType]);
        ready.set(phonemeType, done);
        done.catch(() => ready.delete(phonemeType));
      }
      return done;
    },

    async loadVoice(key, entry, files) {
      const paths: Record<string, string> = {};
      py.FS.mkdirTree("/phoonnx-js/files");
      for (const [url, buf] of Object.entries(files)) {
        let path = written.get(url);
        if (!path) {
          path = `/phoonnx-js/files/${written.size}-${url.split("/").pop()}`;
          py.FS.writeFile(path, new Uint8Array(buf));
          written.set(url, path);
        }
        paths[url] = path;
      }
      const pyEntry = py.toPy(entry);
      const pyPaths = py.toPy(paths);
      try {
        const info = loadVoicePy(key, pyEntry, pyPaths);
        const out = info.toJs({ dict_converter: Object.fromEntries }) as FrontendVoiceInfo;
        info.destroy();
        return out;
      } finally {
        pyEntry.destroy();
        pyPaths.destroy();
      }
    },

    textToIds(key, text) {
      const ids = textToIdsPy(key, text);
      const out = ids.toJs() as number[][];
      ids.destroy();
      return out;
    },

    versions() {
      const proxy = py.runPython(
        "import importlib.metadata as _m\n" +
        "{d.metadata['Name'].lower().replace('_', '-'): d.version for d in _m.distributions()}",
      ) as PyProxy;
      const out = proxy.toJs({ dict_converter: Object.fromEntries }) as Record<string, string>;
      proxy.destroy();
      return out;
    },
  };
}

/** Whether phoonnx.js can run `entry`: a single-graph VITS voice. */
export function isVitsEntry(entry: IndexVoiceEntry): boolean {
  return VITS_ENGINES.has(entry.engine ?? "") && !entry.aux_model_urls?.decode_path;
}

/**
 * Download Python phoonnx's voice index and keep the single-graph VITS voices,
 * keyed by `voice_id`.
 */
export async function fetchVoiceIndex(
  base: string = VOICE_INDEX_BASE,
  files: string[] = VITS_INDEX_FILES,
): Promise<Map<string, IndexVoiceEntry>> {
  const voices = new Map<string, IndexVoiceEntry>();
  for (const file of files) {
    const resp = await fetch(base + file);
    if (!resp.ok) throw new Error(`download failed (${resp.status}): ${base + file}`);
    const data = (await resp.json()) as
      | IndexVoiceEntry[]
      | Record<string, IndexVoiceEntry>;
    for (const entry of Array.isArray(data) ? data : Object.values(data)) {
      if (isVitsEntry(entry)) voices.set(entry.voice_id, entry);
    }
  }
  return voices;
}

/** Options for {@link loadIndexVoice}. */
export interface LoadIndexVoiceOptions extends LoadVoiceOptions, PyodideFrontendOptions {}

/**
 * Load a voice from Python phoonnx's voice index, with the Python front end.
 *
 * The voice's phoneme type must be a key of {@link PHONEME_TYPE_PACKAGES}.
 * Synthesis splits the text into sentences as Python phoonnx does, runs the
 * model once per sentence and peak-normalizes each sentence.
 */
export async function loadIndexVoice(
  entry: IndexVoiceEntry,
  options: LoadIndexVoiceOptions = {},
): Promise<LoadedVoice> {
  if (!isVitsEntry(entry)) {
    throw new Error(`voice "${entry.voice_id}" is not a single-graph VITS voice`);
  }
  const phonemeType = entry.phoneme_type ?? "graphemes";
  if (!hasFrontend(phonemeType)) {
    throw new Error(`phoneme type "${phonemeType}" has no browser front end in phoonnx.js`);
  }
  const { onProgress } = options;

  const frontend = loadPyodideFrontend(options);
  // The caller sees a front-end failure at `await frontend`; this handler only
  // keeps the browser from reporting it as unhandled while the files download.
  frontend.catch(() => {});
  const files: Record<string, ArrayBuffer> = {};
  for (const [field, url] of Object.entries(entry)) {
    if (field.endsWith("_url") && field !== "model_url" && typeof url === "string") {
      files[url] = await fetchCached(url);
    }
  }
  const { session, provider } = await createSession(entry.model_url, options);

  onProgress?.(1, "loading the text front end");
  const py = await frontend;
  await py.ensurePhonemeType(phonemeType);
  const info = await py.loadVoice(entry.voice_id, entry, files);

  const rawConfig = entry.config_url
    ? (JSON.parse(new TextDecoder().decode(files[entry.config_url])) as Partial<VoiceConfig>)
    : {};
  const config: VoiceConfig = {
    phoneme_id_map: rawConfig.phoneme_id_map ?? {},
    inference: {
      noise_scale: info.noise_scale,
      length_scale: info.length_scale,
      noise_w: info.noise_w_scale,
    },
    audio: { sample_rate: info.sample_rate },
  };

  return {
    entry: {
      id: entry.voice_id,
      repo: "",
      voice: entry.display_name ?? entry.voice_id,
      lang: entry.lang,
      langLabel: entry.lang,
      phonemeType,
      onnx: entry.model_url,
      config: entry.config_url ?? "",
      piperConfig: null,
      espeakVoice: null,
      sampleRate: info.sample_rate,
      sampleText: "",
      haCompatible: false,
    },
    session,
    config,
    idMap: voiceIdMap(config),
    sampleRate: info.sample_rate,
    provider,
    tokenize: (text: string) => py.textToIds(entry.voice_id, text),
    normalizeAudio: options.normalizeAudio ?? true,
  };
}
