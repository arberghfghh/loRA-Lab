# RPG Maker MV / MZ: finds the editor and its projects on this PC, and builds a game story (with its art) into a
# project: the cast become actors with faces, each place a map with its picture as the background (parallax), and the
# quests and dialogue scenes become NPC events with choices. The project's data folder is backed up before every build,
# and only maps, actors and the tileset that Kōbō made itself are ever replaced.
import json
import logging
import os
import re
import shutil
import subprocess
import textwrap
import time

from . import gameparse as gp

PROJECT_FILES = {"Game.rpgproject": "mv", "game.rmmzproject": "mz"}
EXE = {"mv": "RPGMV.exe", "mz": "RPGMZ.exe"}
TAG = "Kōbō"
TILESET_NAME = "Kōbō parallax"
CLEAR_TILE = 1536            # first A5 tile: drawn from an empty image, so the map's picture (parallax) shows through
MAP_W, MAP_H = 25, 17        # 1200 x 816 px: a little bigger than the 816 x 624 screen, so the view scrolls a bit
SPRITES = ("Actor1", "Actor2", "Actor3", "People1", "People2", "People3", "People4")
SPOTS = ((8, 9), (16, 9), (5, 12), (19, 12), (9, 6), (15, 6), (3, 8), (21, 8), (12, 7), (6, 4), (18, 4))
START = (12, 12)
TRAVEL = (12, 15)
BACKUPS = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Kōbō", "rpg-backups")


