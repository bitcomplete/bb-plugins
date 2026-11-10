// The merge gate: whether a pull request may merge. The reviewer's marker, the
// owner's unsigned approval or real APPROVED review, and the project steward's
// `bb-approval` marker and its plugin-recorded comment id, all read from one
// snapshot. Pure, and kept in its own module because this is the code a change
// may not widen by itself: a pull request that touches this file is always the
// owner's, whatever the decide list says (BB-153). It reads the reviewer marker
// and the approval words from reconcile.ts; reconcile.ts reads `isMarkerComment`
// back, the one cycle, which ESM function hoisting makes safe.
import { classifyApproval, latestReviewMarker, productReason, reviewMarker, type ReviewMarker } from "./reconcile.js";
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";

// ---- the merge gate -------------------------------------------------------------------

/**
 * Whether a comment body opens with a thread's machine-readable marker on its
 * first line: a reviewer's `bb-review` round or the project steward's
 * `bb-approval` decision. A marker comment is a thread's by construction, so
 * it is never the owner's own words, signed or not (BB-110).
 */
export function isMarkerComment(body: string): boolean {
  return reviewMarker(body) !== null || projectApprovalMarker(body) !== null;
}

/**
 * Whether the owner has approved a pull request: an unsigned approving comment
 * by the connected user, or an APPROVED review from them. A signed comment is
 * a thread's (the reviewer's marker, a worker's), never the owner's. So is a
 * comment that merely contains the signature text `— from bb thread`, even
 * when the thread id and the closing `_` are missing: a malformed signature is
 * still an agent's, and the gate fails closed rather than reading its words as
 * the owner's (BB-151). An unsigned comment that carries a `bb-review` or
 * `bb-approval` marker is a thread's too (BB-110).
 *
 * A review steward posts a real, signed review as the connected user too, so
 * an APPROVED review that a thread's review comment stands behind is that
 * thread's, not the owner's (BB-118). The snapshot's `pull.reviews` carries no
 * body, so the review is matched to its flattened comment by author and time.
 *
 * `id`, `url` and `kind` name what approved, for the resolution text: a
 * review's flattened comment carries the review's GitHub id and URL.
 */
const REVIEW_DIDS = new Set(["approved", "requested changes", "reviewed", "had a review dismissed"]);

/** The signature line's opening text, without the thread id or the closing `_`. A malformed signature still marks an agent's comment (BB-151). */
const SIGNATURE_TEXT = "— from bb thread";

/** Whether a body carries the signature text anywhere, however malformed (BB-151). */
export const hasSignatureText = (body: string): boolean => body.includes(SIGNATURE_TEXT);

/** The (author, time) pairs of the reviews a thread posted, signed or marked. github-watcher builds a review's flattened comment and its `pull.reviews` entry from the same `submittedAt ?? createdAt`, so the pair identifies the review. */
function threadReviewKeys(entity: EntitySnapshot): Set<string> {
  const keys = new Set<string>();
  for (const c of entity.comments) {
    const marker = isMarkerComment(c.body);
    const review = REVIEW_DIDS.has(c.did.toLowerCase());
    if (!review && !marker) continue;
    if (c.signedBy === null && !marker) continue;
    keys.add(`${c.author.toLowerCase()}\u0000${c.createdAt}`);
  }
  return keys;
}

export type OwnerApproval = {
  approved: boolean;
  at: string | null;
  /** The GitHub comment, or flattened review, id that approved; null when none did. */
  id: string | null;
  /** Its URL, or null. */
  url: string | null;
  /** Whether a review or a plain comment approved; null when none did. */
  kind: "comment" | "review" | null;
};

