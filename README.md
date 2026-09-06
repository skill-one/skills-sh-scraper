# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh): the leaderboard as a queryable index (`skills.jsonl`) plus each skill's full files (`skills/`). Skills from well-known (domain) sources are not mirrored — they have no repository to attribute.

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide (run / verify / extend): [DEVELOPING.md](DEVELOPING.md)

## What the data is

```
├── skills.jsonl   one row per skill, sorted by installs desc — query / filter / rank here
├── trending.json  the trending view's first 100 GitHub-sourced ids, in rank order
├── curated.json   the officially featured skills' ids, grouped by owner
├── stats.json     the producing run's stats (counts, changes, failed ids)
└── skills/        one directory per skill, named after its id
    └── vercel-labs/skills/find-skills/   ({owner}/{repo}/{slug})
        └── SKILL.md
```

Each `skills.jsonl` row:

```json
{
  "id": "vercel-labs/skills/find-skills",
  "installs": 3263512,
  "stars": 1523,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "description": "Find and install skills for your agent from skills.sh",
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  "fetchedAt": "2026-09-05T08:26:00.682Z"
}
```

| Field | Meaning |
|---|---|
| `id`, `installs`, `url` | from the skills.sh leaderboard (the id encodes source and slug: `{owner}/{repo}/{slug}`) |
| `stars` | the GitHub repository's stargazer count (the id's first two segments); `null` if the repo is gone or the count is unknown |
| `description` | from the skill's `SKILL.md` frontmatter; `null` if it has none |
| `hash` | SHA-256 of the skill's files; `null` if unknown |
| `fetchedAt` | when the current content version was first fetched |
| `audits` | with `--audits`: partner audit results (`provider`, `status`, `riskLevel`, …); `[]` = none yet |

Two guarantees, integrity-checked after every run:

- A skill directory contains exactly the files the upstream skill ships — copy it straight into an agent's skills folder.
- The index and `skills/` match exactly: a row exists if and only if its directory exists, and a directory is always complete.

Edge cases (failed fetches, `--limit` runs, delisted skills) are covered in [DEVELOPING.md](DEVELOPING.md).

`trending.json` is the trending leaderboard's first 100 GitHub-sourced ids, re-fetched on every run from `/api/v1/skills?view=trending&per_page=200` — one request, deep enough that its first 100 GitHub-sourced entries cover the top-100 cutoff after well-known (domain) sources are skipped like at the leaderboard. It is a plain JSON array in upstream rank order — the same canonical id form as the index — so a skill's rank is its array index.

Both files keep only what `skills.jsonl` does not already hold: `trending.json` and the per-owner `skills` arrays in `curated.json` are plain id lists (every per-skill field the index deliberately drops — `installs`, `url`, and the redundant display data `slug`, `name`, `source`, `sourceType`, `installUrl` — is dropped here too), with the same canonical id form as the index. `curated.json` comes from `/api/v1/skills/curated` and additionally keeps what only that endpoint has: per-owner `owner` / `totalInstalls` / `featuredRepo` / `featuredSkill` grouping (no source filtering — the list is curated upstream) and the top-level `totalOwners` / `totalSkills` / `generatedAt`. Upstream may feature the same skill under several owners, so ids can repeat across groups.

## How to get the data

Published daily to the [`dist` branch](../../tree/dist) — each commit is a complete snapshot at the branch root. Two ways in: fetch individual files straight from GitHub, or clone the whole snapshot.

### Fetch individual files

No clone, no auth. Start from the index to find ids, then fetch any skill's files by path:

```bash
# the index: one row per skill, sorted by installs — filter it to find ids
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills.jsonl

# then any file of a skill, by its id: dist/skills/<id>/<filename>
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills/vercel-labs/skills/find-skills/SKILL.md
```

GitHub serves these with a ~5-minute cache, so `dist` URLs always track the latest snapshot.

To pin to a day, swap `dist` for a `dist-<date>` tag (the newest 5 snapshots are tagged). The tag name is deliberately slash-free: `dist/<date>` in a raw URL is ambiguous with the `dist` branch and fails to resolve.

```bash
# resolve the newest available tag, then swap it into any URL above
latest=$(git ls-remote --tags https://github.com/skill-one/skills-sh-scraper.git 'dist-*' \
         | awk -F/ '{print $NF}' | sort -V | tail -1)
curl -sO "https://raw.githubusercontent.com/skill-one/skills-sh-scraper/$latest/skills.jsonl"
```

Tags are immutable, so this is cache-friendly: cache by tag and re-fetch only when a newer day appears.

### Clone the whole snapshot

Get everything in one shot, ready for offline use:

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git
```

To pin to a day, clone the `dist-<date>` tag instead (resolve the newest one as shown above):

```bash
git clone --depth 1 -b "$latest" https://github.com/skill-one/skills-sh-scraper.git
```

Or produce the data yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).
