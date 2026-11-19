/**
 * Text to phoneme symbols, one list per sentence, as Python phoonnx reads a
 * voice that uses a unicode or espeak phonemizer.
 *
 * The code follows scriptconv's `TextFrontend` (sentence and paragraph cuts),
 * `BasePhonemizer` (`chunk_text`, `split_clauses`, `remove_punctuation`) and
 * quebra-frases (`sentence_tokenize`). The phonemizer itself is the `readClause`
 * argument: it takes one clause and returns its phoneme string.
 */

// Python `\\w` of the `regex` module, and of the `re` module (no marks).
const WORD_WITH_MARKS = "\\p{L}\\p{M}\\p{N}_";
const WORD = "\\p{L}\\p{N}_";

// quebra_frases `_SENTENCE_REGEX`: a space after "." or "?" ends a sentence,
// except after an abbreviation such as "e.g" or "Dr.".
const SENTENCE_BREAK = new RegExp(
  `(?<![${WORD_WITH_MARKS}]\\.[${WORD_WITH_MARKS}][^\\n])(?<![A-Z][a-z]\\.)(?<=\\.|\\?)\\s`,
  "u",
);
// scriptconv `_PARAGRAPH_BREAK`.
const PARAGRAPH_BREAK = /(\n(?:[^\S\n]*\n)+)/;
// Python `\s` (`str.isspace`). JavaScript's `\s` lacks U+001C to U+001F and U+0085,
// and holds U+FEFF.
const SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// scriptconv `_CLAUSE_BREAK` and `_TRAILING_PUNCTUATION`. A match starts only where
// a run of marks starts, so a long run is read once. Group 1 is the clause break.
const MARK = `[^${WORD}${SPACE}]`;
const CLAUSE_BREAK = new RegExp(
  `(?<!${MARK})(?=${MARK}*[${SPACE}])${MARK}*?((?:\\.\\.|\\u2026|[,:;!?|\\u060c\\u061b\\u061f])${MARK}*)`,
  "gu",
);
const TRAILING_PUNCTUATION = new RegExp(`(?<!${MARK})${MARK}+[${SPACE}]*$`, "u");
const LANG_FLAGS = /\([^)]+\)/g;

// scriptconv `CLAUSE_PUNCTUATION`: the clause marks and the symbol each one is kept as.
const CLAUSE_PUNCTUATION: Record<string, string> = {
  ".": ".", "?": "?", "!": "!", ",": ",", ":": ":", ";": ";",
  "،": ",", "؛": ";", "؟": "?",
};
const PAUSE_PUNCTUATION = new Set([",", ":", ";"]);
const SEPARATING_MARKS = new Set(
  Object.entries(CLAUSE_PUNCTUATION).filter(([, s]) => s === "!" || s === "?").map(([m]) => m),
);
const CHUNK_DELIMITERS = [":", ";", "...", "|"];

const isAlpha = (ch: string | undefined) => ch !== undefined && /^\p{L}$/u.test(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && /^\p{Nd}$/u.test(ch);

export function sentenceTokenize(text: string): string[] {
  return text.split(SENTENCE_BREAK);
}

/** `BasePhonemizer._between_letters`: the character at `index` stands between two letters. */
function betweenLetters(chars: string[], index: number): boolean {
  if (!(index > 0 && index < chars.length - 1) || !isAlpha(chars[index + 1])) return false;
  let letter = index - 1;
  while (letter > 0 && /^\p{M}$/u.test(chars[letter])) letter--;
  return isAlpha(chars[letter]);
}

/** `BasePhonemizer.remove_punctuation`. */
export function removePunctuation(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let separates = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if ((c === "'" || c === "’" || c === "-") && betweenLetters(chars, i)) {
      out.push(c);
      continue;
    }
    if (SEPARATING_MARKS.has(c)) {
      if (i === 0 || !SEPARATING_MARKS.has(chars[i - 1])) {
        let end = i;
        while (end < chars.length && SEPARATING_MARKS.has(chars[end])) end++;
        let letter = i - 1;
        while (letter > 0 && /^\p{M}$/u.test(chars[letter])) letter--;
        separates = i > 0 && isAlpha(chars[letter]) && end < chars.length && isAlpha(chars[end]);
        if (separates) out.push(" ");
      }
      if (separates) continue;
    }
    if (i > 0 && i < chars.length - 1 && isDigit(chars[i - 1]) && isDigit(chars[i + 1])) {
      out.push(c);
      continue;
    }
    if (/^\p{P}$/u.test(c)) continue;
    out.push(c);
  }
  return out.join("").trim();
}

function clauseMark(punctuation: string): string | null {
  if (punctuation.includes("..") || punctuation.includes("…")) return null;
  for (const c of punctuation) if (c in CLAUSE_PUNCTUATION) return CLAUSE_PUNCTUATION[c];
  return null;
}