export function ownerApproval(entity: EntitySnapshot): OwnerApproval {
  const viewer = entity.viewer === null ? null : entity.viewer.toLowerCase();
  if (viewer === null) return { approved: false, at: null, id: null, url: null, kind: null };
  let bestAt: string | null = null;
  let bestId: string | null = null;
  let bestUrl: string | null = null;
  let bestKind: "comment" | "review" | null = null;
  const note = (at: string, id: string | null, url: string | null, kind: "comment" | "review") => {
    if (bestAt === null || at > bestAt) {
      bestAt = at;
      bestId = id;
      bestUrl = url;
      bestKind = kind;
    }
  };
  for (const c of entity.comments) {
    // A malformed signature is an agent's: never the owner's approval (BB-151).
    if (c.signedBy !== null || hasSignatureText(c.body) || c.author.toLowerCase() !== viewer) continue;
    if (isMarkerComment(c.body)) continue;
    const review = REVIEW_DIDS.has(c.did.toLowerCase());
    // A flattened APPROVED review approves by its state; any other comment by its words.
    if (c.did.toLowerCase() !== "approved" && classifyApproval(c.body) !== "approve") continue;
    note(c.createdAt, c.id, c.url, review ? "review" : "comment");
  }
  const threads = threadReviewKeys(entity);
  for (const r of entity.pull?.reviews ?? []) {
    if (r.author.toLowerCase() !== viewer || r.state.toLowerCase() !== "approved") continue;
    const when = r.submittedAt ?? "";
    // A review a thread posted as the connected user (a review steward's
    // APPROVED review) is not the owner's approval (BB-118).
    if (threads.has(`${r.author.toLowerCase()}\u0000${when}`)) continue;
    // The flattened comment carries the review's GitHub id and URL. A
    // malformed signature on it is still a thread's, so the review is too
    // (BB-151); `threadReviewKeys` only catches a well-formed one.
    const flat = entity.comments.find((c) => c.author.toLowerCase() === viewer && c.createdAt === when && c.did.toLowerCase() === "approved");
    if (flat !== undefined && (flat.signedBy !== null || hasSignatureText(flat.body))) continue;
    note(when, flat?.id ?? null, flat?.url ?? null, "review");
  }
  if (bestAt === null) return { approved: false, at: null, id: null, url: null, kind: null };
  return { approved: true, at: bestAt, id: bestId, url: bestUrl, kind: bestKind };
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
 * comment (its Spawn the reviewer step), or null. The worker is told the
 * approval landed so it merges without a `github_watch` on the owner.
 */
export function reviewWorkerThread(comments: readonly SnapshotComment[]): string | null {
  let found: string | null = null;
  for (const c of comments) if (c.signedBy !== null && c.body.includes("Independent review running")) found = c.signedBy;
  return found;
}

/**
 * The merge gate from the build-tickets skill, in one place: the reviewer's
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
  /** The comment or flattened review that approved, for the resolution text (BB-151). */
  ownerApprovalId: string | null;
  ownerApprovalUrl: string | null;
  ownerApprovalKind: "comment" | "review" | null;
  /** The project-steward marker that approved, when that is the gate. */
  projectApprovalId: string | null;
  projectApprovalUrl: string | null;
  gateMet: boolean;
  /** What is missing, in words; null when the gate is met. */
  missing: string | null;
  /** The plugin's `approve-pr` condition: user lane, marker approved, checks green, no owner approval yet. */
  needsOwnerApproval: boolean;
  /** The project steward's side: a `decide: project` entry, marker approved, checks green, no project approval yet. */
  needsProjectApproval: boolean;
  /**
   * Whether the approval present is stale because the base ref changed after it
   * was given and the head is not based on the default branch tip (BB-279). The
   * remedy is a rebase, not a fresh approval, so neither approval is requested
   * while it holds; `missing` names the rebase.
   */
  baseStale: boolean;
  /** The decide mark applied to this pull request; `user` unless the project steward classified it under a `project` entry. */
  decision: "project" | "user";
  /** Whether the plugin posted a project-steward approval marker on this pull request. */
  projectApproved: boolean;
  /** Whether the reviewer's latest owner-reviewed marker escalated the pull request to the owner (BB-192). */
  escalated: boolean;
  /**
   * The product reason (BB-207) when the reviewer judged the pull request
   * substantial and no referenced ticket has an approved spec; null otherwise.
   * It makes the pull request the owner's and a project-steward `bb-approval`
   * never meets it.
   */
  reason: "product" | null;
};

/**
 * The refusal a project steward hears when it tries to approve a pull request
 * whose reviewer marker escalated it to the owner (`approver=owner`, or a
 * missing/unknown approver, fail closed). A `bb-approval` is not the gate
 * whatever the decide list matched, so the project steward forwards it instead
 * (BB-192).
 */
export const ESCALATED_APPROVAL_REFUSAL =
  "The reviewer escalated this pull request to the owner, so the project steward does not decide it: the owner's unsigned approval is the gate. Forward it with steward_update { binding, forward, resolution: \"approve-decline\", recommendation }.";

/**
 * The refusal a project steward hears when it tries to approve a pull request
 * whose product reason (BB-207) makes it the owner's: it is substantial and
 * references no ticket with an approved spec, so the owner's unsigned approval
 * of the Product section is the gate and a `bb-approval` never meets it.
 */
export const PRODUCT_APPROVAL_REFUSAL =
  "This pull request is substantial and references no ticket with an approved spec, so the owner decides it: the owner's unsigned approval of the Product section is the gate, and a `bb-approval` never meets it. Forward it with steward_update { binding, forward, resolution: \"approve-decline\", recommendation }.";

