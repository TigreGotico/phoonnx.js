"""Text to token ids through the phoonnx front end, for phoonnx.js.

phoonnx.js runs this module in Pyodide. The ONNX graph runs in
onnxruntime-web, so this module never opens one. It maps each URL of a voice
index entry to the file phoonnx.js already downloaded, loads the voice with
``TTSModelInfo.load`` as Python phoonnx does, and records the token ids that
``TTSVoice.synthesize`` hands to the model, one list per sentence.

Packages that phoonnx needs only to download files or to open a graph are
replaced by empty modules when they are not installed. No front-end code path
calls them.
"""
import sys
import types
from pathlib import Path

import numpy as np


class _Placeholder:
    """Stands in for any class of a package that is not installed."""

    def __init__(self, *args, **kwargs):
        raise RuntimeError("phoonnx.js front end: this call needs a package it does not load")


class _StubModule(types.ModuleType):
    """A module whose every attribute is a placeholder class or submodule."""

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        value = type(name, (_Placeholder,), {})
        setattr(self, name, value)
        return value


def _stub(*names: str) -> None:
    for name in names:
        try:
            __import__(name)
        except ImportError:
            parts = name.split(".")
            for i in range(1, len(parts) + 1):
                sub = ".".join(parts[:i])
                if sub not in sys.modules:
                    sys.modules[sub] = _StubModule(sub)
                if i > 1:
                    setattr(sys.modules[".".join(parts[:i - 1])], parts[i - 1], sys.modules[sub])


_stub("onnxruntime", "requests", "huggingface_hub.constants", "huggingface_hub.errors",
      "json_database")

from phoonnx import model_manager, voice as voice_module  # noqa: E402
from phoonnx.engines import get_adapter  # noqa: E402

_GRAPH = Path("/phoonnx-js/model.onnx")
_files: dict = {}
_voices: dict = {}


def _resolve(url: str, timeout: int = 120) -> Path:
    try:
        return Path(_files[url])
    except KeyError:
        raise FileNotFoundError(f"phoonnx.js did not provide {url}") from None


def _no_session(*args, **kwargs):
    return None


def _vits_adapter(*args, **kwargs):
    # phoonnx.js runs single-graph VITS models only; the adapter builds no
    # token ids, so its choice does not change them.
    return get_adapter("vits")


model_manager._resolve = _resolve
model_manager.TTSModelInfo._fetch_onnx = lambda self, url: _GRAPH
model_manager.make_session = _no_session
voice_module.make_session = _no_session
voice_module.detect_engine = _vits_adapter


def load_voice(key: str, entry: dict, files: dict) -> dict:
    """Load the voice ``entry`` (one voice index record) under ``key``.

    ``files`` maps each URL of the entry to the path of its file in the
    Pyodide file system. The model URL needs no file.
    """
    _files.update(files)
    info = model_manager.TTSModelInfo(**entry)
    voice = info.load()
    captured: list = []  # the token ids of each sentence, in synthesis order

    def phoneme_ids_to_audio(phoneme_ids, syn_config=None, include_alignments=False):
        captured.append([int(i) for i in phoneme_ids])
        audio = np.zeros(1, dtype=np.float32)
        return (audio, None) if include_alignments else audio

    voice.phoneme_ids_to_audio = phoneme_ids_to_audio
    _voices[key] = (voice, captured)
    config = voice.config
    return {
        "sample_rate": config.sample_rate,
        "noise_scale": config.noise_scale,
        "length_scale": config.length_scale,
        "noise_w_scale": config.noise_w_scale,
        "num_speakers": config.num_speakers,
        "phoneme_type": config.phoneme_type.value,
        "lang_code": config.lang_code,
    }


def text_to_ids(key: str, text: str) -> list:
    """The token ids of each sentence of ``text``, as phoonnx feeds them."""
    voice, captured = _voices[key]
    captured.clear()
    for _ in voice.synthesize(text):
        pass
    return [list(ids) for ids in captured]
