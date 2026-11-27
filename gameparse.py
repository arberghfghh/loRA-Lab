# Reads a game story (the Markdown parts written by llm.write_game_part) back into its pieces: the cast, the places,
# the quests and the dialogue scenes. Used to plan the game's art and to build it into an RPG Maker project.
# Pure text handling (no ComfyUI imports), so it can be tested on its own.
import re

_MD = re.compile(r"\*\*|__|`|\\")


def plain(text):
    """Markdown emphasis and stray quotes off a line."""
    text = _MD.sub("", str(text or "")).strip()
    text = re.sub(r"^\*+|\*+$", "", text).strip()
    return text


def slug(text, limit=40):
    s = re.sub(r"[^A-Za-z0-9]+", "_", plain(text)).strip("_")
    return s[:limit] or "x"


def _sections(text, level):
    """[(heading, body)] for every heading of exactly this level ("##" or "###"); text before the first one is skipped."""
    out, cur, body = [], None, []
    for line in str(text or "").splitlines():
        m = re.match(r"^(#+)\s+(.*)$", line)
        if m and len(m.group(1)) == len(level):
            if cur is not None:
                out.append((cur, "\n".join(body).strip()))
            cur, body = plain(m.group(2)), []
        elif m and len(m.group(1)) < len(level):
            if cur is not None:
                out.append((cur, "\n".join(body).strip()))
            cur, body = None, []
        elif cur is not None:
            body.append(line)
    if cur is not None:
        out.append((cur, "\n".join(body).strip()))
    return out


def _section(text, name):
    """Body of the "## <name>" section (first heading that starts with name), or ""."""
    for head, body in _sections(text, "##"):
        if head.lower().startswith(name.lower()):
            return body
    return ""


def _field(body, name):
    """The "Name: value" line of a block (value may go on over the following lines until the next field)."""
    m = re.search(rf"^\W*{re.escape(name)}\W*:\s*(.*(?:\n(?!\s*\W*[A-Z][\w ]{{1,20}}\W*:)(?!\s*#).*)*)", body, re.M | re.I)
    return re.sub(r"\s+", " ", plain(m.group(1))).strip() if m else ""


def _first_sentences(text, n=2, limit=400):
    text = re.sub(r"\s+", " ", plain(text))
    parts = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(parts[:n])[:limit].strip()


_MALE = re.compile(r"\b(he|him|his|himself|man|boy|father|son|brother|uncle|king|prince|lord|husband|sir|mr)\b", re.I)
_FEMALE = re.compile(r"\b(she|her|hers|herself|woman|girl|mother|daughter|sister|aunt|queen|princess|lady|wife|madam|mrs|ms)\b", re.I)


def _sex(*texts):
    """1boy / 1girl from the pronouns and words of a character's description, "" when it can't tell."""
    text = " ".join(texts)
    m, f = len(_MALE.findall(text)), len(_FEMALE.findall(text))
    return "1boy" if m > f else "1girl" if f > m else ""


def _cast(text):
    cast = []
    for head, body in _sections(text, "##"):
        bits = re.split(r"\s+[-–—:]\s+", head, 1)
        name, role = bits[0].strip(), bits[1].strip() if len(bits) > 1 else ""
        if not name or len(name) > 60:
            continue
        cast.append({"name": name, "role": role, "look": _field(body, "Look"), "personality": _field(body, "Personality"),
                     "sex": _sex(role, _field(body, "Look"), _field(body, "Personality")),
                     "wants": _field(body, "Wants"), "player": bool(re.search(r"\bplayer\b|\bprotagonist\b|\bhero(ine)?\b", role, re.I))})
    if cast and not any(c["player"] for c in cast):
        cast[0]["player"] = True
    seen, player = set(), False
    for c in cast:   # only one player character
        if c["player"] and player:
            c["player"] = False
        player = player or c["player"]
    return [c for c in cast if not (c["name"].lower() in seen or seen.add(c["name"].lower()))]


def _places(text):
    body = _section(text, "Locations") or _section(text, "Places")
    places = [{"name": h, "text": re.sub(r"\s+", " ", plain(b))} for h, b in _sections(body, "###")]
    if not places:   # "- **Name**: text" lists instead of ### headings
        for m in re.finditer(r"^\s*(?:[-*]|\d+\.)\s+\**([^*:\n]{2,60})\**\s*[:–—-]\s*(.+)$", body, re.M):
            places.append({"name": plain(m.group(1)), "text": plain(m.group(2))})
    return places


