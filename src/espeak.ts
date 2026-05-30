/**
 * espeak-ng tokenizer for phoonnx — optional entry point.
 *
 * Import from `phoonnx/espeak` to get the helpers; the espeak-ng WASM module
 * itself is a peer dependency that callers must provide. This keeps the base
 * `phoonnx` import free of any WASM payload.
 *
 * @example Vite / Astro project
 * ```ts
 * import espeakFactory from "espeak-ng";
 * import espeakWasmUrl from "espeak-ng/dist/espeak-ng.wasm?url";
 * import { makeEspeakTokenizer } from "phoonnx/espeak";
 * import { loadVoice, synthesize } from "phoonnx";
 *
 * const tokenize = makeEspeakTokenizer(espeakFactory, espeakWasmUrl);
 * const voice = await loadVoice(entry);
 * const result = await synthesize(voice, "Hello world", { tokenize });
 * ```
 *
 * @example CDN / vanilla JS — load wasm from CDN
 * ```js
 * const { makeEspeakTokenizer } = await import("https://esm.sh/phoonnx/espeak");
 * const espeakFactory = (await import("https://esm.sh/espeak-ng")).default;
 * const tokenize = makeEspeakTokenizer(espeakFactory, "https://esm.sh/espeak-ng/dist/espeak-ng.wasm");
 * ```
 */

type EspeakFactory = (opts: {
  arguments: string[];
  print: (s: string) => void;
  printErr: (s: string) => void;
  locateFile: (p: string) => string;
}) => Promise<unknown>;

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

/**
 * Create a tokenizer function bound to a specific espeak-ng WASM instance.
 *
 * @param espeakFactory  The Emscripten factory (default export of `espeak-ng`).
 * @param wasmUrl        URL or path to `espeak-ng.wasm`.
 */
export function makeEspeakTokenizer(
  espeakFactory: EspeakFactory,
  wasmUrl: string,
): (text: string, idMap: Record<string, number>, espeakVoice?: string) => Promise<number[]> {
  return async (
    text: string,
    idMap: Record<string, number>,
    espeakVoice?: string,
  ) => {
    if (!espeakVoice) {
      throw new Error(
        "espeakVoice is required. Pass voice.entry.espeakVoice (e.g. \"eu\", \"en\").",
      );
    }
    return tokenizeEspeak(text, espeakVoice, idMap, espeakFactory, wasmUrl);
  };
}

/**
 * Low-level espeak tokenizer.
 *
 * Most callers should use {@link makeEspeakTokenizer} instead.
 */
export async function tokenizeEspeak(
  text: string,
  espeakVoice: string,
  idMap: Record<string, number>,
  espeakFactory: EspeakFactory,
  wasmUrl: string,
): Promise<number[]> {
  const blank = idMap["_"] ?? 0;
  const bos = idMap["^"] ?? 1;
  const eos = idMap["$"] ?? 2;

  let cleaned = "";
  for (const ch of text) if (!PUNCT.has(ch)) cleaned += ch;

  const lines: string[] = [];
  await espeakFactory({
    arguments: ["-q", "--ipa", "-v", espeakVoice, cleaned.trim()],
    print: (s: string) => lines.push(s),
    printErr: () => {},
    locateFile: (p: string) => (p.endsWith(".wasm") ? wasmUrl : p),
  });
  const ipa = lines.join("\n");

  const tokens: number[] = [];
  for (const ch of Array.from(ipa.normalize("NFD"))) {
    const id = idMap[ch];
    if (id !== undefined) tokens.push(id);
  }

  const seq: number[] = [bos, blank];
  for (const t of tokens) seq.push(t, blank);
  seq.push(eos);
  return seq;
}
