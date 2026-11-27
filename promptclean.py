# Prompts to share (e.g. on Patreon) without giving away how a picture was made: the subject, pose, outfit and scene
# stay; artist tags, model-specific quality/date tags, LoRA activation words and LoRA/embedding syntax go.
import csv
import json
import os
import re
import struct
import threading

import folder_paths

from . import loraflags

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "danbooru_tags.csv")
# Tags that name a model family (Pony/Anima score tags, Illustrious/Anima date and rating tags) rather than the picture.
# Matched against _core(), where underscores are already spaces.
MODEL_TAG = re.compile(r"(score \d+( up)?|newest|recent|year \d{4}|source \w+|rating[: ]\w+|safe|sensitive|questionable|explicit|nsfw|"
                       r"very aesthetic|amazing quality|absurdres)")
SYNTAX = re.compile(r"<(lora|lyco|hypernet):[^>]*>|\bembedding:[\w.\-]+", re.I)
TRIGGER_NOTE = re.compile(r"trigger word:\s*([^\n,;]+)", re.I)

_artists = None
_lock = threading.Lock()


def _artist_names():
    """Danbooru artist names (spaces, lowercase). A tag name lives in one category only, so these never hit a general tag."""
    global _artists
    with _lock:
        if _artists is None:
            with open(CSV_PATH, newline="", encoding="utf-8") as f:
                _artists = {name.replace("_", " ").lower() for name, cat, *_ in csv.reader(f) if cat == "1" and len(name) >= 3}
        return _artists


def _lora_triggers(path):
    """The trigger word written into a LoRA file by Kōbō's trainer or kohya's training comment, if any."""
    try:
        with open(path, "rb") as f:
            size = struct.unpack("<Q", f.read(8))[0]
            if size > 50_000_000:   # not a real safetensors header
                return []
            meta = json.loads(f.read(size)).get("__metadata__") or {}
    except (OSError, ValueError, struct.error):
        return []
    words = [meta.get("lora_lab_trigger", "")]
    m = TRIGGER_NOTE.search(meta.get("ss_training_comment", ""))
    return [w.strip() for w in words + [m.group(1) if m else ""] if w.strip()]


def secret_words():
    """Activation words the user set in Kōbō plus the ones inside the LoRA files (lowercase)."""
    words = set(w.lower() for w in loraflags.load()["words"].values())
    for name in folder_paths.get_filename_list("loras"):
        if name.lower().endswith(".safetensors"):
            words.update(w.lower() for w in _lora_triggers(folder_paths.get_full_path("loras", name)))
    return {w for w in words if w}


def _core(tag):
    """'(Tag_Name:1.2)' -> 'tag name', for matching."""
    t = re.sub(r":\s*[\d.]+\s*\)*$", "", tag.strip().strip("()[]{}").strip())
    return " ".join(t.replace("_", " ").lower().split())


def clean(text, words):
    """The prompt with every revealing tag left out. `words` comes from secret_words()."""
    artists = _artist_names()
    keep = []
    for tag in SYNTAX.sub("", text).replace("\n", ",").split(","):
        core = _core(tag)
        if not core or core.startswith("@") or core.startswith("artist:") or core.startswith("by ") or core in artists \
                or MODEL_TAG.fullmatch(core) or core in words or any(re.search(rf"\b{re.escape(w)}\b", core) for w in words):
            continue
        tag = tag.strip()
        if tag.count("(") != tag.count(")"):   # one half of a weighted group "(a, b:1.2)": keep just the words
            tag = re.sub(r":\s*[\d.]+\s*$", "", tag.strip("()").strip())
        keep.append(tag)
    return ", ".join(dict.fromkeys(keep))
