// Voice transcription: a server-process voice-input service for bb that posts
// a recording to any OpenAI-compatible `/audio/transcriptions` endpoint. It
// runs entirely on the bb server, so it needs no primary machine, no bb
// account and no Codex login; the wire format is the one OpenAI, Groq,
// Mistral, OpenRouter, Fireworks and self-hosted Whisper servers all speak.
//
// bb owns the microphone and the composer; this plugin owns the request. The
// registration contract is `PluginAiServiceDeclaration` from
// `bb.experimental_aiServices` (bb desktop-v0.44.0 and later; plugin services
// are listed in Automatic since desktop-v0.45.0).
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginAiServiceStatus,
} from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeBaseUrl,
  resolveApiKey,
  settingDefaults,
  type Env,
} from "./config.js";
import {
  REALTIME_CLIENT_SECRET_PATH,
  REALTIME_MAX_INSTRUCTIONS_CHARS,
  REALTIME_MAX_TOOLS,
  REALTIME_SWEEP_INTERVAL_MS,
  declaresTool,
  parseClientSecret,
  realtimeClientSecretBody,
  realtimeMaxMs,
  realtimeModel,
  realtimeReadiness,
  realtimeVoice,
  toolReply,
} from "./realtime.js";
import {
  PLUGIN_ID,
  REALTIME_CLOSE_PATH,
  REALTIME_MINT_PATH,
  REALTIME_SIGNAL_CHANNEL,
  REALTIME_TOOL_PATH,
  type MintedRealtimeSession,
  type RealtimeSessionConfig,
} from "./realtime-shared.js";

export { DEFAULT_BASE_URL, DEFAULT_MODEL, PLUGIN_ID, normalizeBaseUrl };
/** Stable service id: the picker names it `voice-transcription:openai-compatible`. */
export const SERVICE_ID = "openai-compatible";
/** Appended to `baseUrl`; both carry no trailing slash. */
export const TRANSCRIBE_PATH = "/audio/transcriptions";
/** OpenAI's audio limit; refused before anything is sent. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** How much of a non-2xx body an error message carries. */
export const ERROR_BODY_CHARS = 200;
export const NOT_CONFIGURED_MESSAGE =
  "Set the endpoint and model in Settings → Plugins → Voice transcription";
export const MISSING_KEY_MESSAGE =
  "Set the API key in Settings → Plugins → Voice transcription";

/**
 * The RPC another plugin calls to open a Realtime session before its UI shows
 * the overlay. The browser-facing routes below mint and drive the session;
 * this is the one cross-plugin entry point. `toolHandler` names the caller's
 * own RPC method that the model's tool calls are forwarded to.
 */
const realtimeToolSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(2000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const realtimeSessionConfigSchema = z.object({
  instructions: z.string().min(1).max(REALTIME_MAX_INSTRUCTIONS_CHARS),
  tools: z.array(realtimeToolSchema).max(REALTIME_MAX_TOOLS),
  model: z.string().trim().min(1).max(100).optional(),
  voice: z.string().trim().min(1).max(40).optional(),
  maxDurationMs: z.number().int().positive().optional(),
  speaksFirst: z.boolean().optional(),
});

export const rpcContract = defineRpcContract({
  "realtime.open": {
    input: realtimeSessionConfigSchema.extend({
      toolHandler: z
        .object({ method: z.string().trim().min(1) })
        .nullable()
        .default(null),
      /**
       * The opener's own RPC method, called with the session id when the
       * session ends for any reason. Null means no handler.
       */
      onClose: z
        .object({ method: z.string().trim().min(1) })
        .nullable()
        .default(null),
    }),
    output: z.object({ sessionId: z.string(), maxDurationMs: z.number() }),
  },
});

/** A Realtime session that an opener asked for and the overlay has yet to take. */
type PendingRealtimeSession = {
  id: string;
  config: RealtimeSessionConfig;
  toolHandler: { pluginId: string; method: string } | null;
  /** The opener's own method called when the session ends, or null. */
  closeHandler: { pluginId: string; method: string } | null;
  createdAt: number;
  /** Set once a secret has been minted; null until then. */
  startedAt: number | null;
  /** True while a mint is in flight, so a concurrent mint is refused before it reaches OpenAI. */
  minting: boolean;
  maxMs: number;
};

/** A JSON object body, or null when the body is missing or not one. */
async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The settings form's descriptors, with the deployment's base URL and model
 * as defaults. The key has no default and is never read from the environment
 * here: it is resolved at use, in `status` and `transcribe`, so its value
 * never reaches the frontend. See `config.ts`.
 */
export function settingDescriptors(env: Env) {
  const defaults = settingDefaults(env);
  return {
    baseUrl: {
      type: "string",
      label: "Endpoint base URL",
      description:
        "No trailing slash; /audio/transcriptions is appended. Defaults to OpenAI; point it at Groq, Mistral, OpenRouter, Fireworks or a self-hosted Whisper server to use those. Unset, the server's VOICE_TRANSCRIPTION_BASE_URL is used when the deployment sets one.",
      default: defaults.baseUrl,
    },
    apiKey: {
      type: "string",
      label: "API key",
      description:
        "Sent only as `Authorization: Bearer` to the endpoint above, and never to the frontend. The same key mints short-lived Realtime client secrets when the endpoint is OpenAI's. Leave empty for a self-hosted server with no auth. Unset, the server's VOICE_TRANSCRIPTION_API_KEY is used when the deployment sets one.",
      secret: true,
    },
    model: {
      type: "string",
      label: "Model",
      description:
        "Passed through verbatim: gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1, whisper-large-v3-turbo, voxtral-mini-latest, … Unset, the server's VOICE_TRANSCRIPTION_MODEL is used when the deployment sets one.",
      default: defaults.model,
    },
    language: {
      type: "string",
      label: "Language",
      description:
        "ISO-639-1 code such as `en`. Empty lets the endpoint auto-detect.",
      default: "",
    },
  } as const;
}

/** The extensions a Whisper-family server reads to pick a decoder. */
const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

/** A credential-shaped run in an error body, for `redactLine`. */
const SECRET =
  /((?:authorization|token|secret|password|passwd|api[_-]?key|cookie|set-cookie)["']?\s*[:=]\s*["']?(?:bearer\s+)?|bearer\s+)([^\s"',;]+)/giu;

type SettingsValues = {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
};

/**
 * The upload's extension: the MIME type's when it names a known format
 * (`audio/webm;codecs=opus` → "webm", `audio/mp4` → "m4a"), otherwise the
 * recording's own name's.
 */
export function audioExtension(audio: File): string | null {
  const mime = audio.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = AUDIO_EXTENSION_BY_MIME[mime];
  if (byMime !== undefined) return byMime;
  const dot = audio.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : audio.name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/u.test(extension) ? extension : null;
}

/** The filename the multipart part carries, extension matched to the MIME type. */
export function audioFileName(audio: File): string {
  const stem = audio.name.replace(/\.[^./\\]+$/u, "") || "audio";
  const extension = audioExtension(audio);
  return extension === null ? stem : `${stem}.${extension}`;
}

/**
 * One line of an error body with obvious credentials replaced and its length
 * clipped. Everything that reaches a user or a log passes here.
 */
export function redactLine(line: string, max = ERROR_BODY_CHARS): string {
  const clean = line.replace(SECRET, "$1[redacted]");
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * The first `max` characters of a non-2xx body, with credential-shaped runs
 * redacted and the configured key removed. Vendors echo the key in a 401
 * body, and that body must never reach a user or a log.
 */
export function errorExcerpt(
  body: string,
  apiKey: string,
  max = ERROR_BODY_CHARS,
): string {
  const excerpt = redactLine(body.slice(0, max), max);
  const key = apiKey.trim();
  return key === "" ? excerpt : excerpt.split(key).join("[redacted]");
}

/** Whether the service can answer, from the settings alone; no network. */
export function statusFor(values: SettingsValues): PluginAiServiceStatus {
  const baseUrl = normalizeBaseUrl(values.baseUrl);
  const model = values.model.trim();
  if (baseUrl === "" || model === "") {
    return { ready: false, message: NOT_CONFIGURED_MESSAGE };
  }
  // An empty key is a self-hosted server's normal state, but against the
  // default OpenAI endpoint it only means unauthenticated traffic to OpenAI,
  // so Automatic must not pick it.
  if (values.apiKey.trim() === "" && baseUrl === DEFAULT_BASE_URL) {
    return { ready: false, message: MISSING_KEY_MESSAGE };
  }
  return { ready: true };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createVoiceTranscriptionPlugin(env: Env = process.env) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(settingDescriptors(env));

    async function status(): Promise<PluginAiServiceStatus> {
      const values = await settings.get();
      return statusFor({
        ...values,
        apiKey: resolveApiKey(values.apiKey, env) ?? "",
      });
    }

    async function transcribe(
      audio: File,
      { signal, hint }: { signal: AbortSignal; hint: string | null },
    ): Promise<string> {
      const values = await settings.get();
      const baseUrl = normalizeBaseUrl(values.baseUrl);
      const model = values.model.trim();
      if (baseUrl === "" || model === "") throw new Error(NOT_CONFIGURED_MESSAGE);
      if (audio.size > MAX_AUDIO_BYTES) {
        throw new Error(
          `Recordings over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB are too large for ${baseUrl}`,
        );
      }
      const apiKey = resolveApiKey(values.apiKey, env) ?? "";
      const language = values.language.trim();
      const file = new File([audio], audioFileName(audio), { type: audio.type });
      const form = new FormData();
      form.set("file", file);
      form.set("model", model);
      form.set("response_format", "json");
      if (hint !== null) form.set("prompt", hint);
      if (language !== "") form.set("language", language);
      const headers: Record<string, string> = {};
      if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
      const url = `${baseUrl}${TRANSCRIBE_PATH}`;

      const started = Date.now();
      // The first answer is used unless it is a rate limit or a server error
      // and the caller is still waiting; a timeout, an abort and every 4xx are
      // final. FormData is replayable, so a retry sends the same parts.
      let response = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal,
      });
      if (retryable(response.status) && !signal.aborted) {
        // Release the first body's socket before opening the retry.
        await response.body?.cancel();
        response = await fetch(url, {
          method: "POST",
          headers,
          body: form,
          signal,
        });
      }
      const durationMs = Date.now() - started;
      // One line per call: how long, how many bytes, what the endpoint said.
      // Never the audio and never the transcript.
      bb.log.info(
        `voice-transcription: ${url} answered HTTP ${response.status} in ${durationMs} ms for ${audio.size} bytes`,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Voice transcription failed: HTTP ${response.status} from ${url}: ${errorExcerpt(body, apiKey)}`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(
          `Voice transcription failed: ${url} returned a reply that is not JSON`,
        );
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("text" in payload) ||
        typeof (payload as { text: unknown }).text !== "string"
      ) {
        throw new Error(
          `Voice transcription failed: ${url} returned a reply without a text field`,
        );
      }
      return (payload as { text: string }).text.trim();
    }

    bb.experimental_aiServices.register({
      id: SERVICE_ID,
      displayName: "OpenAI-compatible",
      transcribe,
      status,
    });

    // ---- realtime voice ---------------------------------------------------
    // An opener (another plugin's backend) calls `realtime.open`; the server
    // publishes a signal, and the app-wide overlay in `app.tsx` mints a
    // short-lived ephemeral secret and connects straight to OpenAI. The
    // plugin's own key is used only in the server's request to OpenAI and
    // never reaches the browser. Nothing is opened against a non-OpenAI
    // endpoint or without a key: `open` refuses, so no signal is published
    // and the overlay stays inert. A session is capped at `maxMs` and is
    // dropped when the overlay closes it.
    const realtimeSessions = new Map<string, PendingRealtimeSession>();

    async function realtimeKey(): Promise<{ baseUrl: string; apiKey: string }> {
      const values = await settings.get();
      return { baseUrl: values.baseUrl, apiKey: resolveApiKey(values.apiKey, env) ?? "" };
    }

    /**
     * End one session: take it out of the map first, so a second end (the
     * overlay's close racing the cap sweep, say) finds nothing, then tell the
     * opener at most once. The RPC is fired and not awaited: awaiting another
     * plugin's method here can deadlock (the opener may hold a lock it needs for
     * its own `realtime.open`), and the session is over whatever the handler
     * does with the news.
     */
    function endRealtimeSession(id: string): void {
      const session = realtimeSessions.get(id);
      if (session === undefined) return;
      realtimeSessions.delete(id);
      if (session.closeHandler === null) return;
      void bb.sdk.plugins
        .callRpc({
          pluginId: session.closeHandler.pluginId,
          method: session.closeHandler.method,
          input: { sessionId: id },
          outputSchema: z.unknown(),
        })
        .catch((error: unknown) => {
          bb.log.warn(
            `voice-transcription: close handler for session ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    /**
     * Reap every session past its cap through `endRealtimeSession`, so a session
     * abandoned by a closed tab is reported even when nobody opens another one.
     */
    function sweepRealtimeSessions(nowMs = Date.now()): void {
      for (const [id, session] of [...realtimeSessions]) {
        const since = session.startedAt ?? session.createdAt;
        if (nowMs - since > session.maxMs) endRealtimeSession(id);
      }
    }

    // The cap is enforced by the overlay's own clock, but a tab that closes or
    // a model that goes quiet has no clock; this sweep is the guarantee that
    // every session ends and its opener hears about it.
    bb.background.service("realtime-sweep", {
      start(signal) {
        sweepRealtimeSessions();
        return new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            sweepRealtimeSessions();
          }, REALTIME_SWEEP_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearInterval(timer);
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    bb.rpc.register(rpcContract, {
      async "realtime.open"(input, { experimental_caller: caller }) {
        // The overlay is opened on behalf of a plugin that will answer the
        // model's tool calls; a browser client has no tool handler to name.
        if (caller.kind !== "plugin") {
          throw new Error("realtime.open is called by another plugin, not the browser");
        }
        const { baseUrl, apiKey } = await realtimeKey();
        const refusal = realtimeReadiness({ baseUrl, apiKey });
        if (refusal !== null) throw new Error(refusal.message);
        // The background sweep is the guarantee; this eager pass only keeps the
        // map small, and is not awaited so a stale session's handler cannot
        // block the new open.
        sweepRealtimeSessions(Date.now());
        const config: RealtimeSessionConfig = {
          instructions: input.instructions,
          tools: input.tools,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.voice !== undefined ? { voice: input.voice } : {}),
          ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
          ...(input.speaksFirst !== undefined ? { speaksFirst: input.speaksFirst } : {}),
        };
        const session: PendingRealtimeSession = {
          id: crypto.randomUUID(),
          config,
          // The handler is the caller's own RPC method, never one it names for
          // another plugin: the model's tool calls reach the opener, and only
          // the opener, under its own identity.
          toolHandler:
            input.toolHandler === null
              ? null
              : { pluginId: caller.pluginId, method: input.toolHandler.method },
          // The close handler is the same rule: the opener's own method, under
          // its own identity, called when the session ends.
          closeHandler:
            input.onClose === null
              ? null
              : { pluginId: caller.pluginId, method: input.onClose.method },
          createdAt: Date.now(),
          startedAt: null,
          minting: false,
          maxMs: realtimeMaxMs(config),
        };
        realtimeSessions.set(session.id, session);
        bb.realtime.publish(REALTIME_SIGNAL_CHANNEL, { sessionId: session.id });
        return { sessionId: session.id, maxDurationMs: session.maxMs };
      },
    });

    bb.http.route(
      "POST",
      REALTIME_MINT_PATH,
      async (c: Context) => {
        const body = await readJsonObject(c);
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
        if (sessionId === "") return c.json({ error: "A sessionId is required" }, 400);
        const { baseUrl, apiKey } = await realtimeKey();
        const refusal = realtimeReadiness({ baseUrl, apiKey });
        if (refusal !== null) return c.json({ error: refusal.message }, refusal.status);
        const session = realtimeSessions.get(sessionId);
        if (session === undefined) {
          return c.json({ error: "That voice session has ended; start a new one" }, 404);
        }
        const now = Date.now();
        if (session.startedAt !== null) {
          return c.json({ error: "That voice session already has a client secret" }, 409);
        }
        // Claim the session before the OpenAI round trip. The signal reaches
        // every client at once, so two mints can arrive together; only the
        // one that claims it may call OpenAI. The claim is released on every
        // failure path so a retry can still mint.
        if (session.minting) {
          return c.json({ error: "That voice session is already being minted" }, 409);
        }
        if (now - session.createdAt > session.maxMs) {
          endRealtimeSession(sessionId);
          return c.json({ error: "That voice session expired before it started" }, 409);
        }
        session.minting = true;
        try {
          const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
          const url = `${normalizedBaseUrl}${REALTIME_CLIENT_SECRET_PATH}`;
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(realtimeClientSecretBody(session.config)),
            });
          } catch (error) {
            bb.log.warn(
              `voice-transcription: realtime mint could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return c.json({ error: `Could not reach ${url}` }, 502);
          }
          if (!response.ok) {
            const text = await response.text();
            bb.log.warn(
              `voice-transcription: realtime mint answered HTTP ${response.status} from ${url}`,
            );
            return c.json(
              { error: `OpenAI refused the session: HTTP ${response.status}: ${errorExcerpt(text, apiKey)}` },
              502,
            );
          }
          let secret: { value: string; expiresAt: number };
          try {
            secret = parseClientSecret(await response.json());
          } catch (error) {
            return c.json(
              { error: error instanceof Error ? error.message : "OpenAI returned an unexpected reply" },
              502,
            );
          }
          // The overlay may have closed the session while the mint was in
          // flight; the secret is then discarded with it.
          if (realtimeSessions.get(sessionId) !== session) {
            return c.json({ error: "That voice session has ended; start a new one" }, 404);
          }
          session.startedAt = Date.now();
          bb.log.info(
            `voice-transcription: minted a Realtime client secret for session ${session.id} (expires ${secret.expiresAt})`,
          );
          const minted: MintedRealtimeSession = {
            value: secret.value,
            expiresAt: secret.expiresAt,
            model: realtimeModel(session.config),
            voice: realtimeVoice(session.config),
            instructions: session.config.instructions,
            tools: session.config.tools,
            maxDurationMs: session.maxMs,
            speaksFirst: session.config.speaksFirst === true,
          };
          return c.json(minted, 200);
        } finally {
          session.minting = false;
        }
      },
      { auth: "local" },
    );

    bb.http.route(
      "POST",
      REALTIME_TOOL_PATH,
      async (c: Context) => {
        const body = await readJsonObject(c);
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
        const callId = typeof body?.callId === "string" ? body.callId : "";
        const name = typeof body?.name === "string" ? body.name : "";
        const args = typeof body?.arguments === "string" ? body.arguments : "{}";
        if (sessionId === "" || name === "") {
          return c.json({ error: "sessionId and name are required" }, 400);
        }
        const session = realtimeSessions.get(sessionId);
        if (session === undefined) {
          return c.json({ error: "That voice session has ended; start a new one" }, 404);
        }
        if (session.startedAt !== null && Date.now() - session.startedAt > session.maxMs) {
          endRealtimeSession(sessionId);
          return c.json({ error: "That voice session has reached its time limit" }, 409);
        }
        if (!declaresTool(session.config.tools, name)) {
          return c.json({ error: `This session did not declare a tool named ${name}` }, 422);
        }
        if (session.toolHandler === null) {
          return c.json({ error: "This session has no tool handler attached" }, 409);
        }
        let result: unknown;
        try {
          result = await bb.sdk.plugins.callRpc({
            pluginId: session.toolHandler.pluginId,
            method: session.toolHandler.method,
            input: { sessionId, callId, name, arguments: args },
            outputSchema: z.unknown(),
          });
        } catch (error) {
          bb.log.warn(
            `voice-transcription: tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return c.json(
            { error: `The tool handler failed: ${error instanceof Error ? error.message : String(error)}` },
            502,
          );
        }
        return c.json(
          toolReply(result),
          200,
        );
      },
      { auth: "local" },
    );

    bb.http.route(
      "POST",
      REALTIME_CLOSE_PATH,
      async (c: Context) => {
        const body = await readJsonObject(c);
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
        if (sessionId === "") return c.json({ error: "A sessionId is required" }, 400);
        // One end path for every kind of end: take the session out, then tell
        // the opener at most once. The handler is not awaited: the session is
        // over whatever the opener does with the news.
        endRealtimeSession(sessionId);
        return c.json({ ok: true }, 200);
      },
      { auth: "local" },
    );
  };
}

export default createVoiceTranscriptionPlugin();
