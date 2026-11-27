# Prompt writer: turns a short idea into a model-specific prompt using a local Ollama model.
# Optional: needs Ollama (https://ollama.com) with at least one chat model pulled.
import asyncio
import csv
import json
import logging
import os
import re
import threading

import aiohttp

from . import boorutags, recall

_host = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434").replace("0.0.0.0", "127.0.0.1")
OLLAMA_URL = (_host if _host.startswith("http") else "http://" + _host).rstrip("/")
# Set LORA_LAB_LLM_MODEL to pick a model; otherwise the first of PREFERRED that is installed, else any chat model.
DEFAULT_MODEL = os.environ.get("LORA_LAB_LLM_MODEL", "")
# Auto picks the first of these that is installed: Gemma 4 E4B first, then the Qwen 3.5 9B (slower on a 6 GB GPU, part runs on the CPU).
PREFERRED = ("hf.co/hauhaucs/gemma-4", "huihui_ai/qwen3.5-abliterated:9b", "qwen3.5-4b-main","huihui_ai/qwen3.5-abliterated", "stheno", "qwen3.5-4b-abliterated", "qwen3.5", "dolphin-venice", "dolphin", "mistral", "llama", "qwen", "gemma")

_ADULTS = "Every person in the image is an adult (18 or older); never describe minors, children or childlike features."
_TAGS = ("Output ONLY lowercase Danbooru tags separated by commas: start with the subject count (e.g. 1girl, 1boy, 2girls, solo), "
         "then character appearance, clothing, pose, expression, setting, lighting and composition. 20-40 tags. "
         "Use only tags that exist on Danbooru (e.g. 'from below' not 'low angle shot', 'snow, forest' not 'snowy forest'); "
         "invented tags are thrown away. "
         "Do NOT include quality or score tags, do not write sentences, do not explain anything.")
SYSTEM = {
    "illustrious": f"You write prompts for Illustrious-XL, an anime image model trained on Danbooru tags. {_TAGS} {_ADULTS}",
    "pony": f"You write prompts for Pony Diffusion V6 XL, an anime image model trained on Danbooru tags. {_TAGS} {_ADULTS}",
    "anima": f"You write prompts for Anima, an anime image model trained on Danbooru tags. {_TAGS} {_ADULTS}",
    "sd15": f"You write prompts for a Stable Diffusion 1.5 anime model (such as NovelAI Anime) trained on Danbooru tags. {_TAGS} {_ADULTS}",
    "klein": ("You write prompts for FLUX.2 Klein, a photorealistic image model that understands natural language. "
              "Output ONLY the prompt: 2-4 vivid sentences describing the subject, their appearance, clothing, pose and expression, "
              f"the setting, lighting, and camera or art style. No lists, no headings, no explanations. {_ADULTS}"),
    "zimage": ("You write prompts for Z-Image Turbo, a photorealistic image model that understands natural language and can render text. "
               "Output ONLY the prompt: 2-4 vivid sentences describing the subject, setting, lighting, camera and style; if the idea "
               "includes words that should appear in the image (a slogan, brand name or sign), put them in double quotes. "
               f"No lists, no headings, no explanations. {_ADULTS}"),
    "wan": ("You write prompts for Wan, a text-to-video model that understands natural language. "
            "Output ONLY the prompt: 3-5 sentences describing the subject and appearance, what moves and how (actions, hair, cloth, water), "
            f"the camera movement, the setting, lighting and style. No lists, no headings, no explanations. {_ADULTS}"),
}
TAG_TARGETS = {"illustrious", "pony", "anima", "sd15"}

# Same list the page uses for reference-image tags.
BLOCKED_TAGS = {"loli", "shota", "child", "female child", "male child", "kid", "toddler", "baby", "aged down", "underage",
                "young child", "kindergartener", "elementary school student", "middle school student", "childlike body", "randoseru"}


# Danbooru tag list from a1111-sd-webui-tagcomplete (MIT): tag, category, post count, "aliases".
# Small models invent tags ("cold wind", "high quality"); only real ones reach the prompt, aliases become the real tag.
# Lives in web/ so the page's tag autocomplete loads the same file.
DANBOORU_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "danbooru_tags.csv")
DANBOORU_KEEP = {"0", "3", "4"}  # general, copyright, character; artist and meta tags are never wanted here
_danbooru = None
_danbooru_general = set()   # names and aliases of general tags (no characters or series), for salvaging phrases
_danbooru_named = {}        # name or alias -> (tag, category) of characters and series, for names written in an idea
NAMED_MIN_POSTS = 500
_danbooru_lock = threading.Lock()


def danbooru_tags():
    """Alias or tag (spaces, lowercase) -> real Danbooru tag."""
    global _danbooru
    with _danbooru_lock:
        if _danbooru is None:
            tags = {}
            with open(DANBOORU_CSV, newline="", encoding="utf-8") as f:
                for name, cat, _count, aliases in csv.reader(f):
                    if cat not in DANBOORU_KEEP:
                        continue
                    name = name.replace("_", " ")
                    tags[name] = name
                    keys = [name]
                    for a in aliases.split(","):
                        a = a.strip().replace("_", " ")
                        if a and not a.startswith("/"):  # "/lh"-style entries are autocomplete shortcuts
                            tags.setdefault(a, name)
                            keys.append(a)
                    if cat == "0":
                        _danbooru_general.update(keys)
                    elif int(_count or 0) >= NAMED_MIN_POSTS:   # well-known characters (4) and series (3)
                        _danbooru_named.update((k, (name, cat)) for k in keys)
            for e in genshin().values():   # every Genshin character, also the ones too new for the tag list
                _danbooru_named.update((k.lower(), (e["tag"], "4")) for k in (e["tag"], e["name"], *e["aliases"]))
            _danbooru = tags
    return _danbooru


# The Adult workspace's prompt writer speaks rule34.xxx (rule34_tags.csv, see boorutags.py): its tag names and aliases
# win. Danbooru's tags stay valid too, since the rule34 dump misses some of its biggest tags (nude, penis, open mouth).
_rule34 = None


def rule34_tags():
    """(alias or tag -> real tag, general tag names) for rule34 prompts."""
    global _rule34
    known = danbooru_tags()
    with _danbooru_lock:
        if _rule34 is None:
            tags, general = dict(known), set(_danbooru_general)
            if os.path.exists(boorutags.RULE34_CSV):
                with open(boorutags.RULE34_CSV, newline="", encoding="utf-8") as f:
                    for name, cat, _count, aliases in csv.reader(f):
                        if cat not in DANBOORU_KEEP:
                            continue
                        keys = [name.replace("_", " ")] + [a.replace("_", " ") for a in aliases.split(",") if a]
                        tags.update((k, keys[0]) for k in keys)
                        if cat == "0":
                            general.update(keys)
            _rule34 = tags, general
    return _rule34


# Every playable Genshin Impact character (genshin.json, built from genshin-db + the danbooru2026 snapshot): Danbooru tag,
# nicknames, the hair/eyes/features and default outfit most of their solo pictures share, and child = the game's child
# body model (Klee, Nahida, Qiqi…), who never go into explicit prompts.
GENSHIN_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "genshin.json")
_genshin = None


def genshin():
    """Danbooru tag -> Genshin character entry."""
    global _genshin
    if _genshin is None:
        try:
            with open(GENSHIN_JSON, encoding="utf-8") as f:
                _genshin = {e["tag"]: e for e in json.load(f)}
        except FileNotFoundError:
            _genshin = {}
    return _genshin


def _salvage(phrase, known, general):
    """Real general tags inside an invented phrase, longest first: 'mia thong pulled tight' -> ['thong']."""
    words, i, out = phrase.split(), 0, []
    while i < len(words):
        for n in range(min(4, len(words) - i), 0, -1):
            g = " ".join(words[i:i + n])
            # Only real tag names, never aliases ("sitting on" is an alias of "sitting on person"); lone words of 4+ letters.
            if g in general and known.get(g) == g and (n > 1 or len(g) >= 4):
                out.append(g)
                i += n
                break
        else:
            i += 1
    return out


def _clean(text, target, rule34=False):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^\s*(prompt|tags)\s*:\s*", "", text, flags=re.I).strip().strip('"').strip()
    if target in TAG_TARGETS:
        known, general = rule34_tags() if rule34 else (danbooru_tags(), _danbooru_general)
        tags, real = [], []
        for t in re.split(r"[,\n]+", text):
            # Strip list markers ("- ", "* ", "3. ") and labels ("pose: standing") but keep tags like "1girl".
            t = re.sub(r"^(?:[-*•]\s*|\d+[.)]\s+|[a-z ]+:\s*)", "", t.strip().lower()).replace("_", " ").strip(" .")
            if t and not t.isdigit() and t not in BLOCKED_TAGS and t not in tags:
                tags.append(t)
                for k in [known.get(t)] if t in known else [known[g] for g in _salvage(t, known, general)]:
                    if k and k not in BLOCKED_TAGS and k not in real:
                        real.append(k)
        # Nothing recognised (an unusual idea): better the model's own words than an empty prompt.
        return ", ".join(real or tags)
    return " ".join(text.split())


async def _chat(session, model, messages, options, fmt=None):
    # Thinking models (Qwen 3.5, Gemma 4) would otherwise spend the whole num_predict budget reasoning.
    payload = {"model": model, "messages": messages, "stream": False, "think": False, "keep_alive": "2m", "options": options}
    if fmt:
        payload["format"] = fmt   # JSON schema: Ollama constrains the output to it
    async with session.post(OLLAMA_URL + "/api/chat", json=payload) as r:
        body = await r.json(content_type=None)
        if r.status != 200:
            raise RuntimeError((body or {}).get("error") or f"Ollama returned HTTP {r.status}")
        return body["message"]["content"]


SFW = ("This is the General (safe-for-work) workspace: no nudity, no sexual content and no suggestive poses, "
       "even if the idea asks for it.")


RULE34 = "Tags from rule34.xxx are fine too, and use rule34.xxx's tag name where it differs from Danbooru's."


NUDE = ("They are nude: do not describe any other clothing. The only things they may wear are underwear "
        "(bra, panties, thong, g-string, bikini, lingerie), stockings, thighhighs and high heels; sex toys are allowed too.")


def _character_context(ch, new_look=False, nude=False):
    """Tell the writer who the image is of, so the scene stays true to the character's memory."""
    if not isinstance(ch, dict) or not ch.get("name"):
        return ""
    parts = [f'The image shows the character "{str(ch["name"])[:60]}".']
    if ch.get("memory"):
        parts.append("Keep these facts about them in mind: " + str(ch["memory"])[:2000])
    if new_look and nude:
        parts.append("Their face, hair and body are added automatically, so do not describe them. " + NUDE
                     + " Invent a pose, expression, action, setting and lighting that fit who they are.")
    elif new_look:   # empty prompt with a character: a fresh outfit and scene every time
        parts.append("Their face, hair and body are added automatically, so do not describe them. Invent a NEW outfit "
                     "for them that fits who they are, plus a pose, expression, action, setting and lighting.")
    else:
        parts.append("Their appearance and outfit tags are added automatically, so do not repeat them; "
                     "describe the pose, expression, action, setting and lighting in a way that fits who they are.")
    return " ".join(parts)


def _notes(notes):
    """The Workflow folder's .md notes; the safety rules above them still win."""
    notes = str(notes or "").strip()[:4000]
    return f"The user's project notes (follow them where they don't conflict with the rules above): {notes}" if notes else ""


async def _chat_models(session):
    async with session.get(OLLAMA_URL + "/api/tags") as r:
        names = [m["name"] for m in (await r.json(content_type=None)).get("models", [])]
    return [n for n in names if "embed" not in n.lower() and n.split(":")[0] != TIPO_MODEL]


async def list_models():
    """Installed chat models and the one used when the page doesn't pick one."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        models = await _chat_models(session)
        return {"models": models, "default": await _pick_model(session, DEFAULT_MODEL) if models else None}


async def _pick_model(session, requested):
    chat = await _chat_models(session)
    if requested:
        match = next((n for n in chat if n == requested or n.split(":")[0] == requested), None)
        if match:
            return match
    for pref in PREFERRED:
        match = next((n for n in chat if n.lower().startswith(pref)), None)
        if match:
            return match
    if chat:
        return chat[0]
    raise RuntimeError("Ollama has no models yet. Install one, e.g. `ollama pull mistral`, then try again.")


async def write_prompt(idea, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, character=None, new_look=False, nude=False,
                       notes="", rule34=False):
    if target not in SYSTEM:
        raise ValueError(f"Unknown target {target!r}")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)  # let ComfyUI's worker release VRAM before Ollama sizes its GPU layers
    nude, rule34 = nude and not sfw, rule34 and not sfw
    context = _character_context(character, new_look, nude)
    if target in TAG_TARGETS:
        # A character's looks (and outfit, unless they get a new one) are added by the page; TIPO's guesses would clash.
        drop = (_LOOK_TAG if new_look else _LOOK_OR_OUTFIT_TAG) if context else None
        system = " ".join(x for x in (KEY_TAGS, RULE34 if rule34 else "", "Start with the people count (e.g. 1girl, 2girls, 1boy, solo).",
                                      _ADULTS, SFW if sfw else "", context, _notes(notes)) if x)
        named = _named_tags(idea)
        _refuse_children(named, nude or not sfw)
        if _who(named):   # so the people count is right: Tartaglia and Zhongli are 2boys
            system += f" The people named in the description: {_who(named)}."
        tags = await _tipo_tags(system, idea, ", ".join(t for t, _ in named), target, model, sfw, nude, drop, rule34)
        if tags is not None:
            explicit = nude or bool(_EXPLICIT.search(tags))
            _refuse_children(named, explicit or not sfw)
            return _with_named(tags, named, explicit, idea, own=bool(context))
    system = " ".join(x for x in (SYSTEM[target], RULE34 if rule34 and target in TAG_TARGETS else "", SFW if sfw else "",
                                  context, _notes(notes)) if x)
    return _clean(await _ask(system, idea, model, 300), target, rule34)


def _named_tags(text):
    """[(tag, category)] for well-known Danbooru characters and series written in the text ("Frieren", "Spy x Family").
    Longest names first. Only names written with a capital letter count, except two-word-plus character names
    ("raiden shogun") and Genshin characters ("klee"), so "link", "saber" or "a link between worlds" in a sentence
    stay words; Genshin names that are also English words ("amber eyes", "razor") need the capital too."""
    danbooru_tags()
    words, found, i = re.findall(r"[^\W_]+(?:['-][^\W_]+)*", str(text or "")), {}, 0
    while i < len(words):
        for n in (4, 3, 2, 1):
            phrase = " ".join(words[i:i + n]).lower()
            hit = _danbooru_named.get(phrase) if i + n <= len(words) else None
            if hit and (words[i][0].isupper() or (n > 1 and hit[1] == "4")
                        or (hit[0] in genshin() and phrase not in _GENSHIN_WORDS)):
                found.setdefault(hit[0], hit)
                i += n
                break
        else:
            i += 1
    return list(found.values())


_GENSHIN_WORDS = {"amber", "jean", "venti", "albedo", "ei", "yae", "gaming", "razor", "sucrose", "dahlia", "prune",
                  "wanderer", "morax", "childe"}


def _who(named):
    """'Tartaglia (Genshin Impact, male), Frieren' for the writers: small models don't know these characters."""
    def one(t):
        e = genshin().get(t)
        return f"{e['name']} (Genshin Impact, {e['gender']}{', safe pictures only' if e['child'] else ''})" if e \
            else t.title()
    return ", ".join(one(t) for t, cat in named if cat == "4")


