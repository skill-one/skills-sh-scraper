# Developing

How to run, verify, and extend the scraper. For using the data, see [README.md](README.md) · 中文:[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## How it works

1. `GET /api/v1/skills?per_page=500&page=N` — paginate the leaderboard (~17 requests for the whole catalogue).
2. `GET /api/v1/skills/{source}/{skill}` — fetch each skill's files (the `files` array carries the full text). Files are written to a temp dir and renamed into place, so an existing directory is always complete.
3. Merge metadata into a single `skills.jsonl`, sorted by installs desc, written atomically at the end.

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
node scraper.mjs --limit 20               # first 20 skills only (quick end-to-end check)
node scraper.mjs --out ./data             # custom output directory
node scraper.mjs --audits                 # also fetch security audits (doubles request count)
node scraper.mjs --skip-duplicates        # skip content download for isDuplicate skills (metadata still recorded)
```

- The API allows 600 req/min; the scraper paces itself at 590/min (concurrency 10) and retries `429`/`503` honoring `Retry-After`, plus transient network errors.
- Re-running is safe: content is fetched only when its directory is missing, so interrupted scrapes resume. Metadata and audits refresh every run.
- Per-skill failures are recorded in that row's `error` field and retried next run; the process exits non-zero only for systemic failures (auth, leaderboard, index write).

## Verification

| Layer | Answers | Needs | Command |
|---|---|---|---|
| 1. Offline tests | Is the scraper logic correct? | nothing (mock API) | `npm test` |
| 2. Artifact verifier | Is a dataset intact? | nothing (no network) | `node verify.mjs --out data` |
| 3. Real API run | Does the live API still behave? | token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` is the gate before trusting or uploading a dataset: every line parses, ids unique, rows sorted by installs desc, fields well-formed, `contentSaved` matches the on-disk directories exactly, no `.tmp` leftovers. Local quickstart:

```bash
npm test                          # fast, no secrets
npm run scrape && npm run verify  # full scrape + integrity check
```

## CI

- **`ci.yml`** (push / PR): layer 1 on Node 22 and 24. Secret-free, so fork PRs run too.
- **`fetch-skills.yml`** (daily 02:00 UTC + manual): full scrape as a daily canary → resume check (a second run must re-save ≤1% of skills) → `verify.mjs` → force-pushes a daily commit to the [`dist` branch](README.md#where-the-data-is), pruning history to the newest 5. It mints a fresh OIDC token from the long-lived `VERCEL_TOKEN` (required secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — the last two from `.vercel/project.json` after `vercel link`).
