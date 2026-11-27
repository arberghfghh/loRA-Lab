# 📦 Models: downloads the models in modelcatalog.json into ComfyUI's model folders (and pulls the writer into Ollama),
# one at a time in a background thread, resuming half-finished files (.part) after a cancel or a restart.
import hashlib
import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.request

import folder_paths

from . import llm

CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "modelcatalog.json")
CHUNK = 1 << 20
_lock = threading.Lock()
_job = {"state": "idle"}
_cancel = threading.Event()


def catalog():
    with open(CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _dir(folder):
    """Where a file of this folder kind is saved: the first path ComfyUI knows for it."""
    if folder.startswith("@models/"):
        return os.path.join(folder_paths.models_dir, *folder[len("@models/"):].split("/"))
    paths = folder_paths.get_folder_paths(folder)
    if not paths:
        raise RuntimeError(f"ComfyUI has no '{folder}' model folder")
    return paths[0]


def _installed_file(f):
    if f["folder"].startswith("@models/"):
        return os.path.isfile(os.path.join(_dir(f["folder"]), f["name"]))
    try:
        return bool(folder_paths.get_full_path(f["folder"], f["name"]))
    except Exception:
        return False


def _ollama_models():
    try:
        with urllib.request.urlopen(llm.OLLAMA_URL + "/api/tags", timeout=2) as r:
            return {m["name"] for m in json.load(r).get("models", [])}
    except Exception:
        return None


def _has_ollama(names, model):
    full = model if ":" in model else model + ":latest"
    return names is not None and (model in names or full in names)


def _files(item):
    if item.get("ollama_gguf"):
        return [item["ollama_gguf"]]
    return item.get("files") or []


def status():
    """The catalog with what's installed, plus the download job."""
    cat = catalog()
    names = _ollama_models()
    items = []
    for item in cat["items"]:
        files = _files(item)
        if item.get("ollama"):
            have = _has_ollama(names, item["ollama"]["model"])
            missing = 0 if have else item["ollama"]["size"]
        elif item.get("ollama_gguf"):
            have = _has_ollama(names, item["ollama_gguf"]["model"])
            missing = 0 if have else (0 if _installed_file(files[0]) else files[0]["size"])
        else:
            gone = [f for f in files if not _installed_file(f)]
            have, missing = not gone, sum(f["size"] for f in gone)
        items.append({k: v for k, v in item.items() if k not in ("files", "ollama", "ollama_gguf")}
                     | {"installed": have, "size": sum(f["size"] for f in files) or (item.get("ollama") or {}).get("size", 0),
                        "missing": missing, "needsOllama": bool(item.get("ollama") or item.get("ollama_gguf"))})
    with _lock:
        job = dict(_job)
    return {"groups": cat["groups"], "items": items, "ollama": names is not None, "job": job}


def start(ids):
    with _lock:
        if _job.get("state") == "running":
            raise RuntimeError("A download is already running")
        items = [i for i in catalog()["items"] if i["id"] in set(ids)]
        if not items:
            raise RuntimeError("Nothing to download")
        _cancel.clear()
        _job.clear()
        _job.update({"state": "running", "ids": [i["id"] for i in items], "done": [], "current": None, "file": "",
                     "bytes": 0, "total": 0, "speed": 0, "error": "", "started": time.time()})
    threading.Thread(target=_run, args=(items,), daemon=True, name="kobo-models").start()


def cancel():
    _cancel.set()


def _set(**kw):
    with _lock:
        _job.update(kw)


def _run(items):
    try:
        names = _ollama_models()
        # Room for everything still missing, added up per drive (Ollama models land in Ollama's own folder, so
        # they're not counted here), plus 2 GB to spare.
        need, where = {}, {}
        for item in items:
            for f in _files(item) if not item.get("ollama") else []:
                if not _installed_file(f):
                    d = _dir(f["folder"])
                    os.makedirs(d, exist_ok=True)
                    part = os.path.join(d, *f["name"].split("/")) + ".part"
                    drive = os.path.splitdrive(os.path.abspath(d))[0].upper() or d
                    need[drive] = need.get(drive, 0) + f["size"] - (os.path.getsize(part) if os.path.isfile(part) else 0)
                    where[drive] = d
        for drive, n in need.items():
            free = shutil.disk_usage(where[drive]).free
            if free < n + (2 << 30):
                raise RuntimeError(f"Not enough disk space: these models need {n / 1e9:.1f} GB on {drive or where[drive]} "
                                   f"(plus 2 GB to spare), but only {free / 1e9:.1f} GB is free. Untick some, or free up space.")
        for item in items:
            _set(current=item["id"], bytes=0, total=0, file="")
            if item.get("ollama"):
                if not _has_ollama(names, item["ollama"]["model"]):
                    _pull(item["ollama"]["model"])
            elif item.get("ollama_gguf"):
                g = item["ollama_gguf"]
                if not _has_ollama(names, g["model"]):
                    if not _installed_file(g):
                        _download(g)
                    _ollama_create(g)
            else:
                for f in item["files"]:
                    if not _installed_file(f):
                        _download(f)
            with _lock:
                _job["done"].append(item["id"])
        _set(state="done", current=None)
    except _Cancelled:
        _set(state="cancelled", current=None)
    except Exception as e:
        _set(state="error", error=str(e) or e.__class__.__name__, current=None)


class _Cancelled(Exception):
    pass


def _download(f):
    """One file, resumed from its .part file when there is one."""
    d = _dir(f["folder"])
    target = os.path.join(d, *f["name"].split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    part = target + ".part"
    have = os.path.getsize(part) if os.path.isfile(part) else 0
    headers = {"User-Agent": "Kobo"}
    if have:
        headers["Range"] = f"bytes={have}-"
    if os.environ.get("HF_TOKEN") and "huggingface.co" in f["url"]:
        headers["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
    _set(file=f["name"], bytes=have, total=f["size"])
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(f["url"], headers=headers), timeout=60) as r:
                if have and r.status != 206:   # the server ignored the Range: start again
                    have = 0
                total = have + int(r.headers.get("Content-Length") or 0)
                _set(total=total or f["size"], bytes=have)
                t0, b0 = time.time(), have
                checked = have
                with open(part, "ab" if have else "wb") as out:
                    while True:
                        if _cancel.is_set():
                            raise _Cancelled()
                        chunk = r.read(CHUNK)
                        if not chunk:
                            break
                        out.write(chunk)
                        have += len(chunk)
                        # Never fill the drive up (other apps may be writing too): stop with 1 GB left.
                        if have - checked >= 256 * CHUNK:
                            checked = have
                            if shutil.disk_usage(d).free < (1 << 30):
                                raise RuntimeError("The drive is almost full, so the download stopped. Free up space and "
                                                   "press Download again; it carries on where it stopped.")
                        dt = time.time() - t0
                        _set(bytes=have, speed=(have - b0) / dt if dt > 1 else 0)
            break
        except _Cancelled:
            raise
        except urllib.error.HTTPError as e:
            if e.code == 416:   # already complete
                break
            if e.code in (401, 403):
                raise RuntimeError(f"{f['name']}: the site refused the download (HTTP {e.code}).")
            if attempt == 4:
                raise RuntimeError(f"{f['name']}: download failed (HTTP {e.code}).")
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            if attempt == 4:
                raise RuntimeError(f"{f['name']}: download failed ({e}). Check the internet connection and try again; "
                                   "it carries on where it stopped.")
        time.sleep(3 * (attempt + 1))
        have = os.path.getsize(part) if os.path.isfile(part) else 0
        if have:
            headers["Range"] = f"bytes={have}-"
    if f["size"] > (1 << 20) and os.path.getsize(part) < f["size"] * 0.98:
        raise RuntimeError(f"{f['name']}: the download stopped early; try again to carry on.")
    os.replace(part, target)


def _ollama_post(path, body, stream=False, timeout=None):
    req = urllib.request.Request(llm.OLLAMA_URL + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error")
        except Exception:
            msg = ""
        raise RuntimeError(f"Ollama: {msg or f'HTTP {e.code}'}")
    except urllib.error.URLError:
        raise RuntimeError("Ollama isn't running. Start Kōbō from its app (it starts Ollama), or install Ollama from ollama.com.")


def _pull(model):
    _set(file=model, bytes=0, total=0)
    parts, t0 = {}, time.time()
    with _ollama_post("/api/pull", {"model": model, "stream": True}) as r:
        for line in r:
            if _cancel.is_set():
                raise _Cancelled()   # Ollama keeps what it has; pulling again carries on
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("error"):
                raise RuntimeError("Ollama: " + msg["error"])
            if msg.get("digest") and msg.get("total"):
                parts[msg["digest"]] = (msg.get("completed") or 0, msg["total"])
                done = sum(c for c, _ in parts.values())
                _set(bytes=done, total=sum(t for _, t in parts.values()), speed=done / max(1, time.time() - t0))
            if msg.get("status") == "success":
                return
    raise RuntimeError(f"Ollama didn't finish pulling {model}")


def _ollama_create(g):
    """Register a downloaded GGUF in Ollama (upload the blob, then create the model from it)."""
    path = os.path.join(_dir(g["folder"]), g["name"])
    _set(file=g["model"] + " (adding to Ollama)", bytes=0, total=os.path.getsize(path))
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK * 8), b""):
            h.update(chunk)
    digest = "sha256:" + h.hexdigest()
    try:
        with urllib.request.urlopen(urllib.request.Request(llm.OLLAMA_URL + "/api/blobs/" + digest, method="HEAD"), timeout=10):
            pass
    except urllib.error.HTTPError:
        with open(path, "rb") as f:
            req = urllib.request.Request(llm.OLLAMA_URL + "/api/blobs/" + digest, data=f, method="POST",
                                         headers={"Content-Length": str(os.path.getsize(path))})
            urllib.request.urlopen(req, timeout=600).close()
    except urllib.error.URLError:
        raise RuntimeError("Ollama isn't running, so the tag expander couldn't be added to it.")
    with _ollama_post("/api/create", {"model": g["model"], "files": {g["name"]: digest}, "template": g.get("template", ""),
                                      "parameters": g.get("parameters") or {}, "stream": False}, timeout=600) as r:
        body = json.load(r)
    if body.get("status") != "success":
        raise RuntimeError("Ollama couldn't add " + g["model"])