def _refuse_children(named, adult):
    """Child-model characters only in safe General-workspace prompts (Adult adds 18+ LoRAs and tags)."""
    kids = [genshin()[t]["name"] for t, _ in named if genshin().get(t, {}).get("child")]
    if adult and kids:
        raise ValueError(_kids_reply(kids))


def _with_named(tags, named, explicit, idea="", own=False):
    """People count first, then the named characters and series, then the rest. Other series' character tags are left
    out of explicit prompts: a character tag draws them exactly as their series does, and some are minors (Genshin
    characters are known: their adults stay). One Genshin character alone also gets their look, replacing the hair and
    eyes TIPO guessed, and their outfit unless the idea names clothes; not when it's the user's own saved character."""
    roster = genshin()
    if any(t in roster for t, _ in named):
        named = named + [("genshin impact", "3")]
    keep = [t for t, cat in named if cat == "3" or not explicit or (t in roster and not roster[t]["child"])]
    tags = [t for t in tags.split(", ") if t]
    chars = [t for t, cat in named if cat == "4"]
    if chars and all(t in roster for t in chars):   # the roster knows who is a man: Childe + Zhongli = 2boys
        girls = sum(roster[t]["gender"] == "female" for t in chars)
        people = [f"{n}{kind}{'s' if n > 1 else ''}" for n, kind in ((girls, "girl"), (len(chars) - girls, "boy")) if n]
        tags = people + (["solo"] if len(chars) == 1 else []) + [t for t in tags if not _COUNT_TAG.match(t)]
    extra = []
    if len(chars) == 1 and chars[0] in roster and chars[0] in keep and not own:
        e = roster[chars[0]]
        extra = list(e["looks"])
        tags = [t for t in tags if not _LOOK_TAG.search(t)]
        if e["outfit"] and not explicit and not _OUTFIT_TAG.search(idea.lower()) and not _UNDRESSED.search(idea.lower()):
            extra += e["outfit"]
            tags = [t for t in tags if not _OUTFIT_TAG.search(t)]
    count = [t for t in tags if _COUNT_TAG.match(t)]
    return ", ".join(dict.fromkeys(count + keep + extra + tags))


# Tag prompts are made by two models: the writer (good at reading) picks the key tags, then TIPOv2 (KohakuBlueleaf's
# 1B model trained on Danbooru to turn a short caption into tags) fills in the rest around them. TIPO runs on the CPU
# (~1 s), so the writer keeps the GPU. `ollama create tipov2` from TIPOv2-1B-A200M-Q8_0.gguf; without it the writer alone.
TIPO_MODEL = "tipov2"
KEY_TAGS = ("You pick the key Danbooru tags of a picture description: 5-10 lowercase tags for the place, the important "
            "objects, what the people do (pose, action, expression, how they touch), the lighting and the camera framing, "
            "plus the art style if one is given. No names, no hair, eyes, body or clothes. Use only tags that exist on "
            "Danbooru. Output only the tags, comma separated.")
_TIPO_JUNK = {"watermark", "signature", "artist name", "web address", "patreon username", "english text", "comic", "silent comic",
              "2koma", "3koma", "4koma", "monochrome", "greyscale", "simple background", "white background", "grey background", "^ ^"}
_COUNT_TAG = re.compile(r"^(\d\+?(girl|boy|other)s?|multiple (girls|boys|others)|solo|solo focus|no humans|(male|female) focus)$")
_EXPLICIT = re.compile(r"\b(nude|naked|sex|penis|pussy|vaginal|anal|oral|fellatio|cum|nipples|masturbation|erection)\b")
# Same as the page's LOOK_RE / OUTFIT_RE, minus expressions (closed eyes, parted lips).
_LOOK = (r"hair\b|hair$|(?<!closed )eyes|heterochromia|bangs|ponytail|braid|twintails|\bbun\b|\bskin\b|\bears\b|\btail\b|horns|"
         r"wings|breasts|freckles|\bmole\b|pupils|eyelashes|eyebrows|(?<!parted )\blips\b|\babs\b|muscular|curvy|\bfangs?\b")
_OUTFIT = (r"dress|shirt|skirt|jacket|coat|glove|boot|shoe|\bhat\b|ribbon|\bbow\b|bowtie|uniform|kimono|sock|thighhighs|pantyhose|"
           r"leotard|bikini|swimsuit|sleeve|collar|necktie|scarf|cape|armor|apron|hood|vest|pants|shorts|belt|earring|necklace|"
           r"choker|glasses|eyewear|hairband|bra\b|panties|lingerie|sweater|sandal|heels|tiara|crown|mask|\bobi\b|sash|bodysuit|"
           r"footwear|sneakers|jeans|denim|\bsuit\b|clothes|jewelry|lipstick|makeup")
_LOOK_TAG = re.compile(_LOOK)
_OUTFIT_TAG = re.compile(_OUTFIT)
_UNDRESSED = re.compile(r"\b(nude|naked|topless|bottomless|underwear|undress\w*|lingerie|swimsuit|bikini|towel)\b")
_LOOK_OR_OUTFIT_TAG = re.compile(f"{_LOOK}|{_OUTFIT}")


async def write_scene_tags(idea, people, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, drop_looks=False):
    """A story scene -> tags without the people count, which the caller puts first."""
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    system = " ".join(x for x in (KEY_TAGS, "No people count.", _ADULTS, SFW if sfw else "") if x)
    tags = await _tipo_tags(system, idea, people, target, model, sfw, False, _LOOK_OR_OUTFIT_TAG if drop_looks else None)
    return tags if tags is not None else await write_prompt(idea, target, model, sfw=sfw)


async def _tipo_tags(system, idea, people, target, model, sfw, nude, drop, rule34=False):
    """The writer's key tags plus TIPO's, without junk and `drop` matches; None when TIPO isn't installed."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.get(OLLAMA_URL + "/api/tags") as r:
                if not any(m["name"].split(":")[0] == TIPO_MODEL for m in (await r.json(content_type=None)).get("models", [])):
                    return None
    except aiohttp.ClientConnectorError:
        return None   # _ask explains that Ollama isn't running
    key = _clean(await _ask(system, idea, model, 120, temperature=0.2), target, rule34)
    rating = "explicit" if not sfw and (nude or _EXPLICIT.search(key)) else "general"
    prefix = ", ".join(x for x in (str(people or "").strip(" ,"), key) if x)
    payload = {"model": TIPO_MODEL, "raw": True, "stream": False, "keep_alive": "2m",
               "prompt": f"rating: {rating}\ntarget: <|long|> <|short_to_tag|>\nshort: {' '.join(idea.split())[:800]}\ntag: {prefix},",
               "options": {"num_gpu": 0, "num_predict": 200, "temperature": 0.5, "min_p": 0.1}}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
        async with session.post(OLLAMA_URL + "/api/generate", json=payload) as r:
            body = await r.json(content_type=None)
            if r.status != 200:
                raise RuntimeError((body or {}).get("error") or f"Ollama returned HTTP {r.status}")
    # Who is in the picture is the writer's (or the caller's) call: TIPO likes to add a 1boy, or a man's clothes.
    boy = re.search(r"\dboys?\b|multiple boys", prefix)
    more = [t for t in _clean((body.get("response") or "").split("\n")[0], target, rule34).split(", ")
            if not _COUNT_TAG.match(t) and (boy or not re.search(r"\bmale\b|\bboys?\b|trunks", t))]
    tags = dict.fromkeys(t for t in key.split(", ") + more if t and t not in _TIPO_JUNK and not (drop and drop.search(t)))
    return ", ".join(tags)


async def _ask(system, user, model, num_predict, num_ctx=8192, temperature=0.4, fmt=None):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    # Prompts are short; without a cap Ollama sizes the KV cache for the model's full context (256K on Qwen 3.5).
    # Every call uses the same 8192 (also chat): a different num_ctx makes Ollama reload the model (~5-10 s each time).
    options = {"temperature": temperature, "num_predict": num_predict, "num_ctx": num_ctx}
    timeout = aiohttp.ClientTimeout(total=900)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            model = await _pick_model(session, model)
            try:
                text = await _chat(session, model, messages, options, fmt)
            except RuntimeError as e:
                if "memory" not in str(e).lower():
                    raise
                # Not enough VRAM next to ComfyUI: run on CPU only.
                text = await _chat(session, model, messages, dict(options, num_gpu=0), fmt)
    except aiohttp.ClientConnectorError:
        raise RuntimeError("Can't reach Ollama. The prompt writer is optional: install Ollama from ollama.com, "
                           "pull a chat model (e.g. `ollama pull mistral`) and keep it running.")
    return text


TAGS_TO_SENTENCES = ("You turn a list of image tags (Danbooru style) into a natural-language image prompt of {n} flowing sentences. "
                     "Describe, in this order: who is in the image and how they look, their clothing, pose, expression and action, "
                     "the setting, the lighting and the camera framing or angle. Use every tag, written as plain English (1girl -> "
                     "a woman, 2girls -> two women, 1boy -> a man, solo -> alone, from below -> seen from below); never copy tag "
                     "syntax. Do not invent new people, clothes, objects or places. Mention image quality only if the tags include "
                     "quality or score tags (masterpiece, best quality, score_9…), and then only in a short closing phrase. "
                     "Output ONLY the prompt: no lists, no headings, no explanations.")


async def tags_to_sentences(tags, sentences=4, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """Raw tags -> a multi-sentence prompt (for Klein, Z-Image or anywhere sentences read better than tags)."""
    tags = ", ".join(t.strip() for t in re.split(r"[,\n]+", str(tags or ""))
                     if t.strip() and t.strip().lower().replace("_", " ") not in BLOCKED_TAGS)[:4000]
    if not tags:
        raise ValueError("Paste some tags first")
    n = max(2, min(8, int(sentences or 4)))
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    system = " ".join(x for x in (TAGS_TO_SENTENCES.format(n=n), _ADULTS, SFW if sfw else "") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, tags, model, 60 * n + 100, temperature=0.5), flags=re.S)
    return " ".join(text.split()).strip().strip('"')


# ---------- assistant: a local model drives the Image Generation page ----------
# The model only plans (one JSON object); the page carries it out with its own ✨ Write and Generate,
# so the assistant uses exactly the model, LoRAs and settings the user has picked.
ASSISTANT_ACTIONS = ("generate", "write", "again", "reply")
ASSISTANT_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": list(ASSISTANT_ACTIONS)},
        "idea": {"type": "string"},
        "count": {"type": "integer"},
        "orientation": {"type": "string", "enum": ["keep", "portrait", "landscape"]},
        "character": {"type": "string"},
        "reply": {"type": "string"},
    },
    "required": ["action", "idea", "count", "orientation", "character", "reply"],
}
ASSISTANT = (
    "You are the assistant inside Kōbō, an app that draws pictures with a local image model. The user tells you what "
    "they want; you answer with one JSON object that the app carries out.\n"
    "action:\n"
    "- generate: the user wants new pictures (make, draw, generate, show me, picture of...).\n"
    "- write: the user only wants a prompt written, without drawing yet.\n"
    "- again: more pictures of the current prompt with no new idea (more, again, another one, 3 more, same again), also "
    "when they only change the count or the shape (\"make it landscape and do 3 more\").\n"
    "- reply: a question, chat or anything else; nothing is drawn.\n"
    "idea: for generate and write, one or two English sentences describing the picture: who, what they do, outfit if "
    "asked, place, lighting and mood. Keep every detail the user asked for, add nothing they didn't. Leave out the "
    "number of pictures and the picture shape. A character from an anime, game or other series keeps their name and "
    "series exactly (\"Frieren from Sousou no Frieren\"): never replace them with a made-up description of their "
    "looks. Empty for again and reply.\n"
    "count: the number of pictures the user wrote (\"4 pictures\", \"five\", \"3 more\", \"another one\" = 1); 0 when they "
    "wrote no number, even for \"a picture of\" or \"draw\": 0 keeps the user's own setting.\n"
    "orientation: portrait only when the user asks for tall/vertical/portrait/phone wallpaper, landscape only for "
    "wide/horizontal/landscape/desktop wallpaper; keep when they didn't mention the shape (most requests).\n"
    "character: when the user names one of their saved characters, that name exactly as listed; \"none\" when they ask "
    "for no saved character or a different person; otherwise empty.\n"
    "reply: one short, friendly sentence telling the user what you're doing, or the answer to their question.")


async def assistant_plan(message, history=(), characters=(), model=DEFAULT_MODEL, sfw=False):
    """What the user asked for, as {action, idea, count, orientation, character, reply} for the page to carry out."""
    message = " ".join(str(message or "").split())[:1500]
    if not message:
        raise ValueError("Type what you want first")
    names = [str(n)[:60] for n in characters if str(n).strip()][:200]
    named = _named_tags(message)
    kids = [genshin()[t]["name"] for t, _ in named if genshin().get(t, {}).get("child")]
    if kids and (not sfw or _ASK_EXPLICIT.search(message.lower())):
        return {"action": "reply", "idea": "", "count": 0, "orientation": "keep", "character": "", "reply": _kids_reply(kids)}
    known = f"Characters in this message, write them in the idea exactly as: {_who(named)}." if _who(named) else ""
    system = " ".join(x for x in (
        ASSISTANT, "The user's saved characters: " + (", ".join(names) if names else "none") + ".", known,
        "" if kids else _ADULTS,   # General workspace: a safe picture of a child-model character is fine
        SFW if sfw else ADULT_ASK) if x)
    # Earlier turns go in as a transcript, so "two more, but at night" knows what "more" refers to.
    turns = [t for t in history if isinstance(t, dict)][-6:]
    earlier = "\n".join(f"User: {str(t.get('user', ''))[:300]}\nYou: {str(t.get('assistant', ''))[:300]}" for t in turns)
    user = f"Earlier in this conversation:\n{earlier}\n\nNow the user says: {message}" if earlier else message
    text = await _ask(system, user, model, 400, temperature=0.2, fmt=ASSISTANT_SCHEMA)
    plan = _assistant_clean(text, names, message)
    # A small model sometimes renames or drops a character it doesn't know ("ayaka" -> "Aya from Blue Archive").
    missing = [genshin()[t]["name"] for t, cat in named if t in genshin() and cat == "4"
               and genshin()[t]["name"].lower() not in plan["idea"].lower()]
    if missing and plan["action"] in ("generate", "write"):
        plan["idea"] = f"{' and '.join(missing)} from Genshin Impact: {plan['idea']}"[:800]
    # Even abliterated small models soften "nude" to "in underwear": in the Adult workspace the user's words win.
    dropped = [] if sfw else [w for w in dict.fromkeys(_EXPLICIT.findall(message.lower())) if w not in plan["idea"].lower()]
    if dropped and plan["action"] in ("generate", "write"):
        plan["idea"] = f"{plan['idea'].rstrip('.')}, {', '.join(dropped)}"[:800]
    return plan


ADULT_ASK = ("This is the Adult (18+) workspace: nudity and sex between adults are allowed. Keep the user's words for "
             "them (nude, naked, sex…) in the idea; never tone a request down.")


def _kids_reply(kids):
    one = len(kids) == 1
    return (f"{' and '.join(kids)} {'is a child character' if one else 'are child characters'} in Genshin Impact, so I only "
            f"draw {'them' if not one else 'that character'} in the General workspace, in safe pictures.")


_ASK_EXPLICIT = re.compile(rf"{_EXPLICIT.pattern}|\b(nsfw|lewd|hentai|porn|erotic|naughty|undress|strip|topless|lingerie|r18|18\+)")

# Small models pick a shape for almost every request, which would resize the user's pictures: only a shape word counts.
_SHAPE_WORDS = re.compile(r"\b(portrait|landscape|vertical|horizontal|widescreen|wallpaper|phone|desktop)\b", re.I)


def _assistant_clean(text, names, message=""):
    """Never trust the model's JSON: unknown actions become a reply, counts are clamped, names must be the user's own."""
    try:
        plan = json.loads(re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip())
    except json.JSONDecodeError:
        plan = {}
    if not isinstance(plan, dict):
        plan = {}
    action = plan.get("action") if plan.get("action") in ASSISTANT_ACTIONS else "reply"
    idea = " ".join(str(plan.get("idea") or "").split())[:800]
    if action in ("generate", "write") and not idea:
        action = "again" if action == "generate" else "reply"
    if _BLOCKED_WORDS.search(idea.lower()):
        action, idea = "reply", ""
        plan["reply"] = "I can't make that: every person in a picture has to be an adult."
    try:
        count = max(0, min(16, int(plan.get("count") or 0)))
    except (TypeError, ValueError):
        count = 0
    shaped = plan.get("orientation") in ("portrait", "landscape") and _SHAPE_WORDS.search(message)
    orientation = plan["orientation"] if shaped else "keep"
    want = str(plan.get("character") or "").strip().lower()
    character = "none" if want == "none" else next((n for n in names if n.lower() == want), "")
    reply = " ".join(str(plan.get("reply") or "").split())[:1000] or ("On it." if action != "reply" else "Sorry, I didn't get that.")
    return {"action": action, "idea": idea, "count": count, "orientation": orientation, "character": character, "reply": reply}


# Workflow review step: a second pass checks the written prompt against the idea before the test picture.
REVIEW = ("You check an image prompt before it is drawn. Compare it with the user's idea: put back anything from the idea "
          "that is missing, remove anything that contradicts it, fix contradictions inside the prompt (two places, two "
          "framings, clothes that clash) and keep the same format (tags stay tags, sentences stay sentences). Change "
          "nothing else. notes: one short sentence saying what you changed, or \"Looks good.\" when nothing needed fixing. "
          "prompt: the full corrected prompt.")
REVIEW_SCHEMA = {"type": "object", "properties": {"notes": {"type": "string"}, "prompt": {"type": "string"}},
                 "required": ["notes", "prompt"]}


def _review_clean(text, prompt, target):
    """The reviewer's JSON, never trusted: an empty, unreadable or blocked result keeps the original prompt."""
    try:
        r = json.loads(re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip())
    except json.JSONDecodeError:
        r = {}
    if not isinstance(r, dict):
        r = {}
    fixed = _clean(str(r.get("prompt") or ""), target)
    notes = " ".join(str(r.get("notes") or "").split())[:300]
    if not fixed or _BLOCKED_WORDS.search(fixed.lower()):
        return {"prompt": prompt, "notes": "Kept the prompt as written."}
    return {"prompt": fixed, "notes": notes or "Reviewed."}


