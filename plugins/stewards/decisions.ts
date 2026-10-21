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
