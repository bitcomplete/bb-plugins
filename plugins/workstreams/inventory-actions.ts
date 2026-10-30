// The PR inventory's one-click actions: mark a draft ready, request review,
// nudge the reviewers attention names, and confirm an approval's comments
// handled. Each click authorizes one write on the facts the row showed, which
// the click sends back: a GitHub write, or for a confirmation, a verification
// recorded as yours. Before writing, it reads the PR again, and it refuses
// under a hold (the PR's or its effort's) or another writer, and
// when the facts the step depends on changed since the row was shown. A
// confirmation also reads what came after the approval, and without evidence
// that its notes were handled it records only when you confirm anyway. Asking
// the PR's thread to address the notes instead sends it the approval-feedback
// recipe, on the same guards. Every outcome is recorded, refusals included.
// Merge is not here: the row opens the existing fresh merge preview, and
// nothing merges outside it.
import type { ApprovalFeedbackSnapshot } from "./approval-feedback.js";
import { evidenceText, handled, type ApprovalEvidence, type ApprovalHandling } from "./approval-evidence.js";
import type { Pr, PrWrite } from "./contract.js";
import { feedbackToAddress } from "./feedback-to-address.js";
import { REVIEWER } from "./ghactions.js";
import type { AttentionReason } from "./pr-attention.js";
import type { PrHold } from "./pr-holds.js";
import { fixesFor, FIX_WORDS, type FixKind } from "./effort-recipes.js";
import type { PlannedRoute } from "./deck-batch.js";

export type InventoryAction = "mark-ready" | "request-review" | "nudge" | "confirm-handled" | "ask-thread" | "ask-fix" | "revoke-confirmation";
export type ActionResult = { ok: true; detail: string } | { ok: false; error: string };
export type ActionRecord = { at: number; prUrl: string; action: InventoryAction; ok: boolean; detail: string; reviewers: string[] };
/** The reviewers a row showed: those asked, and those who reviewed, with their latest review's state. */
export type ShownReviewers = { requested: readonly string[]; reviewed: readonly { login: string; state: string }[] };

export type InventoryActionDeps = {
  now(): number;
  /** Whether the PR is one of your open PRs in the inventory. */
  listed(prUrl: string): boolean;
  hold(prUrl: string): PrHold | null;
  /** Why the PR's effort stops it: you put the effort on hold, completed it, or archived it, until you resume, reopen, or restore it. Null otherwise. */
  effortHold(prUrl: string): Promise<string | null>;
  /** Why another writer holds the PR or a checkout of it (a legacy batch, a launching board action), or null. */
  writer(prUrl: string): string | null;
  /** Take the PR's board-action lock, or null when another action holds it; the result releases it. */
  lock(prUrl: string): (() => void) | null;
  /** Read the PR from GitHub now, through the board's stores, as they keep it (ages a failed dates read left out carried): null once it isn't open. */
  read(prUrl: string): Promise<{ ok: true; pr: Pr | null } | { ok: false; error: string }>;
  /** The attention these facts earn, as the inventory computes it. */
  attention(pr: Pr): Promise<readonly AttentionReason[]>;
  write(request: PrWrite): Promise<ActionResult>;
  /** Read the approval's notes and what came after them from GitHub now. */
  handling(prUrl: string): Promise<ApprovalHandling>;
  /** Record your verification of this approval feedback on this head, with your provenance and the evidence you confirmed on. */
  confirm(prUrl: string, headOid: string, feedback: ApprovalFeedbackSnapshot, evidence: ApprovalEvidence): void;
  /**
   * Send the PR's own thread the approval-feedback recipe for these notes, starting one under its effort's parent only when it has none.
   * Called without the PR's lock, which the send takes itself.
   */
  ask(prUrl: string, notes: { headOid: string; feedback: ApprovalFeedbackSnapshot }): Promise<ActionResult>;
  /**
   * Send the PR's own thread these fixes, starting a worker for it only when it has none, and only where `route` says the listing named.
   * Called without the PR's lock, as `ask` is.
   */
  fix(prUrl: string, work: { headOid: string; fixes: FixKind[]; headBranch: string | null; route: PlannedRoute | undefined }): Promise<ActionResult>;
  record(entry: ActionRecord): Promise<void>;
};

type Step = { write: PrWrite; reviewers?: string[] } | { confirm: { headOid: string; feedback: ApprovalFeedbackSnapshot; evidence: ApprovalEvidence } }
  | { ask: { headOid: string; feedback: ApprovalFeedbackSnapshot } } | { fix: { headOid: string; fixes: FixKind[]; headBranch: string | null; route: PlannedRoute | undefined } }
  | { refuse: string };
const logins = (values: readonly string[]) => [...new Set(values.map((login) => login.toLowerCase()))].sort().join(", ");
const mentions = (values: readonly string[]) => values.map((login) => `@${login}`).join(", ");
/** Who a nudge re-requests: every reviewer an overdue request or an answered change request names. */
const nudged = (reasons: readonly AttentionReason[]) =>
  [...new Set(reasons.filter((reason) => reason.action === "nudge" || reason.action === "rerequest").flatMap((reason) => reason.reviewers))];

