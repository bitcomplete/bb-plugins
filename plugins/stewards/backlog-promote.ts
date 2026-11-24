// The backlog steward's promotion write (BB-385), as pure functions: the WIP
// ceiling, the ordering, the eligibility rules, the authority limits and the
// ledger entry shape. Nothing here reads a file, a source or the store;
// server.ts hands the values in and writes the plan through the source
// contract. Keeping the limits here is the point: the playbook says them, but
// the plugin enforces them.
import { z } from "zod";
import type { Source } from "./source-contract.js";

/**
 * The one gated tool's parameters. `key` is a hint only: the plugin picks the
 * top-ordered eligible ticket itself, so a `key` that is not that ticket is
 * ignored (the acceptance criteria's "the plugin picks the candidate").
 */
export const backlogPromoteParamsSchema = z.object({ key: z.string().trim().min(1).max(200).optional() }).strict();
export type BacklogPromoteParams = z.infer<typeof backlogPromoteParamsSchema>;

/**
 * Fields a promotion may never carry. The plugin, not the model, decides the
 * state, the label and the assignee, and it never edits a description, cancels
 * or closes. The tool's schema is strict, so a call carrying one is rejected
 * before it runs; this list is the second check, so the pure decision refuses
 * one too (a bug in the wiring cannot smuggle a description or a state through).
 */
export const FORBIDDEN_PROMOTE_FIELDS = ["description", "state", "assignee", "cancel", "close", "addLabels", "priority", "relations"] as const;

/** The only state a promotion sets, and the only assignee it names. */
export const PROMOTE_STATE = "Todo";
export const PROMOTE_ASSIGNEE = "me" as const;

/**
 * The GitHub state a promotion sets: the `status:todo` label the
 * `github-issues` playbook's spec phase keys on. GitHub has no workflow
 * states, so the state is a status label and `sourceUpdateIssue` replaces any
 * other `status:*` label when one is set.
 */
export const PROMOTE_GITHUB_STATE = "status:todo";
/** The GitHub status labels the WIP ceiling counts: the playbook's todo and build phases. */
export const PROMOTE_GITHUB_TODO_LABEL = "status:todo";
export const PROMOTE_GITHUB_IN_PROGRESS_LABEL = "status:in-progress";
/** The GitHub backlog state beyond the playbook's `open`: an issue carrying a `status:backlog` label. */
export const PROMOTE_GITHUB_BACKLOG_LABEL = "status:backlog";

/** The priority order the owner sets by hand; anything else (unset, unknown) ranks last. */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** The stable refusal reasons the digest collapses; anything else is one line. */
export const PROMOTE_WIP_FULL = "WIP full";
export const PROMOTE_NO_CANDIDATE = "no eligible candidate";

/** What the tool read about one open issue, from the fresh backlog read. */
export type BacklogPromoteIssue = {
  /** The source's id for the issue (Linear's UUID), what the ledger records. */
  id: string;
  key: string;
  /** The team key the ticket lives in, as the backlog read reports it. */
  unit: string;
  title: string | null;
  state: string;
  stateType: string | null;
  labels: string[];
  assignees: string[];
  priority: string | null;
  createdAt: string | null;
};

/** What the issue read adds: readiness and the open blockers. */
export type PromoteDetail = {
  description: string | null;
  /** The keys of the issues that still block this one; empty when none. */
  blockedBy: string[];
};

/** The project's promotion limits and the fixed labels no write may touch. */
export type PromoteConfig = {
  promote: boolean;
  /** The unit the binding watches: a Linear team key, or a GitHub `owner/repo`. */
  team: string;
  /**
   * The backlog source the target reads and writes through (BB-398). Optional
   * and defaulting to `linear`, so the Linear call sites and their tests are
   * unchanged. GitHub has no workflow states and no priority, so the state
   * mapping and the WIP count differ.
   */
  source?: Source;
  /** Stage 3's Todo + In Progress ceiling. */
  wipLimit: number;
  /** The project's adoption label (project.label). */
  label: string;
  /** Labels a promotion may never add and that mark a ticket adopted: the adoption label, initiative, and any a playbook adopts on. */
  adoptedLabels: string[];
};

/** The plan a decision accepted, ready to write through the source contract. */
export type PromotePlan = { key: string; state: string; addLabels: string[]; assignee: "me" };