async def review_prompt(idea, prompt, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, character=None, notes=""):
    if target not in SYSTEM:
        raise ValueError(f"Unknown target {target!r}")
    prompt = " ".join(str(prompt or "").split())[:4000]
    if not prompt:
        raise ValueError("There's no prompt to review")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    system = " ".join(x for x in (REVIEW, SYSTEM[target], _ADULTS, SFW if sfw else "", _character_context(character), _notes(notes)) if x)
    user = f"Idea: {' '.join(str(idea or '').split())[:1500] or '(none, keep the prompt as it is)'}\n\nPrompt: {prompt}"
    return _review_clean(await _ask(system, user, model, 500, temperature=0.2, fmt=REVIEW_SCHEMA), prompt, target)


SEQ_TAGS = ("Each line is ONLY lowercase Danbooru tags separated by commas (6-15 tags) for that moment: pose, action, "
            "expression, where in the setting the character is, and camera angle or framing. Use only tags that exist on "
            "Danbooru; invented tags are thrown away. No sentences, no numbering, no quality tags.")
SEQ_SENTENCES = "Each line is ONE sentence describing that moment: pose, action, expression, where in the setting the character is, and the camera framing."


async def write_sequence(story, frames, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, character=None):
    """Split one continuous action into `frames` consecutive moments, one prompt fragment per frame."""
    if target not in SYSTEM:
        raise ValueError(f"Unknown target {target!r}")
    frames = max(2, min(8, int(frames)))
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    system = " ".join(x for x in (
        f"You plan a storyboard: {frames} consecutive frames of ONE continuous action, from its first moment to its last, "
        "like keyframes of a short film. The same character stays in the same place, outfit and lighting the whole time; "
        "only their position, pose, expression and the camera change, step by step, so the frames read as a sequence. "
        f"Output exactly {frames} lines, one per frame, in order, and nothing else.",
        SEQ_SENTENCES if target not in TAG_TARGETS else SEQ_TAGS, _ADULTS, SFW if sfw else "", _character_context(character)) if x)
    beats = _beat_lines(await _ask(system, story, model, 120 * frames), target, frames)
    if len(beats) < 2:
        raise RuntimeError("The prompt writer didn't return usable frames; try rewording the action.")
    return beats