def _steps(body):
    m = re.search(r"^\W*Steps\W*:(.*?)(?=^\W*(?:Complication|Reward)\W*:|\Z)", body, re.M | re.S | re.I)
    if not m:
        return []
    return [plain(x) for x in re.findall(r"^\s*(?:\d+[.)]|[-*])\s+(.+)$", m.group(1), re.M)] or [plain(m.group(1))]


def _quests(text):
    out = []
    for head, body in _sections(text, "##"):
        main = not re.search(r"side|optional", head, re.I)
        for name, qb in _sections(body, "###"):
            out.append({"name": name, "main": main, "giver": _field(qb, "Given by"), "where": _field(qb, "Where"),
                        "goal": _field(qb, "Goal"), "steps": _steps(qb), "complication": _field(qb, "Complication"),
                        "reward": _field(qb, "Reward")})
    return out


def _scenes(text):
    scenes = []
    for head, body in _sections(text, "##"):
        where = when = ""
        lines, choices, cur = [], [], None
        for raw in body.splitlines():
            line = raw.strip()
            if not line:
                continue
            m = re.match(r"^\*?\s*(Location|Where|Setting|Time|When)\s*:\s*(.+?)\*?$", plain(line), re.I)
            if m:
                key, val = m.group(1).lower(), plain(m.group(2))
                if key in ("location", "where", "setting"):
                    where, _, rest = val.partition(",")
                    where = where.strip()
                    when = when or rest.strip()
                else:
                    when = val
                continue
            ch = re.match(r"^(\d+)[.)]\s+(.+)$", line)
            if ch:
                label, sep, reply = plain(ch.group(2)).partition(":")
                if not sep:
                    label, sep, reply = plain(ch.group(2)).partition(" - ")
                cur = {"label": label.strip(" \"“”"), "reply": [reply.strip()] if reply.strip() else []}
                choices.append(cur)
                continue
            sp = re.match(r"^\*\*([^*]{1,40}?):?\*\*:?\s*(.+)$", line) or re.match(r"^([A-Z][\w .'’-]{0,30}):\s+(.+)$", line)
            if sp and not re.match(r"^(Reply|Result|Effect|Changes?|Outcome|Response)$", sp.group(1).strip(), re.I):
                said = re.sub(r"^\*[^*]*\*\s*", "", sp.group(2).strip())   # stage direction before the line
                said = plain(said).strip(" \"“”")
                if said:
                    if cur is not None:   # an answer under a choice
                        cur["reply"].append(f"{plain(sp.group(1))}: {said}" if not re.match(r"^(Reply|Result)", sp.group(1), re.I) else said)
                    else:
                        lines.append((plain(sp.group(1)).strip(" :"), said))
                continue
            if line.startswith("*") and line.endswith("*"):   # stage direction
                continue
            if cur is not None:
                cur["reply"].append(plain(re.sub(r"^\s*[-*]\s+", "", line)))
        for c in choices:
            c["reply"] = " ".join(x for x in c["reply"] if x).strip()
        if lines or choices:
            scenes.append({"name": head, "where": where, "when": when, "lines": lines, "choices": [c for c in choices if c["label"]][:6]})
    return scenes


def outline(game):
    parts = game.get("parts") or {}
    overview = parts.get("overview") or ""
    hook = _section(overview, "Story hook")
    return {
        "title": str(game.get("title") or "Untitled game"),
        "pitch": _first_sentences(_section(overview, "Pitch"), 2),
        "hook": re.sub(r"\s+", " ", plain(hook)).strip(),
        "setting": _first_sentences(_section(parts.get("world") or "", "Setting"), 2),
        "cast": _cast(parts.get("characters") or ""),
        "places": _places(parts.get("world") or ""),
        "quests": _quests(parts.get("quests") or ""),
        "scenes": _scenes(parts.get("dialogue") or ""),
    }


_STOP = {"the", "a", "an", "of", "and", "in", "at", "to", "s", "on", "by", "near", "outside", "inside", "old"}


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]+", plain(text).lower().replace("'s", "")) if w not in _STOP}


