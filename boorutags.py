# Every booru's tags (deepghs/site_tags, CC BY 4.0) in one SQLite file, for tag autocomplete in the Adult and Story
# workspaces. Millions of tags are too many to send to the page, so it asks /lora-lab/booru-tags as you type.
# Build it (and rule34_tags.csv) once from the downloaded site folders:
#   python boorutags.py <folder with danbooru.donmai.us/, e621.net/, ...>
import csv
import json
import os
import re
import sqlite3
import sys
import threading

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "booru_tags.sqlite")
# rule34.xxx's tags alone, in danbooru_tags.csv's format, for the Adult workspace's prompt writer (llm.rule34_tags).
RULE34_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rule34_tags.csv")
RULE34_MIN_POSTS = 25   # same floor as danbooru_tags.csv: rarer tags are mostly typos and one-offs
RULE34_BOOST = 3        # search ranks rule34.xxx tags ahead of other boorus' tags with up to 3x their posts (web/app.js too)

# site folder, name column, post count column, category column, site category -> Kōbō category (0 general, 1 artist,
# 3 copyright, 4 character, 5 meta). Codes left out (deprecated/invalid tags) are skipped. Danbooru goes first: its
# category wins when sites disagree, since it is the vocabulary the anime models were trained on.
SITES = [
    ("danbooru.donmai.us", "name", "post_count", "category", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 5}),
    ("gelbooru.com", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 5}),   # 6 = deprecated
    ("chan.sankakucomplex.com", "name", "post_count", "type", {"0": 0, "1": 1, "2": 1, "3": 3, "4": 4, "5": 0, "8": 5, "9": 5}),
    ("e621.net", "name", "post_count", "category", {"0": 0, "1": 1, "2": 1, "3": 3, "4": 4, "5": 0, "7": 5, "8": 0}),
    ("rule34.xxx", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 5}),
    # 1 origin, 3 species, 6 body type, 7 character, 8 artist (and edit/screencap), 9 source errors, 11 fan series
    ("derpibooru.org", "name", "count", "type", {"0": 0, "1": 3, "3": 0, "4": 4, "5": 5, "6": 0, "7": 4, "8": 1, "9": 5, "11": 3}),
    ("hypnohub.net", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 5}),
    ("xbooru.com", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 5}),
    ("konachan.com", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 0, "6": 1}),     # 5 style, 6 circle
    ("yande.re", "name", "count", "type", {"0": 0, "1": 1, "3": 3, "4": 4, "5": 1, "6": 5}),         # 5 circle, 6 faults
    ("anime-pictures.net", "tag", "num", "type", {"0": 0, "1": 4, "2": 4, "3": 3, "4": 1, "5": 3, "6": 3, "7": 0}),
    ("zerochan.net", "tag", "total", "type", {"mangaka": 1, "character": 4, "vtuber": 4, "series": 3, "game": 3, "movie": 3,
                                              "artbook": 3, "ova": 3, "visual novel": 3, "group": 1, "studio": 1,
                                              "theme": 0, "source": 0, "meta": 5}),
]
# Tags about children never reach the list (wider than llm.BLOCKED_TAGS: e621/rule34/Sankaku have their own words).
CHILD_WORDS = {"loli", "lolis", "lolicon", "shota", "shotas", "shotacon", "toddler", "toddlercon", "child", "children",
               "childlike", "kid", "kids", "baby", "infant", "underage", "preteen", "cub", "minor", "young", "younger",
               "kindergarten", "kindergartener", "randoseru", "elementary"}
CHILD_PHRASES = ("aged_down", "middle_school", "grade_school")
CHILD_PREFIX = re.compile(r"^(loli(?!ta)|shota|pedo|toddler|infantil|childish)")   # lolidom, shotasub, loliconder…; not lolita fashion

_db = None
_lock = threading.Lock()


def norm(name):
    return "_".join(str(name).lower().split())


def blocked(name):
    words = re.split(r"[^a-z0-9]+", name)
    return (bool(CHILD_WORDS.intersection(words)) or any(p in name for p in CHILD_PHRASES)
            or any(CHILD_PREFIX.match(w) for w in words))


