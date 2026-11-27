"""Kōbō from the terminal (standard library only).

  python kobo_cli.py status                      ComfyUI up? what's queued?
  python kobo_cli.py tags "long ha"              booru tag search (the Adult/Story autocomplete)
  python kobo_cli.py run prompts.txt [--set Raiden] [--model "my model"] [--quality "..."] [--seed 123] [--dry-run] [--no-wait]

`run` reads the Workflow tab's prompts-file format ("## name" sets, a "SHARED:" line, one prompt per line,
"portrait"/"landscape" picks the shape). It copies the newest picture Kōbō made (model, LoRAs, negative, steps, CFG,
sampler) and only swaps the prompt, size and seed, so set things up once in Kōbō's right panel first.
Every shot in a set gets the same seed, as in the Workflow tab. Pictures land in ComfyUI's output/LoRA-Lab/cli/.
Files with child tags, or animal tags next to sex tags, aren't drawn (same rule as the website).
Set KOBO_URL (or --url) when ComfyUI isn't on http://127.0.0.1:8188.
"""
import argparse
import copy
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_QUALITY = "masterpiece, best quality, score_7"   # Kōbō's Anima Quality box default
# Same rules as the Workflow tab's Load prompts file (web/app.js FILE_MINOR, ANIMAL_SEX + FILE_SEX): such files aren't drawn.
FILE_MINOR = re.compile(r"\b(loli\w*|shota\w*|child\w*|kids?|toddlers?|bab(y|ies)|minors?|underage|aged down|teens?|teenagers?"
                        r"|preteens?|schoolgirls?|schoolboys?|school uniform|elementary school|middle school|high school)\b", re.I)
ANIMAL_SEX = re.compile(r"\b(dogs?|canine|equine|horse|animal genitalia|zoophilia|bestiality|feral|knot\w*)\b", re.I)
FILE_SEX = re.compile(r"\b(sex\w*|nude|naked|nsfw|penis|pussy|vagina|cock|cum|cumshot|fellatio|cunnilingus|penetrat\w*"
                      r"|intercourse|masturbat\w*|genital\w*|erection|zoophilia|bestiality)\b", re.I)


def refusal_reasons(text):
    """Why the website would refuse this file: child tags always, animal tags only together with sex tags."""
    reasons = []
    if FILE_MINOR.search(text):
        reasons.append("child/minor tags")
    if ANIMAL_SEX.search(text) and FILE_SEX.search(text):
        reasons.append("animal tags with sex tags")
    return reasons

ORIENT = re.compile(r"(^|[\s,(])(?:in\s+)?(portrait|landscape)(?:\s+(?:mode|orientation|format))?(?!\s*\()(?=$|[\s,).])", re.I)
MAX_SHOTS = 35


def join_tags(parts):
    return ", ".join(p for p in ((x or "").strip().strip(",").strip() for x in parts) if p)


def parse_file(text, name="prompts"):
    """[(set name, shared, [shot, ...])] the way the Workflow tab splits a prompts file."""
    if re.search(r"^## ", text, re.M):
        blocks = [(b.split("\n", 1)[0].strip(), b.split("\n", 1)[1] if "\n" in b else "") for b in re.split(r"^## ", text, flags=re.M)[1:]]
    else:
        blocks = [(name, text)]
    sets = []
    for title, body in blocks:
        m = re.search(r"^\s*shared:(.*)$", body, re.I | re.M)
        shots = [re.sub(r"^(shot\s*)?\d+(\s*[.):-]\s*|\s+)", "", s, flags=re.I) for s in (l.strip() for l in body.split("\n"))
                 if s and not re.match(r"^(#|shared:|//|```)", s, re.I)]
        shots = [s for s in shots if s]
        for i in range(0, len(shots), MAX_SHOTS):
            part = f" part {i // MAX_SHOTS + 1}" if len(shots) > MAX_SHOTS else ""
            sets.append(((title or name) + part, (m.group(1) if m else "").strip(), shots[i:i + MAX_SHOTS]))
    return sets


