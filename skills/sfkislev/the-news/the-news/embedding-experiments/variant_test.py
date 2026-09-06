"""
Variant test: keep SKILL.md body identical, only change the frontmatter `name`
field that goes into buildEmbeddingText. See how much cosine vs "news" moves.
"""
import os
import sys
import numpy as np
from openai import OpenAI

MODEL = "text-embedding-3-small"
MAX_CHARS = 12_000

QUERIES = ["news", "headlines", "world news", "breaking news",
           "front page news", "global news"]

DESCRIPTION = ("gives agents real-time and archival access to front-page headlines "
               "across 20 countries for breaking news, current events, and "
               "comparative media analysis.")


def load_body() -> str:
    """SKILL.md body without frontmatter."""
    with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/SKILL.md",
              encoding="utf-8") as f:
        text = f.read()
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:].lstrip("\n")
    return text


def build(name: str, description: str, body: str) -> str:
    header = "\n".join([name, description])
    raw = "\n\n".join([header, body])
    return raw[:MAX_CHARS]


def main():
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("set OPENAI_API_KEY first")
    client = OpenAI()

    def embed(t: str) -> np.ndarray:
        r = client.embeddings.create(model=MODEL, input=t)
        return np.array(r.data[0].embedding)

    def cos(a, b):
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    body = load_body()

    variants = {
        "baseline (name=the-news)":     ("the-news", DESCRIPTION),
        "name=news":                    ("news", DESCRIPTION),
        "name=news-headlines":          ("news-headlines", DESCRIPTION),
        "name=global-news":             ("global-news", DESCRIPTION),
        "name=news-for-agents":         ("news-for-agents", DESCRIPTION),
        "name=news-headlines-global":   ("news-headlines-global", DESCRIPTION),
    }

    query_vecs = {q: embed(q.strip()) for q in QUERIES}

    print(f"{'variant':<40}" + "".join(f"{q:<18}" for q in QUERIES))
    print("-" * (40 + 18 * len(QUERIES)))
    for label, (name, desc) in variants.items():
        text = build(name, desc, body)
        v = embed(text)
        row = f"{label:<40}"
        for q in QUERIES:
            row += f"{cos(v, query_vecs[q]):<18.4f}"
        print(row)


if __name__ == "__main__":
    main()
