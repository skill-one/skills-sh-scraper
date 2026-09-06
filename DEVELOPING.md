# Developing

How to run, verify, and extend the scraper. For using the data, see [README.md](README.md) · 中文:[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## How it works

1. `GET /api/v1/skills?per_page=500&page=N` — paginate the leaderboard (~17 requests for the whole catalogue). Only github-sourced entries (`sourceType: "github"`) are kept; well-known (domain) sources have no repository to attribute and are counted in `nonGithub`.
2. `GET https://api.github.com/repos/{owner}/{repo}` — fetch each unique repository's `stargazers_count` (~1,200 requests: skills cluster on shared repos). A 404 (repo deleted) pins `stars` to `null`; any other failure leaves the previous run's value in place.
3. `GET /api/v1/skills/{source}/{skill}` — fetch each skill's files (the `files` array carries the full text). Files are written to a temp dir and renamed into place, so an existing directory is always complete.
4. Merge metadata into a single `skills.jsonl` — one row per skill with saved content, sorted by installs desc, written atomically at the end.
5. Write `stats.json` — the run's stats, published alongside the dataset. Only fields not trivially derivable from the others:

| Field | Meaning |
|---|---|
| `startedAt`, `finishedAt` | when the run started / ended (`durationMs` is their difference) |
| `limit`, `audits` | run configuration (`limit` is `null` for a full scrape) |
| `leaderboardTotal` | github-sourced leaderboard entries after deduplication |
| `nonGithub` | leaderboard entries skipped because they are not github-sourced |
| `githubRepos` | unique repositories star-fetched this run |
| `indexedRows` | lines in `skills.jsonl` |
| `changed` | rows whose content version changed this run (first fetch or a new upstream hash) — exactly the rows whose `fetchedAt` was re-stamped |
| `added`, `removed` | skills entering / leaving the index: newly listed upstream, and no longer listed (row and content directory deleted; full runs only — limited runs carry unevaluated rows over) |
| `dropped`, `failed`, `carriedOver` | outcome counters; `failedIds` lists the failed skill ids |

## Prerequisites

Node >= 22, a Vercel OIDC token (any Vercel project works), and a GitHub token
(for the star counts; public repo read access is enough):

```bash
npm i -g vercel
vercel link && vercel env pull   # writes VERCEL_OIDC_TOKEN into .env.local, valid ~12h
echo 'GITHUB_TOKEN=ghp_…' >> .env.local   # or export GITHUB_TOKEN yourself
```

Re-run `vercel env pull` when the OIDC token expires (HTTP 401). Never commit `.env.local`. In GitHub Actions, the same token is stored as the repo secret `GH_TOKEN` and mapped to the same `GITHUB_TOKEN` env var (secret names may not start with `GITHUB_`) — the built-in `GITHUB_TOKEN` is capped at 1,000 req/hr per repository, too few for the ~1,200 star requests.

## Run

```bash
node scraper.mjs                          # full scrape into ./data (~8,400 + ~1,200 requests, 30–45 min)
node scraper.mjs --limit 20               # first 20 skills only (quick end-to-end check;
                                          # rows outside the limit are carried over, so this
                                          # is safe to run against an existing dataset)
node scraper.mjs --out ./data             # custom output directory
node scraper.mjs --audits                 # also fetch security audits (doubles request count)
```

- skills.sh allows 600 req/min and GitHub's authenticated REST API 5,000 req/hr; the scraper paces itself at 590/min and 80/min respectively (shared concurrency 10) and retries `429` and `5xx` honoring `Retry-After`, plus transient network errors. `4xx` are never retried: they are deterministic.
- Content is fully re-downloaded and rewritten every run (~8,400 skills.sh requests). The previous `skills.jsonl` only pins `fetchedAt`: skills whose upstream hash is unchanged keep the `fetchedAt` of the run that first fetched that content version. Interrupted scrapes resume, and upstream edits are picked up automatically.
- Star counts are re-fetched per unique repository every run (~1,200 GitHub requests). Rows whose repo request failed keep the previous run's value (or `null`); carried-over rows (failed fetches, `--limit`) keep their previous `stars` too. A repo that 404s pins `stars` to `null`.
- The index holds only github-sourced skills whose content is on disk: well-known (domain) sources are skipped at the leaderboard (counted in `nonGithub`), and duplicate skills and skills without an upstream snapshot are left out (logged, counted in the `Done:` summary, retried next run). A skill whose fetch failed keeps its previous index row and content directory, so the mirror keeps serving the last good content and the row ⟺ directory invariant holds; skills never fetched successfully stay out of the index. With `--limit`, skills outside the limit keep their previous rows too (the limit constrains only what is fetched, never the index; the next full run re-evaluates them). All of these count as `carried over`. The process exits non-zero only for systemic failures (auth, leaderboard, index write).
- With `--audits`, audit results are re-fetched only for skills whose content hash changed; unchanged skills reuse the previous results without a request.
- Slug normalization: a slug may itself contain `/` upstream (e.g. `claude-office-skills/skills/facebook/meta-ads`). skills.sh keys such skills by `${source}/${slug}` with the `/` stripped from the slug (`…/facebookmeta-ads`) — the only form its detail API can address for multi-segment slugs. The scraper therefore normalizes each github-sourced leaderboard entry's id to `${source}/${slug-without-slashes}` (`canonicalId` in `lib.mjs`) before deduplication; two raw ids can in principle strip to the same canonical id, in which case the first occurrence wins. Ids whose slug carries no slash (the vast majority) pass through unchanged.

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
- **`fetch-skills.yml`** (daily 18:00 UTC + manual): restores the previous `dist` snapshot into `data/` first — the upstream hashes in its `skills.jsonl` pin `fetchedAt`, reuse unchanged audit results, keep the last good content of failed fetches, and make the `changed`/`added`/`removed` counters describe the run instead of an empty workspace — then full scrape as a daily canary → `verify.mjs` → force-pushes a daily commit to the [`dist` branch](README.md#where-the-data-is), pruning history to the newest 5 and tagging each retained snapshot `dist-<date>` (slash-free so the tag resolves in raw URLs; tags outside the window are deleted, so pruned objects stay unreachable). It mints a fresh OIDC token from the long-lived `VERCEL_TOKEN` (required secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — the last two from `.vercel/project.json` after `vercel link`); star counts read the repo secret `GH_TOKEN` (a personal access token, mapped to the `GITHUB_TOKEN` env var — set it with `gh secret set GH_TOKEN`).
