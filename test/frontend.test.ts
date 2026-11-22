/**
 * Tests for the sentence and clause splits of the text front end.
 *
 * `fixtures/sentence_parity.json` holds the sentences that Python
 * quebra_frases's `sentence_tokenize` gives for each input.
 * `fixtures/gen_sentence_parity.py` writes it; the file names the
 * quebra_frases version.
 *
 * `fixtures/clause_parity.json` holds the clauses that Python scriptconv's
 * `split_clauses` gives for each input. A script outside this repository
 * writes it; the file names the scriptconv version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { phonemeSentences, sentenceTokenize, splitClauses } from "../src/frontend.ts";

const SENTENCE_PARITY = JSON.parse(
  readFileSync(new URL("./fixtures/sentence_parity.json", import.meta.url), "utf8"),
) as { rows: Array<[string, string[]]> };

// Every wrong row is listed, not only the first.
test("sentences are the sentences of Python quebra_frases", () => {
  const wrong = SENTENCE_PARITY.rows
    .map(([text, expected]) => ({ text, expected, actual: sentenceTokenize(text) }))
    .filter(({ expected, actual }) => JSON.stringify(actual) !== JSON.stringify(expected));
  assert.deepEqual(wrong, [], `${wrong.length} of ${SENTENCE_PARITY.rows.length} rows differ`);
});

const PARITY = JSON.parse(
  readFileSync(new URL("./fixtures/clause_parity.json", import.meta.url), "utf8"),
) as { rows: Array<[string, Array<[string, string | null]>]> };

test("clauses are the clauses of Python scriptconv", () => {
  for (const [text, clauses] of PARITY.rows) {
    assert.deepEqual(splitClauses(text), clauses, JSON.stringify(text));
  }
});

test("one clause of 200,000 symbols reads in both punctuation modes", async () => {
  const symbols = "x".repeat(200_000);
  const readClauses = (clauses: string[]) => clauses.map(() => symbols);
  for (const keepPunctuation of [true, false]) {
    const sentences = await phonemeSentences("a", readClauses, keepPunctuation);
    assert.deepEqual(sentences, [Array.from(symbols)]);
  }
});

// Long runs of marks, with and without whitespace after them.
const N = 100_000;
const SHAPES: Record<string, string> = {
  dots: "a" + ".".repeat(N) + "b",
  dotsThenSpace: "a" + ".".repeat(N) + " b",
  dotsAtEnd: "a" + ".".repeat(N),
  dotsThenNewline: "a" + ".".repeat(N) + "\n",
  ellipses: "a" + "…".repeat(N) + "b",
  mixed: "a" + ".,;".repeat(N / 2).slice(0, N) + "b",
  arabic: "a" + "،؛؟".repeat(N / 2).slice(0, N) + "b",
  quotesThenComma: "a" + '"'.repeat(N) + ", b",
  quotes: "a" + '"'.repeat(N) + "b",
  combiningMarks: "a" + "́".repeat(N) + "b",
  commas: "a, ".repeat(N / 3),
  dotSpace: ". ".repeat(N / 2) + "x",
  spacesThenWord: "a," + " ".repeat(N) + "b",
  spaces: "a" + " ".repeat(N) + "b",
  marksAndSpaces: ". …\x1c".repeat(N / 4) + "b",
  dotWideSpace: (". " + " ".repeat(50)).repeat(N / 52) + "x",
  quotesThenWord: ('"'.repeat(20) + " a").repeat(N / 22),
  dotNewline: ".\n".repeat(N / 2),
  cjkQuotes: "。" + "」".repeat(N) + " x",
  closersAfterSpace: "a. " + "»".repeat(N) + "x",
};

// A child process times both splits of each shape, so a split that never ends
// fails at the deadline instead of hanging the test run.
const TIME_SHAPES = `
  import { readFileSync } from "node:fs";
  const { sentenceTokenize, splitClauses } = await import(${JSON.stringify(new URL("../src/frontend.ts", import.meta.url).href)});
  const seconds = {};
  for (const [name, text] of Object.entries(JSON.parse(readFileSync(0, "utf8")))) {
    const start = performance.now();
    sentenceTokenize(text);
    splitClauses(text);
    seconds[name] = (performance.now() - start) / 1000;
  }
  console.log(JSON.stringify(seconds));
`;

test("long runs of marks split in linear time", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", TIME_SHAPES],
    { input: JSON.stringify(SHAPES), encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(child.signal, null, "the split did not finish in 30 s");
  assert.equal(child.status, 0, child.stderr);
  const seconds = JSON.parse(child.stdout) as Record<string, number>;
  assert.deepEqual(Object.keys(seconds), Object.keys(SHAPES));
  for (const [name, time] of Object.entries(seconds)) assert.ok(time < 1, `${name}: ${time} s`);
});
