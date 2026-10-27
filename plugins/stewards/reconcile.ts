// The mechanical tier's decisions, as pure functions: what changed between two
// observations of an entity, which of those changes are worth a judgment
// turn, where the ready gate stands, and when a binding counts as stuck.
// server.ts fetches, stores and wakes; nothing here talks to anything.
//
// The rule throughout: an event is a hint to look again, never the input a
// decision is made from. Every function here compares two states.
import { createHash } from "node:crypto";
import { isTerminal, phaseOf, type Playbook } from "./config.js";
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";
import type { Binding, Escalation, Need, Observed, ReadyState, Worker } from "./store.js";

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
 * A reviewer's machine-readable verdict, as `pr-reviewer` posts it on the
 * first line of a comment. `lane` is null when the marker did not name one
 * (the gate then treats the pull request as the owner's).
 */
export type ReviewMarker = { round: number; sha: string; verdict: string; lane: string | null };

const REVIEW_MARKER = /^<!--\s*bb-review\b([^>]*?)-->/u;

/** The verdict a marker without `verdict=` is read as: never `approved`. */
export const UNREADABLE_VERDICT = "unreadable";

/**
 * The reviewer's marker on a comment, or null for any other comment. Any
 * first line that opens a `bb-review` comment is a marker, however it is
 * spelled: a round whose keys are missing or misspelled still closes the
 * gate, because the alternative is to read the previous round's `approved`
 * as the latest word. A missing `verdict=` is read from a bare word in the
 * marker (`changes-requested`) and otherwise is `unreadable`; neither is
 * `approved`.
 */
export function reviewMarker(body: string): ReviewMarker | null {
  const first = body.split("\n", 1)[0]!.trim();
  const m = REVIEW_MARKER.exec(first);
  if (m === null) return null;
  const keyed = new Map<string, string>();
  const bare: string[] = [];
  for (const token of m[1]!.trim().split(/\s+/u).filter((t) => t !== "")) {
    const eq = token.indexOf("=");
    if (eq > 0) keyed.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
    else bare.push(token);
  }
  const round = Number(keyed.get("round") ?? "");
  return {
    round: Number.isInteger(round) && round > 0 ? round : 0,
    sha: keyed.get("sha") ?? "",
    verdict: keyed.get("verdict") ?? bare[0] ?? UNREADABLE_VERDICT,
    lane: keyed.get("lane") ?? null,
  };
}

/** The newest reviewer marker in a comment list, by comment time. */
export function latestReviewMarker(comments: readonly SnapshotComment[]): ReviewMarker | null {
  let at = "";
  let latest: ReviewMarker | null = null;
  for (const c of comments) {
    const m = reviewMarker(c.body);
    if (m !== null && c.createdAt >= at) {
      at = c.createdAt;
      latest = m;
    }
  }
  return latest;
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
 * A spec comment is a signed comment that starts by saying so. The steward's
 * own count, and so do the user's: a thread the user runs themselves is
 * treated as the user's own words (an amendment carries its own approval
 * when the approver is `me`). `isUserThread` says whether a signing thread is
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

export function specHash(entity: EntitySnapshot, stewardThreadId: string | null, isUserThread?: (threadId: string) => boolean): string {
  const description = (entity.description ?? "").replace(DESCRIPTION_SIGNATURE, "").trim();
  const specs = entity.comments.filter((c) => isSpecComment(c, stewardThreadId, isUserThread)).map((c) => `${c.id}\n${c.body}`);
  return createHash("sha256").update([description, ...specs].join("\n\u0000\n")).digest("hex").slice(0, 16);
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
 * Whether a state change is the worker's own build/review loop: both states map
 * to a build or review stage and they differ. A terminal state is handled by
 * the lifecycle before this, and any other move still wakes the steward.
 */
export function isOwnStageMove(stageOf: ((state: string) => string | null) | undefined, before: string, after: string): boolean {
  if (stageOf === undefined) return false;
  const a = stageOf(before);
  const b = stageOf(after);
  return a !== null && b !== null && a !== b && OWN_MOVE_STAGES.has(a) && OWN_MOVE_STAGES.has(b);
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
    const ownWork = ctx.workerInFlight && after.pull !== null && ownPull(after.key, after.url, ctx.ownPulls);
    changes.push({ text: `${p}Description edited${own ? " (by this steward)" : ""}`, actionable: !ownWork, ...(own ? { own } : {}) });
  }

  // A spec comment the steward just posted is its own doing; it only matters
  // once an approval is pinned to the spec it changes.
  const beforeSpecs = new Set(before.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread)).map((c) => c.id));
  const addedSpecs = after.comments.filter((c) => isSpecComment(c, ctx.stewardThreadId, ctx.userThread) && !beforeSpecs.has(c.id));
  if (addedSpecs.length > 0) {
    const byUser = addedSpecs.some((c) => c.signedBy !== null && (ctx.userThread?.(c.signedBy) ?? false));
    // A spec comment the user wrote is news on its own: it carries its own
    // approval when the approver is `me`, and when it is the project steward
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
    // link is a quiet note as before.
    const foreign = ctx.workerInFlight && !ownPull(l.key, l.url, ctx.ownPulls);
    changes.push({ text: `${p}Pull request linked${foreign ? " (not this ticket's worker)" : ""}: ${l.key ?? l.url}`, actionable: foreign });
  }

  if (before.pull !== null && after.pull !== null) changes.push(...diffPull(before, after, ctx, ctx.workerInFlight && ownPull(after.key, after.url, ctx.ownPulls)));
  return changes;
}

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
      // names it); with no worker in flight it is quiet as before.
      const foreign = ctx.workerInFlight && !ownPull(pull.key, pull.url, ownPulls);
      changes.push({ text: `${prefix}now followed (${pull.state})`, actionable: foreign });
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
    const ownWork = ctx.workerInFlight && e.pull !== null && ownPull(e.key, e.url, ownPulls);
    const people = ownWork ? fresh.filter((c) => reviewMarker(c.body) === null && lc(c.author) !== lc(e.viewer)) : fresh;
    if (fresh.length > 0) changes.push({ text: commentNews(prefix, fresh), actionable: people.length > 0 });
    if (ownWork) {
      const lane = markerLaneChange(beforeByKey.get(e.key.toLowerCase())?.comments ?? [], e.comments);
      if (lane !== null) changes.push({ text: `${prefix}Review lane: ${lane.from} → ${lane.to}`, actionable: true });
    }
  }
  return changes;
}

