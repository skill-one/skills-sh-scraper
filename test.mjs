// End-to-end test: runs scraper.mjs against a local mock of the skills.sh API.
// No real token, no network. Covers: pagination (with leaderboard drift),
// skills.jsonl index shape (only saved skills — duplicates and no-snapshot
// skills are omitted; skills whose fetch failed keep their previous row and
// content), pure content directories, path sanitization, full re-write every
// run with fetchedAt pinned to the content hash via the previous index,
// .env.local token loading, 429 retry honoring Retry-After, --audits (kept
// while the hash is unchanged, re-fetched when it changes), deterministic
// installs-desc/id-asc row order, and verifier rejection of tampered datasets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const SCRAPER = fileURLToPath(new URL("./scraper.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));

// Realistic content hashes (64-hex) so the verifier's format check passes.
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

// find-skills content is revision-controlled so tests can simulate upstream edits.
const findSkillsFiles = (rev) => [
  { path: "SKILL.md", contents: `# find-skills rev ${rev}\nFind skills on skills.sh.\n` },
  { path: "scripts/run.sh", contents: "#!/bin/sh\necho find-skills\n" },
  { path: "_meta.json", contents: "{}\n" }, // some skills ship their own _meta.json
];
let findSkillsRev = 0;

const FILES = {
  "mintlify.com/mintlify": [{ path: "SKILL.md", contents: "# mintlify\nWell-known skill.\n" }],
  "owner/repo/wei rd~x": [{ path: "SKILL.md", contents: "# weird slug\n" }],
  "owner/repo/dup-skill": [{ path: "SKILL.md", contents: "# duplicate\n" }],
  "owner/repo/rate-limited": null, // no upstream snapshot: hash null, files null
  "owner/repo/bad-id": [{ path: "SKILL.md", contents: "# bad-id\n" }], // detail 400s while badIdBroken
};

// "bad-id" rejects the detail request outright until repaired — used to test
// that a failed fetch carries over the previous snapshot on the next run.
let badIdBroken = true;

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
  { id: "owner/repo/dup-skill", slug: "dup-skill", name: "dup", source: "owner/repo", installs: 2, sourceType: "github", installUrl: "npx skills add owner/repo/dup-skill", url: "https://skills.sh/owner/repo/dup-skill", isDuplicate: true },
  { id: "owner/repo/rate-limited", slug: "rate-limited", name: "rl", source: "owner/repo", installs: 1, sourceType: "github", installUrl: "npx skills add owner/repo/rate-limited", url: "https://skills.sh/owner/repo/rate-limited" },
  { id: "owner/repo/bad-id", slug: "bad-id", name: "bad", source: "owner/repo", installs: 0, sourceType: "github", installUrl: "npx skills add owner/repo/bad-id", url: "https://skills.sh/owner/repo/bad-id" },
];

