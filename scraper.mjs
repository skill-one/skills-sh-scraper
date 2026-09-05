#!/usr/bin/env node
/**
 * Scrape all skills from skills.sh and save them locally.
 *
 * Zero dependencies (Node >= 22). Auth: Vercel OIDC token in VERCEL_OIDC_TOKEN
 * (env var, or .env.local produced by `vercel env pull`) — see DEVELOPING.md.
 *
 * Output shape:
 *   data/skills.jsonl                       index: one row per skill whose
 *                                           files are on disk under skills/
 *   data/skills/{owner}__{repo}__{slug}/    pure skill files, nothing else
 *
 * The index lists exactly the skills with content on disk: one row if and
 * only if the skill's directory exists. Duplicate skills, skills without an
 * upstream snapshot, and skills whose fetch failed are left out (and retried
 * on the next run); the final summary counts them.
 *
 * Usage:
 *   node scraper.mjs                    # full scrape into ./data
 *   node scraper.mjs --limit 20         # fetch details for the first 20 skills only
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

import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = (process.env.SKILLS_API_BASE ?? "https://skills.sh").replace(/\/+$/, "");
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const OUT_DIR = argValue("--out") ?? "data";
const DETAIL_LIMIT = argValue("--limit") ? Number(argValue("--limit")) : Infinity;
const WANT_AUDITS = args.includes("--audits");
const CONCURRENCY = 10; // API rate limit is 600 req/min per (team, project)

async function loadToken() {
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN;
  try {
    const env = await readFile(".env.local", "utf8");
    const line = env.split("\n").find((l) => l.startsWith("VERCEL_OIDC_TOKEN="));
    if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {}
  console.error(
    "Missing VERCEL_OIDC_TOKEN.\n" +
      "Get one with:  npm i -g vercel && vercel link && vercel env pull\n" +
      "(the token lasts ~12h), or export VERCEL_OIDC_TOKEN yourself. See DEVELOPING.md.",
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rolling 60s window, just under the documented 600 req/min limit.
const RATE_PER_MIN = 590;
const sentAt = [];
async function nextSlot() {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift();
    if (sentAt.length < RATE_PER_MIN) {
      sentAt.push(now);
      return;
    }
    await sleep(sentAt[0] + 60_000 - now + 20);
  }
}

async function apiGet(pathname, token, { allow404 = false } = {}) {
  const url = `${API_BASE}${pathname}`;
  for (let attempt = 1; ; attempt++) {
    await nextSlot();
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt >= 5) {
        throw new Error(`network error after ${attempt} tries: ${err.cause?.code ?? err.message} (${url})`);
      }
      await sleep(1000 * attempt);
      continue;
    }
    if ((res.status === 429 || res.status === 503) && attempt < 8) {
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
    if (res.status === 401) {
      throw new Error("HTTP 401 — VERCEL_OIDC_TOKEN missing/expired; re-run `vercel env pull`");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.json();
  }
}

// Ids are "owner/repo/slug" (github) or "domain/slug" (well-known); file paths
// are relative. Each segment is mapped to a filesystem-safe name ("." and ".."
// become "_") and the segments are joined with "__", so one skill is exactly
// one directory that can never escape the output directory.
const safeSegment = (s) => (s === "." || s === ".." ? "_" : s.replace(/[^\w.-]/g, "_"));
const encId = (id) => id.split("/").map(encodeURIComponent).join("/");
const skillDir = (id) => path.join(OUT_DIR, "skills", id.split("/").map(safeSegment).join("__"));
const exists = (p) => access(p).then(() => true, () => false);

async function fetchLeaderboard(token) {
  const skills = [];
  const seen = new Set();
  for (let page = 0; ; page++) {
    const { data, pagination } = await apiGet(`/api/v1/skills?per_page=500&page=${page}`, token);
    // The leaderboard can drift while we paginate (entries shifting across
    // page boundaries), serving the same id twice; keep the first occurrence.
    for (const skill of data ?? []) {
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        skills.push(skill);
      }
    }
    console.error(`  leaderboard: ${skills.length}/${pagination.total} (page ${page})`);
    if (!pagination.hasMore || !data?.length) return skills;
  }
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

// Returns { row, action } for the index. row is null when the skill is left
// out of the index: duplicates (stale content removed too) and skills without
// an upstream snapshot. Fetch errors propagate to the worker, which also
// leaves the skill out (retry on the next run).
//
// Content is fully re-downloaded and rewritten on every run. The previous row
// only pins fetchedAt: while the upstream hash is unchanged, fetchedAt keeps
// describing when that content version was first fetched.
async function fetchSkill(skill, prev, token) {
  const dir = skillDir(skill.id);
  if (skill.isDuplicate) {
    await rm(dir, { recursive: true, force: true });
    return { row: null, action: "dropped" };
  }

  const detail = await apiGet(`/api/v1/skills/${encId(skill.id)}`, token);
  if (!Array.isArray(detail.files) || !detail.files.length) {
    return { row: null, action: "dropped" }; // no upstream snapshot; retried next run
  }

  const dirExists = await exists(dir);
  // Write to a temp dir and rename, so "directory exists" implies "complete".
  // An outdated directory has to be removed first (rename(2) cannot replace a
  // non-empty directory); a crash in that window leaves the row without
  // content, which the next run simply re-fetches.
  if (dirExists) await rm(dir, { recursive: true, force: true });
  const tmp = path.join(OUT_DIR, ".tmp", ...skill.id.split("/").map(safeSegment));
  await rm(tmp, { recursive: true, force: true });
  for (const file of detail.files) {
    const target = path.join(tmp, ...file.path.split("/").map(safeSegment));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents ?? "");
  }
  await mkdir(path.dirname(dir), { recursive: true });
  await rename(tmp, dir);

  const unchanged = !!detail.hash && detail.hash === prev?.hash;
  const row = {
    ...skill,
    hash: detail.hash ?? null,
    fetchedAt: unchanged && prev.fetchedAt ? prev.fetchedAt : new Date().toISOString(),
  };
  await maybeAttachAudits(row, prev, token);
  return { row, action: dirExists ? "updated" : "saved" };
}

// With --audits, attach partner audit results unless the previous row already
// has them (404 = nobody audited the skill yet -> empty array).
async function maybeAttachAudits(row, prev, token) {
  if (!WANT_AUDITS || prev?.audits !== undefined) return;
  const raw = await apiGet(`/api/v1/skills/audit/${encId(row.id)}`, token, { allow404: true }).catch((err) => {
    console.error(`  WARN audits ${row.id}: ${err.message}`);
    return undefined;
  });
  if (raw !== undefined) row.audits = raw?.audits ?? [];
}

const token = await loadToken();
await rm(path.join(OUT_DIR, ".tmp"), { recursive: true, force: true });
await mkdir(path.join(OUT_DIR, "skills"), { recursive: true });

console.error(`[1/2] Fetching leaderboard from ${API_BASE} ...`);
const skills = await fetchLeaderboard(token);
const prevIndex = await loadPrevIndex();

const targets = Number.isFinite(DETAIL_LIMIT) ? skills.slice(0, DETAIL_LIMIT) : skills;
console.error(`[2/2] Fetching content for ${targets.length} skills${WANT_AUDITS ? " + audits" : ""} ...`);

const rows = [];
let index = 0;
let done = 0;
let saved = 0;
let updated = 0;
let dropped = 0;
const failed = [];
const worker = async () => {
  while (index < targets.length) {
    const skill = targets[index++];
    try {
      const { row, action } = await fetchSkill(skill, prevIndex.get(skill.id), token);
      if (row) rows.push(row);
      if (action === "saved") saved++;
      else if (action === "updated") updated++;
      else dropped++;
    } catch (err) {
      // Per-skill failures (bad upstream ids, dead repos) don't fail the run:
      // the skill is left out of the index and retried on the next run. Only
      // systemic failures (leaderboard, auth, index write) abort the process
      // with a non-zero exit code.
      failed.push(skill.id);
      console.error(`  FAIL ${skill.id}: ${err.message}`);
    }
    if (++done % 100 === 0 || done === targets.length) {
      console.error(`  details: ${done}/${targets.length} (saved ${saved}, updated ${updated}, dropped ${dropped}, failed ${failed.length})`);
    }
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

// Sort by installs desc: workers finish out of order, so the index row order
// would otherwise be nondeterministic. Skills no longer listed are dropped.
// Written atomically so the index is never half-updated.
const indexPath = path.join(OUT_DIR, "skills.jsonl");
const tmpIndex = `${indexPath}.tmp`;
await writeFile(tmpIndex, rows.sort((a, b) => b.installs - a.installs).map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
await rename(tmpIndex, indexPath);
await rm(path.join(OUT_DIR, ".tmp"), { recursive: true, force: true });

console.error(`Done: saved=${saved}, updated=${updated}, dropped=${dropped}, failed=${failed.length} -> ${OUT_DIR}/`);
