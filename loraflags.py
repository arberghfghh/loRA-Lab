# Manual Adult/General overrides, activation words and default strengths for LoRAs, shared by every Kōbō window and device.
import json
import os
import threading

import folder_paths

PATH = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-lora-flags.json")
FLAGS = {"adult", "general"}
_lock = threading.Lock()


def _read(for_write=False):
    if os.path.exists(PATH):
        try:
            with open(PATH, encoding="utf-8") as f:
                data = json.load(f)
            flags = {str(k)[:260]: v for k, v in data.get("flags", {}).items() if isinstance(v, str) and v in FLAGS}
            words = {str(k)[:260]: str(v)[:80] for k, v in data.get("words", {}).items() if str(v).strip()}
            # Strength used when nothing else sets one (e.g. a LoRA switched on by its activation word).
            strengths = {str(k)[:260]: float(v) for k, v in data.get("strengths", {}).items() if isinstance(v, (int, float))}
            return flags, words, strengths
        except (OSError, ValueError, AttributeError, TypeError) as e:
            # Reading can show nothing, but a save must not overwrite a file we couldn't read (e.g. a hand-edit typo).
            if for_write:
                raise ValueError(f"{os.path.basename(PATH)} can't be read ({e}); fix or delete it, nothing was changed") from e
    return {}, {}, {}


def _write(flags, words, strengths):
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    data = {"flags": flags, "words": words, "strengths": strengths}
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PATH)
    return data


def _name(name):
    name = str(name or "")[:260]
    if not name:
        raise ValueError("Missing LoRA name")
    return name


def load():
    with _lock:
        flags, words, strengths = _read()
        return {"flags": flags, "words": words, "strengths": strengths}


def set_flag(name, flag):
    name = _name(name)
    with _lock:
        flags, words, strengths = _read(for_write=True)
        if flag in FLAGS:
            flags[name] = flag
        else:
            flags.pop(name, None)   # back to automatic
        return _write(flags, words, strengths)


# The word that switches the LoRA on when it is in a prompt; empty = back to the one in the file (if any).
def set_word(name, word):
    name = _name(name)
    word = " ".join(str(word or "").split())[:80]
    with _lock:
        flags, words, strengths = _read(for_write=True)
        if word:
            words[name] = word
        else:
            words.pop(name, None)
        return _write(flags, words, strengths)
