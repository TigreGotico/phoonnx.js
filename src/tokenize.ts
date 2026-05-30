// Python string.punctuation — matches what phoonnx's UnicodeCodepointPhonemizer
// strips before tokenizing (see phoonnx/phonemizers/base.py remove_punctuation).
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

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
 * Unicode tokenizer — reproduces phoonnx's UnicodeCodepointPhonemizer exactly:
 *   1. Strip punctuation
 *   2. NFD-normalize (splits pre-composed accents into base+combining codepoints)
 *   3. Per-codepoint phoneme_id_map lookup (skip unknowns)
 *   4. Intersperse blank (id 0) between every token
 *   5. Wrap in BOS (^) / EOS ($)
 */
export function tokenizeUnicode(
  text: string,
  idMap: Record<string, number>,
): number[] {
  const blank = idMap["_"] ?? 0;
  const bos = idMap["^"] ?? 1;
  const eos = idMap["$"] ?? 2;

  let cleaned = "";
  for (const ch of text) if (!PUNCT.has(ch)) cleaned += ch;

  const tokens: number[] = [];
  for (const ch of Array.from(cleaned.trim().normalize("NFD"))) {
    const id = idMap[ch];
    if (id !== undefined) tokens.push(id);
  }

  const seq: number[] = [bos, blank];
  for (const t of tokens) seq.push(t, blank);
  seq.push(eos);
  return seq;
}

/**
 * espeak-ng tokenizer — phonemize via WASM, then per-codepoint id lookup.
 *
 * @param text        Input text to phonemize.
 * @param espeakVoice espeak-ng language code (e.g. "eu", "en", "ar").
 * @param idMap       Phoneme id map from the loaded voice config.
 * @param espeakFactory  The espeak-ng Emscripten factory function.
 *                    Pass `(await import("espeak-ng")).default`.
 * @param wasmUrl     URL/path to the espeak-ng .wasm file.
 */
export async function tokenizeEspeak(
  text: string,
  espeakVoice: string,
  idMap: Record<string, number>,
  espeakFactory: (opts: {
    arguments: string[];
    print: (s: string) => void;
    printErr: (s: string) => void;
    locateFile: (p: string) => string;
  }) => Promise<unknown>,
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
