"""Build tag_implications.json (Danbooru's active tag implications, child -> every tag it implies) for tagger.parents().

    python build_implications.py

Standard library only. Reads https://danbooru.donmai.us/tag_implications.json (public, no login), 1000 per page,
then follows chains (black thighhighs -> thighhighs -> legwear) so each tag lists all of its ancestors.
"""
import json
import os
import time
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_implications.json")
URL = "https://danbooru.donmai.us/tag_implications.json?search[status]=active&limit=1000&page={}"
HEADERS = {"User-Agent": "tag-implications-builder/1.0"}


def fetch_all():
    pairs, page = [], 1
    while True:
        req = urllib.request.Request(URL.format(page), headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as r:
            rows = json.loads(r.read())
        if not rows:
            return pairs
        pairs += [(row["antecedent_name"], row["consequent_name"]) for row in rows]
        print(f"page {page}: {len(pairs)} implications", flush=True)
        page += 1
        time.sleep(0.5)   # be polite to the public API


def closure(pairs):
    direct = {}
    for child, parent in pairs:
        direct.setdefault(child.replace("_", " "), set()).add(parent.replace("_", " "))
    full = {}

    def walk(tag, seen):
        for p in direct.get(tag, ()):
            if p not in seen:
                seen.add(p)
                walk(p, seen)
        return seen

    for tag in direct:
        full[tag] = sorted(walk(tag, set()) - {tag})
    return full


if __name__ == "__main__":
    implied = closure(fetch_all())
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(implied, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(implied)} tags with implications -> {OUT}")
