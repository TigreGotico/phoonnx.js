/**
 * Token-id parity with Python phoonnx.
 *
 * Every row of the shared fixture (see id_parity_fixture.mjs) gives the ids
 * Python phoonnx computes for a text. The unicode and espeak tokenizers of
 * phoonnx.js run in Node, so this file compares those rows. The rows of the
 * other phoneme types (graphemes) need the Pyodide front end in a browser and
 * are not read here.
 *
 * A row in KNOWN_GAPS differs from Python. It runs as a `todo` test, which
 * reports the difference and does not fail the suite. Remove the entry when
 * the ids agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// @ts-expect-error espeak-ng ships no type declarations
import espeakFactory from "espeak-ng";

import { flattenIdMap, tokenizeUnicode } from "../src/tokenize.ts";
import { tokenizeEspeak } from "../src/espeak.ts";
import { loadIdParityFixture } from "./id_parity_fixture.mjs";

const wasm = fileURLToPath(new URL("../node_modules/espeak-ng/dist/espeak-ng.wasm", import.meta.url));

/** Rows whose ids differ from Python, with the reason. */
const KNOWN_GAPS: Record<string, string> = {
  "Bonjorn, lo monde": "Python lowercases the text and keeps punctuation (keep_punctuation)",
  "Ço qu'a dit: « Òc ! »": "Python lowercases the text and keeps punctuation (keep_punctuation)",
  "Bonjorn, lo monde. Aquesta votz parla dins ton navegador.":
    "Python lowercases, keeps punctuation and gives one id list per sentence",
  "Ola! Esta voz charra en o tuyo navegador.": "Python lowercases the text and keeps punctuation (keep_punctuation)",
  "Kaixo mundua. Hau proba bat da.": "Python gives one id list per sentence",
  "Hello! This voice runs entirely in your browser.": "Python keeps punctuation (keep_punctuation)",
};

interface Voice { phoneme_type: string; espeak_voice?: string; files: { config_url: { phoneme_id_map: Record<string, number | number[]> } } }
interface Row { voice_id: string; text: string; ids: number[][] }

const fixture: { voices: Record<string, Voice>; rows: Row[] } = await loadIdParityFixture();

async function idsOf(row: Row): Promise<number[][]> {
  const voice = fixture.voices[row.voice_id];
  const idMap = flattenIdMap(voice.files.config_url.phoneme_id_map);
  if (voice.phoneme_type === "unicode") return [tokenizeUnicode(row.text, idMap)];
  return [await tokenizeEspeak(row.text, voice.espeak_voice!, idMap, espeakFactory, wasm)];
}

for (const row of fixture.rows) {
  const type = fixture.voices[row.voice_id].phoneme_type;
  if (type !== "unicode" && type !== "espeak") continue;
  const gap = KNOWN_GAPS[row.text];
  test(`${type} ids match phoonnx: ${row.voice_id} | ${row.text}`, gap ? { todo: gap } : {}, async () => {
    assert.deepEqual(await idsOf(row), row.ids);
  });
}

test("every known gap names a row of the fixture", () => {
  const texts = new Set(fixture.rows.map((row) => row.text));
  for (const text of Object.keys(KNOWN_GAPS)) assert.ok(texts.has(text), text);
});