# ---------- finding RPG Maker and its projects ----------
def _steam_libraries():
    roots = []
    try:
        import winreg
        for hive, key, value in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
                                 (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    roots.append(os.path.normpath(winreg.QueryValueEx(k, value)[0]))
            except OSError:
                pass
    except ImportError:
        pass
    roots.append(r"C:\Program Files (x86)\Steam")
    libs = []
    for root in roots:
        try:
            with open(os.path.join(root, "steamapps", "libraryfolders.vdf"), encoding="utf-8", errors="replace") as f:
                libs += [os.path.normpath(p.replace("\\\\", "\\")) for p in re.findall(r'"path"\s+"([^"]+)"', f.read())]
        except OSError:
            pass
        libs.append(root)
    out = []
    for lib in libs:
        if lib.lower() not in [x.lower() for x in out] and os.path.isdir(lib):
            out.append(lib)
    return out


def find_installs(extra_exe=""):
    """[{engine, exe}] for every RPG Maker MV / MZ found (Steam libraries, the usual install folders, or a chosen exe)."""
    found = []
    dirs = []
    for lib in _steam_libraries():
        dirs += [os.path.join(lib, "steamapps", "common", "RPG Maker MV"), os.path.join(lib, "steamapps", "common", "RPG Maker MZ")]
    for pf in {os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")}:
        dirs += [os.path.join(pf, "KADOKAWA", "RPGMV"), os.path.join(pf, "KADOKAWA", "RPGMZ"),
                 os.path.join(pf, "RPG Maker MV"), os.path.join(pf, "RPG Maker MZ")]
    for d in dirs:
        for engine, exe in EXE.items():
            path = os.path.join(d, exe)
            if os.path.isfile(path) and path.lower() not in [f["exe"].lower() for f in found]:
                found.append({"engine": engine, "exe": path})
    if extra_exe and os.path.isfile(extra_exe):
        name = os.path.basename(extra_exe).lower()
        engine = "mz" if "mz" in name else "mv"
        if extra_exe.lower() not in [f["exe"].lower() for f in found]:
            found.append({"engine": engine, "exe": extra_exe})
    return found


def _documents():
    docs = [os.path.join(os.path.expanduser("~"), "Documents")]
    if os.environ.get("OneDrive"):
        docs.append(os.path.join(os.environ["OneDrive"], "Documents"))
    return [d for d in docs if os.path.isdir(d)]


def search_folders(extra=()):
    """Where new projects are looked for: RPG Maker's default folders (Documents\\Games, …), Documents, the Desktop and
    folders the user added."""
    out = []
    for d in _documents():
        out += [os.path.join(d, n) for n in ("Games", "RPGMV", "RPGMZ", "RPG Maker MV", "RPG Maker MZ")] + [d]
    out.append(os.path.join(os.path.expanduser("~"), "Desktop"))
    out += [x for x in extra if x]
    seen = []
    for d in out:
        if os.path.isdir(d) and os.path.normcase(d) not in [os.path.normcase(x) for x in seen]:
            seen.append(d)
    return seen


def project_engine(path):
    for name, engine in PROJECT_FILES.items():
        if os.path.isfile(os.path.join(path, name)) and os.path.isfile(os.path.join(path, "data", "System.json")):
            return engine
    return None


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def project_info(path):
    engine = project_engine(path)
    if not engine:
        return None
    data = os.path.join(path, "data")
    system = _read_json(os.path.join(data, "System.json"), {}) or {}
    infos = _read_json(os.path.join(data, "MapInfos.json"), []) or []
    actors = _read_json(os.path.join(data, "Actors.json"), []) or []
    pfile = next(os.path.join(path, n) for n, e in PROJECT_FILES.items() if e == engine and os.path.isfile(os.path.join(path, n)))
    try:
        modified = max(os.path.getmtime(os.path.join(data, n)) for n in os.listdir(data) if n.endswith(".json"))
    except (OSError, ValueError):
        modified = os.path.getmtime(pfile)
    return {"path": os.path.normpath(path), "name": os.path.basename(os.path.normpath(path)), "engine": engine,
            "title": str(system.get("gameTitle") or ""), "created": int(os.path.getctime(pfile) * 1000),
            "modified": int(modified * 1000), "maps": sum(1 for m in infos if m), "actors": [a.get("name", "") for a in actors if a][:12],
            "asa": any(TAG in str((a or {}).get("note", "")) for a in actors)}


def find_projects(folders):
    """Every MV / MZ project in these folders (the folder itself, its subfolders and theirs), newest first."""
    found = {}
    for root in folders:
        stack = [(root, 0)]
        while stack:
            d, depth = stack.pop()
            info = project_info(d)
            if info:
                found[os.path.normcase(info["path"])] = info
                continue
            if depth >= 2:
                continue
            try:
                subs = [e.path for e in os.scandir(d) if e.is_dir(follow_symlinks=False) and not e.name.startswith((".", "$"))
                        and e.name.lower() not in ("node_modules", "appdata", "img", "audio", "js", "data", "movies", "fonts")]
            except OSError:
                continue
            stack += [(s, depth + 1) for s in subs[:400]]
    return sorted(found.values(), key=lambda p: -max(p["created"], p["modified"]))


def editor_running():
    try:
        import psutil
        return sorted({p.info["name"] for p in psutil.process_iter(["name"]) if (p.info["name"] or "").lower() in ("rpgmv.exe", "rpgmz.exe")})
    except Exception:
        return []


def open_project(path, installs):
    engine = project_engine(path)
    if not engine:
        raise ValueError("That folder isn't an RPG Maker MV or MZ project")
    pfile = next(os.path.join(path, n) for n, e in PROJECT_FILES.items() if e == engine)
    exe = next((i["exe"] for i in installs if i["engine"] == engine), None)
    if exe:
        subprocess.Popen([exe, pfile], cwd=os.path.dirname(exe))
    else:
        os.startfile(pfile)   # the file type is registered by the editor


# ---------- images ----------
def _cover(src, w, h):
    from PIL import Image
    im = Image.open(src).convert("RGBA")
    scale = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * scale)), max(h, round(im.height * scale))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def _face_sheet(src):
    """A 4 x 2 face sheet (576 x 288) with this face at index 0. Portraits are head and shoulders: the face is the
    upper middle of the picture."""
    from PIL import Image
    im = Image.open(src).convert("RGBA")
    side = int(min(im.width, im.height) * 0.72)
    x, y = (im.width - side) // 2, int(im.height * 0.04)
    face = im.crop((x, y, x + side, min(im.height, y + side))).resize((144, 144), Image.LANCZOS)
    sheet = Image.new("RGBA", (576, 288), (0, 0, 0, 0))
    sheet.paste(face, (0, 0))
    return sheet


