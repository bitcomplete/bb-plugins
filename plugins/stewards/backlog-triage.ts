// The backlog steward's triage writes (BB-341), as pure functions: the fixed
// label vocabulary, the allowlist, the adoption check, the priority rule, the
// comment budget and the ledger entry shape. Nothing here reads a file, a
// source or the store; server.ts hands the values in and writes the plan
// through the source contract. Keeping the limits here is the point: the
// playbook says them, but the plugin enforces them.
import { z } from "zod";
import { signedBy, type SnapshotComment, type Source } from "./source-contract.js";

/** The kind labels a triage write may add, exactly. */
export const BACKLOG_TRIAGE_KINDS = ["bug", "feature", "chore"] as const;
/** The size labels a triage write may add, exactly; the vocabulary is `size:S|M|L`. */
export const BACKLOG_TRIAGE_SIZES = ["S", "M", "L"] as const;
/** The priorities a triage write may set. */
export const BACKLOG_TRIAGE_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type BacklogPriority = (typeof BACKLOG_TRIAGE_PRIORITIES)[number];
/** The only relation kinds a triage write may add; `blocks` is deliberately not one. */
export const BACKLOG_TRIAGE_RELATION_TYPES = ["duplicate", "blockedBy", "related"] as const;
export type BacklogRelationType = (typeof BACKLOG_TRIAGE_RELATION_TYPES)[number];

/**
 * Fields that are never part of a triage write. The tool's schema is strict,
 * so a call carrying one is rejected before it runs; this list is the second
 * check, so the pure decision refuses one too (a bug in the wiring cannot
 * smuggle a description, state, assignee, cancel or close through).
 */
export const FORBIDDEN_TRIAGE_FIELDS = ["description", "state", "assignee", "cancel", "close"] as const;

/** The rolling comment window, in milliseconds. */
export const BACKLOG_COMMENT_WINDOW_MS = 7 * 86_400_000;

/** The fixed vocabulary and the `repo:` names two repositories share (which are refused, not guessed). */
export type BacklogVocabulary = { labels: Map<string, string>; ambiguous: Map<string, string[]> };

/**
 * The fixed label vocabulary: the three kinds, the three sizes, and one
 * `repo:<name>` per repository in the project's `repos.json`, where `<name>`
 * is the repo name after the owner (the spec's `repo:<name>`). A name two
 * repositories share is ambiguous and is refused rather than guessed. The
 * adoption label, `initiative` and any label a playbook adopts on are never
 * in it, whatever the configuration says.
 */
export function backlogLabelVocabulary(repos: readonly string[]): BacklogVocabulary {
  const labels = new Map<string, string>();
  for (const kind of BACKLOG_TRIAGE_KINDS) labels.set(kind.toLowerCase(), kind);
  for (const size of BACKLOG_TRIAGE_SIZES) labels.set(`size:${size}`.toLowerCase(), `size:${size}`);
  const byName = new Map<string, string[]>();
  for (const repo of repos) {
    const name = repo.slice(repo.lastIndexOf("/") + 1);
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), repo]);
  }
  const ambiguous = new Map<string, string[]>();
  for (const [name, full] of byName) {
    const key = `repo:${name}`.toLowerCase();
    if (full.length > 1) ambiguous.set(key, full);
    else labels.set(key, `repo:${name}`);
  }
  return { labels, ambiguous };
}

export const backlogRelationSchema = z.object({ type: z.enum(BACKLOG_TRIAGE_RELATION_TYPES), issue: z.string().trim().min(1).max(200) }).strict();
export type BacklogRelation = z.infer<typeof backlogRelationSchema>;

/**
 * The one gated tool's parameters. `comment` is a body the plugin signs; the
 * optional `proposeCancel` marks it as the stale-cancel proposal rather than a
 * question, so the stale window is enforced on the right kind of comment.
 */
