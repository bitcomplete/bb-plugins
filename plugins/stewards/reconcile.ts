// The mechanical tier's decisions, as pure functions: what changed between two
// observations of an entity, which of those changes are worth a judgment
// turn, where the ready gate stands, and when a binding counts as stuck.
// server.ts fetches, stores and wakes; nothing here talks to anything.
//
// The rule throughout: an event is a hint to look again, never the input a
// decision is made from. Every function here compares two states.
import { createHash } from "node:crypto";
import { isTerminal, labelPhaseName, phaseOf, type Playbook } from "./config.js";
import type { Deployments } from "./deploy.js";
import { isMarkerComment, latestReviewMarker, reviewMarker } from "./gate.js";
import { gateState, reportedItem } from "./ready-gate.js";
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";
import type { Binding, Escalation, Need, Observed, ReadyState, StatusRecord, Worker } from "./store.js";

/**
 * One line of "what changed", and whether it alone makes a judgment turn due.
 * `own` marks the steward's own doing (its signed description edit), which is
 * news to nobody above it.
 */
export type Change = { text: string; actionable: boolean; own?: boolean; byUser?: boolean };

/**
 * A worker is in flight from its spawn until it is stopped, failed or
 * archived. Its turn ending is a pause, not a finish: a worker waits on its
 * reviewer, is woken again, and pushes again. Own-pull-request activity is
 * the worker's while any worker of the binding is in flight (criterion 1).
 */
export const workerInFlight = (w: Pick<Worker, "status">): boolean => w.status === "running" || w.status === "finished";
export const anyWorkerInFlight = (workers: readonly Pick<Worker, "status">[]): boolean => workers.some(workerInFlight);

/**
 * A worker whose turn is in progress. A `finished` worker is a pause between
 * turns, not a running one: it can no longer race a push, so a merge item
 * must not deadlock behind it (BB-175).
 */
export const workerRunning = (w: Pick<Worker, "status">): boolean => w.status === "running";

/**
 * Why a merge item is not actionable while a worker's turn is in progress,
 * naming each such worker so the page says something true (BB-175). Null when
 * none is running; a `finished` worker does not count.
 */
export function runningWorkerReason(workers: readonly Pick<Worker, "threadId" | "status">[]): string | null {
  const running = workers.filter(workerRunning);
  if (running.length === 0) return null;
  const names = running.map((w) => w.threadId);
  return names.length === 1 ? `worker ${names[0]} is mid-turn` : `workers ${names.join(", ")} are mid-turn`;
}



/**
 * A change in the lane a reviewer's rounds are in: the one thing about a
 * `bb-review` marker the steward hears while a worker is in flight.
 */
export function markerLaneChange(before: readonly SnapshotComment[], after: readonly SnapshotComment[]): { from: string; to: string } | null {
  const b = latestReviewMarker(before);
  const a = latestReviewMarker(after);
  if (b === null || a === null || b.lane === null || a.lane === null || b.lane === a.lane) return null;
  return { from: b.lane, to: a.lane };
}


/**
 * The product inputs `prGate` reads from a binding (BB-207). A review or PR
 * binding's `substantial` is the reviewer's diff judgment: the `bb-review`
 * marker carries it (`substantial=yes|no`) and is the newest word, so it wins;
 * a review steward's report (`steward_report { ready: { substantial, why } }`)
 * is the fallback when the marker did not name one. The marker's `spec=yes|no`
 * says whether a ticket the pull request references has an approved spec, the
 * ack that spares the owner the ask.
 *
 * A ticket binding's own `ready.substantial` is the spec gate's judgment, a
 * different thing from the diff's, so the diff judgment is read only from the
 * marker on its pull request; its own `ready.approval` is the ack. Unjudged
 * (null) leaves every lane exactly as before, which is what keeps the change
 * inert until a reviewer reports a verdict.
 */
export function productGateOptions(b: Pick<Binding, "kind" | "ready">, pull?: EntitySnapshot | null): { substantial: boolean | null; ticketApprovedSpec: boolean } {
  // `ready` is always present on a stored binding; the guard keeps a partial
  // caller (a unit test's stub) from throwing, and unjudged stays null.
  const ready: ReadyState | null | undefined = b.ready;
  const marker = pull === undefined || pull === null ? null : latestReviewMarker(pull.comments);
  if (b.kind === "ticket") {
    return { substantial: marker?.substantial ?? null, ticketApprovedSpec: ready?.approval != null };
  }
  return { substantial: marker?.substantial ?? ready?.substantial ?? null, ticketApprovedSpec: marker?.ticketApprovedSpec ?? false };
}

/**
 * A spec comment is a signed comment that starts by saying so. The steward's
 * own count, and so do the user's: a thread the user runs themselves is
 * treated as the user's own words (an amendment carries its own approval
 * when the approver is `user`). `isUserThread` says whether a signing thread is
 * the user's rather than a steward, worker or the project steward; without it
 * only the steward's own comments count.
 */
export const isSpecComment = (c: SnapshotComment, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): boolean =>
  c.signedBy !== null && /^\s*(\*\*)?spec\b/iu.test(c.body) && (c.signedBy === stewardThreadId || (isUserThread?.(c.signedBy) ?? false));

/**
 * What an approval is pinned to: the description and the spec comments. The
 * steward's own and the user's (a thread the user runs) both count. Any
 * change to either changes the hash. The signature line is left out of the
 * description, so the steward's own signed edit hashes the same as the text
 * it wrote.
 */
const DESCRIPTION_SIGNATURE = /\s*_— from bb thread ([A-Za-z0-9_-]+)_\s*$/u;

/** The thread that signed the description, when its last edit was signed. */
export const descriptionSignedBy = (entity: EntitySnapshot): string | null => DESCRIPTION_SIGNATURE.exec(entity.description ?? "")?.[1] ?? null;

/**
 * The text an approval is pinned to: the description with its signature line
 * removed, then each spec comment as `<id>\n<body>`, joined by a NUL
 * separator. `specHash` hashes exactly this, and BB-249 stores it as the
 * approval's `approvedText` so a later edit can be diffed against it.
 */