/** `split_clauses`: `[clause, mark]` pairs of one sentence. */
export function splitClauses(sentence: string): Array<[string, string | null]> {
  const clauses: Array<[string, string | null]> = [];
  let start = 0;
  for (const match of sentence.matchAll(CLAUSE_BREAK)) {
    const end = match.index! + match[0].length;
    // Group 1, the break, ends where the match ends.
    clauses.push([sentence.slice(start, end - match[1].length), clauseMark(match[1])]);
    start = end;
  }
  const tail = sentence.slice(start);
  const trailing = TRAILING_PUNCTUATION.exec(tail);
  clauses.push([tail, trailing ? clauseMark(trailing[0]) : null]);
  return clauses;
}

/** `BasePhonemizer.chunk_text`: the chunks of each sentence, with whether it ends its sentence. */
function chunkText(text: string): Array<[string, boolean]> {
  const alternatives = CHUNK_DELIMITERS.map((delimiter) => {
    const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `(?:(?<!\\d)${escaped}|${escaped}(?!\\d))`;
  }).join("|");
  const delimiters = new RegExp(`(${alternatives})`);
  const chunks: Array<[string, boolean]> = [];
  for (const sentence of sentenceTokenize(text)) {
    const parts = sentence.split(delimiters);
    for (let i = 0; i < parts.length; i += 2) chunks.push([parts[i].trim(), i + 2 >= parts.length]);
  }
  return chunks;
}

/** `_clause_breaks_as_spaces`: each line of the phonemizer output is a clause, and a space joins them. */
function clauseBreaksAsSpaces(phonemes: string): string {
  if (!phonemes.includes("\n")) return phonemes;
  return phonemes.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
}

/** Reads one clause into its phoneme string. */
type ReadClause = (clause: string) => string;

/** Reads every clause of a text into its phoneme string, in one call. */
export type ReadClauses = (clauses: string[]) => string[] | Promise<string[]>;

function readSymbols(read: ReadClause, clause: string): string[] {
  const phonemes = clause === "" ? "" : read(clause).trim().replace(LANG_FLAGS, "");
  return Array.from(clauseBreaksAsSpaces(phonemes));
}

/** The sentences of `BasePhonemizer._punctuated_sentences`: clause symbols stay. */
function punctuatedSentences(text: string, read: ReadClause): string[][] {
  const sentences: string[][] = [];
  for (const sentence of sentenceTokenize(text)) {
    const phonemes: string[] = [];
    for (const [rawClause, mark] of splitClauses(sentence)) {
      const clause = removePunctuation(rawClause);
      if (!clause) continue;
      const clausePhonemes = readSymbols(read, clause);
      if (clausePhonemes.length === 0) continue;
      if (phonemes.length > 0 && phonemes[phonemes.length - 1] !== " ") phonemes.push(" ");
      phonemes.push(...clausePhonemes);
      if (mark) {
        phonemes.push(mark);
        if (PAUSE_PUNCTUATION.has(mark)) phonemes.push(" ");
      }
    }
    if (phonemes.length > 0) sentences.push(phonemes);
  }
  return sentences;
}

/** The sentences of `BasePhonemizer._bare_sentences`: no punctuation reaches the voice. */
function bareSentences(text: string, read: ReadClause): string[][] {
  const sentences: string[][] = [];
  let chunks: string[][] = [];
  for (const [chunk, endsSentence] of chunkText(text)) {
    chunks.push(readSymbols(read, removePunctuation(chunk)));
    if (endsSentence) {
      const joined: string[] = [];
      let joins = true;
      for (const symbols of chunks) {
        if (symbols.length === 0) continue;
        if (!joins) joined.push(" ");
        joined.push(...symbols);
        joins = symbols[symbols.length - 1] === " ";
      }
      sentences.push(joined);
      chunks = [];
    }
  }
  return sentences;
}

function sentencesOf(text: string, read: ReadClause, keepPunctuation: boolean): string[][] {
  const out: string[][] = [];
  if (!text.trim()) return out;
  const paragraphs = text.split(PARAGRAPH_BREAK).filter((_, i) => i % 2 === 0);
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    for (const sentence of sentenceTokenize(paragraph)) {
      const part = sentence.trimStart();
      if (!part.trim()) continue;
      const segments = keepPunctuation ? punctuatedSentences(part, read) : bareSentences(part, read);
      for (const symbols of segments) if (symbols.length > 0) out.push(symbols);
    }
  }
  return out;
}

/**
 * The symbols of each sentence of `text`, as `TextFrontend.segments` gives them
 * for a phonemizer that keeps no state: paragraphs, then sentences, then the
 * phonemizer's own sentence cut. A sentence with no symbols is left out.
 *
 * The cuts depend on the text only, so the clauses are collected first and
 * `readClauses` reads all of them in one call, which lets an espeak voice use
 * one engine instance for the whole text.
 */
export async function phonemeSentences(
  text: string,
  readClauses: ReadClauses,
  keepPunctuation: boolean,
): Promise<string[][]> {
  const clauses: string[] = [];
  sentencesOf(text, (clause) => (clauses.push(clause), ""), keepPunctuation);
  const phonemes = await readClauses(clauses);
  let next = 0;
  return sentencesOf(text, () => phonemes[next++], keepPunctuation);
}
