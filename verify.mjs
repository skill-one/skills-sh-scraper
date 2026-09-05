#!/usr/bin/env node
/**
 * Verify the integrity of a scraped dataset — no network, no token.
 *
 * Checks skills.jsonl + content directories against the scraper's invariants:
 *   - every line parses; ids unique; rows sorted by installs desc (ties by id)
 *   - required fields well-formed (id, sourceType, installs, fetchedAt, hash,
 *     audits)
 *   - no two rows share a sanitized directory name
 *   - rows and content directories match exactly, in both directions: every
 *     row has a non-empty directory (its files mirror the upstream skill
 *     verbatim, including files like _meta.json that skills may ship) and
 *     every directory belongs to a row
 *   - no .tmp / skills.jsonl.tmp leftovers from interrupted runs
 *
 * Usage: node verify.mjs [--out data]
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { argValue, dirName, exists } from "./lib.mjs";

const args = process.argv.slice(2);
const OUT_DIR = argValue(args, "--out") ?? "data";
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
  if (row.fetchedAt !== null && !isIso(row.fetchedAt)) problem(`${label}: bad fetchedAt`);
  if (row.hash !== null && !isHash(row.hash)) problem(`${label}: bad hash`);
  if ("audits" in row && !Array.isArray(row.audits)) problem(`${label}: audits must be an array`);
  return label;
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
    if (rows[i - 1].installs < rows[i].installs) problem(`rows not sorted by installs desc at ${rows[i].id}`);
    else if (rows[i - 1].installs === rows[i].installs && rows[i - 1].id > rows[i].id)
      problem(`equal-installs rows not sorted by id at ${rows[i].id}`);
  }

  // Rows and directories must match exactly, in both directions.
  const rowNames = new Map();
  for (const row of rows) {
    const label = checkRow(row);
    if (typeof row.id !== "string") continue;
    const name = dirName(row.id);
    if (rowNames.has(name)) problem(`${label}: directory name collides with another row (${rowNames.get(name)})`);
    rowNames.set(name, row.id);
    const dir = path.join(OUT_DIR, "skills", name);
    if (!(await exists(dir))) {
      problem(`${label}: index row has no content directory`);
      continue;
    }
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    if (!entries.some((e) => e.isFile())) problem(`${label}: content directory is empty`);
    dirCount++;
  }
  const skillDirs = await readdir(path.join(OUT_DIR, "skills"), { withFileTypes: true }).catch(() => null);
  if (skillDirs) {
    for (const entry of skillDirs) {
      if (entry.isDirectory() && !rowNames.has(entry.name)) problem(`orphan content directory (no index row): ${entry.name}`);
    }
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
