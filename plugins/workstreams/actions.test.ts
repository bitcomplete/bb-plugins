// Row actions: availability, thread routing, prompts, merge refusals and the
// nudge comment. Fixtures are the invented Inkwell bookstore: repos quill,
// folio, margin, colophon and spine; tickets ABC-/OPS-/WEB-/SHOP-; PRs 42–99.
import { describe, expect, it } from "vitest";
import {
  AGENT_ACTIONS,
  actionPreview,
  actionPrompt,
  mergeVerdict,
  nudgeComment,
  primaryAction,
  recommendThread,
  shouldDeleteBranch,
  type AgentAction,
  type LiveMergeFacts,
  type ThreadCandidate,
  type ThreadCapabilities,
} from "./actions.js";
import { RESULT_INSTRUCTION } from "./runs.js";
import { inboxSection, inboxVerb, type InboxUnitFacts } from "./workstreams.js";
import type { MergeStateStatus } from "./contract.js";

const NOW = Date.parse("2030-01-10T12:00:00Z");

function unit(overrides: Partial<InboxUnitFacts> = {}): InboxUnitFacts {
  return { ticket: "ABC-101", lifecycle: "awaiting-review", stack: null, pr: { mergedAt: null, mergeStateStatus: "CLEAN" }, ...overrides };
}

/** The action a unit's row offers, read exactly as the Board reads it. */
function actionOf(facts: InboxUnitFacts) {
  const section = inboxSection(facts, NOW);
  return primaryAction(facts, section, inboxVerb(facts, section));
}

describe("primaryAction", () => {
  it("offers each agent action only on the row whose verb calls for it", () => {
    expect(actionOf(unit({ lifecycle: "blocked" }))).toMatchObject({ kind: "agent", action: "investigate-ci" });
    expect(actionOf(unit({ lifecycle: "awaiting-review", pr: { mergeStateStatus: "DIRTY" } }))).toMatchObject({
      kind: "agent",
      action: "resolve-conflicts",
    });
    expect(actionOf(unit({ lifecycle: "awaiting-followup" }))).toMatchObject({ kind: "agent", action: "address-review" });
    expect(actionOf(unit({ lifecycle: "awaiting-rereview" }))).toBeNull();
    expect(actionOf(unit({ lifecycle: "approved-with-comments" }))).toMatchObject({ kind: "agent", action: "address-comments" });
    expect(actionOf(unit({ lifecycle: "approved-with-note" }))).toMatchObject({ kind: "agent", action: "review-approval-note" });
  });

  it("offers the direct actions only where GitHub says they apply", () => {
    expect(actionOf(unit({ lifecycle: "awaiting-merge" }))).toMatchObject({ kind: "direct", action: "merge" });
    expect(actionOf(unit({ lifecycle: "awaiting-merge", pr: { mergeStateStatus: "UNSTABLE" } }))).toMatchObject({ action: "merge" });
    expect(actionOf(unit({ lifecycle: "awaiting-merge", pr: { mergeStateStatus: "BEHIND" } }))).toMatchObject({
      kind: "direct",
      action: "update-branch",
    });
    expect(actionOf(unit({ lifecycle: "awaiting-review" }))).toMatchObject({ kind: "direct", action: "nudge" });
  });

  it("never offers Merge on a row stacked behind an unmerged PR, only a jump to the PR it waits on", () => {
    const behind = unit({ lifecycle: "awaiting-merge", stack: { blockedBelow: 57 } });
    expect(actionOf(behind)).toEqual({ kind: "jump", behind: 57, label: "Go to #57" });
  });

  it("offers nothing where there is nothing to do but wait or look", () => {
    expect(actionOf(unit({ lifecycle: "awaiting-merge", pr: { mergeStateStatus: "BLOCKED" } }))).toBeNull();
    expect(actionOf(unit({ lifecycle: "awaiting-merge", pr: { mergeStateStatus: "UNKNOWN" } }))).toBeNull();
    expect(actionOf(unit({ lifecycle: "in-progress" }))).toBeNull();
    expect(actionOf(unit({ lifecycle: "merged", pr: { mergedAt: "2030-01-09T10:00:00Z" } }))).toBeNull();
    expect(actionOf(unit({ lifecycle: "up-next", ticket: null, pr: null }))).toBeNull();
  });
});

const ALL: ThreadCapabilities = { send: true, subthread: true, contextUsage: true };

function thread(overrides: Partial<ThreadCandidate> = {}): ThreadCandidate {
  return {
    id: "thr_a",
    title: "Gift card balance on folio",
    tier: "started",
    running: false,
    updatedAt: 1_000,
    contextUsed: 0.2,
    canSpawnChild: true,
    ...overrides,
  };
}