export function specText(entity: EntitySnapshot, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): string {
  const description = (entity.description ?? "").replace(DESCRIPTION_SIGNATURE, "").trim();
  const specs = entity.comments.filter((c) => isSpecComment(c, stewardThreadId, isUserThread)).map((c) => `${c.id}\n${c.body}`);
  return [description, ...specs].join("\n\u0000\n");
}

export function specHash(entity: EntitySnapshot, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): string {
  return createHash("sha256").update(specText(entity, stewardThreadId, isUserThread)).digest("hex").slice(0, 16);
}

/**
 * A comment that explains a spec edit: a signed comment that starts `Spec:`,
 * `Criteria:` or `Revision:`. This is deliberately wider than `isSpecComment`
 * (which only counts `Spec:` because it feeds the spec hash); the link on a
 * re-approval may point at a criteria or revision comment, and widening the
 * hash predicate would change every pinned hash.
 */
export const isEditComment = (c: SnapshotComment, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): boolean =>
  c.signedBy !== null && /^\s*(\*\*)?(?:spec|criteria|revision)\b/iu.test(c.body) && (c.signedBy === stewardThreadId || (isUserThread?.(c.signedBy) ?? false));

/**
 * The comment that explains the latest edit: the newest signed
 * `Spec:`/`Criteria:`/`Revision:` comment with a link, created after `since`
 * (the last approval's time), so a re-approval item points at the comment
 * that explains this edit and not an older one. Null when there is none.
 */
export function newestEditComment(entity: EntitySnapshot, stewardThreadId: string | null, isUserThread: ((threadId: string) => boolean) | undefined, since: number): SnapshotComment | null {
  const comments = entity.comments.filter((c) => isEditComment(c, stewardThreadId, isUserThread) && c.url !== null && c.url !== "" && Date.parse(c.createdAt) > since);
  let newest: SnapshotComment | null = null;
  for (const c of comments) if (newest === null || c.createdAt > newest.createdAt) newest = c;
  return newest;
}

/** A plain unified diff and the number of changed lines (insertions plus deletions). */
export type SpecDiff = { diff: string; changedLines: number };

/** Two texts that differ only in whitespace: strip it all and compare. */
const withoutWhitespace = (s: string): string => s.replace(/\s+/gu, "");

/** A line's identity for the diff: whitespace is not a change, so a line's key ignores it. */
const lineKey = (line: string): string => line.replace(/\s+/gu, " ").trim();

/** The diff line as it should read: the NUL separator between the description and a spec comment is dropped. */
const displayLine = (line: string): string => line.replace(/\u0000/gu, "");

type DiffOp = { type: "equal" | "del" | "ins"; line: string };

/** A longest-common-subsequence line diff, oldest first. Lines are matched ignoring whitespace. */
function lineOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const a = before.map(lineKey);
  const b = after.map(lineKey);
  // lcs[i][j] is the LCS length of before[i:] and after[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ type: "equal", line: before[i]! }), i++, j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ type: "del", line: before[i]! }), i++;
    else ops.push({ type: "ins", line: after[j]! }), j++;
  }
  while (i < n) ops.push({ type: "del", line: before[i]! }), i++;
  while (j < m) ops.push({ type: "ins", line: after[j]! }), j++;
  return ops;
}

/**
 * The LCS table costs `lines × lines`; a spec is small, but a very large one
 * must not be able to balloon the server's memory on every look. Above this
 * many cells the diff falls back to common prefix and suffix around one block.
 */
const MAX_LCS_CELLS = 4_000_000;

/** The same diff when the LCS table would be too large: keep the common prefix and suffix, mark the rest. */
function coarseOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && lineKey(before[start]!) === lineKey(after[start]!)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && lineKey(before[endB - 1]!) === lineKey(after[endA - 1]!)) {
    endB--;
    endA--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "equal", line: before[i]! });
  for (let i = start; i < endB; i++) ops.push({ type: "del", line: before[i]! });
  for (let i = start; i < endA; i++) ops.push({ type: "ins", line: after[i]! });
  for (let i = endB; i < before.length; i++) ops.push({ type: "equal", line: before[i]! });
  return ops;
}

/**
 * A plain unified diff between an approved spec and the current one, with the
 * number of changed lines. Dependency-free. A difference that is only
 * whitespace has no visible change: the diff is empty and the count is zero,
 * though the spec hash (and so the approval) still changes.
 */
export function specDiff(before: string, after: string, context = 3): SpecDiff {
  if (withoutWhitespace(before) === withoutWhitespace(after)) return { diff: "", changedLines: 0 };
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = a.length * b.length <= MAX_LCS_CELLS ? lineOps(a, b) : coarseOps(a, b);
  const changedLines = ops.filter((o) => o.type !== "equal").length;
  // The line number each op starts at on either side, so a hunk header can name it.
  const beforeAt: number[] = [];
  const afterAt: number[] = [];
  let bn = 1;
  let an = 1;
  for (const o of ops) {
    beforeAt.push(bn);
    afterAt.push(an);
    if (o.type !== "ins") bn++;
    if (o.type !== "del") an++;
  }
  const groups: Array<{ from: number; to: number }> = [];
  ops.forEach((o, idx) => {
    if (o.type === "equal") return;
    const last = groups[groups.length - 1];
    // Merge two changed runs when their context windows would overlap.
    if (last !== undefined && idx - last.to <= context * 2 + 1) last.to = idx;
    else groups.push({ from: idx, to: idx });
  });
  const out: string[] = ["--- approved", "+++ current"];
  for (const g of groups) {
    const from = Math.max(0, g.from - context);
    const to = Math.min(ops.length - 1, g.to + context);
    const slice = ops.slice(from, to + 1);
    const beforeCount = slice.filter((o) => o.type !== "ins").length;
    const afterCount = slice.filter((o) => o.type !== "del").length;
    out.push(`@@ -${beforeAt[from]!},${beforeCount} +${afterAt[from]!},${afterCount} @@`);
    for (const o of slice) out.push(`${o.type === "equal" ? " " : o.type === "del" ? "-" : "+"}${displayLine(o.line)}`);
  }
  return { diff: out.join("\n"), changedLines };
}

