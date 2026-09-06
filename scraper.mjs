#!/usr/bin/env node
/**
 * Scrape all skills from skills.sh and save them locally.
 *
 * Zero dependencies (Node >= 22). Auth: a Vercel OIDC token in VERCEL_OIDC_TOKEN
 * (env var, or .env.local produced by `vercel env pull`) for skills.sh, and a
 * GitHub token in GITHUB_TOKEN for star counts — see DEVELOPING.md.
 *
 * Only github-sourced skills (sourceType "github") are mirrored; well-known
 * sources have no repository to attribute. Each index row records the stars
 * of the skill's repository (owner/repo = the id's first two segments).
 *
 * Output shape:
 *   data/skills.jsonl                       index: one row per github-sourced
 *                                           skill whose files are on disk
 *   data/trending.json                      the trending view's first 100
 *                                           github-sourced ids, in upstream
 *                                           rank order
 *   data/curated.json                       the official curated partners and
 *                                           their skills' ids, verbatim
 *                                           grouping
 *   data/skills/{owner}/{repo}/{slug}/      pure skill files, nothing else
 *                                           (mirrors the id segment by segment)
 *   data/stats.json                         this run's stats: timing, entry
 *                                           counts, failed ids
 *
 * The index lists exactly the skills with content on disk: one row if and
 * only if the skill's directory exists. Duplicate skills and skills without
 * an upstream snapshot are left out (and retried on the next run). A skill
 * whose fetch fails keeps its previous snapshot — index row and content
 * directory — until a later run fetches it again; skills never fetched
 * successfully stay out of the index. A skill that disappears from the
 * leaderboard is removed from the index along with its content directory
 * (full runs; limited runs carry every unevaluated row over instead).
 * The final summary counts all of these outcomes.
 *
 * Usage:
 *   node scraper.mjs                    # full scrape into ./data
 *   node scraper.mjs --limit 20         # fetch details for the first 20 skills
 *                                       # only; the rest of a previous index is
 *                                       # carried over, so this is safe to run
 *                                       # against an existing dataset
 *   node scraper.mjs --out ./data       # custom output directory
 *   node scraper.mjs --audits           # also fetch security audit results
 *
 * Content is fully re-downloaded and rewritten on every run; the previous
 * skills.jsonl only pins fetchedAt: while a skill's upstream hash is
 * unchanged it keeps the fetchedAt of the run that first fetched that
 * content version.
 *
 * Safe to re-run: interrupted scrapes resume, and upstream edits are picked
 * up on the next run.
 */

import { mkdir, readdir, readFile, rename, rmdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { argValue, canonicalId, dirName, exists, githubRepoOf, safeSegment, skillDescription } from "./lib.mjs";

const API_BASE = (process.env.SKILLS_API_BASE ?? "https://skills.sh").replace(/\/+$/, "");
const GITHUB_API_BASE = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/+$/, "");
const args = process.argv.slice(2);
const OUT_DIR = argValue(args, "--out") ?? "data";
const DETAIL_LIMIT = argValue(args, "--limit") ? Number(argValue(args, "--limit")) : Infinity;
const WANT_AUDITS = args.includes("--audits");
const CONCURRENCY = 10; // request budget shared by both API clients
const startedAt = new Date();

// repo -> stargazers_count, filled by the stars phase and read by fetchSkill.
const repoStars = new Map();

