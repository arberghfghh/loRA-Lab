# Tag finder (from the TagFinder app): booru tags similar to a main tag (dog -> puppy, shiba_inu, dog_ears, ...),
# plus example posts for the image viewer.
#   danbooru   - Danbooru's related-tag API (no key needed)
#   safebooru  - Gelbooru-engine site; samples posts and counts co-occurring tags (no key needed)
#   gelbooru   - same method, needs an API key + user id
#   rule34     - rule34.xxx (18+), same method, needs an API key + user id
# Blocking urllib calls: the routes run these in an executor.
import functools
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from .llm import BLOCKED_TAGS

USER_AGENT = "TagFinder/1.0"
# Same file the TagFinder app uses, so API keys entered in either one work in both.
CONFIG_PATH = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "TagFinder", "config.json")

# Danbooru and Gelbooru-engine sites use the same tag category numbers.
CATEGORIES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}

RATINGS = ("general", "sensitive", "questionable", "explicit", "any")

# A tag must show up this many times more often next to the main tag than on the
# site overall. Filters generic tags like "smile" or "solo" that appear everywhere.
MIN_LIFT = 5.0

# Never returned, on any site or rating.
BLOCKED = re.compile(
    r"(^|_)(loli|lolicon|shota|shotacon|toddlercon|bestiality|zoophilia)(_|$)"
    r"|(^|_)(animal|dog|horse|canine|equine)_penis(_|$)"
)


class SiteError(Exception):
    pass


def normalize(tag):
    """'Shiba Inu' -> 'shiba_inu' (booru tag style)."""
    return re.sub(r"\s+", "_", tag.strip().lower())


def _allowed(name):
    return not BLOCKED.search(name) and name.replace("_", " ") not in BLOCKED_TAGS


def _post_allowed(tag_string):
    return all(_allowed(t) for t in tag_string.split())


def _is_video(url):
    return url.lower().split("?")[0].endswith((".mp4", ".webm"))


# Hosts the image viewer may load from (the local image proxy refuses anything else).
IMAGE_HOSTS = ("donmai.us", "safebooru.org", "gelbooru.com", "rule34.xxx")


def fetch_image(url):
    """Download a booru image/video for the viewer. Returns (bytes, content_type)."""
    host = urllib.parse.urlparse(url).hostname or ""
    if not url.startswith("https://") or not any(host == h or host.endswith("." + h) for h in IMAGE_HOSTS):
        raise SiteError("Image host not allowed")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read(), resp.headers.get("Content-Type", "application/octet-stream")


def _get(url, params, retries=3):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            # Gelbooru-engine sites answer rate limiting with 404/429/503.
            if attempt == retries or e.code not in (404, 429, 503):
                raise
            time.sleep(1.5 * (attempt + 1))


# ---------------------------------------------------------------- credentials

KEYED_SITES = ("gelbooru", "rule34")


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError):
        config = {}
    for site in KEYED_SITES:
        env_key = os.environ.get(f"{site.upper()}_API_KEY")
        env_user = os.environ.get(f"{site.upper()}_USER_ID")
        if env_key and env_user:
            config[site] = {"api_key": env_key, "user_id": env_user}
    return config


def _credentials(config, site):
    creds = config.get(site) or {}
    if creds.get("api_key") and creds.get("user_id"):
        return {"api_key": creds["api_key"], "user_id": str(creds["user_id"])}
    return None


# ---------------------------------------------------------------- sites

class Danbooru:
    name = "danbooru"
    base = "https://danbooru.donmai.us"
    adult = False

    def resolve(self, tag):
        """Follow aliases, e.g. 'dogs' -> 'dog'."""
        aliases = json.loads(_get(f"{self.base}/tag_aliases.json", {
            "search[antecedent_name]": tag, "search[status]": "active"}))
        return aliases[0]["consequent_name"] if aliases else tag

    def suggest(self, tag):
        tags = json.loads(_get(f"{self.base}/tags.json", {
            "search[name_matches]": f"*{tag}*", "search[order]": "count", "limit": 20}))
        return [t["name"] for t in tags if _allowed(t["name"])][:8]

    @functools.lru_cache(maxsize=1)
    def _total_posts(self):
        return json.loads(_get(f"{self.base}/counts/posts.json", {}))["counts"]["posts"]

    def related(self, tag, rating, categories, limit):
        # Danbooru sometimes times out on big queries and caches an empty answer
        # for that exact query string, so try equivalent spellings, then no filter.
        queries = [tag] if rating == "any" else [f"{tag} rating:{rating[0]}", f"{tag} rating:{rating}", tag]
        params = {"order": "Cosine", "limit": max(limit * 3, 100)}
        if len(categories) == 1 and "all" not in categories:
            params["category"] = next(iter(categories))
        for query in queries:
            data = json.loads(_get(f"{self.base}/related_tag.json", {**params, "query": query}))
            if data.get("related_tags"):
                break
        total = self._total_posts()

        results = {}
        for item in data.get("related_tags", []):
            t = item["tag"]
            results[t["name"]] = {
                "category": CATEGORIES.get(t["category"], str(t["category"])),
                "posts": t["post_count"],
                "score": item["cosine_similarity"],
                # "frequency" = share of the main tag's posts that also have this tag.
                "lift": item["frequency"] / max(t["post_count"] / total, 1e-9),
            }
        return data.get("post_count") or data.get("tag", {}).get("post_count", 0), results

    def posts(self, tag, rating, page=1, limit=40):
        query = tag if rating == "any" else f"{tag} rating:{rating[0]}"
        data = json.loads(_get(f"{self.base}/posts.json", {"tags": query, "limit": limit, "page": page}))
        out = []
        for p in data:
            sample = p.get("large_file_url") or p.get("file_url")
            # Some posts hide their files from anonymous users; skip those.
            if not p.get("preview_file_url") or not sample or not _post_allowed(p.get("tag_string", "")):
                continue
            out.append({
                "id": p["id"], "preview": p["preview_file_url"], "sample": sample,
                "file": p.get("file_url") or sample, "video": _is_video(sample),
                "width": p.get("image_width"), "height": p.get("image_height"),
                "page": f"{self.base}/posts/{p['id']}",
            })
        return {"posts": out, "more": len(data) >= limit}


