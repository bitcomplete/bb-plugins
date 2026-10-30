import type { PluginAiServiceDeclaration } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceTranscriptionPlugin,
  DEFAULT_BASE_URL,
  ERROR_BODY_CHARS,
  MAX_AUDIO_BYTES,
  MISSING_KEY_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  PLUGIN_ID,
  SERVICE_ID,
  audioFileName,
  errorExcerpt,
  redactLine,
  statusFor,
} from "./server.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

/** Load the plugin into the fake host with the given stored settings. */
async function load(settings: Record<string, string> = {}) {
  const host: FakePluginHost = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings,
  });
  disposals.push(() => host.harness.lifecycle.dispose());
  await createVoiceTranscriptionPlugin()(host.bb);
  const service = host.harness.inspection.registrations.aiServiceRegistrations.find(
    (entry) => entry.id === SERVICE_ID,
  );
  if (service === undefined) throw new Error("voice transcription service was not registered");
  return { host, service: service as PluginAiServiceDeclaration };
}

function audio(bytes = 3, name = "recording.webm", type = "audio/webm;codecs=opus"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("voice transcription registration", () => {
  it("registers the openai-compatible voice service", async () => {
    const { host, service } = await load();
    expect(host.harness.inspection.registrations.aiServiceRegistrations).toHaveLength(1);
    expect(service.id).toBe("openai-compatible");
    expect(service.displayName).toBe("OpenAI-compatible");
    expect(typeof service.transcribe).toBe("function");
    expect(typeof service.status).toBe("function");
    expect(service.complete).toBeUndefined();
  });
});

describe("status", () => {
  it("is not ready with the default OpenAI endpoint and no key", async () => {
    const { service } = await load();
    expect(await service.status!()).toEqual({ ready: false, message: MISSING_KEY_MESSAGE });
  });

  it("is not ready when the endpoint or the model is empty", async () => {
    const missingEndpoint = await load({ apiKey: "sk-test", baseUrl: "" });
    expect(await missingEndpoint.service.status!()).toEqual({
      ready: false,
      message: NOT_CONFIGURED_MESSAGE,
    });
    const missingModel = await load({ apiKey: "sk-test", model: "  " });
    expect(await missingModel.service.status!()).toEqual({
      ready: false,
      message: NOT_CONFIGURED_MESSAGE,
    });
  });

  it("is ready with a key on the default endpoint", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    expect(await service.status!()).toEqual({ ready: true });
  });

  it("is ready with an empty key when the endpoint is not the default", async () => {
    const { service } = await load({ baseUrl: "http://whisper.local:8080/v1" });
    expect(await service.status!()).toEqual({ ready: true });
  });

  it("treats a trailing slash on the default endpoint as the default", async () => {
    expect(statusFor({ baseUrl: `${DEFAULT_BASE_URL}/`, apiKey: "", model: "m", language: "" })).toEqual({
      ready: false,
      message: MISSING_KEY_MESSAGE,
    });
  });

  it("does not probe the network", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await service.status!();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("transcribe", () => {
  it("posts the exact multipart request, including prompt and language", async () => {
    const { service } = await load({ apiKey: "sk-test", language: "en" });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return jsonResponse({ text: "  hello world  " });
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await service.transcribe!(audio(), { signal: signal(), hint: "bb-plugins, Linear" });

    expect(text).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe(`${DEFAULT_BASE_URL}/audio/transcriptions`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer sk-test" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("prompt")).toBe("bb-plugins, Linear");
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.webm");
    expect(file.type).toBe("audio/webm;codecs=opus");
  });

  it("omits prompt and language when there is none, and Authorization when the key is empty", async () => {
    const { service } = await load({ baseUrl: "http://whisper.local:8080/v1" });
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        captured = init;
        return jsonResponse({ text: "ok" });
      }),
    );

    await service.transcribe!(audio(), { signal: signal(), hint: null });

    expect(captured!.headers).toEqual({});
    const form = captured!.body as FormData;
    expect(form.get("prompt")).toBeNull();
    expect(form.get("language")).toBeNull();
  });

  it("appends the path to a custom endpoint and strips its trailing slash", async () => {
    const { service } = await load({ baseUrl: "https://api.groq.com/openai/v1/" });
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (requested: string | URL) => {
        url = String(requested);
        return jsonResponse({ text: "ok" });
      }),
    );
    await service.transcribe!(audio(), { signal: signal(), hint: null });
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("passes Chrome webm and Safari m4a with the matching filename", async () => {
    expect(audioFileName(new File([new Uint8Array([1])], "voice", { type: "audio/webm;codecs=opus" }))).toBe("voice.webm");
    expect(audioFileName(new File([new Uint8Array([1])], "voice.mp4", { type: "audio/mp4" }))).toBe("voice.m4a");
    expect(audioFileName(new File([new Uint8Array([1])], "memo.opus", { type: "" }))).toBe("memo.opus");
    expect(audioFileName(new File([new Uint8Array([1])], "memo", { type: "" }))).toBe("memo");
  });

  it("refuses a recording over 25 MB before sending anything", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const big = new File([new Uint8Array(MAX_AUDIO_BYTES + 1)], "big.webm", { type: "audio/webm" });

    await expect(service.transcribe!(big, { signal: signal(), hint: null })).rejects.toThrow(/25 MB/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an abort without retrying", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const controller = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          const requestSignal = init!.signal!;
          if (requestSignal.aborted) return abort();
          requestSignal.addEventListener("abort", abort);
          fetchStarted();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = service.transcribe!(audio(), { signal: controller.signal, hint: null });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on 429 and 5xx and succeeds", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const serverError = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ text: "ok" }));
    vi.stubGlobal("fetch", serverError);
    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).resolves.toBe("ok");
    expect(serverError).toHaveBeenCalledTimes(2);
  });

  it("stops after the one retry when the second answer is still 429", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const fetchMock = vi.fn(async () => new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).rejects.toThrow(/HTTP 429/u);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a 200 reply that has no text field", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ transcript: "oops" })));

    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).rejects.toThrow(
      /without a text field/u,
    );
  });

  it("does not retry a 400", async () => {
    const { service } = await load({ apiKey: "sk-test" });
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).rejects.toThrow(/HTTP 400/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the status and endpoint and never the key in a 401", async () => {
    const key = "sk-secret-12345";
    const { service } = await load({ apiKey: key });
    const body = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401 })));

    let error: Error | undefined;
    try {
      await service.transcribe!(audio(), { signal: signal(), hint: null });
    } catch (thrown) {
      error = thrown as Error;
    }

    expect(error!.message).toContain("HTTP 401");
    expect(error!.message).toContain(`${DEFAULT_BASE_URL}/audio/transcriptions`);
    expect(error!.message).not.toContain(key);
  });

  it("logs one line per call with duration, bytes and status, never the transcript", async () => {
    const { host, service } = await load({ apiKey: "sk-test" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ text: "the secret transcript" })));

    await service.transcribe!(audio(7), { signal: signal(), hint: null });

    const info = host.harness.inspection.logEntries.filter((entry) => entry.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]!.message).toContain("HTTP 200");
    expect(info[0]!.message).toContain("7 bytes");
    expect(info[0]!.message).not.toContain("the secret transcript");
  });

  it("rejects a configured-empty call rather than posting", async () => {
    const { service } = await load({ baseUrl: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(service.transcribe!(audio(), { signal: signal(), hint: null })).rejects.toThrow(
      NOT_CONFIGURED_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("redaction", () => {
  it("redacts credential-shaped runs and clips", () => {
    expect(redactLine("Authorization: Bearer abcdef")).toBe("Authorization: Bearer [redacted]");
    expect(redactLine("x".repeat(ERROR_BODY_CHARS + 50))).toHaveLength(ERROR_BODY_CHARS + 1);
  });

  it("strips the configured key from the 200-character excerpt", () => {
    const key = "sk-live-abcdefghijklmnop";
    const body = `{"error":{"message":"Invalid API key: ${key}"}}`;
    const excerpt = errorExcerpt(body, key);
    expect(excerpt).toContain("[redacted]");
    expect(excerpt).not.toContain(key);
  });
});
