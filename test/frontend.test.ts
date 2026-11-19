/**
 * Tests for the clause split of the text front end.
 *
 * `fixtures/clause_parity.json` holds the clauses that Python scriptconv's
 * `split_clauses` gives for each input. A script outside this repository
 * writes it; the file names the scriptconv version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { splitClauses } from "../src/frontend.ts";

const PARITY = JSON.parse(
  readFileSync(new URL("./fixtures/clause_parity.json", import.meta.url), "utf8"),
) as { rows: Array<[string, Array<[string, string | null]>]> };

test("clauses are the clauses of Python scriptconv", () => {
  for (const [text, clauses] of PARITY.rows) {
    assert.deepEqual(splitClauses(text), clauses, JSON.stringify(text));
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
};

// A child process times each shape, so a split that never ends fails at the
// deadline instead of hanging the test run.
const TIME_SHAPES = `
  import { readFileSync } from "node:fs";
  const { splitClauses } = await import(${JSON.stringify(new URL("../src/frontend.ts", import.meta.url).href)});
  const seconds = {};
  for (const [name, text] of Object.entries(JSON.parse(readFileSync(0, "utf8")))) {
    const start = performance.now();
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