def _beat_lines(text, target, limit):
    """One cleaned prompt fragment per line of the model's answer, without numbering, chatter or blocked words."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    lines = [re.sub(r"^\s*(?:(?:frame|shot)\s*\d+\s*[:.)-]|\d+\s*[:.)-]|[-*•])\s*", "", l, flags=re.I).strip() for l in text.splitlines()]
    beats = [_clean(l, target) for l in lines if l and not l.lower().startswith(("here", "sure", "storyboard", "shot list"))]
    return [b for b in beats if b and not _BLOCKED_WORDS.search(b.lower())][:limit]


# A set like AI artists post on Patreon: one theme, the same character, outfit, place and lighting in every shot; only the
# pose, camera and expression change. Shot 1 is the hero shot that establishes the look (later shots are drawn from it).
SET_MIN, SET_MAX = 4, 35

# Clothing that changes during a set ("she takes her top off in shot 3, her pants in shot 16, then she's nude") is not left
# to the shot planner: small models lose track of it within a few lines. The changes are read from the idea as a short
# list (_set_stages), and the code writes what she wears into every shot (_set_shots).
SET_STAGES = ("Read the idea for a picture set of {n} shots. List ONLY the shots where the character's clothing changes "
              "(usually 1 to 3 entries, never one per shot), with the shot number where it happens. wearing: lowercase "
              "Danbooru tags for everything she still wears from that shot on. Her top means every piece on her upper body, "
              "never only the jacket: taking off the top removes the jacket, coat, shirt, blouse and bra, so she is topless; taking off the pants or skirt removes "
              "everything below. Count the earlier changes too (top off, pants still on: topless, pants). Use completely nude "
              "once nothing is left. The clothing before the first change is: {start}. Example for 'she takes her top off "
              "in shot 4 and is naked from shot 10': [{{\"shot\": 4, \"wearing\": \"topless, skirt\"}}, {{\"shot\": 10, "
              "\"wearing\": \"completely nude\"}}]. stages is an empty list when the clothing never changes.")
SET_STAGES_SCHEMA = {"type": "object", "properties": {"stages": {"type": "array", "items": {
    "type": "object", "properties": {"shot": {"type": "integer"}, "wearing": {"type": "string"}}, "required": ["shot", "wearing"]}}},
    "required": ["stages"]}
_CHANGES_CLOTHES = re.compile(r"\bshots?\s*\d+|undress|strip|take[sn]? (?:off|of)|took off|remov|nude|naked|topless|bottomless|"
                              r"changes? (?:into|clothes|outfit)|puts? on", re.I)
_QUALITY_TAG = re.compile(r"\b(?:quality|masterpiece|absurdres|highres|score_\d\w*)\b")
_SET_CLOTHING = re.compile(f"{_OUTFIT}|{_UNDRESSED.pattern}|{_EXPLICIT.pattern}|cleft of venus|areola")
_FRAMING = re.compile(r"^(?:close-up|portrait|upper body|cowboy shot|full body|lower body|feet out of frame|dutch angle|"
                      r"from (?:side|behind|above|below))$")
# Pose, action and expression: each shot has its own, so the main prompt of a set must not repeat one in every shot.
_POSE = re.compile(r"\b(?:standing|sitting|kneeling|lying|leaning|squatting|crouching|walking|running|bending|bent over|spread legs|"
                   r"crossed (?:arms|legs)|arms? (?:up|behind|crossed)|hands? (?:on|up|in|behind|together)|own hands|holding|"
                   r"looking (?:at|down|up|away|back|to)|smile|smirk|frown|pout|annoyed|frustrated|angry|furious|sigh|"
                   r"determined|staring|glaring|blush|open mouth|closed eyes|crying|tears|expressionless|satisfied|"
                   r"relaxed|exhausted|throwing|on (?:desk|chair|bed|floor|couch))\b")
# Tags the clothing patterns catch by accident ("collar" in collarbone, "dress" in undressing) or that show skin.
_NOT_CLOTHES = re.compile(r"collarbone|undress|cleavage|navel|uncensored|\bbare\b")
_TEXT_TAG = re.compile(r"^(?:speech bubble|english text|text|spoken \w+|thought bubble|comic|watermark|signature)$")   # text in every shot


def _set_base(prompt, stages, target):
    """The main prompt of a set keeps only the shared look (who, place, light, style). The framing, pose and expression
    belong to each shot, and with clothing stages so do clothes and skin (the writer puts the whole story into the
    prompt: "nude, close-up, leaning forward")."""
    if target not in TAG_TARGETS:
        return prompt
    return ", ".join(t for t in _tags(prompt) if not _FRAMING.match(t.lower()) and not _POSE.search(t.lower()) and not _TEXT_TAG.match(t.lower())
                     and not (stages and (_SET_CLOTHING.search(t.lower()) or _NOT_CLOTHES.search(t.lower()))))


def _tags(text):
    return [t.strip() for t in str(text or "").split(",") if t.strip()]


_UPPER_WEAR = re.compile(r"jacket|coat|shirt|blouse|\bbra\b|sweater|hoodie|cardigan|\bvest\b|\btop\b|corset|tank top|camisole")
_LOWER_WEAR = re.compile(r"pants|trousers|skirt|shorts|jeans|panties|underwear|thong")


def _undressed(wearing):
    """Models write "topless, jacket, shirt": topless drops the upper-body clothes, bottomless the lower, nude all of them."""
    tags, low = _tags(wearing), wearing.lower()
    if re.search(r"\b(?:completely nude|nude|naked)\b", low):
        return ", ".join(t for t in tags if not _OUTFIT_TAG.search(t.lower()))
    if "topless" in low:
        tags = [t for t in tags if t.lower() == "topless" or not _UPPER_WEAR.search(t.lower())]
    if "bottomless" in low:
        tags = [t for t in tags if t.lower() == "bottomless" or not _LOWER_WEAR.search(t.lower())]
    return ", ".join(tags)


def _stages_clean(text, shots, target, sfw, start=""):
    """[(shot, wearing)] for the shots where the clothing really changes, sorted. A model that lists every shot, or runs
    out of tokens halfway, still counts: the pairs are read even from cut-off JSON and repeats of the same clothing are
    folded into the change that started them. Out of range, blocked or (General workspace) nude stages are dropped."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    pairs = re.findall(r'"shot"\s*:\s*"?(\d+)"?\s*,\s*"wearing"\s*:\s*"([^"]*)"', text)
    found = {}
    for shot, wearing in pairs:
        wearing, shot = _undressed(_clean(wearing, target)), int(shot)
        low = wearing.lower()
        if 1 <= shot <= shots and wearing and not _BLOCKED_WORDS.search(low) and not (sfw and (_EXPLICIT.search(low) or "topless" in low)):
            found[shot] = wearing
    same = lambda a, b: {t.lower() for t in _tags(a)} == {t.lower() for t in _tags(b)}
    out, now = [], _clean(start, target) if start else ""
    for shot, wearing in sorted(found.items()):
        if not same(wearing, now):
            out.append((shot, wearing))
            now = wearing
    return out


def _set_shots(beats, base, stages, start, target):
    """The shot lines. With clothing stages, every shot says what she wears at that point (the page takes the clothing out
    of the main prompt while the set is drawn) and the shot where a change happens also gets undressing."""
    tagged = target in TAG_TARGETS
    have = {t.lower() for t in _tags(base)}
    out = []
    for i, beat in enumerate(beats, 1):
        wearing = next((w for s, w in reversed(stages) if s <= i), start)
        if not tagged:
            out.append(f"{beat} Clothing: {wearing}." if stages and wearing else beat)
            continue
        tags = [t for t in _tags(beat) if t.lower() not in have and not _QUALITY_TAG.search(t.lower())
                and not (stages and _SET_CLOTHING.search(t.lower()))]
        if stages:
            tags += (["undressing"] if any(s == i for s, _ in stages) else []) + _tags(wearing)
        out.append(", ".join(dict.fromkeys(tags)))
    return out


async def plan_set(idea, prompt, shots, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, character=None, notes="", outfit=""):
    """{shots, stages, outfit, base}: the shot list, the clothing changes found in the idea, the clothing before the first
    one, and the main prompt to draw the set with."""
    if target not in SYSTEM:
        raise ValueError(f"Unknown target {target!r}")
    shots = max(SET_MIN, min(SET_MAX, int(shots)))
    idea = " ".join(str(idea or "").split())[:1500]
    prompt = " ".join(str(prompt or "").split())[:3000]
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    worn = [t for t in _tags(prompt) if _OUTFIT_TAG.search(t.lower()) and not _NOT_CLOTHES.search(t.lower())
            and not _UNDRESSED.search(t.lower()) and not _EXPLICIT.search(t.lower())]
    start = ", ".join(dict.fromkeys(worn + _tags(outfit)))
    stages = []
    if _CHANGES_CLOTHES.search(idea):
        system = " ".join(x for x in (SET_STAGES.format(n=shots, start=start or "her usual outfit"), _ADULTS, SFW if sfw else "") if x)
        stages = _stages_clean(await _ask(system, idea, model, 900, temperature=0.1, fmt=SET_STAGES_SCHEMA), shots, target, sfw, start)
    look = ("Every shot shows the same character in the same place, time of day and lighting (already in the main prompt, so "
            "never mention them). Her clothing changes during the set at the shots listed below; that is added to every shot "
            "for you, so never mention clothes or nudity, but make the poses, actions and expressions fit what is happening."
            if stages else
            "Every shot shows the same character in the same outfit, place, time of day and lighting (those are already in "
            "the main prompt, so never mention clothes, place or lighting).")
    system = " ".join(x for x in (
        f"You plan a themed picture set of {shots} shots, like the sets AI artists post on Patreon. {look} Each line is one "
        "shot and changes only the pose, action, expression and the camera. Shot 1 is the hero shot: the character fully "
        "in view, showing the setting. Then mix the framing: about a third full body, a third cowboy shot or upper body, a "
        "third close-ups (portrait, face, hands); vary the angle (from the front, side, behind, above, below) and never "
        "repeat a pose. Order the shots so the set flows like a photoshoot that follows the idea. No quality tags. "
        f"Output exactly {shots} lines, one per shot, and nothing else.",
        SEQ_SENTENCES if target not in TAG_TARGETS else SEQ_TAGS, _ADULTS, SFW if sfw else "", _character_context(character),
        _notes(notes)) if x)
    if stages:   # the writer rarely lists the whole outfit, and a bare "pants" draws her in a bra before the top comes off
        start = ", ".join(dict.fromkeys(_tags(start) + ["fully clothed"]))
    changes = "\n".join(f"Shot {s}: {w}" for s, w in stages)
    base = _set_base(prompt, stages, target)
    user = f"Theme: {idea}\n\nMain prompt: {base}" + (f"\n\nClothing changes:\n{changes}" if changes else "")
    beats = _beat_lines(await _ask(system, user, model, 90 * shots), target, shots)
    if 2 <= len(beats) < shots:   # small models often stop a line or two short; ask once for the rest
        more = shots - len(beats)
        user += "\n\nShots so far:\n" + "\n".join(beats) + f"\n\nWrite the last {more} shots, different from these."
        beats += _beat_lines(await _ask(system.replace(f"exactly {shots} lines", f"exactly {more} lines"), user, model, 90 * more + 100), target, more)
    if len(beats) < 2:
        raise RuntimeError("The AI didn't return usable shots; try again or reword the idea.")
    return {"shots": _set_shots(beats, base, stages, start, target), "stages": [{"shot": s, "wearing": w} for s, w in stages],
            "outfit": _tags(start), "base": base}


_BLOCKED_WORDS = re.compile(r"\b(?:%s)\b" % "|".join(map(re.escape, BLOCKED_TAGS)))

# Workflow chat: "remove the lantern, add rain, make shot 3 a close-up" -> the edited prompt and shot list.
EDIT = ("You edit an image prompt, and its shot list when there is one, exactly as the user's instruction says. Add what they "
        "ask to add, remove what they ask to remove (every mention of it), change nothing else, and keep the same format "
        "(tags stay tags, sentences stay sentences, one shot per line). \"Shot 3\" means the third line of the shot list; "
        "keep the number of shots unless they ask for more or fewer. If the instruction is only a question, change nothing. "
        "prompt: the full prompt after the edit. shots: the shot list after the edit, empty when there is none. "
        "reply: one short sentence saying what you changed, or the answer to their question.")
EDIT_SCHEMA = {"type": "object", "properties": {"prompt": {"type": "string"}, "shots": {"type": "array", "items": {"type": "string"}},
                                                "reply": {"type": "string"}}, "required": ["prompt", "shots", "reply"]}


def _edit_prompt(text, old, target):
    """The edited prompt. For tag models, tags the user already had stay exactly as they were (trigger words, artists and
    other tags Danbooru doesn't list would otherwise be thrown away); only tags the editor adds go through _clean."""
    if target not in TAG_TARGETS:
        return _clean(text, target)
    key = lambda t: re.sub(r"^(?:[-*•]\s*|\d+[.)]\s+)", "", t.strip().lower()).replace("_", " ").strip(" .")
    mine = {key(t): t.strip() for t in re.split(r"[,\n]+", old) if key(t)}
    out = []
    for t in re.split(r"[,\n]+", re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)):
        k = key(t)
        new = [mine[k]] if k in mine else _clean(k, target).split(", ") if k else []
        out += [x for x in new if x and key(x) not in BLOCKED_TAGS and x not in out]
    return ", ".join(out)


def _edit_clean(text, prompt, shots, target):
    """The editor's JSON, never trusted: anything unreadable or blocked keeps the prompt and shots as they were."""
    try:
        r = json.loads(re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip())
    except json.JSONDecodeError:
        r = {}
    r = r if isinstance(r, dict) else {}
    new_prompt = _edit_prompt(str(r.get("prompt") or ""), prompt, target)
    new_shots = _beat_lines("\n".join(str(s) for s in r.get("shots") or [] if isinstance(s, str)), target, SET_MAX) if shots else []
    reply = " ".join(str(r.get("reply") or "").split())[:500]
    if not new_prompt or _BLOCKED_WORDS.search(f"{new_prompt} {' '.join(new_shots)}".lower()):
        return {"prompt": prompt, "shots": shots, "reply": "I couldn't make that change, so nothing was changed.", "changed": False}
    if shots and len(new_shots) < 2:
        new_shots = shots   # a shot list that lost its shots is a bad edit; keep the prompt change only
    changed = new_prompt != prompt or new_shots != shots
    return {"prompt": new_prompt, "shots": new_shots, "reply": reply or ("Done." if changed else "Nothing to change."), "changed": changed}


async def edit_workflow(instruction, prompt, shots, target, model=DEFAULT_MODEL, free_vram=None, sfw=False, character=None, notes=""):
    if target not in SYSTEM:
        raise ValueError(f"Unknown target {target!r}")
    instruction = " ".join(str(instruction or "").split())[:800]
    if not instruction:
        raise ValueError("Tell me what to add or remove")
    prompt = " ".join(str(prompt or "").split())[:4000]
    shots = [" ".join(str(s).split())[:400] for s in (shots or []) if str(s).strip()][:SET_MAX]
    if _BLOCKED_WORDS.search(instruction.lower()):
        return {"prompt": prompt, "shots": shots, "reply": "I can't add that: every person in a picture has to be an adult.", "changed": False}
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    system = " ".join(x for x in (EDIT, SYSTEM[target], _ADULTS, SFW if sfw else "", _character_context(character), _notes(notes)) if x)
    listing = "\n".join(f"{i}. {s}" for i, s in enumerate(shots, 1)) or "(none)"
    user = f"Instruction: {instruction}\n\nPrompt: {prompt or '(empty)'}\n\nShot list:\n{listing}"
    text = await _ask(system, user, model, 150 * max(2, len(shots)) + 300, temperature=0.2, fmt=EDIT_SCHEMA)
    return _edit_clean(text, prompt, shots, target)


async def sort_tags(tags, categories, model=DEFAULT_MODEL, free_vram=None):
    """Which Tag library category each tag belongs in: {tag: category name}. Tags that fit nowhere are left out."""
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    categories = [c for c in categories if c["name"].lower() not in BLOCKED_TAGS]
    tags = [t for t in tags if not _BLOCKED_WORDS.search(t.lower())]
    if not tags or not categories:
        return {}
    listing = "\n".join(f"- {c['name']}" + (f" (e.g. {', '.join(c['tags'][:10])})" if c["tags"] else "") for c in categories)
    system = ("You sort image tags (Danbooru style) into the categories of a tag library. Categories:\n" + listing +
              "\nFor every tag the user lists, output one line: <tag> | <category name>. Use the best-fitting category; "
              "write a category name exactly as listed, or ? if no category fits at all. Output nothing else.")
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, "\n".join(tags), model, 14 * len(tags) + 40, temperature=0), flags=re.S)
    names, wanted, out = {c["name"].lower(): c["name"] for c in categories}, {t.lower(): t for t in tags}, {}
    for line in text.splitlines():
        tag, _, name = line.rpartition("|")
        tag, name = wanted.get(tag.strip().lower()), names.get(name.strip().lower())
        if tag and name:
            out[tag] = name
    return out


# ---------- story: a novel told in many images ----------
# Planned in two steps so a small local model never has to write 100+ scenes at once: first a cover and a chapter
# outline, then each chapter's scenes (narration + image prompt), with the outline and the previous scene as context.
# Explicit stories are paced like an adult comic: a dressed set-up first, then escalating chapter by chapter.
STORY_LEVELS = {
    "safe": SFW,
    "spicy": ("This is an explicit erotic story for adults (18+), told like an adult comic. Sexual acts between adults are "
              "allowed, but the main characters always keep their outfit on, opened, pulled up or pulled aside: bare breasts "
              "are fine, but they are never fully nude and their genitals always stay covered or out of frame."),
    "nude": ("This is an explicit erotic story for adults (18+), told like an adult comic. Sexual acts between adults are "
             "allowed. The main characters are completely nude in every scene: no clothes or underwear at all; only "
             "stockings, thighhighs, high heels, jewelry or accessories."),
    "strip": ("This is an explicit erotic story for adults (18+), told like an adult comic. Sexual acts between adults are "
              "allowed. The main character starts fully dressed and loses their clothes as the story goes on: they undress, "
              "or their partner takes the clothes off them, piece by piece, until they are completely nude near the end."),
}
_COMIC_ARC = ("Pace it like an adult comic: chapter 1 sets up the situation with only teasing, then every chapter escalates "
              "step by step, the most explicit chapters come near the end, and the last chapter is the ending.")
STORY_ARC = {
    "safe": "The chapters follow one continuous plot with a beginning, rising tension, a high point and an ending.",
    "spicy": _COMIC_ARC,
    "nude": _COMIC_ARC,
    "strip": _COMIC_ARC,
}
# "strip" stories: how far into the whole story a scene is decides how dressed the main characters are.
STRIP_STAGES = (
    (0.3, "{who} is fully dressed{outfit}"),
    (0.5, "{who}'s outfit{outfit} comes off step by step: opened, pulled down or taken off by {who} or their partner"),
    (0.7, "{who} is down to underwear, or topless with the rest of the outfit pulled aside"),
    (1.0, "{who} is completely nude: no clothes or underwear at all, only stockings, thighhighs, high heels or jewelry "
          "(tag nude, completely nude)"),
)


