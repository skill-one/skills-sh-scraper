// End-to-end test: runs scraper.mjs against a local mock of the skills.sh API.
// No real token, no network. Covers: pagination, skills.jsonl index shape,
// pure content directories, path sanitization, resume on re-run, .env.local
// token loading, 429 retry honoring Retry-After, --skip-duplicates, --audits.

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
const hashOf = (id) => createHash("sha256").update(id).digest("hex");

const FILES = {
  "vercel-labs/skills/find-skills": [
    { path: "SKILL.md", contents: "# find-skills\nFind skills on skills.sh.\n" },
    { path: "scripts/run.sh", contents: "#!/bin/sh\necho find-skills\n" },
    { path: "_meta.json", contents: "{}\n" }, // some skills ship their own _meta.json
  ],
  "mintlify.com/mintlify": [{ path: "SKILL.md", contents: "# mintlify\nWell-known skill.\n" }],
  "owner/repo/wei rd~x": [{ path: "SKILL.md", contents: "# weird slug\n" }],
  "owner/repo/dup-skill": [{ path: "SKILL.md", contents: "# duplicate\n" }],
  "owner/repo/rate-limited": null, // no upstream snapshot: hash null, files null
  "owner/repo/bad-id": null, // upstream rejects the detail request outright
};

const AUDITS = {
  "vercel-labs/skills/find-skills": [
    { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", auditedAt: "2026-09-01T00:00:00.000Z", riskLevel: "LOW" },
  ],
};

const SKILLS = [
  { id: "vercel-labs/skills/find-skills", slug: "find-skills", name: "find-skills", source: "vercel-labs/skills", installs: 12345, sourceType: "github", installUrl: "npx skills add vercel-labs/skills/find-skills", url: "https://skills.sh/vercel-labs/skills/find-skills" },
  { id: "mintlify.com/mintlify", slug: "mintlify", name: "mintlify", source: "mintlify.com", installs: 99, sourceType: "well-known", installUrl: "npx skills add mintlify.com/mintlify", url: "https://skills.sh/mintlify.com/mintlify" },
  { id: "owner/repo/wei rd~x", slug: "wei rd~x", name: "weird", source: "owner/repo", installs: 3, sourceType: "github", installUrl: "npx skills add owner/repo/wei rd~x", url: "https://skills.sh/owner/repo/wei rd~x" },
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
    if (id === "owner/repo/bad-id") {
      res.statusCode = 400; // permanently broken upstream id
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    if (id === "owner/repo/rate-limited" && hits.rateLimited++ === 0) {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end("rate limited");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: skill.id, source: skill.source, slug: skill.slug, installs: skill.installs, hash: FILES[skill.id] ? hashOf(skill.id) : null, files: FILES[skill.id] }));
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
    // --- run 1: default scrape saves everything, content dirs stay pure
    const r1 = await run(out1);
    assert.equal(r1.status, 0, `run 1 failed:\n${r1.stderr}`);
    assert.equal(hits.list, 2); // 6 skills, 3 per mock page
    assert.equal(hits.detail, 7); // 6 skills + one 429 retried (the 400 is not retried)
    assert.equal(hits.audit, 0); // flag off -> no audit requests

    const rows1 = await readRows(out1);
    assert.equal(rows1.length, 6);
    assert.equal(rows1[0].id, "vercel-labs/skills/find-skills"); // leaderboard order kept
    assert.equal(rows1[0].installs, 12345);
    assert.equal(rows1[0].contentSaved, true);
    assert.equal(rows1[0].hash, hashOf("vercel-labs/skills/find-skills"));
    assert.ok(rows1[0].fetchedAt);
    assert.equal("audits" in rows1[0], false);
    assert.equal(rows1[3].isDuplicate, true); // flag preserved on the row

    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "SKILL.md"), "utf8"),
      FILES["vercel-labs/skills/find-skills"][0].contents,
    );
    assert.equal(
      await readFile(dir(out1, "vercel-labs__skills__find-skills", "scripts", "run.sh"), "utf8"),
      FILES["vercel-labs/skills/find-skills"][1].contents,
    );
    // content dirs contain ONLY skill files (upstream-shipped _meta.json is legit)
    assert.deepEqual((await readdir(dir(out1, "vercel-labs__skills__find-skills"))).sort(), ["SKILL.md", "_meta.json", "scripts"]);
    // well-known source: domain__slug directory
    assert.equal(await readFile(dir(out1, "mintlify.com__mintlify", "SKILL.md"), "utf8"), FILES["mintlify.com/mintlify"][0].contents);
    // unsafe slug characters are sanitized in directory names
    assert.equal(await readFile(dir(out1, "owner__repo__wei_rd_x", "SKILL.md"), "utf8"), FILES["owner/repo/wei rd~x"][0].contents);
    // skill without snapshot: no directory, row marked noSnapshot
    assert.equal(await pathExists(dir(out1, "owner__repo__rate-limited")), false);
    assert.equal(rows1[4].contentSaved, false);
    assert.equal(rows1[4].noSnapshot, true);
    assert.equal(rows1[4].hash, null);
    // permanently failing skill: run still exits 0, error recorded on the row
    assert.equal(await pathExists(dir(out1, "owner__repo__bad-id")), false);
    assert.equal(rows1[5].contentSaved, false);
    assert.match(rows1[5].error, /HTTP 400/);
    // no temp leftovers
    assert.equal(await pathExists(path.join(out1, ".tmp")), false);

    // --- run 2: resume — content reused; only the failed skill is retried
    const r2 = await run(out1);
    assert.equal(r2.status, 0, `run 2 failed:\n${r2.stderr}`);
    assert.equal(hits.detail, 8); // +1: the failed skill is retried (and fails again)
    assert.equal(hits.audit, 0);
    assert.match(r2.stderr, /saved=0, reused=5, failed=1/);
    const rows2 = await readRows(out1);
    assert.equal(rows2.length, 6);
    assert.match(rows2[5].error, /HTTP 400/);

    // --- run 3: fresh dir with --audits --skip-duplicates
    const r3 = await run(out2, ["--audits", "--skip-duplicates"]);
    assert.equal(r3.status, 0, `run 3 failed:\n${r3.stderr}`);
    assert.equal(hits.detail, 13); // +5 new fetches (no 429 retry left for rate-limited)
    assert.equal(hits.audit, 5); // all but the failed skill (no audit after a detail error); unaudited -> 404 -> []

    const rows3 = await readRows(out2);
    assert.equal(rows3.length, 6);
    assert.equal(await pathExists(dir(out2, "owner__repo__dup-skill")), false); // no content for duplicates
    assert.equal(rows3[3].contentSaved, false);
    assert.equal("noSnapshot" in rows3[3], false); // skipped by flag, not by upstream
    assert.deepEqual(rows3[0].audits, AUDITS["vercel-labs/skills/find-skills"]);
    assert.deepEqual(rows3[1].audits, []); // audited by nobody -> empty array

    // --- artifact verifier accepts both datasets (default + flag modes)
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
    assert.match(v1.stdout, /OK: 6 rows, 4 content directories/);
    const v2 = await verify(out2);
    assert.equal(v2.status, 0, `verify out2 failed:\n${v2.stdout}${v2.stderr}`);

    // --- verifier rejects tampered datasets (problems are reported on stderr)
    // 1. index claims content that is gone from disk
    await rm(dir(out1, "vercel-labs__skills__find-skills"), { recursive: true, force: true });
    const t1 = await verify(out1);
    assert.equal(t1.status, 1);
    assert.match(t1.stderr, /directory missing/);
    // 2. index order broken
    const reversed = (await readRows(out1)).reverse();
    await writeFile(path.join(out1, "skills.jsonl"), reversed.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const t2 = await verify(out1);
    assert.equal(t2.status, 1);
    assert.match(t2.stderr, /not sorted/);
    // 3. leftover temp file from an interrupted run
    await writeFile(path.join(out1, "skills.jsonl.tmp"), "{");
    const t3 = await verify(out1);
    assert.equal(t3.status, 1);
    assert.match(t3.stderr, /skills\.jsonl\.tmp/);
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
