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
 * The first `decide: user` entry with paths that the changed files touch, or
 * undefined. A pull request that touches a `user` entry's paths is the user's,
 * whatever `project` entries also match (BB-125, fail closed).
 */
export function matchingUserEntry(files: readonly string[], decisions: readonly BigDecision[]): BigDecision | undefined {
  return decisions.find((d) => d.decide === "user" && d.paths.length > 0 && touchesAny(files, d.paths));
}

/**
 * The mark for an entry named by the project steward. A missing name, an
 * unknown entry, or an unknown mark is the user's. The project steward's
 * words are matched to the list case-insensitively, by text. When the entry
 * names `paths`, the pull request's changed files must touch one of them.
 * When the files touch any `user` entry's paths the mark is the user's, even
 * when the named entry is marked project.
 */
export function decideForEntry(entry: string | null | undefined, decisions: readonly BigDecision[], files?: readonly string[]): DecideMark {
  const wanted = (entry ?? "").trim();
  if (wanted === "") return "user";
  const found = decisions.find((d) => d.text === wanted || d.text.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) return "user";
  if (files !== undefined && matchingUserEntry(files, decisions) !== undefined) return "user";
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
  if (matchingUserEntry(files, decisions) !== undefined) return "user";
  const match = decisions.find((d) => d.decide === "project" && d.paths.length > 0 && touchesAny(files, d.paths));
  return match === undefined ? "user" : decideForEntry(match.text, decisions, files);
}

/**
 * The one-line rule every listing states, so the wake, the page, the refusal
 * and `bb stewards gate` all read the same (BB-135).
 */
export const DECISION_RULE = "a `user` entry wins; self-widening is always the user's; no match is the user's";

/** One decide-list entry a change matched, and the changed files that matched it. */
export type DecisionMatch = { text: string; decide: DecideMark; files: string[] };

/**
 * What the decide list did with a change: every entry its paths matched, the
 * entry that decides it, the final mark, and the rule (BB-135). Entry-
 * independent, so the wake, the gate and the approval refusal cannot disagree
 * about which entries matched; the named-entry question is `decideFor`'s.
 */
export type DecisionExplanation = {
  /** Every entry whose paths at least one changed file matched, in decide-list order. */
  matched: DecisionMatch[];
  /** The entry that decides the change, or null when none matched (the user's) or the change is self-widening. */
  winner: DecisionMatch | null;
  /** The final mark. */
  mark: DecideMark;
  /** True when the change touches the decide list or the code that enforces it. */
  selfWidening: boolean;
  /** True when the changed files could not be read (a missing or empty list). */
  unreadable: boolean;
  /** The one-line rule. */
  rule: string;
  /** One line saying why the mark came out as it did. */
  reason: string;
};

/**
 * Explain how the decide list places a change: every entry the changed files
 * matched (text, mark, matching files), the entry that wins by the rule, the
 * final mark, and why. `files` null or empty is a failed read and can only be
 * the user's, as everywhere else (fail closed, BB-51/BB-135).
 */
export function explainDecision(files: readonly string[] | null | undefined, decisions: readonly BigDecision[]): DecisionExplanation {
  const rule = DECISION_RULE;
  if (files === null || files === undefined) {
    return { matched: [], winner: null, mark: "user", selfWidening: false, unreadable: true, rule, reason: "the changed files could not be read" };
  }
  if (files.length === 0) {
    return { matched: [], winner: null, mark: "user", selfWidening: false, unreadable: true, rule, reason: "the pull request changes no files" };
  }
  const matched: DecisionMatch[] = decisions
    .filter((d) => d.paths.length > 0 && touchesAny(files, d.paths))
    .map((d) => ({ text: d.text, decide: d.decide === "project" ? "project" : "user", files: files.filter((f) => touchesAny([f], d.paths)) }));
  if (isSelfWidening(files)) {
    return { matched, winner: null, mark: "user", selfWidening: true, unreadable: false, rule, reason: "the change touches the decide list or the code that enforces it" };
  }
  const user = matched.find((m) => m.decide === "user");
  if (user !== undefined) return { matched, winner: user, mark: "user", selfWidening: false, unreadable: false, rule, reason: `the changed files touch ${JSON.stringify(user.text)}, which is the user's decision` };
  const project = matched.find((m) => m.decide === "project");
  if (project !== undefined) return { matched, winner: project, mark: "project", selfWidening: false, unreadable: false, rule, reason: `the changed files touch ${JSON.stringify(project.text)}, which is the project steward's decision` };
  return { matched, winner: null, mark: "user", selfWidening: false, unreadable: false, rule, reason: "no decide-list entry's paths matched" };
}

/**
 * The listing a wake, the page and `bb stewards gate` print: every entry the
 * changed files matched with the files that matched it, the deciding entry,
 * and the rule in one line (BB-135).
 */
export function formatDecisionListing(explanation: DecisionExplanation): string {
  const entries = explanation.unreadable
    ? "Decide list: the changed files were not read, so no entry was matched."
    : explanation.matched.length === 0
      ? "Decide list: no entry's paths matched the changed files."
      : [
          `Decide list: ${explanation.matched.length} entr${explanation.matched.length === 1 ? "y" : "ies"} matched:`,
          ...explanation.matched.map((m) => `- ${JSON.stringify(m.text)} [${m.decide}] — ${m.files.join(", ") || "(no file listed)"}`),
        ].join("\n");
  const winner = explanation.selfWidening
    ? "Deciding entry: none — self-widening is always the user's."
    : explanation.winner === null
      ? "Deciding entry: none (the user's)."
      : `Deciding entry: ${JSON.stringify(explanation.winner.text)} [${explanation.winner.decide}].`;
  return `${entries}\n${winner}\nRule: ${explanation.rule}`;
}

/**
 * Why a pull request is the user's to approve, in words, or null when a
 * project-steward approval may be recorded. The null/empty file list gets its
 * own text: it is not the self-widening refusal, it is a failed read (BB-51).
 * Every refusal carries the decide-list listing, so the approval route names
 * the entries that matched and the one that decides (BB-135).
 */
export function decideForRefusal(files: readonly string[] | null | undefined, entry: string | null | undefined, decisions: readonly BigDecision[]): string | null {
  const listing = formatDecisionListing(explainDecision(files, decisions));
  const refused = (reason: string): string => `${reason}\n${listing}`;
  if (files === null || files === undefined) return refused("the changed files could not be read");
  if (files.length === 0) return refused("the pull request changes no files");
  if (isSelfWidening(files)) return refused("the change touches the decide list or the code that enforces it");
  const userEntry = matchingUserEntry(files, decisions);
  if (userEntry !== undefined) return refused(`the changed files touch ${JSON.stringify(userEntry.text)}, which is the user's decision`);
  const wanted = (entry ?? "").trim();
  if (wanted === "") return refused("no decide-list entry was given");
  const found = decisions.find((d) => d.text === wanted || d.text.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) return refused(`the entry ${JSON.stringify(entry)} is not in the decide list`);
  if (found.paths.length > 0 && !touchesAny(files, found.paths)) return refused(`the changed files do not touch ${JSON.stringify(found.text)}'s paths`);
  return found.decide === "project" ? null : refused(`the entry ${JSON.stringify(found.text)} is not marked project`);
}
