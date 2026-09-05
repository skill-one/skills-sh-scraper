// Helpers shared by scraper.mjs and verify.mjs.

import { access } from "node:fs/promises";

export const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// Ids are "owner/repo/slug" (github) or "domain/slug" (well-known); file paths
// are relative. Each segment is mapped to a filesystem-safe name ("." and ".."
// become "_") and the segments are joined with "__", so one skill is exactly
// one directory that can never escape the output directory.
export const safeSegment = (s) => (s === "." || s === ".." ? "_" : s.replace(/[^\w.-]/g, "_"));
export const dirName = (id) => id.split("/").map(safeSegment).join("__");

export const exists = (p) => access(p).then(() => true, () => false);
