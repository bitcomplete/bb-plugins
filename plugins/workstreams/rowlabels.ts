// The words a Board row displays, as opposed to the words its rules use. The
// verbs from `inboxVerb` stay full length (the actions, tests and How-this-works
// panel read them); the row shows a short form and spells the full one out on
// hover. Pure, so it is tested apart from the React that draws it.
import type { PrimaryAction } from "./actions.js";
import { compactAge, type StateAge } from "./workstreams.js";

const SHORT_VERB: Record<string, string> = {
  "Resolve conflicts": "Conflicts",
  "Changes requested": "Changes req.",
  "Approved, comments open": "Comments",
  "Ready to merge": "Ready",
  "Blocked by branch rules": "Rules block",
  "Checking mergeability": "Checking",
};

/** The row's short verb. Verbs already short ("CI failing", "Behind #42") pass through. */
export function shortVerb(verb: string): string {
  return SHORT_VERB[verb] ?? verb;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The verb chip's hover when it runs the primary action: the full verb, what a click does, and its key. */
export function primaryHint(verb: string, action: PrimaryAction): string {
  const does =
    action.kind === "agent"
      ? `start an agent to ${lowerFirst(action.label)}`
      : action.kind === "direct"
        ? lowerFirst(action.label)
        : `go to #${action.behind}`;
  return `${verb}: ${does} (a)`;
}

/** The compact age the row shows: "4d", "23h", or nothing when it is unknown. */
export function shortAge(age: StateAge, now: number): string {
  return age.since === null ? "" : compactAge(age.since, now);
}

/** The age's hover, in words: "CI failing for 3d", or "last commit 4d ago" when no state change was seen. */
export function ageHint(age: StateAge, verb: string | null, now: number): string {
  if (age.since === null) return age.basis === "state" ? "Time in this state is unknown" : "No commit date";
  const text = compactAge(age.since, now);
  if (age.basis === "last-commit") return `No state change seen yet: last commit ${text} ago`;
  return verb === null ? `In this state for ${text}` : `${verb} for ${text}`;
}

/** The title's hover: the PR's full original title, then where it lives. */
export function titleHint(row: {
  title: string;
  repo: string;
  pr: { number: number; title: string } | null;
  branch: string | null;
}): string {
  const heading = row.pr === null || row.pr.title.trim() === "" ? row.title : row.pr.title;
  const where = row.pr === null ? row.repo : `${row.repo} #${row.pr.number}`;
  return row.branch === null ? `${heading}\n${where}` : `${heading}\n${where} · ${row.branch}`;
}
