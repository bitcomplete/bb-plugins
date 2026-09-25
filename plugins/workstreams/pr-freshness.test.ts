import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrFreshness } from "./pr-freshness.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness() {
  const callbacks = new Map<string, () => void>();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  const schedule = vi.fn();
  const subscribe = vi.fn((environmentId: string, changed: () => void) => {
    callbacks.set(environmentId, changed);
    const stop = vi.fn(() => callbacks.delete(environmentId));
    stops.set(environmentId, stop);
    return stop;
  });
  return { schedule, subscribe, callbacks, stops, freshness: createPrFreshness({ subscribe, schedule, settleMs: 15_000 }) };
}

describe("PR freshness", () => {
  it("refreshes an ordinary linked thread on idle and checks again after GitHub settles", () => {
    const { freshness, schedule } = harness();
    freshness.setLinks([{ threadId: "existing-thread", environmentId: null, urls: ["pr-a"] }]);
    freshness.threadIdle("unrelated-thread");
    expect(schedule).not.toHaveBeenCalled();
    freshness.threadIdle("existing-thread");
    expect(schedule.mock.calls).toEqual([[["pr-a"]]]);
    vi.advanceTimersByTime(15_000);
    expect(schedule.mock.calls).toEqual([[["pr-a"]], [["pr-a"]]]);
    freshness.dispose();
  });

  it("shares an environment subscription and bounds repeated git and idle events to two reads per URL", () => {
    const { freshness, schedule, subscribe, callbacks } = harness();
    freshness.setLinks([
      { threadId: "one", environmentId: "env", urls: ["pr-a"] },
      { threadId: "two", environmentId: "env", urls: ["pr-a", "pr-b"] },
      { threadId: "unlinked", environmentId: "unused-env", urls: [] },
    ]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    callbacks.get("env")!();
    for (let i = 0; i < 10; i++) {
      freshness.threadIdle("one");
      callbacks.get("env")!();
      vi.advanceTimersByTime(1_000);
    }
    expect(schedule.mock.calls).toEqual([[["pr-a", "pr-b"]]]);
    vi.advanceTimersByTime(5_000);
    expect(schedule.mock.calls).toEqual([[["pr-a", "pr-b"]], [["pr-a"]], [["pr-b"]]]);
    freshness.dispose();
  });

  it("uses new links without duplicating subscriptions and releases unused environments", () => {
    const { freshness, schedule, subscribe, callbacks, stops } = harness();
    freshness.setLinks([{ threadId: "one", environmentId: "env", urls: ["old-pr"] }]);
    freshness.setLinks([{ threadId: "one", environmentId: "env", urls: ["new-pr"] }]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    callbacks.get("env")!();
    expect(schedule).toHaveBeenCalledWith(["new-pr"]);
    freshness.setLinks([]);
    expect(stops.get("env")).toHaveBeenCalledOnce();
    freshness.dispose();
  });

  it("cancels timers and subscriptions on reload, including late callbacks", () => {
    const { freshness, schedule, subscribe, callbacks, stops } = harness();
    const link = { threadId: "one", environmentId: "env", urls: ["pr-a"] };
    freshness.setLinks([link]);
    const callback = callbacks.get("env")!;
    callback();
    freshness.dispose();
    callback();
    freshness.setLinks([link]);
    freshness.threadIdle("one");
    vi.advanceTimersByTime(30_000);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(stops.get("env")).toHaveBeenCalledOnce();
  });
});
