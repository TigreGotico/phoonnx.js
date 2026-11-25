"""Text to token ids through the phoonnx front end, for phoonnx.js.

phoonnx.js runs this module in Pyodide. The ONNX graph runs in
onnxruntime-web, so this module never opens one. It maps each URL of a voice
index entry to the file phoonnx.js already downloaded, loads the voice with
``TTSModelInfo.load`` as Python phoonnx does, and reads the token ids of each
sentence from ``TTSVoice.prepare``, the text step of ``TTSVoice.synthesize``.

Packages that phoonnx needs only to download files or to open a graph are
replaced by empty modules when they are not installed. No front-end code path
calls them.
"""
import sys
import types
from pathlib import Path


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

_hub_constants = sys.modules["huggingface_hub.constants"]
if isinstance(_hub_constants, _StubModule):
    # phoonnx builds paths from HF_HUB_CACHE and tests HF_HUB_OFFLINE when it loads a voice.
    _hub_constants.HF_HUB_CACHE = "/phoonnx-js/hf-cache"
    _hub_constants.HF_HUB_OFFLINE = True

_hub_errors = sys.modules["huggingface_hub.errors"]
if isinstance(_hub_errors, _StubModule):
    # phoonnx names these classes in an except clause, which needs real exceptions.
    for _name in ("EntryNotFoundError", "LocalEntryNotFoundError", "OfflineModeIsEnabled"):
        setattr(_hub_errors, _name, type(_name, (Exception,), {}))

from phoonnx import model_manager  # noqa: E402
from phoonnx.runtime import Runtime  # noqa: E402

# phoonnx.js runs the graphs in onnxruntime-web, so this module opens none.
_GRAPH = Path("/phoonnx-js/model.onnx")
_files: dict = {}
_voices: dict = {}


def _fetch(url: str) -> Path:
    """The file phoonnx.js downloaded for ``url``. A graph needs no file here."""
    if url in _files:
        return Path(_files[url])
    if url.split("?")[0].endswith(".onnx"):
        return _GRAPH
    raise FileNotFoundError(f"phoonnx.js did not provide {url}")


_RUNTIME = Runtime(fetch=_fetch, open_session=lambda *args, **kwargs: None)


def load_voice(key: str, entry: dict, files: dict) -> dict:
    """Load the voice ``entry`` (one voice index record) under ``key``.

    ``files`` maps each URL of the entry to the path of its file in the
    Pyodide file system. The model URL needs no file.
    """
    _files.update(files)
    info = model_manager.TTSModelInfo(**entry)
    voice = info.load(runtime=_RUNTIME)
    _voices[key] = voice
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
    return [[int(i) for i in utterance.ids] for utterance in _voices[key].prepare(text)]
