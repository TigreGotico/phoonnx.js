/**
 * Tests for the super-resolution stage of synthesize().
 *
 * A stub voice session returns fixed audio for each sentence, and a stub
 * `novasr` session replaces the real model, so no download is needed. The
 * stub upscaler repeats each sample three times (16 kHz in, 48 kHz out). The
 * expected values are the stub audio scaled to a peak of 1 by hand.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as ort from "onnxruntime-web";

import { synthesize } from "../src/voice.ts";
import type { LoadedVoice, VoiceConfig, VoiceEntry } from "../src/types.ts";

// Raw model output for each sentence, keyed by the first token id.
const RAW: Record<number, number[]> = {
  1: [0.1, -0.5, 0.25, 0.2],
  5: [0.3, 0.6, -0.15, 0],
};
// The same audio scaled to a peak of 1 (peaks 0.5 and 0.6).
const NORMALIZED = [
  Float32Array.from([0.2, -1, 0.5, 0.4]),
  Float32Array.from([0.5, 1, -0.25, 0]),
];
const TWO_SENTENCES = () => [[1, 2, 3, 4], [5, 6, 7, 8]];

function stubVoice(): LoadedVoice {
  const session = {
    inputNames: ["input", "input_lengths", "scales"],
    outputNames: ["output"],
    async run(feeds: Record<string, ort.Tensor>) {
      const first = Number((feeds.input.data as BigInt64Array)[0]);
      const audio = Float32Array.from(RAW[first]);
      return { output: new ort.Tensor("float32", audio, [1, 1, audio.length]) };
    },
  };
  return {
    entry: { id: "stub", phonemeType: "unicode", sampleRate: 16000 } as VoiceEntry,
    session: session as unknown as ort.InferenceSession,
    config: { phoneme_id_map: {} } as VoiceConfig,
    idMap: {},
    sampleRate: 16000,
    provider: "wasm",
    normalizeAudio: true,
    tokenize: TWO_SENTENCES,
  };
}

/** Stub the model download and session creation. Records every SR input. */
function stubSuperResolution(t: TestContext, failOnRun?: number) {
  const inputs: Float32Array[] = [];
  const srSession = {
    inputNames: ["audio"],
    outputNames: ["out"],
    async run(feeds: Record<string, ort.Tensor>) {
      const x = Float32Array.from(feeds.audio.data as Float32Array);
      inputs.push(x);
      if (inputs.length === failOnRun) throw new Error("stub failure");
      const y = new Float32Array(x.length * 3);
      x.forEach((v, i) => y.fill(v, 3 * i, 3 * i + 3));
      return { out: new ort.Tensor("float32", y, [1, 1, y.length]) };
    },
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(8)));
  const create = t.mock.method(
    ort.InferenceSession,
    "create",
    async () => srSession as unknown as ort.InferenceSession,
  );
  return { inputs, fetch, create };
}

function upscaledByStub(chunks: Float32Array[]): Float32Array {
  const out: number[] = [];
  for (const c of chunks) for (const v of c) out.push(v, v, v);
  return Float32Array.from(out);
}

function bytes(a: Float32Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

test("super-resolution off: no engine loads and the audio is byte-identical", async (t) => {
  const { fetch, create } = stubSuperResolution(t);
  const voice = stubVoice();
  const expected = Float32Array.from([...NORMALIZED[0], ...NORMALIZED[1]]);

  const plain = await synthesize(voice, "two sentences");
  const off = await synthesize(voice, "two sentences", { superResolution: false });
  const modelOnly = await synthesize(voice, "two sentences", { superResolutionModel: "lavasr" });

  for (const result of [plain, off, modelOnly]) {
    assert.equal(result.sampleRate, 16000);
    assert.deepEqual(bytes(result.samples), bytes(expected));
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
});

test("super-resolution on: one engine call per sentence, on the normalized audio", async (t) => {
  const { inputs } = stubSuperResolution(t);
  const voice = stubVoice();

  const result = await synthesize(voice, "two sentences", { superResolution: true });

  assert.equal(inputs.length, 2);
  assert.deepEqual(bytes(inputs[0]), bytes(NORMALIZED[0]));
  assert.deepEqual(bytes(inputs[1]), bytes(NORMALIZED[1]));
  assert.equal(result.sampleRate, 48000);
  assert.deepEqual(bytes(result.samples), bytes(upscaledByStub(NORMALIZED)));
});

test("super-resolution engine loads once per voice over several calls", async (t) => {
  const { inputs, fetch, create } = stubSuperResolution(t);
  const voice = stubVoice();

  for (let i = 0; i < 3; i++) {
    const result = await synthesize(voice, "two sentences", { superResolution: true });
    assert.equal(result.sampleRate, 48000);
  }

  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(inputs.length, 6);
  const url = String(fetch.mock.calls[0].arguments[0]);
  assert.match(url, /TigreGotico\/audiosronnx-novasr\/resolve\/[0-9a-f]{40}\/novasr\.onnx$/);
});

test("super-resolution failure on one sentence gives native audio for the whole text", async (t) => {
  stubSuperResolution(t, 2);
  const voice = stubVoice();
  const warnings: string[] = [];

  const result = await synthesize(voice, "two sentences", {
    superResolution: true,
    superResolutionOptions: { logger: { warn: (m) => warnings.push(m) } },
  });

  assert.equal(result.sampleRate, 16000);
  assert.deepEqual(
    bytes(result.samples),
    bytes(Float32Array.from([...NORMALIZED[0], ...NORMALIZED[1]])),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /super-resolution \(novasr\) failed/);
});

test("unknown super-resolution engine warns and gives native audio", async (t) => {
  for (const name of ["toString", "constructor", "does-not-exist"]) {
    const { fetch, create } = stubSuperResolution(t);
    const warnings: string[] = [];

    const result = await synthesize(stubVoice(), "two sentences", {
      superResolution: true,
      superResolutionModel: name as never,
      superResolutionOptions: { logger: { warn: (m) => warnings.push(m) } },
    });

    assert.equal(result.sampleRate, 16000, name);
    assert.equal(warnings.length, 1, name);
    assert.match(warnings[0], new RegExp(`unknown super-resolution engine "${name}"`));
    assert.equal(fetch.mock.callCount(), 0, name);
    assert.equal(create.mock.callCount(), 0, name);
    t.mock.restoreAll();
  }
});
