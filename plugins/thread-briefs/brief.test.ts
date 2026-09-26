import { describe, expect, it } from "vitest";
import {
  awaitingUser,
  deriveStatus,
  effectiveStage,
  isStageOverrideStale,
  resolveBrief,
  rowDecoration,
  rowSignalFor,
} from "./brief.js";
import type { StoredBrief } from "./contract.js";

const stored = (overrides: Partial<StoredBrief> = {}): StoredBrief => ({
  version: 1,
  threadId: "thr_1",
  fields: {
    goal: "Ship the briefs plugin",
    currentState: "Server and app entries written",
    nextStep: "Run the vitest suite",
    blockedOn: "",
    constraints: "",
  },
  modelStage: "implementation",
  stageOverride: null,
  stageOverrideSeq: null,
  endedWithQuestion: false,
  lastSummarizedAt: 1_000,
  lastActivitySeen: 50,
  ...overrides,
});

describe("deriveStatus", () => {
  it("reports done when there is no next step", () => {
    expect(
      deriveStatus({ nextStep: "   ", blockedOn: "", awaitingUser: false }),
    ).toBe("done");
  });

  it("prefers done over a question, so a finished thread is not a prompt", () => {
    expect(
      deriveStatus({ nextStep: "", blockedOn: "", awaitingUser: true }),
    ).toBe("done");
  });

  it("reports waiting-on-other when something is blocking", () => {
    expect(
      deriveStatus({
        nextStep: "Merge it",
        blockedOn: "Review from Dylan",
        awaitingUser: true,
      }),
    ).toBe("waiting-on-other");
  });

  it("reports waiting-on-me when the agent asked something", () => {
    expect(
      deriveStatus({ nextStep: "Pick an approach", blockedOn: "", awaitingUser: true }),
    ).toBe("waiting-on-me");
  });

  it("reports working otherwise", () => {
    expect(
      deriveStatus({ nextStep: "Keep going", blockedOn: "", awaitingUser: false }),
    ).toBe("working");
  });
});

describe("awaitingUser", () => {
  it("is true for a live pending interaction even without a question", () => {
    expect(
      awaitingUser({ endedWithQuestion: false, hasPendingInteraction: true }),
    ).toBe(true);
  });

  it("is true for a question with no pending interaction", () => {
    expect(
      awaitingUser({ endedWithQuestion: true, hasPendingInteraction: false }),
    ).toBe(true);
  });

  it("is false when neither holds", () => {
    expect(
      awaitingUser({ endedWithQuestion: false, hasPendingInteraction: false }),
    ).toBe(false);
  });
});

describe("stage overrides", () => {
  it("uses the model's stage when nothing is overridden", () => {
    expect(effectiveStage(stored())).toBe("implementation");
  });

  it("honours an override set at the current activity cursor", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(effectiveStage(brief)).toBe("review");
    expect(isStageOverrideStale(brief)).toBe(false);
  });

  it("retires an override once the thread has real new activity", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 51,
    });
    expect(isStageOverrideStale(brief)).toBe(true);
    expect(effectiveStage(brief)).toBe("implementation");
  });

  it("hides a retired override from the stage control", () => {
    const resolved = resolveBrief(
      stored({
        stageOverride: "review",
        stageOverrideSeq: 50,
        lastActivitySeen: 51,
      }),
      { hasPendingInteraction: false },
    );
    expect(resolved.stageOverride).toBeNull();
    expect(resolved.stage).toBe("implementation");
  });
});

describe("rowDecoration", () => {
  const signalFor = (brief: StoredBrief) =>
    rowSignalFor(resolveBrief(brief, { hasPendingInteraction: false }));

  it("draws nothing for a thread that is simply being worked on", () => {
    expect(rowDecoration(signalFor(stored()), false)).toBeNull();
  });

  it("upgrades a working thread to waiting-on-me on a pending interaction", () => {
    const decoration = rowDecoration(signalFor(stored()), true);
    expect(decoration?.icon).toBe("MessageQuestion");
    expect(decoration?.label).toBe("Waiting on you — Implementation");
  });

  it("does not let a pending interaction override a stored done", () => {
    const done = stored({
      fields: { ...stored().fields, nextStep: "" },
    });
    const decoration = rowDecoration(signalFor(done), true);
    expect(decoration?.icon).toBe("CircleCheck");
    expect(decoration?.tone).toBe("success");
  });

  it("draws the blocked glyph for a thread waiting on someone else", () => {
    const blocked = stored({
      fields: { ...stored().fields, blockedOn: "Waiting on CI" },
    });
    expect(rowDecoration(signalFor(blocked), false)?.icon).toBe("Pause");
  });
});
