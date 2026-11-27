# LoRA training: datasets in input/lora-training/<name> (image + same-name .txt caption, what ComfyUI's
# "Load Image and Text Dataset from Folder" node reads) and a record of training jobs, so finished LoRAs get
# kohya-style metadata. ComfyUI's Save LoRA node writes none, and Kōbō reads model type, trigger tags and its
# adult/child checks from that metadata.
import glob
import io
import json
import os
import re
import threading
import time
from collections import Counter

import safetensors.torch
from PIL import Image

import folder_paths

from . import charlib, tagger
from .llm import BLOCKED_TAGS

ROOT = os.path.join(folder_paths.get_input_directory(), "lora-training")
OUT_DIR = os.path.join(folder_paths.get_output_directory(), "trained-loras")
JOBS_PATH = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-training.json")
META = "lora-lab.json"
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
MODES = ("general", "adult")
FAMILIES = {"sd15": "sd_v1", "sdxl": "sdxl_base_v1-0", "anima": "anima"}
# A dataset image the tagger sees as a child at this confidence can't be trained on.
CHILD_THRESHOLD = 0.35
MAX_IMAGE_BYTES = 30 * 1024 * 1024

_lock = threading.Lock()


class DatasetError(Exception):
    pass


def _dir(name):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise DatasetError("Dataset names use letters, numbers, spaces, - and _ (up to 40)")
    return os.path.join(ROOT, name)


def _image(name, file):
    path = os.path.join(_dir(name), os.path.basename(str(file)))
    if not path.lower().endswith(IMAGE_EXT) or not os.path.isfile(path):
        raise DatasetError("Unknown image")
    return path


def _caption_path(image_path):
    return os.path.splitext(image_path)[0] + ".txt"


