// The PR inventory, the front door: every open PR you author, and every PR an
// effort names as a member, grouped by the effort that owns it (explicitly or
// through its ticket), with "No effort" last. Each row says who reviews it, its
// state in the board's words, what needs attention with the next step, its
// owner, and its age, when GitHub last answered for it, and who works on it.
// Pure: the server gathers the facts; this shapes and counts them.
import { z } from "zod";
import type { Pr } from "./contract.js";
import type { PrObservation } from "./inventory-store.js";
import { attentionReasonSchema, type AttentionReason } from "./pr-attention.js";
import { EFFORT_PILES } from "./effort-piles.js";
import { prHoldSchema, type PrHold } from "./pr-holds.js";
import { blockerFor, stageFor, PIPELINE_STAGES } from "./pr-stage.js";
import type { ResolvedThreadLink } from "./work-context.js";
import { compactAge, displayTitle, prLifecycle, relativeTime } from "./workstreams.js";
import { prTarget } from "./ghactions.js";
import { userConfirmationSchema } from "./approval-evidence.js";
import { dismissed, sentSchema, yourTurn, yourTurnSchema, type Dismissal, type Sent } from "./your-turn.js";

export const INVENTORY_QUESTIONS = ["forgotten-draft", "missing-reviewer", "needs-nudge"] as const;
/** Every action a row records, as inventory-actions.ts takes them. */
export const INVENTORY_ACTIONS = ["mark-ready", "request-review", "nudge", "confirm-handled", "ask-thread", "ask-fix", "revoke-confirmation"] as const;
export type InventoryQuestion = (typeof INVENTORY_QUESTIONS)[number];

const threadSchema = z.object({ id: z.string(), title: z.string(), active: z.boolean() }).strict();
export const inventoryRowSchema = z.object({
  prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(),
  /** False for a PR an effort names that someone else authored: the inventory reads its checkout. */
  authored: z.boolean(),
  reviewers: z.object({ requested: z.array(z.string()), reviewed: z.array(z.object({ login: z.string(), state: z.string(), submittedAt: z.string().optional() }).strict()) }).strict(),
  /** The board's stage, and its state word there. */
  stage: z.enum(PIPELINE_STAGES).nullable(), status: z.string(),
  /** Your open PR in its repository that this one of yours is stacked on, by number: file this row under that one, which merges first. */
  stackedOn: z.number().nullable(),
  draft: z.boolean().nullable(), head: z.string().nullable(),
  /** The approval comments' fingerprint, when approving reviews left any: Confirm handled sends it back with `head`. */
  feedbackFingerprint: z.string().nullable(),
  attention: z.array(attentionReasonSchema),
  /** Reviewer feedback on your PR that waits on your move (your-turn.ts), held or not; null on a teammate's PR. turnOf says where it lists. */
  yourTurn: yourTurnSchema.nullable(),
  /** You dismissed it from Your turn on this head, and no person has said anything since. */
  dismissed: z.boolean(),
  /** The last read GitHub answered, and the last it didn't, with why, while no read since has succeeded. */
  checkedAt: z.string().nullable(), failure: z.object({ at: z.string(), error: z.string().nullable() }).strict().nullable(),
  /** The last full inventory read no longer listed it, or couldn't read it. */
  stale: z.boolean(),
  hold: prHoldSchema.nullable(),
  /** The thread the work started in, and the one working on it now or last. */
  threads: z.object({ origin: threadSchema.nullable(), executor: threadSchema.nullable() }).strict(),
  /** The batch thread whose claim holds the PR while it addresses the feedback, by id and title, both null while it starts. */
  addressing: z.object({ threadId: z.string().nullable(), title: z.string().nullable() }).strict().nullable(),
  /** Where the newest Address batch sent it, and its thread's live status, for as long as the PR is open. */
  sent: sentSchema.nullable(),
  /** Whom to ask for review: this PR's past reviewers, then its repository's most recent ones. */
  suggestedReviewers: z.array(z.string()),
  /** Your confirmation of its approval's notes, at any age: whether it still covers this head and these notes, and whether evidence backed it. */
  confirmation: userConfirmationSchema.nullable(),
  /** What the last inventory action on the PR did, or why it was refused. */
  lastAction: z.object({ at: z.number(), action: z.enum(INVENTORY_ACTIONS), ok: z.boolean(), detail: z.string(),
    reviewers: z.array(z.string()) }).strict().nullable(),
}).strict();
export type InventoryRow = z.infer<typeof inventoryRowSchema>;
/** `pile` is the effort's pile, or archived, which the server always says: All PRs writes nothing to a held, done, or archived effort's PRs. */
const effortSchema = z.object({ id: z.string(), name: z.string(), pile: z.enum([...EFFORT_PILES, "archived"]).optional() }).strict();
export const inventoryViewSchema = z.object({
  /** One group per effort that owns a row, by name, then "No effort" (a null effort). */
  groups: z.array(z.object({ effort: effortSchema.nullable(), rows: z.array(inventoryRowSchema) }).strict()),
  /** Rows with at least one reason of each question, across every row, whatever the filter. */
  counts: z.object({ "forgotten-draft": z.number(), "missing-reviewer": z.number(), "needs-nudge": z.number() }).strict(),
  /** The last complete read, and the last attempt, of your authored PRs. */
  checkedAt: z.string().nullable(), attemptedAt: z.string().nullable(), refreshing: z.boolean(),
  /** GitHub's rate limit holds reads until then. */
  rateLimitedUntil: z.number().nullable(),
  warnings: z.array(z.string()),
}).strict();
export type InventoryView = z.infer<typeof inventoryViewSchema>;

