# skills.sh data mirror

A daily snapshot of every skill on [skills.sh](https://www.skills.sh): the leaderboard as a queryable index (`skills.jsonl`) plus each skill's full files (`skills/`).

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide (run / verify / extend): [DEVELOPING.md](DEVELOPING.md)

## What the data is

```
├── skills.jsonl   one row per skill, sorted by installs desc — query / filter / rank here
├── stats.json     the producing run's stats (counts, changes, failed ids)
└── skills/        one directory per skill, named after its id
    └── vercel-labs/skills/find-skills/   (GitHub: {owner}/{repo}/{slug} · well-known: {domain}/{slug})
        └── SKILL.md
```

Each `skills.jsonl` row:

```json
{
  "id": "vercel-labs/skills/find-skills",
  "installs": 3263512,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "description": "Find and install skills for your agent from skills.sh",
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  "fetchedAt": "2026-09-05T08:26:00.682Z"
}
```

| Field | Meaning |
|---|---|
| `id`, `installs`, `url` | from the skills.sh leaderboard (the id encodes source and slug) |
| `description` | from the skill's `SKILL.md` frontmatter; `null` if it has none |
| `hash` | SHA-256 of the skill's files; `null` if unknown |
| `fetchedAt` | when the current content version was first fetched |
| `audits` | with `--audits`: partner audit results (`provider`, `status`, `riskLevel`, …); `[]` = none yet |

Two guarantees, integrity-checked after every run:

- A skill directory contains exactly the files the upstream skill ships — copy it straight into an agent's skills folder.
- The index and `skills/` match exactly: a row exists if and only if its directory exists, and a directory is always complete.

Edge cases (failed fetches, `--limit` runs, delisted skills) are covered in [DEVELOPING.md](DEVELOPING.md).

## How to get the data

Published daily to the [`dist` branch](../../tree/dist) — each commit is a complete snapshot at the branch root.

Most consumers only need a file or two, so fetch them straight from the branch — no clone, no auth:

```bash
# the index: one row per skill, sorted by installs — filter it to find ids
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills.jsonl

# then any file of a skill, by its id: dist/skills/<id>/<filename>
curl -sO https://raw.githubusercontent.com/skill-one/skills-sh-scraper/dist/skills/vercel-labs/skills/find-skills/SKILL.md
```

GitHub serves these with a ~5-minute cache, so the `dist` URLs always track the latest snapshot.

Pinned to a day — each of the newest 5 snapshots is also tagged `dist-<date>`. The tag name is deliberately slash-free: `dist/<date>` in a raw URL is ambiguous with the `dist` branch and fails to resolve. Tags are immutable, so this is cache-friendly: cache by tag and re-fetch only when a newer day appears.

```bash
# resolve the newest available tag, then swap it into any URL above
latest=$(git ls-remote --tags https://github.com/skill-one/skills-sh-scraper.git 'dist-*' \
         | awk -F/ '{print $NF}' | sort -V | tail -1)
curl -sO "https://raw.githubusercontent.com/skill-one/skills-sh-scraper/$latest/skills.jsonl"
```

Or clone the whole snapshot when you want everything or need it offline:

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git
# pinned to a day: git clone --depth 1 -b "$latest" https://github.com/skill-one/skills-sh-scraper.git
```

Or produce it yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).
