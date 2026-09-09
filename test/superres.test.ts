/**
 * Tests for the super-resolution wiring: config gating, engine metadata, and
 * graceful degradation. The full ONNX end-to-end (actually downloading and
 * running the audiosronnx graphs) needs onnxruntime-web with real model weights
 * and is gated behind PHOONNX_SR_E2E=1, exactly like the Python side gates its
 * ONNX e2e — CI runs the DSP parity + these wiring tests, not the model download.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadSuperResolution,
  availableSuperResolutionEngines,
  SuperResolution,
} from "../src/superres.ts";

test("loadSuperResolution returns null when disabled or unset", () => {
  assert.equal(loadSuperResolution(undefined), null);
  assert.equal(loadSuperResolution({}), null);
  assert.equal(loadSuperResolution({ enabled: false }), null);
});

test("loadSuperResolution builds an engine when enabled (default lavasr)", () => {
  const sr = loadSuperResolution({ enabled: true });
  assert.ok(sr instanceof SuperResolution);
  assert.equal(sr!.engine, "lavasr");
});

test("loadSuperResolution honours the requested engine alias", () => {
  for (const engine of ["novasr", "hifiganbwe", "apbwe", "lavasr"] as const) {
    const sr = loadSuperResolution({ enabled: true, engine });
    assert.equal(sr!.engine, engine);
  }
});

test("loadSuperResolution warns and returns null for an unknown engine", () => {
  const warnings: string[] = [];
  const sr = loadSuperResolution({
    enabled: true,
    // deliberately bogus alias
    engine: "does-not-exist" as never,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(sr, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown super-resolution engine/);
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
    assert.match(e.repo, /^TigreGotico\/audiosronnx-/);
    assert.equal(typeof e.approxMB, "number");
    assert.ok(e.description.length > 0);
    assert.equal(e.revision.length, 40); // pinned git sha
  }
  // sanity: relative sizes (novasr lightest, apbwe heaviest)
  assert.ok(byName.novasr.approxMB < byName.hifiganbwe.approxMB);
  assert.ok(byName.lavasr.approxMB < byName.apbwe.approxMB);
});

test("upscale on empty input short-circuits to 48 kHz without loading a model", async () => {
  const sr = loadSuperResolution({ enabled: true, engine: "novasr" })!;
  const out = await sr.upscale(new Float32Array(0), 22050);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.samples.length, 0);
});
