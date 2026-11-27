# Image -> Danbooru tags with confidences, from up to three models working together:
#   - WD EVA02 2026 canary (CPU, timm): the classic tagger, fine-tuned on Danbooru up to May 2026.
#   - PixAI Tagger v1.0 (GPU, PyTorch, native 1008 px): newer, much better at characters.
#   - Haruka (CPU, onnxruntime, EVA02-B 448 px, 2026 Danbooru data, 98.8k tags): adds characters PixAI misses.
#   - JoyCaption Beta One (Ollama "joycaption-beta-one"): vision LLM that writes its own tag list;
#     it confirms borderline tags. Slower (~8 s), so only used when asked for.
# Results keep the old shape ({"ratings", "general", "character"}) with scores on WD's scale
# (0.35 = "at the model's recommended threshold"), so every caller's thresholds still mean the same.
import base64
import copy
import csv
import glob
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageOps

import folder_paths

MODEL_NAME = "wd-eva02-tagger-2026-canary"   # WD EVA02-L fine-tuned on Danbooru up to May 2026 (16.5k tags), timm weights
MODEL_DIR = os.path.join(folder_paths.models_dir, "wd_tagger", MODEL_NAME)
PIXAI_DIR = os.path.join(folder_paths.models_dir, "pixai_tagger", "pixai-tagger-v1.0")
PIXAI_ADDONS = os.path.join(folder_paths.models_dir, "pixai_tagger", "addons")
HARUKA_DIR = os.path.join(folder_paths.models_dir, "haruka_tagger")   # KaraKaraWitch/haruka-tagger
E621_DIR = os.path.join(folder_paths.models_dir, "e621_tagger", "z3d-e621-convnext")  # toynya/Z3D-E621-Convnext
CAMIE_DIR = os.path.join(folder_paths.models_dir, "camie_tagger")   # Camais03/camie-tagger-v2
JOYCAPTION_MODEL = "joycaption-beta-one"

# Default for training / prompt-writer tagging: PixAI + Haruka (cheap); JoyCaption only on request.
# Nov 2026, 160 Danbooru posts from after every model's cutoff (thresholds picked on one half, scored on the other):
#   WD+PixAI   general F1 0.689, character F1 0.691 (55% of characters found), 3.5 s/image
#   PixAI+Haruka 2:1  general 0.691, character 0.736 (62%; explicit pictures 0.620 -> 0.685), 1.2 s/image
DEFAULT_MODELS = ("pixai", "haruka")
# general: 0.45 gave v3-at-0.35's tag count on two pictures (0.40 added "meme", "1other"); character: guesses below 0.85 are mostly look-alikes
WD_THRESHOLDS = {0: 0.45, 4: 0.85}
# Combining, tuned on 120 recent Danbooru posts against their own tags (F1): PixAI 0.669
# (finds 54% of characters), WD 0.611 (27%), JoyCaption alone 0.41; adding WD or JoyCaption
# to PixAI doesn't raise accuracy, so the page defaults to PixAI and the others are optional.
W_WD, W_PIXAI = 1.0, 3.0  # weighted average of the two taggers
W_E621 = 1.0
W_HARUKA = 1.5            # PixAI:Haruka = 2:1 (best of the weight grid above)
HARUKA_THRESHOLDS = {"general": 0.35, "character": 0.35, "copyright": 0.35, "artist": 0.25}   # the model card's
HARUKA_ONLY = 0.6         # general tags only Haruka knows: scaled down (UI-default F1 0.651 -> 0.665 on the same set)
HARUKA_KEEP = 0.005       # raw probability below which a Haruka tag counts as 0 (keeps 98.8k-tag loops short)
# Camie v2: the model card's thresholds (macro-best 0.492 for general tags, micro-best 0.614 for names).
# shortcut: W_CAMIE is a guess, not tuned like PixAI:Haruka; Camie is opt-in (Advanced) until it is measured.
CAMIE_THRESHOLDS = {"general": 0.492, "character": 0.614, "copyright": 0.614, "artist": 0.614}
W_CAMIE = 1.5
# Z3D on 40 tagged Rule34 images: P 0.80 / R 0.42 at 0.3 (WD-style BGR 0-255 input; [-1,1] input gives garbage).
E621_THRESHOLD = 0.3
E621_KEEP = {0: "general", 5: "general"}   # general and species; e621 artist/character/series/meta guesses don't fit Anima
# Animal penis types: the taggers often guess two species for one big veiny penis (dog + horse).
# Only the strongest type is kept. shortcut: a picture really showing two species loses one; add a toggle if that comes up.
PENIS_TYPES = {
    "canine": {"dog penis", "knotted penis", "canine penis", "knot", "wolf penis"},
    "equine": {"horse penis", "equine penis", "flared penis", "medial ring", "equine"},   # "equine": e621's species guess
    "feline": {"cat penis", "feline penis", "barbed penis"},
    "porcine": {"pig penis", "corkscrew penis", "porcine penis"},
    "reptile": {"dragon penis", "reptile penis", "hemipenes"},
}
E621_AS_BLOCKED = {"young": "child", "cub": "child"}   # e621's words for minors, renamed so llm.BLOCKED_TAGS catches them
# e621 bookkeeping tags that are on nearly every post and mean nothing to Anima.
E621_SKIP = {"female", "male", "human", "mammal", "hair", "genitals", "bodily fluids", "genital fluids", "duo", "trio", "group", "solo",
             "clothing", "clothed", "topwear", "bottomwear", "headwear", "footwear", "legwear", "handwear", "accessory", "text",
             "outside", "inside", "detailed background", "simple background", "human focus", "not furry focus", "male/female",
             "5 fingers", "4 fingers", "fingers", "toes", "humanoid", "breasts", "butt", "nipples", "penis", "pussy"}
