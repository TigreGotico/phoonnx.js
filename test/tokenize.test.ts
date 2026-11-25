import { test } from "node:test";
import assert from "node:assert/strict";

import { flattenIdMap, symbolsToIds, voiceIdMap } from "../src/tokenize.ts";

// A native phoonnx config gives a precomposed symbol the ids of its parts.
// The expected ids are Python phoonnx's TTSTokenizer.tokenize("ɪç") for this map.
const config = { "_": 0, "^": 1, "$": 2, " ": 3, "ɪ": 74, "ç": [16, 140], "c": 16, "̧": 140 };

test("a symbol listed with several ids reads as all of them", () => {
  assert.deepEqual(symbolsToIds(["ɪ", "ç"], flattenIdMap(config)), [1, 0, 74, 0, 16, 0, 140, 0, 2]);
});

test("a list of one id reads as that id", () => {
  assert.deepEqual(flattenIdMap({ "a": [14], "b": 15 }), { "a": 14, "b": 15 });
});

// pipertts_de-DE_miro, as Piper trained it: its map lists "ç" with its own id 40,
// and Piper reads "ç" as "c" (16) and U+0327 (140). The expected ids are Python
// phoonnx's VoiceConfig.from_dict(config).tokenizer.tokenize(["ɪ", "ç"]) for the
// config of every pipertts voice of the catalogue.
const piperMap = { "_": [0], "^": [1], "$": [2], "ɪ": [74], "c": [16], "ç": [40], "̧": [140] };

test("a voice Piper trained reads a precomposed symbol as the ids of its parts", () => {
  const config = { piper_version: "1.0.0", phoneme_type: "espeak", phoneme_id_map: piperMap };
  assert.deepEqual(symbolsToIds(["ɪ", "ç"], voiceIdMap(config)), [1, 0, 74, 0, 16, 0, 140, 0, 2]);
});

test("a piper config that phoonnx wrote keeps the own id of a precomposed symbol", () => {
  const config = { piper_version: "1.0.0", alphabet: "ipa", phoneme_type: "espeak", phoneme_id_map: piperMap };
  assert.deepEqual(symbolsToIds(["ɪ", "ç"], voiceIdMap(config)), [1, 0, 74, 0, 40, 0, 2]);
});

test("a voice Piper trained drops a part its map does not hold", () => {
  const map = { "_": [0], "^": [1], "$": [2], "c": [16], "ç": [40] };
  const config = { piper_version: "1.0.0", phoneme_type: "espeak", phoneme_id_map: map };
  assert.deepEqual(symbolsToIds(["ç"], voiceIdMap(config)), [1, 0, 16, 0, 2]);
});