export type PromoteDecision = { ok: true; plan: PromotePlan; candidate: BacklogPromoteIssue } | { ok: false; reason: string };

const sameTeam = (issue: BacklogPromoteIssue, config: PromoteConfig): boolean => issue.unit.trim().toUpperCase() === config.team.trim().toUpperCase();

/**
 * Whether a GitHub issue carries one of the given status labels, by its
 * snapshot state (which is the one status label when it carries exactly one)
 * or by its labels. GitHub's `state` is derived from a `status:*` label, but a
 * malformed issue carrying two status labels reads `open`, so the labels are
 * checked too.
 */
function githubHasStatus(issue: BacklogPromoteIssue, labels: readonly string[]): boolean {
  const wanted = new Set(labels.map((l) => l.trim().toLowerCase()));
  if (wanted.has(issue.state.trim().toLowerCase())) return true;
  return issue.labels.some((l) => wanted.has(l.trim().toLowerCase()));
}

/** Whether the state is a terminal closed one; GitHub's closed issues are never WIP or candidates. */
const isClosedState = (issue: BacklogPromoteIssue): boolean => issue.state.trim().toLowerCase().startsWith("closed");

/**
 * Whether an issue sits in Todo or In Progress, the two states the WIP
 * ceiling counts. This is by state name, not state type: "In Review" is a
 * `started` state in Linear's BB team, and a ticket in review is not work in
 * progress for the ceiling. On GitHub the two are the `status:todo` and
 * `status:in-progress` labels the `github-issues` playbook keys on.
 */
export function isTodoOrInProgress(issue: BacklogPromoteIssue, source: Source = "linear"): boolean {
  if (source === "github") return githubHasStatus(issue, [PROMOTE_GITHUB_TODO_LABEL, PROMOTE_GITHUB_IN_PROGRESS_LABEL]);
  const name = issue.state.trim().toLowerCase();
  return name === "todo" || name === "in progress";
}

/**
 * Whether an issue sits in the watched unit's Backlog state. On GitHub that is
 * the `open` state (an issue with no status label), the state the
 * `github-issues` playbook's `open` phase covers, or an issue carrying a
 * `status:backlog` label.
 */
export function isBacklogState(issue: BacklogPromoteIssue, source: Source = "linear"): boolean {
  if (source === "github") {
    if (issue.state.trim().toLowerCase() === "open") return true;
    return githubHasStatus(issue, [PROMOTE_GITHUB_BACKLOG_LABEL]);
  }
  const type = (issue.stateType ?? "").trim().toLowerCase();
  if (type === "backlog") return true;
  return issue.state.trim().toLowerCase() === "backlog";
}

/** Whether an issue is already adopted: it carries an adoption label or any assignee. */
export function isAdopted(issue: BacklogPromoteIssue, config: PromoteConfig): boolean {
  if (issue.assignees.length > 0) return true;
  const labels = new Set(issue.labels.map((l) => l.trim().toLowerCase()));
  return config.adoptedLabels.some((l) => labels.has(l.trim().toLowerCase()));
}

/** Whether the ticket looks ready to be worked: a title and a non-empty description. */
export function isReadyLooking(issue: BacklogPromoteIssue, detail: PromoteDetail): boolean {
  return (issue.title ?? "").trim() !== "" && (detail.description ?? "").trim() !== "";
}

/** Whether an issue still has an open blocker, so it is never promoted. */
export function hasOpenBlocker(detail: PromoteDetail): boolean {
  return detail.blockedBy.length > 0;
}

/** Whether a candidate may be promoted at all: ready-looking and unblocked. */
export function candidateEligible(issue: BacklogPromoteIssue, detail: PromoteDetail): boolean {
  return isReadyLooking(issue, detail) && !hasOpenBlocker(detail);
}

/**
 * How many issues the watched unit has in progress, the WIP ceiling's
 * numerator. Linear counts Todo and In Progress by state name. GitHub counts
 * `status:todo` and `status:in-progress`, and also an open issue that is
 * already adopted (the adoption label or any assignee), because on GitHub the
 * adoption is what marks it as being worked even before its status label
 * moves; a closed issue never counts.
 */
