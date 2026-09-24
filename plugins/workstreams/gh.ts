// The `gh` and git payload parsers, kept out of host.ts so they can be tested
// without loading the host runtime. They are the boundary between an external
// tool's JSON and every rule in workstreams.ts: parse defensively here, and
// pass typed values inward.
import { MERGE_STATE_STATUSES, type MergeStateStatus, type Pr } from "./contract.js";
import { parseReviewRequests } from "./ghactions.js";

const KNOWN_MERGE_STATE_STATUSES = new Set<string>(MERGE_STATE_STATUSES);

/**
 * GitHub's authoritative "can this merge right now" signal, from
 * `gh pr list --json mergeStateStatus`. Anything missing or unrecognized
 * becomes UNKNOWN, so a value GitHub adds later — or a unit cached before
 * this field existed — never gets misread as ready to merge.
 */
export function parseMergeStateStatus(value: unknown): MergeStateStatus {
  if (typeof value !== "string") return "UNKNOWN";
  const upper = value.toUpperCase();
  return KNOWN_MERGE_STATE_STATUSES.has(upper) ? (upper as MergeStateStatus) : "UNKNOWN";
}

/** Basename of an origin URL, minus `.git`. Handles scp-style git@ remotes. */
export function repoFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/u, "");
  if (trimmed === "") return null;
  const last = trimmed.split(/[/:]/u).pop();
  if (last === undefined || last === "") return null;
  return last.replace(/\.git$/u, "");
}

/** `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>". */
export function parseAheadBehind(
  output: string,
): { ahead: number; behind: number } | null {
  const match = /^(\d+)\s+(\d+)$/u.exec(output.trim());
  if (match === null) return null;
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

/** Pull the conclusions out of `gh pr list --json statusCheckRollup`. */
export function checkConclusions(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) return [];
  return rollup
    .flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      // Checks report `conclusion`; commit statuses report `state`.
      const value = record.conclusion ?? record.state;
      return typeof value === "string" && value !== ""
        ? [value.toUpperCase()]
        : [];
    })
    .slice(0, 100);
}

/**
 * The state of each reviewer's most recent review. This is what separates
 * `approved-with-comments` from `awaiting-merge`: a PR whose overall decision
 * is APPROVED but which still carries a reviewer sitting at COMMENTED has
 * something outstanding that the aggregate `reviewDecision` hides.
 */
export function latestReviewStates(reviews: unknown): string[] {
  if (!Array.isArray(reviews)) return [];
  return reviews
    .flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const state = (entry as Record<string, unknown>).state;
      return typeof state === "string" && state !== "" ? [state.toUpperCase()] : [];
    })
    .slice(0, 50);
}

/** `gh pr list --json mergeCommit` gives `{ oid }`, or null before a merge. */
export function mergeCommitOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const oid = (value as Record<string, unknown>).oid;
  return typeof oid === "string" && /^[0-9a-f]{7,64}$/iu.test(oid) ? oid : null;
}

/**
 * `gh pr list --head <branch>` answers with an array, empty when the branch
 * has no pull request — the normal case, not an error.
 */
export function parsePrList(raw: string): { pr: Pr; mergeCommit: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const first = parsed[0];
  if (first === null || first === undefined || typeof first !== "object") return null;
  const view = first as Record<string, unknown>;
  if (typeof view.number !== "number") return null;
  const pr: Pr = {
    number: view.number,
    state: typeof view.state === "string" ? view.state.toUpperCase() : "",
    isDraft: view.isDraft === true,
    reviewDecision:
      typeof view.reviewDecision === "string" && view.reviewDecision !== ""
        ? view.reviewDecision.toUpperCase()
        : null,
    checkConclusions: checkConclusions(view.statusCheckRollup),
    url: typeof view.url === "string" ? view.url.slice(0, 500) : "",
    title: typeof view.title === "string" ? view.title.slice(0, 300) : "",
    mergeable:
      typeof view.mergeable === "string" ? view.mergeable.toUpperCase() : null,
    mergeStateStatus: parseMergeStateStatus(view.mergeStateStatus),
    baseRefName:
      typeof view.baseRefName === "string" && view.baseRefName !== ""
        ? view.baseRefName.slice(0, 300)
        : null,
    headRefName:
      typeof view.headRefName === "string" && view.headRefName !== ""
        ? view.headRefName.slice(0, 300)
        : null,
    latestReviewStates: latestReviewStates(view.latestReviews),
    reviewRequests: parseReviewRequests(view.reviewRequests),
    mergedAt:
      typeof view.mergedAt === "string" && !Number.isNaN(Date.parse(view.mergedAt))
        ? view.mergedAt.slice(0, 40)
        : null,
  };
  return { pr, mergeCommit: mergeCommitOf(view.mergeCommit) };
}
