"""
Compare SKILL.md (current draft) vs SKILL-edit.md (action-verb + news-source variant)
against top 'news' competitors. Show cosine on key queries and predicted final score.
"""
import os
import re
import sys
import json
import urllib.request
import urllib.parse
import math
import numpy as np
from openai import OpenAI

MODEL = "text-embedding-3-small"
MAX_BYTES = 7_500
QUERIES = ["news", "headlines", "world news", "breaking news",
           "front page news", "global news", "international news",
           "current events", "news api"]
COMPETITORS = ["cctv-news-fetcher", "news", "news-summary",
               "hot-news-aggregator", "daily-news-brief"]


def trunc_bytes(text, max_bytes):
    enc = text.encode("utf-8")
    if len(enc) <= max_bytes:
        return text
    end = max_bytes
    while end > 0 and (enc[end] & 0xC0) == 0x80:
        end -= 1
    return enc[:end].decode("utf-8", errors="ignore")


def parse_fm(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not m:
        return {}, text
    fields = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    return fields, text[m.end():]


def fetch_skill(slug):
    body = json.dumps({"path": "skills:getBySlug", "args": {"slug": slug},
                       "format": "json"}).encode()
    req = urllib.request.Request("https://wry-manatee-359.convex.cloud/api/query",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        meta = json.loads(r.read())["value"]
    files = meta["latestVersion"]["files"]
    downloads = meta["skill"]["stats"]["downloads"]
    skill_md = next((f for f in files if f["path"].lower() == "skill.md"), None)
    if not skill_md:
        return None, None, None, downloads
    def fetch_file(path):
        url = (f"https://wry-manatee-359.convex.site/api/v1/skills/{slug}/file?"
               + urllib.parse.urlencode({"path": path}))
        with urllib.request.urlopen(url) as r:
            return r.read().decode("utf-8", errors="replace")
    txt = fetch_file(skill_md["path"])
    other = []
    for f in files:
        if f["path"].lower() == "skill.md":
            continue
        if f["path"].lower().endswith(".md"):
            continue
        if f.get("size", 0) > 50_000:
            continue
        try:
            other.append((f["path"], fetch_file(f["path"])))
        except Exception:
            pass
    fm, body = parse_fm(txt)
    return fm, body, other, downloads


def build(fm, body, other_files):
    header = "\n".join([p for p in [fm.get("name", ""), fm.get("description", "")] if p])
    file_parts = [f"# {p}\n{c}" for p, c in other_files]
    raw = "\n\n".join(filter(None, [header, body, *file_parts]))
    return trunc_bytes(raw[:12_000], MAX_BYTES)


def predict_final(vec_score, lex_boost, downloads):
    return vec_score + lex_boost + math.log1p(max(downloads, 0)) * 0.08


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()
    embed = lambda t: np.array(client.embeddings.create(model=MODEL, input=t).data[0].embedding)
    cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    # Load both local variants
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/clawhub/SKILL.md",
              encoding="utf-8") as f:
        v1_raw = f.read()
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/clawhub/SKILL-edit.md",
              encoding="utf-8") as f:
        v2_raw = f.read()

    v1_fm, v1_body = parse_fm(v1_raw)
    v2_fm, v2_body = parse_fm(v2_raw)
    v1_text = build(v1_fm, v1_body, [])
    v2_text = build(v2_fm, v2_body, [])

    # Our (the-news) live downloads for final-score projection
    _, _, _, our_dl = fetch_skill("the-news")

    print(f"V1 (current draft, clawhub/SKILL.md): "
          f"{len(v1_text)} chars / {len(v1_text.encode('utf-8'))} bytes "
          f"{'[TRUNCATED]' if len(v1_text.encode('utf-8')) >= MAX_BYTES - 5 else ''}")
    print(f"V2 (SKILL-edit.md, action-verb + sources): "
          f"{len(v2_text)} chars / {len(v2_text.encode('utf-8'))} bytes "
          f"{'[TRUNCATED]' if len(v2_text.encode('utf-8')) >= MAX_BYTES - 5 else ''}")
    print(f"our downloads: {our_dl}")

    v1_vec = embed(v1_text)
    v2_vec = embed(v2_text)
    query_vecs = {q: embed(q) for q in QUERIES}

    # Fetch competitors
    comp_vecs = {}
    comp_dl = {}
    for slug in COMPETITORS:
        fm, body, other, dl = fetch_skill(slug)
        if fm is None:
            continue
        text = build(fm, body, other)
        comp_vecs[slug] = embed(text)
        comp_dl[slug] = dl

    print(f"\nCOSINE on each query:")
    print(f"  {'query':<22}{'V1':<10}{'V2':<10}{'delta':<10}"
          + "".join(f"{s.split('-')[0]:<10}" for s in COMPETITORS))
    print("  " + "-" * (22 + 30 + 10 * len(COMPETITORS)))
    for q in QUERIES:
        c1 = cos(v1_vec, query_vecs[q])
        c2 = cos(v2_vec, query_vecs[q])
        d = c2 - c1
        row = f"  {q:<22}{c1:<10.4f}{c2:<10.4f}{d:+.4f}   "
        for slug in COMPETITORS:
            row += f"{cos(comp_vecs[slug], query_vecs[q]):<10.4f}"
        print(row)

    # Final-score projection for query "news" assuming +2.5 lexical for all top slugs
    # (they all have 'news' as a slug token, name token, etc — confirmed earlier)
    print(f"\nPROJECTED FINAL SCORE for query 'news' (vector + 2.5 lex + 0.08*log1p(dl))")
    print(f"  {'skill':<26}{'vec':<10}{'pop':<10}{'projected':<12}")
    print("  " + "-" * 60)
    rows = [
        ("V1 (current draft)", cos(v1_vec, query_vecs["news"]), our_dl),
        ("V2 (action+sources)", cos(v2_vec, query_vecs["news"]), our_dl),
    ]
    for slug in COMPETITORS:
        rows.append((slug, cos(comp_vecs[slug], query_vecs["news"]), comp_dl[slug]))
    rows.sort(key=lambda r: predict_final(r[1], 2.5, r[2]), reverse=True)
    for label, vec, dl in rows:
        pop = math.log1p(max(dl, 0)) * 0.08
        proj = predict_final(vec, 2.5, dl)
        print(f"  {label:<26}{vec:<10.4f}{pop:<10.4f}{proj:<12.4f}")


if __name__ == "__main__":
    main()