def _save_png(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "PNG")


# ---------- event commands ----------
def _cmd(code, indent, params):
    return {"code": code, "indent": indent, "parameters": params}


class Talk:
    """Builds an event's command list: text windows with faces, choices, pictures, switches."""

    def __init__(self, engine, faces):
        self.engine, self.faces, self.list = engine, faces, []

    def text(self, speaker, text, indent=0):
        text = re.sub(r"[\\<>]", "", gp.plain(text)).strip()
        if not text:
            return
        face = self.faces.get((speaker or "").lower(), "")
        mv_name = self.engine == "mv" and speaker
        width = 40 if face else 52
        lines = textwrap.wrap(text, width) or [text]
        per = 3 if mv_name else 4
        for i in range(0, len(lines), per):
            params = [face, 0, 0, 2] + ([speaker or ""] if self.engine == "mz" else [])
            self.list.append(_cmd(101, indent, params))
            if mv_name:
                self.list.append(_cmd(401, indent, [f"\\C[6]{speaker}\\C[0]"]))
            for line in lines[i:i + per]:
                self.list.append(_cmd(401, indent, [line]))

    def choices(self, options, indent=0):
        """options: [(label, fn(indent))]; more than 6 go on over a "More…" choice."""
        if len(options) > 6:
            options = options[:5] + [("More…", lambda ind, rest=options[5:]: self.choices(rest, ind))]
        labels = [gp.plain(lbl)[:38] for lbl, _ in options]
        self.list.append(_cmd(102, indent, [labels, -1, 0, 2, 0]))
        for i, (label, fn) in enumerate(options):
            self.list.append(_cmd(402, indent, [i, labels[i]]))
            fn(indent + 1)
            self.list.append(_cmd(0, indent + 1, []))
        self.list.append(_cmd(404, indent, []))

    def picture(self, name, indent=0):
        self.list.append(_cmd(231, indent, [1, name, 0, 0, 0, 0, 100, 100, 255, 0]))
        self.list.append(_cmd(230, indent, [30]))

    def erase_picture(self, indent=0):
        self.list.append(_cmd(235, indent, [1]))

    def self_switch(self, indent=0):
        self.list.append(_cmd(123, indent, ["A", 0]))

    def transfer(self, map_id, x, y, indent=0):
        self.list.append(_cmd(201, indent, [0, map_id, x, y, 2, 0]))

    def done(self):
        return self.list + [_cmd(0, 0, [])]


def _page(commands, image=None, trigger=0, priority=1, after=False):
    return {
        "conditions": {"actorId": 1, "actorValid": False, "itemId": 1, "itemValid": False, "selfSwitchCh": "A",
                       "selfSwitchValid": after, "switch1Id": 1, "switch1Valid": False, "switch2Id": 1, "switch2Valid": False,
                       "variableId": 1, "variableValid": False, "variableValue": 0},
        "directionFix": False,
        "image": {"characterIndex": (image or {}).get("index", 0), "characterName": (image or {}).get("name", ""),
                  "direction": 2, "pattern": 1, "tileId": 0},
        "list": commands, "moveFrequency": 3,
        "moveRoute": {"list": [{"code": 0, "parameters": []}], "repeat": True, "skippable": False, "wait": False},
        "moveSpeed": 3, "moveType": 0, "priorityType": priority, "stepAnime": False, "through": False,
        "trigger": trigger, "walkAnime": True,
    }


def _event(eid, name, x, y, pages):
    return {"id": eid, "name": name[:40], "note": "", "pages": pages, "x": x, "y": y}


