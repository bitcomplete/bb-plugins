import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHooksLoop, HooksRequestError, readSse, SseParser, StreamIdleError, subscribe, type Lease, type Rejection } from "./hooks-client.js";

const BASE = "http://hooks.test:8081";
const MINUTE = 60_000;

// A bb-gate-hooks whose stream and subscribe endpoint a test drives.
function fakeHooks() {
  const encoder = new TextEncoder();
  type Stream = { send(text: string): void; end(): void; closed: boolean };
  const streams: Stream[] = [];
  const subscribes: Array<{ connection: string; source: string; token: string; watches: Array<{ kind: string; id: string }> }> = [];
  const state = {
    eventsStatus: 200,
    silent: false,
    answer: (body: (typeof subscribes)[number]): Response => Response.json({ leases: body.watches.map((w) => ({ ...w, unit: "acme/widgets", expiresAt: "2026-10-10T18:00:00Z" })), rejected: [] }),
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u === `${BASE}/v1/events`) {
      if (state.eventsStatus !== 200) return new Response("", { status: state.eventsStatus });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const entry: Stream = {
        closed: false,
        send: (text) => controller.enqueue(encoder.encode(text)),
        end: () => {
          entry.closed = true;
          controller.close();
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => {
          entry.closed = true;
        },
      });
      // The service guarantees a keepalive every 20 s; so does the fake, unless a test mutes it.
      const keepalive = setInterval(() => {
        if (!entry.closed && !state.silent) entry.send(": keepalive\n\n");
      }, 20_000);
      init?.signal?.addEventListener("abort", () => {
        entry.closed = true;
        clearInterval(keepalive);
      });
      streams.push(entry);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (u === `${BASE}/v1/subscribe`) {
      const body = JSON.parse(String(init?.body)) as (typeof subscribes)[number];
      subscribes.push(body);
      return state.answer(body);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const hello = (connection: string, leaseSeconds = 3600) => `event: hello\ndata: ${JSON.stringify({ connection, leaseSeconds })}\n\n`;
  const doorbell = (id: string, over: Record<string, unknown> = {}) =>
    `id: 1\nevent: doorbell\ndata: ${JSON.stringify({ source: "github", kind: "issue", id, unit: "acme/widgets", action: "update", at: "2026-10-10T17:02:11Z", ...over })}\n\n`;
  return { fetchImpl, streams, subscribes, state, hello, doorbell, last: () => streams.at(-1)! };
}

describe("SSE parsing", () => {
  it("handles chunks split anywhere, CRLF, comments, several data lines, ids and the default event", () => {
    const parser = new SseParser();
    const text = ": keepalive\r\nevent: hello\r\ndata: {\"a\":1}\r\n\r\nid: 42\nevent: doorbell\ndata: one\ndata:two\n\ndata: bare\n\n";
    const events = [];
    for (const ch of text) events.push(...parser.push(ch));
    expect(events).toEqual([
      { event: "hello", data: '{"a":1}', id: null },
      { event: "doorbell", data: "one\ntwo", id: "42" },
      { event: "message", data: "bare", id: "42" },
    ]);
    expect(parser.push(": only a comment\n\n")).toEqual([]);
  });

  it("reads a stream until it ends, and stops when aborted", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("event: a\ndata: 1\n\nevent: b\n"));
        c.enqueue(encoder.encode("data: 2\n\n"));
        c.close();
      },
    });
    const seen = [];
    for await (const e of readSse(body, new AbortController().signal)) seen.push(e.event);
    expect(seen).toEqual(["a", "b"]);

    const controller = new AbortController();
    let cancelled = false;
    const open = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
    const reading = (async () => {
      const got = [];
      for await (const e of readSse(open, controller.signal)) got.push(e);
      return got;
    })();
    controller.abort();
    expect(await reading).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it("gives up on a stream that sends nothing for the idle time", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const silent = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
      const reading = (async () => {
        for await (const _ of readSse(silent, new AbortController().signal, 5000)) void _;
      })();
      const settled = reading.then(() => "ended", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await settled).toBeInstanceOf(StreamIdleError);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscribe", () => {
  it("posts the connection, source, token and watches of either kind, in batches of 100, and merges the answers", async () => {
    const hooks = fakeHooks();
    const ids: Lease[] = [{ kind: "repo", id: "acme/widgets" }, ...Array.from({ length: 149 }, (_, i) => ({ kind: "issue" as const, id: `i-${i + 1}` }))];
    hooks.state.answer = (body) => Response.json({ leases: body.watches.slice(1), rejected: [{ ...body.watches[0], reason: "forbidden" }] });
    const result = await subscribe(hooks.fetchImpl, BASE, "c_1", "tok-1", ids, new AbortController().signal);
    expect(hooks.subscribes).toHaveLength(2);
    expect(hooks.subscribes[0]).toMatchObject({ connection: "c_1", source: "github", token: "tok-1" });
    expect(hooks.subscribes[0]!.watches).toHaveLength(100);
    expect(hooks.subscribes[0]!.watches.slice(0, 2)).toEqual([{ kind: "repo", id: "acme/widgets" }, { kind: "issue", id: "i-1" }]);
    expect(hooks.subscribes[1]!.watches).toHaveLength(50);
    expect(result.leases).toHaveLength(148);
    expect(result.rejected.map((r) => r.id)).toEqual(["acme/widgets", "i-100"]);
  });

  it("throws with the status and body when the connection is unknown, without the token in the message", async () => {
    const hooks = fakeHooks();
    hooks.state.answer = () => Response.json({ error: "unknown-connection" }, { status: 404 });
    const error = await subscribe(hooks.fetchImpl, BASE, "c_gone", "tok-secret", [{ kind: "issue", id: "i" }], new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HooksRequestError);
    expect((error as HooksRequestError).status).toBe(404);
    expect((error as HooksRequestError).unknownConnection).toBe(true);
    expect((error as Error).message + (error as HooksRequestError).body).not.toContain("tok-secret");
    expect(new HooksRequestError("x", 404, "not found").unknownConnection).toBe(false);
    expect(new HooksRequestError("x", 200, JSON.stringify({ error: "unknown-connection" })).unknownConnection).toBe(false);
  });
});

