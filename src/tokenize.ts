import { phonemeSentences } from "./frontend.js";
import type { VoiceConfig } from "./types.js";

/** How the tokenizers read a voice's text. */
export interface TokenizeOptions {
  /**
   * Keep clause punctuation (`. ? ! , : ;`) as symbols, as a voice trained
   * with punctuation expects. `LoadedVoice.keepPunctuation` holds the value
   * of a voice. Default false.
   */
  keepPunctuation?: boolean;
}

/**
 * Normalize a phoneme_id_map to char → int.
 * piper uses `{ "a": [14] }`, phoonnx uses `{ "a": 14 }`.
 */
export function flattenIdMap(
  m: Record<string, number | number[]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/**
 * Symbols to token ids, as phoonnx's TTSTokenizer reads them: a symbol
 * that is not in the map falls back to its canonical decomposition when every
 * part is in the map, then to its lowercase form, and is dropped otherwise.
 * Multi-character map keys fold adjacent symbols, longest key first. A blank
 * id goes between the ids, and BOS and EOS wrap them.
 */
export function symbolsToIds(symbols: string[], idMap: Record<string, number>): number[] {
  const blank = idMap["_"] ?? 0;
  const bos = idMap["^"] ?? 1;
  const eos = idMap["$"] ?? 2;
  const compounds = Object.keys(idMap)
    .map((key) => Array.from(key))
    .filter((chars) => chars.length > 1)
    .sort((a, b) => b.length - a.length);

  const ids: number[] = [];
  let folded = 0;
  for (let i = 0; i < symbols.length; i++) {
    if (i < folded) continue;
    const symbol = symbols[i];
    let id: number | number[] | undefined = idMap[symbol];
    for (const chars of compounds) {
      if (symbols.slice(i, i + chars.length).join("") === chars.join("")) {
        id = idMap[chars.join("")];
        folded = i + chars.length;
        break;
      }
    }
    if (id === undefined && Array.from(symbol).length === 1) {
      const parts = Array.from(symbol.normalize("NFD"));
      if (parts.length > 1 && parts.every((part) => part in idMap)) {
        id = parts.map((part) => idMap[part]);
      }
    }
    if (id === undefined && Array.from(symbol).length === 1) {
      const lowered = symbol.toLowerCase();
      if (lowered !== symbol && lowered in idMap) id = idMap[lowered];
    }
    if (id === undefined) continue;
    if (Array.isArray(id)) ids.push(...id);
    else ids.push(id);
  }

  const seq: number[] = [bos, blank];
  for (const id of ids) seq.push(id, blank);
  seq.push(eos);
  return seq;
}

/**
 * Unicode tokenizer, as phoonnx reads a "unicode" voice: the text splits into
 * sentences and clauses, each clause loses its punctuation (kept as a clause
 * symbol with `keepPunctuation`), and its NFD codepoints are the symbols. It
 * returns one id list per sentence.
 *
 * phoonnx also normalizes numbers, dates and abbreviations to words first, and
 * applies the phonetic spellings of the language. This function does neither.
 */
export async function tokenizeUnicode(
  text: string,
  idMap: Record<string, number>,
  options: TokenizeOptions = {},
): Promise<number[][]> {
  const sentences = await phonemeSentences(
    text,
    (clauses) => clauses.map((clause) => clause.normalize("NFD")),
    options.keepPunctuation ?? false,
  );
  return sentences.map((symbols) => symbolsToIds(symbols, idMap));
}

/**
 * Whether a voice keeps clause punctuation, as Python phoonnx reads the config:
 * the `keep_punctuation` key when there is one. A piper config, which has no
 * `phoonnx_version`, keeps it unless phoonnx wrote it (a `piper_version` that
 * starts with "phoonnx", or an `alphabet` key). Any other config does not.
 */
export function keepsPunctuation(config: VoiceConfig): boolean {
  if (config.keep_punctuation !== undefined && config.keep_punctuation !== null) {
    return Boolean(config.keep_punctuation);
  }
  if ("phoonnx_version" in config) return false;
  const map = config.phoneme_id_map;
  const pipershaped =
    "piper_version" in config ||
    (typeof config.phoneme_type === "string" &&
      ["text", "espeak"].includes(config.phoneme_type) &&
      Object.keys(map).length > 0 &&
      Object.values(map).every(Array.isArray));
  if (!pipershaped) return false;
  return !(String(config.piper_version ?? "").startsWith("phoonnx") || "alphabet" in config);
}