# ---------- build ----------
def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _backup(path):
    dest = os.path.join(BACKUPS, gp.slug(os.path.basename(os.path.normpath(path))), time.strftime("%Y%m%d-%H%M%S"))
    shutil.copytree(os.path.join(path, "data"), os.path.join(dest, "data"))
    # Keep the last 10 backups of each project.
    root = os.path.dirname(dest)
    for old in sorted(os.listdir(root))[:-10]:
        shutil.rmtree(os.path.join(root, old), ignore_errors=True)
    return dest


def _tag(key):
    return f"<{TAG}:{key}>"


def _ours(obj):
    return isinstance(obj, dict) and f"<{TAG}:" in str(obj.get("note", ""))


def _tagged(obj, key):
    return isinstance(obj, dict) and _tag(key) in str(obj.get("note", ""))


def _tileset(project, tilesets):
    from PIL import Image
    _save_png(Image.new("RGBA", (384, 768), (0, 0, 0, 0)), os.path.join(project, "img", "tilesets", "ASA_Clear.png"))
    ts = next((t for t in tilesets if t and t.get("name") == TILESET_NAME), None)
    if not ts:
        ts = {"id": len(tilesets) if tilesets else 1}
        while len(tilesets) <= ts["id"]:
            tilesets.append(None)
        tilesets[ts["id"]] = ts
    flags = [0] * 8192
    flags[0] = 0x10          # the empty tile on the upper layers doesn't block anything
    for t in range(1537, 1664):
        flags[t] = 0x0F      # unused A5 tiles block, the clear tile at 1536 is walkable everywhere
    ts.update({"flags": flags, "mode": 1, "name": TILESET_NAME, "note": _tag("tileset"),
               "tilesetNames": ["", "", "", "", "ASA_Clear", "", "", "", ""]})
    return ts["id"]


def _sprites(project):
    have = []
    folder = os.path.join(project, "img", "characters")
    for name in SPRITES:
        if any(os.path.isfile(os.path.join(folder, name + ext)) for ext in (".png", ".png_", ".rpgmvp")):
            have += [(name, i) for i in range(8)]
    return have


