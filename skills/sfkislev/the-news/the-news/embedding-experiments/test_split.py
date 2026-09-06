"""
Test the new split SKILL.md (clawhub/SKILL.md) against the currently-published
v1.0.8 and the top news competitors. Mirrors ClawHub's buildEmbeddingText.
"""
import os
import re
import sys
import json
import urllib.request
import urllib.parse
import numpy as np
from openai import OpenAI

MODEL = "text-embedding-3-small"
MAX_CHARS = 12_000
MAX_BYTES = 7_500
QUERIES = ["news", "headlines", "world news", "breaking news",
           "front page news", "global news", "international news",
           "current events", "news api"]
COMPETITORS = ["the-news", "cctv-news-fetcher", "news", "news-summary",
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
    # Fetch SKILL.md + non-md text files (mimic publish-side otherFiles filter)
    skill_md = next((f for f in files if f["path"].lower() == "skill.md"), None)
    if not skill_md:
        return None, None, None
    def fetch_file(path):
        url = (f"https://wry-manatee-359.convex.site/api/v1/skills/{slug}/file?"
               + urllib.parse.urlencode({"path": path}))
        with urllib.request.urlopen(url) as r:
            return r.read().decode("utf-8", errors="replace")
    skill_md_text = fetch_file(skill_md["path"])
    other = []
    for f in files:
        if f["path"].lower() == "skill.md":
            continue
        if f["path"].lower().endswith(".md"):
            continue  # ClawHub filters .md from otherFiles
        if f.get("size", 0) > 50_000:
            continue
        try:
            other.append((f["path"], fetch_file(f["path"])))
        except Exception:
            pass
    fm, body = parse_fm(skill_md_text)
    return fm, body, other


def build(fm, body, other_files):
    header = "\n".join([p for p in [fm.get("name", ""), fm.get("description", "")]
                        if p])
    file_parts = [f"# {p}\n{c}" for p, c in other_files]
    raw = "\n\n".join(filter(None, [header, body, *file_parts]))
    char_lim = raw[:MAX_CHARS]
    return trunc_bytes(char_lim, MAX_BYTES)


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()
    embed = lambda t: np.array(
        client.embeddings.create(model=MODEL, input=t).data[0].embedding)
    cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    # Build the new candidate from local clawhub/SKILL.md (no other files yet, REFERENCE.md
    # would be .md so excluded from embedding anyway)
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/clawhub/SKILL.md",
              encoding="utf-8") as f:
        cand_raw = f.read()
    cand_fm, cand_body = parse_fm(cand_raw)
    cand_text = build(cand_fm, cand_body, [])
    print(f"NEW CANDIDATE (clawhub/SKILL.md split):"
          f" {len(cand_text)} chars / {len(cand_text.encode('utf-8'))} bytes")
    print(f"  Truncated: {len(cand_text.encode('utf-8')) >= MAX_BYTES - 5}")
    cand_vec = embed(cand_text)

    # Fetch competitors
    comp_vecs = {}
    for slug in COMPETITORS:
        fm, body, other = fetch_skill(slug)
        if fm is None:
            continue
        text = build(fm, body, other)
        b = len(text.encode("utf-8"))
        trunc_flag = "[TRUNCATED]" if b >= MAX_BYTES - 5 else ""
        print(f"  {slug:<22}: {len(text):>5} chars / {b:>5} bytes {trunc_flag}"
              f" (+{len(other)} extra files)")
        comp_vecs[slug] = embed(text)

    query_vecs = {q: embed(q) for q in QUERIES}

    print(f"\nCOSINE SIMILARITY (NEW vs competitors)")
    cols = ["NEW"] + COMPETITORS
    print(f"{'query':<22}" + "".join(f"{c:<22}" for c in cols))
    print("-" * (22 + 22 * len(cols)))
    for q in QUERIES:
        row = f"{q:<22}"
        row += f"{cos(cand_vec, query_vecs[q]):<22.4f}"
        for slug in COMPETITORS:
            if slug in comp_vecs:
                row += f"{cos(comp_vecs[slug], query_vecs[q]):<22.4f}"
            else:
                row += f"{'-':<22}"
        print(row)

    print(f"\nGAP (positive = NEW beats competitor; negative = NEW loses)")
    for q in QUERIES:
        new_score = cos(cand_vec, query_vecs[q])
        row = f"  {q:<20}"
        for slug in COMPETITORS:
            if slug not in comp_vecs:
                continue
            gap = new_score - cos(comp_vecs[slug], query_vecs[q])
            row += f"  {slug.split('-')[0]}: {gap:+.3f}"
        print(row)


if __name__ == "__main__":
    main()