def _main_name(cast):
    cast = _cast_list(cast)
    return str(cast[0]["name"])[:60] if cast else "the main character"


def _strip_plan(chs, index, first, scenes, outfit, who):
    """Stage (0-3) of each of the `scenes` scenes starting at scene `first` of chapter `index`, and the writer's instructions."""
    wants = [max(1, int(c.get("want") or scenes)) for c in chs]
    total, start = sum(wants), sum(wants[:index]) + first
    stages = [next(i for i, (end, _) in enumerate(STRIP_STAGES) if (start + k) / total < end or i == 3) for k in range(scenes)]
    outfit = f" ({outfit})" if outfit else ""
    runs = []
    for k, st in enumerate(stages):
        if runs and runs[-1][2] == st:
            runs[-1][1] = k
        else:
            runs.append([k, k, st])
    text = " ".join(f"Scene{f' {a + 1}' if a == b else f's {a + 1}-{b + 1}'}: " + STRIP_STAGES[st][1].format(outfit=outfit, who=who) + "."
                    for a, b, st in runs)
    return stages, text + f" Every image prompt shows exactly what {who} still wears with clothing tags (e.g. open shirt, bra, panties, topless, nude)."


_SEX = {"1girl": "a woman", "1boy": "a man", "1other": "a person"}


def _cast_list(cast):
    """cast: one character dict or a list (main character first, then an optional co-star). "count" is their 1girl/1boy tag."""
    return [c for c in (cast if isinstance(cast, list) else [cast]) if isinstance(c, dict) and c.get("name")][:2]


def _count_tags(cast):
    """'1girl, 1boy' for a woman and a man, '2girls' for two women; empty when a count is unknown."""
    if not cast or any(c.get("count") not in _SEX for c in cast):
        return ""
    n = {k: sum(1 for c in cast if c["count"] == k) for k in _SEX}
    return ", ".join(f"{v}{k[1:]}{'s' if v > 1 else ''}" for k, v in n.items() if v)


def _story_cast(cast):
    cast = _cast_list(cast)
    if not cast:
        return ""
    names = [f'"{str(c["name"])[:60]}"' + (f" ({_SEX[c['count']]})" if c.get("count") in _SEX else "") for c in cast]
    out = (f"The story is about the character {names[0]}." if len(cast) == 1 else
           f"The story is about two characters, {names[0]} and {names[1]}, who appear together in almost every scene.")
    for c in cast:
        if c.get("memory"):
            out += f" Facts about {str(c['name'])[:60]}: " + str(c["memory"])[:1500]
    return out


def _others(target, cast):
    pair, counts = len(cast) > 1, _count_tags(cast)
    who = "both main characters plus any others" if pair else "the main character plus any others"
    example = (f"{counts} when only {'the two main characters are' if pair else 'the main character is'} in the image"
               if counts else "e.g. 2girls, 1boy")
    return ("Other adults (partners, extras) may appear. "
            + (f"Start each image prompt with the people-count tags for {who} ({example}) and describe the others' look; "
               if target in TAG_TARGETS else "Mention everyone in the image and describe the others' look; ")
            + "they can be partly out of frame.")


def _cells(line, n):
    parts = [p.strip().strip('"').strip() for p in re.split(r"\s*\|\|?\s*", line)]
    return (parts + [""] * n)[:n]




def _is_prose(seg):
    words = seg.split()
    return len(words) >= 6 and len(words) > 4 * (seg.count(",") + 1) - 4   # a sentence, not a comma-separated tag list


def _scene_lines(text):
    """[narration, prompt] pairs in whatever layout the model used: '<narration> || <prompt>' per line, the two the
    other way round, a prose line followed by tag lines, or every scene chained with '||' on one line."""
    def clean(s):
        return re.sub(r"^\s*(?:scene\s*\d+\s*[:.)-]|\d+\s*[:.)-]|[-*•])\s*", "", s.strip(), flags=re.I).strip().strip(";").strip()

    pairs, segs = [], []
    for line in text.splitlines():
        # '||' already says which part is which, so trust it instead of guessing prose vs tags
        # (short narrations with a few commas look like tag lists to _is_prose).
        parts = [p for p in (clean(s) for s in re.split(r"\s*\|\|\s*", line)) if p]
        if "||" in line and len(parts) % 2 == 0:
            for a, b in zip(parts[::2], parts[1::2]):
                pairs.append([b, a] if _is_prose(b) and not _is_prose(a) else [a, b])
            continue
        for s in re.split(r"\s*\|\|?\s*", line):
            s = clean(s)
            if s:
                segs.append(s)
    prose_first = next((_is_prose(s) for s in segs), True)
    tags = []
    for s in segs:
        if _is_prose(s):
            pairs.append([s, "" if prose_first else ", ".join(tags)])
            tags = []
        elif prose_first:
            if pairs:
                pairs[-1][1] = ", ".join(x for x in (pairs[-1][1], s) if x)
        else:
            tags.append(s)
    return pairs


async def write_story_outline(premise, chapters, level, target, model=DEFAULT_MODEL, free_vram=None, character=None):
    """Title, cover image prompt and `chapters` chapter lines: title, setting, outfit, what happens."""
    if target not in SYSTEM or level not in STORY_LEVELS:
        raise ValueError("Unknown target or story type")
    chapters = max(1, min(40, int(chapters)))
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    outfit = ("always 'nude'" if level == "nude" else
              f"everything {_main_name(character)} wears at the start (top, bottom, underwear, shoes), the same in every chapter line, "
              "since it comes off piece by piece" if level == "strip" else
              "what they wear in this chapter (it can change between chapters" + (", sexy and revealing" if level == "spicy" else "") + ")")
    cover = (("Danbooru tags for the cover image" if target in TAG_TARGETS else "one sentence describing the cover image")
             + ": the main character(s) posing, eye-catching, like a comic cover, without describing their face, hair or body")
    system = " ".join(x for x in (
        f"You are a novelist planning an illustrated story told in {chapters} chapters; each chapter moves to a new place or moment.",
        STORY_ARC[level], STORY_LEVELS[level], _ADULTS, _story_cast(character),
        f"Output a title line, a cover line, then exactly {chapters} chapter lines, and nothing else, in this format:\n"
        "TITLE: <story title>\n"
        f"COVER: <{cover}>\n"
        f"CHAPTER: <chapter title> | <setting: where and when> | <outfit: {outfit}> | <what happens, 1-2 sentences>") if x)
    user = premise.strip() or "Invent an original story that fits the characters."
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 90 * chapters + 120, 8192, 0.8), flags=re.S)
    title, cover_prompt, out = "", "", []
    for line in text.splitlines():
        line = line.strip().strip("*").strip()
        m = re.match(r"^(title|cover)\s*:\s*(.+)$", line, re.I)
        if m:
            if m.group(1).lower() == "title" and not title:
                title = m.group(2).strip().strip('"*')
            elif m.group(1).lower() == "cover" and not cover_prompt:
                cover_prompt = _clean(m.group(2), target)
            continue
        line = re.sub(r"^(?:chapter\s*\d*\s*[:.)-]?|\d+\s*[:.)-])\s*", "", line, flags=re.I)
        if line.count("|") < 2:
            continue
        name, setting, wear, summary = _cells(line, 4)
        if level == "nude":
            wear = ""
        elif target in TAG_TARGETS:
            wear = _clean(wear, target)
        out.append({"title": name[:120], "setting": setting[:300], "outfit": wear[:400], "summary": summary[:600]})
    out = out[:chapters]
    if not out:
        raise RuntimeError("The prompt writer didn't return a usable outline; try again or reword the premise.")
    return {"title": (title or "Untitled story")[:120], "cover": cover_prompt[:1200], "chapters": out}


# 🎞 From video: the page sends frames spread over the video; JoyCaption describes each, the writer turns them into a premise.
CAPTION_MODEL = "joycaption-beta-one"
VIDEO_FRAMES = 16
FRAME_PROMPT = ("Write a straightforward caption for this image in 2-4 sentences. Say how many people there are and each "
                "person's apparent age, what they are doing, what they wear, where they are, and any animals (only if there are some).")
VIDEO_PREMISE = ("You are given descriptions of frames from one video, in time order. Write the premise of a story that follows "
                 "the same events: where it happens, what happens first, how it builds and how it ends. Retell it with the cast "
                 "below instead of the people in the video; anyone else in the video is an unnamed side character. Don't describe "
                 "anyone's hair, eye or skin colour, face or body: the cast has its own looks. Skip title cards, logos, credits, on-screen "
                 "text and blank frames. Write 5-8 plain sentences: no title, no headings, no lists. "
                 "If the frames show anyone under 18 in a sexual situation, or sexual content with an animal, output only the word REFUSE.")
_MINOR_WORDS = re.compile(r"\b(child|children|kids?|toddlers?|infants?|bab(y|ies)|minors?|underage|preteens?|teens?|teenage|teenagers?|"
                          r"schoolgirls?|schoolboys?|little (girl|boy)s?|young (girl|boy)s?|loli|shota|(1[0-7]|[1-9])[- ]years?[- ]old)\b", re.I)
_ANIMAL_WORDS = re.compile(r"\b(dogs?|pupp(y|ies)|cats?|kittens?|horses?|ponies|pony|animals?|pets?|goats?|pigs?|sheep|cows?)\b", re.I)
_SEXUAL_WORDS = re.compile(r"\b(nude|naked|sex|sexual|sexually|intercourse|penis|pussy|vagina|vaginal|anal|oral|fellatio|cum|"
                           r"nipples?|masturbat\w*|erect\w*|genitals?|topless|breasts?|aroused|penetrat\w*)\b", re.I)
VIDEO_STOP = "This video can't be used: it seems to show {}. Pick another video."
_NO_SCENE = re.compile(r"\b(logo|text|words?|graphic|title|credits|blank|solid (black|gr[ae]y|white))\b", re.I)
# "There are no people, animals or children" must not count as seeing them.
_NONE_SEEN = re.compile(r"\b(?:no|without|zero|0)\s+(?:visible\s+)?(?:people|persons|humans|animals|pets|children|kids|other|additional)\b[^.]*", re.I)


async def _caption_frame(session, image_b64):
    payload = {"model": CAPTION_MODEL, "stream": False, "keep_alive": "1m", "options": {"num_predict": 200, "temperature": 0.3},
               "messages": [{"role": "user", "content": FRAME_PROMPT, "images": [image_b64]}]}
    async with session.post(OLLAMA_URL + "/api/chat", json=payload) as r:
        body = await r.json(content_type=None)
        if r.status != 200:
            raise RuntimeError((body or {}).get("error") or f"Ollama returned HTTP {r.status}")
        return " ".join(body["message"]["content"].split())


async def _watch_video(frames, level, free_vram=None):
    """frames: [{"time": seconds, "image": base64 JPEG}] in order -> [(time, JoyCaption caption)], after the safety checks."""
    frames = [f for f in frames if isinstance(f, dict) and f.get("image")][:VIDEO_FRAMES]
    if not frames:
        raise ValueError("No frames came from the video")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    captions = []
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=600)) as session:
            async with session.get(OLLAMA_URL + "/api/tags") as r:
                names = [m["name"].split(":")[0] for m in (await r.json(content_type=None)).get("models", [])]
            if CAPTION_MODEL not in names:
                raise RuntimeError(f"Watching a video needs JoyCaption in Ollama ({CAPTION_MODEL}); it isn't installed.")
            for f in frames:
                captions.append((float(f.get("time") or 0), await _caption_frame(session, f["image"])))
    except aiohttp.ClientConnectorError:
        raise RuntimeError("Can't reach Ollama; start it and try again.")
    # Checked on what JoyCaption saw, before the writer gets anything.
    seen = [(_NONE_SEEN.sub("", c), bool(_SEXUAL_WORDS.search(c))) for _, c in captions]
    if (level != "safe" or any(sex for _, sex in seen)) and any(_MINOR_WORDS.search(c) for c, _ in seen):
        raise ValueError(VIDEO_STOP.format("someone who may be under 18"))
    if any(sex and _ANIMAL_WORDS.search(c) for c, sex in seen):
        raise ValueError(VIDEO_STOP.format("sexual content with an animal"))
    return captions


async def video_premise(frames, level, model=DEFAULT_MODEL, free_vram=None, character=None):
    """frames: [{"time": seconds, "image": base64 JPEG}] in order -> a story premise that retells the video with the cast."""
    if level not in STORY_LEVELS:
        raise ValueError("Unknown story type")
    captions = await _watch_video(frames, level, free_vram)
    system = " ".join(x for x in (VIDEO_PREMISE, STORY_LEVELS[level], _ADULTS.replace("in the image", "in the story"),
                                  _story_cast(character)) if x)
    # Title cards, logos and black screens tell the writer nothing; small writers retell them anyway.
    scenes = [(t, c) for t, c in captions if not (re.search(r"\bno people\b", c, re.I) and _NO_SCENE.search(c))]
    if not scenes:
        raise ValueError("JoyCaption saw no scenes in this video, only titles or blank screens.")
    # Small writers follow rules better right after the frames than before them.
    user = ("\n".join(f"Frame {i + 1} ({int(t) // 60}:{int(t) % 60:02d}): {c}" for i, (t, c) in enumerate(scenes))
            + "\n\nNow write the premise. Leave out title cards, logos, credits and on-screen text, and never mention "
              "hair, eyes, skin or body.")
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 500, 8192, 0.6), flags=re.S).strip()
    if not text or re.fullmatch(r"\W*REFUSE\W*", text, re.I):
        raise ValueError(VIDEO_STOP.format("someone under 18 or an animal in a sexual situation") if text else
                         "The prompt writer didn't return a premise; try again.")
    return {"premise": text[:3000], "frames": [c for _, c in captions]}


