import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL } from "../config.js";
import {
  REALTIME_CLOSE_PATH,
  REALTIME_MINT_PATH,
  REALTIME_TOOL_PATH,
  type MintedRealtimeSession,
} from "../realtime-shared.js";
import { PLUGIN_ID, createVoiceTranscriptionPlugin } from "../server.js";
import { runThrowawayCaller, type ThrowawayCallerTransport } from "./caller.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

async function load(): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings: { apiKey: "sk-throwaway-standard", baseUrl: DEFAULT_BASE_URL },
  });
  disposals.push(() => host.harness.lifecycle.dispose());
  await createVoiceTranscriptionPlugin({})(host.bb);
  return host;
}

describe("throwaway caller", () => {
  it("opens, mints, forwards a tool call and closes against a mocked OpenAI", async () => {
    const host = await load();
    // The opener's own tool handler; the real cross-plugin call is stubbed.
    host.harness.sdk.stub("plugins.callRpc", async () => ({ text: "ping" }));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: "ek_throwaway", expires_at: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transport: ThrowawayCallerTransport = {
      open: async (config) =>
        (await host.harness.callRpc("realtime.open", config, {
          experimental_caller: { kind: "plugin", pluginId: "throwaway-caller" },
        })) as { sessionId: string },
      mint: async (sessionId) =>
        (await (await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, json({ sessionId }))).json()) as MintedRealtimeSession,
      toolCall: async (call) =>
        (await (await host.harness.fetchHttp("POST", REALTIME_TOOL_PATH, json(call))).json()) as { output: string },
      close: async (sessionId) => {
        await host.harness.fetchHttp("POST", REALTIME_CLOSE_PATH, json({ sessionId }));
      },
    };

    const result = await runThrowawayCaller(transport);

    expect(result.minted.value).toBe("ek_throwaway");
    expect(result.toolOutput).toBe(JSON.stringify({ text: "ping" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The session was closed, so its secret can never be minted again.
    const after = await host.harness.fetchHttp("POST", REALTIME_MINT_PATH, json({ sessionId: result.sessionId }));
    expect(after.status).toBe(404);
  });
});
