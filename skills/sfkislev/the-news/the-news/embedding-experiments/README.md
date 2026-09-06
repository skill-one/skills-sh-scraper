# Embedding experiments

Reproduces ClawHub's vector-search scoring locally so we can iterate on
description / SKILL.md wording without republishing.

## What it does

- Pulls the **actually-published** frontmatter + SKILL.md (+ small bundled files)
  for `the-news`, `cctv-news-fetcher`, and other competitors via ClawHub's public
  Convex HTTP API.
- Rebuilds the exact embedding-input string ClawHub builds (`buildEmbeddingText`),
  truncated to 12_000 chars.
- Embeds each one with `text-embedding-3-small` (1536 dims, same model ClawHub uses).
- Embeds a list of query terms (`news`, `headlines`, etc.) with no preprocessing,
  matching ClawHub's `args.query.trim()` at search time.
- Computes cosine similarity (Convex vector-index default metric).
- Prints both absolute scores and the gap to `the-news`.

## Run

```
pip install openai numpy
set OPENAI_API_KEY=sk-...
python compare.py
```

Cost: ~$0.001 per run. Embedding-3-small is $0.02 per 1M tokens.

## Workflow for iterating

1. Run baseline — observe gap to `cctv-news-fetcher` on query `news`.
2. Edit a local copy of `SKILL.md` / description, save in this dir as e.g.
   `variant_v1_skill.md`.
3. Modify `compare.py` to add a fake "skill" entry that reads from the local
   variant instead of fetching from Convex.
4. Re-run, see if cosine for `news` moves up.
5. When a variant beats CCTV on `news` without losing on other queries, ship it.
