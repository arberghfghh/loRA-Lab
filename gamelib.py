# Game stories: the script of a game (overview, world, characters, main story, quests, dialogue), written part by part
# by the prompt writer. Text only. One JSON file per game in ComfyUI's user folder, shared by every Kōbō window and device.
import json
import os
import re
import threading
import time
import uuid

import folder_paths

from .gameparse import ART_KINDS, art_items
from .llm import GAME_PARTS, GAME_SIZES

DIR = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-games")

_lock = threading.Lock()


def _id(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())[:16]


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _path(gid):
    return os.path.join(DIR, gid + ".json")


def _read(gid):
    try:
        with open(_path(gid), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _image(im):
    return {"filename": _text(im.get("filename"), 200), "subfolder": _text(im.get("subfolder"), 300), "type": "output",
            "seed": im.get("seed") if isinstance(im.get("seed"), int) else 0}


def _clean_art(art, stored):
    """The game's pictures (title, cast, places, scenes). Their images only change through add_art_image and
    drop_art_image, so a save from a page that missed a finished image never loses it."""
    have = {a["key"]: a for a in (stored or {}).get("art") or []}
    out = []
    for a in art if isinstance(art, list) else []:
        if not isinstance(a, dict) or not a.get("key") or a.get("kind") not in ART_KINDS:
            continue
        key = _text(a["key"], 80)
        images = have[key]["images"] if key in have else [_image(i) for i in a.get("images") or [] if isinstance(i, dict) and i.get("filename")]
        try:
            pick = int(a.get("pick") or 0)
        except (TypeError, ValueError):
            pick = 0
        out.append({"key": key, "kind": a["kind"], "name": _text(a.get("name"), 120), "role": _text(a.get("role"), 120),
                    "who": [_text(x, 60) for x in a.get("who") or []][:4], "idea": _text(a.get("idea"), 3000),
                    "count": _text(a.get("count"), 40),
                    "prompt": _text(a.get("prompt"), 4000), "charId": _text(a.get("charId"), 40), "images": images,
                    "pick": min(max(0, pick), max(0, len(images) - 1))})
    return out[:120]


def _clean(g, stored):
    parts = g.get("parts") if isinstance(g.get("parts"), dict) else {}
    now = int(time.time() * 1000)
    return {
        "id": _id(g.get("id")) or uuid.uuid4().hex[:12],
        # Set once: a game made in the General workspace stays safe for work.
        "workspace": stored["workspace"] if stored else "adult" if g.get("workspace") == "adult" else "general",
        "title": _text(g.get("title"), 120) or "Untitled game",
        "idea": _text(g.get("idea"), 2000),
        "genre": _text(g.get("genre"), 80),
        "tone": _text(g.get("tone"), 120),
        "size": g.get("size") if g.get("size") in GAME_SIZES else "medium",
        "parts": {k: _text(parts.get(k), 20000) for k in GAME_PARTS},
        # The user's own characters ticked for this game: the writer uses them, their pictures use their look.
        "cast": [{"id": _text(c.get("id"), 40), "name": _text(c.get("name"), 60), "sex": c.get("sex") if c.get("sex") in ("1girl", "1boy") else "",
                  "about": _text(c.get("about"), 600), "player": bool(c.get("player"))}
                 for c in g.get("cast") or [] if isinstance(c, dict) and c.get("name")][:8],
        "style": _text(g.get("style"), 200),
        "art": _clean_art(g.get("art"), stored),
        # The linked RPG Maker project only changes through set_rpg (the page may hold an older copy of the game).
        "rpg": (stored.get("rpg") or {}) if stored else {},
        "created": stored["created"] if stored else now,
        "updated": now,
    }


def list_games(workspace):
    """The General workspace lists only its own games; Adult and Story list all of them."""
    out = []
    with _lock:
        if os.path.isdir(DIR):
            for name in os.listdir(DIR):
                g = name.endswith(".json") and _read(name[:-5])
                if g and (workspace != "general" or g["workspace"] == "general"):
                    out.append({"id": g["id"], "workspace": g["workspace"], "title": g["title"], "idea": g["idea"], "genre": g["genre"],
                                "size": g["size"], "written": sum(1 for t in g["parts"].values() if t), "updated": g["updated"]})
    return sorted(out, key=lambda x: -x["updated"])


def get(gid):
    with _lock:
        return _read(_id(gid))


def upsert(g):
    with _lock:
        clean = _clean(g, _read(_id(g.get("id"))) if _id(g.get("id")) else None)
        _save(clean)
        return clean


def delete(gid):
    with _lock:
        try:
            os.remove(_path(_id(gid)))
            return True
        except OSError:
            return False


def _save(g):
    os.makedirs(DIR, exist_ok=True)
    tmp = _path(g["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(g, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(g["id"]))


def plan_art(gid):
    """(Re)reads the story into its list of pictures; pictures still in the story keep their prompt, character and images."""
    with _lock:
        g = _read(_id(gid))
        if not g:
            return None
        have = {a["key"]: a for a in g.get("art") or []}
        # A new picture of one of the user's own characters (or a scene with one) is drawn with that character.
        mine = {}
        for c in g.get("cast") or []:
            if c.get("id"):
                mine.setdefault(c["name"].split()[0].lower(), c["id"])   # the writer sometimes adds a surname
                mine[c["name"].lower()] = c["id"]
        names = lambda item: [item["name"]] if item["kind"] == "cast" else item.get("who") or []
        own = lambda item: next((mine.get(n.lower()) or mine.get(n.split()[0].lower()) for n in names(item)
                                 if mine.get(n.lower()) or mine.get(n.split()[0].lower())), "")
        art = []
        for item in art_items(g):
            old = have.get(item["key"])
            art.append(dict(item, prompt=old["prompt"] if old else "", charId=old.get("charId", "") if old else own(item),
                            images=old["images"] if old else [], pick=old["pick"] if old else 0))
        # Pictures of parts that left the story stay at the end while they have images, so nothing drawn is lost.
        keys = {a["key"] for a in art}
        art += [a for a in g.get("art") or [] if a["key"] not in keys and a["images"]]
        g["art"] = _clean_art(art, g)
        g["updated"] = int(time.time() * 1000)
        _save(g)
        return g


def _art(g, key):
    return next((a for a in (g or {}).get("art") or [] if a["key"] == key), None)


def add_art_image(gid, key, image, seed=0):
    with _lock:
        g = _read(_id(gid))
        item = _art(g, key)
        if not item or not isinstance(image, dict) or not image.get("filename"):
            return None
        im = _image(dict(image, seed=seed if isinstance(seed, int) else 0))
        if not any(x["filename"] == im["filename"] and x["subfolder"] == im["subfolder"] for x in item["images"]):
            item["images"].append(im)
            item["pick"] = len(item["images"]) - 1
        _save(g)
        return item


def drop_art_image(gid, key, index):
    with _lock:
        g = _read(_id(gid))
        item = _art(g, key)
        if not item or not 0 <= index < len(item["images"]):
            return None
        item["images"].pop(index)
        item["pick"] = min(item["pick"], max(0, len(item["images"]) - 1))
        _save(g)
        return item


def set_rpg(gid, rpg):
    with _lock:
        g = _read(_id(gid))
        if not g:
            return None
        g["rpg"] = rpg or {}
        _save(g)
        return g


def all_games():
    with _lock:
        return [g for g in (_read(n[:-5]) for n in (os.listdir(DIR) if os.path.isdir(DIR) else []) if n.endswith(".json")) if g]
