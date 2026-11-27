# Images tab: every picture Kōbō saved under output/LoRA-Lab,
# with favourites and the workspace each was made in.
# Favourites, workspaces and image sets (named groups the user makes) live in one JSON file in ComfyUI's user folder;
# deleting removes the file from disk, from the sets, and from the character galleries and stories that showed it.
import json
import os
import re
import threading
import time

import folder_paths
from PIL import Image

from . import charlib, chatlib, imageinfo, mangalib, promptclean, storylib

OUT = os.path.abspath(folder_paths.get_output_directory())
ROOT = os.path.join(OUT, "LoRA-Lab")
ROOTS = (ROOT,)
EXPORT = os.path.join(OUT, "Patreon-export")   # outside LoRA-Lab, so the clean copies don't show up in the Images tab
PATH = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-images.json")
EXTS = (".png", ".jpg", ".jpeg", ".webp")
MODES = ("general", "adult", "story")

_lock = threading.Lock()


def key(image):
    """'LoRA-Lab/…/name.png' for an image dict ({filename, subfolder}), the same on Windows and elsewhere."""
    return (str(image.get("subfolder") or "").replace("\\", "/").strip("/") + "/" + str(image.get("filename") or "")).lstrip("/")


def _file(image):
    """Absolute path of an image inside output/LoRA-Lab, or None."""
    if not isinstance(image, dict) or not image.get("filename"):
        return None
    path = os.path.abspath(os.path.join(OUT, key(image)))
    inside = any(os.path.normcase(os.path.commonpath([path, r])) == os.path.normcase(r) for r in ROOTS)
    return path if inside and path.lower().endswith(EXTS) else None


def _read():
    """{"images": {key: {fav, mode}}, "sets": [{id, name, mode, images: [key…]}]}"""
    try:
        with open(PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    return {"images": data.get("images", {}), "sets": data.get("sets", [])}


def _write(data):
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, PATH)


# folder -> (its mtime, [(image name, mtime ms)], [subfolders]). A folder's mtime changes when a file in it is added,
# removed or renamed, so unchanged folders are not listed again.
# shortcut: an image overwritten in place keeps its old time here until its folder changes; fine while Kōbō writes new names.
_folders = {}


def _walk(folder):
    """(folder, [(image name, mtime ms)]) for folder and its subfolders, rescanning only folders that changed."""
    try:
        stamp = os.stat(folder).st_mtime_ns
        hit = _folders.get(folder)
        if hit is None or hit[0] != stamp:
            files, subs = [], []
            with os.scandir(folder) as it:
                for e in it:
                    if e.is_dir():
                        subs.append(e.path)
                    elif e.name.lower().endswith(EXTS):
                        files.append((e.name, int(e.stat().st_mtime * 1000)))   # no extra disk read on Windows
            hit = _folders[folder] = (stamp, files, subs)
    except OSError:   # missing or just deleted
        _folders.pop(folder, None)
        return
    yield folder, hit[1]
    for s in hit[2]:
        yield from _walk(s)


def list_images():
    with _lock:
        meta = _read()["images"]
    out = []
    for d, files in (w for r in ROOTS for w in _walk(r)):
        sub = os.path.relpath(d, OUT).replace("\\", "/")
        for f, t in files:
            m = meta.get(sub + "/" + f, {})
            out.append({"filename": f, "subfolder": sub, "time": t,
                        "fav": bool(m.get("fav")), "mode": m.get("mode")})
    out.sort(key=lambda x: -x["time"])
    return out


def mark(image, mode=None, fav=None):
    """Remember the workspace a picture was made in, and/or star it."""
    if not _file(image):
        return None
    k = key(image)
    with _lock:
        data = _read()
        meta = data["images"]
        m = meta.get(k, {})
        if mode in MODES:
            m["mode"] = mode
        if fav is not None:
            if fav:
                m["fav"] = True
            else:
                m.pop("fav", None)
        meta[k] = m
        _write(data)
    return m


def delete(images):
    gone = []
    for image in images[:1000]:
        path = _file(image)
        if not path:
            continue
        if os.path.isfile(path):
            os.remove(path)
        gone.append(key(image))
    if gone:
        with _lock:
            data = _read()
            for k in gone:
                data["images"].pop(k, None)
            for st in data["sets"]:
                st["images"] = [k for k in st["images"] if k not in gone]
            _write(data)
        charlib.drop_images(gone, key)
        storylib.drop_images(gone, key)
        chatlib.drop_images(gone, key)
        mangalib.drop_images(gone, key)
    return gone


