# Keyword recall for Chat and Novel: finds the older passages that share the most words with what is being written now
# (BM25 ranking from bm25s), so a reply or a chapter can use details that no longer fit in the writer's context.
# Runs on the processor in milliseconds; nothing is stored, the index is built for each request.
import logging
import re

try:
    import bm25s
except ImportError:   # optional: without it there is simply no recall
    bm25s = None
    logging.info("[Kobo] bm25s is not installed: Chat and Novel won't recall older passages")

_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)?")
_STOP = frozenset("""a about above after again against all am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from
further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his
how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's like me more most mustn't my myself no nor
not now of off oh ok okay on once only or other ought our ours ourselves out over own really said same say says shan't she
she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's
these they they'd they'll they're they've this those through to too um under until up us very was wasn't we we'd we'll
we're we've well were weren't what what's when when's where where's which while who who's whom why why's will with won't
would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves""".split())


def _tokens(text):
    return [w for w in _WORD.findall(text.lower()) if len(w) > 1 and w not in _STOP]


def search(query, passages, limit_chars, k=8):
    """Indexes of the passages that best match the query, best first, as many as fit in limit_chars together.
    Empty when bm25s is missing or no passage shares a word with the query."""
    q = _tokens(query)
    docs = [(i, t) for i, t in enumerate(_tokens(p) for p in passages) if t]
    if bm25s is None or not q or not docs:
        return []
    index = bm25s.BM25()
    index.index([t for _, t in docs], show_progress=False)
    found, scores = index.retrieve([q], k=min(k, len(docs)), show_progress=False)
    hits, used = [], 0
    for d, score in zip(found[0], scores[0]):
        i = docs[int(d)][0]
        if score <= 0 or used + len(passages[i]) > limit_chars:
            continue
        hits.append(i)
        used += len(passages[i])
    return hits


def chunks(text, size):
    """Paragraphs joined into pieces of at most `size` characters; a longer paragraph is cut."""
    out, cur = [], ""
    for para in (p.strip() for p in re.split(r"\n\s*\n", text or "")):
        while len(para) > size:
            if cur:
                out.append(cur)
                cur = ""
            out.append(para[:size])
            para = para[size:].strip()
        if not para:
            continue
        if cur and len(cur) + 2 + len(para) > size:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out
