import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHooksLoop, HooksRequestError, postActivity, readSse, SseParser, StreamIdleError, subscribe, type IdentifyResponse, type Lease, type Rejection, type SessionEvent } from "./hooks-client.js";

const BASE = "http://hooks.test:8081";
const MINUTE = 60_000;

// A bb-gate-hooks whose stream and subscribe endpoint a test drives.
function fakeHooks() {
  const encoder = new TextEncoder();
  type Stream = { send(text: string): void; end(): void; closed: boolean };
  const streams: Stream[] = [];
  const subscribes: Array<{ connection: string; source: string; token: string; watches: Array<{ kind: string; id: string }> }> = [];
  const identifies: Array<{ connection: string; source: string; token: string; teams: string[] }> = [];
  const replies: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const state = {
    eventsStatus: 200,
    silent: false,
    answer: (body: (typeof subscribes)[number]): Response => Response.json({ leases: body.watches.map((w) => ({ ...w, unit: "team-1", expiresAt: "2026-10-10T18:00:00Z" })), rejected: [] }),
    /** Null: the service predates agent sessions and has no /v1/identify. */
    identify: ((body: (typeof identifies)[number]): Response => Response.json({ user: { id: "u1", name: "Jane" }, teams: body.teams, rejected: [], expiresAt: "2026-10-10T18:00:00Z" })) as ((body: (typeof identifies)[number]) => Response) | null,
    reply: (): Response => Response.json({ activity: "act-1" }),
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
    if (u === `${BASE}/v1/identify` && state.identify !== null) {
      const body = JSON.parse(String(init?.body)) as (typeof identifies)[number];
      identifies.push(body);
      return state.identify(body);
    }
    if (u.startsWith(`${BASE}/v1/linear/sessions/`)) {
      replies.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: { ...(init?.headers as Record<string, string>) } });
      return state.reply();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const hello = (connection: string, leaseSeconds = 3600) => `event: hello\ndata: ${JSON.stringify({ connection, leaseSeconds })}\n\n`;
  const doorbell = (id: string, over: Record<string, unknown> = {}) =>
    `id: 1\nevent: doorbell\ndata: ${JSON.stringify({ source: "linear", kind: "issue", id, unit: "team-1", action: "update", at: "2026-10-10T17:02:11Z", ...over })}\n\n`;
  const session = (over: Record<string, unknown> = {}) =>
    `id: 2\nevent: session\ndata: ${JSON.stringify({
      source: "linear",
      session: "sess-1",
      action: "created",
      issue: { id: "i-1", identifier: "ENG-1", team: "t-eng", teamKey: "ENG" },
      asker: { id: "u2", name: "Carol" },
      owner: { id: "u1", name: "Jane" },
      fromOwner: false,
      routedAs: "assignee",
      comment: { text: "@bb build this", untrusted: true },
      at: "2026-10-10T17:02:11Z",
      ...over,
    })}\n\n`;
  return { fetchImpl, streams, subscribes, identifies, replies, state, hello, doorbell, session, last: () => streams.at(-1)! };
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
  it("posts the connection, source, token and watches, in batches of 100, and merges the answers", async () => {
    const hooks = fakeHooks();
    const leases = Array.from({ length: 150 }, (_, i) => ({ kind: i === 149 ? ("team" as const) : ("issue" as const), id: `i-${i}` }));
    hooks.state.answer = (body) => Response.json({ leases: body.watches.slice(1), rejected: [{ ...body.watches[0], reason: "forbidden" }] });
    const result = await subscribe(hooks.fetchImpl, BASE, "c_1", "tok-1", leases, new AbortController().signal);
    expect(hooks.subscribes).toHaveLength(2);
    expect(hooks.subscribes[0]).toMatchObject({ connection: "c_1", source: "linear", token: "tok-1" });
    expect(hooks.subscribes[0]!.watches).toHaveLength(100);
    expect(hooks.subscribes[0]!.watches[0]).toEqual({ kind: "issue", id: "i-0" });
    expect(hooks.subscribes[1]!.watches).toHaveLength(50);
    expect(hooks.subscribes[1]!.watches.at(-1)).toEqual({ kind: "team", id: "i-149" });
    expect(result.leases).toHaveLength(148);
    expect(result.rejected.map((r) => r.id)).toEqual(["i-0", "i-100"]);
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

  function start(
    hooks: ReturnType<typeof fakeHooks>,
    over: { leases?: () => Lease[]; token?: (account?: string) => Promise<string>; idleMs?: number; identity?: () => { account?: string; teams: string[] } | null } = {},
  ) {
    const logs: string[] = [];
    const sessions: SessionEvent[] = [];
    const identities: IdentifyResponse[] = [];
    const sweeps: string[] = [];
    const doorbells: string[] = [];
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
      leases:
        over.leases ??
        (() => [
          { kind: "issue", id: "i-1" },
          { kind: "issue", id: "i-2" },
        ]),
      onDoorbell: (id, unit) => {
        doorbells.push(id);
        units.push(unit);
      },
      onRejected: async (r) => {
        rejected.push(r);
      },
      sweep: async (reason) => {
        sweeps.push(reason);
      },
      ...(over.identity === undefined ? {} : { identity: over.identity }),
      onIdentified: (who) => void identities.push(who),
      onSession: (event) => void sessions.push(event),
      timing: { backoffMinMs: 1000, backoffMaxMs: 8000, ...(over.idleMs === undefined ? {} : { idleMs: over.idleMs }) },
    });
    const controller = new AbortController();
    const done = loop.run(controller.signal);
    return { loop, logs, sweeps, doorbells, units, rejected, sessions, identities, controller, done, setToken: (t: string) => (token = t), refreshes: () => refreshes };
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
    expect(hooks.subscribes).toEqual([{ connection: "c_1", source: "linear", token: "tok-1", watches: [{ kind: "issue", id: "i-1" }, { kind: "issue", id: "i-2" }] }]);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.loop.connected).toBe(true);

    hooks.last().send(hooks.doorbell("i-1"));
    hooks.last().send(hooks.doorbell("team-1", { kind: "team" }));
    hooks.last().send(hooks.doorbell("i-9", { source: "github" }));
    hooks.last().send("event: doorbell\ndata: not json\n\n");
    hooks.last().send(hooks.doorbell("i-2", { action: "remove", unit: "" }));
    await tick();
    expect(s.doorbells).toEqual(["i-1", "i-2"]);
    // The unit comes through for stewards' team interest; an empty one is none.
    expect(s.units).toEqual(["team-1", null]);
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

  it("proves each workspace's leases with its own token, one call each, and says whose a refused lease was", async () => {
    const hooks = fakeHooks();
    hooks.state.answer = (body) =>
      body.token === "tok-globex"
        ? Response.json({ leases: [], rejected: [{ ...body.watches[0], reason: "forbidden" }] })
        : Response.json({ leases: body.watches, rejected: [] });
    const s = start(hooks, {
      token: async (account) => `tok-${account}`,
      leases: () => [
        { kind: "issue", id: "i-1", account: "acme" },
        { kind: "issue", id: "i-2", account: "globex" },
        { kind: "team", id: "t-1", account: "acme" },
      ],
    });
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(hooks.subscribes.map((b) => [b.token, b.watches])).toEqual([
      ["tok-acme", [{ kind: "issue", id: "i-1" }, { kind: "team", id: "t-1" }]],
      ["tok-globex", [{ kind: "issue", id: "i-2" }]],
    ]);
    expect(s.rejected).toEqual([[{ kind: "issue", id: "i-2", reason: "forbidden", account: "globex" }]]);
    expect(s.loop.connected).toBe(true);
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

  it("leases a newly added watch right away when connected, and leaves it to the next hello otherwise", async () => {
    const hooks = fakeHooks();
    const s = start(hooks, { leases: () => [] });
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
    expect(hooks.subscribes).toEqual([{ connection: "c_1", source: "linear", token: "tok-1", watches: [{ kind: "issue", id: "i-new" }] }]);
    // Teams stewards asked about go out the same way, several in one call; none is no call.
    await s.loop.added("team", "t-1", "t-2");
    await s.loop.added("team");
    expect(hooks.subscribes.at(-1)!.watches).toEqual([{ kind: "team", id: "t-1" }, { kind: "team", id: "t-2" }]);
    expect(hooks.subscribes).toHaveLength(2);
    s.controller.abort();
    await s.done;
  });

  it("refreshes the token and retries once when the service says Linear refused it", async () => {
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
    const s = start(hooks, { token: async () => { throw new Error("The Linear token was refused and there is no refresh token. Connect Linear again."); } });
    await tick();
    hooks.last().send(hooks.hello("c_1"));
    await tick();
    expect(hooks.subscribes).toEqual([]);
    expect(s.sweeps).toEqual(["connected"]);
    expect(s.logs.some((l) => l.startsWith("warn") && l.includes("Connect Linear again"))).toBe(true);
    s.controller.abort();
    await s.done;
  });

  describe("agent sessions", () => {
    it("identifies on hello and at every renewal with the current token and the teams, never logging the token", async () => {
      const hooks = fakeHooks();
      let teams = ["t-eng"];
      const s = start(hooks, { identity: () => ({ teams }) });
      await tick();
      hooks.last().send(hooks.hello("c_1", 600));
      await tick();
      expect(hooks.identifies).toEqual([{ connection: "c_1", source: "linear", token: "tok-1", teams: ["t-eng"] }]);
      expect(s.identities.map((i) => i.user.name)).toEqual(["Jane"]);

      // The teams changed: identify again now, replacing the set.
      teams = ["t-eng", "t-ops"];
      await s.loop.reidentify();
      expect(hooks.identifies.at(-1)).toMatchObject({ connection: "c_1", teams: ["t-eng", "t-ops"] });

      s.setToken("tok-2");
      await tick(300_000);
      expect(hooks.identifies.at(-1)).toMatchObject({ token: "tok-2" });
      expect(hooks.identifies).toHaveLength(3);
      expect(s.logs.join("\n")).not.toMatch(/tok-/u);
      s.controller.abort();
      await s.done;
    });

    it("refreshes the token once when Linear refused it, and identifies nobody when there is no identity", async () => {
      const hooks = fakeHooks();
      hooks.state.identify = (body) => (body.token === "tok-1" ? new Response("token refused", { status: 401 }) : Response.json({ user: { id: "u1", name: "Jane" }, teams: [], rejected: [] }));
      const s = start(hooks, { identity: () => ({ teams: [] }) });
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      await tick();
      expect(hooks.identifies.map((i) => i.token)).toEqual(["tok-1", "tok-fresh-1"]);
      expect(s.identities).toHaveLength(1);
      s.controller.abort();
      await s.done;

      const none = fakeHooks();
      const t = start(none, { identity: () => null });
      await tick();
      none.last().send(none.hello("c_2"));
      await tick();
      expect(none.identifies).toEqual([]);
      expect(none.subscribes).toHaveLength(1);
      t.controller.abort();
      await t.done;
    });

    it("keeps the watches on a service without /v1/identify, saying so once", async () => {
      const hooks = fakeHooks();
      hooks.state.identify = null;
      const s = start(hooks, { identity: () => ({ teams: [] }) });
      await tick();
      hooks.last().send(hooks.hello("c_1", 600));
      await tick();
      await tick(300_000);
      expect(hooks.subscribes).toHaveLength(2);
      expect(s.loop.connected).toBe(true);
      expect(s.logs.filter((l) => l.includes("no /v1/identify"))).toHaveLength(1);
      expect(s.sweeps).toEqual(["connected"]);
      s.controller.abort();
      await s.done;
    });

    it("hands session events on, parsed, and drops ones it cannot read", async () => {
      const hooks = fakeHooks();
      const s = start(hooks);
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      hooks.last().send(hooks.session());
      hooks.last().send(hooks.session({ action: "stopped" }));
      hooks.last().send("event: session\ndata: not json\n\n");
      hooks.last().send(hooks.session({ session: "sess-2", action: "prompted", fromOwner: true, asker: { id: "u1", name: "Jane" }, comment: { text: "yes", untrusted: false } }));
      await tick();
      expect(s.sessions.map((e) => [e.session, e.action, e.issue.identifier, e.comment.untrusted])).toEqual([
        ["sess-1", "created", "ENG-1", true],
        ["sess-2", "prompted", "ENG-1", false],
      ]);
      expect(s.logs.filter((l) => l.includes("does not understand"))).toHaveLength(1);
      expect(s.doorbells).toEqual([]);
      s.controller.abort();
      await s.done;
    });

    it("replies over the current connection with no token, and refuses without one", async () => {
      const hooks = fakeHooks();
      const s = start(hooks);
      await expect(s.loop.reply("sess-1", { kind: "response", body: "Done." }, new AbortController().signal)).rejects.toThrow(/not connected to bb-gate-hooks/u);
      await tick();
      hooks.last().send(hooks.hello("c_1"));
      await tick();
      expect(await s.loop.reply("sess/1", { kind: "elicitation", body: "Confirm?", externalUrl: "https://bb.example/t" }, new AbortController().signal)).toMatchObject({ activity: "act-1" });
      expect(hooks.replies).toEqual([
        { url: `${BASE}/v1/linear/sessions/sess%2F1/activity`, body: { connection: "c_1", kind: "elicitation", body: "Confirm?", externalUrl: "https://bb.example/t" }, headers: expect.not.objectContaining({ authorization: expect.anything() }) },
      ]);
      expect(JSON.stringify(hooks.replies)).not.toMatch(/tok-/u);

      hooks.state.reply = () => Response.json({ error: "not-routed" }, { status: 403 });
      const refused = await s.loop.reply("sess-1", { kind: "response", body: "x" }, new AbortController().signal).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(HooksRequestError);
      expect((refused as HooksRequestError).code).toBe("not-routed");
      s.controller.abort();
      await s.done;
    });
  });
});

describe("postActivity", () => {
  it("leaves out an absent external link", async () => {
    const hooks = fakeHooks();
    await postActivity(hooks.fetchImpl, BASE, "c_1", "sess-1", { kind: "error", body: "No." }, new AbortController().signal);
    expect(hooks.replies[0]!.body).toEqual({ connection: "c_1", kind: "error", body: "No." });
  });
});