class GelbooruEngine:
    """Gelbooru-software sites have no related-tag API, so sample posts and count tags."""

    MAX_OFFSET = 20000  # Gelbooru refuses deeper paging than this

    def __init__(self, name, base, auth=None, sample=300, rating_filter=True, adult=False, site_url=None):
        self.name = name
        self.base = base
        self.site_url = site_url or base
        self.auth = auth or {}
        self.sample = sample
        self.rating_filter = rating_filter
        self.adult = adult
        self._tag_cache = {}

    def _api(self, **params):
        params = {"page": "dapi", "q": "index", **self.auth, **params}
        root = ET.fromstring(_get(f"{self.base}/index.php", params))
        if root.tag == "error" or root.get("success") == "false":
            raise SiteError(root.text or root.get("reason") or "API error")
        return root

    def tag_info(self, name):
        if name not in self._tag_cache:
            try:
                tag = self._api(s="tag", name=name).find("tag")
            except (OSError, SiteError):
                return None  # don't cache failures
            self._tag_cache[name] = tag is not None and {
                "category": CATEGORIES.get(int(tag.get("type")), tag.get("type")),
                "posts": int(tag.get("count")),
            }
        return self._tag_cache[name] or None

    def resolve(self, tag):
        return tag

    def related(self, tag, rating, categories, limit):
        main = self.tag_info(tag)
        if not main or not main["posts"]:
            self._api(s="post", limit=0)  # surfaces auth errors instead of "no results"
            return 0, {}

        query = tag
        if self.rating_filter and rating != "any":
            query += f" rating:{rating}"

        # Spread the sample across the whole result set: the newest posts
        # cluster around a few series and skew the counts.
        first = self._api(s="post", tags=query, limit=0)
        matching = min(int(first.get("count", 0)), self.MAX_OFFSET)
        n_pages = max(1, min(math.ceil(self.sample / 100), math.ceil(matching / 100)))
        last_page = max(0, math.ceil(matching / 100) - 1)
        pages = sorted({round(i * last_page / max(n_pages - 1, 1)) for i in range(n_pages)})
        with ThreadPoolExecutor(max_workers=3) as pool:
            roots = list(pool.map(lambda p: self._api(s="post", tags=query, limit=100, pid=p), pages))

        co = Counter()
        n_posts = 0
        for root in roots:
            for post in root.iter("post"):
                tags = post.get("tags") or post.findtext("tags") or ""
                co.update(set(tags.split()) - {tag})
                n_posts += 1
        if not n_posts:
            return main["posts"], {}

        candidates = [name for name, c in co.most_common()
                      if c >= 2 and _allowed(name)][:max(limit * 3, 60)]
        # Few workers on purpose: these sites rate-limit parallel requests.
        with ThreadPoolExecutor(max_workers=3) as pool:
            infos = list(pool.map(self.tag_info, candidates))
        total = int(self._api(s="post", limit=0).get("count"))

        results = {}
        for name, info in zip(candidates, infos):
            if not info or not info["posts"]:
                continue
            frequency = co[name] / n_posts
            # Estimate how many posts share both tags, then cosine similarity
            # (same measure Danbooru uses): shared / sqrt(posts_a * posts_b).
            shared = frequency * main["posts"]
            results[name] = {
                **info,
                "score": min(shared / math.sqrt(main["posts"] * info["posts"]), 1.0),
                "lift": frequency / (info["posts"] / total),
            }
        return main["posts"], results

    def posts(self, tag, rating, page=1, limit=40):
        query = tag
        # Unlike tag statistics, images should respect the rating on every
        # site except the adult-only one (Safebooru's "safe" still includes
        # some questionable posts).
        if rating != "any" and not self.adult:
            query += f" rating:{rating}"
        root = self._api(s="post", tags=query, limit=limit, pid=page - 1)
        out = []
        for post in root.iter("post"):
            field = lambda k: post.get(k) or post.findtext(k) or ""
            preview, sample, file = field("preview_url"), field("sample_url"), field("file_url")
            sample = sample or file
            if not preview or not sample or not _post_allowed(field("tags")):
                continue
            out.append({
                "id": field("id"), "preview": preview, "sample": sample, "file": file or sample,
                "video": _is_video(file or sample),
                "width": int(field("width") or 0), "height": int(field("height") or 0),
                "page": f"{self.site_url}/index.php?page=post&s=view&id={field('id')}",
            })
        return {"posts": out, "more": len(root.findall("post")) >= limit}