/**
 * Comments newer than the cursor that someone other than this steward and its
 * workers wrote, oldest first. Another thread's signed comment is a real
 * comment: it is not this steward's.
 */
export function newHumanComments(entity: EntitySnapshot, cursor: string, own: ReadonlySet<string>): SnapshotComment[] {
  return entity.comments.filter((c) => c.createdAt > cursor && (c.signedBy === null || !own.has(c.signedBy)));
}

/**
 * Whether an answer says something other than the recommendation, whitespace-
 * and case-insensitively. An empty side never differs: there is nothing to
 * reverse. A leading agreement adds nothing, and a negation on only one side
 * flips the meaning. Used by the citation counters, where "differs" is what
 * makes a correction (BB-35 step 2).
 */
const NEGATION = /(?:\b(?:no|not|never|without|avoid|reject|decline|stop|keep)\b|n't\b)/iu;
const AGREEMENT = /^(?:yes|yep|yeah|agreed?|ok(?:ay)?|sure|correct|confirmed|approved|lgtm|sounds good|do it|please do|go ahead)[\s,.:;—-]+/iu;
const words = (s: string): Set<string> => new Set(s.split(/[^a-z0-9']+/u).filter((w) => w !== ""));
const subset = (x: Set<string>, y: Set<string>): boolean => [...x].every((w) => y.has(w));
export function answerDiffers(answer: string, recommendation: string): boolean {
  const a = answer.replace(/\s+/gu, " ").trim().toLowerCase();
  const r = recommendation.replace(/\s+/gu, " ").trim().toLowerCase();
  if (a === "" || r === "") return false;
  if (a === r) return false;
  if (NEGATION.test(a) !== NEGATION.test(r)) return true;
  const aw = words(a.replace(AGREEMENT, ""));
  const rw = words(r);
  return !subset(rw, aw) && !subset(aw, rw);
}

/**
 * Whether a comment is the connected owner's own unsigned words that differ
 * from the recommendation. Only the owner's own unsigned comment can correct a
 * lesson: a signed comment belongs to a thread, and anyone else's words — on
 * Linear or GitHub — never do (BB-35 step 2).
 */
export function commentDiffersFromRecommendation(c: SnapshotComment, viewer: string | null, recommendation: string | null): boolean {
  if (viewer === null || recommendation === null || c.signedBy !== null) return false;
  if (c.author.toLowerCase() !== viewer.toLowerCase()) return false;
  // A marker comment is a thread's, signed or not: never the owner's words (BB-110).
  if (isMarkerComment(c.body)) return false;
  return answerDiffers(c.body, recommendation);
}

export const newestCommentAt = (observed: Observed): string =>
  [observed.entity, ...observed.pulls].flatMap((e) => e.comments.map((c) => c.createdAt)).reduce((a, b) => (a > b ? a : b), "");

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}
const descriptionHash = (e: EntitySnapshot) => createHash("sha256").update(e.description ?? "").digest("hex").slice(0, 16);
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Verbs that say the entity was moved, not that it merely ought to be. */
const SETTING_VERB = /\b(?:set|sets|setting|moved?|moves?|moving|marked?|marks?|marking|put|puts|changed?|changes?|closed?|closes?|closing|merged?|merges?|merging)\b/iu;

/**
 * Whether a worker's final message says it moved this entity to a terminal
 * state (BB-52 rule 4). The entity key and a terminal state name must be near
 * each other on one line and a setting verb must introduce the move (or the
 * key must run straight into the state, "ENG-12: Done"), so
 * "ENG-12 should be Done once the rollout lands" is not one.
 */
export function workerReportedTerminal(result: string | null, entityKey: string, playbook: Playbook): boolean {
  if (result === null || entityKey === "") return false;
  const key = entityKey.toLowerCase();
  for (const line of result.split("\n")) {
    const flat = line.toLowerCase();
    const ki = flat.indexOf(key);
    if (ki < 0) continue;
    for (const state of playbook.terminal) {
      if (state === "") continue;
      const term = state.toLowerCase();
      const si = flat.indexOf(term);
      if (si < 0 || Math.abs(ki - si) > 60) continue;
      const from = Math.max(0, Math.min(ki, si) - 30);
      const span = flat.slice(from, Math.max(ki + key.length, si + term.length));
      const adjacent = new RegExp(`${escapeRegExp(key)}\\s*[:\\-—]\\s*${escapeRegExp(term)}`, "u").test(flat);
      if (SETTING_VERB.test(span) || adjacent) return true;
    }
  }
  return false;
}

/**
 * Whether a pull request is the binding's worker's own: its key or URL is in
 * the set the server built from the worker's head branch and what the worker
 * reported (BB-52 rule 0). A null key and empty URL never match.
 */
const ownPull = (key: string | null, url: string | null, own: ReadonlySet<string>): boolean =>
  (key !== null && own.has(key.toLowerCase())) || (url !== null && url !== "" && own.has(url.toLowerCase()));

/** The stages a worker of the binding moves an entity between: a move within them is its own (rule 1). */
const OWN_MOVE_STAGES = new Set(["build", "review"]);
/**
 * Whether a move between two stages is the worker's own build/review loop
 * (BB-52): both stages are build or review and they differ. Used for a state
 * move and, since a label can move the phase too, for a label-driven one
 * (BB-248).
 */
export const isOwnStageChange = (before: string | null, after: string | null): boolean =>
  before !== null && after !== null && before !== after && OWN_MOVE_STAGES.has(before) && OWN_MOVE_STAGES.has(after);

/**
 * Whether a state change is the worker's own build/review loop: both states map
 * to a build or review stage and they differ. A terminal state is handled by
 * the lifecycle before this, and any other move still wakes the steward.
 */
export function isOwnStageMove(stageOf: ((state: string) => string | null) | undefined, before: string, after: string): boolean {
  if (stageOf === undefined) return false;
  return isOwnStageChange(stageOf(before), stageOf(after));
}

/**
 * Whose pull request events are the steward's own work in progress. While any
 * worker of the binding is in flight (criterion 1: from its spawn until it
 * finishes, not only while its turn runs), the worker pushes, edits the
 * description, posts as the viewer (every thread acts as the developer,
 * signed or not) and waits for checks; none of that is news to the steward,
 * which hears from the worker when it finishes. People and terminal states
 * still wake it. BB-52 narrows this to the worker's own pull requests: a
 * linked pull request the plugin cannot tie to the worker keeps its activity
 * actionable.
 */
type DiffContext = Omit<ObservedDiffContext, "ownPulls"> & { prefix: string; viewer: string | null; ownPulls: ReadonlySet<string> };

/**
 * The changes between two observations of one entity, each marked whether it
 * is actionable on its own. `prefix` names the entity when it is not the
 * binding's own (a linked pull request).
 */
export function diffEntity(before: EntitySnapshot, after: EntitySnapshot, ctx: DiffContext): Change[] {
  const changes: Change[] = [];
  const p = ctx.prefix;
  if (before.state !== after.state) {
    // BB-52 rule 1: a worker moving the entity between the playbook's build
    // and review stages is its own loop, not news.
    const own = ctx.workerInFlight && isOwnStageMove(ctx.stageOf, before.state, after.state);
    changes.push({ text: `${p}State: ${before.state} → ${after.state}`, actionable: !own });
  }
  if ((before.title ?? "") !== (after.title ?? "")) changes.push({ text: `${p}Title: ${after.title ?? "(none)"}`, actionable: false });
  if (!same(before.labels, after.labels)) changes.push({ text: `${p}Labels: ${after.labels.join(", ") || "(none)"}`, actionable: false });
  if (!same(before.assignees, after.assignees)) changes.push({ text: `${p}Assignees: ${after.assignees.join(", ") || "(none)"}`, actionable: false });
  if ((before.priority ?? "") !== (after.priority ?? "")) changes.push({ text: `${p}Priority: ${after.priority ?? "(none)"}`, actionable: false });
  if (before.estimate !== after.estimate) changes.push({ text: `${p}Estimate: ${after.estimate ?? "(none)"}`, actionable: false });
  if (descriptionHash(before) !== descriptionHash(after)) {
    // Only an edit that adds the signature is surely the steward's: someone
    // rewriting a description it signed earlier usually keeps the line.
    const signer = descriptionSignedBy(after);
    const own = signer !== null && ctx.own.has(signer) && descriptionSignedBy(before) !== signer;
    const ownWork = after.pull !== null && quietOwn(ctx, after);
    changes.push({ text: `${p}Description edited${own ? " (by this steward)" : ""}`, actionable: !ownWork, ...(own ? { own } : {}) });
  }

  // A spec comment the steward just posted is its own doing; it only matters
  // once an approval is pinned to the spec it changes.
  const beforeSpecs = new Set(before.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread)).map((c) => c.id));
  const addedSpecs = after.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread) && !beforeSpecs.has(c.id));
  if (addedSpecs.length > 0) {
    const byUser = addedSpecs.some((c) => c.signedBy !== null && (ctx.userThread?.(c.signedBy) ?? false));
    // A spec comment the user wrote is news on its own: it carries its own
    // approval when the approver is `user`, and when it is the project steward
    // the steward should know the user authored it, not wait on them.
    changes.push({ text: `${p}Spec comment${addedSpecs.length === 1 ? "" : "s"} added${byUser ? " by the user" : ""}`, actionable: ctx.approved || byUser, ...(byUser ? { byUser } : {}) });
  }

  const beforeChildren = new Map(before.children.map((c) => [c.id, c]));
  for (const child of after.children) {
    const was = beforeChildren.get(child.id);
    if (was === undefined) changes.push({ text: `${p}Sub-issue added: ${child.key} ${child.title ?? ""}`.trimEnd(), actionable: false });
    else if (lc(was.state) !== lc(child.state)) changes.push({ text: `${p}Sub-issue ${child.key}: ${was.state ?? "?"} → ${child.state ?? "?"}`, actionable: true });
  }
  const added = after.linkedPulls.filter((l) => !before.linkedPulls.some((b) => b.url === l.url));
  for (const l of added) {
    // BB-52 rule 2: while a worker is in flight, only its own pull request is
    // quiet; a foreign one wakes the steward. With no worker in flight the
    // link is a quiet note as before. BB-203 keeps the worker's own link loud
    // while the user has an open item, so the steward can reconcile it.
    const own = ownPull(l.key, l.url, ctx.ownPulls);
    const foreign = ctx.workerInFlight && !own;
    const quiet = ctx.workerInFlight && own && ctx.userWaiting !== true;
    changes.push({ text: `${p}Pull request linked${foreign ? " (not this ticket's worker)" : ""}: ${l.key ?? l.url}`, actionable: ctx.workerInFlight && !quiet });
  }

  if (before.pull !== null && after.pull !== null) changes.push(...diffPull(before, after, ctx, quietOwn(ctx, after)));
  return changes;
}

