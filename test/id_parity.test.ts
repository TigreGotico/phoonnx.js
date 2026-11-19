/**
 * Token-id parity with Python phoonnx.
 *
 * Every row of the shared fixture (see id_parity_fixture.mjs) gives the ids
 * Python phoonnx computes for a text. The unicode and espeak tokenizers of
 * phoonnx.js run in Node, so this file compares those rows. The rows of the
 * other phoneme types (graphemes) need the Pyodide front end in a browser and
 * are not read here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// @ts-expect-error espeak-ng ships no type declarations
import espeakFactory from "espeak-ng";

import { flattenIdMap, keepsPunctuation, tokenizeUnicode } from "../src/tokenize.ts";
import { tokenizeEspeak } from "../src/espeak.ts";
import type { VoiceConfig } from "../src/types.ts";
import { loadIdParityFixture } from "./id_parity_fixture.mjs";

const wasm = fileURLToPath(new URL("../node_modules/espeak-ng/dist/espeak-ng.wasm", import.meta.url));

interface Voice { phoneme_type: string; espeak_voice?: string; files: { config_url: VoiceConfig } }
interface Row { voice_id: string; text: string; ids: number[][] }

const fixture: { voices: Record<string, Voice>; rows: Row[] } = await loadIdParityFixture();

async function idsOf(row: Row): Promise<number[][]> {
  const voice = fixture.voices[row.voice_id];
  const config = voice.files.config_url;
  const idMap = flattenIdMap(config.phoneme_id_map);
  const options = { keepPunctuation: keepsPunctuation(config) };
  if (voice.phoneme_type === "unicode") return tokenizeUnicode(row.text, idMap, options);
  return tokenizeEspeak(row.text, voice.espeak_voice!, idMap, espeakFactory, wasm, options);
}

for (const row of fixture.rows) {
  const type = fixture.voices[row.voice_id].phoneme_type;
  if (type !== "unicode" && type !== "espeak") continue;
  test(`${type} ids match phoonnx: ${row.voice_id} | ${row.text}`, async () => {
    assert.deepEqual(await idsOf(row), row.ids);
  });
}
