# 🔍 Image info: how a picture was made, read from what the app left inside the file.
# Knows ComfyUI (Kōbō), AUTOMATIC1111 / Forge / SD.Next / Civitai, NovelAI (also its hidden copy in the alpha channel,
# which survives a Photoshop save), Fooocus, InvokeAI, SwarmUI, Midjourney, and Content Credentials (ChatGPT, Firefly...).
import gzip
import io
import json
import re

import numpy as np
from PIL import Image

MODEL_EXT = re.compile(r"\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$", re.I)
TEXT_KEYS = ("text", "text_g", "text_l", "t5xxl", "clip_l", "prompt", "positive", "negative", "wildcard_text", "populated_text",
             "string", "value", "text_a", "text_b", "string_a", "string_b", "user_prompt", "system_prompt")
SETTING_KEYS = {"seed": "seed", "noise_seed": "seed", "steps": "steps", "cfg": "cfg", "guidance": "guidance", "sampler_name": "sampler",
                "scheduler": "scheduler", "denoise": "denoise", "width": "width", "height": "height"}

# A1111 / NovelAI sampler names -> ComfyUI's.
A1111_SAMPLERS = {"euler a": "euler_ancestral", "euler": "euler", "heun": "heun", "lms": "lms", "dpm2": "dpm_2", "dpm2 a": "dpm_2_ancestral",
                  "dpm++ 2s a": "dpmpp_2s_ancestral", "dpm++ 2m": "dpmpp_2m", "dpm++ sde": "dpmpp_sde", "dpm++ 2m sde": "dpmpp_2m_sde",
                  "dpm++ 3m sde": "dpmpp_3m_sde", "dpm fast": "dpm_fast", "dpm adaptive": "dpm_adaptive", "ddim": "ddim", "unipc": "uni_pc",
                  "lcm": "lcm", "ddpm": "ddpm", "euler cfg++": "euler_cfg_pp", "euler a cfg++": "euler_ancestral_cfg_pp", "deis": "deis",
                  "res multistep": "res_multistep", "er sde": "er_sde"}
A1111_SCHEDULERS = {"karras": "karras", "exponential": "exponential", "sgm uniform": "sgm_uniform", "simple": "simple", "normal": "normal",
                    "beta": "beta", "ddim": "ddim_uniform", "automatic": None}
NAI_SAMPLERS = {"k_euler_ancestral": "euler_ancestral", "k_euler": "euler", "k_dpmpp_2m": "dpmpp_2m", "k_dpmpp_2s_ancestral": "dpmpp_2s_ancestral",
                "k_dpmpp_sde": "dpmpp_sde", "k_dpmpp_2m_sde": "dpmpp_2m_sde", "ddim_v3": "ddim", "ddim": "ddim"}

# Content Credentials (C2PA) and IPTC markers: which AI service a picture came from when there are no settings to read.
C2PA_NAMES = [(b"ChatGPT", "ChatGPT (OpenAI)"), (b"OpenAI", "OpenAI (ChatGPT / DALL-E / Sora)"), (b"DALL", "DALL-E (OpenAI)"),
              (b"Adobe Firefly", "Adobe Firefly"), (b"Firefly", "Adobe Firefly"), (b"Google", "Google (Gemini / Imagen)"),
              (b"Gemini", "Google Gemini"), (b"Imagen", "Google Imagen"), (b"Microsoft", "Microsoft (Bing / Copilot / Designer)"),
              (b"Bing Image Creator", "Bing Image Creator"), (b"Midjourney", "Midjourney"), (b"Meta AI", "Meta AI"), (b"Grok", "Grok (xAI)"),
              (b"Leonardo", "Leonardo.Ai"), (b"Ideogram", "Ideogram"), (b"Canva", "Canva"), (b"Stability", "Stability AI")]


def _info():
    return {"software": [], "edited": [], "notes": [], "models": [], "loras": [], "files": [], "prompt": "", "negative": "",
            "characters": [], "settings": {}, "apply": {}, "raw": {}}


def _add(lst, item):
    if item and item not in lst:
        lst.append(item)


def _num(v):
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 4)
    except (TypeError, ValueError):
        return v