/**
 * Whether a worker in flight owns this pull request's activity and nothing the
 * user must act on is open (BB-203). An open need or `user` escalation keeps the
 * activity loud, so the steward can reconcile the item it is holding for the
 * user. BB-52's in-flight rule is unchanged for everything else.
 */
const quietOwn = (ctx: { workerInFlight: boolean; userWaiting?: boolean; ownPulls: ReadonlySet<string> }, e: EntitySnapshot): boolean =>
  ctx.workerInFlight && ctx.userWaiting !== true && ownPull(e.key, e.url, ctx.ownPulls);

const SETTLED = new Set(["success", "failure", "error"]);

function diffPull(before: EntitySnapshot, after: EntitySnapshot, ctx: DiffContext, ownWork: boolean): Change[] {
  const b = before.pull!;
  const a = after.pull!;
  const p = ctx.prefix;
  const changes: Change[] = [];
  const viewer = lc(ctx.viewer ?? after.viewer);
  if (b.headSha !== a.headSha && a.headSha !== null) {
    // The viewer's own pushes are the steward's workers at work: their checks
    // finishing is the news, not the push.
    const byOther = a.headAuthor !== null && lc(a.headAuthor) !== viewer;
    changes.push({ text: `${p}Pushed ${a.headSha.slice(0, 7)}${a.headAuthor === null ? "" : ` by ${a.headAuthor}`}`, actionable: byOther });
  }
  const bChecks = b.checks?.state ?? null;
  const aChecks = a.checks?.state ?? null;
  if (aChecks !== null && SETTLED.has(aChecks) && (bChecks !== aChecks || !same(b.checks?.failing ?? [], a.checks?.failing ?? []))) {
    changes.push({ text: `${p}Checks finished: ${aChecks}${a.checks!.failing.length > 0 ? ` (failing: ${a.checks!.failing.join(", ")})` : ""}`, actionable: !ownWork });
  }
  const seen = new Set(b.reviews.map((r) => `${r.author}|${r.submittedAt}|${r.state}`));
  for (const r of a.reviews) {
    if (seen.has(`${r.author}|${r.submittedAt}|${r.state}`)) continue;
    changes.push({ text: `${p}Review: ${r.author} ${r.state}`, actionable: lc(r.author) !== viewer });
  }
  const requestedNow = a.requestedReviewers.some((r) => lc(r) === viewer) && !b.requestedReviewers.some((r) => lc(r) === viewer);
  if (requestedNow) changes.push({ text: `${p}Your review was requested`, actionable: true });
  if ((b.reviewDecision ?? "") !== (a.reviewDecision ?? "")) changes.push({ text: `${p}Review decision: ${a.reviewDecision ?? "(none)"}`, actionable: false });
  return changes;
}