def orientation(text):
    found = [m.group(2).lower() for m in ORIENT.finditer(text)]
    return found[-1] if found else None


def drop_orientation(text):
    text = ORIENT.sub(r"\1", text)
    return re.sub(r"^[\s,]+|[\s,]+$", "", re.sub(r" {2,}", " ", re.sub(r",(\s*,)+", ",", text)))


def oriented_size(w, h, o):
    if not o:
        return w, h
    if w == h:
        w, h = (512, 768) if w <= 512 else (832, 1216)
    return (h, w) if (h > w) != (o == "portrait") else (w, h)


class Kobo:
    def __init__(self, url):
        self.url = url.rstrip("/")

    def get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=30) as r:
            return json.load(r)

    def post(self, path, body):
        req = urllib.request.Request(self.url + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def template(self, model=""):
        """The newest finished Kōbō picture's graph (its SaveImage prefix starts with LoRA-Lab/), optionally of one model."""
        hist = self.get("/history?max_items=200")
        for item in sorted(hist.values(), key=lambda v: v["prompt"][0], reverse=True):
            g = item["prompt"][2]
            if (item.get("status", {}).get("status_str") == "success" and _save_node(g) and _text_node(g, "positive")
                    and model.lower() in _model(g).lower()):
                return g
        return None


def _save_node(g):
    return next((k for k, n in g.items() if n["class_type"] == "SaveImage"
                 and str(n["inputs"].get("filename_prefix", "")).startswith("LoRA-Lab/")), None)


def _text_node(g, which):
    """The CLIPTextEncode feeding the sampler's positive/negative input (through ReferenceLatent and the like)."""
    for n in g.values():
        link = n["inputs"].get(which)
        while isinstance(link, list) and str(link[0]) in g:
            node = g[str(link[0])]
            if "text" in node["inputs"]:
                return str(link[0])
            link = node["inputs"].get("conditioning")
    return None


def make_graph(template, positive, seed, orient, prefix):
    g = copy.deepcopy(template)
    g[_text_node(g, "positive")]["inputs"]["text"] = positive
    for n in g.values():
        ins = n["inputs"]
        for k in ("seed", "noise_seed"):
            if isinstance(ins.get(k), int):
                ins[k] = seed
        if isinstance(ins.get("width"), int) and isinstance(ins.get("height"), int):
            ins["width"], ins["height"] = oriented_size(ins["width"], ins["height"], orient)
    g[_save_node(g)]["inputs"]["filename_prefix"] = prefix
    return g


def safe(name):
    return re.sub(r"[^\w \-]", "", name).strip().replace(" ", "_")[:60] or "set"


def cmd_status(k, _args):
    s = k.get("/system_stats")
    q = k.get("/queue")
    dev = (s.get("devices") or [{}])[0]
    print(f"ComfyUI {s['system'].get('comfyui_version')} at {k.url}")
    if dev:
        print(f"GPU {dev.get('name', '?')}: {dev.get('vram_free', 0) / 2**30:.1f} of {dev.get('vram_total', 0) / 2**30:.1f} GB free")
    print(f"queue: {len(q['queue_running'])} running, {len(q['queue_pending'])} waiting")
    t = k.template()
    print("Kōbō template: " + (f"{_model(t)} ({_size(t)})" if t else "none yet: make one picture in Kōbō first"))


def _model(g):
    return next((v for n in g.values() for key, v in n["inputs"].items() if key in ("ckpt_name", "unet_name")), "?")


def _size(g):
    return next((f"{n['inputs']['width']}x{n['inputs']['height']}" for n in g.values()
                 if isinstance(n["inputs"].get("width"), int)), "?")


def cmd_tags(k, args):
    for t in k.get("/lora-lab/booru-tags?q=" + urllib.parse.quote(args.query)):
        alias = f"  (alias {t['alias']})" if t.get("alias") else ""
        print(f"{t['name']:<40} {t['count']:>10,}  {t['sites']}{alias}")


def cmd_run(k, args):
    with open(args.file, encoding="utf-8") as f:
        text = f.read()
    reasons = refusal_reasons(text)
    if reasons:
        sys.exit(f"This file has {' and '.join(reasons)}, so it won't be drawn.")
    sets = [s for s in parse_file(text, os.path.splitext(os.path.basename(args.file))[0])
            if not args.set or args.set.lower() in s[0].lower()]
    if not sets:
        sys.exit("No prompts found" + (f" in sets matching {args.set!r}" if args.set else "") + ".")
    template = k.template(args.model or "")
    if not template:
        sys.exit(f"No Kōbō picture{f' made with {args.model!r}' if args.model else ''} in ComfyUI's recent history: "
                 "make one in Kōbō first (that sets the model, LoRAs and negative).")
    day = time.strftime("%Y-%m-%d")
    print(f"{sum(len(s[2]) for s in sets)} prompts in {len(sets)} set(s), using {_model(template)} ({_size(template)})")
    queued = []
    for name, shared, shots in sets:
        seed = args.seed if args.seed is not None else random.randrange(2**32)
        for i, shot in enumerate(shots, 1):
            positive = join_tags([args.quality, shared, drop_orientation(shot)])
            g = make_graph(template, positive, seed, orientation(shot), f"LoRA-Lab/cli/{day}/{safe(name)}/{i:02d}")
            if args.dry_run:
                print(f"[{name} {i}] seed {seed} {_size(g)}: {positive}")
                continue
            pid = k.post("/prompt", {"prompt": g, "client_id": "kobo-cli"})["prompt_id"]
            queued.append((f"{name} {i}", pid))
        if not args.dry_run:
            print(f"queued {name}: {len(shots)} shots, seed {seed}")
    if args.dry_run or args.no_wait:
        return
    out_dir = None
    for label, pid in queued:
        while not (h := k.get(f"/history/{pid}").get(pid)):   # a job shows up in history once it has finished or failed
            time.sleep(2)
        imgs = [i for o in h["outputs"].values() for i in o.get("images", [])]
        if not imgs:
            print(f"{label}: failed ({h.get('status', {}).get('status_str')})")
            continue
        out_dir = imgs[0]["subfolder"]
        print(f"{label}: {imgs[0]['filename']}")
    if out_dir:
        print(f"done: ComfyUI/output/{out_dir.rsplit('/', 1)[0]}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="kobo", description="Kōbō from the terminal.")
    p.add_argument("--url", default=os.environ.get("KOBO_URL", "http://127.0.0.1:8188"))
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="ComfyUI, queue and the Kōbō settings run would copy")
    t = sub.add_parser("tags", help="search every booru's tags")
    t.add_argument("query")
    r = sub.add_parser("run", help="draw a Workflow prompts file")
    r.add_argument("file")
    r.add_argument("--set", help="only sets whose name contains this (e.g. Raiden)")
    r.add_argument("--model", help="copy the newest Kōbō picture made with this model (part of its file name)")
    r.add_argument("--quality", default=DEFAULT_QUALITY, help="tags put in front of every prompt (Kōbō's Quality box)")
    r.add_argument("--seed", type=int, help="one seed for every set (default: a random seed per set)")
    r.add_argument("--dry-run", action="store_true", help="print the prompts without queueing them")
    r.add_argument("--no-wait", action="store_true", help="queue and exit")
    args = p.parse_args(argv)
    k = Kobo(args.url)
    try:
        {"status": cmd_status, "tags": cmd_tags, "run": cmd_run}[args.cmd](k, args)
    except urllib.error.HTTPError as e:   # ComfyUI answered but refused (e.g. a missing model): show why
        sys.exit(f"ComfyUI said {e.code}: {e.read().decode(errors='replace')[:500]}")
    except OSError as e:
        sys.exit(f"Can't reach ComfyUI at {k.url}: {e}")


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):   # Windows consoles default to cp1252, which can't print "Kōbō"
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    main()