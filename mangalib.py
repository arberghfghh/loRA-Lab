# Manga: black-and-white pages of panels with speech bubbles. The writer plans the story (who is in it, one line per
# page), then writes each page as panels (shot, picture, narration, dialogue); the page draws every panel and letters it.
# One JSON file per manga in ComfyUI's user folder. Panel pictures only change through add_image / drop_image (and the
# Images tab), so a page save from an older window can't lose them.
import json
import os
import re
import threading
import time
import uuid

import folder_paths

DIR = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-manga")
KINDS = ("speech", "thought", "shout", "whisper")
MAX_PAGES, MAX_PANELS = 40, 6

_lock = threading.Lock()


def _id(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())[:16]


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _num(value, lo, hi, default):
    try:
        return min(hi, max(lo, float(value)))
    except (TypeError, ValueError):
        return default


def _path(mid):
    return os.path.join(DIR, mid + ".json")


def _read(mid):
    try:
        with open(_path(mid), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(m):
    os.makedirs(DIR, exist_ok=True)
    tmp = _path(m["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(m["id"]))


def _image(im):
    return {"filename": _text(im.get("filename"), 200), "subfolder": _text(im.get("subfolder"), 300), "type": "output",
            "seed": im.get("seed") if isinstance(im.get("seed"), int) else 0}


def _bubble(b):
    """Where a speech bubble sits, as a fraction of its panel (moved by dragging it on the page)."""
    if not isinstance(b, dict) or b.get("x") is None:
        return None
    return {"x": _num(b.get("x"), 0, 1, 0.5), "y": _num(b.get("y"), 0, 1, 0.2)}


def _panel(p, stored):
    key = _id(p.get("key")) or uuid.uuid4().hex[:8]
    old = stored.get(key) or {}
    images = old.get("images", [])
    lines = [{"who": _text(d.get("who"), 60), "text": _text(d.get("text"), 400), "kind": d.get("kind") if d.get("kind") in KINDS else "speech",
              "at": _bubble(d.get("at"))}
             for d in p.get("dialogue") or [] if isinstance(d, dict) and _text(d.get("text"), 400)][:6]
    return {"key": key, "shot": _text(p.get("shot"), 60), "count": _text(p.get("count"), 60), "idea": _text(p.get("idea"), 1200),
            "caption": _text(p.get("caption"), 400), "captionAt": _bubble(p.get("captionAt")), "dialogue": lines,
            "prompt": _text(p.get("prompt"), 3000), "images": images,
            "pick": int(_num(p.get("pick"), 0, max(0, len(images) - 1), 0)),
            "focus": {"x": _num((p.get("focus") or {}).get("x"), 0, 1, 0.5), "y": _num((p.get("focus") or {}).get("y"), 0, 1, 0.3)}}


def _clean(m, stored):
    now = int(time.time() * 1000)
    old_panels = {p["key"]: p for pg in (stored or {}).get("pages", []) for p in pg.get("panels", [])}
    pages = []
    for pg in (m.get("pages") if isinstance(m.get("pages"), list) else [])[:MAX_PAGES]:
        if not isinstance(pg, dict):
            continue
        panels = [_panel(p, old_panels) for p in pg.get("panels") or [] if isinstance(p, dict)][:MAX_PANELS]
        pages.append({"key": _id(pg.get("key")) or uuid.uuid4().hex[:8], "summary": _text(pg.get("summary"), 1000),
                      "layout": int(_num(pg.get("layout"), 0, 20, 0)), "panels": panels})
    return {
        "id": _id(m.get("id")) or uuid.uuid4().hex[:12],
        # Set once: a manga made in the General workspace stays safe for work.
        "workspace": stored["workspace"] if stored else "adult" if m.get("workspace") == "adult" else "general",
        "title": _text(m.get("title"), 120) or "Untitled manga",
        "idea": _text(m.get("idea"), 2000),
        "genre": _text(m.get("genre"), 80),
        "pageCount": int(_num(m.get("pageCount"), 1, MAX_PAGES, 6)),
        "rtl": bool(m.get("rtl", True)),
        "style": _text(m.get("style"), 300),
        # The user's own characters (Characters tab) in it; the writer invents the rest and gives everyone look tags.
        "cast": [{"id": _id(c.get("id")), "name": _text(c.get("name"), 60), "sex": c.get("sex") if c.get("sex") in ("1girl", "1boy") else "",
                  "about": _text(c.get("about"), 600), "player": bool(c.get("player"))}
                 for c in m.get("cast") or [] if isinstance(c, dict) and c.get("name")][:8],
        "looks": _text(m.get("looks"), 3000),
        "outline": [_text(x, 600) for x in (m.get("outline") if isinstance(m.get("outline"), list) else [])][:MAX_PAGES],
        "pages": pages,
        "created": stored["created"] if stored else now,
        "updated": now,
    }


def list_mangas(workspace):
    """The General workspace lists only its own manga; Adult and Story list all of them."""
    out = []
    with _lock:
        for name in os.listdir(DIR) if os.path.isdir(DIR) else []:
            m = name.endswith(".json") and _read(name[:-5])
            if m and (workspace != "general" or m["workspace"] == "general"):
                panels = [p for pg in m["pages"] for p in pg["panels"]]
                cover = next((p["images"][p["pick"]] for p in panels if p["images"]), None)
                out.append({"id": m["id"], "workspace": m["workspace"], "title": m["title"], "idea": m["idea"], "genre": m["genre"],
                            "pages": len(m["pages"]), "panels": len(panels), "drawn": sum(1 for p in panels if p["images"]),
                            "cover": cover, "updated": m["updated"]})
    return sorted(out, key=lambda x: -x["updated"])


def get(mid):
    with _lock:
        return _read(_id(mid))


def upsert(m):
    with _lock:
        clean = _clean(m, _read(_id(m.get("id"))) if _id(m.get("id")) else None)
        _write(clean)
        return clean


def delete(mid):
    with _lock:
        try:
            os.remove(_path(_id(mid)))
            return True
        except OSError:
            return False


def _find(m, key):
    return next((p for pg in m["pages"] for p in pg["panels"] if p["key"] == key), None)


def add_image(mid, key, image, seed=0):
    with _lock:
        m = _read(_id(mid))
        p = m and _find(m, _id(key))
        if not p or not isinstance(image, dict) or not image.get("filename"):
            return None
        im = _image(dict(image, seed=seed if isinstance(seed, int) else 0))
        if not any(x["filename"] == im["filename"] and x["subfolder"] == im["subfolder"] for x in p["images"]):
            p["images"].append(im)
            p["pick"] = len(p["images"]) - 1
        _write(m)
        return p


def drop_image(mid, key, index):
    with _lock:
        m = _read(_id(mid))
        p = m and _find(m, _id(key))
        if not p:
            return None
        if 0 <= index < len(p["images"]):
            p["images"].pop(index)
            p["pick"] = min(p["pick"], max(0, len(p["images"]) - 1))
            _write(m)
        return p


def drop_images(keys, key):
    """Forget pictures deleted in the Images tab (key() turns an image dict into one of keys)."""
    keys = set(keys)
    with _lock:
        for name in os.listdir(DIR) if os.path.isdir(DIR) else []:
            m = name.endswith(".json") and _read(name[:-5])
            if not m:
                continue
            changed = False
            for pg in m["pages"]:
                for p in pg["panels"]:
                    kept = [im for im in p["images"] if key(im) not in keys]
                    if len(kept) != len(p["images"]):
                        p["images"], p["pick"], changed = kept, min(p["pick"], max(0, len(kept) - 1)), True
            if changed:
                _write(m)
