# Stories: a novel told in 100+ images of one character, planned chapter by chapter by the prompt writer.
# One JSON file per story in ComfyUI's user folder, shared by every Kōbō window and device. Story images
# stay out of the character's gallery (it keeps only the last 300 and feeds "Learn this character").
import json
import os
import re
import threading
import time
import uuid

import folder_paths

from .llm import BLOCKED_TAGS

DIR = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-stories")
MODES = ("general", "adult", "story")
LEVELS = ("safe", "spicy", "nude", "strip")
MAX_CHAPTERS, MAX_SCENES, MAX_VARIANTS = 41, 300, 12

_lock = threading.Lock()


def _id(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())[:16]


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _prompt(value, limit):
    # Comma-separated pieces that are blocked tags are dropped, whether the prompt is tags or sentences.
    parts = [p.strip() for p in str(value or "").split(",")]
    return ", ".join(p for p in parts if p and p.lower().replace("_", " ") not in BLOCKED_TAGS)[:limit]


def _image(value):
    if not isinstance(value, dict) or not value.get("filename"):
        return None
    return {"filename": _text(value["filename"], 200), "subfolder": _text(value.get("subfolder"), 200), "type": "output"}


def _path(sid):
    return os.path.join(DIR, sid + ".json")


def _read(sid):
    try:
        with open(_path(sid), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(story):
    os.makedirs(DIR, exist_ok=True)
    tmp = _path(story["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(story, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(story["id"]))


def _clean(s, stored=None):
    stored = stored or {}
    # Images (several variants per scene, one picked) only come from add_image() and set_pick(), matched by scene id,
    # so a save from the editor never loses a finished image.
    images = {sc["id"]: (sc.get("images", []), sc.get("pick", 0)) for ch in stored.get("chapters", []) for sc in ch.get("scenes", [])}
    workspace = s.get("workspace") if s.get("workspace") in MODES else stored.get("workspace", "adult")
    level = s.get("level") if s.get("level") in LEVELS else "safe"
    if workspace == "general":   # the General workspace never gets nudity
        level = "safe"
    chapters, total = [], 0
    for c in (s.get("chapters") or [])[:MAX_CHAPTERS]:
        if not isinstance(c, dict):
            continue
        scenes = []
        for sc in (c.get("scenes") or [])[:MAX_SCENES - total]:
            if not isinstance(sc, dict):
                continue
            sid = _id(sc.get("id")) or uuid.uuid4().hex[:10]
            imgs, pick = images.get(sid, ([], 0))
            scenes.append({"id": sid, "text": _text(sc.get("text"), 600), "prompt": _prompt(sc.get("prompt"), 1200), "wide": bool(sc.get("wide")),
                           "stage": sc["stage"] if sc.get("stage") in (1, 2, 3) else 0, "images": imgs, "pick": pick})
        total += len(scenes)
        try:
            want = max(1, min(20, int(c.get("want") or len(scenes) or 10)))
        except (TypeError, ValueError):
            want = 10
        chapters.append({"cover": bool(c.get("cover")) and not chapters, "title": _text(c.get("title"), 120), "setting": _text(c.get("setting"), 300),
                         "outfit": "" if level == "nude" else _prompt(c.get("outfit"), 400),
                         "summary": _text(c.get("summary"), 600), "want": want, "scenes": scenes})
    now = int(time.time() * 1000)
    return {
        "id": _id(s.get("id")) or uuid.uuid4().hex[:12],
        "charId": _id(s.get("charId")) or stored.get("charId", ""),
        "costarId": _id(s.get("costarId")),
        "workspace": workspace,
        "level": level,
        "target": _text(s.get("target"), 20),
        "title": _text(s.get("title"), 120) or "Untitled story",
        "premise": _text(s.get("premise"), 2000),
        "gen": _gen(s.get("gen")),
        "chapters": chapters,
        "created": stored.get("created", now),
        "updated": now,
    }


def _gen(g):
    """How the Story workspace renders it: model, versions per scene, portrait/landscape mix, Keep face."""
    g = g if isinstance(g, dict) else {}
    try:
        variants = max(1, min(4, int(g.get("variants") or 1)))
    except (TypeError, ValueError):
        variants = 1
    return {"engine": g.get("engine") if g.get("engine") in ("anima", "sdxl") else "anima", "model": _text(g.get("model"), 200),
            "variants": variants, "mix": g.get("mix") is not False, "face": g.get("face") is not False}


def picked(sc):
    imgs = sc.get("images") or []
    return imgs[min(max(0, sc.get("pick", 0)), len(imgs) - 1)]["image"] if imgs else None


def _summary(s):
    scenes = [sc for ch in s.get("chapters", []) for sc in ch.get("scenes", [])]
    cover = next((picked(sc) for sc in scenes if sc.get("images")), None)
    return {"id": s["id"], "charId": s.get("charId"), "workspace": s.get("workspace"), "level": s.get("level"), "title": s.get("title"),
            "chapters": len(s.get("chapters", [])), "scenes": len(scenes), "done": sum(1 for sc in scenes if sc.get("images")),
            "want": sum(ch.get("want", 0) for ch in s.get("chapters", [])), "cover": cover, "updated": s.get("updated", 0)}


def list_stories(char_id, workspace):
    out = []
    with _lock:
        if os.path.isdir(DIR):
            for name in os.listdir(DIR):
                if name.endswith(".json"):
                    s = _read(name[:-5])
                    if s and (not char_id or s.get("charId") == char_id) and s.get("workspace") == workspace:
                        out.append(_summary(s))
    return sorted(out, key=lambda x: -x["updated"])


def get(sid):
    with _lock:
        return _read(_id(sid))


def upsert(s):
    with _lock:
        stored = _read(_id(s.get("id"))) if _id(s.get("id")) else None
        clean = _clean(s, stored)
        if not clean["charId"]:
            raise ValueError("A story needs a character")
        _write(clean)
        return clean


def delete(sid):
    with _lock:
        try:
            os.remove(_path(_id(sid)))
            return True
        except OSError:
            return False


def _scene(s, scene_id):
    return next((sc for ch in s.get("chapters", []) for sc in ch.get("scenes", []) if sc.get("id") == _id(scene_id)), None)


def add_image(sid, scene_id, image, seed=None):
    """One more variant of a scene; the first one is picked until you pick another."""
    image = _image(image)
    with _lock:
        s = _read(_id(sid))
        sc = s and image and _scene(s, scene_id)
        if not sc:
            return None
        imgs = [x for x in sc.get("images", []) if x["image"] != image]
        sc["images"] = (imgs + [{"image": image, "seed": seed if isinstance(seed, int) else None}])[-MAX_VARIANTS:]
        sc["pick"] = min(sc.get("pick", 0), len(sc["images"]) - 1)
        s["updated"] = int(time.time() * 1000)
        _write(s)
        return sc


def drop_images(keys, key):
    """Forget pictures deleted in the Images tab (key() turns an image dict into one of keys)."""
    keys = set(keys)
    with _lock:
        if not os.path.isdir(DIR):
            return
        for name in os.listdir(DIR):
            s = name.endswith(".json") and _read(name[:-5])
            if not s:
                continue
            changed = False
            for ch in s.get("chapters", []):
                for sc in ch.get("scenes", []):
                    kept = [x for x in sc.get("images", []) if key(x["image"]) not in keys]
                    if len(kept) != len(sc.get("images", [])):
                        cur = picked(sc)
                        sc["images"], changed = kept, True
                        sc["pick"] = next((i for i, x in enumerate(kept) if x["image"] == cur), 0)
            if changed:
                _write(s)


def set_pick(sid, scene_id, pick):
    with _lock:
        s = _read(_id(sid))
        sc = s and _scene(s, scene_id)
        if not sc or not sc.get("images"):
            return None
        sc["pick"] = max(0, min(int(pick), len(sc["images"]) - 1))
        _write(s)
        return sc