export type ThreadRef = { title: string | null; titleFallback: string | null; status: string; updatedAt: number };
/** Everything one row reads. `pr` is null for a PR an effort names that nothing on the board has read. */
export type InventoryRowInput = {
  prUrl: string; pr: Pr | null; authored: boolean; stale: boolean;
  reasons: readonly AttentionReason[]; hold: PrHold | null; observation: PrObservation | null; stackedOn: number | null;
  links: readonly ResolvedThreadLink[];
  threads: ReadonlyMap<string, ThreadRef>;
  suggestedReviewers: readonly string[];
  lastAction: NonNullable<InventoryRow["lastAction"]> | null;
  confirmation?: InventoryRow["confirmation"];
  addressing?: InventoryRow["addressing"];
  sent?: Sent | null;
  dismissal?: Dismissal | null;
};

const EXECUTORS = new Set(["advance", "run", "worker"]);

/** The thread a PR's work started in, and the one working on it now or last, as its row and its Open thread name them. */
export function rowThreads(input: Pick<InventoryRowInput, "links" | "threads">): InventoryRow["threads"] {
  const thread = (id: string | null | undefined): InventoryRow["threads"]["origin"] => {
    const known = id ? input.threads.get(id) : undefined;
    return id && known ? { id, title: (known.title ?? known.titleFallback ?? id).slice(0, 200), active: known.status === "active" } : null;
  };
  const known = (link: ResolvedThreadLink) => input.threads.has(link.threadId);
  // Where the work started: a thread started for its ticket, or one whose metadata names the PR.
  const origin = input.links.find((link) => known(link) && link.tier === "started" && link.sources.some((source) => source === "cluster" || source === "metadata"));
  // Who works on it: the busiest, newest legacy worker or run thread.
  const executor = input.links.filter((link) => known(link) && link.sources.some((source) => EXECUTORS.has(source)))
    .sort((a, b) => Number(input.threads.get(b.threadId)!.status === "active") - Number(input.threads.get(a.threadId)!.status === "active") ||
      input.threads.get(b.threadId)!.updatedAt - input.threads.get(a.threadId)!.updatedAt)[0]?.threadId;
  return { origin: thread(origin?.threadId), executor: thread(executor) };
}

