import { describe, expect, it, vi } from "vitest";
import { createHooksLoop, HooksRequestError, SseParser, sessionEventSchema, subscribe } from "./hooks-client.js";

const BASE = "http://bb-gate-hooks.test:8081";

describe("SseParser", () => {
  it("joins data lines and dispatches on a blank line", () => {
    const parser = new SseParser();
    expect(parser.push("event: session\ndata: {\"a\":1}\n\n")).toEqual([{ event: "session", data: '{"a":1}', id: null }]);
  });

  it("drops keepalive comments and strips one leading space", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\nevent: hello\ndata: spaced\n\n")).toEqual([{ event: "hello", data: "spaced", id: null }]);
  });

  it("holds a partial event until the blank line arrives", () => {
    const parser = new SseParser();
    expect(parser.push("event: session\ndata: {")).toEqual([]);
    expect(parser.push("\"a\":1}\n\n")).toEqual([{ event: "session", data: '{"a":1}', id: null }]);
  });
});

describe("sessionEventSchema", () => {
  it("accepts a Slack wake", () => {
    const parsed = sessionEventSchema.parse({
      source: "slack",
      session: "D0123:1712345678.901234",
      action: "message",
      channel: "D0123",
      thread: "1712345678.901234",
      asker: { id: "U0123", name: "Alice" },
      owner: { id: "U0123", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      comment: { text: "build this", untrusted: false },
      at: "2026-10-22T12:00:00Z",
    });
    expect(parsed.action).toBe("message");
  });

  it("reads files when the service sends them, and none when it does not", () => {
    const base = {
      source: "slack" as const,
      session: "D0123:1712345678.901234",
      action: "message" as const,
      channel: "D0123",
      thread: "1712345678.901234",
      asker: { id: "U0123", name: "Alice" },
      owner: { id: "U0123", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      comment: { text: "", untrusted: false },
      at: "2026-10-22T12:00:00Z",
    };
    // An older service sends no files field; it is read as none.
    expect(sessionEventSchema.parse(base).files).toEqual([]);
    const parsed = sessionEventSchema.parse({
      ...base,
      files: [
        { id: "F1", name: "shot.png", mimeType: "image/png", size: 1234 },
        { id: "F2", name: "snippet.go", mimeType: "text/plain", size: 99 },
      ],
    });
    expect(parsed.files).toEqual([
      { id: "F1", name: "shot.png", mimeType: "image/png", size: 1234 },
      { id: "F2", name: "snippet.go", mimeType: "text/plain", size: 99 },
    ]);
  });

  it("rejects a wake from another source", () => {
    expect(sessionEventSchema.safeParse({ source: "linear", session: "x", action: "created", channel: "c", thread: "t", asker: {}, owner: {}, fromOwner: true, comment: {} }).success).toBe(false);
  });

  it("treats a missing tagged field as tagged, so an older service still expects a reply", () => {
    const parsed = sessionEventSchema.parse({
      source: "slack",
      session: "D0123:1712345678.901234",
      action: "message",
      channel: "D0123",
      thread: "1712345678.901234",
      asker: { id: "U0123", name: "Alice" },
      owner: { id: "U0123", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      comment: { text: "build this", untrusted: false },
      at: "2026-10-22T12:00:00Z",
    });
    expect(parsed.tagged).toBe(true);
  });

  it("carries tagged false for an untagged thread reply", () => {
    const parsed = sessionEventSchema.parse({
      source: "slack",
      session: "C0123:1712345678.901234",
      action: "message",
      mention: false,
      tagged: false,
      channel: "C0123",
      thread: "1712345678.901234",
      asker: { id: "U0123", name: "Alice" },
      owner: { id: "U0123", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      comment: { text: "what about the second one?", untrusted: false },
      at: "2026-10-30T12:00:00Z",
    });
    expect(parsed.tagged).toBe(false);
  });

  it("accepts the block_action wake, which carries no conversation", () => {
    const block = sessionEventSchema.parse({
      source: "slack",
      session: "",
      action: "block_action",
      channel: "C0123",
      thread: "",
      asker: { id: "U1", name: "Alice" },
      owner: { id: "U1", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      actionId: "bb_set_project",
      value: "prj-1",
      responseUrl: "https://hooks.slack.com/actions/T1/B1/cap",
      comment: { text: "", untrusted: false },
      at: "2026-10-26T12:00:00Z",
    });
    expect(block).toMatchObject({ action: "block_action", actionId: "bb_set_project", value: "prj-1", responseUrl: "https://hooks.slack.com/actions/T1/B1/cap" });
  });

  it("rejects the removed invited action, which the service no longer sends", () => {
    const parsed = sessionEventSchema.safeParse({
      source: "slack",
      session: "",
      action: "invited",
      channel: "C0123",
      thread: "",
      asker: { id: "U1", name: "Alice" },
      owner: { id: "U1", name: "Alice" },
      fromOwner: true,
      routedAs: "owner",
      comment: { text: "", untrusted: false },
      at: "2026-10-26T12:00:00Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("subscribe", () => {
  it("posts session leases with their capability and no token", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toBe(`${BASE}/v1/subscribe`);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ leases: [{ kind: "session", id: "D1:1" }], rejected: [] });
    }) as unknown as typeof fetch;
    const result = await subscribe(fetchImpl, BASE, "c_1", [{ kind: "session", id: "D1:1", capability: "cap-secret" }], new AbortController().signal);
    expect(bodies).toEqual([{ connection: "c_1", source: "slack", watches: [{ kind: "session", id: "D1:1", capability: "cap-secret" }] }]);
    expect(JSON.stringify(bodies[0])).not.toContain("token");
    expect(result.leases).toEqual([{ kind: "session", id: "D1:1" }]);
  });

  it("keeps the capability out of a failed request's message", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const error = await subscribe(fetchImpl, BASE, "c_1", [{ kind: "session", id: "D1:1", capability: "cap-secret" }], new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HooksRequestError);
    expect(String((error as Error).message)).not.toContain("cap-secret");
  });
});

describe("createHooksLoop", () => {
  it("identifies with source slack and no teams on the hello, and forwards a session wake", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady!: () => void;
    const ready = new Promise<void>((resolve) => (streamReady = resolve));
    const identifies: unknown[] = [];
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u === `${BASE}/v1/events`) {
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
            streamReady();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (u === `${BASE}/v1/identify`) {
        identifies.push(JSON.parse(String(init?.body)));
        return Response.json({ user: { id: "U1", name: "Alice" }, teams: [], rejected: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const loop = createHooksLoop({ fetch: fetchImpl, baseUrl: BASE, now: () => 1, log: { info: () => undefined, warn: () => undefined }, identity: () => "tok", onSession: (e) => seen.push(e) });
    const abort = new AbortController();
    const running = loop.run(abort.signal);
    await ready;
    controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ connection: "c_1", leaseSeconds: 3600 })}\n\n`));
    controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify({ source: "slack", session: "D1:1", action: "message", channel: "D1", thread: "1", asker: { id: "U1", name: "Alice" }, owner: { id: "U1", name: "Alice" }, fromOwner: true, routedAs: "owner", comment: { text: "hi", untrusted: false }, at: "t" })}\n\n`));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(identifies).toEqual([{ connection: "c_1", source: "slack", token: "tok", teams: [] }]);
    expect(loop.connectionId).toBe("c_1");
    abort.abort();
    await running;
  });

  it("leases the live sessions on the hello and hands rejections back", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady!: () => void;
    const ready = new Promise<void>((resolve) => (streamReady = resolve));
    const subscribes: unknown[] = [];
    const rejected: unknown[] = [];
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u === `${BASE}/v1/events`) {
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
            streamReady();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (u === `${BASE}/v1/identify`) return Response.json({ user: { id: "U1", name: "Alice" }, teams: [], rejected: [] });
      if (u === `${BASE}/v1/subscribe`) {
        subscribes.push(JSON.parse(String(init?.body)));
        return Response.json({ leases: [], rejected: [{ kind: "session", id: "D1:1", reason: "owned" }] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const loop = createHooksLoop({
      fetch: fetchImpl,
      baseUrl: BASE,
      now: () => 1,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      identity: () => "tok",
      leases: () => [{ kind: "session", id: "D1:1", capability: "cap-secret" }],
      onRejected: (r) => rejected.push(r),
      onSession: () => undefined,
    });
    const abort = new AbortController();
    const running = loop.run(abort.signal);
    await ready;
    controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ connection: "c_1", leaseSeconds: 3600 })}\n\n`));
    await vi.waitFor(() => expect(subscribes).toHaveLength(1));
    expect(subscribes[0]).toEqual({ connection: "c_1", source: "slack", watches: [{ kind: "session", id: "D1:1", capability: "cap-secret" }] });
    expect(rejected).toEqual([[{ kind: "session", id: "D1:1", reason: "owned" }]]);
    expect(logs.join("\n")).not.toContain("cap-secret");
    abort.abort();
    await running;
  });

  it("posts an ephemeral prompt through the loop with the connection id", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamReady!: () => void;
    const ready = new Promise<void>((resolve) => (streamReady = resolve));
    const ephemerals: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u === `${BASE}/v1/events`) {
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
            streamReady();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (u === `${BASE}/v1/slack/ephemeral`) {
        ephemerals.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const loop = createHooksLoop({ fetch: fetchImpl, baseUrl: BASE, now: () => 1, log: { info: () => undefined, warn: () => undefined }, identity: () => "tok", onSession: () => undefined });
    const abort = new AbortController();
    const running = loop.run(abort.signal);
    await ready;
    controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ connection: "c_1", leaseSeconds: 3600 })}\n\n`));
    await vi.waitFor(() => expect(loop.connectionId).toBe("c_1"));
    await loop.ephemeral({ channel: "C1", user: "U1", text: "Which project?", blocks: [{ type: "section" }] }, abort.signal);
    expect(ephemerals).toEqual([{ connection: "c_1", channel: "C1", user: "U1", text: "Which project?", blocks: [{ type: "section" }] }]);
    abort.abort();
    await running;
  });
});