/**
 * Reviewers to ask, best first: those who already reviewed this PR, then those who most recently reviewed another PR in its repository,
 * as the board's reads observed them. Anyone already asked is left out.
 */
export function suggestReviewers(pr: Pick<Pr, "latestReviews" | "reviewRequests">, repository: readonly Pick<Pr, "latestReviews">[], limit = 5): string[] {
  const asked = new Set(pr.reviewRequests.map((login) => login.toLowerCase()));
  const recent = repository.flatMap((other) => other.latestReviews.filter((review) => review.state !== "PENDING"))
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
  const seen = new Set<string>();
  return [...pr.latestReviews.filter((review) => review.state !== "PENDING"), ...recent].flatMap(({ login }) => {
    const key = login.toLowerCase();
    if (asked.has(key) || seen.has(key) || !REVIEWER.test(login)) return [];
    seen.add(key);
    return [login];
  }).slice(0, limit);
}

export function createInventoryActions(deps: InventoryActionDeps) {
  const heldOrClaimed = (prUrl: string): string | null => {
    const hold = deps.hold(prUrl);
    return hold ? `On hold${hold.reason ? `: ${hold.reason}` : ""}. Release the hold first; nothing was written.` : deps.writer(prUrl);
  };
  /** One authorized write: guard, lock, read again, re-guard, decide on the fresh facts against the row's, write, read back, and record the outcome. */
  async function act(action: InventoryAction, prUrl: string, decide: (fresh: Pr) => Step | Promise<Step>): Promise<ActionResult> {
    const finish = async (result: ActionResult, reviewers: string[] = []) => {
      await deps.record({ at: deps.now(), prUrl, action, ok: result.ok, detail: result.ok ? result.detail : result.error, reviewers });
      return result;
    };
    const refuse = (error: string) => finish({ ok: false, error });
    if (!deps.listed(prUrl)) return refuse("That PR isn't one of your open PRs in the inventory. Refresh it and try again.");
    const guarded = heldOrClaimed(prUrl) ?? await deps.effortHold(prUrl);
    if (guarded) return refuse(guarded);
    const lock = deps.lock(prUrl);
    if (!lock) return refuse("Another action on this PR is still running; nothing was written.");
    let held = true;
    const release = () => { if (held) { held = false; lock(); } };
    try {
      const read = await deps.read(prUrl);
      if (!read.ok) return refuse(`GitHub couldn't be read, so nothing was written: ${read.error}`);
      if (!read.pr) return refuse("This PR is no longer open; nothing was written.");
      // A hold or a claim may have landed while GitHub answered.
      const late = heldOrClaimed(prUrl) ?? await deps.effortHold(prUrl);
      if (late) return refuse(late);
      const step = await decide(read.pr);
      if ("refuse" in step) return refuse(step.refuse);
      // GitHub doesn't change, so there's nothing to read back.
      // The thread send takes the PR's lock and checks every writer again itself.
      if ("ask" in step) { release(); return finish(await deps.ask(prUrl, step.ask)); }
      if ("fix" in step) { release(); return finish(await deps.fix(prUrl, step.fix)); }
      if ("confirm" in step) {
        const { headOid, feedback, evidence } = step.confirm;
        deps.confirm(prUrl, headOid, feedback, evidence);
        const seen = evidenceText(evidence);
        return finish({ ok: true, detail: handled(evidence) ? `Confirmed the approval's comments handled on ${headOid.slice(0, 7)}: ${seen}.`
          : `Confirmed the approval's comments handled on ${headOid.slice(0, 7)} without evidence. ${seen}.` });
      }
      const result = await deps.write(step.write);
      // Read it once more so its row shows what the write did.
      if (result.ok) await deps.read(prUrl);
      return finish(result, step.reviewers);
    } finally { release(); }
  }
  return {
    /** Only a draft, on the head its row showed; the host checks the head once more as it writes. */
    markReady: (prUrl: string, headOid: string) => act("mark-ready", prUrl, (fresh) => {
      if (!fresh.isDraft) return { refuse: "It's no longer a draft; nothing was written." };
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since the row was shown. Review it and try again; nothing was written." };
      return { write: { kind: "ready", prUrl, headOid } };
    }),
    /** Ask these reviewers, while the PR's reviewers stand as its row showed them. Anyone already asked is skipped. */
    requestReview: (prUrl: string, requested: readonly string[], shown: ShownReviewers) => act("request-review", prUrl, (fresh) => {
      const invalid = requested.filter((login) => !REVIEWER.test(login));
      if (requested.length === 0 || invalid.length) return { refuse: `Choose reviewers by GitHub login${invalid.length ? `; not a login: ${invalid.join(", ")}` : ""}.` };
      const reviewed = (reviews: ShownReviewers["reviewed"]) =>
        logins(reviews.filter((review) => review.state !== "PENDING").map((review) => `${review.login}:${review.state}`));
      if (logins(fresh.reviewRequests) !== logins(shown.requested) || reviewed(fresh.latestReviews) !== reviewed(shown.reviewed)) {
        return { refuse: `Its reviewers changed since the row was shown (now requested: ${mentions(fresh.reviewRequests) || "no one"}). Review it and try again; nothing was written.` };
      }
      const asked = new Set(fresh.reviewRequests.map((login) => login.toLowerCase()));
      const reviewers = [...new Set(requested)].filter((login) => !asked.has(login.toLowerCase()));
      if (reviewers.length === 0) return { refuse: `${mentions(requested)} ${requested.length === 1 ? "is" : "are"} already asked; nothing was written.` };
      return { write: { kind: "nudge", prUrl, reviewers, comment: null }, reviewers };
    }),
    /** Re-request exactly the reviewers the row's nudge named, and only while fresh facts name the same ones. */
    nudge: (prUrl: string, shown: readonly string[]) => act("nudge", prUrl, async (fresh) => {
      const after = nudged(await deps.attention(fresh));
      if (after.length === 0) return { refuse: "No reviewer needs a nudge now; nothing was written." };
      if (logins(shown) !== logins(after)) return { refuse: `Who needs a nudge changed since the row was shown (now ${mentions(after)}). Review it and try again; nothing was written.` };
      return { write: { kind: "nudge", prUrl, reviewers: after, comment: null }, reviewers: after };
    }),
    /**
     * Record the approval's comments handled, bound to the head and feedback the row showed, and only while fresh facts still ask for it.
     * With no commit, reply, or resolved thread since the approval, only `anyway` records it, and the record says there was no evidence.
     */
    confirmHandled: (prUrl: string, headOid: string, fingerprint: string, anyway = false) => act("confirm-handled", prUrl, async (fresh) => {
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since the row was shown. Review them and try again; nothing was written." };
      const feedback = fresh.approvalFeedback;
      if (feedback?.status !== "present") return { refuse: feedback?.status === "none" ? "The approval has no comments to confirm now; nothing was written."
        : "GitHub didn't return the approval's comments in full. Refresh and try again; nothing was written." };
      if (feedback.fingerprint !== fingerprint) return { refuse: "The approval's comments changed since the row was shown. Read them and try again; nothing was written." };
      // What earned the row's reason: an approval comment still to address, whatever a worker's evidence says, or notes you answered on an
      // approved, green, merge-clean PR with every review thread resolved. An approver who reopened a thread leaves the fingerprint as it was.
      if (!(await deps.attention(fresh)).some((reason) => reason.kind === "approval-note" || reason.kind === "approval-comments")) {
        return { refuse: fresh.approvalFeedbackVerified === true ? "These comments are already verified on this head; nothing was written."
          : "Its approval, checks, merge state, or review threads changed since the row was shown. Review it and try again; nothing was written." };
      }
      const notes = await deps.handling(prUrl);
      if (!notes.ok) return { refuse: `GitHub couldn't be read for the approval's notes, so nothing was written: ${notes.error}` };
      if (notes.headOid !== headOid || notes.fingerprint !== fingerprint) return { refuse: "The approval's notes or head changed while they were read. Read them again; nothing was written." };
      if (!handled(notes.evidence) && !anyway) return { refuse: `${evidenceText(notes.evidence)}. Ask its thread to address it, or confirm anyway; nothing was written.` };
      return { confirm: { headOid, feedback, evidence: notes.evidence } };
    }),
    /** Ask the PR's thread for the fixes the listing named, where it named, on the head its row showed, and only those fresh facts still call for. */
    askFix: (prUrl: string, headOid: string, fixes: readonly FixKind[], route: PlannedRoute | undefined) => act("ask-fix", prUrl, (fresh) => {
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since the row was shown. Review it and try again; nothing was sent." };
      const still = fixesFor(fresh).filter((kind) => fixes.includes(kind));
      if (!still.length) return { refuse: `It no longer needs to ${fixes.map((kind) => FIX_WORDS[kind]).join(" or ")}; nothing was sent.` };
      return { fix: { headOid, fixes: still, headBranch: fresh.headRefName, route } };
    }),
    /** Ask the PR's thread to address the approval's notes the row showed, while fresh facts still show them unverified on that head. */
    askThread: (prUrl: string, headOid: string, fingerprint: string) => act("ask-thread", prUrl, (fresh) => {
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since you read the notes. Read them again; nothing was sent." };
      const feedback = fresh.approvalFeedback;
      if (feedback?.status !== "present" || feedback.fingerprint !== fingerprint) return { refuse: "The approval's notes changed since you read them. Read them again; nothing was sent." };
      // A worker's evidence doesn't answer the reviewer; only your Confirm or a reply on the PR does.
      if (fresh.approvalFeedbackVerified === true && !feedbackToAddress(fresh, fresh.approvalFeedbackConfirmed === true).some((item) => item.kind === "approval")) {
        return { refuse: "These notes are already verified on this head; nothing was sent." };
      }
      return { ask: { headOid, feedback } };
    }),
  };
}
