# Merge LoRAs into one LoRA file by stacking their ranks: the new LoRA at strength 1 changes the model exactly as the
# sources did together at their weights. No base model or GPU needed; the file is as big as the sources added up.
import json
import os
import re

import torch
import safetensors.torch
from safetensors import safe_open

import folder_paths

# Down/up names ComfyUI reads; each layer keeps the naming its source file used.
PAIRS = ((".lora_down.weight", ".lora_up.weight"), (".lora_A.weight", ".lora_B.weight"),
         (".lora.down.weight", ".lora.up.weight"), ("_lora.down.weight", "_lora.up.weight"))
MAX_SOURCES = 8
# Same rule as classify() in web/index.html, so a merge can never hide a LoRA the page blocks.
BLOCKED = {"Dart-sarada.safetensors"}
CHILD_TAGS = {"loli", "lolicon", "shota", "shotacon", "child", "kid", "toddler", "aged down", "oppai loli", "cub", "underage"}
CHILD_SHARE = 0.05
# Details about one source's training; the rest of the first source's metadata (its model type) is kept.
DROP_META = {"ss_tag_frequency", "ss_num_train_images", "ss_training_comment", "lora_lab_trigger", "ss_output_name",
             "ss_network_dim", "ss_network_alpha", "merge_sources", "sshs_model_hash", "sshs_legacy_hash",
             "modelspec.title", "modelspec.hash_sha256"}


def _norm(tag):
    return re.sub(r"\s+", " ", str(tag).lower().replace("_", " ")).strip()


def _tag_counts(meta):
    try:
        freq = json.loads(meta.get("ss_tag_frequency") or "{}")
    except ValueError:
        return {}
    tot = {}
    for ds in freq.values() if isinstance(freq, dict) else ():
        for t, c in ds.items() if isinstance(ds, dict) else ():
            if str(t).strip() and isinstance(c, (int, float)):
                tot[str(t).strip()] = tot.get(str(t).strip(), 0) + c
    return tot


def _images(meta, tot):
    try:
        n = int(meta.get("ss_num_train_images") or 0)
    except ValueError:
        n = 0
    return n or max([1, *tot.values()])


def is_blocked(name, meta):
    tot = _tag_counts(meta)
    child = max([0, *(c for t, c in tot.items() if _norm(t) in CHILD_TAGS)])
    return os.path.basename(name) in BLOCKED or child / _images(meta, tot) >= CHILD_SHARE


def _modules(sd, name):
    """{(layer, down suffix, up suffix): (down, up, alpha)}; refuses files with parts that can't be stacked."""
    mods, used = {}, set()
    for k in sd:
        for d, u in PAIRS:
            base = k[:-len(d)]
            if k.endswith(d) and base + u in sd:
                alpha = sd.get(base + ".alpha")
                key = (base, d, u)
                if base.startswith("diffusion_model."):   # ComfyUI's lora_unet_<path, dots as _> for the same layer
                    key = ("lora_unet_" + base[len("diffusion_model."):].replace(".", "_"), *PAIRS[0])
                mods[key] = (sd[k], sd[base + u], float(sd[k].shape[0]) if alpha is None else float(alpha))
                used |= {k, base + u, base + ".alpha"}
                break
    extra = [k for k in sd if k not in used]
    if extra:
        raise ValueError(f"{name} isn't a plain LoRA (it has parts like '{extra[0]}'). "
                         "LoHa, LoKr, DoRA and similar can't be merged this way.")
    if not mods:
        raise ValueError(f"{name} doesn't look like a LoRA.")
    return mods


