// End-to-end test: runs scraper.mjs against a local mock of the skills.sh API.
// No real token, no network. Covers: pagination (with leaderboard drift),
// skills.jsonl index shape (only saved skills — duplicates and no-snapshot
// skills are omitted; skills whose fetch failed keep their previous row and
// content), pure content directories, path sanitization, SKILL.md description
// extraction (plain / quoted / folded block scalars; absent -> null), full
// re-write every run with fetchedAt pinned to the content hash via the previous index,
// .env.local token loading, 429/5xx retry (Retry-After honored), --audits (kept
// while the hash is unchanged, re-fetched when it changes), --limit carrying
// over rows outside the limit so a limited run never orphans content,
// deterministic installs-desc/id-asc row order, per-run stats in stats.json
// (timing, counters for changed/added/removed rows, failed ids), upstream
// delisting (row and content directory removed) and re-listing, slug-with-
// slash ids normalized to skills.sh's canonical (slash-stripped) form, and
// verifier rejection of tampered datasets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalId } from "./lib.mjs";

const SCRAPER = fileURLToPath(new URL("./scraper.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));

// Realistic content hashes (64-hex) so the verifier's format check passes.
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

// find-skills content is revision-controlled so tests can simulate upstream edits.
const findSkillsFiles = (rev) => [
  { path: "SKILL.md", contents: `---
name: find-skills
description: Find skills on skills.sh.
---
# find-skills rev ${rev}
Find skills on skills.sh.
` },
  { path: "scripts/run.sh", contents: "#!/bin/sh\necho find-skills\n" },
  { path: "_meta.json", contents: "{}\n" }, // some skills ship their own _meta.json
];
let findSkillsRev = 0;

const FILES = {
  "mintlify.com/mintlify": [{ path: "SKILL.md", contents: "# mintlify\nWell-known skill.\n" }], // no frontmatter
  "owner/repo/wei rd~x": [{ path: "SKILL.md", contents: '---\ndescription: "weird but quoted"\n---\n# weird slug\n' }],
  "owner/repo/dup-skill": [{ path: "SKILL.md", contents: "# duplicate\n" }],
  "owner/repo/flaky-500": [{ path: "SKILL.md", contents: "---\ndescription: >-\n  fetched after a\n  transient 500\n---\n# flaky\n" }], // detail 500s once, then succeeds
  "owner/repo/rate-limited": null, // no upstream snapshot: hash null, files null
  "owner/repo/bad-id": [{ path: "SKILL.md", contents: "# bad-id\n" }], // detail 400s while badIdBroken
  // canonical form: the raw leaderboard id is claude-office-skills/skills/facebook/meta-ads
  "claude-office-skills/skills/facebookmeta-ads": [{ path: "SKILL.md", contents: "---\nname: Facebook Meta Ads\ndescription: slash slug normalized\n---\n# fb\n" }],
};

// "bad-id" rejects the detail request outright until repaired — used to test
// that a failed fetch carries over the previous snapshot on the next run.
let badIdBroken = true;

// Ids hidden from the leaderboard — simulates upstream delisting / re-listing.
// The slash-slug skill starts hidden so it only joins in run 12.
const gone = new Set(["claude-office-skills/skills/facebook/meta-ads"]);

const filesFor = (id) => (id === "vercel-labs/skills/find-skills" ? findSkillsFiles(findSkillsRev) : FILES[id]);

const AUDITS = {
  "vercel-labs/skills/find-skills": [
    { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", auditedAt: "2026-09-01T00:00:00.000Z", riskLevel: "LOW" },
  ],
};

const SKILLS = [
  { id: "vercel-labs/skills/find-skills", slug: "find-skills", name: "find-skills", source: "vercel-labs/skills", installs: 12345, sourceType: "github", installUrl: "npx skills add vercel-labs/skills/find-skills", url: "https://skills.sh/vercel-labs/skills/find-skills" },
  { id: "mintlify.com/mintlify", slug: "mintlify", name: "mintlify", source: "mintlify.com", installs: 99, sourceType: "well-known", installUrl: "npx skills add mintlify.com/mintlify", url: "https://skills.sh/mintlify.com/mintlify" },
  // installs ties with mintlify (both 99): exercises the id tiebreak — the
  // expected order below is the id-ascending one.
  { id: "owner/repo/wei rd~x", slug: "wei rd~x", name: "weird", source: "owner/repo", installs: 99, sourceType: "github", installUrl: "npx skills add owner/repo/wei rd~x", url: "https://skills.sh/owner/repo/wei rd~x" },
  { id: "owner/repo/flaky-500", slug: "flaky-500", name: "flaky", source: "owner/repo", installs: 50, sourceType: "github", installUrl: "npx skills add owner/repo/flaky-500", url: "https://skills.sh/owner/repo/flaky-500" },
  { id: "owner/repo/dup-skill", slug: "dup-skill", name: "dup", source: "owner/repo", installs: 2, sourceType: "github", installUrl: "npx skills add owner/repo/dup-skill", url: "https://skills.sh/owner/repo/dup-skill", isDuplicate: true },
  { id: "owner/repo/rate-limited", slug: "rate-limited", name: "rl", source: "owner/repo", installs: 1, sourceType: "github", installUrl: "npx skills add owner/repo/rate-limited", url: "https://skills.sh/owner/repo/rate-limited" },
  { id: "owner/repo/bad-id", slug: "bad-id", name: "bad", source: "owner/repo", installs: 0, sourceType: "github", installUrl: "npx skills add owner/repo/bad-id", url: "https://skills.sh/owner/repo/bad-id" },
  // raw leaderboard id carries a slash inside the slug (4 segments); skills.sh
  // keys this skill by the slug with the "/" stripped
  { id: "claude-office-skills/skills/facebook/meta-ads", slug: "facebook/meta-ads", name: "facebook", source: "claude-office-skills/skills", installs: 7, sourceType: "github", installUrl: "npx skills add claude-office-skills/skills/facebook/meta-ads", url: "https://skills.sh/claude-office-skills/skills/facebookmeta-ads" },
];

test("scraper end-to-end against mock API", async () => {
  const hits = { list: 0, detail: 0, audit: 0, rateLimited: 0, flaky500: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/skills") {
      hits.list++;
      const page = Number(url.searchParams.get("page") ?? 0);
      const listed = SKILLS.filter((s) => !gone.has(s.id));
      const data = listed.slice(page * 3, page * 3 + 3);
      if (page === 1) data.push(SKILLS[0]); // leaderboard drift: same id served on two pages
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data, pagination: { page, perPage: 500, total: listed.length, hasMore: (page + 1) * 3 < listed.length } }));
      return;
    }
    if (url.pathname.startsWith("/api/v1/skills/audit/")) {
      hits.audit++;
      const id = decodeURIComponent(url.pathname.slice("/api/v1/skills/audit/".length));
      if (!AUDITS[id]) {
        res.statusCode = 404; // nobody audited this skill yet
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.end(JSON.stringify({ id, source: "vercel-labs/skills", slug: "find-skills", audits: AUDITS[id] }));
      return;
    }
    const id = decodeURIComponent(url.pathname.slice("/api/v1/skills/".length));
    // The detail API only addresses skills.sh's canonical ids (slug slashes
    // stripped): a request for the raw form is not found.
    const skill = SKILLS.find((s) => canonicalId(s.id, s.sourceType) === id);
    if (!skill) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    hits.detail++;
    if (id === "owner/repo/bad-id" && badIdBroken) {
      res.statusCode = 400; // permanently broken upstream id (while badIdBroken)
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    if (id === "owner/repo/flaky-500" && hits.flaky500++ === 0) {
      res.statusCode = 500; // transient upstream failure: the retry succeeds
      res.end(JSON.stringify({ error: "internal" }));
      return;
    }
    if (id === "owner/repo/rate-limited" && hits.rateLimited++ === 0) {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end("rate limited");
      return;
    }
    const files = filesFor(id);
    res.setHeader("content-type", "application/json");
    // The hash covers the content: bumping findSkillsRev changes exactly one
    // skill's upstream hash, the others' hashes stay stable across runs.
    const hash = files ? (id === "vercel-labs/skills/find-skills" ? hashOf(`${id}:${findSkillsRev}`) : hashOf(id)) : null;
    res.end(JSON.stringify({ id: skill.id, source: skill.source, slug: skill.slug, installs: skill.installs, hash, files }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const workDir = await mkdtemp(path.join(tmpdir(), "skills-scraper-test-"));
  const out1 = path.join(workDir, "data1");
  const out2 = path.join(workDir, "data2");
  // Token with quotes exercises the .env.local parsing (quote stripping).
  await writeFile(path.join(workDir, ".env.local"), 'VERCEL_OIDC_TOKEN="mock-token"\n');

  // Async spawn: the scraper fetches from the mock server hosted in THIS
  // process, so a synchronous spawnSync would deadlock its event loop.
  const run = async (out, flags = []) => {
    const env = { ...process.env, SKILLS_API_BASE: base };
    delete env.VERCEL_OIDC_TOKEN; // force the .env.local fallback
    const child = spawn(process.execPath, [SCRAPER, "--out", out, ...flags], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    return { status: code, stderr };
  };

  const readRows = async (out) => (await readFile(path.join(out, "skills.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const readStats = async (out) => JSON.parse(await readFile(path.join(out, "stats.json"), "utf8"));
  const pathExists = (p) => access(p).then(() => true, () => false);
  const dir = (out, ...p) => path.join(out, "skills", ...p);

  try {
    // --- run 1: default scrape saves everything saveable; the index holds
    // only the saved skills (dup / no-snapshot / failed are left out)
    const r1 = await run(out1);
    assert.equal(r1.status, 0, `run 1 failed:\n${r1.stderr}`);
    assert.equal(hits.list, 3); // 7 skills, 3 per mock page
    assert.equal(hits.detail, 8); // 6 skills attempted (the duplicate is never fetched) + one 429 retry + one 500 retry
    assert.equal(hits.audit, 0); // flag off -> no audit requests

    const rows1 = await readRows(out1);
    assert.deepEqual(
      rows1.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "mintlify.com/mintlify", "owner/repo/wei rd~x", "owner/repo/flaky-500"], // installs desc; dup, no-snapshot and failed skills omitted
    );
    assert.equal(rows1[0].installs, 12345);
    assert.equal(rows1[0].hash, hashOf("vercel-labs/skills/find-skills:0"));
    assert.ok(rows1[0].fetchedAt);
    assert.equal("audits" in rows1[0], false);
    // redundant leaderboard fields are not carried into the index
    for (const field of ["contentSaved", "noSnapshot", "error", "slug", "name", "source", "sourceType", "installUrl"])
      assert.equal(field in rows1[0], false);

    // description comes from the SKILL.md frontmatter (all four shapes)
    assert.equal(rows1[0].description, "Find skills on skills.sh."); // plain scalar
    assert.equal(rows1[1].description, null); // no frontmatter
    assert.equal(rows1[2].description, "weird but quoted"); // quoted scalar
    assert.equal(rows1[3].description, "fetched after a transient 500"); // folded block scalar

    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "scripts", "run.sh"), "utf8"),
      findSkillsFiles(0)[1].contents,
    );
    // content dirs contain ONLY skill files (upstream-shipped _meta.json is legit)
    assert.deepEqual((await readdir(dir(out1, "vercel-labs/skills/find-skills"))).sort(), ["SKILL.md", "_meta.json", "scripts"]);
    // well-known source: domain/slug directory
    assert.equal(await readFile(dir(out1, "mintlify.com/mintlify", "SKILL.md"), "utf8"), FILES["mintlify.com/mintlify"][0].contents);
    // unsafe slug characters are sanitized in directory names
    assert.equal(await readFile(dir(out1, "owner/repo/wei_rd_x", "SKILL.md"), "utf8"), FILES["owner/repo/wei rd~x"][0].contents);
    // the transient 500 was retried into a save
    assert.equal(await readFile(dir(out1, "owner/repo/flaky-500", "SKILL.md"), "utf8"), FILES["owner/repo/flaky-500"][0].contents);
    // duplicate / no-snapshot / failed skills leave nothing on disk
    assert.equal(await pathExists(dir(out1, "owner/repo/dup-skill")), false);
    assert.equal(await pathExists(dir(out1, "owner/repo/rate-limited")), false);
    assert.equal(await pathExists(dir(out1, "owner/repo/bad-id")), false);
    assert.match(r1.stderr, /changed=4, added=4, removed=0, dropped=2, failed=1/); // run still exits 0
    // no temp leftovers
    assert.equal(await pathExists(path.join(out1, ".tmp")), false);

    // stats.json describes this run: timing, entry counts, failed ids
    const stats1 = await readStats(out1);
    assert.equal(stats1.limit, null); // no --limit: full scrape
    assert.equal(stats1.audits, false);
    assert.ok(!Number.isNaN(Date.parse(stats1.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(stats1.finishedAt)));
    assert.ok(stats1.finishedAt >= stats1.startedAt);
    assert.equal(stats1.leaderboardTotal, 7); // unique leaderboard entries (drift dupe excluded)
    assert.equal(stats1.indexedRows, 4);
    assert.equal(stats1.changed, 4); // every first save re-stamps fetchedAt
    assert.equal(stats1.added, 4); // all four rows are new to the index
    assert.equal(stats1.removed, 0);
    assert.deepEqual(
      { dropped: stats1.dropped, failed: stats1.failed, carriedOver: stats1.carriedOver },
      { dropped: 2, failed: 1, carriedOver: 0 },
    );
    assert.deepEqual(stats1.failedIds, ["owner/repo/bad-id"]);
    assert.equal(stats1.indexedRows, 4);

    // --- run 2: everything is re-fetched and re-written, but while the
    // upstream hash is unchanged each row keeps the fetchedAt of the run
    // that first fetched that content version
    const r2 = await run(out1);
    assert.equal(r2.status, 0, `run 2 failed:\n${r2.stderr}`);
    assert.equal(hits.detail, 14); // +6: the four saves + no-snapshot + failed skill
    assert.equal(hits.audit, 0);
    assert.match(r2.stderr, /changed=0, added=0, removed=0, dropped=2, failed=1/);
    const rows2 = await readRows(out1);
    assert.equal(rows2.length, 4);
    assert.equal((await readStats(out1)).changed, 0); // nothing changed: all hashes stable
    assert.deepEqual(rows2.map((r) => r.fetchedAt), rows1.map((r) => r.fetchedAt)); // carried over
    assert.deepEqual(rows2.map((r) => r.hash), rows1.map((r) => r.hash));
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );

    // --- run 3: upstream edits find-skills -> hash changes, its fetchedAt is
    // re-stamped while the untouched skills keep theirs
    findSkillsRev = 1;
    const r3 = await run(out1);
    assert.equal(r3.status, 0, `run 3 failed:\n${r3.stderr}`);
    assert.equal(hits.detail, 20); // +6
    assert.match(r3.stderr, /changed=1, added=0, removed=0, dropped=2, failed=1/);
    const rows3 = await readRows(out1);
    assert.equal((await readStats(out1)).changed, 1); // exactly the edited skill
    assert.equal(rows3[0].hash, hashOf("vercel-labs/skills/find-skills:1"));
    assert.notEqual(rows3[0].fetchedAt, rows1[0].fetchedAt); // re-stamped for the new content
    assert.deepEqual(rows3.slice(1).map((r) => r.fetchedAt), rows1.slice(1).map((r) => r.fetchedAt)); // unchanged hash -> unchanged fetchedAt
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(1)[0].contents, // new content on disk
    );

    // --- run 4: fresh dir with --audits; stale duplicate content is cleaned up
    await mkdir(dir(out2, "owner/repo/dup-skill"), { recursive: true }); // leftover from an older scrape
    const r4 = await run(out2, ["--audits"]);
    assert.equal(r4.status, 0, `run 4 failed:\n${r4.stderr}`);
    assert.equal(hits.detail, 26); // +6 new fetches (the duplicate is skipped, no 429/500 retry left)
    assert.equal(hits.audit, 4); // only the four saved skills reach the audit call
    assert.match(r4.stderr, /changed=4, added=4, removed=0, dropped=2, failed=1/);

    const rows4 = await readRows(out2);
    assert.equal(stats1.audits, false); // run 1's stats (out1) unaffected by run 4
    assert.equal((await readStats(out2)).audits, true); // --audits recorded
    assert.deepEqual(
      rows4.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "mintlify.com/mintlify", "owner/repo/wei rd~x", "owner/repo/flaky-500"],
    );
    assert.equal(await pathExists(dir(out2, "owner/repo/dup-skill")), false); // stale duplicate content removed
    assert.deepEqual(rows4[0].audits, AUDITS["vercel-labs/skills/find-skills"]);
    assert.deepEqual(rows4[1].audits, []); // audited by nobody -> empty array

    // --- run 5: repairing bad-id lets it save (into out1, where it has
    // never had content)
    badIdBroken = false;
    const r5 = await run(out1);
    assert.equal(r5.status, 0, `run 5 failed:\n${r5.stderr}`);
    assert.match(r5.stderr, /changed=1, added=1, removed=0, dropped=2, failed=0/);
    const rows5 = await readRows(out1);
    assert.deepEqual(rows5.map((r) => r.id), [...rows1.map((r) => r.id), "owner/repo/bad-id"]);
    const stats5 = await readStats(out1);
    assert.equal(stats5.changed, 1); // only the newly saved bad-id
    assert.equal(stats5.added, 1);
    assert.equal(await readFile(dir(out1, "owner/repo/bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 6: bad-id breaks again. Its previous snapshot stays on disk, so
    // the previous index row must be carried over: index and directories keep
    // matching (an orphan directory would fail verify) and the mirror keeps
    // serving the last good content.
    badIdBroken = true;
    const r6 = await run(out1);
    assert.equal(r6.status, 0, `run 6 failed:\n${r6.stderr}`);
    assert.match(r6.stderr, /changed=0, added=0, removed=0, dropped=2, failed=1 \(carried over: 1\)/);
    const stats6 = await readStats(out1);
    assert.equal(stats6.carriedOver, 1); // machine-readable stats replaced the old stderr metrics line
    assert.equal(stats6.changed, 0); // the carried-over row keeps its old fetchedAt
    assert.equal(stats6.indexedRows, 5);
    assert.deepEqual(stats6.failedIds, ["owner/repo/bad-id"]);
    const rows6 = await readRows(out1);
    assert.deepEqual(rows6[4], rows5[4]); // carried over verbatim: same hash, fetchedAt, fields
    assert.equal(await readFile(dir(out1, "owner/repo/bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 7: --limit 1 on an existing dataset. The limit constrains only
    // what is fetched, never the index: skills outside the limit keep their
    // previous rows (their content is still on disk), so the index does not
    // shrink to one row and orphan the rest.
    const r7l = await run(out1, ["--limit", "1"]);
    assert.equal(r7l.status, 0, `run 7 failed:\n${r7l.stderr}`);
    assert.match(r7l.stderr, /changed=0, added=0, removed=0, dropped=0, failed=0 \(carried over: 4\)/);
    assert.deepEqual((await readRows(out1)).map((r) => r.id), rows6.map((r) => r.id));
    const stats7l = await readStats(out1);
    assert.equal(stats7l.limit, 1);
    assert.equal(stats7l.carriedOver, 4);
    assert.equal(stats7l.changed, 0); // the one fetched skill's hash is unchanged
    assert.equal(stats7l.indexedRows, 5);

    // --- run 8 (--audits, out2): unchanged content reuses the previous audit
    // results without any audit request
    const auditHitsAfterRun4 = hits.audit;
    const r8 = await run(out2, ["--audits"]);
    assert.equal(r8.status, 0, `run 8 failed:\n${r8.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4); // no re-fetch while hashes are unchanged
    const rows8 = await readRows(out2);
    assert.deepEqual(rows8[0].audits, AUDITS["vercel-labs/skills/find-skills"]); // kept
    assert.deepEqual(rows8[1].audits, []);

    // --- run 9 (--audits, out2): an upstream edit changes the hash, so that
    // skill's audits are re-fetched; the untouched skills keep theirs
    findSkillsRev = 2;
    const r9 = await run(out2, ["--audits"]);
    assert.equal(r9.status, 0, `run 9 failed:\n${r9.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4 + 1); // exactly the edited skill re-audited
    const rows9 = await readRows(out2);
    assert.equal(rows9[0].hash, hashOf("vercel-labs/skills/find-skills:2"));
    assert.deepEqual(rows9[0].audits, AUDITS["vercel-labs/skills/find-skills"]);

    // --- artifact verifier accepts both datasets (default + audits modes)
    const verify = async (out) => {
      const child = spawn(process.execPath, [VERIFY, "--out", out], { cwd: workDir, env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return { status: code, stdout, stderr };
    };
    const v1 = await verify(out1);
    assert.equal(v1.status, 0, `verify out1 failed:\n${v1.stdout}${v1.stderr}`);
    assert.match(v1.stdout, /OK: 5 rows, 5 content directories/); // bad-id carried over from run 6
    const v2 = await verify(out2);
    assert.equal(v2.status, 0, `verify out2 failed:\n${v2.stdout}${v2.stderr}`);
    assert.match(v2.stdout, /OK: 4 rows, 4 content directories/);

    // --- verifier rejects tampered datasets (problems are reported on stderr)
    // 1. content directory without an index row
    await mkdir(dir(out1, "owner/repo/orphan"), { recursive: true });
    const t1 = await verify(out1);
    assert.equal(t1.status, 1);
    assert.match(t1.stderr, /orphan content directory/);
    await rm(dir(out1, "owner/repo/orphan"), { recursive: true, force: true });
    // 2. index claims content that is gone from disk
    await rm(dir(out1, "vercel-labs/skills/find-skills"), { recursive: true, force: true });
    const t2 = await verify(out1);
    assert.equal(t2.status, 1);
    assert.match(t2.stderr, /no content directory/);
    await mkdir(dir(out1, "vercel-labs/skills/find-skills"), { recursive: true });
    await writeFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "restored\n");
    // 3. index order broken
    const reversed = (await readRows(out1)).reverse();
    await writeFile(path.join(out1, "skills.jsonl"), reversed.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t3 = await verify(out1);
    assert.equal(t3.status, 1);
    assert.match(t3.stderr, /not sorted/);
    await writeFile(path.join(out1, "skills.jsonl"), rows1.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // 4. leftover temp file from an interrupted run
    await writeFile(path.join(out1, "skills.jsonl.tmp"), "{");
    const t4 = await verify(out1);
    assert.equal(t4.status, 1);
    assert.match(t4.stderr, /skills\.jsonl\.tmp/);
    // 5. equal-installs rows out of id order (find-skills ties with mintlify)
    const tied = (await readRows(out1)).map((r, i) => (i === 0 ? { ...r, installs: 99 } : r));
    await writeFile(path.join(out1, "skills.jsonl"), tied.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t5 = await verify(out1);
    assert.equal(t5.status, 1);
    assert.match(t5.stderr, /not sorted by id/);
    // 6. two ids sanitizing to the same directory name
    const colliding = (await readRows(out1)).map((r) => ({ ...r }));
    colliding[1].id = "owner/repo/a b";
    colliding.splice(2, 0, { ...colliding[1], id: "owner/repo/a_b" }); // both -> owner/repo/a_b
    await writeFile(path.join(out1, "skills.jsonl"), colliding.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t6 = await verify(out1);
    assert.equal(t6.status, 1);
    assert.match(t6.stderr, /collides/);
    await writeFile(path.join(out1, "skills.jsonl"), rows6.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // 7. stats.json is unparseable
    await writeFile(path.join(out1, "stats.json"), "{");
    const t7 = await verify(out1);
    assert.equal(t7.status, 1);
    assert.match(t7.stderr, /stats\.json: invalid JSON/);
    // 8. stats.json's indexedRows disagrees with the index
    await writeFile(path.join(out1, "stats.json"), JSON.stringify({ ...stats6, indexedRows: 99 }, null, 2) + "\n");
    const t8 = await verify(out1);
    assert.equal(t8.status, 1);
    assert.match(t8.stderr, /indexedRows 99 != index row count 5/);
    await writeFile(path.join(out1, "stats.json"), JSON.stringify(stats6, null, 2) + "\n");
    // 9. description disagrees with the on-disk SKILL.md
    const mislabeled = (await readRows(out1)).map((r, i) => (i === 0 ? { ...r, description: "bogus" } : r));
    await writeFile(path.join(out1, "skills.jsonl"), mislabeled.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t9 = await verify(out1);
    assert.equal(t9.status, 1);
    assert.match(t9.stderr, /description does not match/);
    await writeFile(path.join(out1, "skills.jsonl"), rows6.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // --- run 10: upstream delists a skill. A full run drops its row AND its
    // content directory (the row-iff-directory invariant must keep holding,
    // otherwise verify would report an orphan directory); the removal shows
    // up in stats.
    gone.add("owner/repo/flaky-500");
    const r10 = await run(out1);
    assert.equal(r10.status, 0, `run 10 failed:\n${r10.stderr}`);
    assert.match(r10.stderr, /changed=1, added=0, removed=1, dropped=2, failed=1 \(carried over: 1\)/);
    const stats10 = await readStats(out1);
    assert.equal(stats10.removed, 1);
    assert.equal(stats10.added, 0);
    assert.deepEqual(
      (await readRows(out1)).map((r) => r.id),
      ["vercel-labs/skills/find-skills", "mintlify.com/mintlify", "owner/repo/wei rd~x", "owner/repo/bad-id"],
    );
    assert.equal(await pathExists(dir(out1, "owner/repo/flaky-500")), false); // delisted content removed
    const v10 = await verify(out1);
    assert.equal(v10.status, 0, `verify out1 failed after removal:\n${v10.stdout}${v10.stderr}`);
    assert.match(v10.stdout, /OK: 4 rows, 4 content directories/);

    // --- run 11: upstream re-lists the skill -> it comes back as added, and
    // changed (a fresh first fetch re-stamps its fetchedAt even though the
    // content hash is the same as before the delisting)
    gone.delete("owner/repo/flaky-500");
    const r11 = await run(out1);
    assert.equal(r11.status, 0, `run 11 failed:\n${r11.stderr}`);
    assert.match(r11.stderr, /changed=1, added=1, removed=0, dropped=2, failed=1 \(carried over: 1\)/);
    const stats11 = await readStats(out1);
    assert.equal(stats11.added, 1);
    assert.equal(stats11.removed, 0);
    assert.deepEqual((await readRows(out1)).map((r) => r.id), [...rows1.map((r) => r.id), "owner/repo/bad-id"]);
    assert.equal(await readFile(dir(out1, "owner/repo/flaky-500", "SKILL.md"), "utf8"), FILES["owner/repo/flaky-500"][0].contents);

    // --- run 12: upstream lists a skill whose slug contains "/" (raw id has
    // 4 segments). skills.sh keys such skills by the slug with the "/" stripped;
    // the scraper normalizes the id to that canonical form, so the detail API
    // can address it and the directory layout mirrors the canonical id.
    gone.delete("claude-office-skills/skills/facebook/meta-ads");
    const r12 = await run(out1);
    assert.equal(r12.status, 0, `run 12 failed:\n${r12.stderr}`);
    assert.match(r12.stderr, /changed=1, added=1, removed=0, dropped=2, failed=1 \(carried over: 1\)/);
    const stats12 = await readStats(out1);
    assert.equal(stats12.added, 1);
    assert.deepEqual(stats12.failedIds, ["owner/repo/bad-id"]); // slash slugs no longer fail
    assert.deepEqual(
      (await readRows(out1)).map((r) => r.id),
      [...rows1.map((r) => r.id), "claude-office-skills/skills/facebookmeta-ads", "owner/repo/bad-id"],
    );
    assert.equal(
      await readFile(dir(out1, "claude-office-skills/skills/facebookmeta-ads", "SKILL.md"), "utf8"),
      FILES["claude-office-skills/skills/facebookmeta-ads"][0].contents,
    );
    assert.equal(await pathExists(dir(out1, "claude-office-skills/skills/facebook")), false); // the raw id never materializes
    const v12 = await verify(out1);
    assert.equal(v12.status, 0, `verify out1 failed after run 12:\n${v12.stdout}${v12.stderr}`);
    assert.match(v12.stdout, /OK: 6 rows, 6 content directories/);
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
