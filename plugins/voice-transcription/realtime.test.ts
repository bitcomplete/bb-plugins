import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL } from "./config.js";
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  REALTIME_CLIENT_SECRET_PATH,
  REALTIME_SECRET_TTL_SECONDS,
  REALTIME_SESSION_MAX_MS,
  isOpenAIBaseUrl,
  parseClientSecret,
  realtimeClientSecretBody,
  realtimeMaxMs,
  realtimeReadiness,
} from "./realtime.js";
import {
  REALTIME_CLOSE_PATH,
  REALTIME_MINT_PATH,
  REALTIME_SIGNAL_CHANNEL,
  REALTIME_TOOL_PATH,
} from "./realtime-shared.js";
import { PLUGIN_ID, createVoiceTranscriptionPlugin } from "./server.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

/** Load the plugin into the fake host with the given stored settings. */
async function load(
  settings: Record<string, string> = {},
  env: Record<string, string | undefined> = {},
): Promise<FakePluginHost> {
  const host = createFakePluginHost({ pluginId: PLUGIN_ID, settings });
  disposals.push(() => host.harness.lifecycle.dispose());
  await createVoiceTranscriptionPlugin(env)(host.bb);
  return host;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonRequest(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

/** Open a session the way another plugin does. */
function open(host: FakePluginHost, input: Record<string, unknown>): Promise<unknown> {
  return host.harness.callRpc("realtime.open", input, {
    experimental_caller: { kind: "plugin", pluginId: "throwaway-caller" },
  });
}

/** The stored key every route test uses, to prove it never comes back out. */
const STANDARD_KEY = "sk-standard-abcdefghijklmnop";

const ECHO = {
  name: "echo",
  description: "Echo the given text.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
};

describe("realtime policy", () => {
  it("treats only OpenAI's endpoint as OpenAI, trailing slash included", () => {
    expect(isOpenAIBaseUrl(DEFAULT_BASE_URL)).toBe(true);
    expect(isOpenAIBaseUrl(`${DEFAULT_BASE_URL}/`)).toBe(true);
    expect(isOpenAIBaseUrl(" https://api.openai.com/v1 ")).toBe(true);
    expect(isOpenAIBaseUrl("https://api.groq.com/openai/v1")).toBe(false);
    expect(isOpenAIBaseUrl("http://whisper.local:8080/v1")).toBe(false);
    expect(isOpenAIBaseUrl("")).toBe(false);
  });

  it("refuses clearly off OpenAI's endpoint or without a key", () => {
    expect(realtimeReadiness({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk" })).toBeNull();
    expect(realtimeReadiness({ baseUrl: DEFAULT_BASE_URL, apiKey: "  " })).toMatchObject({ status: 403 });
    expect(realtimeReadiness({ baseUrl: "http://whisper.local:8080/v1", apiKey: "sk" })).toMatchObject({ status: 400 });
  });

  it("caps a session on the order of twenty minutes", () => {
    expect(realtimeMaxMs({ instructions: "x", tools: [] })).toBe(REALTIME_SESSION_MAX_MS);
    expect(realtimeMaxMs({ instructions: "x", tools: [], maxDurationMs: 1_000 })).toBe(1_000);
    expect(realtimeMaxMs({ instructions: "x", tools: [], maxDurationMs: REALTIME_SESSION_MAX_MS * 10 })).toBe(REALTIME_SESSION_MAX_MS);
    expect(realtimeMaxMs({ instructions: "x", tools: [], maxDurationMs: -5 })).toBe(REALTIME_SESSION_MAX_MS);
  });

  it("shapes the client-secret request with the short expiry, instructions and tools", () => {
    const body = realtimeClientSecretBody({ instructions: "Say hi.", tools: [ECHO] });
    expect(body).toMatchObject({
      expires_after: { anchor: "created_at", seconds: REALTIME_SECRET_TTL_SECONDS },
      session: {
        type: "realtime",
        model: DEFAULT_REALTIME_MODEL,
        instructions: "Say hi.",
        audio: { output: { voice: DEFAULT_REALTIME_VOICE } },
        tools: [{ type: "function", name: "echo", description: "Echo the given text." }],
      },
    });
    expect(REALTIME_SECRET_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  it("reads the ephemeral secret from either OpenAI reply shape", () => {
    expect(parseClientSecret({ value: "ek_a", expires_at: 10 })).toEqual({ value: "ek_a", expiresAt: 10 });
    expect(parseClientSecret({ client_secret: { value: "ek_b", expires_at: 20 } })).toEqual({ value: "ek_b", expiresAt: 20 });
    expect(() => parseClientSecret({ client_secret: { expires_at: 1 } })).toThrow(/no ephemeral/u);
    expect(() => parseClientSecret("nope")).toThrow(/not an object/u);
  });
});

describe("realtime mint route", () => {
  it("mints an ephemeral secret and never returns the standard key", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return jsonResponse({ value: "ek_ephemeral", expires_at: 1234 });
      }),
    );

    const opened = (await host.harness.callRpc(
      "realtime.open",
      { instructions: "You are a test.", tools: [ECHO], toolHandler: { pluginId: "throwaway-caller", method: "echo" } },
      { experimental_caller: { kind: "plugin", pluginId: "throwaway-caller" } },
    )) as { sessionId: string; maxDurationMs: number };
    expect(opened.sessionId).not.toBe("");
    expect(opened.maxDurationMs).toBe(REALTIME_SESSION_MAX_MS);
    expect(host.harness.realtimeSignals).toHaveLength(1);
    expect(host.harness.realtimeSignals[0]!.channel).toBe(REALTIME_SIGNAL_CHANNEL);
    expect(host.harness.realtimeSignals[0]!.payload).toEqual({ sessionId: opened.sessionId });

    const response = await host.harness.fetchHttp(
      "POST",
      REALTIME_MINT_PATH,
      jsonRequest({ sessionId: opened.sessionId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ value: "ek_ephemeral", expiresAt: 1234, model: DEFAULT_REALTIME_MODEL });
    expect(JSON.stringify(body)).not.toContain(STANDARD_KEY);
    expect(JSON.stringify(host.harness.logEntries)).not.toContain(STANDARD_KEY);

    // The standard key went only to OpenAI, with the session's instructions and tools.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DEFAULT_BASE_URL}${REALTIME_CLIENT_SECRET_PATH}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${STANDARD_KEY}`);
    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      session: { instructions: string; tools: Array<{ name: string }> };
    };
    expect(sent.session.instructions).toBe("You are a test.");
    expect(sent.session.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("refuses when the endpoint is not OpenAI", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: "https://api.groq.com/openai/v1" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await host.harness.fetchHttp(
      "POST",
      REALTIME_MINT_PATH,
      jsonRequest({ sessionId: "anything" }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/OpenAI/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when no key is set", async () => {
    const host = await load({ baseUrl: DEFAULT_BASE_URL });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await host.harness.fetchHttp(
      "POST",
      REALTIME_MINT_PATH,
      jsonRequest({ sessionId: "anything" }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/API key/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to open a session when unconfigured, so no overlay appears", async () => {
    const host = await load({ baseUrl: DEFAULT_BASE_URL });
    await expect(
      open(host, { instructions: "x", tools: [] }),
    ).rejects.toThrow(/API key/u);
    expect(host.harness.realtimeSignals).toHaveLength(0);
  });

  it("refuses to open from a browser client", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    await expect(
      host.harness.callRpc("realtime.open", { instructions: "x", tools: [] }),
    ).rejects.toThrow(/another plugin/u);
    expect(host.harness.realtimeSignals).toHaveLength(0);
  });

  it("mints once per session, 404s once closed, and 409s a second mint", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: "ek", expires_at: 1 })));
    const opened = (await open(host, { instructions: "x", tools: [ECHO] })) as {
      sessionId: string;
    };

    const first = await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({ sessionId: opened.sessionId }));
    expect(first.status).toBe(200);
    const second = await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({ sessionId: opened.sessionId }));
    expect(second.status).toBe(409);

    const closed = await host.harness.fetchHttp("POST", REALTIME_CLOSE_PATH, jsonRequest({ sessionId: opened.sessionId }));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ ok: true });
    const afterClose = await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({ sessionId: opened.sessionId }));
    expect(afterClose.status).toBe(404);
  });

  it("rejects a mint without a session id", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    const response = await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({}));
    expect(response.status).toBe(400);
  });
});

