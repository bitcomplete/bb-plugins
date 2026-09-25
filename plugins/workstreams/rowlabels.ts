// The words a Board row displays, as opposed to the words its rules use. The
// verbs from `inboxVerb` stay full length (the actions, tests and How-this-works
// panel read them); the row shows the current state clearly and spells out
// the action on hover. Pure, so it is tested apart from the React that draws it.
import type { PrimaryAction } from "./actions.js";
import { compactAge } from "./workstreams.js";

const SHORT_VERB: Record<string, string> = {
  "Resolve conflicts": "Conflicts",
  "Approved, comments open": "Approved · open threads",
  "Review approval note": "Approved · review note",
  "Ready to merge": "Approved · ready",
  "In review": "Waiting for review",
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

export type RowAge = { since: number | null; basis: "pr" | "last-commit" };

/** PR rows show GitHub's open time; local checkouts use their last commit. */
export function rowAge(pr: { createdAt?: string | null } | null, lastCommitAt: string | null): RowAge {
  const date = pr === null ? lastCommitAt : pr.createdAt;
  const parsed = date === null || date === undefined ? NaN : Date.parse(date);
  return { since: Number.isNaN(parsed) ? null : parsed, basis: pr === null ? "last-commit" : "pr" };
}

/** The compact age keeps the last-commit fallback explicit on the row. */
export function shortAge(age: RowAge, now: number): string {
  if (age.since === null) return "";
  const text = compactAge(age.since, now);
  return age.basis === "pr" ? text : `commit ${text}`;
}

/** Explain what the age measures, including unavailable dates. */
export function ageHint(age: RowAge, now: number): string {
  if (age.since === null) return age.basis === "pr" ? "PR open date unavailable" : "No commit date";
  const text = compactAge(age.since, now);
  return age.basis === "pr" ? `PR opened ${text} ago` : `Last commit ${text} ago`;
}

/** The title's hover: the PR's full original title, then where it lives. */
export function titleHint(row: {
  title: string;
  repo: string;
  pr: { number: number; title: string } | null;
  branch: string | null;
  /** The ticket's Linear detail, when known: one more line, never a replacement. */
  linear?: { title: string | null; state: string | null; project: string | null } | null;
}): string {
  const heading = row.pr === null || row.pr.title.trim() === "" ? row.title : row.pr.title;
  const where = row.pr === null ? row.repo : `${row.repo} #${row.pr.number}`;
  const base = row.branch === null ? `${heading}\n${where}` : `${heading}\n${where} · ${row.branch}`;
  const linear = row.linear;
  if (linear === undefined || linear === null) return base;
  const parts = [linear.title, linear.state, linear.project].filter((part): part is string => part !== null && part.trim() !== "");
  return parts.length === 0 ? base : `${base}\nLinear: ${parts.join(" · ")}`;
}
