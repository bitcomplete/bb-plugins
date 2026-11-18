import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller, RateLimitError, type PollResult } from "./poller.js";

/** A clock a test advances beside the fake timers, as the server tests do. */
function world() {
  let now = 1_000_000_000_000;
  const logs: { level: "info" | "warn"; message: string }[] = [];
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
    logs,
    log: {
      info: (message: string) => void logs.push({ level: "info", message }),
      warn: (message: string) => void logs.push({ level: "warn", message }),
    },
  };
}

describe("createPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("polls once at start, then every interval, and reports its status", async () => {
    const w = world();
    const polls: string[] = [];
    const poller = createPoller({ now: w.now, log: w.log, poll: async (reason) => void polls.push(reason), timing: { intervalMs: 60_000, backoffMinMs: 10_000, backoffMaxMs: 120_000 } });
    expect(poller.intervalMs).toBe(60_000);
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(polls).toEqual(["poll"]);
    expect(poller.status()).toMatchObject({ state: "idle", polls: 1, starved: false, intervalMs: 60_000 });

    // Nothing until the interval passes.
    w.advance(59_999);
    await tick(59_999);
    expect(polls).toEqual(["poll"]);
    w.advance(1);
    await tick(1);
    expect(polls).toEqual(["poll", "poll"]);

    controller.abort();
    await done;
    expect(poller.status().state).toBe("stopped");
  });

  it("backs off on a rate limit instead of polling again at the interval, then recovers", async () => {
    const w = world();
    const polls: string[] = [];
    let limited = true;
    const poller = createPoller({
      now: w.now,
      log: w.log,
      poll: async (reason): Promise<PollResult | void> => {
        polls.push(reason);
        if (limited) {
          limited = false;
          throw new RateLimitError("Linear answered HTTP 403", 30_000);
        }
      },
      timing: { intervalMs: 60_000, backoffMinMs: 10_000, backoffMaxMs: 120_000 },
    });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(polls).toEqual(["poll"]);
    expect(poller.status()).toMatchObject({ state: "backoff", starved: true, lastError: "Linear answered HTTP 403", backoffUntil: w.now() + 30_000 });
    expect(w.logs.some((l) => l.level === "warn" && l.message.includes("rate-limited"))).toBe(true);

    // The normal interval has not passed, and no second poll has happened.
    w.advance(29_999);
    await tick(29_999);
    expect(polls).toEqual(["poll"]);
    // The server's hint was 30 s: poll again then, and recover.
    w.advance(1);
    await tick(1);
    expect(polls).toEqual(["poll", "poll (backoff)"]);
    expect(poller.status()).toMatchObject({ state: "idle", starved: false, lastError: null });

    controller.abort();
    await done;
  });

  it("doubles its own backoff when the server gave no hint, up to the cap", async () => {
    const w = world();
    let fails = 3;
    const poller = createPoller({
      now: w.now,
      log: w.log,
      poll: async () => {
        if (fails-- > 0) throw new RateLimitError("too many requests");
      },
      timing: { intervalMs: 60_000, backoffMinMs: 10_000, backoffMaxMs: 25_000 },
    });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(poller.status().backoffUntil - w.now()).toBe(10_000);
    w.advance(10_000);
    await tick(10_000);
    expect(poller.status().backoffUntil - w.now()).toBe(20_000);
    w.advance(20_000);
    await tick(20_000);
    // 40 s would be next, but the cap is 25 s.
    expect(poller.status().backoffUntil - w.now()).toBe(25_000);
    w.advance(25_000);
    await tick(25_000);
    expect(poller.status()).toMatchObject({ starved: false, state: "idle" });
    controller.abort();
    await done;
  });

  it("takes a rate-limited result without throwing, and a transient failure keeps the normal cadence", async () => {
    const w = world();
    let first = true;
    const poller = createPoller({
      now: w.now,
      log: w.log,
      poll: async (): Promise<PollResult | void> => {
        if (first) {
          first = false;
          return { rateLimited: true, retryAfterMs: 5_000 };
        }
        throw new Error("network down");
      },
      timing: { intervalMs: 60_000, backoffMinMs: 10_000 },
    });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(poller.status()).toMatchObject({ starved: true, lastError: "Linear is rate-limiting this server" });
    w.advance(5_000);
    await tick(5_000);
    await tick(0);
    expect(poller.status()).toMatchObject({ starved: false, lastError: "network down" });
    // A non-rate-limit failure does not back off: the next poll is the interval away.
    expect(poller.status().nextPollAt - w.now()).toBe(60_000);
    controller.abort();
    await done;
  });

  it("pokes a waiting poller to poll at once", async () => {
    const w = world();
    const polls: string[] = [];
    const poller = createPoller({ now: w.now, log: w.log, poll: async (reason) => void polls.push(reason), timing: { intervalMs: 60_000 } });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(polls).toEqual(["poll"]);
    poller.poke();
    await tick(0);
    expect(polls).toEqual(["poll", "poll"]);
    controller.abort();
    await done;
  });

  it("clamps a server retry hint to the backoff cap, so a bad header cannot overflow the timer", async () => {
    const w = world();
    let first = true;
    const poller = createPoller({
      now: w.now,
      log: w.log,
      poll: async (): Promise<PollResult | void> => {
        if (first) {
          first = false;
          throw new RateLimitError("Linear rate-limited the poll", Number.MAX_SAFE_INTEGER);
        }
      },
      timing: { intervalMs: 60_000, backoffMinMs: 10_000, backoffMaxMs: 25_000 },
    });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(poller.status().backoffUntil - w.now()).toBe(25_000);
    controller.abort();
    await done;
  });

  it("does not let a poke cut a backoff short", async () => {
    const w = world();
    const polls: string[] = [];
    let limited = true;
    const poller = createPoller({
      now: w.now,
      log: w.log,
      poll: async (reason): Promise<PollResult | void> => {
        polls.push(reason);
        if (limited) throw new RateLimitError("Linear answered HTTP 429");
      },
      timing: { intervalMs: 60_000, backoffMinMs: 30_000, backoffMaxMs: 120_000 },
    });
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    expect(polls).toEqual(["poll"]);
    expect(poller.status().starved).toBe(true);
    // A poke during the backoff does not run a round.
    poller.poke();
    await tick(0);
    expect(polls).toEqual(["poll"]);
    // The backoff still ends on its own schedule.
    limited = false;
    w.advance(30_000);
    await tick(30_000);
    expect(polls).toEqual(["poll", "poll (backoff)"]);
    expect(poller.status().starved).toBe(false);
    controller.abort();
    await done;
  });

  it("notifies state listeners and clears the next poll on stop", async () => {
    const w = world();
    const states: string[] = [];
    const poller = createPoller({ now: w.now, log: w.log, poll: async () => undefined, timing: { intervalMs: 60_000 } });
    poller.onStateChange(() => states.push(poller.status().state));
    const controller = new AbortController();
    const done = poller.run(controller.signal);
    await tick(0);
    controller.abort();
    await done;
    expect(states).toContain("idle");
    expect(states.at(-1)).toBe("stopped");
    expect(poller.status().nextPollAt).toBe(0);
  });
});
