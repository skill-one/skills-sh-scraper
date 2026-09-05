# Developing

How to run, verify, and extend the scraper. For using the data, see [README.md](README.md) · 中文:[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## How it works

1. `GET /api/v1/skills?per_page=500&page=N` — paginate the leaderboard (~17 requests for the whole catalogue).
2. `GET /api/v1/skills/{source}/{skill}` — fetch each skill's files (the `files` array carries the full text). Files are written to a temp dir and renamed into place, so an existing directory is always complete.
3. Merge metadata into a single `skills.jsonl` — one row per skill with saved content, sorted by installs desc, written atomically at the end.
4. Write `stats.json` — the run's stats (timing, entry counts, failed ids), published alongside the dataset.

## Prerequisites

Node >= 22 and a Vercel OIDC token (any Vercel project works):

```bash
npm i -g vercel
vercel link && vercel env pull   # writes VERCEL_OIDC_TOKEN into .env.local, valid ~12h
```

Re-run `vercel env pull` when it expires (HTTP 401). Never commit `.env.local`.

## Run

```bash
node scraper.mjs                          # full scrape into ./data (~8,400 requests, 15–30 min)
node scraper.mjs --limit 20               # first 20 skills only (quick end-to-end check;
                                          # rows outside the limit are carried over, so this
                                          # is safe to run against an existing dataset)
node scraper.mjs --out ./data             # custom output directory
node scraper.mjs --audits                 # also fetch security audits (doubles request count)
```

- The API allows 600 req/min; the scraper paces itself at 590/min (concurrency 10) and retries `429` and `5xx` honoring `Retry-After`, plus transient network errors. `4xx` are never retried: they are deterministic.
- Content is fully re-downloaded and rewritten every run (~8,400 requests, 15–30 min). The previous `skills.jsonl` only pins `fetchedAt`: skills whose upstream hash is unchanged keep the `fetchedAt` of the run that first fetched that content version. Interrupted scrapes resume, and upstream edits are picked up automatically.
- The index holds only skills whose content is on disk: duplicate skills and skills without an upstream snapshot are left out (logged, counted in the `Done:` summary, retried next run). A skill whose fetch failed keeps its previous index row and content directory, so the mirror keeps serving the last good content and the row ⟺ directory invariant holds; skills never fetched successfully stay out of the index. With `--limit`, skills outside the limit keep their previous rows too (the limit constrains only what is fetched, never the index; the next full run re-evaluates them). All of these count as `carried over`. The process exits non-zero only for systemic failures (auth, leaderboard, index write).
- With `--audits`, audit results are re-fetched only for skills whose content hash changed; unchanged skills reuse the previous results without a request.
- Known upstream limitation: skills whose slug contains `/` (e.g. `claude-office-skills/skills/facebook/meta-ads`) always fail the detail fetch with HTTP 400 — the API only routes `/{owner}/{repo}/{skill}` and cannot address such ids (no encoding works). They fail fast, show up in `stats.json` → `failedIds`, and are retried every run in case upstream adds support.

## Verification

| Layer | Answers | Needs | Command |
|---|---|---|---|
| 1. Offline tests | Is the scraper logic correct? | nothing (mock API) | `npm test` |
| 2. Artifact verifier | Is a dataset intact? | nothing (no network) | `node verify.mjs --out data` |
| 3. Real API run | Does the live API still behave? | token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` is the gate before trusting or uploading a dataset: every line parses, ids unique, rows sorted by installs desc (ties by id), fields well-formed, no two rows sharing a sanitized directory name, rows and content directories match exactly (every row has a directory, no orphan directories), `stats.json` present, parseable and consistent with the index, no `.tmp` leftovers. Local quickstart:

```bash
npm test                          # fast, no secrets
npm run scrape && npm run verify  # full scrape + integrity check
```

## CI

- **`ci.yml`** (push / PR): layer 1 on Node 22 and 24. Secret-free, so fork PRs run too.
- **`fetch-skills.yml`** (daily 02:00 UTC + manual): full scrape as a daily canary → resume check (a sampled second run over the top 500 skills, on a throwaway copy of the dataset, must save ≤5) → `verify.mjs` → force-pushes a daily commit to the [`dist` branch](README.md#where-the-data-is), pruning history to the newest 5. It mints a fresh OIDC token from the long-lived `VERCEL_TOKEN` (required secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — the last two from `.vercel/project.json` after `vercel link`).
