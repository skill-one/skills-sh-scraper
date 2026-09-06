"""
Reproduce ClawHub's embedding-and-search to compare cosine similarity for
'the-news' vs 'cctv-news-fetcher' against query terms.

Mirrors openclaw/clawhub:
  - model: text-embedding-3-small, default 1536 dims
  - embedding input = name + description + homepage + website + url + emoji
    joined by "\n", then "\n\n", then README body, then "\n\n# {path}\n{content}"
    for each other file; truncated to 12_000 chars.
  - query embedded as raw .trim()
  - similarity: cosine (Convex vector index default)

Usage:
  set OPENAI_API_KEY=sk-...
  python compare.py
"""
import os
import re
import sys
import json
import urllib.request
import urllib.parse

import numpy as np
from openai import OpenAI

CONVEX_QUERY = "https://wry-manatee-359.convex.cloud/api/query"
CONVEX_FILE = "https://wry-manatee-359.convex.site/api/v1/skills/{slug}/file"
MODEL = "text-embedding-3-small"
MAX_CHARS = 12_000
MAX_BYTES = 7_500  # PR #2337 (May 21, 2026): bytes cap added on top of char cap

QUERIES = ["news", "headlines", "world news", "breaking news",
           "front page news", "global news"]
SKILLS = ["the-news", "cctv-news-fetcher", "news", "news-summary",
          "hot-news-aggregator", "market-news", "daily-news-brief"]


def fetch_skill_meta(slug: str) -> dict:
    body = json.dumps({"path": "skills:getBySlug",
                       "args": {"slug": slug}, "format": "json"}).encode()
    req = urllib.request.Request(CONVEX_QUERY, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["value"]


def fetch_skill_file(slug: str, path: str) -> str:
    url = CONVEX_FILE.format(slug=slug) + "?" + urllib.parse.urlencode({"path": path})
    with urllib.request.urlopen(url) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Strip leading YAML-ish frontmatter (--- ... ---), return (fields, body)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not m:
        return {}, text
    fields = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    return fields, text[m.end():]


def truncate_utf8_bytes(text: str, max_bytes: int) -> str:
    """Mirror convex/lib/skills.ts truncateUtf8Bytes: keep largest prefix
    that encodes to <= max_bytes in UTF-8, never splitting a code point."""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    # Walk back from max_bytes to a UTF-8 boundary (continuation byte starts 0b10xxxxxx).
    end = max_bytes
    while end > 0 and (encoded[end] & 0xC0) == 0x80:
        end -= 1
    return encoded[:end].decode("utf-8", errors="ignore")


def build_embedding_text(name: str, description: str, homepage: str,
                         website: str, url: str, emoji: str,
                         readme: str, other_files: list[tuple[str, str]]) -> str:
    header_parts = [p for p in [name, description, homepage, website, url, emoji] if p]
    file_parts = [f"# {p}\n{c}" for p, c in other_files]
    raw = "\n\n".join(filter(None, ["\n".join(header_parts), readme, *file_parts]))
    char_limited = raw[:MAX_CHARS]
    return truncate_utf8_bytes(char_limited, MAX_BYTES)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()

    def embed(text: str) -> np.ndarray:
        r = client.embeddings.create(model=MODEL, input=text)
        return np.array(r.data[0].embedding)

    query_vecs = {q: embed(q.strip()) for q in QUERIES}

    skill_vecs = {}
    skill_inputs = {}
    for slug in SKILLS:
        meta = fetch_skill_meta(slug)
        parsed = meta["latestVersion"]["parsed"]
        files = meta["latestVersion"]["files"]
        skill_md = next((f for f in files if f["path"].lower() == "skill.md"), None)
        if not skill_md:
            print(f"SKIP {slug}: no SKILL.md")
            continue
        raw_md = fetch_skill_file(slug, skill_md["path"])
        fm, body = parse_frontmatter(raw_md)
        other = []
        for f in files:
            if f["path"].lower() == "skill.md":
                continue
            if f.get("size", 0) > 50_000:
                continue
            try:
                other.append((f["path"], fetch_skill_file(slug, f["path"])))
            except Exception as e:
                print(f"  skip file {f['path']}: {e}")
        emb_text = build_embedding_text(
            name=fm.get("name") or parsed.get("name", ""),
            description=fm.get("description") or parsed.get("description", ""),
            homepage=fm.get("homepage", ""),
            website=fm.get("website", ""),
            url=fm.get("url", ""),
            emoji=fm.get("emoji", ""),
            readme=body,
            other_files=other,
        )
        skill_inputs[slug] = emb_text
        skill_vecs[slug] = embed(emb_text)
        emb_bytes = len(emb_text.encode("utf-8"))
        truncated = emb_bytes >= MAX_BYTES - 5
        print(f"  embedded {slug}: {len(emb_text)} chars / {emb_bytes} bytes"
              f" {'[TRUNCATED to byte cap]' if truncated else ''}"
              f", {len(other)} extra files")

    print()
    print("COSINE SIMILARITY")
    header = f"{'query':<22}" + "".join(f"{s:<22}" for s in skill_vecs)
    print(header)
    print("-" * len(header))
    for q in QUERIES:
        row = f"{q:<22}"
        for slug in skill_vecs:
            row += f"{cosine(skill_vecs[slug], query_vecs[q]):<22.4f}"
        print(row)

    print()
    print("RELATIVE GAP TO the-news (positive = competitor beats us)")
    for q in QUERIES:
        ours = cosine(skill_vecs["the-news"], query_vecs[q])
        gaps = []
        for slug in skill_vecs:
            if slug == "the-news":
                continue
            gaps.append(f"{slug}: {cosine(skill_vecs[slug], query_vecs[q]) - ours:+.4f}")
        print(f"  {q:<20} " + "  ".join(gaps))


if __name__ == "__main__":
    main()
