// The decide list, applied. A pull request in the owner-reviewed lane is the
// project steward's to approve only when it falls under an entry the project
// file marks `decide: project`. Everything else is the user's: an entry with
// no mark or an unknown mark, a pull request no entry matches, and, above all,
// a pull request that changes the decide list or the code that enforces it.
// Pure, so the rule is the same wherever it is applied and easy to test.
import type { BigDecision, DecideMark } from "./config.js";

/**
 * The paths whose change is always the user's decision, whatever the decide
 * list says: the list itself, and the code that records or checks a
 * project-steward approval. This is the no-self-widening rule, and it is
 * hard-coded so a pull request cannot mark itself `project`.
 */
export const SELF_WIDENING_PATHS: readonly string[] = [
  ".bb/stewards/project.json",
  "bb-plugins/plugins/stewards/config.ts",
  "bb-plugins/plugins/stewards/decisions.ts",
  "bb-plugins/plugins/stewards/reconcile.ts",
  "bb-plugins/plugins/stewards/store.ts",
  "bb-plugins/plugins/stewards/server.ts",
];

/** A glob with `*` (within a path segment) and `**` (across segments). */
function globMatches(pattern: string, path: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "\u0000")
    .replace(/\*/gu, "[^/]*")
    .replace(/\u0000/gu, ".*");
  return new RegExp(`^${source}$`, "u").test(path);
}

/** Drop a leading repo directory (`bb-plugins/plugins/…` → `plugins/…`), for matching a repo-relative GitHub filename. */
function withoutRepo(path: string): string {
  return path.includes("/") && !path.startsWith("**") ? path.slice(path.indexOf("/") + 1) : path;
}

/** Whether any changed path falls under any pattern, matching with or without the repo directory. */
export function touchesAny(files: readonly string[], patterns: readonly string[]): boolean {
  return files.some((file) => patterns.some((pattern) => globMatches(pattern, file) || globMatches(withoutRepo(pattern), file) || globMatches(pattern, withoutRepo(file))));
}

/** Whether the change touches the decide list or the code that enforces it. */
export function isSelfWidening(files: readonly string[]): boolean {
  return touchesAny(files, SELF_WIDENING_PATHS);
}

/**
 * The mark for an entry named by the project steward. A missing name, an
 * unknown entry, or an unknown mark is the user's. The project steward's
 * words are matched to the list case-insensitively, by text. When the entry
 * names `paths`, the pull request's changed files must touch one of them.
 */
export function decideForEntry(entry: string | null | undefined, decisions: readonly BigDecision[], files?: readonly string[]): DecideMark {
  const wanted = (entry ?? "").trim();
  if (wanted === "") return "user";
  const found = decisions.find((d) => d.text === wanted || d.text.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) return "user";
  if (files !== undefined && found.paths.length > 0 && !touchesAny(files, found.paths)) return "user";
  return found.decide === "project" ? "project" : "user";
}

/**
 * The mark for a pull request: the self-widening rule first, then the entry
 * the project steward classified it under. `files` are the pull request's
 * changed paths; when they cannot be read the caller passes null or empty,
 * which can only ever yield `user` (fail closed).
 */
export function decideFor(files: readonly string[] | null | undefined, entry: string | null | undefined, decisions: readonly BigDecision[]): DecideMark {
  if (files === null || files === undefined || files.length === 0) return "user";
  if (isSelfWidening(files)) return "user";
  return decideForEntry(entry, decisions, files);
}

/**
 * The mark for a pull request the plugin has to place itself, from its changed
 * files: a `project` entry whose paths they touch is the project steward's,
 * and everything else — no matching entry, a `user` entry, an entry with no
 * paths, a self-widening change, or a file list that could not be read — is
 * the user's (fail closed). This is the rule the project steward's own
 * `approve` applies, so the page and the gate agree (BB-51).
 */
export function decideForPull(files: readonly string[] | null | undefined, decisions: readonly BigDecision[]): DecideMark {
  if (files === null || files === undefined || files.length === 0) return "user";
  if (isSelfWidening(files)) return "user";
  const match = decisions.find((d) => d.decide === "project" && d.paths.length > 0 && touchesAny(files, d.paths));
  return match === undefined ? "user" : decideForEntry(match.text, decisions, files);
}

/**
 * Why a pull request is the user's to approve, in words, or null when a
 * project-steward approval may be recorded. The null/empty file list gets its
 * own text: it is not the self-widening refusal, it is a failed read (BB-51).
 */
export function decideForRefusal(files: readonly string[] | null | undefined, entry: string | null | undefined, decisions: readonly BigDecision[]): string | null {
  if (files === null || files === undefined) return "the changed files could not be read";
  if (files.length === 0) return "the pull request changes no files";
  if (isSelfWidening(files)) return "the change touches the decide list or the code that enforces it";
  const wanted = (entry ?? "").trim();
  if (wanted === "") return "no decide-list entry was given";
  const found = decisions.find((d) => d.text === wanted || d.text.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) return `the entry ${JSON.stringify(entry)} is not in the decide list`;
  if (found.paths.length > 0 && !touchesAny(files, found.paths)) return `the changed files do not touch ${JSON.stringify(found.text)}'s paths`;
  return found.decide === "project" ? null : `the entry ${JSON.stringify(found.text)} is not marked project`;
}