// Tokens come from the environment or .env.local. A missing token is fatal.
async function loadEnvToken(name, hint) {
  if (process.env[name]) return process.env[name];
  try {
    const env = await readFile(".env.local", "utf8");
    const line = env.split("\n").find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {}
  console.error(`Missing ${name}.\n${hint}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rolling 60s window limiter, kept just under each host's documented limit.
const makeLimiter = (ratePerMin) => {
  const sentAt = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift();
      if (sentAt.length < ratePerMin) {
        sentAt.push(now);
        return;
      }
      await sleep(sentAt[0] + 60_000 - now + 20);
    }
  };
};

// One API client per host: shared concurrency budget, rolling-window rate
// limit, retries for transient failures (429/5xx honoring Retry-After, up to
// 8 attempts); deterministic 4xx are never retried.
const makeApiGet = ({ base, token, ratePerMin, headers = {}, unauthorizedMessage }) => {
  const nextSlot = makeLimiter(ratePerMin);
  return async function apiGet(pathname, { allow404 = false } = {}) {
    const url = `${base}${pathname}`;
    for (let attempt = 1; ; attempt++) {
      await nextSlot();
      let res;
      try {
        res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (attempt >= 5) {
          throw new Error(`network error after ${attempt} tries: ${err.cause?.code ?? err.message} (${url})`);
        }
        await sleep(1000 * attempt);
        continue;
      }
      // 429/5xx are transient (honor Retry-After; 1s otherwise). 4xx are NOT
      // retried: they are deterministic.
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        const header = res.headers.get("retry-after");
        const sec = header === null ? 1 : Number(header);
        await res.text().catch(() => {});
        await sleep((Number.isFinite(sec) ? sec : 1) * 1000);
        continue;
      }
      if (res.status === 404 && allow404) {
        await res.text().catch(() => {});
        return null;
      }
      if (res.status === 401) throw new Error(unauthorizedMessage);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
      return res.json();
    }
  };
};

// Ids are "owner/repo/slug" (github) or "domain/slug" (well-known), already
// normalized to skills.sh's canonical form (slug slashes stripped, see
// canonicalId in lib.mjs). Directory names are derived in lib.mjs; `encId`
// percent-encodes each segment for URLs.
const encId = (id) => id.split("/").map(encodeURIComponent).join("/");
const skillDir = (id) => path.join(OUT_DIR, "skills", dirName(id));

async function fetchLeaderboard(api) {
  const skills = [];
  const seen = new Set();
  let nonGithub = 0;
  for (let page = 0; ; page++) {
    const { data, pagination } = await api(`/api/v1/skills?per_page=500&page=${page}`);
    // The leaderboard can drift while we paginate (entries shifting across
    // page boundaries), serving the same id twice; keep the first occurrence.
    // Ids are normalized to skills.sh's canonical form first, so a raw and a
    // canonical occurrence of the same skill collapse into one entry too.
    // Only github-sourced skills are mirrored: well-known sources have no
    // repository to attribute (and no stars to fetch).
    for (const skill of data ?? []) {
      if (skill.sourceType !== "github") {
        nonGithub++;
        continue;
      }
      const id = canonicalId(skill);
      if (!seen.has(id)) {
        seen.add(id);
        skills.push({ ...skill, id });
      }
    }
    console.error(`  leaderboard: ${skills.length}/${pagination.total} (page ${page})`);
    if (!pagination.hasMore || !data?.length) return { skills, nonGithub };
  }
}

// Trending and curated skill entries carry per-skill fields the index
// deliberately drops (installs, url, and the redundant display data slug,
// name, source, sourceType, installUrl). Only the canonical id survives —
// the join key back into skills.jsonl.

// The trending view's first 100 github-sourced skills (documented as
// view=trending), a single per_page=200 request — deep enough that its first
// 100 github-sourced entries cover the top-100 cutoff even after well-known
// entries are skipped (like at the leaderboard). Ids are normalized to
// skills.sh's canonical form (see canonicalId in lib.mjs) and kept in
// upstream rank order.
const TRENDING_COUNT = 100;
async function fetchTrending(api) {
  const { data } = await api(`/api/v1/skills?view=trending&per_page=${TRENDING_COUNT * 2}`);
  const ids = [];
  const seen = new Set();
  let nonGithub = 0;
  for (const skill of data ?? []) {
    if (skill.sourceType !== "github") {
      nonGithub++;
      continue;
    }
    const id = canonicalId(skill);
    if (!seen.has(id)) {
      seen.add(id);
      if (ids.length < TRENDING_COUNT) ids.push(id);
    }
  }
  return { ids, nonGithub };
}

// The curated view: officially featured skills grouped by owner, with the
// owner's aggregate installs and featured repo/skill plus top-level counts
// and the list's generation timestamp — all unique to this endpoint, kept
// verbatim. Per-skill entries are reduced to their canonical ids. No source
// filtering: the list is curated upstream.
async function fetchCurated(api) {
  const raw = await api("/api/v1/skills/curated");
  return {
    generatedAt: raw.generatedAt ?? null,
    totalOwners: raw.totalOwners ?? null,
    totalSkills: raw.totalSkills ?? null,
    data: (raw.data ?? []).map((owner) => ({
      owner: owner.owner,
      totalInstalls: owner.totalInstalls,
      featuredRepo: owner.featuredRepo ?? null,
      featuredSkill: owner.featuredSkill ?? null,
      skills: (owner.skills ?? []).map(canonicalId),
    })),
  };
}

// Previous run's index drives resume: for skills whose directory is already
// on disk it remembers hash/fetchedAt/audits without re-fetching them.
async function loadPrevIndex() {
  try {
    const text = await readFile(path.join(OUT_DIR, "skills.jsonl"), "utf8");
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return new Map(rows.map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

// Returns the index row for the skill, or null when the skill is left out of
// the index: duplicates (stale content removed too) and skills without an
// upstream snapshot. Fetch errors propagate to the worker, which also leaves
// the skill out (retry on the next run).
//
// Content is fully re-downloaded and rewritten on every run. The previous row
// only pins fetchedAt: while the upstream hash is unchanged, fetchedAt keeps
// describing when that content version was first fetched.
async function fetchSkill(skill, prev) {
  const dir = skillDir(skill.id);
  if (skill.isDuplicate) {
    await rm(dir, { recursive: true, force: true });
    return null;
  }

  const detail = await skillsApi(`/api/v1/skills/${encId(skill.id)}`);
  if (!Array.isArray(detail.files) || !detail.files.length) {
    return null; // no upstream snapshot; retried next run
  }
  const skillMd = detail.files.find((f) => f.path === "SKILL.md");

  const dirExists = await exists(dir);
  // Write to a temp dir and swap it in via rename(2), so "directory exists"
  // implies "complete". The old content is parked inside .tmp first because
  // rename(2) cannot replace a non-empty directory; if the swap fails it is
  // restored, and a crash in the tiny window between the two renames leaves
  // recoverable content in .tmp (flagged by the leftover check in verify.mjs).
  const tmp = path.join(OUT_DIR, ".tmp", dirName(skill.id));
  const parked = path.join(OUT_DIR, ".tmp", "old", dirName(skill.id));
  await rm(tmp, { recursive: true, force: true });
  for (const file of detail.files) {
    const target = path.join(tmp, ...file.path.split("/").map(safeSegment));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents ?? "");
  }
  await mkdir(path.dirname(dir), { recursive: true });
  if (dirExists) {
    await mkdir(path.dirname(parked), { recursive: true });
    await rename(dir, parked);
    try {
      await rename(tmp, dir);
    } catch (err) {
      await rename(parked, dir); // swap failed: put the old content back
      throw err;
    }
    await rm(parked, { recursive: true, force: true });
  } else {
    await rename(tmp, dir);
  }

  const unchanged = !!detail.hash && detail.hash === prev?.hash;
  // Only the fields not derivable elsewhere: the id encodes source and slug
  // (the directory layout mirrors it), the rest of the leaderboard payload
  // (name, source, sourceType, installUrl) is redundant display data. Stars
  // come from the per-repo fetch: the previous value covers a repo whose
  // star request failed this run.
  const repo = githubRepoOf(skill);
  const row = {
    id: skill.id,
    installs: skill.installs,
    stars: repoStars.get(repo) ?? prev?.stars ?? null,
    url: skill.url,
    description: skillDescription(skillMd?.contents),
    hash: detail.hash ?? null,
    fetchedAt: unchanged && prev.fetchedAt ? prev.fetchedAt : new Date().toISOString(),
  };
  await maybeAttachAudits(row, prev, unchanged);
  return row;
}

// With --audits, attach partner audit results. They are re-fetched whenever
// the skill's content changed (or on the first fetch); while the hash is
// unchanged the previous results are reused without a request. A failed audit
// request keeps the previous results; 404 = nobody audited the skill yet.
async function maybeAttachAudits(row, prev, unchanged) {
  if (!WANT_AUDITS) return;
  if (prev?.audits !== undefined && unchanged) {
    row.audits = prev.audits;
    return;
  }
  const raw = await skillsApi(`/api/v1/skills/audit/${encId(row.id)}`, { allow404: true }).catch((err) => {
    console.error(`  WARN audits ${row.id}: ${err.message}`);
    return undefined;
  });
  if (raw !== undefined) row.audits = raw?.audits ?? [];
  else if (prev?.audits !== undefined) row.audits = prev.audits;
}

const skillsToken = await loadEnvToken(
  "VERCEL_OIDC_TOKEN",
  "Get one with:  npm i -g vercel && vercel link && vercel env pull\n" +
    "(the token lasts ~12h), or export VERCEL_OIDC_TOKEN yourself. See DEVELOPING.md.",
);
const githubToken = await loadEnvToken(
  "GITHUB_TOKEN",
  "Create one at https://github.com/settings/tokens (public repo read access is enough),\n" +
    "then export GITHUB_TOKEN or add it to .env.local. In GitHub Actions the built-in\n" +
    "secrets.GITHUB_TOKEN works. See DEVELOPING.md.",
);
const skillsApi = makeApiGet({
  base: API_BASE,
  token: skillsToken,
  ratePerMin: 590, // skills.sh documents 600 req/min per (team, project)
  unauthorizedMessage: "HTTP 401 — VERCEL_OIDC_TOKEN missing/expired; re-run `vercel env pull`",
});
const githubApi = makeApiGet({
  base: GITHUB_API_BASE,
  token: githubToken,
  ratePerMin: 80, // GitHub REST: 5000 req/hr authenticated
  headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  unauthorizedMessage: "HTTP 401 — GITHUB_TOKEN missing/expired",
});
await rm(path.join(OUT_DIR, ".tmp"), { recursive: true, force: true });
await mkdir(path.join(OUT_DIR, "skills"), { recursive: true });

console.error(`[1/5] Fetching leaderboard from ${API_BASE} ...`);
const { skills, nonGithub } = await fetchLeaderboard(skillsApi);
const prevIndex = await loadPrevIndex();

console.error(`[2/5] Fetching trending top ${TRENDING_COUNT} (github-sourced) from ${API_BASE} ...`);
const { ids: trending, nonGithub: trendingNonGithub } = await fetchTrending(skillsApi);
// Written atomically, like the index; independent of the rest of the run.
const trendingPath = path.join(OUT_DIR, "trending.json");
await writeFile(`${trendingPath}.tmp`, JSON.stringify(trending, null, 2) + "\n");
await rename(`${trendingPath}.tmp`, trendingPath);
console.error(`  trending: ${trending.length}${trendingNonGithub ? ` (${trendingNonGithub} non-github skipped)` : ""}`);

console.error(`[3/5] Fetching curated skills from ${API_BASE} ...`);
const curated = await fetchCurated(skillsApi);
const curatedPath = path.join(OUT_DIR, "curated.json");
await writeFile(`${curatedPath}.tmp`, JSON.stringify(curated, null, 2) + "\n");
await rename(`${curatedPath}.tmp`, curatedPath);
console.error(`  curated: ${curated.data.length} owners / ${curated.totalSkills} skills`);

const targets = Number.isFinite(DETAIL_LIMIT) ? skills.slice(0, DETAIL_LIMIT) : skills;

// Stars are per repository, and skills cluster on shared repos: one request
// per unique repo instead of per skill. A 404 (deleted/renamed-away repo)
// pins stars to null; any other failure just skips the repo, and rows fall
// back to the previous run's value (or null on first fetch).
const repos = [...new Set(targets.map(githubRepoOf).filter(Boolean))];
console.error(`[4/5] Fetching stars for ${repos.length} repositories from ${GITHUB_API_BASE} ...`);
let reposDone = 0;
let repoIndex = 0;
const starWorker = async () => {
  while (repoIndex < repos.length) {
    const repo = repos[repoIndex++];
    const data = await githubApi(`/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, { allow404: true }).catch(
      (err) => {
        console.error(`  WARN stars ${repo}: ${err.message}`);
        return undefined;
      },
    );
    if (data !== undefined) repoStars.set(repo, data?.stargazers_count ?? null);
    if (++reposDone % 200 === 0 || reposDone === repos.length) {
      console.error(`  stars: ${reposDone}/${repos.length}`);
    }
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, starWorker));