# 🎞 Video describer (Create tab): like VideoLens, a timeline of what each moment shows plus a summary of the whole video.
VIDEO_SUMMARY = ("You are given descriptions of frames from one video, in time order. Write what the video shows: first a short "
                 "overview paragraph (setting, who is in it, what happens from start to end), then 'Key moments:' with 3-6 lines, "
                 "each starting with its timestamp (m:ss). Use only what the frames say. Plain, direct words; no moral comments. "
                 "Skip title cards, logos and blank frames. "
                 "If the frames show anyone under 18 in a sexual situation, or sexual content with an animal, output only the word REFUSE.")


async def video_describe(frames, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """frames as for video_premise -> {"summary", "moments": [{"time", "text"}]}; each moment can become an image prompt."""
    captions = await _watch_video(frames, "safe" if sfw else "adult", free_vram)
    scenes = [(t, c) for t, c in captions if not (re.search(r"\bno people\b", c, re.I) and _NO_SCENE.search(c))] or captions
    user = "\n".join(f"{int(t) // 60}:{int(t) % 60:02d} - {c}" for t, c in scenes) + "\n\nNow describe the video."
    system = " ".join((VIDEO_SUMMARY, _ADULTS.replace("in the image", "in the video")))
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 600, 8192, 0.4), flags=re.S).strip()
    if re.fullmatch(r"\W*REFUSE\W*", text, re.I):
        raise ValueError(VIDEO_STOP.format("someone under 18 or an animal in a sexual situation"))
    return {"summary": text[:4000], "moments": [{"time": t, "text": c} for t, c in scenes]}


async def write_story_chapter(story, index, scenes, level, target, model=DEFAULT_MODEL, free_vram=None, character=None, prev="", first=0):
    """`scenes` consecutive moments of chapter `index` from its scene `first` on, each {"text": narration, "prompt": image prompt,
    "stage": how undressed they are (0-3, "strip" stories only)}."""
    if target not in SYSTEM or level not in STORY_LEVELS:
        raise ValueError("Unknown target or story type")
    chs = story.get("chapters") or []
    if not 0 <= index < len(chs):
        raise ValueError("Unknown chapter")
    scenes = max(1, min(20, int(scenes)))
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    ch = chs[index]
    plan ="\n".join(f"{'>> ' if i == index else ''}Chapter {i + 1}: {c.get('title', '')} - {c.get('summary', '')}" for i, c in enumerate(chs))
    stages = [0] * scenes
    if level == "strip":
        stages, wear = _strip_plan(chs, index, max(0, int(first)), scenes, ch.get("outfit") or "", _main_name(character))
    else:
        wear = "The main characters are completely nude." if level == "nude" else f"Outfit: {ch.get('outfit') or 'fitting the scene'}."
    image = ("lowercase Danbooru tags separated by commas (10-20 tags): clothing, pose, action, expression, where in the setting "
             "they are, lighting and camera angle. Use only tags that exist on Danbooru; invented tags are thrown away"
             if target in TAG_TARGETS else
             "one sentence describing the clothing, pose, action, expression, setting, lighting and camera framing")
    system = " ".join(x for x in (
        f"You write one chapter of an illustrated novel as {scenes} consecutive scenes; each scene becomes one image. "
        "The scenes flow from one moment to the next and tell this chapter's part of the plot.",
        STORY_LEVELS[level], _ADULTS, _story_cast(character), _others(target, _cast_list(character)),
        f"Story: {story.get('title', '')}.", f"Premise: {str(story.get('premise', ''))[:600]}" if story.get("premise") else "",
        f"Chapter plan (>> marks this chapter):\n{plan}\n",
        f"This chapter's setting: {ch.get('setting', '')}. {wear}",
        f"The previous scene was: {str(prev)[:400]} Go on from there; don't repeat it." if prev else "",
        f"Output exactly {scenes} lines, one per scene, in order, and nothing else. Each line is: <narration> || <image prompt>. "
        "The narration is 1-2 sentences of vivid novel prose in the past tense about that moment. "
        f"The image prompt is {image}. Never describe the main characters' faces, hair or bodies; those are added automatically.") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, f"Write chapter {index + 1}: {ch.get('title', '')}.", model,
                                                       110 * scenes + 60, 8192, 0.8), flags=re.S)
    out = []
    for narration, prompt in _scene_lines(text):
        prompt = _clean(prompt, target)
        # Some models put the whole scene in the narration and only "1girl, 1boy" in the prompt: borrow its real tags.
        have = [t for t in prompt.split(", ") if t]
        if target in TAG_TARGETS and len([t for t in have if not _COUNT_TAG.match(t)]) < 3:
            prompt = ", ".join(have + [t for t in _clean(narration, target).split(", ") if t and t not in have])
        if narration and prompt:
            out.append({"text": narration[:600], "prompt": prompt[:1200], "stage": stages[min(len(out), scenes - 1)]})
    out = out[:scenes]
    if not out:
        logging.warning("[Kobo] unreadable story chapter from %s: %r", model, text[:1500])
        raise RuntimeError("The prompt writer didn't return usable scenes for this chapter; try again.")
    return out


# ---------- game story: the script of a game, text only ----------
# Written one part at a time, each with the other parts as context, so a small local model never has to hold a whole
# design document at once. Every part is Markdown; the page shows it in a box you can edit.
GAME_SFW = "This is the General (safe-for-work) workspace: no sexual content and no nudity, even if the idea asks for it."
GAME_ADULTS = "Every character involved in romance or sexual content is an adult (18 or older)."
# Size of the game: places to visit, important characters, main and side quests, dialogue scenes, and tokens per part.
GAME_SIZES = {
    "small": {"places": 3, "cast": 3, "quests": 3, "side": 2, "scenes": 2, "tokens": 1500},
    "medium": {"places": 5, "cast": 4, "quests": 5, "side": 3, "scenes": 3, "tokens": 2100},
    "large": {"places": 7, "cast": 6, "quests": 8, "side": 5, "scenes": 4, "tokens": 2900},
}
GAME_PARTS = {
    "overview": ("Overview",
                 "Write the overview. Start with the line 'TITLE: <the game's title>'. Then, each under its own '## ' heading: "
                 "Pitch (one or two sentences that sell the game), Genre and play style, The player (who they play and what "
                 "they do), Story hook (how it starts and what is at stake), Tone and themes."),
    "world": ("World",
              "Write the world. Under '## Setting': the place, the era and what makes it different, in one paragraph. Under "
              "'## Locations': {places} places the player visits, each as '### <name>' with what it looks like, who is there and "
              "what the player does there. Under '## Factions': the groups in conflict, what each wants and how they treat the "
              "player. Under '## Rules': the magic, technology or other rules the story depends on."),
    "characters": ("Characters",
                   "Write the cast: the player character, {cast} important characters (allies, rivals, someone who may betray or "
                   "surprise the player) and the main villain. Each as '## <name> - <role>' followed by these lines: Look, "
                   "Personality, Wants, Secret, How they change during the story."),
    "plot": ("Main story",
             "Write the main story in three acts: '## Act 1: <name>', '## Act 2: <name>', '## Act 3: <name>'. Each act is a "
             "numbered list of 3-4 story beats (the events the player plays through, in order, one or two sentences each) and "
             "ends on a turning point. Then '## Twist' (one reveal that changes how the player sees the story) and "
             "'## Endings' (2 or 3 endings and the player choices that lead to each)."),
    "quests": ("Quests",
               "Write the quests. Under '## Main quests': {quests} quests that follow the main story in order. Under '## Side "
               "quests': {side} optional quests that show more of the world and its characters. Each quest as '### <name>' "
               "followed by these lines, one sentence each: Given by, Where, Goal, Steps (3 short numbered steps), Complication, "
               "Reward."),
    "dialogue": ("Dialogue",
                 "Write {scenes} key dialogue scenes of the main story as a game script. Each scene as '## <scene name>' with a "
                 "line saying where and when it happens, then the lines as '**NAME:** what they say', with short stage "
                 "directions in italics. In every scene the player picks an answer at least once: list 2-3 numbered choices "
                 "and, under each, the reply it gets and what it changes."),
}


def _own_cast(work, kind, lead):
    """The characters the user ticked: they are in the game or novel under their own names, with their own looks."""
    cast = [c for c in work.get("cast") or [] if isinstance(c, dict) and c.get("name")]
    if not cast:
        return ""
    who = {"1girl": "a woman", "1boy": "a man"}
    return f"These characters must be in the {kind}, under these exact names; keep their looks and give them fitting roles:\n" + "\n".join(
        f"- {str(c['name'])[:60]}" + (f" ({who[c['sex']]})" if c.get("sex") in who else "") + (f" — {lead}" if c.get("player") else "") +
        (f": {str(c['about'])[:600]}" if c.get("about") else "") for c in cast[:8])


async def write_game_part(game, part, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """One part of a game's story as Markdown: {"text", "title"}; only the overview names the game."""
    if part not in GAME_PARTS:
        raise ValueError("Unknown part")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    size = GAME_SIZES.get(game.get("size"), GAME_SIZES["medium"])
    parts = game.get("parts") or {}
    done = "\n\n".join(f"# {GAME_PARTS[k][0]}\n{str(parts[k])[:3000]}" for k in GAME_PARTS if k != part and parts.get(k))
    system = " ".join(x for x in (
        "You are a game writer and narrative designer. You write the story document of a video game, one part at a time.",
        f"Genre: {str(game['genre'])[:80]}." if game.get("genre") else "", f"Tone: {str(game['tone'])[:120]}." if game.get("tone") else "",
        GAME_SFW if sfw else "", GAME_ADULTS,
        "Be specific: invent names, places and events instead of describing them in general terms, and keep every name and "
        "fact consistent with the parts already written. Keep it tight, so the part is finished and not cut off: one or "
        "two sentences per paragraph, list line or stage direction. Write in Markdown and output only this part, never "
        "the parts already written: no introduction and no closing remarks.") if x)
    user = "\n\n".join(x for x in (
        f"Game idea: {str(game.get('idea') or '').strip()[:2000] or 'Invent an original game.'}", _own_cast(game, "game", "the player character"),
        f"Title: {str(game['title'])[:120]}" if game.get("title") and part != "overview" else "",
        "Already written:\n\n" + done if done else "", GAME_PARTS[part][1].format(**size)) if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 600 if part == "overview" else size["tokens"], 8192, 0.8), flags=re.S)
    text = re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text.strip())
    title = re.match(r"\W*title\W*:\s*(.+)", text, re.I)
    if title:
        text = text[title.end():].strip()
    # The writer copies the "# Part" headings of its context, sometimes after a recap of another part: keep what follows
    # this part's own heading, no title line on top, and "## " as the highest level.
    own = list(re.finditer(rf"^# +{re.escape(GAME_PARTS[part][0])}\b.*$", text, re.I | re.M))
    if own:
        text = text[own[-1].end():].strip()
    first, _, rest = text.partition("\n")
    if first.startswith("# ") and first[2:].strip(" *").lower() in [str(game.get("title") or "").lower()] + [n.lower() for n, _ in GAME_PARTS.values()]:
        text = rest.strip()
    if re.search(r"^# ", text, re.M):
        text = re.sub(r"^#", "##", text, flags=re.M)
    if not text:
        raise RuntimeError("The writer returned nothing for this part; try again.")
    return {"text": text, "title": title.group(1).strip('"* ')[:120] if title else ""}


# ---------- novel: an outline, then the chapters as prose ----------
# The outline (premise, characters, setting and a plan of every chapter) is written first; then each chapter on its own,
# with the outline, the whole chapter plan and the end of the chapter before it, so a small local model stays on track.
NOVEL_LENGTHS = {
    "short": {"chapters": 6, "words": 1200},
    "medium": {"chapters": 10, "words": 1600},
    "long": {"chapters": 16, "words": 2000},
}
_NOVEL_CHAPTER = re.compile(r"^#+\s*Chapter\s+(\d+)\s*[:.\-–—]?\s*(.*)$", re.I | re.M)


def _novel_system(novel, sfw, task):
    return " ".join(x for x in (
        f"You are a novelist. {task}",
        f"Genre: {str(novel['genre'])[:80]}." if novel.get("genre") else "", f"Tone: {str(novel['tone'])[:120]}." if novel.get("tone") else "",
        GAME_SFW if sfw else "", GAME_ADULTS,
        "Be specific: give people, places and things names, and keep every name and fact consistent.") if x)


def _novel_lead(novel):
    return next((str(c["name"])[:60] for c in novel.get("cast") or [] if isinstance(c, dict) and c.get("player") and c.get("name")), "")


async def write_novel_outline(novel, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """The plan of a novel: {"title", "outline" (Markdown: premise, characters, setting), "chapters": [{"title", "summary"}]}."""
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    size = NOVEL_LENGTHS.get(novel.get("length"), NOVEL_LENGTHS["medium"])
    n = size["chapters"]
    lead = _novel_lead(novel)
    user = "\n\n".join(x for x in (
        f"Novel idea: {str(novel.get('idea') or '').strip()[:2000] or 'Invent an original story.'}",
        _own_cast(novel, "novel", "the main character"),
        f"The story is told in the first person by {lead or 'the main character'}." if novel.get("pov") == "first" else "",
        "Plan the novel. Start with the line 'TITLE: <the novel's title>'. Then, each under its own '## ' heading: Premise (one "
        "paragraph: who, where, what they want and what stands in the way), Characters (4-7 people, each as '- **Name**: who they "
        "are, how they look, what they want'), Setting (one short paragraph). Then exactly "
        f"{n} chapters, each as '## Chapter <number>: <title>' followed by 2-3 sentences saying what happens in it. The chapters "
        "build up the conflict, turn at the middle, reach the climax near the end, and the last chapter ends the story.") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(_novel_system(novel, sfw, "You plan novels chapter by chapter."), user, model,
                                                       700 + n * 110, 8192, 0.8), flags=re.S)
    text = re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text.strip())
    title = re.search(r"^\W*title\W*:\s*(.+)$", text, re.I | re.M)
    if title:
        text = (text[:title.start()] + text[title.end():]).strip()
    found = list(_NOVEL_CHAPTER.finditer(text))
    if not found:
        raise RuntimeError("The writer didn't return a chapter plan; try again.")
    chapters = []
    for i, m in enumerate(found):
        body = text[m.end():found[i + 1].start() if i + 1 < len(found) else len(text)]
        chapters.append({"title": m.group(2).strip(" *#\"") or f"Chapter {i + 1}", "summary": re.sub(r"\s+", " ", body.replace("*", "")).strip()})
    outline = text[:found[0].start()].strip()
    outline = re.sub(r"^# .*\n", "", outline).strip()   # a title heading on top
    return {"title": title.group(1).strip('"* ')[:120] if title else "", "outline": outline, "chapters": chapters}


