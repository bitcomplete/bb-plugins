// Row actions on the Board inbox. Pure: which action a row offers, which
// thread an agent action should run in, the prompts it sends, and whether a
// merge may go ahead. Nothing here runs a command or calls the SDK; host.ts and
// server.ts do, and they read every decision from here so it can be tested.
import type { MergeStateStatus } from "./contract.js";
import { threadPrompt, waitingBehind, type InboxSection, type InboxUnitFacts, type PromptFacts } from "./workstreams.js";
import type { ThreadTier } from "./threads.js";
import { RESULT_INSTRUCTION } from "./runs.js";

/** Actions that need judgement, so they go to an agent thread. */
export const AGENT_ACTIONS = ["investigate-ci", "resolve-conflicts", "address-review", "address-comments", "review-approval-note"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Mechanical GitHub actions the host runs directly, behind a confirm dialog. */
export const DIRECT_ACTIONS = ["merge", "update-branch", "nudge"] as const;
export type DirectAction = (typeof DIRECT_ACTIONS)[number];

export type PrimaryAction =
  | { kind: "agent"; action: AgentAction; label: string }
  | { kind: "direct"; action: DirectAction; label: string }
  | { kind: "jump"; behind: number; label: string };

export const AGENT_LABEL: Record<AgentAction, string> = {
  "investigate-ci": "Investigate CI",
  "resolve-conflicts": "Resolve conflicts",
  "address-review": "Address review and reply",
  "address-comments": "Address comments and reply",
  "review-approval-note": "Review approval note",
};

export const DIRECT_LABEL: Record<DirectAction, string> = {
  merge: "Merge",
  "update-branch": "Update branch",
  nudge: "Nudge reviewers",
};

/**
 * The one action a row's `a` key runs, read from the verb `inboxVerb` gave it
 * so the action can never disagree with what the row says. Null where there is
 * nothing to do but look: in flight, shipped, parked, or a PR held by branch
 * rules or an unfinished mergeability check.
 */
export function primaryAction(
  unit: Pick<InboxUnitFacts, "lifecycle" | "stack">,
  section: InboxSection,
  verb: string | null,
): PrimaryAction | null {
  const agent = (action: AgentAction): PrimaryAction => ({ kind: "agent", action, label: AGENT_LABEL[action] });
  const direct = (action: DirectAction): PrimaryAction => ({ kind: "direct", action, label: DIRECT_LABEL[action] });
  if (section === "fix" && verb === "CI failing") return agent("investigate-ci");
  if (section === "fix" && verb === "Resolve conflicts") return agent("resolve-conflicts");
  if (section === "respond" && verb === "Changes requested") return agent("address-review");
  if (section === "respond" && verb === "Approved, comments open") return agent("address-comments");
  if (section === "respond" && verb === "Review approval note") return agent("review-approval-note");
  if (section === "merge" && verb === "Ready to merge") return direct("merge");
  if (section === "merge" && verb === "Update branch") return direct("update-branch");
  if (section === "waiting" && verb === "In review") return direct("nudge");
  const behind = section === "waiting" ? waitingBehind(unit) : null;
  if (behind !== null) return { kind: "jump", behind, label: `Go to #${behind}` };
  return null;
}

// ---- which thread an agent action runs in -----------------------------------

export type ThreadMode = "continue" | "subthread" | "new";

/** A thread linked to the row, with what the dialog read about it live. */
export type ThreadCandidate = {
  id: string;
  title: string;
  tier: ThreadTier;
  /** Mid-turn (or starting, or stopping): a message would interrupt or queue. */
  running: boolean;
  updatedAt: number;
  /** Fraction of the context window in use, 0-1, or null when not reported. */
  contextUsed: number | null;
  /** BB's own answer to whether this thread may take a child. */
  canSpawnChild: boolean;
};

/** Which thread APIs are safe for tracked Board actions. */
export type ThreadCapabilities = { send: boolean; subthread: boolean; contextUsage: boolean };

export type Recommendation = { mode: ThreadMode; threadId: string | null; reason: string };

const STRONG = new Set<ThreadTier>(["started", "environment"]);
const TIER_ORDER: readonly ThreadTier[] = ["started", "environment", "ticket", "paths"];

/** Strongest tier first, then most recently updated, then id: total and stable. */
export function byRelevance(a: ThreadCandidate, b: ThreadCandidate): number {
  return (
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  );
}

function quoted(title: string): string {
  const flat = title.replace(/\s+/gu, " ").trim();
  return `'${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}'`;
}

/** A subthread of `parent` when the SDK and BB allow one, else a new thread that says why. */
function subthreadOr(parent: ThreadCandidate, caps: ThreadCapabilities, reason: string): Recommendation {
  if (!caps.subthread) {
    return { mode: "new", threadId: null, reason: "New thread: this BB version cannot spawn a subthread." };
  }
  if (!parent.canSpawnChild) {
    return { mode: "new", threadId: null, reason: `New thread: BB will not add a subthread to ${quoted(parent.title)}.` };
  }
  return { mode: "subthread", threadId: parent.id, reason };
}

/**
 * Where an agent action should run. The user can override it in the dialog;
 * this is only the preselection, and its reason is shown in one line.
 *
 * Repairs (CI, conflicts) hang off the most relevant linked thread of ANY tier
 * as a subthread: they do not need the author's reasoning, a subthread leaves
 * the parent's context untouched, and the parent hears when it finishes.
 *
 * Review replies use a subthread of the thread that wrote the PR (a strong
 * link). Each Board action needs its own thread so lifecycle events and final
 * answers belong to exactly one run. Weak links (a title or a path mention)
 * often point at large unrelated threads, so they get a new thread.
 */
export function recommendThread(
  action: AgentAction,
  candidates: readonly ThreadCandidate[],
  caps: ThreadCapabilities,
): Recommendation {
  const ranked = [...candidates].sort(byRelevance);
  if (action === "investigate-ci" || action === "resolve-conflicts") {
    const best = ranked[0];
    if (best === undefined) return { mode: "new", threadId: null, reason: "New thread: no thread is linked to this work yet." };
    return subthreadOr(best, caps, `Subthread of ${quoted(best.title)}: it's the most relevant thread already on this work.`);
  }
  const strong = ranked.filter((thread) => STRONG.has(thread.tier));
  if (strong.length === 0) {
    return ranked.length === 0
      ? { mode: "new", threadId: null, reason: "New thread: no thread is linked to this work yet." }
      : {
          mode: "new",
          threadId: null,
          reason: "New thread: the linked threads only mention this work, and may be large or unrelated.",
        };
  }
  const parent = strong.find((thread) => thread.canSpawnChild) ?? strong[0]!;
  return subthreadOr(parent, caps, `Subthread of ${quoted(parent.title)}: it wrote this PR; this action gets its own tracked thread.`);
}

// ---- prompts ----------------------------------------------------------------

function where(facts: PromptFacts): { pr: string; branch: string } {
  const title = facts.title === null || facts.title.trim() === "" ? "" : ` (${facts.title.trim()})`;
  return {
    pr: `${facts.repo} ${facts.prNumber === null ? "(no pull request)" : `#${facts.prNumber}`}${title}`,
    branch: facts.branch ?? "(no branch checked out)",
  };
}

const REVIEW_STEPS =
  "Fetch every review comment and review thread with gh. Address each one in the code, commit, and push. " +
  "Then reply on every comment thread saying what changed, or why you did not change it. " +
  "Resolve only the threads the pushed code demonstrably addresses. " +
  "Do not re-request review unless your change is materially riskier than what was reviewed.";

/**
 * The editable prompt an agent action starts from. Every field is substituted,
 * and every template ends by asking for a Result line, which is how the Board
 * reports the outcome without a model call (see `extractResult`).
 */
export function actionPrompt(action: AgentAction, facts: PromptFacts): string {
  return `${actionBody(action, facts)} ${RESULT_INSTRUCTION}`;
}

function actionBody(action: AgentAction, facts: PromptFacts): string {
  const { pr, branch } = where(facts);
  switch (action) {
    case "investigate-ci":
      return threadPrompt("fix", facts);
    case "address-review":
      return `Changes were requested on ${pr}, branch ${branch}, checkout ${facts.path}. ${REVIEW_STEPS} Report back with a summary per thread.`;
    case "address-comments":
      return `${pr} is approved but has open review comments, branch ${branch}, checkout ${facts.path}. ${REVIEW_STEPS} Report back with a summary per thread. Do not merge. Report back whether the PR is ready to merge.`;
    case "review-approval-note":
      return `${pr} is approved with a written review note, branch ${branch}, checkout ${facts.path}. Read the approving review body and decide which points need code changes; leave informational points alone and explain why. Make focused fixes with relevant tests. Fetch the PR's base branch and integrate it before finishing: rebase if behind, resolve any conflicts preserving both sides' intent, and run the tests again. Commit and push the resulting work; use an exact --force-with-lease if rebased. Reply on the PR to the approving review note, mention its reviewer, and state what changed or why a point needs no change. Start that PR comment with "Approval note for @reviewer:" using the reviewer's actual login, and include the pushed head SHA so the follow-up is tied to the code you checked. After the push and reply, wait for checks to settle, then re-read the live PR state, review decision, unresolved threads, checks, and mergeStateStatus. Verify the PR is actually mergeable before reporting it ready; if any gate remains, name that gate and the next action. Do not merge. Report the fix, branch update, reply, test result, and live merge readiness.`;
    case "resolve-conflicts":
      return `${pr} has merge conflicts with its base. In checkout ${facts.path} on branch ${branch}, bring in the base branch, resolve the conflicts preserving both sides' intent, run the tests, and push with an exact --force-with-lease if you rebased. Report what conflicted and how you resolved it.`;
  }
}

/** Short, default-instruction preview. Scan facts are observations, not live checks. */
export function actionPreview(
  action: AgentAction,
  scan: {
    checkConclusions?: readonly string[];
    baseRefName?: string | null;
    headRefName?: string | null;
    latestReviews?: readonly { login: string; state: string }[];
    unresolvedReviewThreads?: number | null;
    approvalHasBody?: boolean;
  } | null,
): { steps: string[]; lastScan: string[] } {
  const lastScan: string[] = [];
  switch (action) {
    case "investigate-ci": {
      const checks = scan?.checkConclusions;
      if (checks !== undefined) {
        const failing = checks.filter((value) => value === "FAILURE" || value === "ERROR").length;
        if (failing > 0) lastScan.push(`${failing} failing ${failing === 1 ? "check" : "checks"} of ${checks.length}`);
      }
      return { steps: ["Investigate the CI failure.", "Propose a fix and report what you found."], lastScan };
    }
    case "resolve-conflicts":
      if (scan?.headRefName && scan.baseRefName) lastScan.push(`${scan.headRefName} → ${scan.baseRefName}`);
      return {
        steps: [
          "Bring in the base branch and resolve conflicts, preserving both sides' intent.",
          "Run the tests.",
          "Push the result; use an exact --force-with-lease if rebased. Report the resolutions.",
        ],
        lastScan,
      };
    case "address-review":
    case "address-comments": {
      if (scan?.unresolvedReviewThreads !== null && scan?.unresolvedReviewThreads !== undefined) {
        lastScan.push(`${scan.unresolvedReviewThreads} open review ${scan.unresolvedReviewThreads === 1 ? "thread" : "threads"}`);
      }
      if (action === "address-review") {
        const reviewers = scan?.latestReviews?.filter((review) => review.state === "CHANGES_REQUESTED") ?? [];
        if (reviewers.length > 0) {
          const names = reviewers.slice(0, 3).map((review) => review.login).join(", ");
          lastScan.push(`Changes requested by ${names}${reviewers.length > 3 ? ` and ${reviewers.length - 3} more` : ""}`);
        }
      }
      return {
        steps: [
          "Fetch every review comment and thread; address each in the code.",
          "Commit and push, then reply on every comment thread with what changed or why it did not.",
          "Resolve only threads the pushed code demonstrably addresses; summarize each thread. Re-request review only if materially riskier.",
          ...(action === "address-comments" ? ["Report whether the PR is ready to merge. Do not merge."] : []),
        ],
        lastScan,
      };
    }
    case "review-approval-note":
      return {
        steps: [
          "Review each approval note; fix actionable points and explain informational ones.",
          "Fetch and integrate the base; rebase if behind and resolve conflicts preserving intent.",
          "Run relevant tests, commit, and push; use an exact --force-with-lease after a rebase.",
          "Reply on the PR to the approving reviewer with what changed or why no change was needed; include the pushed head SHA.",
          "Wait for checks, then re-read live approval, threads, checks, and mergeability. Report remaining gates; do not merge.",
        ],
        lastScan: scan?.approvalHasBody ? ["Written approval note present"] : [],
      };
  }
}

// ---- merge ------------------------------------------------------------------

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** What the merge dialog re-reads from GitHub the moment it opens. */
export type LiveMergeFacts = {
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: MergeStateStatus;
  headRefOid: string | null;
  /** Open PRs whose base is this PR's head branch: merging with delete would orphan them. */
  stackedAbove: number[];
  unresolvedThreads: number;
  /** True when there were more review threads than one page could count. */
  unresolvedAtLeast: boolean;
  /** Written approving reviews from complete live review history, newest first. */
  approvalNotes: { author: string; body: string; submittedAt: string; truncated: boolean }[];
  approvalNotesMore: number;
  /** False when GitHub could not provide the complete review history. */
  approvalNotesComplete: boolean;
};

export type MergeVerdict = { refusals: string[]; warnings: string[] };

export const SHA = /^[0-9a-f]{40}$/u;

const MERGE_STATE_REFUSAL: Partial<Record<MergeStateStatus, string>> = {
  DIRTY: "It has merge conflicts with its base.",
  BEHIND: "The branch is behind its base. Update the branch first.",
  BLOCKED: "Branch protection is not satisfied (a required check or review is missing).",
  UNKNOWN: "GitHub has not worked out whether it can merge yet. Try again in a moment.",
};

/** Refuse unless open, not a draft, approved, and CLEAN / HAS_HOOKS / UNSTABLE. */
export function mergeVerdict(live: LiveMergeFacts): MergeVerdict {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (live.state !== "OPEN") refusals.push(`The pull request is ${live.state.toLowerCase() || "not open"}.`);
  if (live.isDraft) refusals.push("It is a draft.");
  if (live.reviewDecision !== "APPROVED") {
    refusals.push(
      live.reviewDecision === "CHANGES_REQUESTED" ? "Changes are requested." : "It is not approved.",
    );
  }
  const status = MERGE_STATE_REFUSAL[live.mergeStateStatus];
  if (status !== undefined) refusals.push(status);
  if (live.mergeStateStatus === "UNSTABLE") warnings.push("Some checks that are not required are failing.");
  if (live.headRefOid === null || !SHA.test(live.headRefOid)) refusals.push("GitHub did not report the head commit.");
  return { refusals, warnings };
}

/** `--delete-branch` only when allowed AND nothing open is based on this branch. */
export function shouldDeleteBranch(setting: boolean, stackedAbove: readonly number[]): boolean {
  return setting && stackedAbove.length === 0;
}

// ---- nudge ------------------------------------------------------------------

/**
 * The prefilled nudge comment. It always opens with the literal "PTAL - ";
 * with no pending reviewers the mention is left out rather than left empty.
 */
export function nudgeComment(facts: {
  reviewers: readonly string[];
  repo: string;
  prNumber: number;
  title: string;
  age: string;
}): string {
  const who = facts.reviewers.length === 0 ? "" : `${facts.reviewers.map((login) => `@${login}`).join(" ")}: `;
  const waiting = facts.age.trim() === "" ? "is waiting on review" : `has been waiting ${facts.age.trim()}`;
  return `PTAL - ${who}${facts.repo} #${facts.prNumber} (${facts.title.trim()}) ${waiting}.`;
}