def _rows(path, name_col, count_col, cat_col, cats, site):
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name, cat = norm(r[name_col]), cats.get((r[cat_col] or "").split(",")[0])
            count = int(float(r[count_col] or 0))
            if (name and "\\" not in name and cat is not None and count > 0 and r.get("is_deprecated") != "True"
                    and not blocked(name)):   # "\breasts"-style escapes are scraper junk
                yield name, cat, count, site


def build(src, out=DB_PATH):
    csv.field_size_limit(1 << 30)
    tmp = out + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("CREATE TABLE tags (name TEXT PRIMARY KEY, cat INTEGER, count INTEGER, sites TEXT) WITHOUT ROWID;"
                     "CREATE TABLE aliases (alias TEXT PRIMARY KEY, name TEXT) WITHOUT ROWID;")
    for site, *cols in SITES:
        path = os.path.join(src, site, "tags.csv")
        if not os.path.exists(path):
            print("missing", path)
            continue
        db.executemany(
            "INSERT INTO tags VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET "
            "cat = CASE WHEN tags.sites LIKE 'danbooru%' OR excluded.count <= tags.count THEN tags.cat ELSE excluded.cat END, "
            "count = max(tags.count, excluded.count), "
            "sites = CASE WHEN instr(',' || tags.sites || ',', ',' || excluded.sites || ',') THEN tags.sites "
            "ELSE tags.sites || ',' || excluded.sites END",
            _rows(path, *cols, site))
        print(site, db.execute("SELECT count(*) FROM tags").fetchone()[0], "tags so far")
    for site, *_ in SITES:
        path = os.path.join(src, site, "tag_aliases.csv")
        if not os.path.exists(path):
            continue
        with open(path, newline="", encoding="utf-8") as f:
            pairs = ((norm(r["alias"]), norm(r["tag"])) for r in csv.DictReader(f))
            # Only aliases of tags in the list, and never a word that is a tag itself.
            db.executemany("INSERT OR IGNORE INTO aliases SELECT ?1, ?2 WHERE ?1 <> '' AND ?1 <> ?2 "
                           "AND EXISTS (SELECT 1 FROM tags WHERE name = ?2) AND NOT EXISTS (SELECT 1 FROM tags WHERE name = ?1)",
                           ((a, t) for a, t in pairs if not blocked(a)))
    db.commit()
    print(db.execute("SELECT count(*) FROM tags").fetchone()[0], "tags,", db.execute("SELECT count(*) FROM aliases").fetchone()[0], "aliases")
    db.close()
    os.replace(tmp, out)