export function wipCount(issues: readonly BacklogPromoteIssue[], config: PromoteConfig): number {
  const source = config.source ?? "linear";
  return issues.filter((issue) => {
    if (!sameTeam(issue, config)) return false;
    if (isTodoOrInProgress(issue, source)) return true;
    return source === "github" && !isClosedState(issue) && isAdopted(issue, config);
  }).length;
}

const createdAtMs = (issue: BacklogPromoteIssue): number => {
  const t = issue.createdAt === null ? Number.NaN : Date.parse(issue.createdAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * The eligible tickets in promotion order: un-adopted Backlog tickets in the
 * watched team, ordered by the owner's priority and then oldest first (the
 * `createdAt` Linear already returns), with the key as a final tiebreak. The
 * plugin never ranks a ticket above what the owner set by hand.
 *
 * The tiebreak is explicit because `sourceBacklog` sets no `orderBy` and
 * Linear returns newest `createdAt` first, so keeping the source order would
 * promote the newest ticket, the opposite of the criterion.
 */
export function orderedCandidates(issues: readonly BacklogPromoteIssue[], config: PromoteConfig): BacklogPromoteIssue[] {
  const source = config.source ?? "linear";
  const rank = (issue: BacklogPromoteIssue): number => PRIORITY_RANK[(issue.priority ?? "").trim().toLowerCase()] ?? 4;
  return issues.filter((issue) => sameTeam(issue, config) && isBacklogState(issue, source) && !isAdopted(issue, config)).sort((a, b) => rank(a) - rank(b) || createdAtMs(a) - createdAtMs(b) || a.key.localeCompare(b.key));
}

/** The one plan a promotion writes: Todo (`status:todo` on GitHub), the adoption label, and this server's own login. */
export function promotePlan(candidate: BacklogPromoteIssue, config: PromoteConfig): PromotePlan {
  const source = config.source ?? "linear";
  return { key: candidate.key, state: source === "github" ? PROMOTE_GITHUB_STATE : PROMOTE_STATE, addLabels: [config.label], assignee: PROMOTE_ASSIGNEE };
}

/**
 * The whole rule set, in one pure decision. The caller reads the team's fresh
 * backlog and the candidate issues' details first (a read that fails is the
 * caller's to refuse); this returns the exact plan to write, or the reason it
 * refused. `details` holds what the issue read added for the candidates the
 * caller looked at; a candidate with no detail is skipped, so a caller that
 * stopped reading at the first eligible one still gets the same pick.
 */
export function decidePromote(input: { params: BacklogPromoteParams; issues: readonly BacklogPromoteIssue[]; details: ReadonlyMap<string, PromoteDetail>; config: PromoteConfig }): PromoteDecision {
  const { params, issues, details, config } = input;
  const refuse = (reason: string): PromoteDecision => ({ ok: false, reason });

  if (!config.promote) return refuse("backlog.promote is off; the backlog steward promotes nothing");

  for (const field of FORBIDDEN_PROMOTE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, field)) return refuse(`a promotion may not carry ${field}; the plugin picks the ticket, the state, the label and the assignee`);
  }

  if (wipCount(issues, config) >= config.wipLimit) return refuse(PROMOTE_WIP_FULL);

  for (const candidate of orderedCandidates(issues, config)) {
    const detail = details.get(candidate.key);
    if (detail === undefined) continue;
    if (!candidateEligible(candidate, detail)) continue;
    return { ok: true, plan: promotePlan(candidate, config), candidate };
  }
  return refuse(PROMOTE_NO_CANDIDATE);
}

/** The ledger detail for an accepted promotion, recorded beside the write. */
export function promoteAcceptedDetail(candidate: BacklogPromoteIssue, params: BacklogPromoteParams, config: PromoteConfig): Record<string, unknown> {
  const source = config.source ?? "linear";
  return { state: source === "github" ? PROMOTE_GITHUB_STATE : PROMOTE_STATE, addLabels: [config.label], assignee: PROMOTE_ASSIGNEE, requestedKey: params.key ?? null, promoted: candidate.key };
}

/** The ledger detail for a refused promotion, so the digest can show the reason. */
export function promoteRefusedDetail(params: BacklogPromoteParams): Record<string, unknown> {
  return { requestedKey: params.key ?? null };
}
