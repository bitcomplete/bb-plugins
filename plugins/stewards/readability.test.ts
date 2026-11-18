import { describe, expect, it } from "vitest";
import type { DecisionExplanation } from "./decisions.js";
import { adoptionHow } from "./deps.js";
import {
  ADOPTION_WHY,
  adoptionNeedLine,
  approvePrNeedParts,
  approvePrWhy,
  approveSpecNeedParts,
  contextProblem,
  decisionWhy,
  forwardedQuestionParts,
  forwardWhy,
  lessonDecideParts,
  mergeNeedParts,
  mixedEvidenceDecideParts,
  needLineProblem,
  playbookRefreshQuestionParts,
  readabilityProblems,
  repeatedObjectionQuestionParts,
  ROUTINE_FORWARD_WHY,
  whyProblem,
} from "./need-parts.js";

/** A decide-list explanation with the fields a fixture does not set. */
const explanation = (over: Partial<DecisionExplanation>): DecisionExplanation => ({
  matched: [],
  winner: null,
  mark: "user",
  selfWidening: false,
  selfWideningFiles: [],
  unreadable: false,
  rule: "a `user` entry wins; self-widening is always the user's; no match is the user's",
  reason: "no decide-list entry's paths matched",
  ...over,
});

describe("the readability checker", () => {
  it("accepts a clean set of the three shown parts", () => {
    expect(
      readabilityProblems({
        need: "Approve web#74: Slack bot join endpoint",
        context: "What it changes: Slack bot join endpoint. Reviewer's verdict: approved.",
        why: "The decide list marks this the user's: Production infrastructure.",
      }),
    ).toEqual([]);
  });

  it("fails a need line over 120 characters", () => {
    expect(needLineProblem("x".repeat(121))).toMatch(/120/u);
  });

  it("fails a context over 80 words", () => {
    expect(contextProblem(Array.from({ length: 81 }, () => "word").join(" "))).toMatch(/80/u);
  });

  it("fails a why over two sentences", () => {
    expect(whyProblem("One thing. Two things. Three things.")).toMatch(/2/u);
  });

  it("fails on a thread id, a binding id, a backtick or forwarding glue", () => {
    expect(needLineProblem("Approve thr_abc123")).toMatch(/thread id/u);
    expect(needLineProblem("Approve bnd_abc123")).toMatch(/binding id/u);
    expect(needLineProblem("Approve the `join` endpoint")).toMatch(/backtick/u);
    expect(contextProblem("Meanwhile: the worker waits.")).toMatch(/Meanwhile/u);
    expect(contextProblem("A decision escalation from ENG-1.")).toMatch(/escalation from/u);
  });
});