export const backlogTriageParamsSchema = z
  .object({
    key: z.string().trim().min(1).max(200),
    addLabels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    relations: z.array(backlogRelationSchema).max(20).optional(),
    priority: z.enum(["none", ...BACKLOG_TRIAGE_PRIORITIES]).optional(),
    comment: z.string().trim().min(1).max(20_000).optional(),
    proposeCancel: z.boolean().optional(),
  })
  .strict();
export type BacklogTriageParams = z.infer<typeof backlogTriageParamsSchema>;

/** One row of the triage ledger: every accepted write and every refusal. */
export const backlogWriteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  team: z.string(),
  issueId: z.string(),
  issueKey: z.string(),
  at: z.number(),
  outcome: z.enum(["accepted", "refused"]),
  kind: z.enum(["label", "relation", "priority", "comment", "triage", "promote"]),
  detail: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().nullable().default(null),
});
export type BacklogWrite = z.infer<typeof backlogWriteSchema>;

/** What the tool read about the target ticket, enough for every rule. */
export type TriageTicket = {
  key: string;
  /** The team key the ticket lives in, as the snapshot reports it. */
  unit: string;
  labels: string[];
  /** Linear's priority label as the snapshot carries it ("High", "No priority"), or null. */
  priority: string | null;
  state: string;
  stateType: string | null;
  assignees: string[];
  updatedAt: string | null;
  comments: SnapshotComment[];
};

/** The project's backlog limits and the fixed labels no write may touch. */
export type TriageConfig = {
  triage: boolean;
  /** The unit the binding watches: a Linear team key, or a GitHub `owner/repo`. */
  team: string;
  /**
   * The backlog source the target reads and writes through (BB-397). Optional
   * and defaulting to `linear`, so the Linear call sites and tests are
   * unchanged. GitHub has no issue priority and no issue relations, so a plan
   * that asks for either is refused before any write.
   */
  source?: Source;
  commentsPerWeek: number;
  staleDays: number;
  /** The project's adoption label (project.label). */
  label: string;
  /** Labels a triage write may never add: the adoption label, initiative, and any a playbook adopts on. */
  adoptedLabels: string[];
  /** The project's repos, as owner/name; the `repo:` vocabulary is built from them. */
  repos: string[];
};

/** The plan a decision accepted, ready to write through the source contract. */
export type TriagePlan = {
  addLabels: string[];
  relations: BacklogRelation[];
  /** `null` is no priority write, `"none"` clears it, and a value sets it. */
  priority: BacklogPriority | "none" | null;
  comment: { body: string; kind: "question" | "stale" } | null;
};

export type TriageDecision = { ok: true; plan: TriagePlan } | { ok: false; reason: string };

const PRIORITY_SET = new Set<string>(BACKLOG_TRIAGE_PRIORITIES);

/** Linear's priority label ("High", "No priority", …) as the four values, or null when unset. */
export function normalizePriority(raw: string | null | undefined): BacklogPriority | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "no priority" || v === "none" || !PRIORITY_SET.has(v) ? null : (v as BacklogPriority);
}

/** Whether a raw priority is one the tool can reason about: unset, one of the four, or hand-set (unknown). */
function priorityState(raw: string | null | undefined): { state: "unset" } | { state: "known"; value: BacklogPriority } | { state: "hand" } {
  if (raw === null || raw === undefined) return { state: "unset" };
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "no priority" || v === "none") return { state: "unset" };
  return PRIORITY_SET.has(v) ? { state: "known", value: v as BacklogPriority } : { state: "hand" };
}

/** The last priority the steward wrote for a ticket, or null. */
export function lastStewardPriority(ledger: readonly BacklogWrite[]): BacklogPriority | "none" | null {
  let found: BacklogPriority | "none" | null = null;
  for (const entry of ledger) {
    if (entry.outcome !== "accepted" || entry.kind !== "priority") continue;
    const value = entry.detail.priority;
    if (value === "none" || (typeof value === "string" && PRIORITY_SET.has(value))) found = value as BacklogPriority | "none";
  }
  return found;
}

/** The accepted comments for a ticket within the rolling window. */
export function commentsInWindow(ledger: readonly BacklogWrite[], now: number): BacklogWrite[] {
  return ledger.filter((e) => e.outcome === "accepted" && e.kind === "comment" && e.at > now - BACKLOG_COMMENT_WINDOW_MS);
}

