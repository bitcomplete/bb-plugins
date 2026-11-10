import { describe, expect, it } from "vitest";
import { NO_STALL, STALL_WAKE_THRESHOLD, advanceStall, hasLiveWakeSource, parseUntil, pullWatchCounts, type WakeSourceInput } from "./wake-source.js";

const noSources: WakeSourceInput = {
  hold: null,
  holdBehind: [],
  mergeBehind: [],
  holdStack: [],
  deployments: {},
  runningWorkers: 0,
  openEscalations: 0,
  openNeeds: 0,
  pullRequestWatch: false,
};

const watch = (over: Partial<WakeSourceInput> = {}): WakeSourceInput => ({ ...noSources, ...over });

describe("a binding's live wake sources (BB-154)", () => {
  it("is false with only a free-text wait", () => {
    expect(hasLiveWakeSource(noSources)).toBe(false);
  });

  it("is true for an open holdBehind", () => {
    expect(hasLiveWakeSource(watch({ hold: "behind ENG-9", holdBehind: ["ENG-9"] }))).toBe(true);
  });

  it("is true for a merge hold (BB-256), with or without a start hold", () => {
    expect(hasLiveWakeSource(watch({ mergeBehind: ["ENG-9"] }))).toBe(true);
    expect(hasLiveWakeSource(watch({ hold: "Later", mergeBehind: ["ENG-9"] }))).toBe(true);
  });

  it("is true for an open stack-wait (BB-215)", () => {
    expect(hasLiveWakeSource(watch({ hold: "stacked on ENG-9", holdStack: ["ENG-9"] }))).toBe(true);
  });

  it("does not count a manual hold with no holdBehind", () => {
    expect(hasLiveWakeSource(watch({ hold: "waiting for the vendor" }))).toBe(false);
  });

  it("is true for a deployment watch merged or deploying, false once deployed", () => {
    const merged = watch({ deployments: { "acme/web#7": { state: "merged" } as never } });
    const deploying = watch({ deployments: { "acme/web#7": { state: "deploying" } as never } });
    const deployed = watch({ deployments: { "acme/web#7": { state: "deployed" } as never } });
    expect(hasLiveWakeSource(merged)).toBe(true);
    expect(hasLiveWakeSource(deploying)).toBe(true);
    expect(hasLiveWakeSource(deployed)).toBe(false);
  });

  it("is true for a running worker, an open escalation or need, or a pull-request watch", () => {
    expect(hasLiveWakeSource(watch({ runningWorkers: 1 }))).toBe(true);
    expect(hasLiveWakeSource(watch({ openEscalations: 1 }))).toBe(true);
    expect(hasLiveWakeSource(watch({ openNeeds: 1 }))).toBe(true);
    expect(hasLiveWakeSource(watch({ pullRequestWatch: true }))).toBe(true);
  });

  // BB-285: an open pull request is not a wake source for a `pr`/`review`
  // binding, and a ticket's open own pull request counts only while its gate
  // is not met.
  it("does not count a pr or review binding's own open pull request", () => {
    expect(pullWatchCounts("pr", 1, false)).toBe(false);
    expect(pullWatchCounts("review", 1, false)).toBe(false);
  });

  it("counts a ticket's open own pull request only while its gate is not met", () => {
    expect(pullWatchCounts("ticket", 1, false)).toBe(true);
    expect(pullWatchCounts("ticket", 1, true)).toBe(false);
    expect(pullWatchCounts("ticket", 0, false)).toBe(false);
  });
});

describe("the requeue-only stall counter (BB-154)", () => {
  const at = (over: Partial<Parameters<typeof advanceStall>[1]> = {}) => advanceStall(NO_STALL, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 1_000, ...over });

  it("starts a run at the first requeue-only report and escalates at the threshold", () => {
    const first = at();
    expect(first.state).toEqual({ count: 1, waitText: "the vendor", firstAt: 1_000 });
    expect(first.escalate).toBe(false);
    expect(STALL_WAKE_THRESHOLD).toBe(2);

    const second = advanceStall(first.state, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 2_000 });
    expect(second.state).toEqual({ count: 2, waitText: "the vendor", firstAt: 1_000 });
    expect(second.escalate).toBe(true);
  });

  it("compares the wait trimmed", () => {
    const first = at({ waitingOn: "  the vendor  " });
    expect(first.state.waitText).toBe("the vendor");
    const second = advanceStall(first.state, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 2_000 });
    expect(second.state.count).toBe(2);
    expect(second.escalate).toBe(true);
  });

  it("resets on a wake for another reason", () => {
    const first = at();
    const changed = advanceStall(first.state, { reason: "changed", waitingOn: "the vendor", liveSource: false, now: 2_000 });
    expect(changed.state).toEqual(NO_STALL);
    expect(changed.escalate).toBe(false);
  });

  it("resets when the wait changes", () => {
    const first = at();
    const other = advanceStall(first.state, { reason: "requeue", waitingOn: "the reviewer", liveSource: false, now: 2_000 });
    expect(other.state).toEqual({ count: 1, waitText: "the reviewer", firstAt: 2_000 });
  });

  it("resets when a structured source appears", () => {
    const first = at();
    const sourced = advanceStall(first.state, { reason: "requeue", waitingOn: "the vendor", liveSource: true, now: 2_000 });
    expect(sourced.state).toEqual(NO_STALL);
  });

  it("resets when the wait is cleared", () => {
    const first = at();
    expect(advanceStall(first.state, { reason: "requeue", waitingOn: null, liveSource: false, now: 2_000 }).state).toEqual(NO_STALL);
    expect(advanceStall(first.state, { reason: "requeue", waitingOn: "", liveSource: false, now: 2_000 }).state).toEqual(NO_STALL);
  });

  it("keeps the first-reported time across a run", () => {
    const first = at({ now: 1_000 });
    const second = advanceStall(first.state, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 9_000 });
    expect(second.state.firstAt).toBe(1_000);
  });

  it("skips and resets while a dated wait is ahead, and counts once it has passed (BB-247)", () => {
    const first = at();
    const future = advanceStall(first.state, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 2_000, until: 5_000 });
    expect(future.state).toEqual(NO_STALL);
    expect(future.escalate).toBe(false);
    // Past the date, the same wait starts a fresh run from zero.
    const after = advanceStall(future.state, { reason: "requeue", waitingOn: "the vendor", liveSource: false, now: 6_000, until: 5_000 });
    expect(after.state).toEqual({ count: 1, waitText: "the vendor", firstAt: 6_000 });
    expect(after.escalate).toBe(false);
  });
});

describe("a report's `until` date (BB-247)", () => {
  it("reads a date as 00:00 UTC and an ISO datetime as itself", () => {
    expect(parseUntil("2026-12-01")).toBe(Date.parse("2026-12-01T00:00:00Z"));
    expect(parseUntil("2026-12-01T15:30:00Z")).toBe(Date.parse("2026-12-01T15:30:00Z"));
  });

  it("refuses a non-date and a date that does not exist", () => {
    expect(parseUntil("next Tuesday")).toBeNull();
    expect(parseUntil("2026-02-30")).toBeNull();
    expect(parseUntil("2026-13-01")).toBeNull();
    expect(parseUntil("")).toBeNull();
  });
});