describe("recommendThread for review replies", () => {
  for (const action of ["address-review", "address-comments"] as AgentAction[]) {
    it(`${action}: gives the idle author thread a dedicated subthread for reliable run tracking`, () => {
      const result = recommendThread(action, [thread({ tier: "environment" })], ALL);
      expect(result).toMatchObject({ mode: "subthread", threadId: "thr_a" });
      expect(result.reason).toBe("Subthread of 'Gift card balance on folio': it wrote this PR; this action gets its own tracked thread.");
    });

    it(`${action}: spawns a subthread of a running author thread, so its work is not interrupted`, () => {
      expect(recommendThread(action, [thread({ running: true })], ALL)).toMatchObject({ mode: "subthread", threadId: "thr_a" });
    });

    it(`${action}: starts a new thread when only weak links exist, because those often point at large unrelated threads`, () => {
      const weak = [thread({ tier: "ticket" }), thread({ id: "thr_b", tier: "paths" })];
      expect(recommendThread(action, weak, ALL)).toMatchObject({ mode: "new", threadId: null });
      expect(recommendThread(action, [], ALL)).toMatchObject({ mode: "new", threadId: null });
    });
  }

  it("prefers the strongest and most recent author thread as parent", () => {
    const threads = [thread({ id: "thr_run", running: true, updatedAt: 9_000 }), thread({ id: "thr_idle", tier: "environment" })];
    expect(recommendThread("address-review", threads, ALL)).toMatchObject({ mode: "subthread", threadId: "thr_run" });
  });

  it("uses a dedicated subthread regardless of author context use", () => {
    const result = recommendThread("address-review", [thread({ contextUsed: 0.82 })], ALL);
    expect(result).toMatchObject({ mode: "subthread", threadId: "thr_a" });
    expect(recommendThread("address-review", [thread({ contextUsed: 0.7 })], ALL).mode).toBe("subthread");
  });

  it("can use a subthread when the SDK does not report context use", () => {
    expect(recommendThread("address-review", [thread({ contextUsed: 0.95 })], { ...ALL, contextUsage: false }).mode).toBe("subthread");
  });

  it("degrades: no subthreads or BB refusing a child → new", () => {
    expect(recommendThread("address-review", [thread()], { ...ALL, send: false }).mode).toBe("subthread");
    expect(recommendThread("address-review", [thread()], { send: false, subthread: false, contextUsage: true }).mode).toBe("new");
    expect(recommendThread("address-review", [thread({ running: true })], { ...ALL, subthread: false }).mode).toBe("new");
    const refused = recommendThread("address-review", [thread({ running: true, canSpawnChild: false })], ALL);
    expect(refused.mode).toBe("new");
    expect(refused.reason).toContain("will not add a subthread");
  });
});

describe("recommendThread for repairs (CI, conflicts)", () => {
  for (const action of ["investigate-ci", "resolve-conflicts"] as AgentAction[]) {
    it(`${action}: hangs a subthread off even a weak-only link, keeping lineage without touching the parent's context`, () => {
      const result = recommendThread(action, [thread({ tier: "paths" })], ALL);
      expect(result).toMatchObject({ mode: "subthread", threadId: "thr_a" });
      expect(result.reason).toBe("Subthread of 'Gift card balance on folio': it's the most relevant thread already on this work.");
    });

    it(`${action}: subthreads an idle author thread too, rather than continuing in it`, () => {
      expect(recommendThread(action, [thread()], ALL).mode).toBe("subthread");
    });

    it(`${action}: starts a new thread only when nothing is linked`, () => {
      expect(recommendThread(action, [], ALL)).toMatchObject({ mode: "new", threadId: null });
    });

    it(`${action}: degrades to new, saying why, without subthread support`, () => {
      const result = recommendThread(action, [thread()], { ...ALL, subthread: false });
      expect(result.mode).toBe("new");
      expect(result.reason).toContain("cannot spawn a subthread");
    });
  }

  it("picks the best thread by tier, then most recent, then id", () => {
    const pick = (threads: ThreadCandidate[]) => recommendThread("investigate-ci", threads, ALL).threadId;
    expect(pick([thread({ id: "thr_p", tier: "paths", updatedAt: 9_000 }), thread({ id: "thr_t", tier: "ticket", updatedAt: 1 })])).toBe("thr_t");
    expect(pick([thread({ id: "thr_old", tier: "ticket", updatedAt: 1 }), thread({ id: "thr_new", tier: "ticket", updatedAt: 2 })])).toBe("thr_new");
    expect(pick([thread({ id: "thr_b", tier: "ticket" }), thread({ id: "thr_a", tier: "ticket" })])).toBe("thr_a");
  });
});

const FACTS = { repo: "folio", prNumber: 47, title: "Show gift card balance", branch: "dev/abc-101", path: "/p/folio-abc-101" };