def match_place(text, places):
    """Index of the place a "Where:"/"Location:" text means, or -1."""
    want = _words(text)
    if not want:
        return -1
    best, score = -1, 0.0
    for i, p in enumerate(places):
        have = _words(p["name"])
        if not have:
            continue
        s = len(want & have) / len(have)
        if plain(p["name"]).lower() in plain(text).lower():
            s += 1
        if s > score:
            best, score = i, s
    return best if score >= 0.5 else -1


def match_person(name, cast):
    """The cast member a speaker or quest giver means (first names count), or None."""
    n = plain(name).lower().strip(" :")
    if not n:
        return None
    for c in cast:
        if c["name"].lower() == n:
            return c
    for c in cast:
        first = c["name"].lower().split()[0]
        if first == n.split()[0] or first in n.split():
            return c
    return None


# ---------- art ----------
ART_KINDS = ("title", "cast", "place", "scene")


def art_items(game):
    """The pictures a game needs: a title screen, a portrait per character, a background per place and an image per
    dialogue scene. Each has a stable key (kept when the story is edited) and an idea for the prompt writer."""
    o = outline(game)
    style = str(game.get("style") or "").strip()
    # Only the title screen says it's a game: "video game" makes the writer add tags like 3d, wireframe or rpg (weapon).
    pre = f"Art style: {style}. " if style else ""
    looks = {c["name"]: c["look"] for c in o["cast"]}
    sexes = {c["name"]: c["sex"] for c in o["cast"]}
    who_is = {"1boy": "a man", "1girl": "a woman"}
    player = next((c for c in o["cast"] if c["player"]), None)
    items = [{"key": "title", "kind": "title", "name": "Title screen",
              "idea": pre + f"Key art for the title screen of the game {o['title']}" + (f" ({game['genre']})" if game.get("genre") else "") +
                      ", wide shot, no text, no letters. " + " ".join(x for x in (
                  o["pitch"], o["setting"], f"{player['name']} in the foreground: {player['look']}" if player and player["look"] else "") if x)}]
    for c in o["cast"]:
        items.append({"key": "cast:" + slug(c["name"]).lower(), "kind": "cast", "name": c["name"], "role": c["role"], "count": c["sex"],
                      "idea": pre + f"Character portrait of {c['name']}" + (f", {who_is[c['sex']]}" if c["sex"] else "") +
                              f" ({c['role'] or 'character'}), one person alone, head and shoulders, "
                              f"facing the viewer, plain simple background. {c['look']}"})
    for p in o["places"]:
        items.append({"key": "place:" + slug(p["name"]).lower(), "kind": "place", "name": p["name"],
                      "idea": pre + f"Background art of a location, scenery only, no people, no humans, wide establishing shot: {p['name']}. "
                              f"{_first_sentences(p['text'], 2)} {o['setting']}".strip()})
    for s in o["scenes"]:
        who = []
        for speaker, _ in s["lines"]:
            c = match_person(speaker, o["cast"])
            if c and c["name"] not in who:
                who.append(c["name"])
        people = " ".join(f"{n}: {looks[n]}" for n in who[:3] if looks.get(n))
        boys, girls = sum(sexes.get(n) == "1boy" for n in who[:3]), sum(sexes.get(n) == "1girl" for n in who[:3])
        count = ", ".join(x for x in (f"{boys}boy{'s' if boys > 1 else ''}" if boys else "", f"{girls}girl{'s' if girls > 1 else ''}" if girls else "") if x)
        if boys + girls != len(who[:3]):
            count = ""
        items.append({"key": "scene:" + slug(s["name"]).lower(), "kind": "scene", "name": s["name"], "who": who[:3], "count": count,
                      "idea": pre + f"Story illustration of the scene '{s['name']}'" + (f" at {s['where']}" if s["where"] else "") +
                              (f", {s['when']}" if s["when"] else "") + f". {len(who) or 1} {'person' if len(who) < 2 else 'people'}: {', '.join(f'{n} ({who_is[sexes[n]]})' if sexes.get(n) else n for n in who) or 'the hero'}. " +
                              (s["lines"][0][1][:200] if s["lines"] else "") + (f" {people}" if people else "")})
    return items