# ---------- AUTOMATIC1111 / Forge / SD.Next / Civitai "parameters" text ----------
def _split_params(line):
    # "Steps: 30, Sampler: Euler a, Lora hashes: "a: 1, b: 2", ..." -> pairs; quoted values may contain commas,
    # and Civitai writes its resource list as bare JSON.
    civitai = r"(Civitai resources|Civitai metadata):\s*(\[.*?\]|\{.*?\})(?=,\s*[A-Z][\w ]*:|\s*$),?"
    pairs = [(m.group(1), m.group(2)) for m in re.finditer(civitai, line)]
    line = re.sub(civitai, "", line)
    return pairs + re.findall(r'\s*([\w \-/+.()]+?):\s*("(?:\\.|[^"])*"|[^,]*)(?:,|$)', line)


def parse_a1111(text, info):
    lines = text.strip().split("\n")
    params_i = next((i for i in range(len(lines) - 1, -1, -1) if re.match(r"\s*Steps:\s*\d+", lines[i])), None)
    params = {}
    if params_i is not None:
        for k, v in _split_params(lines[params_i]):
            v = v.strip()
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1].replace('\\"', '"')
            params[k.strip()] = v
        body = lines[:params_i]
    else:
        body = lines
    body = "\n".join(body)
    prompt, _, neg = body.partition("Negative prompt:")
    info["prompt"], info["negative"] = prompt.strip(), neg.strip()
    info["raw"]["parameters"] = text

    ver = params.get("Version", "")
    if ver.startswith("f") or "forge" in ver.lower() or "neo" in ver.lower():
        app = "Stable Diffusion WebUI Forge"
    elif "Civitai" in text and ("Civitai resources" in params or "Civitai metadata" in params):
        app = "Civitai (online generator or AUTOMATIC1111-style app)"
    elif ver:
        app = "AUTOMATIC1111 Stable Diffusion WebUI"
    else:
        app = "AUTOMATIC1111-style app (A1111, Forge, SD.Next, Civitai...)"
    _add(info["software"], app + (f" ({ver})" if ver else ""))

    if params.get("Model"):
        _add(info["models"], {"name": params["Model"], "hash": params.get("Model hash", ""), "kind": "checkpoint"})
    elif params.get("Model hash"):
        _add(info["models"], {"name": "", "hash": params["Model hash"], "kind": "checkpoint"})
    for name, w in re.findall(r"<(?:lora|lyco):([^:>]+):?([-\d.]*)[^>]*>", info["prompt"], re.I):
        _add(info["loras"], {"name": name, "strength": _num(w or 1)})
    if params.get("Civitai resources"):
        try:
            for r in json.loads(params["Civitai resources"]):
                name = r.get("modelName") or r.get("name") or ""
                label = f'{name} ({r["modelVersionName"]})' if r.get("modelVersionName") else name
                if r.get("type", "").lower() in ("lora", "locon", "lycoris", "dora"):
                    if not any(l["name"].lower() == name.lower() for l in info["loras"]):
                        _add(info["loras"], {"name": label, "strength": _num(r.get("weight", 1)), "civitai": r.get("modelVersionId")})
                elif r.get("type", "").lower() == "checkpoint":
                    if not info["models"]:
                        _add(info["models"], {"name": label, "kind": "checkpoint", "civitai": r.get("modelVersionId")})
                else:
                    _add(info["files"], {"kind": r.get("type", "resource"), "name": label})
        except (ValueError, TypeError, AttributeError):
            pass
    if params.get("VAE"):
        _add(info["files"], {"kind": "VAE", "name": params["VAE"]})
    for k in ("ADetailer model", "ADetailer model 2nd", "Hires upscaler", "ControlNet 0", "ControlNet 1"):
        if params.get(k):
            _add(info["files"], {"kind": k, "name": params[k][:120]})

    s = info["settings"]
    sampler = params.get("Sampler", "")
    sched = params.get("Schedule type", "")
    for word in ("Karras", "Exponential", "SGM Uniform"):   # older A1111 put the schedule in the sampler name
        if sampler.endswith(" " + word):
            sampler, sched = sampler[:-len(word) - 1], sched or word
    for key, label in (("Steps", "steps"), ("CFG scale", "cfg"), ("Seed", "seed"), ("Denoising strength", "denoise"),
                       ("Clip skip", "clip skip"), ("Hires upscale", "hires upscale"), ("Hires steps", "hires steps"),
                       ("Distilled CFG Scale", "guidance")):
        if params.get(key):
            s[label] = _num(params[key])
    if sampler:
        s["sampler"] = sampler
    if sched:
        s["scheduler"] = sched
    if params.get("Size") and "x" in params["Size"]:
        w, h = params["Size"].split("x", 1)
        s["size"] = f"{w}×{h}"
        info["apply"].update(width=_num(w), height=_num(h))
    a = info["apply"]
    no_lora = re.sub(r"\s*<(?:lora|lyco):[^>]+>", "", info["prompt"])
    a.update(prompt=re.sub(r"\s*,[\s,]*", ", ", no_lora).strip(" ,"), negative=info["negative"], settings=True)
    for k in ("steps", "cfg", "seed"):
        if k in s:
            a[k] = s[k]
    if sampler.lower() in A1111_SAMPLERS:
        a["sampler"] = A1111_SAMPLERS[sampler.lower()]
    if sched.lower() in A1111_SCHEDULERS and A1111_SCHEDULERS[sched.lower()]:
        a["scheduler"] = A1111_SCHEDULERS[sched.lower()]
    extra = {k: v for k, v in params.items() if k not in ("Steps", "Sampler", "Schedule type", "CFG scale", "Seed", "Size", "Model", "Model hash",
                                                         "Version", "Denoising strength", "Civitai resources", "Civitai metadata", "VAE", "Clip skip",
                                                         "Distilled CFG Scale", "Hires steps", "Hires upscale", "Hires upscaler")}
    for k, v in list(extra.items())[:25]:
        s.setdefault(k.lower(), v[:160])


