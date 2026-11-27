# Novels: an outline (premise, characters, chapter plan) and then the chapters as prose, written one at a time by the
# prompt writer. Text only. One JSON file per novel in ComfyUI's user folder, shared by every Kōbō window and device.
import json
import os
import re
import threading
import time
import uuid

import folder_paths

from .llm import NOVEL_LENGTHS

DIR = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-novels")

_lock = threading.Lock()


def _id(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())[:16]


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _path(nid):
    return os.path.join(DIR, nid + ".json")


def _read(nid):
    try:
        with open(_path(nid), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _clean(n, stored):
    now = int(time.time() * 1000)
    chapters = n.get("chapters") if isinstance(n.get("chapters"), list) else []
    return {
        "id": _id(n.get("id")) or uuid.uuid4().hex[:12],
        # Set once: a novel made in the General workspace stays safe for work.
        "workspace": stored["workspace"] if stored else "adult" if n.get("workspace") == "adult" else "general",
        "title": _text(n.get("title"), 120) or "Untitled novel",
        "idea": _text(n.get("idea"), 2000),
        "genre": _text(n.get("genre"), 80),
        "tone": _text(n.get("tone"), 120),
        "length": n.get("length") if n.get("length") in NOVEL_LENGTHS else "medium",
        "pov": n.get("pov") if n.get("pov") in ("first", "third") else "third",
        # The user's own characters ticked for this novel; "player" is the main character.
        "cast": [{"name": _text(c.get("name"), 60), "sex": c.get("sex") if c.get("sex") in ("1girl", "1boy") else "",
                  "about": _text(c.get("about"), 600), "player": bool(c.get("player"))}
                 for c in n.get("cast") or [] if isinstance(c, dict) and c.get("name")][:8],
        "outline": _text(n.get("outline"), 20000),
        "chapters": [{"title": _text(c.get("title"), 160), "summary": _text(c.get("summary"), 1500), "text": _text(c.get("text"), 60000)}
                     for c in chapters if isinstance(c, dict)][:40],
        "created": stored["created"] if stored else now,
        "updated": now,
    }


def list_novels(workspace):
    """The General workspace lists only its own novels; Adult and Story list all of them."""
    out = []
    with _lock:
        if os.path.isdir(DIR):
            for name in os.listdir(DIR):
                n = name.endswith(".json") and _read(name[:-5])
                if n and (workspace != "general" or n["workspace"] == "general"):
                    out.append({"id": n["id"], "workspace": n["workspace"], "title": n["title"], "idea": n["idea"], "genre": n["genre"],
                                "chapters": len(n["chapters"]), "written": sum(1 for c in n["chapters"] if c["text"]),
                                "words": sum(len(c["text"].split()) for c in n["chapters"]), "updated": n["updated"]})
    return sorted(out, key=lambda x: -x["updated"])


def get(nid):
    with _lock:
        return _read(_id(nid))


def upsert(n):
    with _lock:
        clean = _clean(n, _read(_id(n.get("id"))) if _id(n.get("id")) else None)
        os.makedirs(DIR, exist_ok=True)
        tmp = _path(clean["id"]) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(clean, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _path(clean["id"]))
        return clean


def delete(nid):
    with _lock:
        try:
            os.remove(_path(_id(nid)))
            return True
        except OSError:
            return False
