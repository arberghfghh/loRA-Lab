# Character chat: characters you talk to, each with any number of chats. One JSON file per character in ComfyUI's
# user folder, shared by every Kōbō window and device. The page edits only the character sheet (save()); messages
# are added by the server as they are sent and written (add_message()), and "learned" is the memory the writer builds
# from the chats (llm.learn_from_chat), which every new chat with the character starts from.
import json
import os
import re
import threading
import time
import uuid

import folder_paths

DIR = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-chat")
MAX_CHATS, MAX_MESSAGES = 60, 600

_lock = threading.Lock()


def _id(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())[:16]


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _path(cid):
    return os.path.join(DIR, cid + ".json")


def _read(cid):
    try:
        with open(_path(cid), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(c):
    os.makedirs(DIR, exist_ok=True)
    c["updated"] = int(time.time() * 1000)
    tmp = _path(c["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(c["id"]))


def _chat(c, chat_id):
    return next((x for x in c.get("chats", []) if x["id"] == _id(chat_id)), None)


def pending(c):
    """Messages not learned from yet, over all of the character's chats."""
    return sum(len(x["messages"]) - x.get("learned", 0) for x in c.get("chats", []))


def list_characters(workspace):
    """The General workspace lists only its own characters; Adult and Story list all of them."""
    out = []
    with _lock:
        if os.path.isdir(DIR):
            for name in os.listdir(DIR):
                c = name.endswith(".json") and _read(name[:-5])
                if c and (workspace != "general" or c["workspace"] == "general"):
                    last = max(c["chats"], key=lambda x: x["updated"]) if c["chats"] else None
                    out.append({"id": c["id"], "workspace": c["workspace"], "name": c["name"], "charId": c["charId"],
                                "persona": c["persona"][:200], "chats": len(c["chats"]), "updated": c["updated"],
                                "last": last["messages"][-1]["text"][:140] if last and last["messages"] else ""})
    return sorted(out, key=lambda x: -x["updated"])


def get(cid):
    with _lock:
        return _read(_id(cid))


def save(c):
    """Create or edit a character sheet; the chats always stay as the server has them."""
    with _lock:
        stored = _read(_id(c.get("id"))) if _id(c.get("id")) else None
        now = int(time.time() * 1000)
        clean = {
            "id": stored["id"] if stored else uuid.uuid4().hex[:12],
            # Set once: a character made in the General workspace stays safe for work.
            "workspace": stored["workspace"] if stored else "adult" if c.get("workspace") == "adult" else "general",
            "name": _text(c.get("name"), 60) or "Unnamed",
            "charId": _id(c.get("charId")),       # a character from the Characters tab: their picture, look and memory
            "persona": _text(c.get("persona"), 4000),
            "greeting": _text(c.get("greeting"), 2000),
            "you": _text(c.get("you"), 60),       # what the character calls the user
            # Only sent when edited by hand, so an older copy in the page never undoes what the chats taught them.
            "learned": _text(c["learned"], 6000) if "learned" in c else stored["learned"] if stored else "",
            "chats": stored["chats"] if stored else [],
            "created": stored["created"] if stored else now,
            "updated": now,
        }
        _write(clean)
        return clean


def delete(cid):
    with _lock:
        try:
            os.remove(_path(_id(cid)))
            return True
        except OSError:
            return False


def new_chat(cid):
    with _lock:
        c = _read(_id(cid))
        if not c:
            return None
        now = int(time.time() * 1000)
        chat = {"id": uuid.uuid4().hex[:12], "title": time.strftime("%d %b %Y, %H:%M"), "messages": [], "learned": 0, "created": now, "updated": now}
        if c["greeting"]:
            chat["messages"].append({"role": "char", "text": c["greeting"], "time": now})
            chat["learned"] = 1   # the greeting is the user's own text, nothing to learn from
        c["chats"] = (c["chats"] + [chat])[-MAX_CHATS:]
        _write(c)
        return chat


def edit_chat(cid, chat_id, title=None, delete=False):
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        if not chat:
            return False
        if delete:
            c["chats"].remove(chat)
        elif title is not None:
            chat["title"] = _text(title, 80) or chat["title"]
        _write(c)
        return True


def add_message(cid, chat_id, role, text):
    """Append one message; returns (character, chat) or (None, None) for an unknown chat."""
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        text = _text(text, 8000)
        if not chat or not text or role not in ("user", "char"):
            return None, None
        chat["messages"].append({"role": role, "text": text, "time": int(time.time() * 1000)})
        drop = max(0, len(chat["messages"]) - MAX_MESSAGES)
        chat["messages"], chat["learned"] = chat["messages"][drop:], max(0, chat.get("learned", 0) - drop)
        chat["updated"] = chat["messages"][-1]["time"]
        _write(c)
        return c, chat


def cut(cid, chat_id, keep):
    """Keep only the first `keep` messages of a chat (delete a message and everything after it, or retry a reply)."""
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        if not chat:
            return None, None
        chat["messages"] = chat["messages"][:max(0, int(keep))]
        chat["learned"] = min(chat.get("learned", 0), len(chat["messages"]))
        _write(c)
        return c, chat


def unlearned(c):
    """[(chat id, start, messages)] for every chat with messages not learned from yet, oldest chat first."""
    return [(x["id"], x.get("learned", 0), x["messages"][x.get("learned", 0):])
            for x in sorted(c.get("chats", []), key=lambda x: x["created"]) if len(x["messages"]) > x.get("learned", 0)]


def set_learned(cid, learned, upto):
    """Store the new memory; upto = {chat id: number of messages it covers}. A chat cut shorter meanwhile stays covered."""
    with _lock:
        c = _read(_id(cid))
        if not c:
            return None
        c["learned"] = _text(learned, 6000)
        for chat in c["chats"]:
            if chat["id"] in upto:
                chat["learned"] = min(len(chat["messages"]), max(chat.get("learned", 0), upto[chat["id"]]))
        _write(c)
        return c


# ---------- picture story: a chat retold as a few illustrated scenes ----------
# chat["story"] = {"style", "looks", "scenes": [{key, caption, idea, prompt, images, pick}]}. The writer plans the scenes
# (set_story), the page edits the text (save_story) and each finished picture is added with add_story_image, so a save
# from a page that missed a finished image never loses it.
def _image(im):
    return {"filename": _text(im.get("filename"), 200), "subfolder": _text(im.get("subfolder"), 300), "type": "output",
            "seed": im.get("seed") if isinstance(im.get("seed"), int) else 0}


def _story(chat):
    return chat.setdefault("story", {"style": "", "looks": "", "scenes": []})


def _scene(chat, key):
    return next((s for s in _story(chat)["scenes"] if s["key"] == key), None)


def set_story(cid, chat_id, looks, scenes, style=None):
    """A new plan replaces the scenes (their pictures stay in the Images tab)."""
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        if not chat:
            return None
        story = _story(chat)
        if style is not None:
            story["style"] = _text(style, 200)
        story["looks"] = _text(looks, 2000)
        story["scenes"] = [{"key": f"s{i + 1}", "caption": _text(s.get("caption"), 600), "idea": _text(s.get("idea"), 800),
                            "count": _text(s.get("count"), 60), "prompt": "", "images": [], "pick": 0} for i, s in enumerate(scenes[:30])]
        _write(c)
        return story


def save_story(cid, chat_id, body):
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        if not chat:
            return None
        story = _story(chat)
        for k, limit in (("style", 200), ("looks", 2000)):
            if k in body:
                story[k] = _text(body[k], limit)
        for s in body.get("scenes") or []:
            have = isinstance(s, dict) and _scene(chat, s.get("key"))
            if not have:
                continue
            for k, limit in (("caption", 600), ("idea", 800), ("count", 60), ("prompt", 3000)):
                if k in s:
                    have[k] = _text(s[k], limit)
            try:
                have["pick"] = max(0, min(int(s.get("pick", have["pick"])), max(0, len(have["images"]) - 1)))
            except (TypeError, ValueError):
                pass
        _write(c)
        return story


def add_story_image(cid, chat_id, key, image, seed=0):
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        scene = chat and _scene(chat, key)
        if not scene or not isinstance(image, dict) or not image.get("filename"):
            return None
        im = _image(dict(image, seed=seed if isinstance(seed, int) else 0))
        if not any(x["filename"] == im["filename"] and x["subfolder"] == im["subfolder"] for x in scene["images"]):
            scene["images"].append(im)
            scene["pick"] = len(scene["images"]) - 1
        _write(c)
        return scene


def drop_story_image(cid, chat_id, key, index):
    with _lock:
        c = _read(_id(cid))
        chat = c and _chat(c, chat_id)
        scene = chat and _scene(chat, key)
        if not scene or not 0 <= index < len(scene["images"]):
            return None
        scene["images"].pop(index)
        scene["pick"] = min(scene["pick"], max(0, len(scene["images"]) - 1))
        _write(c)
        return scene


def drop_images(keys, key):
    """Forget pictures deleted in the Images tab (key() turns an image dict into one of keys)."""
    keys = set(keys)
    with _lock:
        for name in os.listdir(DIR) if os.path.isdir(DIR) else []:
            c = name.endswith(".json") and _read(name[:-5])
            if not c:
                continue
            changed = False
            for chat in c["chats"]:
                for s in (chat.get("story") or {}).get("scenes") or []:
                    kept = [im for im in s["images"] if key(im) not in keys]
                    if len(kept) != len(s["images"]):
                        s["images"], s["pick"], changed = kept, min(s["pick"], max(0, len(kept) - 1)), True
            if changed:
                _write(c)