JC_BOOST = 0.1            # JoyCaption also wrote the tag: move it this far toward certain
JC_ONLY = 0.0             # tags only JoyCaption wrote (92% were wrong): not added, except safety tags
PIXAI_IDLE_SECONDS = 300  # free PixAI's ~1 GB of VRAM after this long unused
GIF_FRAMES = 4            # frames tagged from an animated image (first, last and two between)

# Tags that keep their underscores (from SmilingWolf's reference implementation).
KAOMOJIS = {
    "0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o",
    "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||",
}

_lock = threading.Lock()
_session = None
_tags = None

# The WD model (~1.3 GB) is downloaded from Hugging Face the first time someone tags an image.
REPO = "ashen-sensored/" + MODEL_NAME
_dl_lock = threading.Lock()
_dl_thread = None
_dl_error = None


def _space(name):
    return name if name in KAOMOJIS else name.replace("_", " ")


# WD, Haruka and e621 run on the CPU at the same time: each gets half the cores instead of all of them,
# so they stop fighting over threads.
ORT_THREADS = max(1, (os.cpu_count() or 4) // 2)


def _ort_session(path):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = ORT_THREADS
    opts.inter_op_num_threads = 1
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    # CPU on purpose: onnxruntime-directml was 7x faster standalone but crashed the ComfyUI server (access violation).
    return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])


def _model_ready():
    return all(os.path.exists(os.path.join(MODEL_DIR, f)) for f in ("model.safetensors", "selected_tags.csv"))


def _download():
    global _dl_error
    try:
        from huggingface_hub import hf_hub_download
        os.makedirs(MODEL_DIR, exist_ok=True)
        for f in ("selected_tags.csv", "model.safetensors"):
            hf_hub_download(REPO, f, local_dir=MODEL_DIR)
    except Exception as e:
        _dl_error = f"{type(e).__name__}: {e}"


def ensure_model():
    """None when the tagger is ready; otherwise starts the one-time download and returns a message."""
    global _dl_thread, _dl_error
    if _model_ready():
        return None
    with _dl_lock:
        if _dl_error:
            err, _dl_error, _dl_thread = _dl_error, None, None
            return f"Downloading the image tagger failed ({err}). Try again, or download {REPO} into {MODEL_DIR}."
        if _dl_thread is None or not _dl_thread.is_alive():
            _dl_thread = threading.Thread(target=_download, daemon=True)
            _dl_thread.start()
    return "Downloading the image tagger (about 1.2 GB, one time only). Try again in a few minutes."


def ensure_ready(models=None):
    """Like ensure_model(), but only waits for WD when this request will actually use it: WD was picked, or none of
    PixAI / Haruka / e621 is installed (the same fallback _tag_frame uses)."""
    wanted = list(models or DEFAULT_MODELS)
    others = any(m in wanted and ready() for m, ready in (("pixai", pixai_ready), ("haruka", haruka_ready), ("e621", e621_ready), ("camie", camie_ready)))
    return ensure_model() if "wd" in wanted or not others else None


