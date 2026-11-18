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
 * const result = await synthesize(voice, "Hello world", {
 *   tokenize: (text, idMap) =>
 *     tokenize(text, idMap, entry.espeakVoice!, { keepPunctuation: voice.keepPunctuation }),
 * });
 * ```
 *
 * @example CDN / vanilla JS — load wasm from CDN
 * ```js
 * const { makeEspeakTokenizer } = await import("https://esm.sh/phoonnx/espeak");
 * const espeakFactory = (await import("https://esm.sh/espeak-ng")).default;
 * const tokenize = makeEspeakTokenizer(espeakFactory, "https://esm.sh/espeak-ng/dist/espeak-ng.wasm");
 * ```
 */

import { phonemeSentences, type ReadClauses } from "./frontend.js";
import { symbolsToIds, type TokenizeOptions } from "./tokenize.js";

type EspeakFactory = (opts: {
  arguments: string[];
  stdin: () => number | null;
  print: (s: string) => void;
  printErr: (s: string) => void;
  locateFile: (p: string) => string;
}) => Promise<unknown>;

/**
 * Create a tokenizer function bound to a specific espeak-ng WASM instance.
 *
 * @param espeakFactory  The Emscripten factory (default export of `espeak-ng`).
 * @param wasmUrl        URL or path to `espeak-ng.wasm`.
 */
export function makeEspeakTokenizer(
  espeakFactory: EspeakFactory,
  wasmUrl: string,
): (
  text: string,
  idMap: Record<string, number>,
  espeakVoice?: string,
  options?: TokenizeOptions,
) => Promise<number[][]> {
  return async (
    text: string,
    idMap: Record<string, number>,
    espeakVoice?: string,
    options?: TokenizeOptions,
  ) => {
    if (!espeakVoice) {
      throw new Error(
        "espeakVoice is required. Pass voice.entry.espeakVoice (e.g. \"eu\", \"en\").",
      );
    }
    return tokenizeEspeak(text, espeakVoice, idMap, espeakFactory, wasmUrl, options);
  };
}

/**
 * Low-level espeak tokenizer. It returns one id list per sentence.
 *
 * The text splits into sentences and clauses as in Python phoonnx, and espeak-ng
 * reads each clause alone. With `keepPunctuation`, each clause keeps its
 * clause symbol. phoonnx also normalizes numbers, dates and abbreviations to
 * words first, and applies the phonetic spellings of the language. This
 * function does neither.
 *
 * Most callers should use {@link makeEspeakTokenizer} instead.
 */
export async function tokenizeEspeak(
  text: string,
  espeakVoice: string,
  idMap: Record<string, number>,
  espeakFactory: EspeakFactory,
  wasmUrl: string,
  options: TokenizeOptions = {},
): Promise<number[][]> {
  // One espeak-ng instance reads every clause: stdin holds one clause per line,
  // and the instance prints the phonemes of each line on a line of its own.
  const run = async (clauses: string[]): Promise<string[]> => {
    const bytes = new TextEncoder().encode(clauses.join("\n"));
    let next = 0;
    const lines: string[] = [];
    await espeakFactory({
      arguments: ["-q", "--ipa", "-v", espeakVoice],
      stdin: () => (next < bytes.length ? bytes[next++] : null),
      print: (s: string) => lines.push(s),
      printErr: () => {},
      locateFile: (p: string) => (p.endsWith(".wasm") ? wasmUrl : p),
    });
    return lines;
  };
  const readClauses: ReadClauses = async (clauses) => {
    if (clauses.length === 0) return [];
    // A newline inside a clause reads as a space, so a line is one clause.
    const single = clauses.map((clause) => clause.replace(/\r?\n/g, " "));
    const lines = await run(single);
    if (lines.length === single.length) return lines;
    // Some clause printed no line or several. Read each clause alone.
    const alone: string[] = [];
    for (const clause of single) alone.push((await run([clause])).join("\n"));
    return alone;
  };
  const sentences = await phonemeSentences(text, readClauses, options.keepPunctuation ?? false);
  return sentences.map((symbols) => symbolsToIds(symbols, idMap));
}
