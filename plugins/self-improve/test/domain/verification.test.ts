import { describe, expect, it } from "vitest";
import { observationWindow, verifyWindows, DEFAULT_VERIFICATION_POLICY } from "../../src/domain/verification.js";
import { DAY, NOW, vote } from "./fixtures.js";
const before = (sessions: number, votes: number) => ({ startMs: NOW - 7 * DAY, endMs: NOW, sessions, votes });
const after = (sessions: number, votes: number) => ({ startMs: NOW, endMs: NOW + 7 * DAY, sessions, votes });
describe("evidence-aware normalized verdicts", () => {
  it("requires denominator and mature windows rather than reporting zero as solved", () => {
    expect(verifyWindows(before(0, 0), after(100, 0)).verdict).toBe("PENDING");
    expect(verifyWindows(before(100, 20), { ...after(100, 0), endMs: NOW + DAY }).verdict).toBe("PENDING");
    expect(verifyWindows(before(100, 0), after(100, 0)).verdict).toBe("PENDING");
  });
  it("normalizes by sessions and distinguishes large shifts from sampling noise", () => {
    expect(verifyWindows(before(10_000, 1_000), after(20_000, 2_000)).verdict).toBe("NO EFFECT");
    expect(verifyWindows(before(10_000, 1_000), after(10_000, 100)).verdict).toBe("REDUCED");
    expect(verifyWindows(before(10_000, 100), after(10_000, 1_000)).verdict).toBe("WORSE");
    expect(verifyWindows(before(30, 3), after(30, 2)).verdict).toBe("PENDING");
  });
  it("zero post votes needs adequate upper-bound evidence and reports confounders", () => {
    const result = verifyWindows(before(10_000, 1_000), after(10_000, 0), DEFAULT_VERIFICATION_POLICY, ["provider changed"]);
    expect(result.verdict).toBe("SOLVED");
    expect(result.confounders).toEqual(["provider changed"]);
    expect(result.reasons.join(" ")).toMatch(/association/i);
  });
  it("refuses overlapping windows, negative observations and invalid thresholds", () => {
    expect(() => verifyWindows(before(100, 1), { ...after(100, 1), startMs: NOW - 1 })).toThrow(/overlap/i);
    expect(() => verifyWindows(before(100, -1), after(100, 1))).toThrow();
    expect(() => verifyWindows(before(100, 1), after(100, 1), { ...DEFAULT_VERIFICATION_POLICY, materialChange: 2 })).toThrow();
  });
  it("measures only predicted symptoms in eligible observed sessions with exclusive end bounds", () => {
    const sessions = [{ sessionId: "session-a", atMs: NOW, originPluginId: null }, { sessionId: "own", atMs: NOW, originPluginId: "self-improve" }];
    const window = observationWindow(NOW, NOW + DAY, sessions, [vote(), vote({ id: "unpredicted", symptomId: "another" }), vote({ id: "next-window", occurredAtMs: NOW + DAY, evidence: { kind: "thread", threadId: "thread-a", sessionId: "session-a", turnIndex: 1, eventId: "next-event" } })], ["p-a"], ["symptom-p-a"]);
    expect(window).toMatchObject({ sessions: 1, votes: 1 });
  });
});
