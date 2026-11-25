import { phonemeSentences } from "./frontend.js";
import type { IdMap, VoiceConfig } from "./types.js";

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
 * A phoneme_id_map as the tokenizers read it, as Python phoonnx reads it: a list
 * of one id gives that id, and a longer list keeps every id. Piper writes
 * `{ "a": [14] }`, and phoonnx writes `{ "a": 14 }` or `{ "ç": [16, 140] }`.
 */
export function flattenIdMap(m: IdMap): IdMap {
  const out: IdMap = {};
  for (const [k, v] of Object.entries(m)) out[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
  return out;
}

/** The id of a single-id symbol such as the blank, or `fallback`. */
export function singleId(idMap: IdMap, symbol: string, fallback: number): number {
  const id = idMap[symbol];
  return typeof id === "number" ? id : fallback;
}

/**
 * Symbols to token ids, as phoonnx's TTSTokenizer reads them: a symbol
 * that is not in the map falls back to its canonical decomposition when every
 * part is in the map, then to its lowercase form, and is dropped otherwise.
 * Multi-character map keys fold adjacent symbols, longest key first. A blank
 * id goes between the ids, and BOS and EOS wrap them.
 */
export function symbolsToIds(symbols: string[], idMap: IdMap): number[] {
  const blank = singleId(idMap, "_", 0);
  const bos = singleId(idMap, "^", 1);
  const eos = singleId(idMap, "$", 2);
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
        id = parts.flatMap((part) => idMap[part]);
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
  idMap: IdMap,
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
 * Whether Piper trained the voice: a piper config, which has no `phoonnx_version`,
 * that phoonnx did not write (a `piper_version` that starts with "phoonnx", or an
 * `alphabet` key), as Python phoonnx reads it.
 */
export function trainedByPiper(config: VoiceConfig): boolean {
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

/**
 * Whether a voice keeps clause punctuation, as Python phoonnx reads the config:
 * the `keep_punctuation` key when there is one, else whether Piper trained it.
 */
export function keepsPunctuation(config: VoiceConfig): boolean {
  if (config.keep_punctuation !== undefined && config.keep_punctuation !== null) {
    return Boolean(config.keep_punctuation);
  }
  return trainedByPiper(config);
}

/**
 * The id map of a voice, as Python phoonnx reads it. Piper decomposes the
 * espeak-ng phonemes (NFD) before the id lookup, so "ç" reaches a voice it
 * trained as "c" and U+0327, and the own id of "ç" is never trained
 * (piper1-gpl src/piper/phonemize_espeak.py at v1.5.0). For such a voice a
 * precomposed symbol reads as the ids of its parts that the map holds.
 */
export function voiceIdMap(config: VoiceConfig): IdMap {
  const idMap = flattenIdMap(config.phoneme_id_map);
  if (!trainedByPiper(config)) return idMap;
  for (const symbol of Object.keys(idMap)) {
    const parts = Array.from(symbol.normalize("NFD"));
    if (parts.join("") === symbol) continue;
    idMap[symbol] = parts.filter((part) => part in config.phoneme_id_map)
      .flatMap((part) => config.phoneme_id_map[part]);
  }
  return idMap;
}