describe("every plugin-composed item reads in three plain parts", () => {
  it("an approve-pr item names the title, verdict and deciding entry", () => {
    const parts = approvePrNeedParts({
      key: "acme/web#74",
      title: "Slack bot join endpoint",
      shortSha: "abc1234",
      verdict: "approved",
      foreign: false,
      product: false,
      why: decisionWhy(explanation({ winner: { text: "Production infrastructure", decide: "user", files: ["x"] } })),
      listing: "Decide list: 1 entry matched:\n- \"Production infrastructure\" [user] — x\nDeciding entry: \"Production infrastructure\" [user].\nRule: a `user` entry wins.",
    });
    expect(readabilityProblems({ need: parts.what, context: parts.how, why: parts.why })).toEqual([]);
    expect(parts.what).toContain("Slack bot join endpoint");
    expect(parts.how).toContain("Reviewer's verdict");
    expect(parts.why).toContain("Production infrastructure");
    expect(parts.details).toContain("Post the unsigned comment");
  });

  it("an approve-spec item states the gate rule", () => {
    const parts = approveSpecNeedParts({ what: "Approve ENG-12's spec", covered: ["asm_1 — the API is stable"] });
    expect(readabilityProblems({ need: parts.what, context: parts.how, why: parts.why })).toEqual([]);
    expect(parts.details).toContain("asm_1");
  });

  it("a merge item states the gate rule", () => {
    const parts = mergeNeedParts({ key: "acme/web#74", lane: "no-review" });
    expect(readabilityProblems({ need: parts.what, context: parts.how, why: parts.why })).toEqual([]);
  });

  it("a deps adoption decide item is short and readable", () => {
    const need = adoptionNeedLine("SC-111", "acme/sandbox", ["medium", "high"]);
    expect(readabilityProblems({ need, context: adoptionHow(true), why: ADOPTION_WHY })).toEqual([]);
  });

  it("the other plugin-composed decide items are readable", () => {
    const lesson = lessonDecideParts({ file: "AGENTS.md", lessonText: "Always run the tests.", boundary: true, retire: false, branch: "guidance-x", prUrl: "https://github.com/acme/web/pull/9" });
    expect(readabilityProblems({ need: lesson.what, context: lesson.how, why: lesson.why })).toEqual([]);
    const retired = lessonDecideParts({ file: "AGENTS.md", lessonText: "Always run the tests.", boundary: true, retire: true, branch: "guidance-x", prUrl: "https://github.com/acme/web/pull/9" });
    expect(retired.how).toMatch(/nightly pass retired/u);
    expect(readabilityProblems({ need: retired.what, context: retired.how, why: retired.why })).toEqual([]);
    const mixed = mixedEvidenceDecideParts({ file: "AGENTS.md", lessonText: "Always run the tests.", hits: 4, corrections: 1 });
    expect(readabilityProblems({ need: mixed.what, context: mixed.how, why: mixed.why })).toEqual([]);
    const refresh = playbookRefreshQuestionParts({ playbook: "linear-tickets", templateName: "linear-tickets", pr: "https://github.com/acme/web/pull/9", additive: false, removals: 2 });
    expect(readabilityProblems({ need: refresh.question, context: refresh.context, why: refresh.why })).toEqual([]);
    const objection = repeatedObjectionQuestionParts({ key: "ENG-12", objections: ["Add a rollback plan."], previous: ["Add a rollback plan."] });
    expect(readabilityProblems({ need: objection.question, context: objection.context, why: objection.why })).toEqual([]);
  });

  it("an approve-pr why reflects the gate, not just the decide list", () => {
    const winner = { text: "Identity and access", decide: "user" as const, files: ["x"] };
    const projectWinner = { text: "A store migration", decide: "project" as const, files: ["x"] };
    expect(approvePrWhy({ product: true, escalated: false, explanation: explanation({ winner }) })).toMatch(/substantial and references no ticket/u);
    // Escalated only overrides a project mark; a user winner still names the entry.
    expect(approvePrWhy({ product: false, escalated: true, explanation: explanation({ winner: projectWinner, mark: "project" }) })).toMatch(/reviewer escalated/u);
    expect(approvePrWhy({ product: false, escalated: true, explanation: explanation({ winner }) })).toMatch(/Identity and access/u);
    expect(approvePrWhy({ product: false, escalated: false, explanation: explanation({ winner }) })).toMatch(/Identity and access/u);
    expect(approvePrWhy({ product: false, escalated: false, explanation: explanation({ winner: null }) })).toMatch(/No decide-list entry/u);
    expect(approvePrWhy({ product: false, escalated: false, explanation: explanation({ winner: null, selfWidening: true }) })).toMatch(/touches the decide list/u);
    expect(approvePrWhy({ product: false, escalated: false, explanation: null })).toMatch(/No decide-list entry/u);
    for (const why of [
      approvePrWhy({ product: true, escalated: false, explanation: explanation({ winner }) }),
      approvePrWhy({ product: false, escalated: true, explanation: explanation({ winner: projectWinner, mark: "project" }) }),
      approvePrWhy({ product: false, escalated: true, explanation: explanation({ winner }) }),
      approvePrWhy({ product: false, escalated: false, explanation: explanation({ winner: null }) }),
    ]) {
      expect(whyProblem(why)).toBeNull();
    }
  });

  it("a forwarded question shows the steward's context as written, with no glue", () => {
    const context = "The billing API key is not in the repo, and the worker needs it to run the integration tests.";
    const parts = forwardedQuestionParts({
      question: "Provide the billing API key?",
      context,
      why: forwardWhy("Granting a new credential, token or cluster access, or widening what an existing one can reach"),
    });
    expect(parts.context).toBe(context);
    expect(parts.context).not.toContain("Meanwhile:");
    expect(parts.context).not.toContain("escalation from");
    expect(readabilityProblems({ need: parts.question, context: parts.context, why: parts.why })).toEqual([]);
    // A routine forward carries the routine why, never a reworded question.
    expect(forwardWhy(null)).toBe(ROUTINE_FORWARD_WHY);
  });
});