def _load():
    global _session, _tags
    with _lock:
        if _session is None:
            import timm
            from safetensors.torch import load_file

            model_path = os.path.join(MODEL_DIR, "model.safetensors")
            csv_path = os.path.join(MODEL_DIR, "selected_tags.csv")
            if not (os.path.exists(model_path) and os.path.exists(csv_path)):
                raise FileNotFoundError(f"Tagger model not found in {MODEL_DIR}")
            with open(csv_path, newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            _tags = [(_space(r["name"]), int(r["category"])) for r in rows]
            model = timm.create_model("eva02_large_patch14_448", pretrained=False, num_classes=len(_tags))
            model.load_state_dict(load_file(model_path), strict=True)
            _session = model.eval()
    return _session, _tags


def _open_rgb(data):
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGBA")
    flat = Image.new("RGBA", img.size, (255, 255, 255, 255))
    flat.alpha_composite(img)
    return flat.convert("RGB")


def _prepare(data, size):
    img = _open_rgb(data)
    w, h = img.size
    side = max(w, h)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(img, ((side - w) // 2, (side - h) // 2))
    square = square.resize((size, size), Image.BICUBIC)
    arr = np.asarray(square, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR, 0-255, NHWC
    return np.ascontiguousarray(arr)[None]


def _calibrate(p, threshold):
    """Raw probability -> 0..1 where 0.5 is the model's own recommended threshold."""
    if p >= threshold:
        return 0.5 + 0.5 * (p - threshold) / max(1e-6, 1 - threshold)
    return 0.5 * p / threshold


def _wd_scale(s):
    """Calibrated score -> WD's raw scale (0.35 = threshold), which callers' thresholds expect."""
    return s * 0.7 if s < 0.5 else 0.35 + (s - 0.5) * 1.3


# ---------------------------------------------------------------- WD (CPU)

def _wd(data):
    """({tag: (calibrated, kind)}, ratings) from WD."""
    import torch

    model, tags = _load()
    # wdv3-timm's preprocessing: pad to a white square, 448 bicubic, BGR, mean/std 0.5, NCHW.
    x = torch.from_numpy(_prepare(data, 448)[0].copy()).permute(2, 0, 1)[None].div_(127.5).sub_(1)
    with torch.inference_mode():
        probs = torch.sigmoid(model(x))[0].tolist()
    out, ratings = {}, {}
    for (name, category), p in zip(tags, probs):
        if category == 9:
            ratings[name] = p
        elif category in WD_THRESHOLDS:
            out[name] = (_calibrate(p, WD_THRESHOLDS[category]), "character" if category == 4 else "general")
    return out, ratings


# ---------------------------------------------------------------- e621 (Z3D ConvNext, CPU, onnxruntime)

_e621_lock = threading.Lock()
_e621_session = None
_e621_tags = None


def e621_ready():
    return all(os.path.isfile(os.path.join(E621_DIR, f)) for f in ("model.onnx", "tags-selected.csv"))


def _e621(data):
    """({tag: (calibrated, kind)}, {}) from the e621 tagger (it has no rating outputs)."""
    global _e621_session, _e621_tags
    with _e621_lock:
        if _e621_session is None:
            with open(os.path.join(E621_DIR, "tags-selected.csv"), newline="", encoding="utf-8") as f:
                _e621_tags = [(E621_AS_BLOCKED.get(r["name"], _space(r["name"])), int(r["category"])) for r in csv.DictReader(f)]
            _e621_session = _ort_session(os.path.join(E621_DIR, "model.onnx"))
    inp = _e621_session.get_inputs()[0]
    probs = _e621_session.run(None, {inp.name: _prepare(data, int(inp.shape[1]))})[0][0]
    out = {}
    for (name, category), p in zip(_e621_tags, probs.tolist()):
        if category in E621_KEEP and name not in E621_SKIP:
            s = _calibrate(p, E621_THRESHOLD)
            if name not in out or s > out[name][0]:   # young and cub both become "child": keep the stronger
                out[name] = (s, E621_KEEP[category])
    return out, {}


# ---------------------------------------------------------------- Haruka (EVA02-B, CPU, onnxruntime)

_haruka_lock = threading.Lock()
_haruka_session = None
_haruka_tags = None   # [(name with spaces, category)]
HARUKA_RATINGS = {"rating_g": "general", "rating_s": "sensitive", "rating_q": "questionable", "rating_e": "explicit"}


def haruka_ready():
    return all(os.path.isfile(os.path.join(HARUKA_DIR, f)) for f in ("haruka-tagger.onnx", "haruka-tagger_metadata.json"))


def _haruka(data):
    """({tag: (calibrated, kind)}, ratings) from Haruka; tags it scores near 0 are left out (callers treat them as 0)."""
    global _haruka_session, _haruka_tags
    with _haruka_lock:
        if _haruka_session is None:
            with open(os.path.join(HARUKA_DIR, "haruka-tagger_metadata.json"), encoding="utf-8") as f:
                meta = json.load(f)
            cats = meta["tag_to_category"]
            names = [meta["idx_to_tag"][str(i)] for i in range(int(meta["total_tags"]))]
            _haruka_tags = [(n if n in HARUKA_RATINGS else _space(n), cats.get(n, "general")) for n in names]
            _haruka_session = _ort_session(os.path.join(HARUKA_DIR, "haruka-tagger.onnx"))
    # Letterbox on white to 448, ImageNet mean/std, RGB, NCHW (the model card's preprocessing).
    img = _open_rgb(data)
    w, h = img.size
    r = min(448 / w, 448 / h)
    nw, nh = max(1, int(w * r)), max(1, int(h * r))
    canvas = Image.new("RGB", (448, 448), (255, 255, 255))
    canvas.paste(img.resize((nw, nh), Image.BICUBIC), ((448 - nw) // 2, (448 - nh) // 2))
    x = (np.asarray(canvas, dtype=np.float32) / 255.0 - (0.485, 0.456, 0.406)) / (0.229, 0.224, 0.225)
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)
    logits = _haruka_session.run(None, {_haruka_session.get_inputs()[0].name: x})[0][0].astype(np.float64)
    probs = 1 / (1 + np.exp(-logits))
    out, ratings = {}, {}
    for i in np.nonzero(probs >= HARUKA_KEEP)[0].tolist():
        name, cat = _haruka_tags[i]
        if cat == "rating":
            ratings[HARUKA_RATINGS.get(name, name)] = float(probs[i])
        elif cat in HARUKA_THRESHOLDS:
            out[name] = (_calibrate(float(probs[i]), HARUKA_THRESHOLDS[cat]), cat)
    for name, label in HARUKA_RATINGS.items():
        ratings.setdefault(label, 0.0)
    return out, ratings


# ---------------------------------------------------------------- Camie v2 (CPU, onnxruntime, 512 px, 70.5k tags)

_camie_lock = threading.Lock()
_camie_session = None
_camie_tags = None   # [(name with spaces, category)]


def camie_ready():
    return all(os.path.isfile(os.path.join(CAMIE_DIR, f)) for f in ("camie-tagger-v2.onnx", "camie-tagger-v2-metadata.json"))


def _camie(data):
    """({tag: (calibrated, kind)}, ratings) from Camie's refined head; near-0 tags left out like Haruka's."""
    global _camie_session, _camie_tags
    with _camie_lock:
        if _camie_session is None:
            with open(os.path.join(CAMIE_DIR, "camie-tagger-v2-metadata.json"), encoding="utf-8") as f:
                mapping = json.load(f)["dataset_info"]["tag_mapping"]
            cats = mapping["tag_to_category"]
            names = [mapping["idx_to_tag"][str(i)] for i in range(len(mapping["idx_to_tag"]))]
            _camie_tags = [(_space(n), cats.get(n, "general")) for n in names]
            _camie_session = _ort_session(os.path.join(CAMIE_DIR, "camie-tagger-v2.onnx"))
    # Fit in 512 keeping the shape, pad with the ImageNet mean colour, ImageNet mean/std, RGB, NCHW (the model's onnx_inference.py).
    img = _open_rgb(data)
    w, h = img.size
    r = min(512 / w, 512 / h)
    nw, nh = max(1, int(w * r)), max(1, int(h * r))
    canvas = Image.new("RGB", (512, 512), (124, 116, 104))
    canvas.paste(img.resize((nw, nh), Image.LANCZOS), ((512 - nw) // 2, (512 - nh) // 2))
    x = (np.asarray(canvas, dtype=np.float32) / 255.0 - (0.485, 0.456, 0.406)) / (0.229, 0.224, 0.225)
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)
    logits = _camie_session.run(None, {_camie_session.get_inputs()[0].name: x})[1][0].astype(np.float64)   # [1] = refined
    probs = 1 / (1 + np.exp(-logits))
    out, ratings = {}, {}
    for i in np.nonzero(probs >= HARUKA_KEEP)[0].tolist():
        name, cat = _camie_tags[i]
        if cat == "rating":
            ratings[name.replace("rating ", "")] = float(probs[i])
        elif cat in CAMIE_THRESHOLDS:
            out[name] = (_calibrate(float(probs[i]), CAMIE_THRESHOLDS[cat]), cat)
    for label in ("general", "sensitive", "questionable", "explicit"):
        ratings.setdefault(label, 0.0)
    return out, ratings


# ---------------------------------------------------------------- PixAI (GPU, PyTorch, in this process)

class _PixAI:
    def __init__(self):
        import torch
        from safetensors import safe_open
        from safetensors.torch import load_file

        from . import pixai_vitdet

        with open(os.path.join(PIXAI_DIR, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.names = [_space(t) for t in cfg["tags"]]
        thresholds = cfg.get("category_best_threshold") or {}
        self.kinds = []
        for cat, count in cfg["tags_split"]:
            self.kinds += [({"style": "artist"}.get(cat, cat), float(thresholds.get(cat, 0.3)))] * count
        self.size = int(cfg.get("img_size", 1008))
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.dtype = torch.float16 if self.device.type == "cuda" else torch.float32
        skip = ("auto_map", "custom_pipelines", "architectures", "transformers_version")
        with torch.device("meta"):   # every weight comes from the file: skips ~9 s of random init on the CPU
            model = pixai_vitdet.ViTDetCls(pixai_vitdet.ViTDetClsConfig(**{k: v for k, v in cfg.items() if k not in skip}))
        missing, unexpected = model.load_state_dict(load_file(os.path.join(PIXAI_DIR, "model.safetensors")), strict=False, assign=True)
        if missing or unexpected:
            raise RuntimeError(f"PixAI weights don't match ({len(missing)} missing, {len(unexpected)} unexpected)")
        for m in model.modules():
            if hasattr(m, "_setup_rope_freqs"):
                m._setup_rope_freqs()   # the RoPE tables aren't in the file
        # Halve only real tensors: the RoPE tables are complex and model.to(dtype) would drop their imaginary part.
        if self.dtype != torch.float32:
            for t in list(model.parameters()) + list(model.buffers()):
                if t.is_floating_point():
                    t.data = t.data.to(self.dtype)
        self.model = model.to(self.device).eval()
        # Add-on heads trained on PixAI's pooled features for tags it misses (models/pixai_tagger/addons/*.safetensors).
        self.addons = []
        for path in sorted(glob.glob(os.path.join(PIXAI_ADDONS, "*.safetensors"))):
            with safe_open(path, "pt") as f:
                meta = f.metadata()
                th = json.loads(meta["thresholds"])
                self.addons.append(([_space(t) for t in json.loads(meta["tags"])], [th[t] for t in json.loads(meta["tags"])],
                                    f.get_tensor("weight").to(self.device, torch.float32), f.get_tensor("bias").to(self.device, torch.float32)))

    def predict(self, data):
        import torch
        import torch.nn.functional as F

        img = _open_rgb(data)
        # Shrink on the GPU: a 4K picture as float32 on the CPU is ~100 MB and slow to resize there.
        x = torch.from_numpy(np.asarray(img, dtype=np.uint8).copy()).to(self.device).permute(2, 0, 1).float().div_(255)[None]
        h, w = x.shape[-2:]
        r = min(self.size / h, self.size / w)
        nh, nw = int(h * r), int(w * r)
        x = F.interpolate(x, size=(nh, nw), mode="bilinear", antialias=True, align_corners=False)
        top, left = (self.size - nh) // 2, (self.size - nw) // 2
        x = F.pad(x, (left, self.size - nw - left, top, self.size - nh - top), value=0.0)
        with torch.inference_mode():
            f = self.model.forward_feature(((x - 0.5) / 0.5).to(self.device, self.dtype))[-1]   # same steps as ViTDetCls.forward,
            pooled = self.model.head_pool(f.view(f.shape[0], f.shape[1], -1).permute(0, 2, 1))  # keeping the pooled features
            probs = torch.sigmoid(self.model.head(pooled).float())[0].cpu().numpy()
            extra = [(tags, ths, torch.sigmoid(pooled[0].float() @ w.T + b).cpu().tolist()) for tags, ths, w, b in self.addons]
        out, ratings = {}, {}
        for name, (kind, threshold), p in zip(self.names, self.kinds, probs.tolist()):
            if kind == "rating":
                ratings[{"rating:g": "general", "rating:s": "sensitive", "rating:q": "questionable",
                         "rating:e": "explicit"}.get(name, name)] = p
            elif kind != "meta":
                out[name] = (_calibrate(p, threshold), kind)
        for tags, ths, ps in extra:
            for name, threshold, p in zip(tags, ths, ps):
                s = _calibrate(p, threshold)
                if s > out.get(name, (0,))[0]:   # an add-on only ever raises a tag PixAI scored lower
                    out[name] = (s, "general")
        return out, ratings


_pixai = None
_pixai_lock = threading.Lock()
_pixai_used = 0.0
_pixai_watching = False   # the idle watcher is started once, however often PixAI reloads


def pixai_ready():
    return all(os.path.isfile(os.path.join(PIXAI_DIR, f)) for f in ("config.json", "model.safetensors"))


def _pixai_predict(data):
    global _pixai, _pixai_used, _pixai_watching
    with _pixai_lock:
        if _pixai is None:
            _pixai = _PixAI()
        if not _pixai_watching:
            _pixai_watching = True
            threading.Thread(target=_pixai_idle_watch, daemon=True).start()
        _pixai_used = time.time()
        try:
            return _pixai.predict(data)
        finally:
            _pixai_used = time.time()


def unload_pixai(idle_only=False):
    """Free PixAI's VRAM now (e.g. before LoRA training needs the GPU). idle_only: only if it's still unused
    (checked under the lock, so a request that just started can't lose its model)."""
    global _pixai
    with _pixai_lock:
        if _pixai is None or (idle_only and time.time() - _pixai_used <= PIXAI_IDLE_SECONDS):
            return
        _pixai = None
        try:
            import gc
            import torch
            gc.collect()   # drop the model's last references before asking CUDA for the memory back
            torch.cuda.empty_cache()
        except Exception as e:
            logging.warning("[Kobo] freeing PixAI's GPU memory failed: %s", e)


def _pixai_idle_watch():   # started once, runs for the life of the server (cheap: one check every 30 s)
    while True:
        time.sleep(30)
        unload_pixai(idle_only=True)


# ---------------------------------------------------------------- JoyCaption (Ollama)

JC_PROMPT = (
    "Write a list of Danbooru tags for this image. Use lowercase with underscores, comma-separated. Include the "
    "number of characters (e.g. 1girl, 2boys), known characters, copyright, hair, eyes, body, clothing, accessories, "
    "pose, expression, actions, objects and background. Describe everything visible, including explicit content, "
    "using Danbooru's own tag names. Output only the tags."
)


def _ollama_url():
    from . import llm
    return llm.OLLAMA_URL


def joycaption_ready():
    try:
        with urllib.request.urlopen(_ollama_url() + "/api/tags", timeout=3) as r:
            names = [m["name"].split(":")[0] for m in json.loads(r.read()).get("models", [])]
        return JOYCAPTION_MODEL in names
    except Exception:
        return False


def _joycaption(data):
    """Set of tags (with spaces) JoyCaption writes for the image."""
    img = _open_rgb(data)
    img.thumbnail((768, 768), Image.BICUBIC)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    body = {"model": JOYCAPTION_MODEL, "stream": False, "keep_alive": 0, "options": {"num_predict": 320},
            "messages": [{"role": "user", "content": JC_PROMPT, "images": [base64.b64encode(buf.getvalue()).decode()]}]}
    req = urllib.request.Request(_ollama_url() + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        reply = json.loads(r.read())["message"]["content"]
    tags = set()
    for raw in reply.replace("\n", ",").split(","):
        t = raw.strip().strip(".*-•\"'` ").lower()
        if ":" in t and t.split(":", 1)[0] in ("artist", "character", "copyright", "meta", "general", "rating"):
            t = t.split(":", 1)[1].strip()
        t = " ".join(t.replace("_", " ").split()) if t not in KAOMOJIS else t
        if t and len(t) <= 60:
            tags.add(t)
    return tags


# Klein / Z-Image read sentences: JoyCaption looks at the picture itself (colours, light, framing the tags never say);
# the tagger's tags go along as hints because JoyCaption doesn't know character names.
DESCRIBE_PROMPT = (
    "Write a descriptive caption for this image in a casual tone, as {n} full sentences (about {words} words), not a list of "
    "tags. Say who is in it and how they look, their clothing, pose, expression and action, the setting, the colours, the "
    "lighting and the camera framing or angle. {content} Do NOT mention the image's resolution. Do NOT use any ambiguous "
    "language. Do not quote writing on signs or screens. Do not start with \"This image\". Every person is an adult. {focus}Use these tags as hints for names and details: {tags}"
)
_MINOR_WORDS = re.compile(r"\b(?:child|children|kid|kids|toddler|baby|little (?:girl|boy)|young (?:girl|boy)|preteen|teen|teenager|"
                          r"schoolgirl|schoolboy|loli|shota|underage)\b", re.I)


def describe_image(data, tags="", sfw=False, sentences=5, focus=""):
    """Sentences describing the image (JoyCaption), for engines that read natural language."""
    img = _open_rgb(data)
    img.thumbnail((768, 768), Image.BICUBIC)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    content = ("Keep it safe for work: leave out nudity and anything sexual." if sfw
               else "Describe everything visible, including nudity or sexual content when present.")
    n = max(2, min(8, int(sentences)))
    focus = " ".join(str(focus or "").split())[:120]
    focus = f"Pay special attention to this and describe it in detail: {focus}. " if focus else ""
    prompt = DESCRIBE_PROMPT.format(n=n, words=n * 24, content=content, focus=focus, tags=str(tags or "none")[:1500])
    body = {"model": JOYCAPTION_MODEL, "stream": False, "keep_alive": 0, "options": {"num_predict": 400, "temperature": 0.5},
            "messages": [{"role": "user", "content": prompt, "images": [base64.b64encode(buf.getvalue()).decode()]}]}
    req = urllib.request.Request(_ollama_url() + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        text = " ".join(json.loads(r.read())["message"]["content"].split()).strip().strip('"')
    if _MINOR_WORDS.search(text):
        raise ValueError("The description mentions a minor, so it was not used.")
    return text


# Writing in the picture (signs, speech bubbles, captions): RapidOCR's bundled PP-OCRv6 models on the CPU, one model for
# English, Japanese, Chinese and most Latin-script languages. ~0.5 s per image, so it never competes with PixAI for VRAM.
_ocr = None
_ocr_lock = threading.Lock()


def read_text(data):
    """Lines of text found in the image, top to bottom ([] when there is none)."""
    global _ocr
    from rapidocr import RapidOCR  # optional: pip install rapidocr

    with _ocr_lock:  # one engine, not safe to share between the executor's threads
        if _ocr is None:
            _ocr = RapidOCR()
        return list(_ocr(data).txts or ())


# ---------------------------------------------------------------- combined

def _one_penis_type(general):
    """Drops the tags of every animal penis type except the highest-scoring one."""
    best = {kind: max((s for t, s in general if t in tags), default=0) for kind, tags in PENIS_TYPES.items()}
    winner = max(best, key=best.get)
    if not best[winner]:
        return general
    losers = set().union(*(tags for kind, tags in PENIS_TYPES.items() if kind != winner))
    return [[t, s] for t, s in general if t not in losers]


def available_models():
    return {"wd": _model_ready(), "pixai": pixai_ready(), "haruka": haruka_ready(), "e621": e621_ready(), "camie": camie_ready(), "joycaption": joycaption_ready()}


def _frames(data):
    """Animated GIF/WebP/APNG: up to GIF_FRAMES evenly spaced frames as PNG bytes. Still images: [data] unchanged."""
    img = Image.open(io.BytesIO(data))
    n = getattr(img, "n_frames", 1)
    if n < 2:
        return [data]
    out = []
    for i in sorted({round(k * (n - 1) / (GIF_FRAMES - 1)) for k in range(GIF_FRAMES)}):
        img.seek(i)
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, "PNG")
        out.append(buf.getvalue())
    return out


# Danbooru's implications (build_implications.py): tag -> every tag it implies ("o-ring bikini" -> bikini, o-ring, swimsuit).
IMPLICATIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_implications.json")
_implied = None


def _implications():
    global _implied
    if _implied is None:
        try:
            with open(IMPLICATIONS_FILE, encoding="utf-8") as f:
                _implied = {k: set(v) for k, v in json.load(f).items()}
        except FileNotFoundError:
            _implied = {}   # no file: "most specific tags only" simply keeps everything
    return _implied


def parents(names):
    """{tag: [tags in names that it implies]}: which tags a more specific tag already covers."""
    implied, have = _implications(), set(names)
    return {n: sorted(implied[n] & have) for n in have if implied.get(n, set()) & have}


# The last few results, so analysing the same picture again (or flipping a setting) is instant.
CACHE_SIZE = 16
_cache = OrderedDict()
_cache_lock = threading.Lock()


def tag_image(data, models=None):
    """{"ratings", "general": [[tag, score]], "character": [[tag, score]], "artist": [[tag, score]],
    "copyright": [[tag, score]], "parents": {tag: [implied tags]}, "models": [...], "by": {tag: [...]}}.
    "artist" is PixAI's guess at the artist style (best 8; WD has no artist tags). Copyrights are also in "general".

    Scores are on WD's scale (0.35 = recommended threshold). Unavailable models are skipped,
    and if PixAI fails the result falls back to WD alone. Animated images are tagged on several frames and each
    tag keeps its best frame's score (so a safety tag seen in any one frame counts)."""
    key = (hashlib.sha1(data).hexdigest(), tuple(dict.fromkeys(models or DEFAULT_MODELS)))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return copy.deepcopy(_cache[key])   # callers edit their result
    result = _tag_image(data, models)
    result["parents"] = parents([t for t, _ in result["general"]])
    if result.get("degraded"):   # a tagger failed for now (e.g. out of VRAM): don't keep the weaker result
        return result
    with _cache_lock:
        _cache[key] = copy.deepcopy(result)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return result


# Tag -> look / clothing / action / setting / camera (build_tag_groups.py, from the Mexes, Jio7 and Sankaku taxonomies):
# the page writes a prompt's tags in that order and sorts "Tags from image" into appearance and outfit.
GROUPS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_groups.json")
_groups = None


def tag_groups(names):
    """{tag: group} for the names that have one."""
    global _groups
    if _groups is None:
        try:
            with open(GROUPS_FILE, encoding="utf-8") as f:
                _groups = json.load(f)
        except FileNotFoundError:
            _groups = {}   # no file: the page keeps tags in score order
    return {n: _groups[n] for n in names if n in _groups}


def to_rule34(result):
    """A copy of tag_image's result with tags renamed to rule34.xxx's names via its aliases (rule34_tags.csv), the
    same map the Adult prompt writer uses. Safety tags keep their names, so every block check still sees them."""
    from . import boorutags, llm

    known = llm.rule34_tags()[0]

    def ren(t):
        new = known.get(t, t)
        unsafe = (t, new)
        return t if any(x in llm.BLOCKED_TAGS or boorutags.blocked(boorutags.norm(x)) for x in unsafe) else new

    out = dict(result)
    for key in ("general", "character", "artist", "copyright"):
        best = {}
        for t, p in result.get(key, []):
            best[ren(t)] = max(p, best.get(ren(t), 0))   # two tags with one rule34 name: keep the stronger
        out[key] = sorted(([n, p] for n, p in best.items()), key=lambda x: -x[1])
    by = {}
    for t, ms in result.get("by", {}).items():
        by[ren(t)] = sorted(set(by.get(ren(t), [])) | set(ms))
    out["by"] = by
    parents_ = {}
    for t, ps in result.get("parents", {}).items():
        kept = {ren(p) for p in ps} - {ren(t)}
        if kept:
            parents_[ren(t)] = sorted(kept | set(parents_.get(ren(t), [])))
    out["parents"] = parents_
    return out


def _tag_image(data, models=None):
    frames = _frames(data)
    results = [_tag_frame(f, list(models) if models else None) for f in frames]
    if len(results) == 1:
        return results[0]
    merged = {"ratings": {}, "models": results[0]["models"], "by": {}, "frames": len(frames),
              "degraded": any(r.get("degraded") for r in results)}
    for r in results:
        for n, p in r["ratings"].items():
            merged["ratings"][n] = max(p, merged["ratings"].get(n, 0))
        for n, ms in r["by"].items():
            merged["by"][n] = sorted(set(merged["by"].get(n, [])) | set(ms))
    for key in ("general", "character", "artist", "copyright"):
        best = {}
        for r in results:
            for n, p in r[key]:
                best[n] = max(p, best.get(n, 0))
        merged[key] = sorted(([n, p] for n, p in best.items()), key=lambda t: -t[1])
    merged["general"] = _one_penis_type(merged["general"])   # frames may disagree on the species
    merged["artist"] = merged["artist"][:8]
    return merged


def _tag_frame(data, models=None):
    from . import llm

    models = list(dict.fromkeys(m for m in (models or DEFAULT_MODELS) if m in ("wd", "pixai", "haruka", "e621", "camie", "joycaption")))
    for m, ready in (("pixai", pixai_ready), ("haruka", haruka_ready), ("e621", e621_ready), ("camie", camie_ready)):
        if m in models and not ready():
            models.remove(m)
    if not any(m in models for m in ("wd", "pixai", "haruka", "e621", "camie")):
        models.insert(0, "wd")  # JoyCaption alone isn't calibrated; always have a tagger

    results, used = {}, []
    # JoyCaption runs first and alone, and leaves the GPU when done (keep_alive 0). Ollama sizes its GPU share when
    # it loads; PixAI loading next to it overflowed the 6 GB card and Windows paged both to RAM (minutes per image).
    if "joycaption" in models:
        models.remove("joycaption")
        try:
            results["joycaption"] = _joycaption(data)
            used.append("joycaption")
        except Exception as e:
            logging.warning("[Kobo] joycaption tagging failed: %s", e)
    jobs = {"wd": _wd, "pixai": _pixai_predict, "haruka": _haruka, "e621": _e621, "camie": _camie}
    failed = {}
    with ThreadPoolExecutor(max_workers=max(1, len(models))) as pool:
        futures = {m: pool.submit(jobs[m], data) for m in models}
        for m, fut in futures.items():
            try:
                results[m] = fut.result()
                used.append(m)
            except Exception as e:
                failed[m] = f"{type(e).__name__}: {e}"
                logging.warning("[Kobo] %s tagging failed: %s", m, e)
    if not any(m in results for m in ("wd", "pixai", "haruka", "e621", "camie")):
        if "wd" in failed or (failed and not _model_ready()):
            # Say why the picked taggers failed, not just "WD not found".
            raise RuntimeError("Tagging failed: " + "; ".join(f"{m}: {e}" for m, e in failed.items()))
        results["wd"] = _wd(data)  # last resort; raises if WD itself is broken
        used.append("wd")

    per = {m: results[m][0] for m in ("wd", "pixai", "haruka", "e621", "camie") if m in results}
    if "e621" in per and len(per) > 1:
        # e621 only adds its own words: on Danbooru words it is weaker and would drag WD/PixAI's scores down.
        # Safety tags still vote (they take the max, so it can only raise them).
        others = [t for m, t in per.items() if m != "e621"]
        per["e621"] = {n: v for n, v in per["e621"].items() if n in llm.BLOCKED_TAGS or not any(n in t for t in others)}
    weights = {"wd": W_WD, "pixai": W_PIXAI, "haruka": W_HARUKA, "e621": W_E621, "camie": W_CAMIE}
    jc = results.get("joycaption", set())

    ratings = {}
    for m in per:
        for name, p in results[m][1].items():
            ratings.setdefault(name, []).append(p)
    ratings = {n: sum(v) / len(v) for n, v in ratings.items()}

    general, character, artist, copyright, by = [], [], [], [], {}
    for name in set(jc).union(*[set(t) for t in per.values()]):
        votes = [(per[m][name][0], weights[m], m) for m in per if name in per[m]]
        if votes and "haruka" in per and "pixai" in per and name not in per["haruka"]:
            votes.append((0.0, W_HARUKA, "haruka"))   # Haruka has 98.8k tags: missing means it scored ~0, so it votes 0
        if votes:
            kind = next(per[m][name][1] for m in per if name in per[m])
            if kind == "character" and "haruka" in per:
                score = sum(s * w for s, w, _ in votes) / sum(w for _, w, _ in votes)  # averaging beat the max (0.736 vs 0.718)
            elif name in llm.BLOCKED_TAGS or kind == "character":
                score = max(s for s, _, _ in votes)  # safety tags: never weaker than any one model
            else:
                # Copyrights are averaged like general tags (they used to take the max, so a series or brand only
                # Haruka guessed, e.g. "nvidia" on a parody console box, slipped through at full strength).
                score = sum(s * w for s, w, _ in votes) / sum(w for _, w, _ in votes)
                if "pixai" in per and name not in per["pixai"] and [m for _, _, m in votes] == ["haruka"]:
                    score *= HARUKA_ONLY   # words PixAI doesn't know: half of them were wrong at the default threshold
            if name in jc:
                score += (1 - score) * JC_BOOST
                if name in llm.BLOCKED_TAGS:
                    score = max(score, 0.5)  # safety tags: any one model seeing it is enough
        elif name in jc and (JC_ONLY or name in llm.BLOCKED_TAGS):
            kind, score = "general", max(JC_ONLY, 0.5 if name in llm.BLOCKED_TAGS else 0)
        else:
            continue
        p = _wd_scale(score)
        if kind == "character" and p >= 0.35:
            character.append([name, p])
        elif kind in ("general", "copyright") and p >= 0.2:
            general.append([name, p])   # copyrights stay in "general" too, for callers that don't know "copyright"
            if kind == "copyright":
                copyright.append([name, p])
        elif kind == "artist" and p >= 0.2:
            artist.append([name, p])
        else:
            continue
        by[name] = [m for m, tags in per.items() if name in tags and tags[name][0] >= 0.5] + (["joycaption"] if name in jc else [])
    general = _one_penis_type(general)
    for lst in (general, character, artist, copyright):
        lst.sort(key=lambda t: -t[1])
    return {"ratings": ratings, "general": general, "character": character, "artist": artist[:8], "copyright": copyright,
            "models": used, "by": by, "degraded": bool(failed)}
