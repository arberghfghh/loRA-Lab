"""Workflow tab: the one folder the user gives it access to.

In that folder:  *.txt  -> ideas, one per non-empty line
                 *.md   -> notes the AI writer and reviewer follow
                 images -> can be picked as the reference image
                 approved/ -> approved final pictures are copied here
Only this folder (top level, plus approved/) is ever read or written.
"""
import json
import os
import re
import shutil

import folder_paths

SETTINGS = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-workflow.json")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
APPROVED = "approved"
MAX_IDEAS = 500
MAX_NOTES = 4000   # characters of notes handed to the AI; small local models lose track beyond this


def get_folder():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            path = json.load(f).get("folder") or ""
    except (OSError, ValueError):
        return ""
    return path if os.path.isdir(path) else ""


def set_folder(path):
    path = os.path.abspath(os.path.expanduser(str(path or "").strip().strip('"')))
    if not os.path.isdir(path):
        raise ValueError("That folder doesn't exist")
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump({"folder": path}, f)
    return path


def _files(folder, exts):
    return sorted(n for n in os.listdir(folder) if n.lower().endswith(exts) and os.path.isfile(os.path.join(folder, n)))


def _read(path, limit):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read(limit)


def contents(folder):
    """{folder, ideas: [{file, text}], images: [name], notes: str} for the page."""
    if not folder:
        return {"folder": "", "ideas": [], "images": [], "notes": ""}
    ideas = []
    for name in _files(folder, (".txt",)):
        for line in _read(os.path.join(folder, name), 200_000).splitlines():
            line = " ".join(line.split())
            if line and len(ideas) < MAX_IDEAS:
                ideas.append({"file": name, "text": line[:800]})
    notes = "\n\n".join(f"[{n}]\n{_read(os.path.join(folder, n), MAX_NOTES).strip()}" for n in _files(folder, (".md",)))
    return {"folder": folder, "ideas": ideas, "images": _files(folder, IMAGE_EXTS), "notes": notes[:MAX_NOTES]}


def image_path(folder, name):
    """Only an image that is listed in the folder itself: no paths, no other files."""
    if not folder or name not in _files(folder, IMAGE_EXTS):
        return None
    return os.path.join(folder, name)


def set_name(text):
    """A safe folder name for a set: letters, digits, spaces, - and _ only."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w \-]", "", str(text or ""))).strip(" .")[:60]


def save_approved(folder, image, output_dir, group=""):
    """Copy one finished picture from ComfyUI's output folder into <folder>/approved/ (or approved/<set>/)."""
    if not folder:
        raise ValueError("Pick a folder first")
    out = os.path.abspath(output_dir)
    src = os.path.abspath(os.path.join(out, str(image.get("subfolder") or ""), os.path.basename(str(image.get("filename") or ""))))
    if not src.startswith(out + os.sep) or not os.path.isfile(src) or not src.lower().endswith(IMAGE_EXTS):
        raise ValueError("Unknown picture")
    dest_dir = os.path.join(folder, APPROVED, *([set_name(group)] if set_name(group) else []))
    os.makedirs(dest_dir, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(src))
    dest, n = os.path.join(dest_dir, base + ext), 1
    while os.path.exists(dest):   # never overwrite a picture already there
        dest, n = os.path.join(dest_dir, f"{base}_{n}{ext}"), n + 1
    shutil.copy2(src, dest)
    return os.path.basename(dest)
