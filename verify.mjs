#!/usr/bin/env node
/**
 * Verify the integrity of a scraped dataset — no network, no token.
 *
 * Checks skills.jsonl + content directories against the scraper's invariants:
 *   - every line parses; ids unique; rows sorted by installs desc
 *   - required fields well-formed (id, sourceType, installs, contentSaved,
 *     fetchedAt, hash, audits)
 *   - noSnapshot rows have contentSaved=false, no hash and no directory
 *   - contentSaved matches the on-disk directory exactly
 *   - content directories are non-empty (their files mirror the upstream
 *     skill verbatim, including files like _meta.json that skills may ship)
 *   - no .tmp / skills.jsonl.tmp leftovers from interrupted runs
 *
 * Usage: node verify.mjs [--out data]
 */

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const OUT_DIR = argValue("--out") ?? "data";

// Must match scraper.mjs exactly.
const safeSegment = (s) => (s === "." || s === ".." ? "_" : s.replace(/[^\w.-]/g, "_"));
const skillDir = (id) => path.join(OUT_DIR, "skills", id.split("/").map(safeSegment).join("__"));

const exists = (p) => access(p).then(() => true, () => false);
const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

const problems = [];
const problem = (msg) => problems.push(msg);

function checkRow(row) {
  const id = row.id;
  const label = typeof id === "string" ? id : "(missing id)";
  // Ids are source/slug; slugs may themselves contain "/" (4+ segments exist).
  if (typeof id !== "string" || id.split("/").filter((s) => s.length).length < 2) problem(`${label}: malformed id`);
  if (!["github", "well-known"].includes(row.sourceType)) problem(`${label}: bad sourceType ${JSON.stringify(row.sourceType)}`);
  if (!Number.isFinite(row.installs) || row.installs < 0) problem(`${label}: bad installs`);
  if (typeof row.contentSaved !== "boolean") problem(`${label}: contentSaved must be a boolean`);
  if (row.fetchedAt !== null && !isIso(row.fetchedAt)) problem(`${label}: bad fetchedAt`);
  if (row.hash !== null && !isHash(row.hash)) problem(`${label}: bad hash`);
  if ("audits" in row && !Array.isArray(row.audits)) problem(`${label}: audits must be an array`);
  if ("error" in row && typeof row.error !== "string") problem(`${label}: error must be a string`);
  if (row.noSnapshot) {
    if (row.contentSaved !== false) problem(`${label}: noSnapshot but contentSaved=true`);
    if (row.hash !== null) problem(`${label}: noSnapshot but hash set`);
  }
  return label;
}

async function checkContentDir(row, label) {
  const dir = skillDir(row.id);
  const dirExists = await exists(dir);
  if (dirExists !== row.contentSaved) {
    problem(`${label}: contentSaved=${row.contentSaved} but directory ${dirExists ? "exists" : "missing"}`);
    return false;
  }
  if (!dirExists) return false;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  if (!files.length) problem(`${label}: content directory is empty`);
  return true;
}

let dirCount = 0;
let rowCount = 0;
const text = await readFile(path.join(OUT_DIR, "skills.jsonl"), "utf8").catch(() => null);
if (text === null) {
  problem(`skills.jsonl not found under ${OUT_DIR}`);
} else {
  const rows = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      problem(`line ${i + 1}: invalid JSON`);
    }
  }
  rowCount = rows.length;
  if (!rows.length) problem("index has no rows");

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) problem(`duplicate id: ${row.id}`);
    seen.add(row.id);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].installs < rows[i].installs) {
      problem(`rows not sorted by installs desc at ${rows[i].id}`);
      break;
    }
  }
  for (const row of rows) {
    const label = checkRow(row);
    if (typeof row.id === "string" && (await checkContentDir(row, label))) dirCount++;
  }
  if (await exists(path.join(OUT_DIR, ".tmp"))) problem(".tmp leftover from an interrupted run");
  if (await exists(path.join(OUT_DIR, "skills.jsonl.tmp"))) problem("skills.jsonl.tmp leftover from an interrupted run");
}

if (problems.length) {
  for (const msg of problems.slice(0, 20)) console.error(`FAIL ${msg}`);
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  console.error(`verify: ${problems.length} problem(s) in ${OUT_DIR}`);
  process.exit(1);
}
console.log(`OK: ${rowCount} rows, ${dirCount} content directories, 0 problems (${OUT_DIR})`);