# ---------- ComfyUI (Kōbō draws through ComfyUI too) ----------
def _resolve_text(graph, ref, seen, depth=0):
    """A text input is either a string or a link to the node that makes it (primitive, concatenate, wildcard...)."""
    if isinstance(ref, str):
        return [ref] if ref.strip() else []
    if not (isinstance(ref, list) and len(ref) == 2) or depth > 8 or str(ref[0]) in seen:
        return []
    seen.add(str(ref[0]))
    node = graph.get(str(ref[0])) or {}
    out = []
    for k, v in (node.get("inputs") or {}).items():
        if k in TEXT_KEYS or k.startswith(("text", "string", "prompt")):
            out += _resolve_text(graph, v, seen, depth + 1)
    return out


def _cond_texts(graph, ref, seen, depth=0):
    """Walk back from a sampler's positive/negative input to every text that feeds it."""
    if not (isinstance(ref, list) and len(ref) == 2) or depth > 12 or str(ref[0]) in seen:
        return []
    seen.add(str(ref[0]))
    node = graph.get(str(ref[0])) or {}
    texts = []
    for k, v in (node.get("inputs") or {}).items():
        if k in TEXT_KEYS or k.startswith(("text", "prompt")):
            texts += _resolve_text(graph, v, set())
        elif isinstance(v, list) and len(v) == 2 and k not in ("clip", "model", "vae", "image", "pixels", "samples", "latent", "mask",
                                                                "control_net", "clip_vision", "style_model", "vae_model"):
            texts += _cond_texts(graph, v, seen, depth + 1)
    return texts


def _value(graph, v, depth=0):
    """A setting that's linked to a primitive / seed node: follow it to the number."""
    while isinstance(v, list) and len(v) == 2 and depth < 6:
        node = graph.get(str(v[0])) or {}
        ins = node.get("inputs") or {}
        v = next((ins[k] for k in ("seed", "noise_seed", "value", "int", "float", "number", "steps", "cfg", "sampler_name", "scheduler")
                  if k in ins), None)
        depth += 1
    return v


