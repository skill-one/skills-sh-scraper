# skills.sh data mirror

A daily-updated mirror of every skill on [skills.sh](https://www.skills.sh): leaderboard metadata plus full file contents.

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide (run / verify / extend): [DEVELOPING.md](DEVELOPING.md)

## Where the data is

Published daily to the [`dist` branch](../../tree/dist): one commit per day, the newest 5 kept. Each commit is a full snapshot — `skills.jsonl` (index, ~1 MB of rows) plus `skills/` (all skill files):

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-scraper.git   # latest snapshot
git log dist                                                                      # browse recent daily snapshots
```

Or produce it yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).

## What's in the data

```
data/
├── skills.jsonl   one row per saved skill, sorted by installs desc (ties by id) — query / filter / rank here
└── skills/        one directory per skill — read / copy files here
    ├── vercel-labs__skills__find-skills/     skill id with "/" → "__"
    │   └── SKILL.md
    └── mintlify.com__mintlify/              (GitHub: {owner}__{repo}__{slug} · well-known: {domain}__{slug})
        └── SKILL.md
```

A skill directory contains exactly the files the upstream skill ships — copy it straight into an agent's skills folder. The index and the content directories match exactly — a row exists if and only if its directory exists — and a directory that exists is complete. Both are integrity-checked after every run.

`skills.jsonl` rows carry the skills.sh leaderboard fields (`id`, `slug`, `name`, `source`, `sourceType`, `installs`, `installUrl`, `url`) plus:

| Field | Meaning |
|---|---|
| `hash` | SHA-256 of the skill's files; `null` if unknown |
| `fetchedAt` | when the current content version was first fetched; carried over while the hash is unchanged (content itself is re-downloaded every run) |
| `audits` | with `--audits`: partner audit results (`provider`, `status`, `riskLevel`, …); `[]` = none yet. Reused while the content hash is unchanged, re-fetched when it changes |

Skills left out of the index: duplicates (`isDuplicate` on the leaderboard) and skills with no upstream file snapshot. A skill whose fetch failed keeps its previous snapshot — index row plus content directory — until a later run fetches it again; skills never fetched successfully are left out. All of them are retried every run; the run log counts them as `dropped` / `failed` (previously saved ones as `carried over`).

## Using the data

```bash
cp -r data/skills/vercel-labs__skills__find-skills ~/.agents/skills/   # a skill directory is the skill
grep -r "pattern" data/skills --include=SKILL.md                     # full-text search
jq -s 'sort_by(-.installs)[:20] | map(.id)' data/skills.jsonl        # top 20 by installs
jq -c 'select(.audits[]?.status == "fail") | .id' data/skills.jsonl  # failed partner audits
```
