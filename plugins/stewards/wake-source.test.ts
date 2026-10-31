import { describe, expect, it } from "vitest";
import { NO_STALL, STALL_WAKE_THRESHOLD, advanceStall, hasLiveWakeSource, type WakeSourceInput } from "./wake-source.js";

const noSources: WakeSourceInput = {
  hold: null,
  holdBehind: [],
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
});