const commentNews = (prefix: string, fresh: SnapshotComment[]) =>
  `${prefix}${fresh.length} new comment${fresh.length === 1 ? "" : "s"} from ${[...new Set(fresh.map((c) => c.author))].join(", ")}`;

/** Whether a line of "what changed" is diffObserved's comment count. */
export const isCommentNews = (text: string): boolean => /^(?:\S+: )?\d+ new comments? from /u.test(text);

/**
 * Every change between two observations: the entity, then each linked pull
 * request. `workerInFlight` quiets the steward's own work on pull requests
 * (see DiffContext), including the reviewer's `bb-review` markers, except a
 * change of lane (criterion 3).
 */
/** The context two observations are compared in, and what the server knows about the worker's own pull requests. */
export type ObservedDiffContext = {
  own: ReadonlySet<string>;
  stewardThreadId: string | null;
  approved: boolean;
  cursor: string;
  workerInFlight: boolean;
  /** Lowercased keys and URLs of the pull requests this binding's worker owns (BB-52 rule 0). */
  ownPulls?: ReadonlySet<string>;
  /** The stage an entity state maps to in this binding's playbook, for the build/review move (rule 1). */
  stageOf?: (state: string) => string | null;
  userThread?: (threadId: string) => boolean;
  /** An open need or `user` escalation: the user is being asked, so own-PR work is not quiet (BB-203). */
  userWaiting?: boolean;
};

export function diffObserved(before: Observed, after: Observed, ctx: ObservedDiffContext): Change[] {
  const ownPulls = ctx.ownPulls ?? new Set<string>();
  const viewer = after.entity.viewer;
  const changes = diffEntity(before.entity, after.entity, { ...ctx, prefix: "", viewer, ownPulls });
  const beforePulls = new Map(before.pulls.map((p) => [p.key.toLowerCase(), p]));
  for (const pull of after.pulls) {
    const was = beforePulls.get(pull.key.toLowerCase());
    const prefix = `${pull.key}: `;
    if (was === undefined) {
      // Rule 2 again: while a worker is in flight, a first sight of its own
      // pull request is quiet and a foreign one wakes (the link line already
      // names it); with no worker in flight it is quiet as before. BB-203 keeps
      // the worker's own follow loud while the user has an open item.
      const own = ownPull(pull.key, pull.url, ownPulls);
      const quiet = ctx.workerInFlight && own && ctx.userWaiting !== true;
      changes.push({ text: `${prefix}now followed (${pull.state})`, actionable: ctx.workerInFlight && !quiet });
    } else changes.push(...diffEntity(was, pull, { ...ctx, prefix, viewer: pull.viewer, ownPulls }));
  }
  // Comments are compared with what the steward was last shown, not with the
  // last ring, so a comment that arrived while the binding was held is still
  // news at the next turn.
  const beforeByKey = new Map<string, EntitySnapshot>([[before.entity.key.toLowerCase(), before.entity], ...before.pulls.map((p) => [p.key.toLowerCase(), p] as const)]);
  for (const e of [after.entity, ...after.pulls]) {
    const prefix = e === after.entity ? "" : `${e.key}: `;
    const fresh = newHumanComments(e, ctx.cursor, ctx.own);
    // On a pull request a worker owns, the viewer's comments are the worker's
    // and its reviewers': they post as the developer, often unsigned. The
    // reviewer's markers are the worker's business too, whoever posts them;
    // a round that changes the lane is not.
    const ownWork = e.pull !== null && quietOwn({ ...ctx, ownPulls }, e);
    const people = ownWork ? fresh.filter((c) => reviewMarker(c.body) === null && lc(c.author) !== lc(e.viewer)) : fresh;
    if (fresh.length > 0) changes.push({ text: commentNews(prefix, fresh), actionable: people.length > 0 });
    if (ownWork) {
      const lane = markerLaneChange(beforeByKey.get(e.key.toLowerCase())?.comments ?? [], e.comments);
      if (lane !== null) changes.push({ text: `${prefix}Review lane: ${lane.from} → ${lane.to}`, actionable: true });
    }
  }
  return changes;
}

/**
 * A `waitingOn` that names the user, the owner or a human. A status record
 * naming one of them without an open `needs` item is refused: the item is what
 * puts the ask on the Stewards page (BB-109 keeps the refusal for `waitingOn`).
 */
export function namesUserAsBlocker(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:user|owner|human)(?:[^\p{L}\p{N}]|$)/iu.test(text);
}


/**
 * A steward that asks for an approval that is already open. The plugin files
 * the request and lists it on the Stewards page, so the playbook says not to
 * ask the user again; a report whose next action is to ask them anyway is a
 * violation `bb stewards show` points at. Only an imperative next action
 * counts, so merely waiting on the request is not flagged.
 */