def parse_comfy_prompt(graph, info):
    info["graph"] = graph   # Fix face redraws with the picture's own model, LoRAs and prompts
    _add(info["software"], "ComfyUI")
    if any("LoRA-Lab" in str((n.get("inputs") or {}).get("filename_prefix", "")) for n in graph.values()):
        info["software"][-1] = "Kōbō (ComfyUI)"
    s, a = info["settings"], info["apply"]
    pos, neg = [], []
    for nid, node in graph.items():
        ct, ins = node.get("class_type", ""), node.get("inputs") or {}
        for k, v in ins.items():
            if isinstance(v, dict) and v.get("lora") and v.get("on", True):   # rgthree Power Lora Loader rows
                _add(info["loras"], {"name": v["lora"], "strength": _num(v.get("strength", 1))})
            if not (isinstance(v, str) and MODEL_EXT.search(v)):
                continue
            if "lora" in k.lower() or "lora" in ct.lower():
                if "lora" in k.lower():
                    st = next((ins[x] for x in ("strength_model", "strength", "lora_strength", "model_weight") if x in ins), 1)
                    _add(info["loras"], {"name": v, "strength": _num(_value(graph, st))})
            elif k in ("ckpt_name", "unet_name", "model_path") or (k == "model_name" and "upscale" not in ct.lower()):
                _add(info["models"], {"name": v, "kind": "diffusion model" if k == "unet_name" else "checkpoint", "loader": ct})
            elif k.startswith("clip_name") or "text_encoder" in k:
                _add(info["files"], {"kind": "Text encoder", "name": v})
            elif k == "vae_name":
                _add(info["files"], {"kind": "VAE", "name": v})
            elif "control" in k:
                _add(info["files"], {"kind": "ControlNet", "name": v})
            elif "upscale" in ct.lower():
                _add(info["files"], {"kind": "Upscaler", "name": v})
            else:
                _add(info["files"], {"kind": f"{ct} · {k}", "name": v})
        if "positive" in ins or "negative" in ins or "conditioning" in ins and ("Guider" in ct or "Sampler" in ct):
            pos += _cond_texts(graph, ins.get("positive", ins.get("conditioning")), set())
            neg += _cond_texts(graph, ins.get("negative"), set())
        for k, label in SETTING_KEYS.items():
            if k in ins and ("Sampler" in ct or "Scheduler" in ct or "Noise" in ct or "Guider" in ct or "Latent" in ct or "Guidance" in ct
                             or k in ("seed", "noise_seed", "sampler_name")):
                v = _value(graph, ins[k])
                if v is not None and not isinstance(v, (list, dict)):
                    prev = s.get(label)
                    s[label] = v if prev in (None, v) else f"{prev} → {v}"
                    a.setdefault(label, v)
    # Images with no sampler wired to a text node (e.g. a Klein reference edit) still show every text box.
    if not pos and not neg:
        for node in graph.values():
            if "TextEncode" in node.get("class_type", "") or "Prompt" in node.get("class_type", ""):
                pos += [t for k, v in (node.get("inputs") or {}).items() if k in TEXT_KEYS for t in _resolve_text(graph, v, set())]
    # Kōbō's two-people prompts (Prompt Control "scene COUPLE(0 0.5) left COUPLE(0.5 1) right") read as one prompt.
    flat = lambda t: re.sub(r",(\s*,)+", ",", re.sub(r"\s*\bCOUPLE(?:\([^)]*\))?\s*", ", ", t))
    dedup = lambda xs: list(dict.fromkeys(flat(t).strip() for t in xs if t.strip()))
    pos, neg = dedup(pos), [t for t in dedup(neg) if t not in pos]
    info["prompt"], info["negative"] = "\n\n".join(pos), "\n\n".join(neg)
    if "width" in s and "height" in s:
        s["size"] = f'{s.pop("width")}×{s.pop("height")}'
    a.update(prompt=pos[0] if pos else "", negative=neg[0] if neg else "", settings=True)
    if a.get("denoise") == 1:
        a.pop("denoise")


def parse_comfy_workflow(wf, info):
    """Only the editor workflow was saved (no API prompt): list its files and text boxes."""
    _add(info["software"], "ComfyUI")
    for node in wf.get("nodes", []):
        t, vals = node.get("type", ""), node.get("widgets_values")
        if not isinstance(vals, list):
            continue
        for i, v in enumerate(vals):
            if isinstance(v, str) and MODEL_EXT.search(v):
                if "lora" in t.lower():
                    st = vals[i + 1] if i + 1 < len(vals) and isinstance(vals[i + 1], (int, float)) else 1
                    _add(info["loras"], {"name": v, "strength": _num(st)})
                elif "Checkpoint" in t or "UNET" in t or "Unet" in t:
                    _add(info["models"], {"name": v, "kind": "checkpoint", "loader": t})
                else:
                    _add(info["files"], {"kind": t, "name": v})
            elif isinstance(v, str) and "TextEncode" in t and v.strip():
                _add(info["characters"], v.strip())
            elif isinstance(v, dict) and v.get("lora") and v.get("on", True):
                _add(info["loras"], {"name": v["lora"], "strength": _num(v.get("strength", 1))})
        if t == "KSampler" and len(vals) >= 7:
            info["settings"].update(seed=vals[0], steps=vals[2], cfg=vals[3], sampler=vals[4], scheduler=vals[5], denoise=vals[6])
    if info["characters"]:
        info["notes"].append("Only the ComfyUI editor workflow was saved, so it can't tell which text box was the positive and which the negative prompt: all of them are listed under Text boxes.")


