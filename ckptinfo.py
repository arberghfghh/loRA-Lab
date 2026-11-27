# Checkpoint families (sd15 / sdxl / other), read from each .safetensors header so SD1.5 and SDXL
# checkpoints land in the right model list. Only the JSON header is read, never the weights.
import json
import logging
import os
import struct

import folder_paths

_cache = {}   # path -> (mtime, size, family)


def _family(path):
    if not path.lower().endswith(".safetensors"):
        return "other"
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > 100_000_000:
            return "other"
        keys = json.loads(f.read(n)).keys()
    if any(k.startswith("conditioner.embedders.1.") for k in keys):
        return "sdxl"
    if any(k.startswith("cond_stage_model.transformer.") for k in keys):
        return "sd15"   # SD1.x uses OpenAI CLIP-L here; SD2 uses cond_stage_model.model.*
    return "other"


def families():
    out = {}
    for name in folder_paths.get_filename_list("checkpoints"):
        path = folder_paths.get_full_path("checkpoints", name)
        if not path:
            continue
        try:
            st = os.stat(path)
            hit = _cache.get(path)
            if not hit or hit[:2] != (st.st_mtime, st.st_size):
                hit = _cache[path] = (st.st_mtime, st.st_size, _family(path))
            out[name] = hit[2]
        except Exception:
            logging.exception("[Kobo] couldn't read checkpoint header: %s", name)
            out[name] = "other"
    return out