export function asksForOpenApproval(status: Binding["status"], open: readonly Escalation[], needs: readonly Pick<Need, "kind">[] = []): string | null {
  if (status === null || (!open.some((x) => x.kind === "approval") && !needs.some((n) => n.kind === "approve-spec"))) return null;
  const next = status.nextAction.trim();
  if (!/^(?:ask|asks|asking|request|requests|requesting|remind|reminds|reminding|tell|tells|telling|prompt|prompts|prompting)\b/iu.test(next)) return null;
  if (!/\b(?:approv\w*|lgtm|sign[- ]?off)\b/iu.test(next)) return null;
  if (!/\b(?:user|you|your)\b/iu.test(next)) return null;
  return "asks for an approval that is already open";
}

/**
 * One item the user must act on for a binding, as the coverage gates name it:
 * a plugin or steward `need` (`need_…`), a route-`user` escalation (`esc_…`),
 * or a question (`qst_…`). Two sources can describe the same ask (a plugin
 * `approve-pr` need and its `approval` escalation); the id is the identity, so
 * a repeated row is listed once.
 */
export type OpenUserItem = { id: string; kind: string; text: string; source: "need" | "escalation" | "question"; createdAt: number };

/**
 * The binding's open user-facing items, in a stable order: route-`user`
 * escalations and questions first, then the needs that are not one of those.
 * Used by the escalate and forward coverage gates and by the reverse-order
 * wake when a gate item is filed (BB-231). Never infers a subject from the
 * text.
 */
export function openUserFacingItems(
  bindingId: string,
  needs: readonly Pick<Need, "id" | "kind" | "what" | "createdAt">[],
  escalations: readonly Escalation[],
  questions: readonly { id: string; question: string; bindingId: string | null; createdAt: number }[],
): OpenUserItem[] {
  const byId = new Map<string, OpenUserItem>();
  // Escalations first: an escalation-backed `need` shares the escalation's id,
  // so the raw route-`user` row must claim its id as an escalation (or a
  // question), not be relabelled a need by the merge that follows.
  for (const x of escalations) {
    if (x.route !== "user") continue;
    if (!byId.has(x.id)) byId.set(x.id, { id: x.id, kind: x.isQuestion ? "question" : x.kind, text: x.question, source: x.isQuestion ? "question" : "escalation", createdAt: x.createdAt });
  }
  for (const q of questions) {
    if (q.bindingId !== bindingId) continue;
    if (!byId.has(q.id)) byId.set(q.id, { id: q.id, kind: "question", text: q.question, source: "question", createdAt: q.createdAt });
  }
  for (const n of needs) if (!byId.has(n.id)) byId.set(n.id, { id: n.id, kind: n.kind, text: n.what, source: "need", createdAt: n.createdAt });
  return [...byId.values()];
}

/**
 * Whether to compact a steward's context: it already holds more than the
 * limit, or the wake about to be sent would push it over (criterion 4).
 * Tokens are estimated from the wake's characters; the provider's reading is
 * exact. A non-positive limit leaves compaction to the provider.
 */
export const CHARS_PER_TOKEN = 4;
export function compactDue(usedTokens: number | null, limit: number, incomingChars = 0): boolean {
  if (!(limit > 0) || usedTokens === null) return false;
  return usedTokens > limit || usedTokens + Math.ceil(incomingChars / CHARS_PER_TOKEN) > limit;
}

/**
 * Whether the gate is shut on something known rather than merely not yet
 * reported: approval is needed and the current spec has none (missing,
 * voided or stale), or the steward reported a checklist item unmet. An item
 * the steward has not reported does not count, so a ticket moved on right
 * after its approval, before the steward reports again, is not flagged.
 */
export function gateKnownUnmet(playbook: Playbook, ready: ReadyState, currentSpecHash: string): boolean {
  const gate = gateState(playbook, ready, currentSpecHash);
  if (gate.passed) return false;
  if (gate.approvalNeeded && (!gate.approved || gate.approvalStale)) return true;
  return gate.unmet.some((item) => reportedItem(ready, item)?.met === false);
}

/**
 * A status that says it waits on the project steward or the user while
 * none of its escalations is open: a wait nobody above it hears about.
 */
export function unheardWait(status: Binding["status"], open: readonly Escalation[], needs: readonly Pick<Need, "kind">[] = []): string | null {
  if (status === null || status.waitingOn === null || open.length > 0 || needs.length > 0) return null;
  if (/project steward/iu.test(status.waitingOn)) return "waits on the project steward, with no open escalation";
  if (/\buser\b/iu.test(status.waitingOn)) return "waits on the user, with no open escalation";
  return null;
}

// ---- idle in an active stage (BB-83) --------------------------------------------

/**
 * The binding facts the idle rule reads beyond the snapshot: its workers, the
 * pull requests its own workers opened (BB-52 rule 0), and what waits on the
 * user. `server.ts` assembles these from the store; nothing here reads one.
 */
export type IdleBinding = Pick<Binding, "stage" | "ending" | "hold" | "deployments" | "requeueUntil"> & {
  workers: readonly Pick<Worker, "status">[];
  ownPulls: ReadonlySet<string>;
  /**
   * Lowercased keys of the binding's own pull requests whose gate is met
   * (BB-285). A gate-met own pull request is not something to wait on: the
   * plugin acts on it, so it does not suppress the idle wake.
   */
  gateMetPulls?: ReadonlySet<string>;
  escalations: readonly Pick<Escalation, "status" | "route">[];
  needs: readonly unknown[];
};

/** The wake text for a binding idle in an active stage (BB-83). */
export const IDLE_WAKE_TEXT =
  "Nothing is running and nothing is being waited on: no worker, no open pull request, no pending deployment. Close the ticket, start the next slice, or report what remains and who does it.";

/** A pull request the plugin can see is not yet merged or closed. */
const pullOpen = (e: EntitySnapshot): boolean => e.pull !== null && e.state !== "merged" && e.state !== "closed";

/**
 * Whether a binding in an active stage has nothing left to wait on (BB-83):
 * its playbook stage is `build` or `review`, it is not ending or held, it has
 * no dated wait still ahead (BB-247), no worker is running, no own pull
 * request (BB-52 rule 0) is open, no deployment watch is merged or deploying,
 * and no escalation or need waits on the user. It says nothing about the grace
 * or the once-per-idle-period guard; the server measures those.
 */
