#!/usr/bin/env node
/**
 * Scrape all skills from skills.sh and save them locally.
 *
 * Zero dependencies (Node >= 22). Auth: Vercel OIDC token in VERCEL_OIDC_TOKEN
 * (env var, or .env.local produced by `vercel env pull`) — see DEVELOPING.md.
 *
 * Output shape:
 *   data/skills.jsonl                       one metadata row per skill (the single index)
 *   data/skills/{owner}__{repo}__{slug}/    pure skill files, nothing else
 *
 * Usage:
 *   node scraper.mjs                    # full scrape into ./data
 *   node scraper.mjs --limit 20         # fetch details for the first 20 skills only
 *   node scraper.mjs --out ./data       # custom output directory
 *   node scraper.mjs --audits           # also fetch security audit results
 *   node scraper.mjs --skip-duplicates  # don't fetch content of isDuplicate skills
 *
 * Safe to re-run: content from a previous run is reused (resume state comes
 * from skills.jsonl + the content directories), so interrupted scrapes resume.
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
const SKIP_DUPLICATES = args.includes("--skip-duplicates");
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
  for (let page = 0; ; page++) {
    const { data, pagination } = await apiGet(`/api/v1/skills?per_page=500&page=${page}`, token);
    skills.push(...(data ?? []));
    console.error(`  leaderboard: ${skills.length}/${pagination.total} (page ${page})`);
    if (!pagination.hasMore || !data?.length) return skills;
  }
}

// Previous run's index drives resume: it knows which skills had a snapshot.
async function loadPrevIndex() {
  try {
    const text = await readFile(path.join(OUT_DIR, "skills.jsonl"), "utf8");
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return new Map(rows.map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

async function fetchSkill(skill, prev, token) {
  const dir = skillDir(skill.id);
  const dirExists = await exists(dir);
  let hash = prev?.hash ?? null;
  let fetchedAt = prev?.fetchedAt ?? null;
  let contentSaved = dirExists;
  let noSnapshot = prev?.noSnapshot ?? false;
  let action = "skipped";

  const needContent = !dirExists && !noSnapshot && !(SKIP_DUPLICATES && skill.isDuplicate);
  if (needContent) {
    const detail = await apiGet(`/api/v1/skills/${encId(skill.id)}`, token);
    hash = detail.hash ?? null;
    fetchedAt = new Date().toISOString();
    if (Array.isArray(detail.files) && detail.files.length) {
      // Write to a temp dir and rename, so "directory exists" implies "complete".
      const tmp = path.join(OUT_DIR, ".tmp", ...skill.id.split("/").map(safeSegment));
      await rm(tmp, { recursive: true, force: true });
      for (const file of detail.files) {
        const target = path.join(tmp, ...file.path.split("/").map(safeSegment));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.contents ?? "");
      }
      await mkdir(path.dirname(dir), { recursive: true });
      await rename(tmp, dir);
      contentSaved = true;
      action = "saved";
    } else {
      noSnapshot = true; // no upstream snapshot; skip it on future runs too
    }
  }

  let audits;
  if (WANT_AUDITS && prev?.audits === undefined) {
    const raw = await apiGet(`/api/v1/skills/audit/${encId(skill.id)}`, token, { allow404: true }).catch((err) => {
      console.error(`  WARN audits ${skill.id}: ${err.message}`);
      return undefined;
    });
    if (raw !== undefined) audits = raw?.audits ?? []; // 404 = nobody audited yet
  }

  const row = { ...skill, hash, contentSaved, fetchedAt };
  if (noSnapshot) row.noSnapshot = true;
  if (audits !== undefined) row.audits = audits;
  return { row, action };
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
let reused = 0;
const failed = [];
const worker = async () => {
  while (index < targets.length) {
    const skill = targets[index++];
    const prev = prevIndex.get(skill.id);
    try {
      const { row, action } = await fetchSkill(skill, prev, token);
      rows.push(row);
      action === "saved" ? saved++ : reused++;
    } catch (err) {
      // Per-skill failures (bad upstream ids, dead repos) don't fail the run:
      // they are recorded on the row, retried on the next run, and stay
      // queryable in the index. Only systemic failures (leaderboard, auth,
      // index write) abort the process with a non-zero exit code.
      failed.push(skill.id);
      console.error(`  FAIL ${skill.id}: ${err.message}`);
      rows.push({
        ...skill,
        hash: prev?.hash ?? null,
        contentSaved: prev?.contentSaved ?? false,
        fetchedAt: prev?.fetchedAt ?? null,
        error: err.message,
        ...(prev?.noSnapshot && { noSnapshot: true }),
        ...(prev?.audits !== undefined && { audits: prev.audits }),
      });
    }
    if (++done % 100 === 0 || done === targets.length) {
      console.error(`  details: ${done}/${targets.length} (saved ${saved}, reused ${reused}, failed ${failed.length})`);
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

console.error(`Done: saved=${saved}, reused=${reused}, failed=${failed.length} -> ${OUT_DIR}/`);
