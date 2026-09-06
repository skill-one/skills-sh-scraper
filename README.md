# skills.sh data mirror

A daily-updated mirror of every skill on [skills.sh](https://www.skills.sh): leaderboard metadata plus full file contents.

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide (run / verify / extend): [DEVELOPING.md](DEVELOPING.md)

## Where the data is

Published daily to the [`dist` branch](../../tree/dist): one commit per day, the newest 5 kept. Each commit is a full snapshot at the branch root — `skills.jsonl` (index, ~1 MB of rows) plus `skills/` (all skill files) — and each retained snapshot is also tagged `dist/<date>` (the tag window mirrors the 5 kept commits):

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git           # latest snapshot
git clone --depth 1 -b dist/2026-09-06 https://github.com/skill-one/skills-sh-scraper.git # pin a specific day
git ls-remote --tags https://github.com/skill-one/skills-sh-scraper.git 'dist/*'          # list available days
git log dist                                                                              # browse recent daily snapshots
```

Or produce it yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).

## What's in the data

```
├── skills.jsonl   one row per saved skill, sorted by installs desc (ties by id) — query / filter / rank here
├── stats.json     the producing run's stats — entry counts, changes, failed ids
└── skills/        one directory per skill — read / copy files here
    ├── vercel-labs/skills/find-skills/     the skill id, one directory level per "/"
    │   └── SKILL.md
    └── mintlify.com/mintlify/              (GitHub: {owner}/{repo}/{slug} · well-known: {domain}/{slug})
        └── SKILL.md
```

Locally the scraper writes this into `data/` (`node scraper.mjs`); on the `dist` branch it sits at the branch root.

A skill directory contains exactly the files the upstream skill ships — copy it straight into an agent's skills folder. The index and the content directories match exactly — a row exists if and only if its directory exists — and a directory that exists is complete. Both are integrity-checked after every run.

Each `skills.jsonl` row carries `id`, `installs` and `url` from the skills.sh leaderboard (the other leaderboard fields are redundant: the id already encodes source and slug) plus:

| Field | Meaning |
|---|---|
| `description` | taken from the skill's `SKILL.md` frontmatter; `null` if it has none |
| `hash` | SHA-256 of the skill's files; `null` if unknown |
| `fetchedAt` | when the current content version was first fetched; carried over while the hash is unchanged (content itself is re-downloaded every run) |
| `audits` | with `--audits`: partner audit results (`provider`, `status`, `riskLevel`, …); `[]` = none yet. Reused while the content hash is unchanged, re-fetched when it changes |

Skills left out of the index: duplicates (`isDuplicate` on the leaderboard) and skills with no upstream file snapshot. A skill whose fetch failed keeps its previous snapshot — index row plus content directory — until a later run fetches it again; skills never fetched successfully are left out. All of them are retried every run. A skill that disappears from the leaderboard is removed from the index together with its content directory — on full runs; a limited run carries every unevaluated row over instead. Rows kept from the previous index count as `carried over`: a failed fetch, or — with `--limit` — a skill outside the limit, whose content is still on disk.

`stats.json` summarizes the run that produced the snapshot (only fields not trivially derivable from the others):

| Field | Meaning |
|---|---|
| `startedAt`, `finishedAt` | when the run started / ended (`durationMs` is their difference) |
| `limit`, `audits` | run configuration (`limit` is `null` for a full scrape) |
| `leaderboardTotal` | unique leaderboard entries after deduplication |
| `indexedRows` | lines in `skills.jsonl` |
| `changed` | rows whose content version changed this run (first fetch or a new upstream hash) — exactly the rows whose `fetchedAt` was re-stamped |
| `added`, `removed` | skills entering / leaving the index: newly listed upstream, and no longer listed (the row and its content directory are deleted; full runs only — limited runs carry every unevaluated row over) |
| `dropped`, `failed`, `carriedOver` | outcome counters; `failedIds` lists the failed skill ids |

## Using the data

```bash
cp -r skills/vercel-labs/skills/find-skills ~/.agents/skills/   # a skill directory is the skill
grep -r "pattern" skills --include=SKILL.md                     # full-text search
jq -s 'sort_by(-.installs)[:20] | map(.id)' skills.jsonl        # top 20 by installs
jq -c 'select(.audits[]?.status == "fail") | .id' skills.jsonl  # failed partner audits
```