test("scraper end-to-end against mock API", async () => {
  const hits = { list: 0, detail: 0, audit: 0, rateLimited: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/skills") {
      hits.list++;
      const page = Number(url.searchParams.get("page") ?? 0);
      const data = SKILLS.slice(page * 3, page * 3 + 3);
      if (page === 1) data.push(SKILLS[0]); // leaderboard drift: same id served on two pages
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data, pagination: { page, perPage: 500, total: SKILLS.length, hasMore: (page + 1) * 3 < SKILLS.length } }));
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
    const skill = SKILLS.find((s) => s.id === id);
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
    const child = spawn(process.execPath, [SCRAPER, "--out", out, "--limit", "6", ...flags], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    return { status: code, stderr };
  };

  const readRows = async (out) => (await readFile(path.join(out, "skills.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const pathExists = (p) => access(p).then(() => true, () => false);
  const dir = (out, ...p) => path.join(out, "skills", ...p);

  try {
    // --- run 1: default scrape saves everything saveable; the index holds
    // only the saved skills (dup / no-snapshot / failed are left out)
    const r1 = await run(out1);
    assert.equal(r1.status, 0, `run 1 failed:\n${r1.stderr}`);
    assert.equal(hits.list, 2); // 6 skills, 3 per mock page
    assert.equal(hits.detail, 6); // 5 skills attempted + one 429 retry; the duplicate is never fetched
    assert.equal(hits.audit, 0); // flag off -> no audit requests

    const rows1 = await readRows(out1);
    assert.deepEqual(
      rows1.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "mintlify.com/mintlify", "owner/repo/wei rd~x"], // installs desc; dup, no-snapshot and failed skills omitted
    );
    assert.equal(rows1[0].installs, 12345);
    assert.equal(rows1[0].hash, hashOf("vercel-labs/skills/find-skills:0"));
    assert.ok(rows1[0].fetchedAt);
    assert.equal("audits" in rows1[0], false);
    for (const gone of ["contentSaved", "noSnapshot", "error"]) assert.equal(gone in rows1[0], false);

    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );
    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "scripts", "run.sh"), "utf8"),
      findSkillsFiles(0)[1].contents,
    );
    // content dirs contain ONLY skill files (upstream-shipped _meta.json is legit)
    assert.deepEqual((await readdir(dir(out1, "vercel-labs__skills__find-skills"))).sort(), ["SKILL.md", "_meta.json", "scripts"]);
    // well-known source: domain__slug directory
    assert.equal(await readFile(dir(out1, "mintlify.com__mintlify", "SKILL.md"), "utf8"), FILES["mintlify.com/mintlify"][0].contents);
    // unsafe slug characters are sanitized in directory names
    assert.equal(await readFile(dir(out1, "owner__repo__wei_rd_x", "SKILL.md"), "utf8"), FILES["owner/repo/wei rd~x"][0].contents);
    // duplicate / no-snapshot / failed skills leave nothing on disk
    assert.equal(await pathExists(dir(out1, "owner__repo__dup-skill")), false);
    assert.equal(await pathExists(dir(out1, "owner__repo__rate-limited")), false);
    assert.equal(await pathExists(dir(out1, "owner__repo__bad-id")), false);
    assert.match(r1.stderr, /saved=3, updated=0, dropped=2, failed=1/); // run still exits 0
    // no temp leftovers
    assert.equal(await pathExists(path.join(out1, ".tmp")), false);

    // --- run 2: everything is re-fetched and re-written, but while the
    // upstream hash is unchanged each row keeps the fetchedAt of the run
    // that first fetched that content version
    const r2 = await run(out1);
    assert.equal(r2.status, 0, `run 2 failed:\n${r2.stderr}`);
    assert.equal(hits.detail, 11); // +5: the three saves + no-snapshot + failed skill
    assert.equal(hits.audit, 0);
    assert.match(r2.stderr, /saved=0, updated=3, dropped=2, failed=1/);
    const rows2 = await readRows(out1);
    assert.equal(rows2.length, 3);
    assert.deepEqual(rows2.map((r) => r.fetchedAt), rows1.map((r) => r.fetchedAt)); // carried over
    assert.deepEqual(rows2.map((r) => r.hash), rows1.map((r) => r.hash));
    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );

    // --- run 3: upstream edits find-skills -> hash changes, its fetchedAt is
    // re-stamped while the untouched skills keep theirs
    findSkillsRev = 1;
    const r3 = await run(out1);
    assert.equal(r3.status, 0, `run 3 failed:\n${r3.stderr}`);
    assert.equal(hits.detail, 16); // +5
    assert.match(r3.stderr, /saved=0, updated=3, dropped=2, failed=1/);
    const rows3 = await readRows(out1);
    assert.equal(rows3[0].hash, hashOf("vercel-labs/skills/find-skills:1"));
    assert.notEqual(rows3[0].fetchedAt, rows1[0].fetchedAt); // re-stamped for the new content
    assert.deepEqual(rows3.slice(1).map((r) => r.fetchedAt), rows1.slice(1).map((r) => r.fetchedAt)); // unchanged hash -> unchanged fetchedAt
    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(1)[0].contents, // new content on disk
    );

    // --- run 4: fresh dir with --audits; stale duplicate content is cleaned up
    await mkdir(dir(out2, "owner__repo__dup-skill"), { recursive: true }); // leftover from an older scrape
    const r4 = await run(out2, ["--audits"]);
    assert.equal(r4.status, 0, `run 4 failed:\n${r4.stderr}`);
    assert.equal(hits.detail, 21); // +5 new fetches (the duplicate is skipped, no 429 retry left)
    assert.equal(hits.audit, 3); // only the three saved skills reach the audit call
    assert.match(r4.stderr, /saved=3, updated=0, dropped=2, failed=1/);

    const rows4 = await readRows(out2);
    assert.deepEqual(
      rows4.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "mintlify.com/mintlify", "owner/repo/wei rd~x"],
    );
    assert.equal(await pathExists(dir(out2, "owner__repo__dup-skill")), false); // stale duplicate content removed
    assert.deepEqual(rows4[0].audits, AUDITS["vercel-labs/skills/find-skills"]);
    assert.deepEqual(rows4[1].audits, []); // audited by nobody -> empty array

    // --- run 5: repairing bad-id lets it save (into out1, where it has
    // never had content)
    badIdBroken = false;
    const r5 = await run(out1);
    assert.equal(r5.status, 0, `run 5 failed:\n${r5.stderr}`);
    assert.match(r5.stderr, /saved=1, updated=3, dropped=2, failed=0/);
    const rows5 = await readRows(out1);
    assert.deepEqual(rows5.map((r) => r.id), [...rows1.map((r) => r.id), "owner/repo/bad-id"]);
    assert.equal(await readFile(dir(out1, "owner__repo__bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 6: bad-id breaks again. Its previous snapshot stays on disk, so
    // the previous index row must be carried over: index and directories keep
    // matching (an orphan directory would fail verify) and the mirror keeps
    // serving the last good content.
    badIdBroken = true;
    const r6 = await run(out1);
    assert.equal(r6.status, 0, `run 6 failed:\n${r6.stderr}`);
    assert.match(r6.stderr, /saved=0, updated=3, dropped=2, failed=1 \(carried over: 1\)/);
    assert.match(r6.stderr, /"failed":1,"carried":1/); // machine-readable metrics line
    const rows6 = await readRows(out1);
    assert.deepEqual(rows6[3], rows5[3]); // carried over verbatim: same hash, fetchedAt, fields
    assert.equal(await readFile(dir(out1, "owner__repo__bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 7 (--audits, out2): unchanged content reuses the previous audit
    // results without any audit request
    const auditHitsAfterRun4 = hits.audit;
    const r7 = await run(out2, ["--audits"]);
    assert.equal(r7.status, 0, `run 7 failed:\n${r7.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4); // no re-fetch while hashes are unchanged
    const rows7 = await readRows(out2);
    assert.deepEqual(rows7[0].audits, AUDITS["vercel-labs/skills/find-skills"]); // kept
    assert.deepEqual(rows7[1].audits, []);

    // --- run 8 (--audits, out2): an upstream edit changes the hash, so that
    // skill's audits are re-fetched; the untouched skills keep theirs
    findSkillsRev = 2;
    const r8 = await run(out2, ["--audits"]);
    assert.equal(r8.status, 0, `run 8 failed:\n${r8.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4 + 1); // exactly the edited skill re-audited
    const rows8 = await readRows(out2);
    assert.equal(rows8[0].hash, hashOf("vercel-labs/skills/find-skills:2"));
    assert.deepEqual(rows8[0].audits, AUDITS["vercel-labs/skills/find-skills"]);

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
    assert.match(v1.stdout, /OK: 4 rows, 4 content directories/); // bad-id carried over from run 6
    const v2 = await verify(out2);
    assert.equal(v2.status, 0, `verify out2 failed:\n${v2.stdout}${v2.stderr}`);
    assert.match(v2.stdout, /OK: 3 rows, 3 content directories/);

    // --- verifier rejects tampered datasets (problems are reported on stderr)
    // 1. content directory without an index row
    await mkdir(dir(out1, "owner__repo__orphan"), { recursive: true });
    const t1 = await verify(out1);
    assert.equal(t1.status, 1);
    assert.match(t1.stderr, /orphan content directory/);
    await rm(dir(out1, "owner__repo__orphan"), { recursive: true, force: true });
    // 2. index claims content that is gone from disk
    await rm(dir(out1, "vercel-labs__skills__find-skills"), { recursive: true, force: true });
    const t2 = await verify(out1);
    assert.equal(t2.status, 1);
    assert.match(t2.stderr, /no content directory/);
    await mkdir(dir(out1, "vercel-labs__skills__find-skills"), { recursive: true });
    await writeFile(dir(out1, "vercel-labs__skills__find-skills", "SKILL.md"), "restored\n");
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
    colliding.splice(2, 0, { ...colliding[1], id: "owner/repo/a_b" }); // both -> owner__repo__a_b
    await writeFile(path.join(out1, "skills.jsonl"), colliding.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t6 = await verify(out1);
    assert.equal(t6.status, 1);
    assert.match(t6.stderr, /collides/);
    await writeFile(path.join(out1, "skills.jsonl"), rows6.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