// ---- the merge gate -------------------------------------------------------------------

/**
 * Whether the owner has approved a pull request: an unsigned approving comment
 * by the connected user, or an APPROVED review from them. A signed comment is
 * a thread's (the reviewer's marker, a worker's), never the owner's.
 */
export function ownerApproval(entity: EntitySnapshot): { approved: boolean; at: string | null } {
  const viewer = entity.viewer === null ? null : entity.viewer.toLowerCase();
  if (viewer === null) return { approved: false, at: null };
  let at: string | null = null;
  for (const c of entity.comments) {
    if (c.signedBy !== null || c.author.toLowerCase() !== viewer) continue;
    if (classifyApproval(c.body) !== "approve") continue;
    if (at === null || c.createdAt > at) at = c.createdAt;
  }
  for (const r of entity.pull?.reviews ?? []) {
    if (r.author.toLowerCase() !== viewer || r.state.toLowerCase() !== "approved") continue;
    const when = r.submittedAt ?? "";
    if (at === null || when > at) at = when;
  }
  return { approved: at !== null, at };
}

// ---- the project steward's approval marker --------------------------------------------

/**
 * A project steward's `bb-approval` marker, as the plugin posts it on a pull
 * request: `<!-- bb-approval by=project-steward sha=<sha> entry=<text> [verdict=declined] -->`.
 * `entry` is quoted when it contains whitespace. `verdict` is null on an
 * approval and `declined` on a decline.
 */
export type ProjectApprovalMarker = { by: string; sha: string; entry: string | null; verdict: string | null };

/**
 * The plugin's own record of an approval marker it posted: the GitHub comment
 * id of the marker and the verdict it carried. A marker on the pull request
 * counts only when its comment id is in the store's records, so a hand-typed
 * lookalike (a different comment id) never satisfies the gate.
 */
export type ProjectApprovalRecord = { commentId: string | null; verdict: string };

const APPROVAL_MARKER = /^<!--\s*bb-approval\b([^>]*?)-->/u;
const MARKER_ATTR = /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/gu;