/** The project steward's side of the gate: the decide mark and the plugin's own approval records. */
export type PrGateOptions = {
  /** The mark for the entry the project steward classified the pull request under; omitted is `user` (fail closed). */
  decision?: "project" | "user";
  /** The plugin's own `project_approvals` records for this binding, matched to the marker by comment id. */
  projectApprovals?: readonly ProjectApprovalRecord[];
  /** The review binding's substantial judgment (BB-207); omitted or null is unjudged, so no product reason and every lane as before. */
  substantial?: boolean | null;
  /** Whether a ticket the pull request references has an approved spec (BB-207); that is the ack, so the owner is not asked again. */
  ticketApprovedSpec?: boolean;
  /**
   * Whether the pull request's base ref changed after the approval being
   * considered (BB-279). Omitted reads the pull snapshot's `baseChangedAt`
   * against the approval time; a base that never changed applies no retarget
   * rule, so a pull request based on the default branch throughout that is
   * merely behind keeps its approval.
   */
  baseChangedSinceApproval?: boolean;
  /**
   * Whether the head's merge-base with the default branch is the default
   * branch's tip (BB-279). True means a retargeted head is based on the
   * default branch; false, null or omitted when the source cannot tell, which
   * fails closed only when the base changed after the approval.
   */
  headMergeBaseIsDefaultTip?: boolean | null;
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
  // BB-207: a substantial pull request with no approved spec on a referenced
  // ticket is the owner's, whatever lane the reviewer assigned, and a
  // project-steward `bb-approval` never meets it. Substantial false or
  // unjudged (null) leaves every lane as before, which is what keeps the
  // change inert until a reviewer reports a verdict.
  const reason = productReason(opts.substantial ?? null, opts.ticketApprovedSpec ?? false);
  const product = reason !== null;

  // Only an explicit `no-review` marker skips the owner; a marker the plugin
  // cannot read, or an unknown lane, is the user's (fail closed). The product
  // reason raises a `no-review` marker to the owner lane.
  const ownerLane = lane !== "no-review" || product;
  // A reviewer may escalate an owner-reviewed pull request to the owner in its
  // marker: `approver=owner`, or a missing/unknown approver (fail closed). The
  // gate then needs the owner's unsigned approval and a project-steward
  // `bb-approval` never meets it, whatever `decideFor` says (BB-192). An
  // `approver=project` marker leaves the decide list in charge; `approver` on a
  // `no-review` marker is ignored, and no marker can move a `user` match down.
  // The product reason escalates the same way, so it is folded in here.
  const escalated = product || (marker !== null && ownerLane && marker.approver !== "project");
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
  const decision: "project" | "user" = escalated ? "user" : opts.decision === "project" || (opts.decision === undefined && projectApprovedRaw) ? "project" : "user";
  const projectApproved = projectApprovedRaw && decision === "project";
  // BB-279: an approval given before the pull request's base ref changed
  // counts only when the head is based on the default branch tip. The rule
  // fires only when the base ref changed after the approval: a pull request
  // based on the default branch throughout that is merely behind keeps its
  // approval, because the base never changed. The approval time is the one the
  // gate is using: the project steward's marker or the owner's approval.
  const approvalAt = decision === "project" ? (approval?.comment.createdAt ?? null) : owner.at;
  const baseChangedAt = pull?.baseChangedAt ?? null;
  const baseChangedSinceApproval = opts.baseChangedSinceApproval ?? (baseChangedAt !== null && approvalAt !== null && baseChangedAt > approvalAt);
  const headOnDefaultTip = opts.headMergeBaseIsDefaultTip ?? pull?.headMergeBaseIsDefaultTip ?? null;
  const baseStale = baseChangedSinceApproval && headOnDefaultTip !== true;
  const approved = (decision === "project" ? projectApproved : owner.approved) && !baseStale;
  // A stale approval is not a request for another approval: the head must be
  // rebased onto the default branch first, and a fresh approval would only let
  // the un-rebased head merge. So neither approval is asked for while
  // `baseStale`, and `missing` names the rebase.
  const approvalNeeded = ownerLane && markerApproved && checksGreen && !approved && !baseStale;
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
              ? baseStale
                ? "rebase the head onto the default branch: the base changed since the approval"
                : product
                  ? "owner approval needed (product)"
                  : escalated
                    ? "owner approval needed (the reviewer escalated it)"
                    : decision === "project"
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
    ownerApprovalId: owner.id,
    ownerApprovalUrl: owner.url,
    ownerApprovalKind: owner.kind,
    projectApprovalId: approval?.comment.id ?? null,
    projectApprovalUrl: approval?.comment.url ?? null,
    gateMet,
    missing,
    needsOwnerApproval: approvalNeeded && decision === "user",
    needsProjectApproval: approvalNeeded && decision === "project",
    baseStale,
    decision,
    projectApproved,
    escalated,
    reason,
  };
}

