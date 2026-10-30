import { describe, expect, it } from "vitest";
import { createUpdateStore, POLL_MS, RESTART_POLL_MS, RESTART_TIMEOUT_MS, UPDATE_PATH, type UpdateStoreDeps } from "./server-update.js";

// A router and a clock the test drives. Timers fire only when `advance` is
// called, so each step is explicit.
function harness(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ method: string }> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  let reloaded = 0;
  let visible = true;
  const deps: UpdateStoreDeps = {
    fetch: async (input, init) => {
      expect(input).toBe(UPDATE_PATH);
      calls.push({ method: init?.method ?? "GET" });
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
    visible: () => visible,
  };
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
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { deps, calls, timers, advance, flush, reloaded: () => reloaded, setVisible: (v: boolean) => (visible = v) };
}

describe("update store", () => {
  it("polls while subscribed and reports a pending update", async () => {
    const h = harness([
      { status: 200, body: { pending: false, ready: true } },
      { status: 200, body: { pending: true, ready: true } },
    ]);
    const store = createUpdateStore(h.deps);
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState().status));
    await h.flush();
    expect(store.getState()).toEqual({ status: "current" });
    await h.advance(POLL_MS);
    expect(store.getState()).toEqual({ status: "pending" });
    expect(seen).toEqual(["current", "pending"]);
    unsubscribe();
    expect(h.timers).toHaveLength(0);
  });

  it("hides itself for a server that is not behind bb-gate", async () => {
    const h = harness([{ status: 404 }]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    expect(store.getState()).toEqual({ status: "unavailable" });
    expect(h.timers).toHaveLength(0);
  });

  it("treats a non-JSON answer as not behind bb-gate", async () => {
    const h = harness([{ status: 200, body: "<html>" }]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    expect(store.getState()).toEqual({ status: "unavailable" });
  });

  it("skips a poll while the page is hidden", async () => {
    const h = harness([
      { status: 200, body: { pending: false, ready: true } },
      { status: 200, body: { pending: true, ready: true } },
    ]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    h.setVisible(false);
    await h.advance(POLL_MS);
    expect(h.calls).toHaveLength(1);
    h.setVisible(true);
    await h.advance(POLL_MS);
    expect(h.calls).toHaveLength(2);
    expect(store.getState()).toEqual({ status: "pending" });
  });

  it("applies, then reloads as soon as the server has gone down", async () => {
    const h = harness([
      { status: 200, body: { pending: true, ready: true } },
      { status: 200, body: { applied: true } },
      { status: 200, body: { pending: false, ready: true } }, // old pod still up
      { status: 503 }, // router briefly away
      { status: 200, body: { pending: false, ready: false } },
    ]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    expect(store.getState()).toEqual({ status: "pending" });
    const applied = store.apply();
    await h.flush();
    expect(store.getState()).toEqual({ status: "restarting" });
    expect(h.calls[1]).toEqual({ method: "POST" });
    for (let i = 0; i < 2; i++) await h.advance(RESTART_POLL_MS);
    expect(h.reloaded()).toBe(0);
    await h.advance(RESTART_POLL_MS);
    await applied;
    expect(h.reloaded()).toBe(1);
    expect(h.calls).toHaveLength(5);
  });

  it("reloads anyway when the server never reports going down", async () => {
    const answers: Array<{ status: number; body?: unknown }> = [
      { status: 200, body: { pending: true, ready: true } },
      { status: 200, body: { applied: true } },
    ];
    for (let i = 0; i < 100; i++) answers.push({ status: 200, body: { pending: false, ready: true } });
    const h = harness(answers);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    const applied = store.apply();
    await h.flush();
    for (let i = 0; i * RESTART_POLL_MS < RESTART_TIMEOUT_MS; i++) await h.advance(RESTART_POLL_MS);
    await applied;
    expect(h.reloaded()).toBe(1);
  });

  it("drops the banner without reloading when there was nothing to apply", async () => {
    const h = harness([
      { status: 200, body: { pending: true, ready: true } },
      { status: 200, body: { applied: false } },
    ]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    await store.apply();
    expect(store.getState()).toEqual({ status: "current" });
    expect(h.reloaded()).toBe(0);
    expect(h.timers).toHaveLength(1); // only the regular poll
  });

  it("reports a refused apply instead of waiting forever", async () => {
    const h = harness([{ status: 200, body: { pending: true, ready: true } }, { status: 403 }]);
    const store = createUpdateStore(h.deps);
    store.subscribe(() => {});
    await h.flush();
    await store.apply();
    expect(store.getState()).toEqual({ status: "error", message: "bb-gate answered 403" });
    expect(h.reloaded()).toBe(0);
  });
});