/** Quote a marker attribute value when it contains whitespace or a delimiter. */
function markerAttr(value: string): string {
  return /[\s"<>]/u.test(value) ? JSON.stringify(value) : value;
}

function unescapeMarker(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** The first line of a project-steward approval marker, as the plugin posts it. */
export function approvalMarkerLine(fields: { sha: string; entry: string | null; verdict: "approved" | "declined" }): string {
  const attrs = ["by=project-steward", `sha=${fields.sha}`];
  if (fields.entry !== null && fields.entry.trim() !== "") attrs.push(`entry=${markerAttr(fields.entry.trim())}`);
  if (fields.verdict === "declined") attrs.push("verdict=declined");
  return `<!-- bb-approval ${attrs.join(" ")} -->`;
}

/**
 * The project-steward approval marker on a comment, or null for any other
 * comment. Any first line that opens a `bb-approval` comment is read, however
 * its keys are spelled; an unreadable one is still a marker (with no verdict),
 * so it never counts as an approval.
 */
export function projectApprovalMarker(body: string): ProjectApprovalMarker | null {
  const first = body.split("\n", 1)[0]!.trim();
  const m = APPROVAL_MARKER.exec(first);
  if (m === null) return null;
  const attrs = new Map<string, string>();
  for (const t of m[1]!.matchAll(MARKER_ATTR)) attrs.set(t[1]!.toLowerCase(), t[2] !== undefined ? unescapeMarker(t[2]) : t[3]!);
  return { by: attrs.get("by") ?? "", sha: attrs.get("sha") ?? "", entry: attrs.get("entry") ?? null, verdict: attrs.get("verdict") ?? null };
}

/**
 * The newest `bb-approval` marker whose comment id the plugin itself recorded,
 * by comment time. A marker with an id the store does not hold is a lookalike
 * someone typed and is skipped.
 */
export function latestProjectApprovalMarker(comments: readonly SnapshotComment[], recordedCommentIds: ReadonlySet<string>): { marker: ProjectApprovalMarker; comment: SnapshotComment } | null {
  let at = "";
  let latest: { marker: ProjectApprovalMarker; comment: SnapshotComment } | null = null;
  for (const c of comments) {
    if (!recordedCommentIds.has(c.id)) continue;
    const marker = projectApprovalMarker(c.body);
    if (marker === null) continue;
    if (c.createdAt >= at) {
      at = c.createdAt;
      latest = { marker, comment: c };
    }
  }
  return latest;
}

/**
 * The worker thread that posted build-tickets' "Independent review running"
 * comment, or null. The worker is told the approval landed so it merges
 * without a `github_watch` on the owner.
 */
export function reviewWorkerThread(comments: readonly SnapshotComment[]): string | null {
  let found: string | null = null;
  for (const c of comments) if (c.signedBy !== null && c.body.includes("Independent review running")) found = c.signedBy;
  return found;
}

/**
 * The lane gate from the build-tickets skill, in one place: the reviewer's
 * latest marker has verdict `approved`, every check has passed, and, in the
 * owner-reviewed lane, the owner has approved. The marker need not name the
 * current head: an approval is of the pull request, not of a commit, so it
 * survives a rebase, a merge of the base branch and the worker's own small
 * follow-ups; only a later marker with another verdict, or checks failing on
 * the current head, closes the gate. It is used by the merge button, by the
 * item the plugin files, and by the wake text that tells a steward whether a
 * pull request's gate is met.
 */
export type PrGate = {
  headSha: string | null;
  marker: ReviewMarker | null;
  lane: string | null;
  checksGreen: boolean;
  checksState: string | null;
  ownerApproved: boolean;
  ownerApprovalAt: string | null;
  gateMet: boolean;
  /** What is missing, in words; null when the gate is met. */
  missing: string | null;
  /** The plugin's `approve-pr` condition: user lane, marker approved, checks green, no owner approval yet. */
  needsOwnerApproval: boolean;
  /** The project steward's side: a `decide: project` entry, marker approved, checks green, no project approval yet. */
  needsProjectApproval: boolean;
  /** The decide mark applied to this pull request; `user` unless the project steward classified it under a `project` entry. */
  decision: "project" | "user";
  /** Whether the plugin posted a project-steward approval marker on this pull request. */
  projectApproved: boolean;
};

/** The project steward's side of the gate: the decide mark and the plugin's own approval records. */
export type PrGateOptions = {
  /** The mark for the entry the project steward classified the pull request under; omitted is `user` (fail closed). */
  decision?: "project" | "user";
  /** The plugin's own `project_approvals` records for this binding, matched to the marker by comment id. */
  projectApprovals?: readonly ProjectApprovalRecord[];
};

export function prGate(entity: EntitySnapshot, opts: PrGateOptions = {}): PrGate {
  const pull = entity.pull;
  const headSha = pull?.headSha ?? null;
  const marker = latestReviewMarker(entity.comments);
  const lane = marker?.lane ?? null;
  const checksState = pull?.checks?.state ?? null;
  const checksGreen = pull !== null && (pull.checks === null || pull.checks.state === "success");
  const owner = ownerApproval(entity);
  const markerApproved = marker !== null && marker.verdict === "approved";
  // Only an explicit `no-review` marker skips the owner; a marker the plugin
  // cannot read, or an unknown lane, is the user's (fail closed).
  const ownerLane = lane !== "no-review";
  // The project steward's decision is the plugin's own record AND the marker
  // it posted: only a `bb-approval` comment whose id the plugin recorded
  // counts, so a hand-typed lookalike (a different comment id) never does.
  // Every record is kept, declines included: the newest matching marker's
  // verdict decides, so a decline at a later sha revokes an earlier approval
  // rather than leaving its marker as the latest word. The record's head sha
  // is not compared with the current head: a decision is of the pull request,
  // and a later head is covered unless the worker added scope (AGENTS.md,
  // "What counts as an approval").
  const recorded = new Map((opts.projectApprovals ?? []).filter((r) => r.commentId !== null).map((r) => [r.commentId!, r.verdict] as const));
  const approval = latestProjectApprovalMarker(entity.comments, new Set(recorded.keys()));
  const approvalVerdict = approval === null ? null : (approval.marker.verdict ?? recorded.get(approval.comment.id) ?? "approved");
  const projectApprovedRaw = approvalVerdict !== null && approvalVerdict !== "declined";
  // The gate belongs to whoever the decide list names. An explicit decision
  // wins; without one, a project approval means the project steward (a
  // project approval is only ever recorded for a `project` entry), and
  // everything else is the user's (fail closed).
  const decision: "project" | "user" = opts.decision === "project" || (opts.decision === undefined && projectApprovedRaw) ? "project" : "user";
  const projectApproved = projectApprovedRaw && decision === "project";
  const approved = decision === "project" ? projectApproved : owner.approved;
  const approvalNeeded = ownerLane && markerApproved && checksGreen && !approved;
  const gateMet = pull !== null && markerApproved && checksGreen && (!ownerLane || approved);
  const missing = gateMet
    ? null
    : pull === null
      ? "not a pull request"
      : marker === null
        ? "no reviewer round yet"
        : marker.verdict !== "approved"
          ? `reviewer verdict: ${marker.verdict}`
          : !checksGreen
            ? `checks ${checksState ?? "not run"}`
            : ownerLane && !approved
              ? decision === "project"
                ? "project steward approval needed"
                : "owner approval needed"
              : "not met";
  return {
    headSha,
    marker,
    lane,
    checksGreen,
    checksState,
    ownerApproved: owner.approved,
    ownerApprovalAt: owner.at,
    gateMet,
    missing,
    needsOwnerApproval: approvalNeeded && decision === "user",
    needsProjectApproval: approvalNeeded && decision === "project",
    decision,
    projectApproved,
  };
}

/**
 * A `blockedOn` that names the user, the owner or a human. A status record
 * naming one of them without an open `needs` item is refused: the item is what
 * puts the ask on the Stewards page.
 */
export function namesUserAsBlocker(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:user|owner|human)(?:[^\p{L}\p{N}]|$)/iu.test(text);
}

// ---- approval words -------------------------------------------------------------------

/**
 * How a piece of text answers an approval request. Explicit approval words
 * approve; explicit refusal words decline; anything else is ambiguous and is
 * the project steward's to interpret. The page answer uses all three; a
 * project steward's own guidance + resolve is a decision, so anything that
 * does not approve declines (as before).
 */
export type ApprovalVerdict = "approve" | "decline" | "ambiguous";

const NEGATED_APPROVE = /(?:^|[^\p{L}\p{N}])(?:not|never|cannot|do\s+not|[a-z]+n['’]t)\s+(?:\w+\s+){0,2}?(?:approv\w*|ship|lgtm|go\s+ahead|looks?\s+good|sign\s*off|yes)(?:[^\p{L}\p{N}]|$)/iu;
const REFUSAL = /(?:^|[^\p{L}\p{N}])(?:reject(?:ed)?|declin(?:e|ed)|hold\s+off)(?:[^\p{L}\p{N}]|$)/iu;
const APPROVE_WORDS = /(?:^|[^\p{L}\p{N}])(?:lgtm|approv(?:e|es|ed|al)|ship\s*it|go\s*ahead|looks?\s+good|sign(?:ed)?\s*off|:shipit:|yes|yep|yeah)(?:[^\p{L}\p{N}]|$)/iu;
const DECLINE_WORDS = /(?:^|[^\p{L}\p{N}])(?:no|nope|don'?t|do\s+not|not\s+yet|changes?\s+(?:are\s+)?(?:needed|requested)|needs?\s+changes?)(?:[^\p{L}\p{N}]|$)/iu;

/**
 * A clear refusal first, so "not approved" and "don't ship it" decline rather
 * than matching the approval word inside them; then approval words, so
 * "LGTM, no concerns" and "ship it, no further changes needed" approve; then
 * a bare no or a request for changes declines; anything else is ambiguous.
 */
export function classifyApproval(text: string | null | undefined): ApprovalVerdict {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  if (flat === "") return "ambiguous";
  if (NEGATED_APPROVE.test(flat) || REFUSAL.test(flat)) return "decline";
  if (APPROVE_WORDS.test(flat)) return "approve";
  if (DECLINE_WORDS.test(flat)) return "decline";
  return "ambiguous";
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

// ---- the ready gate ------------------------------------------------------------------

export type GateState = {
  /** No ready gate in the playbook: nothing to pass. */
  none: boolean;
  checklistMet: boolean;
  unmet: string[];
  /** Null until the steward has judged it. */
  substantial: boolean | null;
  approvalNeeded: boolean;
  approved: boolean;
  /** An approval exists but the spec has changed since. */
  approvalStale: boolean;
  passed: boolean;
};

/** Checklist wording as compared: case, runs of spaces and trailing punctuation do not count. */
const checklistKey = (s: string) => s.toLowerCase().replace(/\s+/gu, " ").replace(/[\s.:;,]+$/u, "").trim();

/** What the steward last reported for one of the playbook's checklist items. */
export const reportedItem = (ready: ReadyState, item: string): ReadyState["checklist"][number] | undefined =>
  ready.checklist.find((c) => checklistKey(c.item) === checklistKey(item));

/**
 * The playbook's own wording for a reported checklist entry: by its number
 * in the wake (1-based), or by its text as the playbook writes it. Null for
 * anything else. Stewards paraphrase long items, so a paraphrase is refused
 * rather than guessed at: a guess that misses leaves the gate shut in
 * silence, which is how it never passed.
 */
export function resolveChecklistItem(items: readonly string[], reported: string | number): string | null {
  const text = String(reported);
  const number = /^\s*#?(\d+)\.?\s*$/u.exec(text);
  if (number !== null) return items[Number(number[1]) - 1] ?? null;
  return items.find((item) => checklistKey(item) === checklistKey(text)) ?? null;
}

export function gateState(playbook: Playbook, ready: ReadyState, currentSpecHash: string): GateState {
  if (playbook.ready === null) return { none: true, checklistMet: true, unmet: [], substantial: null, approvalNeeded: false, approved: false, approvalStale: false, passed: true };
  const items = playbook.ready.checklist;
  const unmet = items.filter((item) => reportedItem(ready, item)?.met !== true);
  const checklistMet = unmet.length === 0;
  // Unjudged counts as substantial: the safe side of the gate.
  const approvalNeeded = ready.substantial !== false;
  const approved = ready.approval !== null;
  const approvalStale = approved && ready.approval!.specHash !== currentSpecHash;
  const passed = checklistMet && (!approvalNeeded || (approved && !approvalStale));
  return { none: false, checklistMet, unmet, substantial: ready.substantial, approvalNeeded, approved, approvalStale, passed };
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
 * Whether the gate waits on its approver: the checklist is met, the ticket
 * is (or may be) substantial, and the current spec has no approval. The
 * plugin asks the approver itself then, so the gate does not depend on the
 * steward remembering to.
 */
export const approvalWanted = (gate: GateState): boolean => !gate.none && gate.checklistMet && gate.approvalNeeded && !gate.passed;

/**
 * A status that says it waits on the project steward or the user while
 * none of its escalations is open: a wait nobody above it hears about.
 */
export function unheardWait(status: Binding["status"], open: readonly Escalation[], needs: readonly Pick<Need, "kind">[] = []): string | null {
  if (status === null || status.blockedOn === null || open.length > 0 || needs.length > 0) return null;
  if (/project steward/iu.test(status.blockedOn)) return "waits on the project steward, with no open escalation";
  if (/\buser\b/iu.test(status.blockedOn)) return "waits on the user, with no open escalation";
  return null;
}

// ---- idle in an active stage (BB-83) --------------------------------------------

/**
 * The binding facts the idle rule reads beyond the snapshot: its workers, the
 * pull requests its own workers opened (BB-52 rule 0), and what waits on the
 * user. `server.ts` assembles these from the store; nothing here reads one.
 */
export type IdleBinding = Pick<Binding, "stage" | "ending" | "hold" | "deployments"> & {
  workers: readonly Pick<Worker, "status">[];
  ownPulls: ReadonlySet<string>;
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
 * its playbook stage is `build` or `review`, it is not ending or held, no
 * worker is running, no own pull request (BB-52 rule 0) is open, no deployment
 * watch is merged or deploying, and no escalation or need waits on the user.
 * It says nothing about the grace or the once-per-idle-period guard; the
 * server measures those.
 */
export function idleInActiveStage(b: IdleBinding, observed: Observed): boolean {
  if (b.stage !== "build" && b.stage !== "review") return false;
  if (b.ending !== null || b.hold !== null) return false;
  if (b.workers.some((w) => w.status === "running")) return false;
  if ([observed.entity, ...observed.pulls].some((e) => pullOpen(e) && ownPull(e.key, e.url, b.ownPulls))) return false;
  if (Object.values(b.deployments).some((w) => w.state === "merged" || w.state === "deploying")) return false;
  if (b.escalations.some((x) => x.status === "open" && x.route === "me")) return false;
  if (b.needs.length > 0) return false;
  return true;
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
  | { kind: "reopen"; why: string }
  | { kind: "stay-ended" };

const hasLabel = (entity: EntitySnapshot, label: string) => entity.labels.some((l) => l.toLowerCase() === label.toLowerCase());

/**
 * What the entity's state means for the binding. A review binding is not
 * labelled, so only the terminal state ends it; a ticket or pr binding also
 * ends when the label goes, and comes back when it returns.
 *
 * An entity that leaves its terminal state while the binding is still
 * ending reopens it too: a ticket an automation moved to Done and someone
 * moved straight back should not cost its steward its workers.
 */
export function lifecycle(binding: Pick<Binding, "kind" | "endedAt" | "endReason" | "manualDetach" | "ending">, playbook: Playbook, entity: EntitySnapshot, label: string, opts: { labelRequired?: boolean } = {}): Lifecycle {
  const terminal = isTerminal(playbook, entity.state);
  // A review binding is not labelled; a binding the plugin adopts itself (a
  // dependency bot's pull request) has no label to hold it, so its label is
  // not required either.
  const labelled = binding.kind === "review" || opts.labelRequired === false || hasLabel(entity, label);
  if (binding.endedAt !== null) {
    if (terminal || !labelled || binding.manualDetach) return { kind: "stay-ended" };
    if (binding.endReason === "terminal") return { kind: "reopen", why: `reopened: now ${entity.state}` };
    if (binding.endReason === "detach") return { kind: "reopen", why: `the ${label} label is back` };
    return { kind: "stay-ended" };
  }
  if (binding.ending === "terminal" && !terminal && labelled) return { kind: "reopen", why: `reopened before the binding ended: now ${entity.state}` };
  if (terminal) return { kind: "terminal" };
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

/** The phase and stage for the entity's state, or nulls when the playbook does not name it. */
export function phaseAndStage(playbook: Playbook, state: string): { phase: string; stage: Binding["stage"] } {
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