def merge_state_dicts(sources):
    """[(name, state_dict, weight)] -> one LoRA state_dict. Each layer's ranks are put side by side, with each source's
    weight * alpha / rank folded into its up matrix and alpha = the new rank, so the changes add up exactly."""
    parts = [(name, _modules(sd, name), w) for name, sd, w in sources]
    for i, (a, ma, _) in enumerate(parts):
        for b, mb, _ in parts[i + 1:]:
            if not ma.keys() & mb.keys():
                raise ValueError(f"{a} and {b} share no layers: they're for different model types or saved in different formats.")
    # The smallest precision any source uses (often fp16/bf16), so one float32 source doesn't double the file.
    dtype = min((next(iter(mods.values()))[1].dtype for _, mods, _ in parts), key=lambda t: t.itemsize)
    out = {}
    for key in sorted(set().union(*(m.keys() for _, m, _ in parts))):
        base, d, u = key
        downs, ups = [], []
        for _, mods, w in parts:
            if key in mods:
                down, up, alpha = mods[key]
                downs.append(down.float())
                ups.append(up.float() * (w * alpha / down.shape[0]))
        try:
            out[base + d] = torch.cat(downs, 0).to(dtype).contiguous()
            out[base + u] = torch.cat(ups, 1).to(dtype).contiguous()
        except RuntimeError:
            raise ValueError(f"These LoRAs don't fit together at {base}: they're for different model types.") from None
        out[base + ".alpha"] = torch.tensor(float(out[base + d].shape[0]))
    return out


def merge_metadata(sources, metas):
    """The first source's model-type info plus every source's training tags, so Kōbō sorts the merge like its sources."""
    typed = next((m for m in metas if m.get("ss_base_model_version") or m.get("modelspec.architecture")), metas[0])
    meta = {k: v for k, v in typed.items() if k not in DROP_META}
    freq, counts = {}, []
    for (name, _, _), m in zip(sources, metas):
        try:
            ds = json.loads(m.get("ss_tag_frequency") or "{}")
        except ValueError:
            ds = {}
        for d, tags in ds.items() if isinstance(ds, dict) else ():
            freq[f"{name}/{d}"] = tags
        tot = _tag_counts(m)
        if tot:
            counts.append(_images(m, tot))
    if freq:
        meta["ss_tag_frequency"] = json.dumps(freq)
    if counts:   # the fewest images of any source: a tag's share can only rise, so an adult source keeps the merge adult
        meta["ss_num_train_images"] = str(min(counts))
    meta["merge_sources"] = json.dumps([{"name": n, "weight": w, **({"sources": m["merge_sources"]} if m.get("merge_sources") else {})}
                                        for (n, _, w), m in zip(sources, metas)])
    return meta


def _weight(name, value):
    try:
        w = float(value)
    except (TypeError, ValueError):
        w = float("nan")
    if not -2 <= w <= 3 or w == 0:
        raise ValueError(f"{name}: strength must be between -2 and 3, and not 0.")
    return w


def merge(loras, name):
    """[{"name", "weight"}] from the page -> the new file's name in models/loras."""
    if not isinstance(loras, list) or not 2 <= len(loras) <= MAX_SOURCES:
        raise ValueError(f"Pick 2 to {MAX_SOURCES} LoRAs to merge.")
    stem = re.sub(r"[^\w\- ]", "_", str(name or "")).strip()[:80]
    if not stem:
        raise ValueError("Give the merged LoRA a name.")
    known = set(folder_paths.get_filename_list("loras"))
    out_name = stem + ".safetensors"
    out_path = os.path.join(folder_paths.get_folder_paths("loras")[0], out_name)
    if out_name in known or os.path.exists(out_path):
        raise ValueError(f"A LoRA called {out_name} already exists; pick another name.")
    sources, metas = [], []
    for item in loras:
        n = str((item or {}).get("name") or "") if isinstance(item, dict) else ""
        if n not in known:   # only files ComfyUI lists, so no paths outside models/loras
            raise ValueError(f"LoRA not found: {n}")
        if not n.lower().endswith(".safetensors"):
            raise ValueError(f"{n} isn't a .safetensors file.")
        path = folder_paths.get_full_path("loras", n)
        with safe_open(path, "pt") as f:
            meta = f.metadata() or {}
        if is_blocked(n, meta):
            raise ValueError(f"{n} is blocked in Kōbō, so it can't be merged.")
        sources.append((n, safetensors.torch.load_file(path), _weight(n, item.get("weight"))))
        metas.append(meta)
    merged = merge_state_dicts(sources)
    tmp = out_path + ".tmp"
    safetensors.torch.save_file(merged, tmp, metadata=merge_metadata(sources, metas))
    os.replace(tmp, out_path)
    return out_name