def _read(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def _meta(name):
    # Datasets made outside Kōbō (no meta file) belong to the Adult workspace, like old characters.
    meta = _read(os.path.join(_dir(name), META), {})
    return {"trigger": str(meta.get("trigger", "")), "workspace": meta.get("workspace") if meta.get("workspace") in MODES else "adult",
            "checked": meta.get("checked") or {}, "sources": meta.get("sources") or {}}


def _save_meta(name, meta):
    _write(os.path.join(_dir(name), META), meta)


def _images(name):
    d = _dir(name)
    return sorted(f for f in os.listdir(d) if f.lower().endswith(IMAGE_EXT))


def list_datasets(workspace):
    os.makedirs(ROOT, exist_ok=True)
    out = []
    for name in sorted(os.listdir(ROOT), key=str.lower):
        if not NAME_RE.match(name) or not os.path.isdir(os.path.join(ROOT, name)):
            continue
        meta = _meta(name)
        if meta["workspace"] != workspace:
            continue
        files = _images(name)
        out.append({"name": name, "trigger": meta["trigger"], "count": len(files), "thumb": files[0] if files else None})
    return out


def get(name):
    d = _dir(name)
    if not os.path.isdir(d):
        raise DatasetError("Unknown dataset")
    meta = _meta(name)
    source = {file: key for key, file in meta["sources"].items()}   # gallery image each copied file came from
    images = []
    for f in _images(name):
        cap = _caption_path(os.path.join(d, f))
        text = open(cap, encoding="utf-8").read().strip() if os.path.exists(cap) else ""
        images.append({"file": f, "caption": text, "child": f in meta["checked"] and meta["checked"][f].get("child", False),
                       "source": source.get(f)})
    return {"name": name, "trigger": meta["trigger"], "workspace": meta["workspace"], "images": images}


def create(name, workspace, trigger=""):
    d = _dir(name)
    if workspace not in MODES:
        raise DatasetError("Unknown workspace")
    with _lock:
        if os.path.exists(d):
            raise DatasetError(f'"{name}" already exists')
        os.makedirs(d)
        _save_meta(name, {"trigger": trigger, "workspace": workspace, "checked": {}, "sources": {}})
    return get(name)


def set_trigger(name, trigger):
    with _lock:
        meta = _meta(name)
        meta["trigger"] = " ".join(str(trigger).split())[:60]
        _save_meta(name, meta)
    return meta["trigger"]


def add_image(name, filename, data):
    if len(data) > MAX_IMAGE_BYTES:
        raise DatasetError("Image is larger than 30 MB")
    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
    except Exception:
        raise DatasetError("Not an image")
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in IMAGE_EXT:
        ext = ".png"
        img = Image.open(io.BytesIO(data))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        data = buf.getvalue()
    d = _dir(name)
    with _lock:
        used = {os.path.splitext(f)[0] for f in _images(name)}
        n = len(used) + 1
        while f"{n:03}" in used:
            n += 1
        file = f"{n:03}{ext}"
        with open(os.path.join(d, file), "wb") as f:
            f.write(data)
    return file


def delete_image(name, file):
    path = _image(name, file)
    with _lock:
        os.remove(path)
        if os.path.exists(_caption_path(path)):
            os.remove(_caption_path(path))
        meta = _meta(name)
        meta["checked"].pop(os.path.basename(path), None)
        _save_meta(name, meta)


def sync_from_gallery(name, workspace, trigger, images):
    """Make a dataset hold exactly these generated images (output-folder refs {filename, subfolder}), e.g. a character's
    gallery minus the ones you unticked. New ones are copied in, unticked ones that were copied before are removed;
    captions of images already there are kept. Returns the files that are new."""
    d = _dir(name)
    if not os.path.isdir(d):
        create(name, workspace, trigger)
    elif _meta(name)["workspace"] != workspace:
        raise DatasetError(f'"{name}" belongs to the other workspace')
    out_dir = os.path.realpath(folder_paths.get_output_directory())
    wanted = {}
    for im in images:
        if not isinstance(im, dict) or not im.get("filename"):
            continue
        path = os.path.realpath(os.path.join(out_dir, str(im.get("subfolder") or ""), os.path.basename(str(im["filename"]))))
        if os.path.commonpath([out_dir, path]) == out_dir and path.lower().endswith(IMAGE_EXT) and os.path.isfile(path):
            wanted[f'{im.get("subfolder") or ""}/{os.path.basename(path)}'] = path
    sources = _meta(name)["sources"]
    for key in [k for k in sources if k not in wanted]:
        if os.path.isfile(os.path.join(d, sources[key])):
            delete_image(name, sources[key])
        del sources[key]
    added = []
    for key, path in wanted.items():
        if key in sources and os.path.isfile(os.path.join(d, sources[key])):
            continue
        with open(path, "rb") as f:
            sources[key] = add_image(name, path, f.read())
        added.append(sources[key])
    with _lock:
        meta = _meta(name)
        meta["sources"] = sources
        meta["trigger"] = trigger
        _save_meta(name, meta)
    return added


def save_caption(name, file, text):
    path = _image(name, file)
    text = ", ".join(t for t in (" ".join(t.split()) for t in str(text).replace("\n", ",").split(",")) if t)[:2000]
    with open(_caption_path(path), "w", encoding="utf-8") as f:
        f.write(text)
    return text


def _check(name, file):
    """Run the WD tagger on one image and remember whether it looks like a child. Returns the tagger result."""
    path = _image(name, file)
    with open(path, "rb") as f:
        result = tagger.tag_image(f.read())
    child = any(t in BLOCKED_TAGS and p >= CHILD_THRESHOLD for t, p in result["general"] + result["character"])
    if result.get("degraded"):   # a tagger failed this time: answer now, but check again next time
        return result, child
    with _lock:
        meta = _meta(name)
        meta["checked"][os.path.basename(path)] = {"mtime": os.path.getmtime(path), "child": child}
        _save_meta(name, meta)
    return result, child


def caption(name, file, threshold):
    """Tags for one image (Danbooru style, blocked tags never included) and whether it was flagged."""
    result, child = _check(name, file)
    tags = [t for t, p in result["general"] if p >= threshold and t not in BLOCKED_TAGS]
    return {"tags": tags, "child": child}


def check_dataset(name):
    """Tagger-check every image not checked since it last changed; returns the flagged files."""
    meta = _meta(name)
    for f in _images(name):
        c = meta["checked"].get(f)
        if not c or c.get("mtime") != os.path.getmtime(os.path.join(_dir(name), f)):
            _check(name, f)
    meta = _meta(name)
    return [f for f in _images(name) if meta["checked"].get(f, {}).get("child")]


def validate_for_training(name):
    if not os.path.isdir(_dir(name)):
        raise DatasetError("Unknown dataset")
    images = _images(name)
    if len(images) < 5:
        raise DatasetError("Add at least 5 images (15–40 works best)")
    flagged = check_dataset(name)
    tagger.unload_pixai()  # training needs the GPU; the tagger's PixAI model holds ~1 GB
    if flagged:
        raise DatasetError(f"{len(flagged)} image(s) look like a child and can't be used for training: {', '.join(flagged)}")
    for f in images:
        cap = _caption_path(os.path.join(_dir(name), f))
        text = open(cap, encoding="utf-8").read().lower() if os.path.exists(cap) else ""
        if any(t.strip().replace("_", " ") in BLOCKED_TAGS for t in text.split(",")):
            raise DatasetError(f"The caption of {f} has a child-related tag")
    return len(images)


# ---------- jobs ----------

def _jobs():
    return _read(JOBS_PATH, [])


def add_job(job):
    with _lock:
        jobs = _jobs()
        jobs.append(job)
        _write(JOBS_PATH, jobs[-50:])


def _stamp(path, job):
    """Write kohya-style training metadata into a finished LoRA."""
    freq, n = Counter(), 0
    d = _dir(job["dataset"])
    for f in (_images(job["dataset"]) if os.path.isdir(d) else []):
        cap = _caption_path(os.path.join(d, f))
        if os.path.exists(cap):
            freq.update(t.strip() for t in open(cap, encoding="utf-8").read().split(",") if t.strip())
        n += 1
    metadata = {
        "ss_base_model_version": FAMILIES[job["family"]],
        "ss_sd_model_name": job.get("checkpoint", ""),
        "ss_network_module": "networks.lora",
        "ss_network_dim": str(job.get("rank", "")),
        "ss_output_name": job["name"],
        "ss_steps": str(job.get("steps", "")),
        "ss_num_train_images": str(n),
        "ss_tag_frequency": json.dumps({job["dataset"]: dict(freq)}),
        "modelspec.title": job["name"],
        "lora_lab_trigger": job.get("trigger", ""),
        "lora_lab_dataset": job["dataset"],
    }
    tensors = safetensors.torch.load_file(path)
    tmp = path + ".tmp"
    safetensors.torch.save_file(tensors, tmp, metadata=metadata)
    os.replace(tmp, path)


def refresh_jobs(history):
    """Settle running jobs against ComfyUI's history (history(pid) -> entry or None) and return all jobs."""
    with _lock:
        jobs, changed = _jobs(), False
        for job in jobs:
            if job.get("status") != "running":
                continue
            entry = history(job["pid"])
            if not entry:
                continue
            status = entry.get("status") or {}
            if not status.get("completed"):
                if status.get("status_str") == "error":
                    msg = next((m[1] for m in status.get("messages", []) if m[0] in ("execution_error", "execution_interrupted")), {})
                    job["status"], job["error"] = "error", msg.get("exception_message") or "Training failed or was cancelled"
                    changed = True
                continue
            files = sorted(glob.glob(os.path.join(OUT_DIR, glob.escape(job["file_prefix"]) + "_*.safetensors")), key=os.path.getmtime)
            files = [f for f in files if os.path.getmtime(f) >= job["started"] - 5]
            if not files:
                job["status"], job["error"] = "error", "Training finished but no LoRA file was found"
            else:
                try:
                    _stamp(files[-1], job)
                except Exception as e:
                    job["stamp_error"] = f"{type(e).__name__}: {e}"
                job["status"], job["file"], job["finished"] = "done", os.path.basename(files[-1]), time.time()
                if job.get("character_id"):   # "Learn this character": the LoRA becomes part of the character
                    job["attached"] = charlib.learned(job["character_id"], job["file"], job.get("trigger", ""),
                                                      job["family"] if job.get("switch_engine") else None)
                for out in (entry.get("outputs") or {}).values():
                    for img in out.get("images") or []:
                        job["loss_graph"] = img
            changed = True
        if changed:
            _write(JOBS_PATH, jobs)
    return jobs
