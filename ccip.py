# Character likeness: how alike the anime character in two pictures is, with CCIP (deepghs, model card: openrail).
# Ported from imgutils.metrics.ccip (MIT) without the imgutils package itself: it needs numpy < 2 and ComfyUI uses numpy 2.
# Made for one character per picture. Runs on the processor with onnxruntime (~0.3 s per new picture); the model is
# loaded for each request and freed afterwards, so it never holds RAM while Kōbō draws.
import json
import os
import threading
from collections import OrderedDict

import numpy as np
import onnxruntime
from PIL import Image

import folder_paths

MODEL = "ccip-caformer-24-randaug-pruned"
MODEL_DIR = os.path.join(folder_paths.models_dir, "ccip", MODEL)
FILES = ("model_feat.onnx", "model_metrics.onnx", "metrics.json")
SIZE = 384
_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)[:, None, None]
_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)[:, None, None]
_MAX_CACHED = 4000   # features (768 floats each) of pictures already looked at, by path + modification time
_cache = OrderedDict()
_lock = threading.Lock()


def ready():
    return all(os.path.isfile(os.path.join(MODEL_DIR, f)) for f in FILES)


def threshold():
    """Differences at or below this mean "the same character" (the model's own best-F1 value)."""
    with open(os.path.join(MODEL_DIR, "metrics.json"), encoding="utf-8") as f:
        return float(json.load(f)["threshold"])


def _pixels(path):
    with Image.open(path) as im:
        im = im.convert("RGBA")
        flat = Image.new("RGBA", im.size, (255, 255, 255, 255))   # transparent cut-outs on white, like imgutils
        flat.alpha_composite(im)
        data = np.asarray(flat.convert("RGB").resize((SIZE, SIZE), Image.BILINEAR), np.float32) / 255.0
    return (data.transpose(2, 0, 1) - _MEAN) / _STD


def _session(name):
    return onnxruntime.InferenceSession(os.path.join(MODEL_DIR, name), providers=["CPUExecutionProvider"])


def _features(paths):
    """Feature of each picture, or None for one that can't be read."""
    keys = [(p, os.path.getmtime(p)) for p in paths]
    with _lock:
        todo = []
        for k in dict.fromkeys(keys):
            if k in _cache:
                continue
            try:
                todo.append((k, _pixels(k[0])))
            except OSError:   # broken or not really a picture: left out, not the whole request
                pass
        if todo:
            feat = _session("model_feat.onnx")
            for i in range(0, len(todo), 8):
                part = todo[i:i + 8]
                out, = feat.run(["output"], {"input": np.stack([px for _, px in part]).astype(np.float32)})
                for (k, _), f in zip(part, out):
                    _cache[k] = f
            while len(_cache) > _MAX_CACHED:
                _cache.popitem(last=False)
        for k in keys:
            if k in _cache:
                _cache.move_to_end(k)
        return [_cache.get(k) for k in keys]


def differences(ref, paths):
    """CCIP difference of each picture's character to the reference picture's (lower = more alike); None for a picture
    that can't be read. Raises OSError when the reference itself can't be read."""
    feats = _features([ref] + list(paths))
    if feats[0] is None:
        raise OSError("The reference picture can't be read")
    good = [i for i, f in enumerate(feats) if f is not None]
    out, = _session("model_metrics.onnx").run(["output"], {"input": np.stack([feats[i] for i in good]).astype(np.float32)})
    row = dict(zip(good, out[0]))
    return [float(row[i]) if i in row else None for i in range(1, len(feats))]
