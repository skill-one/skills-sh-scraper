# skills.sh scraper

Scrape every skill listed on [skills.sh](https://www.skills.sh) — leaderboard metadata plus each skill's full file contents — into a local directory. Single-file, zero dependencies (Node >= 20). Built on the [official API](https://www.skills.sh/docs/api).

## How it works

1. `GET /api/v1/skills?per_page=500&page=N` — paginate the leaderboard (~17 requests for the whole catalogue).
2. `GET /api/v1/skills/{source}/{skill}` — fetch each skill's detail (its `files` array carries the full text of every file) and write the files to a pure per-skill directory. Files are written to a temp dir and renamed into place, so a directory that exists is always complete.
3. Metadata is merged (list + detail + optional audits) into a single `skills.jsonl` index, written atomically at the end of the run.

## Prerequisites

The API requires a **Vercel OIDC token**; any Vercel project works:

```bash
npm i -g vercel
vercel link        # link to any of your Vercel projects
vercel env pull    # writes VERCEL_OIDC_TOKEN into .env.local (valid ~12h)
```

The script reads `VERCEL_OIDC_TOKEN` from the environment, falling back to `.env.local` in the current directory. Tokens expire after ~12 hours (HTTP 401) — re-run `vercel env pull` to refresh. Never commit `.env.local`.

## Usage

```bash
node scraper.mjs                          # full scrape into ./data
node scraper.mjs --limit 20               # fetch details for the first 20 skills only (quick end-to-end check)
node scraper.mjs --out ./data             # custom output directory
node scraper.mjs --audits                 # also fetch security audit results (doubles the request count)
node scraper.mjs --skip-duplicates        # don't fetch content of isDuplicate skills (metadata still recorded)
```

A full scrape is ~8,400 detail requests; at the API's 600 req/min rate limit expect roughly 15–30 minutes (double with `--audits`). Re-running is safe: content from previous runs is reused, so an interrupted scrape resumes where it stopped. The process exits non-zero if any skill failed; failures are logged to stderr.

## Output

```
data/
├── skills.jsonl                              # the single metadata index (one row per skill, installs desc)
└── skills/
    ├── vercel-labs/skills/find-skills/       # github skills: owner/repo/slug
    │   ├── SKILL.md                          # pure skill files — nothing else; copy the
    │   └── scripts/run.sh                    #   directory straight into an agent's skills folder
    └── mintlify.com/mintlify/                # well-known skills: domain/slug
        └── SKILL.md
```

One `skills.jsonl` line (pretty-printed here):

```json
{"id":"vercel-labs/skills/find-skills","slug":"find-skills","name":"find-skills","source":"vercel-labs/skills","sourceType":"github","installs":12345,"installUrl":"npx skills add vercel-labs/skills/find-skills","url":"https://skills.sh/vercel-labs/skills/find-skills","hash":"…","contentSaved":true,"fetchedAt":"2026-09-05T…","audits":[…]}
```

Row fields: the leaderboard object (`id`, `slug`, `name`, `source`, `sourceType`, `installs`, `installUrl`, `url`, optional `isDuplicate`) plus:

| Field | Meaning |
|---|---|
| `hash` | SHA-256 of the skill's file contents (from the detail endpoint); `null` if unknown |
| `contentSaved` | `true` if the skill's files are on disk under `skills/` |
| `noSnapshot` | present when skills.sh has no file snapshot for the skill (`contentSaved` is then `false`) |
| `fetchedAt` | when the content was last fetched from the API |
| `audits` | with `--audits`: array of partner audit results (`provider`, `status`, `riskLevel`, …); `[]` means nobody audited it yet |

## Consuming the data

```bash
# install a skill into an agent — the directory is the skill
cp -r data/skills/vercel-labs/skills/find-skills ~/.agents/skills/

# full-text search across all skills
grep -r "pattern" data/skills --include=SKILL.md

# ranking / filtering
jq -s 'sort_by(-.installs)[:20] | map(.id)' data/skills.jsonl
jq -c 'select(.audits[]?.status == "fail") | .id' data/skills.jsonl
```

## Rate limits & errors

The API allows 600 requests/min per (team, project). The script paces itself at 590/min with a rolling window and concurrency of 10, and retries `429`/`503` responses honoring `Retry-After` as well as transient network errors.

## Verification

Three layers, each answering a different question. All of them run identically locally and in CI.

| Layer | Answers | Needs | Command |
|---|---|---|---|
| 1. Offline tests | Is the scraper logic correct? | nothing (mock API) | `npm test` |
| 2. Artifact verifier | Is a scraped dataset intact? | nothing (no network) | `node verify.mjs --out data` |
| 3. Real API run | Does the live API still behave? | Vercel OIDC token | `node scraper.mjs --limit 5 && node verify.mjs` |

`verify.mjs` checks a dataset against the scraper's invariants: every JSONL line parses, ids are unique, rows are sorted by installs desc, fields are well-formed (`hash` is 64-hex or null, `audits` is an array, …), `contentSaved` matches the on-disk directories exactly, `noSnapshot` rows have no content, no `_meta.json`/`.tmp` junk survives. It is the gate before any dataset is trusted or uploaded.

### Local

```bash
npm test                                   # fast, no secrets
vercel link && vercel env pull             # once; refresh the token every ~12h
npm run scrape && npm run verify           # full scrape + integrity check
```

### GitHub Actions

- **`ci.yml`** (push / PR): layer 1 on Node 22 and 24. No secrets involved, so it also runs on fork PRs.
- **`fetch-skills.yml`** (daily 02:00 UTC + manual): layer 3 as a daily canary. It mints a fresh OIDC token from secrets (the OIDC token expires every ~12h, so it must never be stored — only the long-lived `VERCEL_TOKEN` is), runs offline tests first, scrapes everything, proves resume works on real data (a second run must report `saved=0`), runs `verify.mjs`, and only then uploads two artifacts: `skills-jsonl-*` (index) and `skills-content-*` (full mirror, 14-day retention).

Repository secrets required: `VERCEL_TOKEN` (Vercel personal access token), `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — copy the last two from `.vercel/project.json` after a local `vercel link`.

## Notes

- Re-run semantics: a skill's content is fetched when its directory doesn't exist; metadata and audits are always refreshed from the current run's leaderboard. Skills dropped from skills.sh disappear from `skills.jsonl` on the next run (their content directories stay on disk).
- `--skip-duplicates` still records metadata for `isDuplicate` rows (forks/copies of other skills); only their file download is skipped. Flip the flag later and re-run to backfill.
- Skills without an upstream snapshot are marked `noSnapshot` and never re-requested.
- Path segments are sanitized (`.`/`..` → `_`, non-URL-safe chars → `_`) so ids can never escape the output directory.
- This replaces the earlier v1 layout (`skills.json` array + per-directory `_meta.json`); those files are no longer produced.
- Chinese documentation: [README.zh-CN.md](README.zh-CN.md).
