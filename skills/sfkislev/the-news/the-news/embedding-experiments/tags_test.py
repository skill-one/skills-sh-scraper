"""
Test adding a tags/keywords section to SKILL.md and measure cosine impact.
Variants:
  A) baseline (current SKILL.md, no tags)
  B) English news synonyms appended at bottom
  C) Multilingual "news" terms appended at bottom
  D) English news synonyms appended at TOP (before Overview)
  E) Combined: English at top + multilingual at bottom
  F) High-density English keywords woven into description + bottom tags
"""
import os
import sys
import numpy as np
from openai import OpenAI

MODEL = "text-embedding-3-small"
MAX_CHARS = 12_000

QUERIES = ["news", "headlines", "world news", "breaking news",
           "front page news", "global news", "current events", "news api"]

DESCRIPTION = ("gives agents real-time and archival access to front-page headlines "
               "across 20 countries for breaking news, current events, and "
               "comparative media analysis.")

DESCRIPTION_NEWS_DENSE = ("News headlines API for agents. Real-time news and "
                          "historical news archive. Global news from 20 countries — "
                          "breaking news, world news, front-page news, and comparative "
                          "news analysis.")

ENGLISH_TAGS = """
## Tags
news, headlines, breaking news, world news, global news, international news,
news api, news headlines, front-page news, current events, news archive,
real-time news, daily news, news aggregator, news sources, news outlets,
news media, news skill, news agent, news fetcher, news service.
"""

MULTILINGUAL_TAGS = """
## Multilingual
news (English), noticias (Spanish), nouvelles (French), Nachrichten (German),
notizie (Italian), notícias (Portuguese), новости (Russian), 新闻 (Chinese),
ニュース (Japanese), 뉴스 (Korean), أخبار (Arabic), חדשות (Hebrew),
haberler (Turkish), nieuws (Dutch), uutiset (Finnish), wiadomości (Polish),
новини (Ukrainian), समाचार (Hindi), aktualności (Polish).
"""


def load_body() -> str:
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/SKILL.md",
              encoding="utf-8") as f:
        text = f.read()
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:].lstrip("\n")
    return text


def build(name: str, description: str, body: str) -> str:
    return "\n\n".join([f"{name}\n{description}", body])[:MAX_CHARS]


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()

    def embed(t):
        r = client.embeddings.create(model=MODEL, input=t)
        return np.array(r.data[0].embedding)

    def cos(a, b):
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    body = load_body()

    variants = {
        "A baseline":                build("the-news", DESCRIPTION, body),
        "B +English tags bottom":    build("the-news", DESCRIPTION, body + "\n" + ENGLISH_TAGS),
        "C +Multilingual bottom":    build("the-news", DESCRIPTION, body + "\n" + MULTILINGUAL_TAGS),
        "D +English tags TOP":       build("the-news", DESCRIPTION, ENGLISH_TAGS + "\n" + body),
        "E +Eng top + Multi bottom": build("the-news", DESCRIPTION, ENGLISH_TAGS + "\n" + body + "\n" + MULTILINGUAL_TAGS),
        "F dense-desc + Eng bottom": build("the-news", DESCRIPTION_NEWS_DENSE, body + "\n" + ENGLISH_TAGS),
    }

    query_vecs = {q: embed(q.strip()) for q in QUERIES}

    for label, text in variants.items():
        print(f"  {label}: {len(text)} chars")
    print()

    # header
    print(f"{'variant':<30}" + "".join(f"{q:<16}" for q in QUERIES))
    print("-" * (30 + 16 * len(QUERIES)))
    base_v = embed(variants["A baseline"])
    base_scores = {q: cos(base_v, query_vecs[q]) for q in QUERIES}
    for label, text in variants.items():
        v = embed(text)
        row = f"{label:<30}"
        for q in QUERIES:
            row += f"{cos(v, query_vecs[q]):<16.4f}"
        print(row)

    print()
    print(f"{'variant':<30}" + "".join(f"{q:<16}" for q in QUERIES))
    print("DELTA vs baseline")
    print("-" * (30 + 16 * len(QUERIES)))
    for label, text in variants.items():
        if label == "A baseline":
            continue
        v = embed(text)
        row = f"{label:<30}"
        for q in QUERIES:
            d = cos(v, query_vecs[q]) - base_scores[q]
            row += f"{d:+.4f}        "
        print(row)


if __name__ == "__main__":
    main()
