// Helpers shared by scraper.mjs and verify.mjs.

import { access } from "node:fs/promises";

export const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// Ids are "owner/repo/slug" (github) or "domain/slug" (well-known); file paths
// are relative. A skill's directory mirrors its id segment by segment; each
// segment is mapped to a filesystem-safe name ("." and ".." become "_"), so a
// skill directory can never escape the output directory.
export const safeSegment = (s) => (s === "." || s === ".." ? "_" : s.replace(/[^\w.-]/g, "_"));
export const dirName = (id) => id.split("/").map(safeSegment).join("/");

// skills.sh keys a skill by its slug with the "/" stripped out of it, but the
// leaderboard still carries the raw id (e.g. "owner/repo/face/book" whose
// canonical form is "owner/repo/facebook"). The detail API only routes
// /{owner}/{repo}/{skill} and cannot address the raw form, so normalize to
// the canonical shape: keep the source prefix ("owner/repo" for github,
// "domain" for well-known) and join the slug segments without separators.
// Both forms collapse to one entry, so this must run before deduplication.
export const canonicalId = (id, sourceType) => {
  const segs = id.split("/");
  const prefix = sourceType === "well-known" ? 1 : 2;
  return segs.length <= prefix ? id : [...segs.slice(0, prefix), segs.slice(prefix).join("")].join("/");
};

// `description` from a SKILL.md's YAML frontmatter. Minimal on purpose: a
// single-line scalar (matching quotes stripped) or a `|`/`>` block scalar;
// anything else (no frontmatter, no top-level key) yields null. Scraper and
// verifier share this function, so the index and the on-disk SKILL.md can
// never disagree.
export const skillDescription = (contents) => {
  if (typeof contents !== "string") return null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^description:(?:\s|$)/.test(l));
  if (at === -1) return null;
  const value = lines[at].slice("description:".length).trim();
  if (/^[|>][+-]?$/.test(value)) {
    const joiner = value[0] === ">" ? " " : "\n";
    const rest = [];
    for (let j = at + 1; j < lines.length && (lines[j] === "" || /^\s/.test(lines[j])); j++) {
      if (lines[j].trim()) rest.push(lines[j].trim());
    }
    return rest.join(joiner).trim() || null;
  }
  const quoted =
    value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.at(-1) === value[0];
  return (quoted ? value.slice(1, -1) : value) || null;
};

export const exists = (p) => access(p).then(() => true, () => false);
