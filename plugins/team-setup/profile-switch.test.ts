import { describe, expect, it } from "vitest";
import { switchProfile } from "./profile-switch.js";
import { RESTART_PATH, RESTART_POLL_MS, UPDATE_PATH, type UpdateStoreDeps } from "./server-update.js";

// A router and a clock the test drives. Timers fire only when `advance` is
// called, so each step is explicit.
function harness(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ method: string; url: string }> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  let reloaded = 0;
  const deps: UpdateStoreDeps = {
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: input });
      const a = answers.shift() ?? { status: 500 };
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
        status: a.status,
        headers: { "Content-Type": "application/json" },
      });
    },
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => now,
    reload: () => reloaded++,
    visible: () => true,
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
  };
  return { deps, calls, advance, flush, reloaded: () => reloaded };
}

describe("profile switch", () => {
  it("activates, restarts with first_visit for a never-started profile, and follows", async () => {
    const h = harness([
      { status: 200, body: { restarted: true } },
      { status: 200, body: { pending: false, ready: true } },
      { status: 200, body: { pending: false, ready: false } },
    ]);
    const activated: string[] = [];
    const running = switchProfile(
      {
        ...h.deps,
        activate: async (name) => {
          activated.push(name);
          return { booted: false };
        },
      },
      "demo",
      "default",
    );
    await h.flush();
    expect(activated).toEqual(["demo"]);
    expect(h.calls[0]).toEqual({ method: "POST", url: `${RESTART_PATH}?first_visit=1` });
    await h.advance(RESTART_POLL_MS);
    await h.advance(RESTART_POLL_MS);
    await running;
    expect(h.calls[1]).toEqual({ method: "GET", url: UPDATE_PATH });
    expect(h.reloaded()).toBe(1);
  });

  it("does not set first_visit for a profile that has booted", async () => {
    const h = harness([
      { status: 200, body: { restarted: true } },
      { status: 200, body: { pending: false, ready: false } },
    ]);
    const running = switchProfile({ ...h.deps, activate: async () => ({ booted: true }) }, "default", "demo");
    await h.flush();
    expect(h.calls[0]).toEqual({ method: "POST", url: RESTART_PATH });
    await h.advance(RESTART_POLL_MS);
    await running;
    expect(h.reloaded()).toBe(1);
  });

  it("puts the previous profile back when the restart is refused", async () => {
    const h = harness([{ status: 403 }]);
    const activated: string[] = [];
    await expect(
      switchProfile(
        {
          ...h.deps,
          activate: async (name) => {
            activated.push(name);
            return { booted: false };
          },
        },
        "demo",
        "default",
      ),
    ).rejects.toThrow(/403/u);
    // The target, then the previous profile restored before the throw.
    expect(activated).toEqual(["demo", "default"]);
    expect(h.calls).toHaveLength(1);
    expect(h.reloaded()).toBe(0);
  });

  it("puts the previous profile back when the restart is unreachable", async () => {
    const h = harness([]);
    h.deps.fetch = async () => {
      throw new Error("network down");
    };
    const activated: string[] = [];
    await expect(
      switchProfile(
        {
          ...h.deps,
          activate: async (name) => {
            activated.push(name);
            return { booted: true };
          },
        },
        "demo",
        "default",
      ),
    ).rejects.toThrow(/network down/u);
    expect(activated).toEqual(["demo", "default"]);
    expect(h.reloaded()).toBe(0);
  });
});