console.error(`[5/5] Fetching content for ${targets.length} skills${WANT_AUDITS ? " + audits" : ""} ...`);

const rows = [];
let index = 0;
let done = 0;
let changed = 0;
let added = 0;
let dropped = 0;
let carried = 0;
const failed = [];
const worker = async () => {
  while (index < targets.length) {
    const skill = targets[index++];
    const prev = prevIndex.get(skill.id);
    try {
      const row = await fetchSkill(skill, prev);
      if (row) {
        rows.push(row);
        // fetchedAt is re-stamped exactly when the content version changed
        // (first fetch or a new upstream hash), so it doubles as the
        // run's change count. Every fetched row absent from the previous
        // index is a skill newly listed upstream.
        if (row.fetchedAt !== prev?.fetchedAt) changed++;
        if (!prevIndex.has(skill.id)) added++;
      } else dropped++;
    } catch (err) {
      // Per-skill failures (bad upstream ids, dead repos) don't fail the run:
      // the skill is retried on the next run. Its previous snapshot, if any,
      // stays on disk, so keep the matching index row — index and content
      // directories keep matching, and the mirror keeps serving the last good
      // content. Skills never fetched successfully stay out of the index.
      // Only systemic failures (leaderboard, auth, index write) abort the
      // process with a non-zero exit code.
      failed.push(skill.id);
      console.error(`  FAIL ${skill.id}: ${err.message}`);
      if (prev && (await exists(skillDir(skill.id)))) {
        rows.push(prev);
        carried++;
      }
    }
    if (++done % 100 === 0 || done === targets.length) {
      console.error(`  details: ${done}/${targets.length} (changed ${changed}, dropped ${dropped}, failed ${failed.length})`);
    }
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

// With --limit, skills outside the limit were not evaluated this run, but
// their content is still on disk. Carry their previous rows over so the
// index keeps describing every content directory (a limited run must not
// shrink the index and orphan the rest); the next full run re-evaluates
// them. Full runs evaluate every skill, so this is a no-op for them and
// they remain the ones that drop rows for skills no longer listed.
if (targets.length < skills.length) {
  const evaluated = new Set(targets.map((s) => s.id));
  for (const [id, prev] of prevIndex) {
    if (!evaluated.has(id) && (await exists(skillDir(id)))) {
      rows.push(prev);
      carried++;
    }
  }
}

// Skills in the previous index that the current leaderboard no longer lists
// (full runs only — limited runs carry every unevaluated row over, so they
// never remove anything). Drop their content directories too, so the
// "row if and only if directory" invariant keeps holding.
const indexed = new Set(rows.map((r) => r.id));
const removed = [...prevIndex.keys()].filter((id) => !indexed.has(id));
for (const id of removed) await rm(skillDir(id), { recursive: true, force: true });

// Sort by installs desc, ties by id: workers finish out of order, so the row
// order would otherwise be nondeterministic and daily snapshots would differ
// even without real changes. Written atomically so the index is never
// half-updated.
const byRank = (a, b) => b.installs - a.installs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const indexPath = path.join(OUT_DIR, "skills.jsonl");
const tmpIndex = `${indexPath}.tmp`;
await writeFile(tmpIndex, rows.sort(byRank).map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
await rename(tmpIndex, indexPath);
await rm(path.join(OUT_DIR, ".tmp"), { recursive: true, force: true });

// Prune directories left empty by dropped skills (git drops empty dirs on
// publish, but the local tree stays tidy). Bottom-up: rmdir fails harmlessly
// while a directory is still non-empty, so only empty branches disappear.
async function pruneEmpty(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) if (entry.isDirectory()) await pruneEmpty(path.join(dir, entry.name));
  await rmdir(dir).catch(() => {});
}
await pruneEmpty(path.join(OUT_DIR, "skills"));

// Run stats, published alongside the dataset. Only fields a human (or a
// consumer) cannot trivially derive: run configuration, timing, and the
// outcome counters — including `changed`, the rows whose `fetchedAt` was
// re-stamped because their content version changed.
const finishedAt = new Date();
const stats = {
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  limit: Number.isFinite(DETAIL_LIMIT) ? DETAIL_LIMIT : null,
  audits: WANT_AUDITS,
  leaderboardTotal: skills.length,
  nonGithub,
  githubRepos: repos.length,
  indexedRows: rows.length,
  changed,
  added,
  removed: removed.length,
  dropped,
  failed: failed.length,
  carriedOver: carried,
  failedIds: failed,
};
const statsPath = path.join(OUT_DIR, "stats.json");
await writeFile(`${statsPath}.tmp`, JSON.stringify(stats, null, 2) + "\n");
await rename(`${statsPath}.tmp`, statsPath);

console.error(`Done: changed=${changed}, added=${added}, removed=${removed.length}, dropped=${dropped}, failed=${failed.length} (carried over: ${carried}) -> ${OUT_DIR}/`);
// Machine-readable numbers live in ${OUT_DIR}/stats.json (written above).
