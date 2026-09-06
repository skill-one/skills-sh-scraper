"""
Test the current local SKILL.md (restructured to front-load semantic content
before the 7,500-byte cut) against the published v1.0.8 (multilingual at bottom,
cut off).
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
           "front page news", "global news", "international news"]


def truncate_utf8_bytes(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    end = max_bytes
    while end > 0 and (encoded[end] & 0xC0) == 0x80:
        end -= 1
    return encoded[:end].decode("utf-8", errors="ignore")


def fetch_published_skill_md(slug: str) -> tuple[dict, str]:
    body = json.dumps({"path": "skills:getBySlug", "args": {"slug": slug},
                       "format": "json"}).encode()
    req = urllib.request.Request("https://wry-manatee-359.convex.cloud/api/query",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        meta = json.loads(r.read())["value"]
    url = (f"https://wry-manatee-359.convex.site/api/v1/skills/{slug}/file?"
           + urllib.parse.urlencode({"path": "SKILL.md"}))
    with urllib.request.urlopen(url) as r:
        raw = r.read().decode("utf-8", errors="replace")
    return meta, raw


def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not m:
        return {}, text
    fields = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    return fields, text[m.end():]


def build(name, desc, body) -> str:
    header = "\n".join([p for p in [name, desc] if p])
    raw = "\n\n".join([header, body])
    char_lim = raw[:MAX_CHARS]
    return truncate_utf8_bytes(char_lim, MAX_BYTES)


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()
    embed = lambda t: np.array(
        client.embeddings.create(model=MODEL, input=t).data[0].embedding)
    cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    # Published v1.0.8 (multilingual at bottom, gets cut)
    pub_meta, pub_raw = fetch_published_skill_md("the-news")
    pub_fm, pub_body = parse_frontmatter(pub_raw)
    pub_text = build(pub_fm.get("name", ""), pub_fm.get("description", ""), pub_body)

    # Local restructured (multilingual moved up)
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/SKILL.md",
              encoding="utf-8") as f:
        local_raw = f.read()
    local_fm, local_body = parse_frontmatter(local_raw)
    local_text = build(local_fm.get("name", ""), local_fm.get("description", ""),
                       local_body)

    print(f"Published v{pub_meta['latestVersion']['version']}: "
          f"{len(pub_text)} chars / {len(pub_text.encode('utf-8'))} bytes")
    print(f"Local restructure:        "
          f"{len(local_text)} chars / {len(local_text.encode('utf-8'))} bytes")

    # Check what's IN each truncated text
    print("\n--- Last 200 chars of PUBLISHED (what survives truncation) ---")
    print(pub_text[-200:])
    print("\n--- Last 200 chars of LOCAL RESTRUCTURED ---")
    print(local_text[-200:])

    pub_vec = embed(pub_text)
    local_vec = embed(local_text)
    query_vecs = {q: embed(q) for q in QUERIES}

    print(f"\n{'query':<22}{'PUBLISHED':<14}{'LOCAL':<14}{'DELTA':<10}")
    print("-" * 60)
    for q in QUERIES:
        p = cos(pub_vec, query_vecs[q])
        l = cos(local_vec, query_vecs[q])
        d = l - p
        marker = "  <-- !" if abs(d) > 0.02 else ""
        print(f"{q:<22}{p:<14.4f}{l:<14.4f}{d:+.4f}{marker}")

    # Also probe the multilingual presence
    print("\nDoes 'multilingual' / 'noticias' appear in each truncated text?")
    for label, t in [("PUBLISHED", pub_text), ("LOCAL", local_text)]:
        has_multi = "Multilingual" in t
        has_noticias = "noticias" in t
        print(f"  {label}: Multilingual={has_multi}, noticias={has_noticias}")


if __name__ == "__main__":
    main()