def list_sets():
    with _lock:
        return _read()["sets"]


def save_set(set_id, name, mode):
    """Make a new set (no id) or rename one. Returns the set, or None for an unknown id."""
    name = " ".join(str(name or "").split())[:60] or "Untitled set"
    with _lock:
        data = _read()
        if set_id:
            st = next((x for x in data["sets"] if x["id"] == set_id), None)
            if st is None:
                return None
            st["name"] = name
        else:
            st = {"id": "set%x" % time.time_ns(), "name": name, "mode": mode if mode in MODES else "adult", "images": []}
            data["sets"].append(st)
        _write(data)
    return st


def delete_set(set_id):
    """Forget the set; its pictures stay on disk."""
    with _lock:
        data = _read()
        data["sets"] = [x for x in data["sets"] if x["id"] != set_id]
        _write(data)


def export_set(set_id):
    """Clean copies of a set's pictures in output/Patreon-export/<set name>/<set name>_01.png…, to share.
    Only the pixels are kept (as RGB, so no alpha-channel tricks): no prompt, workflow, model or LoRA names, and new
    file names, since ComfyUI's can name the LoRA. Returns {folder, count}, or None for an unknown set."""
    ex = _export_target(set_id)
    if ex is None:
        return None
    base, folder, files = ex
    for f in os.listdir(folder):   # drop an older export of this set (it may have had more pictures)
        if re.fullmatch(re.escape(base) + r"_\d+\.png", f):
            os.remove(os.path.join(folder, f))
    for i, path in enumerate(files, 1):
        with Image.open(path) as im:
            im.convert("RGB").save(os.path.join(folder, f"{base}_{i:02d}.png"), compress_level=4)
    return {"folder": folder, "count": len(files)}


def export_prompts(set_id):
    """<set name>_prompts.txt next to the clean copies: one cleaned prompt per picture, numbered like the copies
    (promptclean drops artist tags, model tags and LoRA words). Returns {file, count, found}, or None for an unknown set."""
    ex = _export_target(set_id)
    if ex is None:
        return None
    base, folder, files = ex
    words = promptclean.secret_words()
    lines, found = [], 0
    for i, path in enumerate(files, 1):
        with open(path, "rb") as f:
            prompt = imageinfo.analyze(f.read())["prompt"].split("\n\n")[0]
        text = promptclean.clean(prompt, words) if prompt else ""
        found += bool(text)
        lines.append(f"{base}_{i:02d}:\n{text or '(no prompt saved in this picture)'}\n")
    out = os.path.join(folder, f"{base}_prompts.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return {"file": out, "count": len(files), "found": found}


def _export_target(set_id):
    """(file-name base, export folder, the set's picture paths oldest first) for a set, or None."""
    with _lock:
        sets = _read()["sets"]
    st = next((x for x in sets if x["id"] == set_id), None)
    if st is None:
        return None
    slug = lambda s: re.sub(r"[^\w-]+", "_", s["name"]).strip("_")[:40] or "set"
    base = slug(st)
    # Two sets with the same cleaned name ("Raiden", "Raiden!") would share a folder and delete each other's export.
    if any(x["id"] != set_id and slug(x) == base for x in sets):
        base = f"{base}_{re.sub(r'[^\w-]+', '', str(set_id))[:12]}"
    folder = os.path.join(EXPORT, base)
    os.makedirs(folder, exist_ok=True)
    files = [p for p in (_file({"filename": os.path.basename(k), "subfolder": os.path.dirname(k)}) for k in st["images"]) if p and os.path.isfile(p)]
    return base, folder, files[::-1]   # sets list newest first; number them oldest first


def set_images(set_id, images, add=True):
    """Put pictures into a set (newest first) or take them out. Returns the set, or None for an unknown id."""
    keys = [key(im) for im in images[:1000] if _file(im)]
    with _lock:
        data = _read()
        st = next((x for x in data["sets"] if x["id"] == set_id), None)
        if st is None:
            return None
        if add:
            st["images"] = [k for k in keys if k not in st["images"]] + st["images"]
        else:
            st["images"] = [k for k in st["images"] if k not in set(keys)]
        _write(data)
    return st
