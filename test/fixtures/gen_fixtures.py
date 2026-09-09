"""Generate numerical parity fixtures from the audiosronnx Python DSP.

Run inside the shared ovos venv (scipy+numpy). Writes JSON the JS test suite
asserts against, so the JS DSP ports are checked against real Python ground truth.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, "/home/miro/AgentWorkspaces/ml/audiosronnx")

from audiosronnx._kaiser import kaiser_resample
from audiosronnx._stft import stft as torch_stft, istft as torch_istft
from audiosronnx.audio import resample as poly_resample
from audiosronnx.engines import lavasr as L

OUT = os.path.join(os.path.dirname(__file__), "dsp_fixtures.json")

rng = np.random.default_rng(1234)


def sig(n, seed=0):
    r = np.random.default_rng(seed)
    t = np.arange(n) / 16000.0
    return (0.6 * np.sin(2 * np.pi * 440 * t)
            + 0.3 * np.sin(2 * np.pi * 1234 * t)
            + 0.05 * r.standard_normal(n)).astype(np.float32)


fx = {}

# ---- kaiser_resample (torchaudio faithful; used by hifiganbwe / apbwe) ----
x = sig(400, 1)
fx["kaiser_8k_48k"] = {
    "in": x.tolist(), "in_sr": 8000, "out_sr": 48000,
    "out": kaiser_resample(x, 8000, 48000).tolist(),
}
x2 = sig(500, 2)
fx["kaiser_16k_12k"] = {
    "in": x2.tolist(), "in_sr": 16000, "out_sr": 12000,
    "out": kaiser_resample(x2, 16000, 12000).tolist(),
}

# ---- polyphase resample (scipy resample_poly; used by lavasr / novasr) ----
x3 = sig(600, 3)
fx["poly_16k_44100"] = {
    "in": x3.tolist(), "in_sr": 16000, "out_sr": 44100,
    "out": poly_resample(x3, 16000, 44100).tolist(),
}
x4 = sig(700, 4)
fx["poly_22050_16k"] = {
    "in": x4.tolist(), "in_sr": 22050, "out_sr": 16000,
    "out": poly_resample(x4, 22050, 16000).tolist(),
}
x4b = sig(400, 14)
fx["poly_44100_48k"] = {
    "in": x4b.tolist(), "in_sr": 44100, "out_sr": 48000,
    "out": poly_resample(x4b, 44100, 48000).tolist(),
}

# ---- torch-faithful STFT / ISTFT (used by apbwe) ----
x5 = sig(2048, 5)
sp = torch_stft(x5, 1024, 80, 320)
fx["torch_stft_1024_80_320"] = {
    "in": x5.tolist(), "n_fft": 1024, "hop": 80, "win": 320,
    "re": np.real(sp).astype(np.float64).ravel().tolist(),
    "im": np.imag(sp).astype(np.float64).ravel().tolist(),
    "shape": list(sp.shape),
}
inv = torch_istft(sp, 1024, 80, 320, length=len(x5))
fx["torch_istft_1024_80_320"] = {"out": inv.tolist()}

# ---- lavasr host DSP: scipy STFT/ISTFT, mel filterbank, spectral merge ----
x6 = sig(4096, 6)
sp6 = L._stft(x6, L._ENH_SR, L._ENH_NFFT, L._ENH_HOP)
fx["lava_stft_2048_512"] = {
    "in": x6.tolist(), "sr": L._ENH_SR, "n_fft": L._ENH_NFFT, "hop": L._ENH_HOP,
    "re": np.real(sp6).astype(np.float64).ravel().tolist(),
    "im": np.imag(sp6).astype(np.float64).ravel().tolist(),
    "shape": list(sp6.shape),
}
inv6 = L._istft(sp6, L._ENH_SR, L._ENH_NFFT, L._ENH_HOP, target_len=len(x6))
fx["lava_istft_2048_512"] = {"out": inv6.tolist()}

mel_fb = L._build_mel_filterbank(L._ENH_SR, L._ENH_NFFT, L._ENH_MELS, 0.0, 8000.0)
fx["mel_fb"] = {
    "sr": L._ENH_SR, "n_fft": L._ENH_NFFT, "n_mels": L._ENH_MELS,
    "fmin": 0.0, "fmax": 8000.0,
    "shape": list(mel_fb.shape),
    "fb": mel_fb.astype(np.float64).ravel().tolist(),
}

orig = sig(3000, 7)
enh = sig(3000, 8) * 0.5
merged = L._spectral_merge(orig, enh, L._ENH_SR, 8000.0, 1024)
fx["spectral_merge"] = {
    "orig": orig.tolist(), "enh": enh.tolist(),
    "sr": L._ENH_SR, "cutoff": 8000.0, "transition": 1024,
    "out": merged.tolist(),
}

# End-to-end mel front-end (STFT -> |.| -> mel -> log), the enhancer input path.
mag = np.abs(sp6).astype(np.float32)
mel = np.matmul(mel_fb, mag)
mel = np.log(np.maximum(mel, 1e-5)).astype(np.float32)
fx["lava_mel_frontend"] = {
    "shape": list(mel.shape),
    "out": mel.astype(np.float64).ravel().tolist(),
}

with open(OUT, "w") as f:
    json.dump(fx, f)
print("wrote", OUT, "keys:", list(fx))
