import { describe, expect, it } from "vitest";
import { AFTER_THE_FACT_RATIONALE_WHY, REPEAT_RATIONALE_WHY, ROUTINE_RATIONALE_WHY, clusterKey, routineRationaleWanted } from "./rationale.js";

describe("the rationale rules (BB-35 step 4)", () => {
  it("asks on a routine decision the guidance did not settle", () => {
    expect(routineRationaleWanted({ kind: "decision", resolutionKind: "text", entry: null })).toBe(true);
    expect(routineRationaleWanted({ kind: "decision", resolutionKind: "choice" })).toBe(true);
    // A named decide-list entry means the project steward forwarded a big
    // decision: the project could never decide it, so it never asks.
    expect(routineRationaleWanted({ kind: "decision", resolutionKind: "text", entry: "New vendors, services or spending" })).toBe(false);
    // The gate items, a credential and a plain step never ask.
    expect(routineRationaleWanted({ kind: "approval", resolutionKind: "text" })).toBe(false);
    expect(routineRationaleWanted({ kind: "approval", resolutionKind: "approve-decline" })).toBe(false);
    expect(routineRationaleWanted({ kind: "decision", resolutionKind: "secret" })).toBe(false);
    expect(routineRationaleWanted({ kind: "decision", resolutionKind: "done" })).toBe(false);
  });

  it("keeps the three one-line whys distinct", () => {
    expect(new Set([ROUTINE_RATIONALE_WHY, REPEAT_RATIONALE_WHY, AFTER_THE_FACT_RATIONALE_WHY]).size).toBe(3);
    for (const why of [ROUTINE_RATIONALE_WHY, REPEAT_RATIONALE_WHY, AFTER_THE_FACT_RATIONALE_WHY]) expect(why.length).toBeGreaterThan(0);
  });
});

describe("the escalation cluster key", () => {
  it("drops case, punctuation and spacing, and keeps the playbook apart", () => {
    expect(clusterKey("linear-tickets", "Include SSO?")).toBe(clusterKey("linear-tickets", "include   sso"));
    expect(clusterKey("linear-tickets", "Include SSO?")).not.toBe(clusterKey("github-prs", "Include SSO?"));
    // No playbook is its own bucket, so two unbound questions still cluster.
    expect(clusterKey(null, "Include SSO?")).toBe(clusterKey(null, "include sso"));
  });
});
