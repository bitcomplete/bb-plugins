// The backlog steward's promotion write (BB-385), as pure functions: the WIP
// ceiling, the ordering, the eligibility rules, the authority limits and the
// ledger entry shape. Nothing here reads a file, a source or the store;
// server.ts hands the values in and writes the plan through the source
// contract. Keeping the limits here is the point: the playbook says them, but
// the plugin enforces them.
import { z } from "zod";

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
  /** The team the binding watches. */
  team: string;
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
 * Whether an issue sits in Todo or In Progress, the two states the WIP
 * ceiling counts. This is by state name, not state type: "In Review" is a
 * `started` state in Linear's BB team, and a ticket in review is not work in
 * progress for the ceiling.
 */
export function isTodoOrInProgress(issue: BacklogPromoteIssue): boolean {
  const name = issue.state.trim().toLowerCase();
  return name === "todo" || name === "in progress";
}

/** Whether an issue sits in the team's Backlog state. */
export function isBacklogState(issue: BacklogPromoteIssue): boolean {
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

/** How many Todo or In Progress issues the team has, the WIP ceiling's numerator. */
export function wipCount(issues: readonly BacklogPromoteIssue[], config: PromoteConfig): number {
  return issues.filter((issue) => sameTeam(issue, config) && isTodoOrInProgress(issue)).length;
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
  const rank = (issue: BacklogPromoteIssue): number => PRIORITY_RANK[(issue.priority ?? "").trim().toLowerCase()] ?? 4;
  return issues.filter((issue) => sameTeam(issue, config) && isBacklogState(issue) && !isAdopted(issue, config)).sort((a, b) => rank(a) - rank(b) || createdAtMs(a) - createdAtMs(b) || a.key.localeCompare(b.key));
}

/** The one plan a promotion writes: Todo, the adoption label, and this server's own login. */
export function promotePlan(candidate: BacklogPromoteIssue, config: PromoteConfig): PromotePlan {
  return { key: candidate.key, state: PROMOTE_STATE, addLabels: [config.label], assignee: PROMOTE_ASSIGNEE };
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
  return { state: PROMOTE_STATE, addLabels: [config.label], assignee: PROMOTE_ASSIGNEE, requestedKey: params.key ?? null, promoted: candidate.key };
}

/** The ledger detail for a refused promotion, so the digest can show the reason. */
export function promoteRefusedDetail(params: BacklogPromoteParams): Record<string, unknown> {
  return { requestedKey: params.key ?? null };
}