describe("actionPrompt", () => {
  it("substitutes every field into the address-review prompt, and forbids a gratuitous re-request", () => {
    const text = actionPrompt("address-review", FACTS);
    expect(text).toMatch(/^Changes were requested on folio #47 \(Show gift card balance\), branch dev\/abc-101, checkout \/p\/folio-abc-101\. /u);
    expect(text).toContain("Resolve only the threads the pushed code demonstrably addresses.");
    expect(text).toContain("Do not re-request review unless");
    expect(text).toContain("Report back with a summary per thread.");
  });

  it("opens the address-comments prompt with the approval, and ends by forbidding the merge", () => {
    const text = actionPrompt("address-comments", FACTS);
    expect(text.startsWith("folio #47 (Show gift card balance) is approved but has open review comments")).toBe(true);
    expect(text).toContain("Do not merge. Report back whether the PR is ready to merge.");
  });

  it("finishes approval feedback and branch conflicts before claiming the PR is mergeable", () => {
    const prompt = actionPrompt("review-approval-note", FACTS);
    const preview = actionPreview("review-approval-note", { approvalHasBody: true, unresolvedReviewThreads: 0 });
    expect(prompt).toContain("leave informational points alone and explain why");
    expect(prompt).toMatch(/Make focused fixes with relevant tests.*Fetch the PR's base branch.*rebase if behind, resolve any conflicts.*run the tests again.*Commit and push.*exact --force-with-lease/us);
    expect(prompt).toContain("Reply on the PR to the approving review note, mention its reviewer, and state what changed or why a point needs no change.");
    expect(prompt).toContain('Start that PR comment with "Approval note for @reviewer:" using the reviewer\'s actual login, and include the pushed head SHA');
    expect(prompt).toMatch(/After the push and reply, wait for checks to settle, then re-read the live PR state, review decision, unresolved threads, checks, and mergeStateStatus.*Verify the PR is actually mergeable before reporting it ready/us);
    expect(prompt).toContain("if any gate remains, name that gate and the next action. Do not merge.");
    expect(preview.steps.join(" ")).toMatch(/Review each approval note.*rebase if behind and resolve conflicts.*Run relevant tests, commit, and push.*Reply on the PR.*Wait for checks, then re-read live approval, threads, checks, and mergeability/us);
    expect(preview.lastScan).toEqual(["Written approval note present"]);
    expect(preview.steps.join(" ")).toContain("Report remaining gates; do not merge.");
  });

  it("asks the conflict prompt for an exact --force-with-lease, in the right checkout", () => {
    expect(actionPrompt("resolve-conflicts", FACTS)).toBe(
      "folio #47 (Show gift card balance) has merge conflicts with its base. In checkout /p/folio-abc-101 on branch dev/abc-101, bring in the base branch, resolve the conflicts preserving both sides' intent, run the tests, and push with an exact --force-with-lease if you rebased. Report what conflicted and how you resolved it. End your final message with a line starting 'Result:' that says what happened in under 12 words.",
    );
  });

  it("reuses the existing Fix prompt for CI", () => {
    expect(actionPrompt("investigate-ci", FACTS)).toMatch(/^CI is failing on folio #47/u);
  });

  it("ends every template with the Result line the Board reads the outcome from, so no action reports back blind", () => {
    for (const action of AGENT_ACTIONS) {
      expect(actionPrompt(action, FACTS).endsWith(` ${RESULT_INSTRUCTION}`)).toBe(true);
    }
  });

  it("leaves no placeholder behind in any template", () => {
    for (const action of ["investigate-ci", "resolve-conflicts", "address-review", "address-comments"] as AgentAction[]) {
      expect(actionPrompt(action, FACTS)).not.toMatch(/[{}]|undefined|null/u);
    }
  });
});

describe("actionPreview", () => {
  it("presents CI as investigation and a proposed fix, without promising a code push", () => {
    const preview = actionPreview("investigate-ci", { checkConclusions: ["SUCCESS", "FAILURE", "ERROR"] });
    expect(preview.steps).toEqual(["Investigate the CI failure.", "Propose a fix and report what you found."]);
    expect(preview.steps.join(" ")).not.toMatch(/commit|push|merge/u);
    expect(actionPrompt("investigate-ci", FACTS)).toContain("Investigate the failure and propose a fix.");
    expect(preview.lastScan).toEqual(["2 failing checks of 3"]);
    expect(actionPreview("investigate-ci", { checkConclusions: ["SUCCESS"] }).lastScan).toEqual([]);
  });

  it("tracks the conflict prompt's base, test, and conditional safe push", () => {
    const preview = actionPreview("resolve-conflicts", { headRefName: "dev/abc-101", baseRefName: "main" });
    expect(preview.lastScan).toEqual(["dev/abc-101 → main"]);
    expect(preview.steps.join(" ")).toMatch(/base branch.*resolve conflicts.*Run the tests.*Push.*--force-with-lease if rebased/us);
    expect(actionPrompt("resolve-conflicts", FACTS)).toContain("push with an exact --force-with-lease if you rebased");
  });

  for (const action of ["address-review", "address-comments"] as const) {
    it(`${action} includes the prompt's code push, replies, and demonstrated-only resolution`, () => {
      const preview = actionPreview(action, { unresolvedReviewThreads: 2 });
      const steps = preview.steps.join(" ");
      expect(preview.lastScan).toEqual(["2 open review threads"]);
      expect(steps).toMatch(/Fetch every review comment and thread.*Commit and push.*reply on every comment thread.*Resolve only threads the pushed code demonstrably addresses/us);
      expect(steps).toContain("Re-request review only if materially riskier.");
      expect(actionPrompt(action, FACTS)).toContain("Resolve only the threads the pushed code demonstrably addresses.");
      expect(steps.includes("Do not merge.")).toBe(action === "address-comments");
    });
  }

  it("names only reviewers who requested changes and bounds the scan detail", () => {
    const preview = actionPreview("address-review", {
      latestReviews: [
        { login: "ada", state: "CHANGES_REQUESTED" },
        { login: "bea", state: "APPROVED" },
        { login: "cam", state: "CHANGES_REQUESTED" },
        { login: "dee", state: "CHANGES_REQUESTED" },
        { login: "eli", state: "CHANGES_REQUESTED" },
      ],
    });
    expect(preview.lastScan).toEqual(["Changes requested by ada, cam, dee and 1 more"]);
  });
});

function live(overrides: Partial<LiveMergeFacts> = {}): LiveMergeFacts {
  return {
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    headRefOid: "a".repeat(40),
    stackedAbove: [],
    unresolvedThreads: 0,
    unresolvedAtLeast: false,
    approvalNotes: [],
    approvalNotesMore: 0,
    approvalNotesComplete: true,
    ...overrides,
  };
}

describe("mergeVerdict", () => {
  it("allows an open, approved, clean PR", () => {
    expect(mergeVerdict(live())).toEqual({ refusals: [], warnings: [] });
    expect(mergeVerdict(live({ mergeStateStatus: "HAS_HOOKS" })).refusals).toEqual([]);
  });

  it("allows UNSTABLE with a warning", () => {
    expect(mergeVerdict(live({ mergeStateStatus: "UNSTABLE" }))).toEqual({
      refusals: [],
      warnings: ["Some checks that are not required are failing."],
    });
  });

  const refusals: [string, Partial<LiveMergeFacts>, string][] = [
    ["a draft", { isDraft: true }, "It is a draft."],
    ["an unapproved PR", { reviewDecision: "REVIEW_REQUIRED" }, "It is not approved."],
    ["a PR with no review decision", { reviewDecision: null }, "It is not approved."],
    ["a closed PR", { state: "CLOSED" }, "The pull request is closed."],
    ...(["DIRTY", "BEHIND", "BLOCKED", "UNKNOWN"] as MergeStateStatus[]).map(
      (status): [string, Partial<LiveMergeFacts>, string] => [status, { mergeStateStatus: status }, ""],
    ),
    ["a missing head sha", { headRefOid: null }, "GitHub did not report the head commit."],
  ];
  for (const [what, overrides, reason] of refusals) {
    it(`refuses ${what}, with a reason`, () => {
      const verdict = mergeVerdict(live(overrides));
      expect(verdict.refusals.length).toBe(1);
      if (reason !== "") expect(verdict.refusals[0]).toBe(reason);
    });
  }
});

describe("shouldDeleteBranch", () => {
  it("deletes only when the setting allows it and no open PR is based on the branch", () => {
    expect(shouldDeleteBranch(true, [])).toBe(true);
    expect(shouldDeleteBranch(false, [])).toBe(false);
    expect(shouldDeleteBranch(true, [58])).toBe(false);
  });
});

describe("nudgeComment", () => {
  it("starts with the literal 'PTAL - ' and mentions every pending reviewer", () => {
    const text = nudgeComment({ reviewers: ["ada-inkwell", "shop/reviewers"], repo: "margin", prNumber: 61, title: "Paginate the reading list", age: "3d" });
    expect(text).toBe("PTAL - @ada-inkwell @shop/reviewers: margin #61 (Paginate the reading list) has been waiting 3d.");
    expect(text.startsWith("PTAL - ")).toBe(true);
  });

  it("still starts with 'PTAL - ' and leaves no empty mention with no pending reviewers", () => {
    const text = nudgeComment({ reviewers: [], repo: "margin", prNumber: 61, title: "Paginate the reading list", age: "3d" });
    expect(text).toBe("PTAL - margin #61 (Paginate the reading list) has been waiting 3d.");
  });
});