# ---------- NovelAI ----------
def nai_to_sd(text):
    """NovelAI emphasis -> (tag:weight). {x} is ×1.05 per brace, [x] ÷1.05; "1.3::x::" sets a weight; negative weights move to the negative."""
    moved = []

    def weighted(m):
        w, body = float(m.group(1)), m.group(2).strip(" ,")
        if w < 0:
            moved.append(body)
            return ""
        return f"({body}:{round(w, 2)})" if body else ""
    text = re.sub(r"(-?\d+(?:\.\d+)?)::(.*?)(?:::|$)", weighted, text, flags=re.S)

    def braces(m):
        opened = m.group(1)
        n = len(opened) * (1 if opened[0] == "{" else -1)
        body = m.group(2).strip(" ,")
        return f"({body}:{round(1.05 ** n, 2)})" if body else ""
    for _ in range(3):
        text = re.sub(r"(\{+|\[+)([^{}\[\]]*)[}\]]+", braces, text)
    text = re.sub(r"\bartist:\s*", "", text)
    text = re.sub(r"\)(?=\w)", "), ", text)
    text = re.sub(r"\s*,[\s,]*", ", ", text)
    text = re.sub(r"\(([^():]+)\)", r"\\(\1\\)", text)   # NovelAI's ( ) are plain text, e.g. "kurenaiz (kuayrenaiz)"
    return re.sub(r"\s+", " ", text).strip(" ,"), moved


def parse_novelai(d, info, where):
    c = d.get("Comment")
    c = json.loads(c) if isinstance(c, str) else (c or {})
    source = d.get("Source") or c.get("model_name") or "NovelAI"
    _add(info["software"], "NovelAI" + (" (read from the hidden copy in the picture's transparency channel)" if where == "stealth" else ""))
    _add(info["models"], {"name": source, "hash": c.get("model_hash", ""), "kind": "NovelAI model (online only, can't be downloaded)"})
    info["prompt"] = c.get("prompt") or d.get("Description") or ""
    info["negative"] = c.get("uc", "")
    for ch in ((c.get("v4_prompt") or {}).get("caption") or {}).get("char_captions", []):
        pos = (ch.get("centers") or [{}])[0]
        info["characters"].append(ch.get("char_caption", "") + (f'  (placed at x {pos.get("x")}, y {pos.get("y")})' if pos else ""))
    for ch in ((c.get("v4_negative_prompt") or {}).get("caption") or {}).get("char_captions", []):
        if ch.get("char_caption", "").strip():
            info["characters"].append("Negative: " + ch["char_caption"])
    s = info["settings"]
    for k, label in (("seed", "seed"), ("steps", "steps"), ("scale", "cfg"), ("cfg_rescale", "cfg rescale"), ("sampler", "sampler"),
                     ("noise_schedule", "scheduler"), ("strength", "img2img strength"), ("noise", "img2img noise")):
        if c.get(k) not in (None, "") and (c[k] != 0 or k == "seed"):
            s[label] = _num(c[k])
    if c.get("width"):
        s["size"] = f'{c["width"]}×{c["height"]}'
    if c.get("upscaled_enhance") or c.get("upscaled_width"):
        s["finished with"] = f'NovelAI Upscale/Enhance to {c.get("upscaled_width")}×{c.get("upscaled_height")}'
    if c.get("request_type"):
        s["request"] = c["request_type"]
    if c.get("sm") or c.get("sm_dyn"):
        s["smea"] = "SMEA DYN" if c.get("sm_dyn") else "SMEA"
    if d.get("Generation time"):
        s["generation time"] = f'{float(d["Generation time"]):.1f} s'
    refs = sum(len(c.get(k) or []) for k in ("reference_information_extracted_multiple", "director_reference_descriptions") if isinstance(c.get(k), list))
    if refs:
        info["notes"].append(f"Used {refs} vibe-transfer / character reference image(s), which aren't stored in the file.")
    if c.get("lora_unet_weights"):
        info["notes"].append("NovelAI LoRA weights were set.")
    else:
        info["notes"].append("NovelAI has no LoRA support for users: no LoRA was used.")
    info["raw"]["novelai"] = {**{k: v for k, v in d.items() if k != "Comment"}, "Comment": c}

    pos, moved = nai_to_sd(info["prompt"])
    chars = []
    for ch in ((c.get("v4_prompt") or {}).get("caption") or {}).get("char_captions", []):
        t, m = nai_to_sd(ch.get("char_caption", ""))
        chars.append(re.sub(r"^(girl|boy|other)\s*,\s*", "", t))
        moved += m
    negs, m2 = nai_to_sd(info["negative"])
    neg = ", ".join(dict.fromkeys(x.strip() for x in (moved + [negs]) if x.strip()))
    info["apply"] = {"prompt": ", ".join(x for x in [pos] + chars if x), "negative": neg, "settings": False}
    if c.get("width"):
        info["apply"].update(width=c["width"], height=c["height"])
    info["apply"]["converted"] = "NovelAI {braces} and n::weights:: were turned into (tag:weight) for Illustrious / NoobAI / Pony."