def import_extra(src, gelbooru_jsonl, derpibooru_csv):
    """Writes <src>/gelbooru.com and <src>/derpibooru.org in site_tags' layout, for build():
    DraconicDragon/Gelbooru-Tags-Full (jsonl, 2026) replaces site_tags' tiny Gelbooru list, and DominikDoom's
    tagcomplete derpibooru.csv (name, type, count, "aliases") adds Derpibooru."""
    os.makedirs(os.path.join(src, "gelbooru.com"), exist_ok=True)
    with open(gelbooru_jsonl, encoding="utf-8") as f,             open(os.path.join(src, "gelbooru.com", "tags.csv"), "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out)
        w.writerow(("name", "count", "type"))
        for line in f:
            r = json.loads(line)
            w.writerow((r["tag_name"], r["post_count"], r["category_id"]))
    alias_path = os.path.join(src, "gelbooru.com", "tag_aliases.csv")
    if os.path.exists(alias_path):
        os.remove(alias_path)   # site_tags' aliases belong to its old list
    os.makedirs(os.path.join(src, "derpibooru.org"), exist_ok=True)
    with open(derpibooru_csv, newline="", encoding="utf-8") as f,             open(os.path.join(src, "derpibooru.org", "tags.csv"), "w", newline="", encoding="utf-8") as tags,             open(os.path.join(src, "derpibooru.org", "tag_aliases.csv"), "w", newline="", encoding="utf-8") as aliases:
        tw, aw = csv.writer(tags), csv.writer(aliases)
        tw.writerow(("name", "type", "count"))
        aw.writerow(("alias", "tag"))
        for name, typ, count, *rest in csv.reader(f):
            tw.writerow((name, typ, count))
            aw.writerows((a, name) for a in (rest[0].split(",") if rest else ()) if a)


def export_rule34(src, out=RULE34_CSV):
    """rule34.xxx's tags as tag, category, posts, "aliases" (aliases never a tag themselves), most posts first."""
    site, *cols = next(s for s in SITES if s[0] == "rule34.xxx")
    tags = {}
    for name, cat, count, _ in _rows(os.path.join(src, site, "tags.csv"), *cols, site):
        if count >= RULE34_MIN_POSTS and count > tags.get(name, (0, 0))[1]:
            tags[name] = (cat, count)
    aliases = {}
    with open(os.path.join(src, site, "tag_aliases.csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            a, t = norm(r["alias"]), norm(r["tag"])
            if a and "," not in a and t in tags and a not in tags and not blocked(a):
                aliases.setdefault(t, []).append(a)
    with open(out + ".tmp", "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows((n, c, k, ",".join(aliases.get(n, ()))) for n, (c, k) in sorted(tags.items(), key=lambda x: -x[1][1]))
    os.replace(out + ".tmp", out)
    print(len(tags), "rule34 tags,", sum(map(len, aliases.values())), "aliases ->", out)


TAGFINDER_CATS = {"general": "0", "artist": "1", "copyright": "3", "character": "4", "meta": "5"}


def merge_rule34(extra, out=RULE34_CSV):
    """Adds the tags only `extra` has (TagFinder's dump: name,category,posts,id with category words) to rule34_tags.csv,
    without aliases. Same filters as export_rule34: no child tags, no scraper junk, at least RULE34_MIN_POSTS posts."""
    with open(out, newline="", encoding="utf-8") as f:
        rows = {r[0]: r for r in csv.reader(f)}
    added = 0
    with open(extra, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name, cat = norm(r.get("name") or ""), TAGFINDER_CATS.get(r.get("category") or "")
            try:
                count = int(float(r.get("posts") or 0))
            except ValueError:
                continue
            if (name and name not in rows and cat is not None and count >= RULE34_MIN_POSTS
                    and "\\" not in name and "," not in name and not blocked(name)):
                rows[name] = [name, cat, str(count), ""]
                added += 1
    with open(out + ".tmp", "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(sorted(rows.values(), key=lambda r: -int(r[2])))
    os.replace(out + ".tmp", out)
    print(added, "tags added from", extra, "->", out)


def search(q, limit=10):
    """Tags whose name starts with q, most posts first (rule34.xxx's count RULE34_BOOST times), then tags with an alias
    that does: [{name, cat, count, sites, alias}]. Names go first because the smaller boorus' aliases are noisy (e621 maps
    "sad anime boy" to male). Names with a comma ("huge_breasts,") are rule34 scraper junk."""
    key = norm(q)
    if len(key) < 2 or not os.path.exists(DB_PATH):
        return []
    args = (key, key + "\U0010ffff", limit, RULE34_BOOST)
    rank = "t.count * (CASE WHEN instr(',' || t.sites || ',', ',rule34.xxx,') THEN ?4 ELSE 1 END) DESC"
    global _db
    with _lock:
        if _db is None:
            _db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        rows = _db.execute("SELECT name, cat, count, sites, NULL FROM tags t WHERE name >= ?1 AND name < ?2 "
                           f"AND instr(name, ',') = 0 ORDER BY {rank} LIMIT ?3", args).fetchall()
        rows += _db.execute("SELECT t.name, t.cat, t.count, t.sites, a.alias FROM aliases a JOIN tags t ON t.name = a.name "
                            f"WHERE a.alias >= ?1 AND a.alias < ?2 AND instr(t.name, ',') = 0 ORDER BY {rank} LIMIT ?3",
                            args).fetchall()
    out, seen = [], set()
    for name, cat, count, sites, alias in rows:
        if name not in seen:
            seen.add(name)
            out.append({"name": name.replace("_", " "), "cat": cat, "count": count, "sites": sites,
                        "alias": alias.replace("_", " ") if alias else None})
    return out[:limit]


if __name__ == "__main__":
    if sys.argv[1] == "--extra":   # python boorutags.py --extra <site folder> <gelbooru.jsonl> <derpibooru.csv>
        import_extra(*sys.argv[2:5])
    elif sys.argv[1] == "--merge":   # python boorutags.py --merge "<TagFinder>/rule34_tags.csv"
        merge_rule34(sys.argv[2])
    else:
        build(sys.argv[1])
        export_rule34(sys.argv[1])   # rebuilds rule34_tags.csv: run --merge again afterwards
