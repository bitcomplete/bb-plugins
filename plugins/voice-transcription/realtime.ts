/**
 * Realtime (voice-to-voice) support for the voice-transcription plugin.
 *
 * The plugin's own key is only ever used on the server, in the request that
 * mints a short-lived ephemeral OpenAI client secret. The browser receives
 * that secret and connects straight to OpenAI over WebRTC; the standard key
 * never reaches the browser. Realtime exists only against OpenAI's own
 * endpoint — the transcription-only vendors have no equivalent — so the
 * plugin stays inert everywhere else.
 *
 * Everything here is pure policy and shaping, so it can be tested without a
 * network or a key. The route handlers in `server.ts` hold the state.
 */
import { DEFAULT_BASE_URL } from "./config.js";
import type { RealtimeSessionConfig, RealtimeTool, RealtimeToolReply } from "./realtime-shared.js";

/** The OpenAI model used when a caller does not name one. */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime";
/** The default spoken voice for model replies. */
export const DEFAULT_REALTIME_VOICE = "alloy";
/**
 * The model that transcribes the user's speech inside a Realtime session, so
 * the overlay can show the live transcript. Separate from the batch
 * transcription model above: Realtime has its own input-transcription model.
 */
export const REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
/** OpenAI's endpoint for minting an ephemeral Realtime client secret. */
export const REALTIME_CLIENT_SECRET_PATH = "/realtime/client_secrets";
/**
 * How long a minted client secret is valid. Kept short so a leaked secret
 * cannot be reused to open a second session; the WebRTC connection it
 * establishes is what lasts, and that is capped separately.
 */
export const REALTIME_SECRET_TTL_SECONDS = 60;
/**
 * The hard cap on one spoken session, on the order of twenty minutes. The
 * overlay counts down and closes itself; the server refuses a session that
 * outlives this even if the overlay is gone.
 */
export const REALTIME_SESSION_MAX_MS = 20 * 60 * 1000;
/** The most tools one session may declare. */
export const REALTIME_MAX_TOOLS = 32;
/** The most instruction characters one session may carry. */
export const REALTIME_MAX_INSTRUCTIONS_CHARS = 20_000;

/** A refusal the routes return with a status a caller can act on. */
export type RealtimeRefusal = { status: 400 | 403; message: string };

/** Realtime exists only against OpenAI's own endpoint. */
export function isOpenAIBaseUrl(raw: string): boolean {
  return raw.trim().replace(/\/+$/u, "") === DEFAULT_BASE_URL;
}

/**
 * Whether a Realtime session can be minted from these settings. `baseUrl`
 * must be OpenAI's and a key must be present; anything else refuses clearly.
 * The plugin's ordinary transcription is untouched by this.
 */
export function realtimeReadiness(values: {
  baseUrl: string;
  apiKey: string;
}): RealtimeRefusal | null {
  if (!isOpenAIBaseUrl(values.baseUrl)) {
    return {
      status: 400,
      message: `Realtime voice needs OpenAI's endpoint; set the endpoint to ${DEFAULT_BASE_URL}`,
    };
  }
  if (values.apiKey.trim() === "") {
    return {
      status: 403,
      message:
        "Realtime voice needs an OpenAI API key; set it in Settings → Plugins → Voice transcription",
    };
  }
  return null;
}

/** The model for one session: the caller's, else the plugin's default. */
export function realtimeModel(config: RealtimeSessionConfig): string {
  const model = config.model?.trim() ?? "";
  return model === "" ? DEFAULT_REALTIME_MODEL : model;
}

/** The voice for one session: the caller's, else the plugin's default. */
export function realtimeVoice(config: RealtimeSessionConfig): string {
  const voice = config.voice?.trim() ?? "";
  return voice === "" ? DEFAULT_REALTIME_VOICE : voice;
}

/**
 * The session length: the caller's request clamped to the plugin's cap, and
 * the cap itself when the caller named none.
 */
export function realtimeMaxMs(config: RealtimeSessionConfig): number {
  const requested = config.maxDurationMs;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return REALTIME_SESSION_MAX_MS;
  }
  return Math.min(Math.floor(requested), REALTIME_SESSION_MAX_MS);
}

/**
 * The body sent to OpenAI's client-secret endpoint. The ephemeral secret is
 * scoped to this session: its instructions, its tools and its voice, and it
 * expires shortly after it is minted.
 */
export function realtimeClientSecretBody(
  config: RealtimeSessionConfig,
): Record<string, unknown> {
  return {
    expires_after: { anchor: "created_at", seconds: REALTIME_SECRET_TTL_SECONDS },
    session: {
      type: "realtime",
      model: realtimeModel(config),
      instructions: config.instructions,
      tools: config.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      })),
      audio: {
        input: { transcription: { model: REALTIME_INPUT_TRANSCRIPTION_MODEL } },
        output: { voice: realtimeVoice(config) },
      },
    },
  };
}

/**
 * The ephemeral secret out of a client-secret reply, whichever shape OpenAI
 * returned (`{ value, expires_at }` or `{ client_secret: { value, expires_at } }`).
 * Only the ephemeral value is read; the standard key is never part of a reply
 * and is never looked for here.
 */
export function parseClientSecret(payload: unknown): {
  value: string;
  expiresAt: number;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("OpenAI returned a reply that is not an object");
  }
  const record = payload as Record<string, unknown>;
  const nested = record.client_secret;
  const source = (
    typeof nested === "object" && nested !== null ? nested : record
  ) as Record<string, unknown>;
  const value = source.value;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("OpenAI returned no ephemeral client secret");
  }
  const rawExpiry = source.expires_at;
  const expiresAt =
    typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : 0;
  return { value: value.trim(), expiresAt };
}

/** Every tool a session declared, by name, for validating a model's call. */
export function declaresTool(tools: RealtimeTool[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

/**
 * Normalise whatever an opener's tool handler returned into the tool route's
 * reply. The original contract is a plain string; the extended one is an
 * object with `output` and an optional `last` flag, which the overlay reads as
 * "let the in-flight response finish, then stop the session". Anything else is
 * stringified as before, so an opener that returns JSON data is unchanged.
 */
export function toolReply(result: unknown): RealtimeToolReply {
  if (typeof result === "string") return { output: result };
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (typeof record.output === "string") {
      return record.last === true
        ? { output: record.output, last: true }
        : { output: record.output };
    }
  }
  return { output: JSON.stringify(result ?? null) };
}
