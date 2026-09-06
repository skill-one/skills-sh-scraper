"""
Analyze news-token density across competitors and the new candidate.
For each doc, count occurrences of news-flavored tokens per 1000 bytes
of embedded text, and show what fraction of bytes are 'news-adjacent'
vs structural/reference content.
"""
import os
import re
import sys
import json
import urllib.request
import urllib.parse


MAX_BYTES = 7_500
COMPETITORS = ["the-news", "cctv-news-fetcher", "news", "news-summary",
               "hot-news-aggregator", "daily-news-brief"]
NEWS_TOKENS = ["news", "headline", "headlines", "breaking", "current event",
               "front-page", "front page", "story", "stories", "report",
               "report", "press", "media", "outlet", "broadcast"]
STRUCTURAL_PATTERNS = [
    (r"```[\s\S]*?```", "code block"),
    (r"\|[^\n]+\|", "table row"),
    (r"https?://\S+", "URL"),
    (r"\{[^\}]*\}", "json fragment"),
]


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
    skill_md = next((f for f in files if f["path"].lower() == "skill.md"), None)
    if not skill_md:
        return None, None, None
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
    return fm, body, other


def build(fm, body, other_files):
    header = "\n".join([p for p in [fm.get("name", ""), fm.get("description", "")] if p])
    file_parts = [f"# {p}\n{c}" for p, c in other_files]
    raw = "\n\n".join(filter(None, [header, body, *file_parts]))
    return trunc_bytes(raw[:12_000], MAX_BYTES)


def analyze(label, text):
    bytes_total = len(text.encode("utf-8"))
    text_lower = text.lower()
    news_hits = sum(text_lower.count(tok) for tok in NEWS_TOKENS)

    # Identify structural bytes (URLs, code blocks, tables, JSON)
    structural_bytes = 0
    for pat, _ in STRUCTURAL_PATTERNS:
        for m in re.finditer(pat, text):
            structural_bytes += len(m.group(0).encode("utf-8"))
    structural_pct = 100 * structural_bytes / max(1, bytes_total)

    # First 300 bytes (high-weight region) news density
    head = text.encode("utf-8")[:300].decode("utf-8", errors="ignore").lower()
    head_news = sum(head.count(tok) for tok in NEWS_TOKENS)

    print(f"  {label:<26} bytes={bytes_total:>5}  news_tokens={news_hits:>3}"
          f"  per_1k={1000*news_hits/bytes_total:>5.1f}"
          f"  head300_news={head_news:>2}  struct%={structural_pct:>5.1f}")


def main():
    # New candidate
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/clawhub/SKILL.md",
              encoding="utf-8") as f:
        cand_raw = f.read()
    cand_fm, cand_body = parse_fm(cand_raw)
    cand_text = build(cand_fm, cand_body, [])

    print("Density analysis on EMBEDDED text (post-truncation)")
    print(f"  {'label':<26} {'bytes':>5}  {'news_tok':>9}"
          f"  {'per_1k':>6}  {'head300':>8}  {'struct':>7}")
    print("-" * 90)
    analyze("NEW CANDIDATE", cand_text)
    for slug in COMPETITORS:
        fm, body, other = fetch_skill(slug)
        if fm is None:
            continue
        text = build(fm, body, other)
        analyze(slug, text)

    # Also dump first 300 bytes of each so we can see what the high-weight zone holds
    print("\n--- HIGH-WEIGHT REGION (first 300 bytes of each embedded text) ---")
    print(f"\n[NEW CANDIDATE]")
    print(cand_text[:300])
    for slug in COMPETITORS:
        fm, body, other = fetch_skill(slug)
        if fm is None:
            continue
        text = build(fm, body, other)
        print(f"\n[{slug}]")
        print(text[:300])


if __name__ == "__main__":
    main()