describe("the loop", () => {
  let now = 1_000_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    now = 1_000_000_000_000;
  });
  afterEach(() => vi.useRealTimers());
  const tick = async (ms = 0) => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  function start(hooks: ReturnType<typeof fakeHooks>, over: { watchIds?: () => Lease[]; token?: () => Promise<string>; idleMs?: number } = {}) {
    const logs: string[] = [];
    const sweeps: string[] = [];
    const doorbells: string[] = [];
    const doorbellKinds: string[] = [];
    const units: Array<string | null> = [];
    const rejected: Rejection[][] = [];
    let token = "tok-1";
    let refreshes = 0;
    const loop = createHooksLoop({
      fetch: hooks.fetchImpl,
      baseUrl: BASE,
      now: () => now,
      log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
      token: over.token ?? (async () => token),
      refreshToken: async () => {
        refreshes++;
        token = `tok-fresh-${refreshes}`;
        return token;
      },
      watchIds: over.watchIds ?? (() => [{ kind: "issue", id: "i-1" }, { kind: "issue", id: "i-2" }]),
      onDoorbell: (kind, id, unit) => {
        doorbellKinds.push(kind);
        doorbells.push(id);
        units.push(unit);
      },
      onRejected: async (r) => {
        rejected.push(r);
      },
      sweep: async (reason) => {
        sweeps.push(reason);
      },
      timing: { backoffMinMs: 1000, backoffMaxMs: 8000, ...(over.idleMs === undefined ? {} : { idleMs: over.idleMs }) },
    });
    const controller = new AbortController();
    const done = loop.run(controller.signal);
    return { loop, logs, sweeps, doorbells, doorbellKinds, units, rejected, controller, done, setToken: (t: string) => (token = t), refreshes: () => refreshes };
  }

  it("subscribes every watch on hello with the current token, sweeps, then rings on doorbells for issues only", async () => {
    const hooks = fakeHooks();
    const s = start(hooks);
    await tick();
    expect(hooks.streams).toHaveLength(1);
    expect(s.loop.connected).toBe(false);
    hooks.last().send(": keepalive\n\n");
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(hooks.subscribes).toEqual([{ connection: "c_1", source: "github", token: "tok-1", watches: [{ kind: "issue", id: "i-1" }, { kind: "issue", id: "i-2" }] }]);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.loop.connected).toBe(true);

    hooks.last().send(hooks.doorbell("i-1"));
    hooks.last().send(hooks.doorbell("acme/widgets", { kind: "repo" }));
    hooks.last().send(hooks.doorbell("acme/widgets#4", { kind: "dependabot_alert" }));
    hooks.last().send(hooks.doorbell("i-9", { source: "linear" }));
    hooks.last().send("event: doorbell\ndata: not json\n\n");
    hooks.last().send(hooks.doorbell("i-2", { action: "remove", unit: "" }));
    await tick();
    expect(s.doorbells).toEqual(["i-1", "acme/widgets#4", "i-2"]);
    expect(s.doorbellKinds).toEqual(["issue", "dependabot_alert", "issue"]);
    // The unit comes along when the service names one.
    expect(s.units).toEqual(["acme/widgets", "acme/widgets", null]);
    expect(s.logs.join("\n")).not.toContain("tok-1");

    s.controller.abort();
    await s.done;
    expect(hooks.last().closed).toBe(true);
  });

  it("renews at half the lease with whatever token it holds, and sweeps after a failed or late renewal", async () => {
    const hooks = fakeHooks();
    const s = start(hooks);
    await tick();
    hooks.last().send(hooks.hello("c_1", 3600));
    await tick();
    expect(hooks.subscribes).toHaveLength(1);

    s.setToken("tok-2");
    await tick(30 * MINUTE);
    expect(hooks.subscribes).toHaveLength(2);
    expect(hooks.subscribes[1]!.token).toBe("tok-2");
    // A renewal on time is quiet; the 10-minute baseline is what sweeps meanwhile.
    expect(s.sweeps).toEqual(["connected", "baseline", "baseline", "baseline"]);

    hooks.state.answer = () => new Response("", { status: 500 });
    await tick(30 * MINUTE);
    expect(hooks.subscribes).toHaveLength(3);
    expect(s.sweeps.filter((r) => r === "failed renewal")).toHaveLength(1);
    expect(s.logs.at(-1)).toContain("HTTP 500");

    // The lease ran out during the failure; the next renewal that works is late.
    hooks.state.answer = (body) => Response.json({ leases: body.watches, rejected: [] });
    await tick(30 * MINUTE);
    expect(hooks.subscribes).toHaveLength(4);
    expect(s.sweeps.filter((r) => r === "late renewal")).toHaveLength(1);
    expect(s.loop.connected).toBe(true);

    s.controller.abort();
    await s.done;
  });

  it("reconnects when the service forgets the connection, and hands rejected leases back", async () => {
    const hooks = fakeHooks();
    const s = start(hooks);
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    hooks.state.answer = () => Response.json({ error: "unknown-connection" }, { status: 404 });
    await tick(30 * MINUTE);
    expect(hooks.streams[0]!.closed).toBe(true);
    expect(s.loop.connected).toBe(false);
    await tick(1000);
    expect(hooks.streams).toHaveLength(2);
    hooks.state.answer = (body) => Response.json({ leases: [body.watches[1]], rejected: [{ ...body.watches[0], reason: "forbidden" }] });
    hooks.last().send(hooks.hello("c_2"));
    await tick();
    expect(hooks.subscribes.at(-1)!.connection).toBe("c_2");
    expect(s.rejected).toEqual([[{ kind: "issue", id: "i-1", reason: "forbidden" }]]);
    expect(s.sweeps.filter((r) => r === "connected")).toHaveLength(2);
    s.controller.abort();
    await s.done;
  });

  it("while the service is unreachable, retries with backoff and sweeps every two minutes", async () => {
    const hooks = fakeHooks();
    hooks.state.eventsStatus = 503;
    const s = start(hooks);
    await tick();
    expect(s.sweeps).toEqual(["stream down"]);
    // 1s, 2s, 4s, 8s, 8s ... attempts; the sweep waits for the 2-minute mark.
    await tick(1000 + 2000 + 4000 + 8000 + 8000);
    expect(hooks.fetchImpl).toHaveBeenCalledTimes(6);
    expect(s.sweeps).toEqual(["stream down"]);
    await tick(2 * MINUTE);
    expect(s.sweeps).toEqual(["stream down", "stream down"]);
    expect(s.logs.filter((l) => l.includes("HTTP 503")).length).toBeGreaterThan(5);

    hooks.state.eventsStatus = 200;
    await tick(8000);
    hooks.last().send(hooks.hello("c_3"));
    await tick();
    expect(hooks.subscribes).toHaveLength(1);
    expect(s.sweeps.at(-1)).toBe("connected");

    // A stream that ends is reconnected the same way.
    hooks.last().end();
    await tick(1000);
    expect(hooks.streams).toHaveLength(2);
    s.controller.abort();
    await s.done;
  });

  it("reports its state and how busy it has been, and says when the state changes", async () => {
    const hooks = fakeHooks();
    hooks.state.eventsStatus = 503;
    const s = start(hooks);
    const changes: string[] = [];
    s.loop.onStateChange(() => changes.push(s.loop.status().state));
    await tick();
    expect(s.loop.status()).toMatchObject({ state: "connecting", since: now, leased: false, leasedUntil: 0, doorbells: 0, sweeps: 1, lastSweepAt: now, lastSweepReason: "stream down" });

    hooks.state.eventsStatus = 200;
    await tick(1000);
    const connectedAt = now;
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(changes).toEqual(["connected"]);
    expect(s.loop.status()).toMatchObject({ state: "connected", since: connectedAt, leased: true, leasedUntil: connectedAt + 60 * MINUTE, sweeps: 2, lastSweepReason: "connected" });

    hooks.last().send(hooks.doorbell("i-1"));
    hooks.last().send(hooks.doorbell("i-2"));
    hooks.last().send(hooks.doorbell("team-1", { kind: "team" }));
    await tick();
    expect(s.loop.status()).toMatchObject({ doorbells: 2, lastDoorbellAt: now });
    // Counts are over the last hour; the last time is kept.
    const lastDoorbellAt = now;
    await tick(61 * MINUTE);
    expect(s.loop.status()).toMatchObject({ doorbells: 0, lastDoorbellAt });

    hooks.last().end();
    await tick();
    expect(changes).toEqual(["connected", "connecting"]);
    expect(s.loop.status().state).toBe("connecting");
    s.controller.abort();
    await s.done;
    expect(changes).toEqual(["connected", "connecting", "stopped"]);
    expect(s.loop.status()).toMatchObject({ state: "stopped", leased: false });
  });

  it("leases a newly added watch or repository right away when connected, and leaves it to the next hello otherwise", async () => {
    const hooks = fakeHooks();
    const s = start(hooks, { watchIds: () => [] });
    await s.loop.added("issue", "i-new");
    await tick();
    expect(hooks.subscribes).toEqual([]);
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    // No watches: nothing to subscribe, but the connection still counts as leased and swept.
    expect(hooks.subscribes).toEqual([]);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.loop.connected).toBe(true);
    await s.loop.added("issue", "i-new");
    expect(hooks.subscribes).toEqual([{ connection: "c_1", source: "github", token: "tok-1", watches: [{ kind: "issue", id: "i-new" }] }]);
    // Several at once are one call; none is no call.
    await s.loop.added("repo", "acme/widgets", "acme/gadgets");
    await s.loop.added("repo");
    expect(hooks.subscribes.slice(1)).toEqual([{ connection: "c_1", source: "github", token: "tok-1", watches: [{ kind: "repo", id: "acme/widgets" }, { kind: "repo", id: "acme/gadgets" }] }]);
    s.controller.abort();
    await s.done;
  });

  it("refreshes the token and retries once when the service says GitHub refused it", async () => {
    const hooks = fakeHooks();
    hooks.state.answer = (body) => (body.token.startsWith("tok-fresh") ? Response.json({ leases: body.watches, rejected: [] }) : new Response("", { status: 401 }));
    const s = start(hooks);
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(hooks.subscribes.map((b) => b.token)).toEqual(["tok-1", "tok-fresh-1"]);
    expect(s.refreshes()).toBe(1);
    expect(s.loop.connected).toBe(true);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.logs.join("\n")).not.toMatch(/tok-/u);

    // Refused again after the refresh: a failed renewal, nothing dropped, no second refresh.
    hooks.state.answer = () => new Response("", { status: 401 });
    await tick(30 * MINUTE);
    expect(hooks.subscribes.map((b) => b.token)).toEqual(["tok-1", "tok-fresh-1", "tok-fresh-1", "tok-fresh-2"]);
    expect(s.refreshes()).toBe(2);
    expect(s.sweeps.filter((r) => r === "failed renewal")).toHaveLength(1);
    expect(s.logs.at(-1)).toContain("HTTP 401");
    expect(s.rejected).toEqual([]);
    expect(hooks.streams).toHaveLength(1);
    s.controller.abort();
    await s.done;
  });

  it("treats a 404 without the unknown-connection body as a wrong URL: logged once, no tight reconnect", async () => {
    const hooks = fakeHooks();
    hooks.state.answer = () => new Response("not found", { status: 404 });
    const s = start(hooks);
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    await tick(60 * MINUTE);
    expect(hooks.streams).toHaveLength(1);
    expect(hooks.streams[0]!.closed).toBe(false);
    expect(hooks.subscribes).toHaveLength(3);
    expect(s.logs.filter((l) => l.includes("BB_HOOKS_URL looks wrong"))).toHaveLength(1);
    expect(s.sweeps.filter((r) => r === "failed renewal")).toHaveLength(2);
    s.controller.abort();
    await s.done;
  });

  it("drops a stream silent for a minute and reconnects; keepalives count as life", async () => {
    const hooks = fakeHooks();
    const s = start(hooks);
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    await tick(5 * MINUTE);
    expect(hooks.streams).toHaveLength(1);
    expect(hooks.streams[0]!.closed).toBe(false);
    hooks.state.silent = true;
    await tick(59_999);
    expect(hooks.streams[0]!.closed).toBe(false);
    await tick(1);
    expect(hooks.streams[0]!.closed).toBe(true);
    expect(s.loop.connected).toBe(false);
    expect(s.logs.some((l) => l.includes("no bytes from bb-gate-hooks for 60 s"))).toBe(true);
    await tick(1000);
    expect(hooks.streams).toHaveLength(2);
    s.controller.abort();
    await s.done;
  });

  it("keeps a token problem out of the log and treats it as a failed renewal", async () => {
    const hooks = fakeHooks();
    const s = start(hooks, { token: async () => { throw new Error("GitHub is not signed in on this bb server (no oauth token). Sign in from the GitHub row of the Team setup checklist."); } });
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(hooks.subscribes).toEqual([]);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.logs.some((l) => l.startsWith("warn") && l.includes("Team setup checklist"))).toBe(true);
    s.controller.abort();
    await s.done;
  });
});