/** The latest accepted question, or null. */
export function lastQuestion(ledger: readonly BacklogWrite[]): BacklogWrite | null {
  let found: BacklogWrite | null = null;
  for (const entry of ledger) {
    if (entry.outcome === "accepted" && entry.kind === "comment" && entry.detail.kind === "question") found = entry;
  }
  return found;
}

/**
 * Whether the requester (any human) has written after the question. A comment
 * signed by a bb thread is the plugin's own, so it never answers one.
 */
export function questionAnswered(question: BacklogWrite, comments: readonly SnapshotComment[]): boolean {
  return comments.some((c) => c.signedBy === null && Date.parse(c.createdAt) > question.at);
}

const day = 86_400_000;

/**
 * The whole rule set, in one pure decision. The caller reads the ticket, the
 * binding and the ledger first (a read that fails is the caller's to refuse);
 * this returns the exact plan to write, or the reason it refused.
 */
export function decideTriage(input: {
  params: BacklogTriageParams;
  ticket: TriageTicket;
  config: TriageConfig;
  ledger: readonly BacklogWrite[];
  bound: boolean;
  now: number;
  /** Team per related issue key, lowercased; missing means the relation could not be checked. */
  relatedTeams: ReadonlyMap<string, string>;
  /** The comment body with the plugin's signature line already appended, when one was given. */
  signedComment: string | null;
}): TriageDecision {
  const { params, ticket, config, ledger, bound, now, relatedTeams, signedComment } = input;
  const refuse = (reason: string): TriageDecision => ({ ok: false, reason });

  if (!config.triage) return refuse("backlog.triage is off; the backlog steward is read-only");

  for (const field of FORBIDDEN_TRIAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, field)) return refuse(`a triage write may not carry ${field}; it only adds labels, relations, priority and a comment`);
  }

  // GitHub has no issue priority and no issue relations, so a plan that asks
  // for either is refused here, before any write reaches the source. It is a
  // refusal, not a silent drop: the caller records it in the ledger.
  const source = config.source ?? "linear";
  if (source !== "linear") {
    if (params.priority !== undefined) return refuse(`${ticket.key} is on a GitHub backlog; GitHub issues have no priority, so the priority write is refused`);
    if ((params.relations ?? []).length > 0) return refuse(`${ticket.key} is on a GitHub backlog; GitHub issues have no relations, so the relation write is refused`);
  }

  // The binding watches one unit: a ticket in another team or repository is
  // never touched, even when it is visible to the same user. The comparison is
  // case-insensitive for both a Linear team key and a GitHub owner/repo.
  if (ticket.unit.trim().toUpperCase() !== config.team.trim().toUpperCase()) {
    return refuse(`${ticket.key} is in ${ticket.unit}, not the watched team ${config.team}`);
  }

  // GitHub has no state type, so a closed issue is caught by its state rather
  // than Linear's completed/canceled types. A closed issue is never triaged.
  if (source === "github" && ticket.state.trim().toLowerCase().startsWith("closed")) {
    return refuse(`${ticket.key} is ${ticket.state}; only open issues are triaged`);
  }

  // The target must be un-adopted: nothing bound, nothing in an adopted state,
  // and nothing labelled for adoption that is also assigned.
  if (bound) return refuse(`${ticket.key} is already bound; the backlog steward only touches un-adopted tickets`);
  if (ticket.stateType !== null && ["started", "completed", "canceled"].includes(ticket.stateType.toLowerCase())) {
    return refuse(`${ticket.key} is ${ticket.stateType}; only un-adopted tickets are triaged`);
  }
  const adoption = config.label.trim().toLowerCase();
  if (adoption !== "" && ticket.labels.some((l) => l.trim().toLowerCase() === adoption) && ticket.assignees.length > 0) {
    return refuse(`${ticket.key} carries ${config.label} and is assigned; it is adopted`);
  }

  // Labels: the fixed vocabulary only, add-only, never an adoption label.
  const vocab = backlogLabelVocabulary(config.repos);
  const adopted = new Set(config.adoptedLabels.map((l) => l.trim().toLowerCase()));
  const addLabels: string[] = [];
  for (const raw of params.addLabels ?? []) {
    const label = raw.trim();
    if (label === "") continue;
    const lower = label.toLowerCase();
    if (adopted.has(lower)) return refuse(`${label} is an adoption label; the triage vocabulary never adds one`);
    const shared = vocab.ambiguous.get(lower);
    if (shared !== undefined) return refuse(`${label} is ambiguous: ${shared.join(", ")} share the name`);
    const canonical = vocab.labels.get(lower);
    if (canonical === undefined) return refuse(`${label} is not in the triage vocabulary (kind, repo:<name>, size:S|M|L)`);
    if (!addLabels.includes(canonical)) addLabels.push(canonical);
  }

  // Relations: the three allowed kinds, both ends in the team, never the
  // ticket itself, add-only.
  const relations: BacklogRelation[] = [];
  for (const relation of params.relations ?? []) {
    const issue = relation.issue.trim();
    if (issue.toLowerCase() === ticket.key.toLowerCase()) return refuse(`a triage write cannot relate ${ticket.key} to itself`);
    const team = relatedTeams.get(issue.toLowerCase());
    if (team === undefined) return refuse(`the ${relation.type} relation to ${issue} could not be checked (its team could not be read)`);
    if (team.trim().toUpperCase() !== config.team.trim().toUpperCase()) return refuse(`the ${relation.type} relation to ${issue} is in ${team}, not ${config.team}; both ends must be in the team`);
    relations.push({ type: relation.type, issue });
  }

  // Priority: unset or last set by the steward. Anything else was set by hand.
  // A priority the ledger did not write is hand-set and is never changed; the
  // steward may set one when it is unset, and change one it set itself.
  let priority: BacklogPriority | "none" | null = null;
  if (params.priority !== undefined) {
    const current = priorityState(ticket.priority);
    const last = lastStewardPriority(ledger);
    const stewardSet = current.state === "known" && last !== null && last !== "none" && last === current.value;
    if (current.state === "hand") return refuse(`${ticket.key} has a priority the steward did not set; it is never changed`);
    if (current.state === "known" && !stewardSet) return refuse(`${ticket.key} has a hand-set priority (${ticket.priority}); the steward never changes it`);
    // `none` is carried, not flattened to null: clearing a priority the
    // steward set is a write, and an empty plan must not swallow it.
    priority = params.priority;
  }

  // Comment: signed, within the budget, one open question, and the stale
  // proposal only when the ticket is stale.
  let comment: TriagePlan["comment"] = null;
  if (params.comment !== undefined) {
    if (signedComment === null || signedBy(signedComment) === null) return refuse("a comment must end with the bb thread signature line; nothing was posted");
    const used = commentsInWindow(ledger, now).length;
    if (used >= config.commentsPerWeek) return refuse(`${ticket.key} already has ${used} comment${used === 1 ? "" : "s"} this week; the budget is ${config.commentsPerWeek}`);
    if (params.proposeCancel === true) {
      const updated = ticket.updatedAt === null ? Number.NaN : Date.parse(ticket.updatedAt);
      if (Number.isNaN(updated) || now - updated < config.staleDays * day) return refuse(`${ticket.key} is not stale (untouched ${config.staleDays}d); no cancel is proposed`);
      comment = { body: signedComment, kind: "stale" };
    } else {
      const question = lastQuestion(ledger);
      if (question !== null && !questionAnswered(question, ticket.comments)) return refuse(`${ticket.key} has an open question; no second one until the requester replies`);
      comment = { body: signedComment, kind: "question" };
    }
  }

  return { ok: true, plan: { addLabels, relations, priority, comment } };
}

/** Whether a plan actually asks Linear to do anything. */
export const planIsEmpty = (plan: TriagePlan): boolean => plan.addLabels.length === 0 && plan.relations.length === 0 && plan.priority === null && plan.comment === null;