export function idleInActiveStage(b: IdleBinding, observed: Observed, now: number = Date.now()): boolean {
  if (b.stage !== "build" && b.stage !== "review") return false;
  if (b.ending !== null || b.hold !== null) return false;
  // BB-247: a dated wait is something the plugin waits on. The binding is
  // parked until the date, so it is not idle and must not be woken with
  // "nothing is being waited on" before then.
  if (b.requeueUntil !== null && b.requeueUntil > now) return false;
  if (b.workers.some((w) => w.status === "running")) return false;
  if ([observed.entity, ...observed.pulls].some((e) => pullOpen(e) && ownPull(e.key, e.url, b.ownPulls) && !(b.gateMetPulls?.has(e.key.toLowerCase()) ?? false))) return false;
  if (Object.values(b.deployments).some((w) => w.state === "merged" || w.state === "deploying")) return false;
  if (b.escalations.some((x) => x.status === "open" && x.route === "user")) return false;
  if (b.needs.length > 0) return false;
  return true;
}

// ---- mechanical status (BB-203) ------------------------------------------------------

/** A status update the plugin writes from an event it observed itself, without a steward turn. */
export type MechanicalEvent =
  | { kind: "approved"; pull: string }
  | { kind: "merged"; pull: string }
  | { kind: "checks"; pull: string; state: string; failing: readonly string[] }
  | { kind: "deployed"; pull: string };

/** The phrase a checks result folds into (BB-203): the summary stays the steward's. */
export const checksPhrase = (state: string, failing: readonly string[]): string =>
  state === "success" ? "checks passed" : `checks ${state}${failing.length === 0 ? "" : ` (failing: ${failing.join(", ")})`}`;

/**
 * The status record the plugin writes on an event it observed itself (BB-203),
 * built from the last report the steward made so the phase, wait, conditions
 * and resources survive. Checks fold into the phrase and leave the summary;
 * the others name the new state. `actor` follows the standing rule: `user`
 * only while a need or a `user` escalation is open. Null when there is no report
 * to build on: a mechanical write never invents the steward's first report.
 */
export function mechanicalStatus(prev: StatusRecord | null, event: MechanicalEvent, userWaiting: boolean, at: number): StatusRecord | null {
  if (prev === null) return null;
  const actor: StatusRecord["actor"] = userWaiting ? "user" : event.kind === "merged" ? "other" : "steward";
  const base = { ...prev, actor, at };
  switch (event.kind) {
    case "approved":
      return { ...base, summary: `Approved ${event.pull}.`, nextAction: "The worker merges it." };
    case "merged":
      return { ...base, summary: `Merged ${event.pull}.`, nextAction: "Awaiting deployment." };
    case "checks":
      return { ...base, nextAction: checksPhrase(event.state, event.failing) };
    case "deployed":
      return { ...base, summary: `Deployed ${event.pull}.`, nextAction: "Close the ticket." };
  }
}

/** The own pull request that went open → merged between two observations, if any (BB-203). */
export function ownPullMerged(before: Observed, after: Observed, ownPulls: ReadonlySet<string>): { pull: string } | null {
  const wasOpen = new Set<string>();
  for (const e of [before.entity, ...before.pulls]) {
    if (e.pull !== null && e.key !== "" && pullOpen(e)) wasOpen.add(e.key.toLowerCase());
  }
  for (const e of [after.entity, ...after.pulls]) {
    if (e.pull === null || e.key === "") continue;
    if (!(e.state === "merged" || e.pull.merged === true) || !ownPull(e.key, e.url, ownPulls)) continue;
    if (wasOpen.has(e.key.toLowerCase())) return { pull: e.key };
  }
  return null;
}

/** Checks that settled on an own pull request between two observations, if any (BB-203). */
export function ownChecksFinished(before: Observed, after: Observed, ownPulls: ReadonlySet<string>): { pull: string; state: string; failing: string[] } | null {
  const was = new Map<string, EntitySnapshot>();
  for (const e of [before.entity, ...before.pulls]) if (e.pull !== null) was.set(e.key.toLowerCase(), e);
  for (const e of [after.entity, ...after.pulls]) {
    if (e.pull === null || !ownPull(e.key, e.url, ownPulls)) continue;
    const prev = was.get(e.key.toLowerCase());
    const bChecks = prev?.pull?.checks?.state ?? null;
    const aChecks = e.pull.checks?.state ?? null;
    if (aChecks === null || !SETTLED.has(aChecks)) continue;
    if (bChecks !== aChecks || !same(prev?.pull?.checks?.failing ?? [], e.pull.checks?.failing ?? [])) return { pull: e.key, state: aChecks, failing: e.pull.checks?.failing ?? [] };
  }
  return null;
}

/** A deployment watch that settled to `deployed` between two reads, if any (BB-203). */
export function deploymentSettled(before: Deployments, after: Deployments): { pull: string } | null {
  for (const [id, watch] of Object.entries(after)) {
    if (watch.state === "deployed" && before[id]?.state !== "deployed") return { pull: watch.key };
  }
  return null;
}

/**
 * Whether an own pull request closed between two observations. A close starts
 * a new idle period, so a steward woken for the previous one is looked at
 * again rather than the close reading as the same period's news.
 */
export function ownPullClosed(before: Observed, after: Observed, ownPulls: ReadonlySet<string>): boolean {
  const wasOpen = new Map<string, boolean>();
  for (const e of [before.entity, ...before.pulls]) {
    if (e.pull === null) continue;
    if (e.key !== "") wasOpen.set(e.key.toLowerCase(), pullOpen(e));
    if (e.url !== null && e.url !== "") wasOpen.set(e.url.toLowerCase(), pullOpen(e));
  }
  for (const e of [after.entity, ...after.pulls]) {
    if (e.pull === null || pullOpen(e)) continue;
    const own = (e.key !== "" && ownPulls.has(e.key.toLowerCase())) || (e.url !== null && e.url !== "" && ownPulls.has(e.url.toLowerCase()));
    if (!own) continue;
    const was = (e.key !== "" ? wasOpen.get(e.key.toLowerCase()) : undefined) ?? (e.url !== null && e.url !== "" ? wasOpen.get(e.url.toLowerCase()) : undefined);
    if (was === true) return true;
  }
  return false;
}

