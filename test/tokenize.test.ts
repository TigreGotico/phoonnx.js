import { test } from "node:test";
import assert from "node:assert/strict";

import { flattenIdMap, symbolsToIds } from "../src/tokenize.ts";

// A native phoonnx config gives a precomposed symbol the ids of its parts.
// The expected ids are Python phoonnx's TTSTokenizer.tokenize("ɪç") for this map.
const config = { "_": 0, "^": 1, "$": 2, " ": 3, "ɪ": 74, "ç": [16, 140], "c": 16, "̧": 140 };

test("a symbol listed with several ids reads as all of them", () => {
  assert.deepEqual(symbolsToIds(["ɪ", "ç"], flattenIdMap(config)), [1, 0, 74, 0, 16, 0, 140, 0, 2]);
});

test("a list of one id reads as that id", () => {
  assert.deepEqual(flattenIdMap({ "a": [14], "b": 15 }), { "a": 14, "b": 15 });
});