describe("realtime tool route", () => {
  it("forwards a declared tool call to the opener and returns its output", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    host.harness.sdk.stub("plugins.callRpc", async () => ({ text: "pong" }));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: "ek", expires_at: 1 })));
    const opened = (await open(host, {
      instructions: "x",
      tools: [ECHO],
      toolHandler: { pluginId: "throwaway-caller", method: "echo" },
    })) as { sessionId: string };
    await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({ sessionId: opened.sessionId }));

    const response = await host.harness.fetchHttp(
      "POST",
      REALTIME_TOOL_PATH,
      jsonRequest({ sessionId: opened.sessionId, callId: "call_1", name: "echo", arguments: '{"text":"hi"}' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: JSON.stringify({ text: "pong" }) });

    const calls = host.harness.sdk.callsTo("plugins.callRpc");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      pluginId: "throwaway-caller",
      method: "echo",
      input: { sessionId: opened.sessionId, callId: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    });
  });

  it("refuses an undeclared tool and a session with no handler", async () => {
    const host = await load({ apiKey: STANDARD_KEY, baseUrl: DEFAULT_BASE_URL });
    const fetchMock = vi.fn(async () => jsonResponse({ value: "ek", expires_at: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const declared = (await open(host, { instructions: "x", tools: [ECHO] })) as {
      sessionId: string;
    };
    await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, jsonRequest({ sessionId: declared.sessionId }));
    const unknownTool = await host.harness.fetchHttp(
      "POST",
      REALTIME_TOOL_PATH,
      jsonRequest({ sessionId: declared.sessionId, callId: "c", name: "not-declared", arguments: "{}" }),
    );
    expect(unknownTool.status).toBe(422);

    const handlerless = (await open(host, { instructions: "x", tools: [ECHO] })) as {
      sessionId: string;
    };
    const noHandler = await host.harness.fetchHttp(
      "POST",
      REALTIME_TOOL_PATH,
      jsonRequest({ sessionId: handlerless.sessionId, callId: "c", name: "echo", arguments: "{}" }),
    );
    expect(noHandler.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