NOVEL_RECALL_CHARS = 1800


def _novel_recall(chapters, index, query):
    """Passages of the chapters written so far that share the most words with this chapter's plan, in story order.
    The previous chapter's ending is left out: it is sent in full anyway."""
    passages, where = [], []
    for j, c in enumerate(chapters[:index]):
        text = str(c.get("text") or "")
        if j == index - 1:
            text = text[:-2500]
        for p in recall.chunks(text, 600):
            passages.append(p)
            where.append(j)
    hits = sorted(recall.search(query, passages, NOVEL_RECALL_CHARS))
    return "\n\n".join(f"[Chapter {where[i] + 1}] {passages[i]}" for i in hits)


async def write_novel_chapter(novel, index, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """One chapter of a novel as prose (plain text with paragraphs)."""
    chapters = novel.get("chapters") or []
    if not 0 <= index < len(chapters):
        raise ValueError("Unknown chapter")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    size = NOVEL_LENGTHS.get(novel.get("length"), NOVEL_LENGTHS["medium"])
    ch, lead = chapters[index], _novel_lead(novel)
    pov = (f"Write in the first person, past tense, as {lead or 'the main character'}." if novel.get("pov") == "first"
           else "Write in the third person, past tense.")
    plan = "\n".join(f"{i + 1}. {c.get('title', '')}: {str(c.get('summary', ''))[:400]}" + ("  <- this chapter" if i == index else "")
                     for i, c in enumerate(chapters))
    prev = str(chapters[index - 1].get("text") or "")[-2500:] if index else ""
    earlier = _novel_recall(chapters, index, f"{ch.get('title', '')} {ch.get('summary', '')}")
    system = _novel_system(novel, sfw, (
        f"You write one chapter of a novel at a time, as finished prose of about {size['words']} words: scenes with action, "
        "dialogue in quotation marks, sensory detail and the characters' thoughts and feelings. Show, don't summarise; let the "
        f"chapter end on a moment that pulls the reader on. {pov} Output only the chapter's text: no chapter heading, no title, no "
        "notes, no summary and no comments before or after."))
    user = "\n\n".join(x for x in (
        f"Novel: {str(novel.get('title') or '')[:120]}", str(novel.get("outline") or "")[:4000], _own_cast(novel, "novel", "the main character"),
        "Chapter plan:\n" + plan,
        "Passages from earlier chapters that matter for this one (keep their details the same):\n" + earlier if earlier else "",
        "The previous chapter ends like this:\n..." + prev if prev else "",
        f"Write chapter {index + 1}: {ch.get('title', '')}. What happens: {ch.get('summary', '')}") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, int(size["words"] * 1.7), 8192, 0.85), flags=re.S)
    text = re.sub(r"^```\w*\s*|\s*```$", "", text.strip())
    text = re.sub(r"\A(?:#+[^\n]*|\**Chapter\s+\d+[^\n]*)\n+", "", text).strip()   # a heading the writer added anyway
    if not text:
        raise RuntimeError("The writer returned nothing for this chapter; try again.")
    return {"text": text}


# ---------- character chat: talk to a character who remembers what you told them ----------
# Every reply is written with the character sheet (how they act and what they like), what they learned from earlier
# chats and the newest messages that fit in the context. learn_from_chat folds new messages into that memory.
CHAT_CONTEXT_CHARS = 14000   # of earlier messages per reply; with the sheet and the reply this fits num_ctx 8192
CHAT_RECALL_CHARS = 2000     # of that, for older moments recalled by keyword (taken from the newest-messages budget)
_RECALL_PASSAGE = 700
_LEARN_CHUNK = 9000


def _chat_who(ch, own=None):
    """The character sheet for the system prompt. own = their entry in the Characters tab, if they are linked to one."""
    name = str(ch.get("name") or "the character")[:60]
    own = own if isinstance(own, dict) else {}
    return "\n\n".join(x for x in (
        f"How {name} acts, talks and what they like:\n{str(ch['persona'])[:4000]}" if ch.get("persona") else "",
        f"{name}'s look (image tags): {str(own['appearance'])[:800]}" if own.get("appearance") else "",
        f"Facts about {name}: {str(own['memory'])[:2000]}" if own.get("memory") else "") if x)


def _chat_system(ch, own, sfw, recalled=()):
    name, you = str(ch.get("name") or "the character")[:60], str(ch.get("you") or "").strip()[:60]
    learned = str(ch.get("learned") or "").strip()
    return "\n\n".join(x for x in (
        f"You are {name}, in a private one-on-one chat with {you or 'the user'}. Stay in character at all times: talk as {name}, "
        "in the first person, with their personality, voice and feelings; never say you are an AI, an assistant or a character, "
        f"and never write {you or 'the user'}'s lines or decide what they do or feel. Reply the way {name} would in a chat: "
        "usually one to three short paragraphs, sometimes just a line. Actions and expressions go in *asterisks*. Ask things, "
        "react to what was said and bring up your own thoughts, plans and moods so the chat stays alive.",
        _chat_who(ch, own),
        f"The user's name is {you}." if you else "",
        f"What {name} remembers from earlier chats with {you or 'the user'} (use it naturally when it fits; don't list it):\n{learned[:6000]}" if learned else "",
        f"Older moments from your chats with {you or 'the user'} that may matter now (they happened earlier; bring them up only "
        "if they fit, and don't quote them):\n" + "\n---\n".join(recalled) if recalled else "",
        GAME_SFW if sfw else "", "Everyone in the chat is an adult (18 or older).") if x)


def _newest(history, budget):
    """How many of the newest messages fit in `budget` characters (always at least one)."""
    n, size = 0, 0
    for m in reversed(history):
        size += len(m["text"]) + 10
        if n and size > budget:
            break
        n += 1
    return n


def _chat_recall(ch, history, older):
    """Exchanges from this chat's older messages and from the character's other chats that share words with the user's
    newest message, oldest first."""
    exchanges = []
    for msgs in [m["messages"] for m in ch.get("chats", []) if m.get("messages") is not history] + [older]:
        for i in range(0, len(msgs), 2):
            exchanges.append(_transcript(ch, msgs[i:i + 2])[:_RECALL_PASSAGE])
    # Only the user's last message: what came before it is still in the window and would pull up more of the same.
    query = next((m["text"] for m in reversed(history) if m["role"] != "char"), "")
    return [exchanges[i] for i in sorted(recall.search(query, exchanges, CHAT_RECALL_CHARS))]


def _chat_messages(ch, own, history, sfw):
    """System prompt plus the newest messages that fit; the oldest messages drop out first (the memory keeps them, and
    the ones that match what is being talked about now come back as recalled moments)."""
    # Recall searches everything outside the smallest window recall can leave, so no message falls between the two.
    recalled = _chat_recall(ch, history, history[:len(history) - _newest(history, CHAT_CONTEXT_CHARS - CHAT_RECALL_CHARS)])
    n = _newest(history, CHAT_CONTEXT_CHARS - sum(len(x) for x in recalled))
    keep = [{"role": "assistant" if m["role"] == "char" else "user", "content": m["text"][:8000]} for m in history[len(history) - n:]]
    return [{"role": "system", "content": _chat_system(ch, own, sfw, recalled)}] + keep


async def _loaded(session, model):
    try:
        async with session.get(OLLAMA_URL + "/api/ps") as r:
            return any(m.get("name") == model for m in (await r.json(content_type=None)).get("models", []))
    except (aiohttp.ClientError, ValueError):
        return False


async def chat_reply(ch, own, history, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """The character's next message, streamed: yields pieces of text as Ollama writes them."""
    name, you = str(ch.get("name") or "")[:60], str(ch.get("you") or "").strip()[:60]
    stop = ["\nUser:", "\nuser:"] + ([f"\n{you}:", f"\n**{you}:**"] if you else [])
    options = {"temperature": 0.85, "repeat_penalty": 1.1, "num_predict": 450, "num_ctx": 8192, "stop": stop}
    timeout = aiohttp.ClientTimeout(total=900, sock_read=300)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            model = await _pick_model(session, model)
            if free_vram and not await _loaded(session, model):
                free_vram()   # only before the model loads: a chat sends many messages and the model stays loaded
                await asyncio.sleep(3)
            payload = {"model": model, "messages": _chat_messages(ch, own, history, sfw), "stream": True, "think": False,
                       "keep_alive": "10m", "options": options}
            for attempt in (0, 1):
                async with session.post(OLLAMA_URL + "/api/chat", json=payload) as r:
                    if r.status != 200:
                        error = ((await r.json(content_type=None)) or {}).get("error") or f"Ollama returned HTTP {r.status}"
                        if attempt == 0 and "memory" in str(error).lower():
                            payload["options"] = dict(options, num_gpu=0)   # not enough VRAM next to ComfyUI: CPU only
                            continue
                        raise RuntimeError(error)
                    head = ""   # the writer sometimes starts with "Name:"; hold the first few characters back to strip it
                    async for line in r.content:
                        if not line.strip():
                            continue
                        part = json.loads(line)
                        if part.get("error"):
                            raise RuntimeError(part["error"])
                        piece = (part.get("message") or {}).get("content") or ""
                        if head is not None:
                            head += piece
                            if len(head) < len(name) + 6 and not part.get("done"):
                                continue
                            piece, head = re.sub(rf"^\s*\**{re.escape(name)}\**\s*:\s*\**", "", head, flags=re.I) if name else head, None
                            piece = piece.lstrip()
                        if piece:
                            yield piece
                        if part.get("done"):
                            break
                    if head:
                        yield head
                    return
    except aiohttp.ClientConnectorError:
        raise RuntimeError("Can't reach Ollama. Character chat needs Ollama (ollama.com) running with a chat model.")


async def unload_models():
    """Take every Ollama model off the GPU (before ComfyUI draws), so the pictures don't share it with a text model."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
        async with session.get(OLLAMA_URL + "/api/ps") as r:
            names = [m["name"] for m in (await r.json(content_type=None)).get("models", [])]
        for name in names:
            async with session.post(OLLAMA_URL + "/api/generate", json={"model": name, "keep_alive": 0}) as r:
                await r.read()
        return names


def unload_gpu_models_soon(wait=3.0):
    """For ComfyUI's on-prompt hook (sync code): take Ollama models that sit on the GPU off it before a picture is drawn.
    Runs in a thread and waits at most `wait` seconds, so a busy Ollama never stalls ComfyUI's server."""
    import urllib.request

    def run():
        try:
            with urllib.request.urlopen(OLLAMA_URL + "/api/ps", timeout=1) as r:
                models = json.loads(r.read()).get("models", [])
            for m in models:
                if m.get("size_vram"):   # TIPO runs on the CPU (size_vram 0) and can stay
                    req = urllib.request.Request(OLLAMA_URL + "/api/generate", json.dumps({"model": m["name"], "keep_alive": 0}).encode(),
                                                 {"Content-Type": "application/json"})
                    urllib.request.urlopen(req, timeout=30).read()
                    logging.info("[Kobo] unloaded %s from the GPU before drawing", m["name"])
        except (OSError, ValueError):
            pass

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(wait)


def _transcript(ch, messages):
    name, you = str(ch.get("name") or "Character")[:60], str(ch.get("you") or "").strip()[:60] or "User"
    return "\n".join(f"{name if m['role'] == 'char' else you}: {m['text']}" for m in messages)


async def learn_from_chat(ch, own, messages, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """Fold new chat messages into what the character remembers; returns the whole new memory (a bullet list)."""
    name, you = str(ch.get("name") or "the character")[:60], str(ch.get("you") or "").strip()[:60] or "the user"
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    learned = str(ch.get("learned") or "").strip()
    text = _transcript(ch, messages)
    chunks = [text[i:i + _LEARN_CHUNK] for i in range(0, len(text), _LEARN_CHUNK)] or [""]
    system = " ".join(x for x in (
        f"You keep the memory of {name}, a character who chats with {you}. You read a new part of their chats and update the "
        f"memory, so {name} remembers it in the next chat. Keep what matters for later: facts about {you} (name, life, work, "
        "likes and dislikes, people and pets, plans), what happened between them, promises and plans they made, inside jokes, "
        f"how {you} feels about {name} and how their relationship is now, and anything {you} asked {name} to do or to change "
        f"about how they act. Most points are about {you}. Only write down what was clearly said, never guesses, and never take "
        f"{name}'s jokes, teasing or guesses about {you} as facts; when {you} asks for something, write down what {you} asked, "
        f"not how {name} answered. Leave out small talk, what is happening in the scene right now "
        "(what someone wears, holds or drinks) and anything already in the character sheet.",
        f"Character sheet:\n{_chat_who(ch, own)}" if _chat_who(ch, own) else "",
        "Output only the updated memory: a list of short bullet points ('- '), at most 40, written as notes in the third person. "
        "Keep every older point that is still true, merge duplicates, and change a point when the chat shows it is no longer "
        "true. No headings, no introduction and no comments.",
        GAME_SFW if sfw else "") if x)
    for chunk in chunks:
        user = "\n\n".join(x for x in (
            f"Current memory:\n{learned[:6000]}" if learned else "Current memory: (nothing yet)",
            f"New part of the chat:\n{chunk}") if x)
        out = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 1200, 8192, 0.3), flags=re.S).strip()
        lines = [re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "- ", l).rstrip() for l in out.splitlines() if l.strip()]
        lines = [l for l in lines if l.startswith("- ") and len(l) > 3]
        if lines:
            learned = "\n".join(lines[:40])
            got_notes = True
    # A refusal or prose answer has no '- ' notes; fail so the caller doesn't mark the messages as learned.
    if not locals().get("got_notes"):
        raise RuntimeError("The model didn't return any memory notes, so nothing was learned; try again or pick another model")
    return learned