def build(game, project, art_path):
    """Writes the game into the project. art_path(item) -> the picked image's file or None. Returns a summary."""
    engine = project_engine(project)
    if not engine:
        raise ValueError("That folder isn't an RPG Maker MV or MZ project (no Game.rpgproject / game.rmmzproject)")
    o = gp.outline(game)
    if not o["places"]:
        raise ValueError("The game story has no places yet: write the World part first (its '## Locations' make the maps)")
    data = os.path.join(project, "data")
    warnings = []
    backup = _backup(project)
    # A missing file starts empty; one that exists but can't be read stays None so we stop before overwriting maps.
    def existing(name, default):
        path = os.path.join(data, name)
        return _read_json(path) if os.path.exists(path) else default
    system = existing("System.json", {})
    actors = existing("Actors.json", [None])
    infos = existing("MapInfos.json", [None])
    tilesets = existing("Tilesets.json", [None])
    if system is None or actors is None or infos is None or tilesets is None:
        raise ValueError("The project's data files can't be read; open and save it once in RPG Maker")
    adv = system.get("advanced") or {}
    screen = (int(adv.get("screenWidth") or 816), int(adv.get("screenHeight") or 624))
    tile = int(system.get("tileSize") or 48)
    art = {a["key"]: a for a in game.get("art") or []}
    pic = lambda key: art_path(art[key]) if key in art else None
    img = os.path.join(project, "img")
    images = 0

    # Title screen
    title_src = pic("title")
    if title_src:
        _save_png(_cover(title_src, *screen), os.path.join(img, "titles1", "ASA_Title.png"))
        _save_png(_cover(title_src, *screen), os.path.join(img, "pictures", "ASA_Title.png"))   # behind the opening text
        system["title1Name"], system["title2Name"] = "ASA_Title", ""
        images += 2

    # Cast -> actors (the player is actor 1 and the only party member), with faces and a bust picture each
    sprites, used = _sprites(project), 0
    if not sprites:
        warnings.append("No character sprites (Actor1, People1, …) in img/characters: NPCs are invisible until you give them one")
    faces, actor_ids = {}, {}
    template = next((a for a in actors if a), None) or {"battlerName": "", "classId": 1, "equips": [0, 0, 0, 0, 0], "traits": [],
                                                       "initialLevel": 1, "maxLevel": 99}
    cast = sorted(o["cast"], key=lambda c: not c["player"])
    for c in cast:
        key, s = "cast:" + gp.slug(c["name"]).lower(), gp.slug(c["name"])
        src = pic(key)
        face = ""
        if src:
            _save_png(_face_sheet(src), os.path.join(img, "faces", f"ASA_{s}.png"))
            _save_png(_cover(src, 480, 480), os.path.join(img, "pictures", f"ASA_{s}.png"))
            face = f"ASA_{s}"
            images += 2
        faces[c["name"].lower()] = face
        faces[c["name"].split()[0].lower()] = face
        if c["player"]:
            aid = 1
        else:
            aid = next((a["id"] for a in actors if _tagged(a, key)), None) or max(len(actors), 2)
        while len(actors) <= aid:
            actors.append(None)
        old = actors[aid] or {}
        sprite = (old.get("characterName"), old.get("characterIndex", 0)) if _tagged(old, key) and old.get("characterName") else \
            sprites[used % len(sprites)] if sprites else ("", 0)
        used += 1
        actors[aid] = dict(template, **{k: v for k, v in old.items() if k in ("classId", "equips", "traits", "initialLevel", "maxLevel", "battlerName")},
                           id=aid, name=c["name"][:24], nickname=c["role"][:24], note=_tag(key),
                           profile="\n".join(textwrap.wrap(gp.plain(c["personality"]).split(". ")[0][:110], 52)[:2]),
                           faceName=face, faceIndex=0, characterName=sprite[0], characterIndex=sprite[1])
        actor_ids[c["name"]] = aid
    player = next((c for c in cast if c["player"]), None)
    sprite_of = {a["name"].lower(): {"name": a["characterName"], "index": a["characterIndex"]} for a in actors if a and _ours(a)}

    # Places -> maps
    tileset_id = _tileset(project, tilesets)
    map_ids = []
    next_id = max([m["id"] for m in infos if m] + [0]) + 1
    for p in o["places"]:
        key = "place:" + gp.slug(p["name"]).lower()
        mid = next((m["id"] for m in infos if m and _tagged(_read_json(os.path.join(data, "Map%03d.json" % m["id"]), {}), key)), None)
        if not mid:
            mid, next_id = next_id, next_id + 1
        map_ids.append(mid)

    # Who and what goes where: quests at their place (given by someone there), dialogue scenes at theirs.
    places = o["places"]
    at = [{"npcs": {}, "arrival": [], "scenes_alone": []} for _ in places]
    start = 0
    main_quests = [q for q in o["quests"] if q["main"]]
    if main_quests and gp.match_place(main_quests[0]["where"], places) >= 0:
        start = gp.match_place(main_quests[0]["where"], places)

    def npc(i, name):
        c = gp.match_person(name, o["cast"])
        label = c["name"] if c else gp.plain(name).strip()[:30]
        return at[i]["npcs"].setdefault(label.lower(), {"name": label, "cast": c, "scenes": [], "quests": []})

    for s in o["scenes"]:
        i = gp.match_place(s["where"], places)
        i = start if i < 0 else i
        others = [sp for sp, _ in s["lines"] if not (player and gp.match_person(sp, [player]))]
        if others:
            npc(i, others[0])["scenes"].append(s)
        else:
            at[i]["scenes_alone"].append(s)
    for q in o["quests"]:
        i = gp.match_place(q["where"], places)
        i = start if i < 0 else i
        giver = q["giver"]
        if not giver or (player and gp.match_person(giver, [player])):
            at[i]["arrival"].append(q)
        else:
            npc(i, giver)["quests"].append(q)
    for i, p in enumerate(places):   # cast members the place text mentions are there too
        for c in o["cast"]:
            if not c["player"] and re.search(rf"\b{re.escape(c['name'].split()[0])}\b", p["text"]):
                npc(i, c["name"])
    placed = {k for a in at for k in a["npcs"]}
    for c in o["cast"]:   # everyone else goes where the fewest people are
        if not c["player"] and c["name"].lower() not in placed:
            npc(min(range(len(places)), key=lambda j: len(at[j]["npcs"])), c["name"])

    def scene_cmds(t, s, ind=0):
        cg = "scene:" + gp.slug(s["name"]).lower()
        has_cg = bool(pic(cg))
        if has_cg:
            t.picture("ASA_Scene_" + gp.slug(s["name"]), ind)
        for sp, said in s["lines"]:
            c = gp.match_person(sp, o["cast"])
            t.text(c["name"] if c else sp, said, ind)
        if s["choices"]:
            t.choices([(ch["label"], lambda ind2, r=ch["reply"]: t.text("", r or "…", ind2)) for ch in s["choices"]], ind)
        if has_cg:
            t.erase_picture(ind)

    for s in o["scenes"]:
        src = pic("scene:" + gp.slug(s["name"]).lower())
        if src:
            _save_png(_cover(src, *screen), os.path.join(img, "pictures", "ASA_Scene_" + gp.slug(s["name"]) + ".png"))
            images += 1

    npc_count, bare = 0, []
    for i, p in enumerate(places):
        key = "place:" + gp.slug(p["name"]).lower()
        pname = ""
        src = pic(key)
        if src:
            pname = "!ASA_" + gp.slug(p["name"])   # "!" keeps the picture fixed to the map instead of scrolling slower
            _save_png(_cover(src, MAP_W * tile, MAP_H * tile), os.path.join(img, "parallaxes", pname + ".png"))
            images += 1
        else:
            bare.append(p["name"])
        events = [None]

        # Arrival: the place's name and look the first time you come here, the story's start on the first map.
        t = Talk(engine, faces)
        if i == start and o["hook"]:
            if title_src:
                t.picture("ASA_Title")
            t.text("", o["hook"])
            if title_src:
                t.erase_picture()
        t.text("", f"{p['name']}. {gp._first_sentences(p['text'], 2, 300)}")
        for s in at[i]["scenes_alone"]:
            scene_cmds(t, s)
        for q in at[i]["arrival"]:
            t.text("", f"New goal — {q['name']}: {q['goal']}")
        t.self_switch()
        events.append(_event(1, "Arrival", 0, 0, [_page(t.done(), trigger=3, priority=0), _page([_cmd(0, 0, [])], priority=0, after=True)]))

        # Travel point: go to any other place.
        t = Talk(engine, faces)
        t.text("", "Where do you want to go?")
        t.choices([(places[j]["name"], lambda ind, j=j: t.transfer(map_ids[j], START[0], START[1] + 1, ind))
                   for j in range(len(places)) if j != i] + [("Stay here", lambda ind: None)])
        crystal = os.path.isfile(os.path.join(img, "characters", "!Crystal.png"))
        events.append(_event(2, "Travel", TRAVEL[0], TRAVEL[1],
                             [_page(t.done(), image={"name": "!Crystal", "index": 0} if crystal else None, trigger=0 if crystal else 1,
                                    priority=1 if crystal else 0)]))

        # NPCs: their scenes and quests the first time you talk to them, a reminder after that.
        for n, (lk, who) in enumerate(at[i]["npcs"].items()):
            if n >= len(SPOTS):
                warnings.append(f"{p['name']}: too many people for one map, {who['name']} was left out")
                continue
            name = who["name"]
            first, again = Talk(engine, faces), Talk(engine, faces)
            for s in who["scenes"]:
                scene_cmds(first, s)
            for q in who["quests"]:
                first.text(name, f"{q['goal']}" if q["goal"] else q["name"])
                steps = " ".join(f"{k + 1}) {st}" for k, st in enumerate(q["steps"][:3]))
                first.text("", f"Quest — {q['name']}." + (f" {steps}" if steps else "") + (f" Reward: {q['reward']}" if q["reward"] else ""))
                again.text(name, f"Don't forget: {q['goal'] or q['name']}")
            c = who["cast"]
            idle = (c and (c["wants"] or c["personality"])) or ""
            if not first.list:
                first.text("", f"{name}. {gp._first_sentences(idle, 1, 200)}" if idle else f"{name} nods at you.")
            if not again.list:
                again.text("", f"{name} smiles at you." if not idle else f"({gp._first_sentences(idle, 1, 200)})")
            image = sprite_of.get(name.lower()) or ({"name": sprites[(used + n) % len(sprites)][0], "index": sprites[(used + n) % len(sprites)][1]} if sprites else None)
            pages = [_page(first.done(), image=image)]
            if who["scenes"] or who["quests"]:
                pages[0]["list"] = pages[0]["list"][:-1] + [_cmd(123, 0, ["A", 0]), _cmd(0, 0, [])]
                pages.append(_page(again.done(), image=image, after=True))
            x, y = SPOTS[n]
            events.append(_event(len(events), name, x, y, pages))
            npc_count += 1

        layer = [CLEAR_TILE] * (MAP_W * MAP_H)
        mp = {"autoplayBgm": False, "autoplayBgs": False, "battleback1Name": "", "battleback2Name": "",
              "bgm": {"name": "", "pan": 0, "pitch": 100, "volume": 90}, "bgs": {"name": "", "pan": 0, "pitch": 100, "volume": 90},
              "disableDashing": False, "displayName": p["name"][:40], "encounterList": [], "encounterStep": 30,
              "height": MAP_H, "note": _tag(key), "parallaxLoopX": False, "parallaxLoopY": False, "parallaxName": pname,
              "parallaxShow": True, "parallaxSx": 0, "parallaxSy": 0, "scrollType": 0, "specifyBattleback": False,
              "tilesetId": tileset_id, "width": MAP_W, "data": layer + [0] * (MAP_W * MAP_H * 5), "events": events}
        _write_json(os.path.join(data, "Map%03d.json" % map_ids[i]), mp)
        mid = map_ids[i]
        while len(infos) <= mid:
            infos.append(None)
        order = infos[mid]["order"] if infos[mid] else max([m.get("order", 0) for m in infos if m] + [0]) + 1
        infos[mid] = {"id": mid, "expanded": False, "name": p["name"][:40], "order": order, "parentId": 0, "scrollX": 600, "scrollY": 408}
    if bare:
        warnings.append(f"No picture yet for {', '.join(bare)}: those maps are empty (draw them in 🎨 Game art, then build again)")

    system["gameTitle"] = o["title"][:60]
    system["startMapId"], system["startX"], system["startY"] = map_ids[start], START[0], START[1]
    system["partyMembers"] = [1]
    _write_json(os.path.join(data, "Actors.json"), actors)
    _write_json(os.path.join(data, "MapInfos.json"), infos)
    _write_json(os.path.join(data, "Tilesets.json"), tilesets)
    _write_json(os.path.join(data, "System.json"), system)
    if editor_running():
        warnings.append("RPG Maker is open: close the project without saving and open it again, or it keeps (and saves) the old data")
    logging.info("[Kobo] built %r into %s: %d maps, %d NPCs, %d images", o["title"], project, len(places), npc_count, images)
    return {"engine": engine, "maps": len(places), "npcs": npc_count, "actors": len(cast), "images": images, "backup": backup,
            "warnings": warnings, "mapIds": {("place:" + gp.slug(p["name"]).lower()): map_ids[i] for i, p in enumerate(places)},
            "start": places[start]["name"]}