def read_stealth(im):
    """NovelAI (and the A1111 'stealth pnginfo' extension) hide the settings in the lowest bit of each pixel, column by column."""
    if im.format not in ("PNG", "WEBP") or im.mode not in ("RGBA", "RGB"):
        return None
    a = np.asarray(im)
    for chans, magic_set in ((a[..., 3:4] if a.ndim == 3 and a.shape[2] == 4 else None, (b"stealth_pnginfo", b"stealth_pngcomp")),
                             (a[..., :3] if a.ndim == 3 else None, (b"stealth_rgbinfo", b"stealth_rgbcomp"))):
        if chans is None:
            continue
        bits = (chans.transpose(1, 0, 2) & 1).reshape(-1)
        head = np.packbits(bits[:15 * 8]).tobytes()
        if head not in magic_set:
            continue
        p = 15 * 8
        n = int("".join(map(str, bits[p:p + 32])), 2)
        p += 32
        if n <= 0 or p + n > bits.size:
            return None
        data = np.packbits(bits[p:p + n]).tobytes()
        if head.endswith(b"comp"):
            data = gzip.decompress(data)
        return data.decode("utf-8", "replace")
    return None


# ---------- EXIF / XMP / Content Credentials ----------
def _exif_texts(im):
    out = {}
    try:
        ex = im.getexif()
    except Exception:
        return out
    tags = dict(ex)
    try:
        tags.update(ex.get_ifd(0x8769))
    except Exception:
        pass
    for tag, name in ((0x9286, "UserComment"), (0x010E, "ImageDescription"), (0x010F, "Make"), (0x0110, "Model"), (0x0131, "Software"),
                      (0x013B, "Artist")):
        v = tags.get(tag)
        if v is None:
            continue
        if isinstance(v, bytes):
            head, body = v[:8], v[8:] if v[:8] in (b"UNICODE\0", b"ASCII\0\0\0", b"\0" * 8) else v
            if head == b"UNICODE\0":
                be, le = body.decode("utf-16-be", "replace"), body.decode("utf-16-le", "replace")
                v = be if sum(ch.isascii() for ch in be) >= sum(ch.isascii() for ch in le) else le
            else:
                v = body.decode("utf-8", "replace")
        v = str(v).strip("\0 ")
        if v:
            out[name] = v
    return out


def _xmp(im, data):
    m = re.search(rb"<x:xmpmeta.*?</x:xmpmeta>", data, re.S)
    x = m.group(0).decode("utf-8", "replace") if m else ""
    if not x:
        for k in ("xmp", "XML:com.adobe.xmp"):
            if im.info.get(k):
                v = im.info[k]
                x = v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
                break
    return x


