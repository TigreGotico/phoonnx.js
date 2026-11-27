/**
 * Tests for the super-resolution loader: engine names, engine metadata and the
 * empty-input path. They download no model. test/synthesize.test.ts covers the
 * stage inside synthesize().
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadSuperResolution,
  availableSuperResolutionEngines,
  SuperResolution,
} from "../src/superres.ts";

test("loadSuperResolution defaults to novasr, as Python phoonnx does", () => {
  const sr = loadSuperResolution();
  assert.ok(sr instanceof SuperResolution);
  assert.equal(sr!.engine, "novasr");
});

test("loadSuperResolution honours the requested engine alias", () => {
  for (const engine of ["novasr", "hifiganbwe", "apbwe", "lavasr"] as const) {
    const sr = loadSuperResolution(engine);
    assert.equal(sr!.engine, engine);
  }
});

test("loadSuperResolution warns and returns null for an unknown engine", () => {
  for (const engine of ["does-not-exist", "toString", "constructor", "__proto__"]) {
    const warnings: string[] = [];
    const sr = loadSuperResolution(engine, { logger: { warn: (m) => warnings.push(m) } });
    assert.equal(sr, null, engine);
    assert.equal(warnings.length, 1, engine);
    assert.match(warnings[0], /unknown super-resolution engine/);
  }
});

test("availableSuperResolutionEngines exposes all four engines with metadata", () => {
  const engines = availableSuperResolutionEngines();
  const byName = Object.fromEntries(engines.map((e) => [e.engine, e]));
  assert.deepEqual(
    engines.map((e) => e.engine).sort(),
    ["apbwe", "hifiganbwe", "lavasr", "novasr"],
  );
  // every engine outputs 48 kHz and names its HF repo + approx size
  for (const e of engines) {
    assert.match(e.repo, /^AudioSRonnx\//);
    assert.equal(typeof e.approxMB, "number");
    assert.ok(e.description.length > 0);
    assert.equal(e.revision.length, 40); // pinned git sha
  }
  // sanity: relative sizes (novasr lightest, apbwe heaviest)
  assert.ok(byName.novasr.approxMB < byName.hifiganbwe.approxMB);
  assert.ok(byName.lavasr.approxMB < byName.apbwe.approxMB);
});

test("upscale on empty input short-circuits to 48 kHz without loading a model", async () => {
  const sr = loadSuperResolution("novasr")!;
  const out = await sr.upscale(new Float32Array(0), 22050);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.samples.length, 0);
});
