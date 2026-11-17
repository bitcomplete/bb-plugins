import { describe, expect, it } from "vitest";
import type { DecisionExplanation } from "./decisions.js";
import { adoptionHow } from "./deps.js";
import {
  ADOPTION_WHY,
  adoptionNeedLine,
  approvePrNeedParts,
  approveSpecNeedParts,
  contextProblem,
  decisionWhy,
  forwardedQuestionParts,
  forwardWhy,
  mergeNeedParts,
  needLineProblem,
  readabilityProblems,
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
        need: "Approve bb-gate#74: Slack bot join endpoint",
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
      key: "bitcomplete/bb-gate#74",
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
    const parts = mergeNeedParts({ key: "bitcomplete/bb-gate#74", lane: "no-review" });
    expect(readabilityProblems({ need: parts.what, context: parts.how, why: parts.why })).toEqual([]);
  });

  it("a deps adoption decide item is short and readable", () => {
    const need = adoptionNeedLine("SC-111", "bitcomplete/santaclaw", ["medium", "high"]);
    expect(readabilityProblems({ need, context: adoptionHow(true), why: ADOPTION_WHY })).toEqual([]);
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