def analyze(data):
    info = _info()
    im = Image.open(io.BytesIO(data))
    info["file"] = {"format": im.format, "size": f"{im.width}×{im.height}", "mode": im.mode}
    meta = {k: v for k, v in im.info.items() if isinstance(v, (str, bytes)) and k not in ("icc_profile", "exif", "xmp", "XML:com.adobe.xmp")}
    meta = {k: (v.decode("utf-8", "replace") if isinstance(v, bytes) else v) for k, v in meta.items()}
    exif = _exif_texts(im)

    # ComfyUI writes "prompt" + "workflow" (PNG text, or "prompt:" / "workflow:" in EXIF for WebP/JPEG savers).
    comfy_prompt = meta.get("prompt")
    comfy_wf = meta.get("workflow")
    for v in exif.values():
        if v.lower().startswith("prompt:"):
            comfy_prompt = v.split(":", 1)[1]
        elif v.lower().startswith("workflow:"):
            comfy_wf = v.split(":", 1)[1]
    params = meta.get("parameters") or exif.get("UserComment") or ""
    found = False
    if comfy_prompt:
        try:
            g = json.loads(comfy_prompt)
            if isinstance(g, dict) and all(isinstance(n, dict) for n in g.values()):
                parse_comfy_prompt(g, info)
                info["raw"]["comfy_prompt"] = g
                found = True
        except ValueError:
            pass
    if not found and comfy_wf:
        try:
            parse_comfy_workflow(json.loads(comfy_wf), info)
            found = True
        except ValueError:
            pass
    if comfy_wf:
        info["raw"]["has_workflow"] = True
    if not found and params.strip().startswith("{"):
        try:
            j = json.loads(params)
        except ValueError:
            j = None
        if isinstance(j, dict) and "sui_image_params" in j:   # SwarmUI
            p = j["sui_image_params"]
            _add(info["software"], "SwarmUI" + (f' ({p.get("swarm_version")})' if p.get("swarm_version") else ""))
            info["prompt"], info["negative"] = p.get("prompt", ""), p.get("negativeprompt", "")
            if p.get("model"):
                _add(info["models"], {"name": p["model"], "kind": "checkpoint"})
            for i, n in enumerate(p.get("loras") or []):
                w = (p.get("loraweights") or [])
                _add(info["loras"], {"name": n, "strength": _num(w[i] if i < len(w) else 1)})
            for k, label in (("seed", "seed"), ("steps", "steps"), ("cfgscale", "cfg"), ("sampler", "sampler"), ("scheduler", "scheduler"),
                             ("width", "width"), ("height", "height")):
                if p.get(k) is not None:
                    info["settings"][label] = p[k]
            info["apply"] = {"prompt": info["prompt"], "negative": info["negative"], "settings": True,
                             **{k: info["settings"][k] for k in ("seed", "steps", "cfg", "width", "height") if k in info["settings"]}}
            info["raw"]["swarmui"] = j
            found = True
        elif isinstance(j, dict) and ("Prompt" in j or "prompt" in j) and ("Base Model" in j or "base_model" in j or meta.get("fooocus_scheme")):
            _add(info["software"], "Fooocus" + (f' ({j.get("Version") or j.get("version")})' if j.get("Version") or j.get("version") else ""))
            info["prompt"] = j.get("Prompt") or j.get("prompt") or ""
            info["negative"] = j.get("Negative Prompt") or j.get("negative_prompt") or ""
            base = j.get("Base Model") or j.get("base_model")
            if base:
                _add(info["models"], {"name": base, "kind": "checkpoint"})
            if j.get("Refiner Model") or j.get("refiner_model"):
                _add(info["files"], {"kind": "Refiner", "name": j.get("Refiner Model") or j.get("refiner_model")})
            for l in j.get("LoRAs") or j.get("loras") or []:
                if isinstance(l, (list, tuple)) and l:
                    _add(info["loras"], {"name": l[0], "strength": _num(l[1] if len(l) > 1 else 1)})
            for k in ("Styles", "Performance", "Resolution", "Sharpness", "Guidance Scale", "Sampler", "Scheduler", "Seed", "Steps"):
                if j.get(k) is not None:
                    info["settings"][k.lower()] = j[k] if not isinstance(j[k], (list, dict)) else json.dumps(j[k])
            info["apply"] = {"prompt": info["prompt"], "negative": info["negative"], "settings": True}
            info["raw"]["fooocus"] = j
            found = True
    if not found and re.search(r"Steps:\s*\d+", params):
        parse_a1111(params, info)
        found = True
    if not found and meta.get("invokeai_metadata"):
        try:
            j = json.loads(meta["invokeai_metadata"])
            _add(info["software"], "InvokeAI" + (f' ({j.get("app_version")})' if j.get("app_version") else ""))
            info["prompt"], info["negative"] = j.get("positive_prompt", ""), j.get("negative_prompt", "")
            m = j.get("model") or {}
            if m:
                _add(info["models"], {"name": m.get("name") or m.get("model_name") or str(m), "kind": m.get("base") or "checkpoint"})
            for l in j.get("loras") or []:
                lm = l.get("model") or l.get("lora") or {}
                _add(info["loras"], {"name": lm.get("name") or lm.get("model_name") or "?", "strength": _num(l.get("weight", 1))})
            for k, label in (("seed", "seed"), ("steps", "steps"), ("cfg_scale", "cfg"), ("scheduler", "sampler"), ("width", "width"), ("height", "height")):
                if j.get(k) is not None:
                    info["settings"][label] = j[k]
            info["apply"] = {"prompt": info["prompt"], "negative": info["negative"], "settings": True,
                             **{k: info["settings"][k] for k in ("seed", "steps", "cfg", "width", "height") if k in info["settings"]}}
            info["raw"]["invokeai"] = j
            found = True
        except ValueError:
            pass
    if not found and (meta.get("Software") == "NovelAI" or "NovelAI" in meta.get("Source", "")):
        parse_novelai(meta, info, "png")
        found = True
    if not found:
        hidden = read_stealth(im)
        if hidden:
            try:
                d = json.loads(hidden)
            except ValueError:
                d = None
            if isinstance(d, dict) and ("Comment" in d or d.get("Software") == "NovelAI"):
                parse_novelai(d, info, "stealth")
            else:
                parse_a1111(hidden, info)
                info["notes"].append("Read from the hidden copy in the picture's pixels (stealth pnginfo).")
            found = True

    # Midjourney: Description = prompt + flags, Author = user, plus an IPTC "made by AI" marker.
    xmp = _xmp(im, data)
    if not found and ("Midjourney" in xmp or "Job ID" in meta or ("Author" in meta and "--" in meta.get("Description", ""))):
        _add(info["software"], "Midjourney")
        info["prompt"] = meta.get("Description", "")
        m = re.search(r"--v(?:ersion)?\s+([\d.]+)", info["prompt"]) or re.search(r"--niji\s+([\d.]+)", info["prompt"])
        _add(info["models"], {"name": ("Niji " if "--niji" in info["prompt"] else "Midjourney v") + (m.group(1) if m else "?"), "kind": "Midjourney model (online only)"})
        if meta.get("Job ID"):
            info["settings"]["job id"] = meta["Job ID"]
        found = True

    # Editing apps that saved over the file afterwards (Photoshop wipes most of the above; NovelAI's hidden copy survives).
    for tool in re.findall(r'(?:CreatorTool|softwareAgent)="([^"]+)"', xmp) + re.findall(r"<xmp:CreatorTool>([^<]+)<", xmp):
        if tool not in info["software"]:
            _add(info["edited"], tool)
    for k in ("Software", "software"):
        if meta.get(k) and meta[k] not in ("NovelAI",) and not found:
            _add(info["edited"], meta[k])
    if exif.get("Software") and exif["Software"] not in info["edited"]:
        _add(info["edited"], exif["Software"])
    if "trainedAlgorithmicMedia" in xmp or b"trainedAlgorithmicMedia" in data:
        info["notes"].append("Marked as made by AI (IPTC 'trained algorithmic media').")
    if b"c2pa." in data or b"urn:c2pa" in data:
        names = [label for key, label in C2PA_NAMES if key in data]
        names = list(dict.fromkeys(names))
        info["notes"].append("Has Content Credentials (C2PA)" + (": mentions " + ", ".join(names[:3]) if names else "") + ".")
        if not found and names:
            _add(info["software"], names[0] + " (from Content Credentials)")
            found = True

    if not found:
        info["notes"].append("No generation info in this file. It was probably removed: screenshots, Discord, X/Twitter, Pixiv and most "
                             "social sites strip it, and so does re-saving in many editors. Press 🏷 Find tags to read the picture itself.")
    if info["edited"]:
        info["notes"].append("Saved again in " + ", ".join(info["edited"]) + " after it was made.")
    info["found"] = found
    info["raw"]["text"] = {k: v[:20000] for k, v in meta.items() if k not in ("prompt", "workflow")}
    if exif:
        info["raw"]["exif"] = {k: v[:20000] for k, v in exif.items()}
    return info
