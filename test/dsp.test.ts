/**
 * Numerical parity tests for the DSP ports in src/dsp.ts.
 *
 * The fixtures in test/fixtures/dsp_fixtures.json are generated from the Python
 * `audiosronnx` reference DSP (see test/fixtures/gen_fixtures.py, run in a venv
 * with numpy+scipy). Each test asserts the JS port matches Python ground truth,
 * so the ports are verified independently of any ONNX runtime or browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  rfft, irfft, kaiserResample, resample, torchStft, torchIstft,
  scipyStft, scipyIstft, buildMelFilterbank, spectralMerge, i0,
} from "../src/dsp.ts";

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/dsp_fixtures.json", import.meta.url)), "utf-8"),
);

const f64 = (a: number[]) => Float64Array.from(a);

function maxAbsErr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length, `length ${a.length} != ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test("i0 matches numpy reference points", () => {
  // numpy.i0 values
  assert.ok(Math.abs(i0(0) - 1) < 1e-12);
  assert.ok(Math.abs(i0(1) - 1.2660658777520082) < 1e-10);
  assert.ok(Math.abs(i0(5) - 27.239871823604442) < 1e-6);
});

test("rfft/irfft round-trip (power-of-two and arbitrary N)", () => {
  for (const n of [64, 100, 313, 1024]) {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.7);
    const s = rfft(x);
    const y = irfft(s.re, s.im, n);
    assert.ok(maxAbsErr(x, y) < 1e-9, `round-trip N=${n}`);
  }
});

test("kaiserResample matches torchaudio (8k -> 48k)", () => {
  const d = fx.kaiser_8k_48k;
  const out = kaiserResample(f64(d.in), d.in_sr, d.out_sr);
  assert.ok(maxAbsErr(out, d.out) < 1e-4, `err=${maxAbsErr(out, d.out)}`);
});

test("kaiserResample matches torchaudio (16k -> 12k, downsample)", () => {
  const d = fx.kaiser_16k_12k;
  const out = kaiserResample(f64(d.in), d.in_sr, d.out_sr);
  assert.ok(maxAbsErr(out, d.out) < 1e-4, `err=${maxAbsErr(out, d.out)}`);
});

test("resample (poly) matches scipy resample_poly", () => {
  for (const key of ["poly_16k_44100", "poly_22050_16k", "poly_44100_48k"]) {
    const d = fx[key];
    const out = resample(f64(d.in), d.in_sr, d.out_sr);
    const err = maxAbsErr(out, d.out);
    assert.ok(err < 1e-4, `${key} err=${err}`);
  }
});

test("torchStft matches torch.stft (1024/80/320)", () => {
  const d = fx.torch_stft_1024_80_320;
  const s = torchStft(f64(d.in), d.n_fft, d.hop, d.win);
  assert.deepEqual([s.nFreq, s.nFrames], d.shape);
  assert.ok(maxAbsErr(s.re, d.re) < 1e-3, `re err=${maxAbsErr(s.re, d.re)}`);
  assert.ok(maxAbsErr(s.im, d.im) < 1e-3, `im err=${maxAbsErr(s.im, d.im)}`);
});

test("torchIstft matches torch.istft (1024/80/320)", () => {
  const d = fx.torch_stft_1024_80_320;
  const inv = fx.torch_istft_1024_80_320;
  const s = torchStft(f64(d.in), d.n_fft, d.hop, d.win);
  const y = torchIstft(s, d.n_fft, d.hop, d.win, true, d.in.length);
  assert.ok(maxAbsErr(y, inv.out) < 1e-4, `err=${maxAbsErr(y, inv.out)}`);
});

test("scipyStft matches scipy.signal.stft (LavaSR front-end 2048/512)", () => {
  const d = fx.lava_stft_2048_512;
  const s = scipyStft(f64(d.in), d.n_fft, d.hop);
  assert.deepEqual([s.nFreq, s.nFrames], d.shape);
  assert.ok(maxAbsErr(s.re, d.re) < 1e-5, `re err=${maxAbsErr(s.re, d.re)}`);
  assert.ok(maxAbsErr(s.im, d.im) < 1e-5, `im err=${maxAbsErr(s.im, d.im)}`);
});

test("scipyIstft matches scipy.signal.istft (LavaSR back-end 2048/512)", () => {
  const d = fx.lava_stft_2048_512;
  const inv = fx.lava_istft_2048_512;
  const s = scipyStft(f64(d.in), d.n_fft, d.hop);
  const y = scipyIstft(s, d.n_fft, d.hop);
  // Python trims/pads to target_len afterwards; compare the overlap.
  const n = Math.min(y.length, inv.out.length);
  assert.ok(maxAbsErr(y.slice(0, n), inv.out.slice(0, n)) < 1e-4,
    `err=${maxAbsErr(y.slice(0, n), inv.out.slice(0, n))}`);
});

test("buildMelFilterbank matches LavaSR Slaney filterbank", () => {
  const d = fx.mel_fb;
  const fb = buildMelFilterbank(d.sr, d.n_fft, d.n_mels, d.fmin, d.fmax);
  assert.equal(fb.length, d.shape[0] * d.shape[1]);
  assert.ok(maxAbsErr(fb, d.fb) < 1e-6, `err=${maxAbsErr(fb, d.fb)}`);
});

test("LavaSR mel front-end (STFT -> |.| -> mel -> log) matches Python", () => {
  const d = fx.lava_stft_2048_512;
  const mf = fx.mel_fb;
  const target = fx.lava_mel_frontend;
  const s = scipyStft(f64(d.in), d.n_fft, d.hop);
  const fb = buildMelFilterbank(mf.sr, mf.n_fft, mf.n_mels, mf.fmin, mf.fmax);
  const [nMels, nFreq] = mf.shape;
  const nFrames = s.nFrames;
  const mag = new Float64Array(nFreq * nFrames);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(s.re[i], s.im[i]);
  const out = new Float64Array(nMels * nFrames);
  for (let m = 0; m < nMels; m++) {
    for (let t = 0; t < nFrames; t++) {
      let acc = 0;
      for (let k = 0; k < nFreq; k++) acc += fb[m * nFreq + k] * mag[k * nFrames + t];
      out[m * nFrames + t] = Math.log(Math.max(acc, 1e-5));
    }
  }
  assert.deepEqual([nMels, nFrames], target.shape);
  assert.ok(maxAbsErr(out, target.out) < 1e-3, `err=${maxAbsErr(out, target.out)}`);
});

test("spectralMerge matches LavaSR _spectral_merge", () => {
  const d = fx.spectral_merge;
  const out = spectralMerge(f64(d.orig), f64(d.enh), d.sr, d.cutoff, d.transition);
  assert.ok(maxAbsErr(out, d.out) < 1e-4, `err=${maxAbsErr(out, d.out)}`);
});
