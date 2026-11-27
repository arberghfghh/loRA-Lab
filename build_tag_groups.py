# Builds tag_groups.json (tag -> look / clothing / action / setting / camera) for tagger.tag_groups, from:
#   Mexes/danbooru-tag-taxonomy + Mexes/rule34-tag-taxonomy (tags.csv, CC BY 4.0): checked slots, wins
#   Jio7/danbooru-tags-classified (MIT): one csv per kind
#   deepghs/sankaku_tags_categorize_for_WD14Tagger (CC BY 4.0): only its two clear categories
#   python build_tag_groups.py <folder with mexes_danbooru.csv, mexes_rule34.csv, jio7/, sankaku_classified.csv>
import csv
import json
import os
import sys

import boorutags

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_groups.json")
MEXES = {"appearance": "look", "clothing": "clothing", "pose": "action", "scenery": "setting",
         "pose:camera": "camera", "other:layout": "camera", "other:style": "camera"}
JIO7 = {"feature": "look", "attire": "clothing", "action": "action", "expression": "action", "setting": "setting", "style": "camera"}
SANKAKU = {"10": "clothing", "11": "look"}   # its other numbers mix kinds (12 has both swimsuits and poses)


def _space(name):
    return name.replace("_", " ")


def build(src, out=OUT):
    groups = {}

    def add(name, group):
        if name and not boorutags.blocked(boorutags.norm(name)):
            groups.setdefault(_space(name.strip().lower()), group)

    for f in ("mexes_danbooru.csv", "mexes_rule34.csv"):
        with open(os.path.join(src, f), newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                group = MEXES.get(r["slot"]) or MEXES.get(r["category"])
                if group:
                    add(r["tag"], group)
                    for a in (r.get("aliases") or "").split(","):   # rule34 names are often Danbooru aliases (1girls)
                        add(a, group)
    for kind, group in JIO7.items():
        with open(os.path.join(src, "jio7", kind + ".csv"), newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                add(r["tag"], group)
    with open(os.path.join(src, "sankaku_classified.csv"), newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["category"] in SANKAKU:
                add(r["name"], SANKAKU[r["category"]])
    with open(out + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(groups, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(out + ".tmp", out)
    print(len(groups), "tags ->", out)


if __name__ == "__main__":
    build(sys.argv[1])
