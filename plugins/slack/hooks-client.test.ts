import { describe, expect, it, vi } from "vitest";
import { createHooksLoop, SseParser, sessionEventSchema } from "./hooks-client.js";

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

  it("rejects a wake from another source", () => {
    expect(sessionEventSchema.safeParse({ source: "linear", session: "x", action: "created", channel: "c", thread: "t", asker: {}, owner: {}, fromOwner: true, comment: {} }).success).toBe(false);
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
});
