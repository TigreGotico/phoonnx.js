"""Reference token ids from Python phoonnx, with the real ONNX model.

For each case of cases.json, load the voice from phoonnx's bundled voice
index, synthesize the text, and record each sentence's phoneme_ids, the
sample count, the peak and the package versions.

    python reference_ids.py cases.json reference.json [type ...]
"""
import json
import sys
import time
from importlib.metadata import PackageNotFoundError, version

import numpy as np
from phoonnx.model_manager import TTSModelManager


# The packages phoonnx.js installs for every voice (BASE_PACKAGES in src/pyodide.ts).
BASE = ["phoonnx", "scriptconv", "quebra-frases", "linguatag", "langcodes",
        "ovos-number-parser", "unicode-rbnf", "ovos-date-parser", "chronologia",
        "ovos-spec-tools", "ovos-utils", "dateparser", "tzlocal"]


def versions(names):
    out = {}
    for name in names:
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = None
    return out


cases = json.load(open(sys.argv[1]))
only = set(sys.argv[3:])
manager = TTSModelManager()
manager.merge_default_voices()
out = {}
for case in cases:
    if only and case["type"] not in only:
        continue
    key = case["voice_id"]
    try:
        t0 = time.time()
        voice = manager.get_voice(key).load()
        chunks = list(voice.synthesize(case["text"]))
        audio = np.concatenate([c.audio_float_array for c in chunks])
        out[key] = {"type": case["type"], "text": case["text"],
                    "ids": [list(map(int, c.phoneme_ids)) for c in chunks],
                    "phonemes": ["".join(c.phonemes) for c in chunks],
                    "samples": int(audio.size), "peak": float(np.abs(audio).max()),
                    "seconds": round(time.time() - t0, 2),
                    "versions": versions([*BASE, *case.get("versionsOf", [])])}
    except Exception as e:
        out[key] = {"type": case["type"], "error": f"{type(e).__name__}: {e}"}
    print(key, out[key].get("error") or out[key]["phonemes"], flush=True)
json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