// ---- lifecycle -----------------------------------------------------------------------

export type Lifecycle =
  | { kind: "continue" }
  | { kind: "terminal" }
  | { kind: "detach" }
  | { kind: "reassigned" }
  | { kind: "reopen"; why: string }
  | { kind: "stay-ended" };

const hasLabel = (entity: EntitySnapshot, label: string) => entity.labels.some((l) => l.toLowerCase() === label.toLowerCase());

/**
 * Whether this server's login is one of the entity's assignees. `owner` null
 * means the login could not be read, and nothing is claimed: a ticket that
 * cannot be checked is never released (BB-115, limit a).
 */
const assignedTo = (entity: EntitySnapshot, owner: string | null): boolean =>
  owner !== null && entity.assignees.some((a) => a.toLowerCase() === owner.toLowerCase());

/**
 * What the entity's state means for the binding. A review binding is not
 * labelled, so only the terminal state ends it; a ticket or pr binding also
 * ends when the label goes, and comes back when it returns.
 *
 * An entity that leaves its terminal state while the binding is still
 * ending reopens it too: a ticket an automation moved to Done and someone
 * moved straight back should not cost its steward its workers.
 *
 * A ticket whose assignee set no longer names this server's login is
 * released: the new assignee's server owns it now (BB-115). `opts.owner` is
 * this server's Linear login, and is passed only when the snapshot that
 * carries `assignees` was read successfully; a read that failed never
 * reaches here, so a partial or rate-limited read never ends a binding.
 */
export function lifecycle(binding: Pick<Binding, "kind" | "endedAt" | "endReason" | "manualDetach" | "ending">, playbook: Playbook, entity: EntitySnapshot, label: string, opts: { labelRequired?: boolean; owner?: string | null } = {}): Lifecycle {
  const terminal = isTerminal(playbook, entity.state);
  // A review binding is not labelled; a binding the plugin adopts itself (a
  // dependency bot's pull request) has no label to hold it, so its label is
  // not required either.
  const labelled = binding.kind === "review" || opts.labelRequired === false || hasLabel(entity, label);
  const mine = assignedTo(entity, opts.owner ?? null);
  if (binding.endedAt !== null) {
    if (terminal || !labelled || binding.manualDetach) return { kind: "stay-ended" };
    if (binding.endReason === "terminal") return { kind: "reopen", why: `reopened: now ${entity.state}` };
    if (binding.endReason === "detach") return { kind: "reopen", why: `the ${label} label is back` };
    // A ticket released on reassignment comes back when it is assigned here
    // again; one still assigned elsewhere stays ended.
    if (binding.endReason === "reassigned") return mine ? { kind: "reopen", why: "reassigned to this server" } : { kind: "stay-ended" };
    return { kind: "stay-ended" };
  }
  if (terminal) return { kind: "terminal" };
  // Only a ticket follows the assignee; a review binding is held by the
  // requested-reviewer check at adoption, and a pr binding by its label.
  // Checked before the follow-through reopen, so a ticket moved back to a
  // non-terminal state and reassigned away in one change is released rather
  // than taking a spurious reopen turn first.
  if (binding.kind === "ticket" && opts.owner !== undefined && opts.owner !== null && !mine) return { kind: "reassigned" };
  if (binding.ending === "terminal" && !terminal && labelled) return { kind: "reopen", why: `reopened before the binding ended: now ${entity.state}` };
  if (!labelled) return { kind: "detach" };
  return { kind: "continue" };
}

export { hasLabel };

/** Whether a terminal binding is being kept open by its steward to finish its work. */
export const followingThrough = (b: Pick<Binding, "ending" | "followThrough">): boolean => b.ending === "terminal" && b.followThrough !== null;

/**
 * When an ending is overdue: the follow-through's cap once the steward has
 * declared one, otherwise the wrap-up turn's own timeout.
 */
export function endingDeadline(b: Pick<Binding, "ending" | "endingAt" | "followThroughUntil">, turnTimeoutMs: number): number | null {
  if (b.ending === null) return null;
  if (b.followThroughUntil !== null) return b.followThroughUntil;
  return b.endingAt === null ? null : b.endingAt + turnTimeoutMs;
}

/**
 * The phase and stage for an entity: a present `label:<name>` phase key first,
 * in playbook order and matching the label ignoring case, then its state
 * (BB-248). `labels` defaults to none, which is the state-only behaviour.
 */
export function phaseAndStage(playbook: Playbook, state: string, labels: readonly string[] = []): { phase: string; stage: Binding["stage"] } {
  const present = new Set(labels.map((l) => l.toLowerCase()));
  const key = Object.keys(playbook.phases).find((p) => {
    const name = labelPhaseName(p);
    return name !== null && present.has(name.toLowerCase());
  });
  if (key !== undefined) return { phase: key, stage: playbook.phases[key]!.stage ?? null };
  const p = phaseOf(playbook, state);
  return { phase: p?.name ?? state, stage: p?.stage ?? null };
}

/**
 * Whether the backstop should raise `stuck`: the phase has a stuck limit, the
 * status record has not moved in that long, and nothing already says so.
 */
export function stuckDue(binding: Pick<Binding, "advancedAt" | "createdAt" | "phase">, playbook: Playbook, open: Escalation[], now: number): number | null {
  if (binding.phase === null) return null;
  const limit = phaseOf(playbook, binding.phase)?.stuckMs ?? null;
  if (limit === null) return null;
  if (open.some((e) => e.kind === "stuck")) return null;
  const since = binding.advancedAt ?? binding.createdAt;
  return now - since >= limit ? limit : null;
}

/** Whether a new status record moved on from the last one. */
export const advanced = (before: Binding["status"], after: { phase: string; summary: string; nextAction: string }): boolean =>
  before === null || before.phase !== after.phase || before.summary !== after.summary || before.nextAction !== after.nextAction;