SITE_INFO = {
    "danbooru": {"label": "Danbooru", "needs_key": False, "adult": False, "default": True},
    "safebooru": {"label": "Safebooru", "needs_key": False, "adult": False, "default": True},
    "gelbooru": {"label": "Gelbooru", "needs_key": True, "adult": False, "default": True},
    "rule34": {"label": "Rule34.xxx", "needs_key": True, "adult": True, "default": False},
}

# Site objects keep caches, so build them once per set of credentials.
_site_cache = {}


def available_sites(sample=300, config=None):
    """Sites that can be used right now (keyed sites only when credentials exist)."""
    config = load_config() if config is None else config
    gel, r34 = _credentials(config, "gelbooru"), _credentials(config, "rule34")
    cache_key = (sample, json.dumps([gel, r34], sort_keys=True))
    if cache_key not in _site_cache:
        sites = {
            "danbooru": Danbooru(),
            "safebooru": GelbooruEngine("safebooru", "https://safebooru.org",
                                        sample=sample, rating_filter=False),
        }
        if gel:
            sites["gelbooru"] = GelbooruEngine("gelbooru", "https://gelbooru.com", auth=gel, sample=sample)
        if r34:
            # Adult-only site: the rating filter would remove nearly everything.
            sites["rule34"] = GelbooruEngine("rule34", "https://api.rule34.xxx", auth=r34,
                                             sample=sample, rating_filter=False, adult=True,
                                             site_url="https://rule34.xxx")
        _site_cache.clear()
        _site_cache[cache_key] = sites
    return _site_cache[cache_key]


def default_sites(sites):
    return [name for name in sites if SITE_INFO[name]["default"]]


# ---------------------------------------------------------------- search

def find_similar_tags(tag, sites=None, limit=25, rating="general", categories=("general",), sample=300):
    """Return (info, results) where results is a ranked list of similar booru tags.

    Each result: {"tag", "category", "posts", "score", "sites"}.
    Score is cosine similarity averaged across the sites searched, so tags
    that several sites agree on rank higher.
    """
    tag = normalize(tag)
    categories = set(categories)
    all_sites = available_sites(sample)
    names = sites or default_sites(all_sites)
    unknown = [s for s in names if s not in all_sites]
    if unknown:
        raise SiteError(f"Unavailable site(s): {', '.join(unknown)} (missing API key?)")
    chosen = [all_sites[s] for s in names]

    def run(site):
        try:
            main = site.resolve(tag)
            count, related = site.related(main, rating, categories, limit)
            return site.name, main, count, related, None
        except Exception as e:  # one site being down shouldn't kill the search
            return site.name, tag, 0, {}, e

    with ThreadPoolExecutor(max_workers=len(chosen)) as pool:
        outcomes = list(pool.map(run, chosen))

    info = {"main_tag": tag, "sites": {}}
    merged = {}
    for site_name, main, count, related, error in outcomes:
        info["sites"][site_name] = {"resolved_tag": main, "posts": count,
                                    "error": str(error) if error else None}
        for name, r in related.items():
            if name in (tag, main) or not _allowed(name) or r["lift"] < MIN_LIFT:
                continue
            if "all" not in categories and r["category"] not in categories:
                continue
            m = merged.setdefault(name, {"tag": name, "category": r["category"],
                                         "posts": 0, "score": 0.0, "sites": []})
            m["posts"] = max(m["posts"], r["posts"])
            m["score"] += r["score"] / len(chosen)
            m["sites"].append(site_name)

    ranked = sorted(merged.values(), key=lambda m: m["score"], reverse=True)[:limit]
    for m in ranked:
        m["score"] = round(m["score"], 4)

    info["suggestions"] = []
    if not ranked and "danbooru" in all_sites:
        try:
            info["suggestions"] = all_sites["danbooru"].suggest(tag)
        except OSError:
            pass
    return info, ranked