export function inventoryRow(input: InventoryRowInput): InventoryRow {
  const { pr, observation, stackedOn } = input;
  const stage = pr === null ? null : stageFor(prLifecycle(pr), pr, stackedOn);
  const target = prTarget(input.prUrl);
  const turn = input.authored && pr ? yourTurn(pr) : null;
  return {
    prUrl: input.prUrl, repo: target?.slug ?? "", number: target?.number ?? 0,
    title: displayTitle(pr?.title ?? ""), authored: input.authored,
    reviewers: { requested: pr?.reviewRequests ?? [], reviewed: (pr?.latestReviews ?? []).filter((review) => review.state !== "PENDING") },
    stage, status: pr && stage ? blockerFor(pr, stage, input.hold, stackedOn, input.stale).label : "Not read yet",
    stackedOn,
    draft: pr?.isDraft ?? null, head: pr?.headRefOid ?? null,
    feedbackFingerprint: pr?.approvalFeedback?.fingerprint ?? null,
    attention: [...input.reasons],
    yourTurn: turn, dismissed: dismissed(input.dismissal, pr?.headRefOid ?? null, turn),
    checkedAt: observation?.checkedAt ?? null,
    failure: observation?.failedAt ? { at: observation.failedAt, error: observation.error ?? null } : null,
    stale: input.stale, hold: input.hold,
    threads: rowThreads(input), addressing: input.addressing ?? null, sent: input.sent ?? null,
    suggestedReviewers: [...input.suggestedReviewers], confirmation: input.confirmation ?? null,
    lastAction: input.lastAction && { at: input.lastAction.at, action: input.lastAction.action, ok: input.lastAction.ok, detail: input.lastAction.detail,
      reviewers: input.lastAction.reviewers },
  };
}

/** Rows by effort, "No effort" last; only rows with a reason of `only`'s question when given. Counts always cover every row. */
export function inventoryView(rows: readonly (InventoryRow & { effort: InventoryView["groups"][number]["effort"] })[],
  meta: Omit<InventoryView, "groups" | "counts">, only?: InventoryQuestion): InventoryView {
  const asks = (row: InventoryRow, question: InventoryQuestion) => row.attention.some((reason) => reason.question === question);
  const groups = new Map<string, InventoryView["groups"][number]>();
  for (const { effort, ...row } of rows) {
    if (only && !asks(row, only)) continue;
    const key = effort?.id ?? "";
    const group = groups.get(key) ?? { effort, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  return {
    groups: [...groups.values()].sort((a, b) => Number(a.effort === null) - Number(b.effort === null) ||
      (a.effort?.name ?? "").localeCompare(b.effort?.name ?? "") || (a.effort?.id ?? "").localeCompare(b.effort?.id ?? "")),
    counts: Object.fromEntries(INVENTORY_QUESTIONS.map((question) => [question, rows.filter((row) => asks(row, question)).length])) as InventoryView["counts"],
    ...meta,
  };
}

/** The plain list the CLI prints: `repo #n · title · reviewers · status · next steps (owner, age) · checked`. */
export function inventoryText(view: InventoryView, now: number): string {
  const { counts } = view;
  const lines = [`${counts["forgotten-draft"]} forgotten in draft · ${counts["missing-reviewer"]} missing a reviewer · ${counts["needs-nudge"]} need a nudge · ` +
    `last read ${relativeTime(view.checkedAt, now)}${view.refreshing ? " · reading now" : ""}`];
  if (view.rateLimitedUntil !== null) lines.push(`GitHub rate limit: the next read waits until ${new Date(view.rateLimitedUntil).toISOString()}.`);
  for (const group of view.groups) {
    lines.push(group.effort?.name ?? "No effort");
    for (const row of group.rows) {
      const reviewers = [...row.reviewers.requested.map((login) => `@${login} (requested)`),
        ...row.reviewers.reviewed.map((review) => `@${review.login} (${review.state.toLowerCase().replace(/_/gu, " ")})`)].join(", ") || "no reviewer";
      const steps = row.attention.map((reason) => `${reason.nextStep} (${reason.owner}${reason.since === null ? "" : `, ${compactAge(reason.since, now)}`})`);
      lines.push(`  ${[`${row.repo} #${row.number}`, row.title || "—", reviewers, row.status, ...steps,
        row.failure ? `read failed ${relativeTime(row.failure.at, now)}${row.failure.error ? `: ${row.failure.error}` : ""}` : `checked ${relativeTime(row.checkedAt, now)}`,
        ...row.hold ? [row.hold.reason ? `held: ${row.hold.reason}` : "held"] : [],
        ...row.lastAction ? [`last ${row.lastAction.action}${row.lastAction.ok ? "" : " refused"} ${relativeTime(new Date(row.lastAction.at).toISOString(), now)}`] : []].join(" · ")}`);
    }
  }
  if (view.groups.length === 0) lines.push("Nothing to show.");
  return lines.concat(view.warnings.map((warning) => `Warning: ${warning}`)).join("\n");
}