_STORY_SCENE = re.compile(r"^#+\s*Scene\s+(\d+)\b.*$", re.I | re.M)


async def plan_chat_story(ch, own, messages, scenes=6, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """A chat retold as a picture story: {"looks": "- Name: look" lines, "scenes": [{"caption", "idea"}]}."""
    name, you = str(ch.get("name") or "the character")[:60], str(ch.get("you") or "").strip()[:60]
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    text = _transcript(ch, messages)
    if len(text) > 12000:   # a long chat: its beginning and as much of the end as fits
        text = text[:3000] + "\n[…]\n" + text[-9000:]
    system = " ".join(x for x in (
        f"You turn a chat between {name} and {you or 'the user'} into a short illustrated story, like a picture book or a comic. "
        "Actions in *asterisks* are what really happens in the scene; things they only talk about (memories, plans, dreams) can be "
        "scenes too when they matter to the story.",
        GAME_SFW if sfw else "", "Everyone in the story is an adult (18 or older).",
        "Be concrete and visual. Output only the story plan in the format asked for: no introduction and no comments.") if x)
    who = _chat_who(ch, own)
    user = "\n\n".join(x for x in (
        f"Character sheet of {name}:\n{who}" if who else "",
        f"The user is called {you}." if you else f"The user has no name in the chat: in the story, call them by a fitting first name you invent.",
        f"The chat:\n{text}",
        # A template with the names in it: told only to "list everyone", the writer tends to skip the character.
        f"Start with how everyone looks, filled in as lowercase image tags (1girl or 1boy, hair colour, hair length and style, eye "
        "colour, body, clothes), the same for the whole story; keep what the chat and the character sheet say and invent the rest:\n"
        f"LOOKS:\n- {name}: <tags>\n- {you or '<the name you give the user>'}: <tags>\n(and a line like that for anyone else "
        "who appears; example: '- Anna: 1girl, long black hair, ponytail, blue eyes, slim, white sweater, jeans')\n"
        f"Then exactly {scenes} scenes that retell the chat as a story, in order from its beginning to its end, each as:\n"
        "## Scene <number>\nCaption: <one or two sentences of story narration, past tense, third person>\n"
        "People: <who is in the picture as image tags: 1girl, 1boy, 2girls, 1girl 1boy and so on, or no humans>\n"
        "Picture: <one sentence for the illustrator: who is in the picture (by name), what they do, their expressions, the place, "
        "the time of day and the camera framing>\nMost scenes show both of them together.") if x)
    out = re.sub(r"<think>.*?</think>", "", await _ask(system, user, model, 450 + scenes * 120, 8192, 0.7), flags=re.S).strip()
    out = re.sub(r"<([^<>\n]*)>", r"\1", out)   # the writer copies the <placeholders> of the format
    found = list(_STORY_SCENE.finditer(out))
    if not found:
        raise RuntimeError("The writer didn't return any scenes; try again.")
    looks = re.sub(r"^[\s*#]*looks[\s*]*:[ \t]*", "", out[:found[0].start()].strip(), flags=re.I).strip()
    looks = "\n".join("- " + l.strip().lstrip("-*• ").strip() for l in looks.splitlines() if l.strip().startswith(("-", "*", "•")))
    plan = []
    for i, m in enumerate(found):
        body = out[m.end():found[i + 1].start() if i + 1 < len(found) else len(out)].replace("**", "")
        cap = re.search(r"caption\s*:\s*(.+?)(?=\n\s*(?:people|picture)\s*:|\Z)", body, re.I | re.S)
        pic = re.search(r"picture\s*:\s*(.+?)(?=\n\s*(?:people|caption)\s*:|\Z)", body, re.I | re.S)
        who = re.search(r"people\s*:\s*(.+)", body, re.I)
        count = _people_count(who.group(1) if who else "")
        caption = " ".join((cap.group(1) if cap else "").split())
        idea = " ".join((pic.group(1) if pic else "" if cap else body).split())
        if caption or idea:
            plan.append({"caption": caption, "idea": idea, "count": count})
    return {"looks": looks, "scenes": plan}


# ---------- manga: a page-by-page plan, then each page as panels with dialogue ----------
# The plan names everyone with look tags (the page draws them from those) and gives one line per page; then each page
# is written on its own with the whole plan and the end of the page before it, so a small local model stays on track.
_MANGA_PAGE = re.compile(r"^#+\s*Page\s+(\d+)\s*[:.\-–—]?\s*(.*)$", re.I | re.M)
_MANGA_PANEL = re.compile(r"^#+\s*Panel\s+(\d+)\b.*$", re.I | re.M)
_MANGA_LINE = re.compile(r"^\s*[-*•]?\s*\**([^:*()\n]{1,40}?)\**\s*(?:\((thinking|thought|thinks|shouting|shouts|yelling|whispering|whispers)\))?\s*\**\s*:\s*(.+)$", re.I)
_MANGA_KIND = {"thinking": "thought", "thought": "thought", "thinks": "thought", "shouting": "shout", "shouts": "shout", "yelling": "shout",
               "whispering": "whisper", "whispers": "whisper"}


# An 18+ genre (only honoured in the Adult workspace) makes it an explicit manga, paced like an adult doujinshi.
_MANGA_ADULT = re.compile(r"18\+|hentai|erotic|smut|nsfw|porn|lewd|explicit", re.I)
MANGA_EXPLICIT = ("This is an explicit erotic manga for adults (18+), like an adult doujinshi: sexual acts between consenting "
                  "adults are allowed and shown on the page. Pace it like one: the first pages set up the characters and the "
                  "situation with teasing, then it escalates page by page, the most explicit pages come near the end and the "
                  "last page is the ending. In explicit panels the Picture line says plainly what is happening, the pose, and "
                  "what each person is wearing or that they are nude, so the artist can draw it.")


def _manga_system(manga, sfw, task):
    return " ".join(x for x in (
        f"You are a manga writer. {task}",
        f"Genre: {str(manga['genre'])[:80]}." if manga.get("genre") else "",
        GAME_SFW if sfw else MANGA_EXPLICIT if _MANGA_ADULT.search(str(manga.get("genre") or "")) else "",
        "Every character is an adult (18 or older) and looks like one.",
        "Be specific and visual: give people and places names, and keep every name, look and fact consistent. Output only "
        "what the format asks for: no introduction and no comments.") if x)


async def write_manga_outline(manga, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """The plan of a manga: {"title", "looks": "- Name: tags" lines, "outline": [what happens on each page]}."""
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    n = max(1, min(40, int(manga.get("pageCount") or 6)))
    user = "\n\n".join(x for x in (
        f"Manga idea: {str(manga.get('idea') or '').strip()[:2000] or 'Invent an original story.'}",
        _own_cast(manga, "manga", "the main character"),
        "Plan the manga. Start with the line 'TITLE: <the manga's title>'. Then 'LOOKS:' and one line for every character, "
        "'- <Name>: <lowercase image tags: 1girl or 1boy, hair colour, hair length and style, eye colour, body, outfit>' "
        "(example: '- Aiko: 1girl, long black hair, ponytail, blue eyes, slim, school uniform, red ribbon'); characters listed "
        f"above keep their look tags. Then exactly {n} pages, each as '## Page <number>: <2-3 sentences: what happens on this "
        "page>'. The story has a clear beginning, a turn, a climax and an ending on the last page, and each page ends on a moment "
        "that makes the reader turn the page.") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(_manga_system(manga, sfw, "You plan a manga page by page."), user, model,
                                                       400 + n * 90, 8192, 0.8), flags=re.S)
    text = re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text.strip())
    text = re.sub(r"<([^<>\n]*)>", r"\1", text)   # the writer copies the <placeholders> of the format
    title = re.search(r"^\W*title\W*:\s*(.+)$", text, re.I | re.M)
    found = list(_MANGA_PAGE.finditer(text))
    if not found:
        raise RuntimeError("The writer didn't return a page plan; try again.")
    head = text[:found[0].start()]
    looks = "\n".join("- " + l.strip().lstrip("-*• ").replace("**", "").strip() for l in head.splitlines()
                      if l.strip().startswith(("-", "*", "•")) and ":" in l)
    pages = []
    for i, m in enumerate(found):
        body = text[m.end():found[i + 1].start() if i + 1 < len(found) else len(text)]
        pages.append(re.sub(r"\s+", " ", (m.group(2) + " " + body).replace("*", "")).strip())
    return {"title": title.group(1).strip('"* ')[:120] if title else "", "looks": looks, "outline": pages[:n]}


def _people_count(text):
    """"1girl, 1boy" for the image, from "1girl 1boy", "1girl and 1boy", "no humans"…"""
    count = re.split(r"[,\s]+(?=\d|no\b|solo)", text.lower().replace(" and ", ", "))
    return ", ".join(t.strip(" ,.") for t in count if re.fullmatch(r"\d\+?(girl|boy|other)s?|no humans|solo", t.strip(" ,.")))


async def write_manga_page(manga, index, model=DEFAULT_MODEL, free_vram=None, sfw=False):
    """One page of a manga as panels: [{"shot", "count", "idea", "caption", "dialogue": [{"who", "text", "kind"}]}]."""
    outline = manga.get("outline") or []
    if not 0 <= index < len(outline):
        raise ValueError("Unknown page")
    if free_vram:
        free_vram()
        await asyncio.sleep(3)
    plan = "\n".join(f"Page {i + 1}: {str(p)[:400]}" + ("  <- this page" if i == index else "") for i, p in enumerate(outline))
    prev = ""
    pages = manga.get("pages") or []
    if 0 < index <= len(pages):
        last = (pages[index - 1].get("panels") or [])[-2:]
        prev = "\n".join(f"- {p.get('idea', '')}" + "".join(f" {d.get('who')}: \"{d.get('text')}\"" for d in p.get("dialogue") or [])
                         for p in last)
    user = "\n\n".join(x for x in (
        f"Manga: {str(manga.get('title') or '')[:120]}",
        f"Characters and how they look:\n{str(manga.get('looks') or '')[:2500]}" if manga.get("looks") else _own_cast(manga, "manga", "the main character"),
        "Page plan:\n" + plan,
        "The page before ends with:\n" + prev if prev else "",
        f"Write page {index + 1} as 3 to 6 panels, in reading order. Vary the shots like a real manga: an establishing wide shot "
        "when the place changes, close-ups for emotions, and a big moment gets its own panel. The characters talk: most panels "
        "have a line of dialogue or a thought, short like real manga (at most 2 lines per panel and 15 words per line); a big "
        "moment can be silent. Narration only now and then, when it's needed. Each panel as:\n"
        "## Panel <number>\nShot: <wide shot, full body, cowboy shot, upper body, portrait or close-up, plus the angle if it isn't "
        "straight on: from above, from below, from side, from behind or pov>\n"
        "People: <who is visible, as image tags: 1girl, 1boy, 2girls, 1girl 1boy, or no humans>\n"
        "Picture: <one sentence for the artist: who (by name), what they do, their expression, the place and the time of day>\n"
        "Narration: <a short caption, or none>\n"
        "Dialogue:\n- <Name>: <what they say>\n- <Name> (thinking): <a thought>\n- <Name> (shouting): <a shout>") if x)
    text = re.sub(r"<think>.*?</think>", "", await _ask(_manga_system(manga, sfw, "You write manga pages panel by panel for the artist and the letterer."),
                                                       user, model, 1100, 8192, 0.75), flags=re.S)
    text = re.sub(r"<([^<>\n]*)>", r"\1", text.replace("**", ""))
    found = list(_MANGA_PANEL.finditer(text))
    if not found:
        raise RuntimeError("The writer didn't return any panels; try again.")
    panels = []
    for i, m in enumerate(found[:6]):
        body = text[m.end():found[i + 1].start() if i + 1 < len(found) else len(text)]
        field = lambda name: (re.search(rf"^\s*{name}\s*:\s*(.*)$", body, re.I | re.M) or [None, ""])[1].strip()
        caption = field("narration").strip('"')
        caption = "" if re.fullmatch(r"\(?(none|no|n/a|-|—)?\)?\.?", caption, re.I) else caption
        dialogue = []
        talk = re.split(r"^\s*dialogue\s*:\s*", body, maxsplit=1, flags=re.I | re.M)
        for line in talk[1].splitlines() if len(talk) > 1 else []:
            d = _MANGA_LINE.match(line)
            if not d or re.fullmatch(r"(shot|people|picture|narration)", d.group(1).strip(), re.I):
                continue
            words = d.group(3).strip().strip('"“”').strip()
            if words and not re.fullmatch(r"\(?(none|no dialogue|silence|\.\.\.)\)?\.?", words, re.I):
                dialogue.append({"who": d.group(1).strip(), "text": words[:400], "kind": _MANGA_KIND.get((d.group(2) or "").lower(), "speech")})
        idea = field("picture")
        if idea or dialogue:
            panels.append({"shot": field("shot")[:60], "count": _people_count(field("people")), "idea": idea[:1200],
                           "caption": caption[:400], "dialogue": dialogue[:4]})
    if not panels:
        raise RuntimeError("The writer didn't return any panels; try again.")
    return {"panels": panels}
