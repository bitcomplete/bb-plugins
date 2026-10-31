// The subscriber side of bb-gate-hooks for Slack (bb-gate/docs/hooks.md,
// "Slack agent"): one SSE stream, carrying `event: session` wakes for the one
// server bound to a Slack user. A wake carries an opaque `capability`, and the
// session it names is leased on `POST /v1/subscribe`, so ownership and reply
// rights survive a restart or a gap longer than the route window. Slack has no
// doorbells. The connection id from the hello is also what the sign-in
// start/exchange and the reply/status/title calls name, so this module owns
// them all and the pod never holds a Slack credential beyond the developer's
// own sign-in token.
//
// Everything that touches the world is injected: fetch, the clock, the token,
// and what to do on a wake. The token goes into one request body and nowhere
// else: not a log line, not an error message.
import { z } from "zod";

export const HOOKS_URL_ENV = "BB_HOOKS_URL";
export const SOURCE = "slack";

// ---- server-sent events ----------------------------------------------------

export type SseEvent = { event: string; data: string; id: string | null };

/**
 * Incremental parser for text/event-stream: feed it chunks, get the events
 * that completed. Comment lines (`: keepalive`) are dropped, a field's single
 * leading space is stripped, several `data:` lines join with newlines, and a
 * blank line dispatches. `retry:` is ignored; reconnect timing is ours.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length > 0 || this.event !== "") out.push({ event: this.event === "" ? "message" : this.event, data: this.data.join("\n"), id: this.id });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
    }
    return out;
  }
}

export class StreamIdleError extends Error {
  constructor(idleMs: number) {
    super(`no bytes from bb-gate-hooks for ${Math.round(idleMs / 1000)} s`);
    this.name = "StreamIdleError";
  }
}

/** The service guarantees a keepalive every 20 s; this much silence means the stream is dead. */
export const STREAM_IDLE_MS = 60_000;

/**
 * The events of a stream body, until it ends or the signal aborts. A stream
 * silent for `idleMs` (keepalives included: any bytes count) throws
 * StreamIdleError, because a half-open connection would otherwise look live.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs = STREAM_IDLE_MS): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      let idle: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<never>((_, reject) => {
        idle = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timedOut]);
      } catch (error) {
        if (error instanceof StreamIdleError) cancel();
        throw error;
      } finally {
        if (idle !== null) clearTimeout(idle);
      }
      if (chunk.done) break;
      for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) yield event;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// ---- the wire shapes ---------------------------------------------------------

export const helloSchema = z.object({ connection: z.string().min(1), leaseSeconds: z.number().positive().optional() });

/** `POST /v1/identify`'s answer: who the token belongs to. Slack has no teams. */
export const identifyResponseSchema = z.object({
  user: z.object({ id: z.string(), name: z.string() }).loose(),
  teams: z.array(z.string()).default([]),
  rejected: z.array(z.object({ kind: z.string(), id: z.string(), reason: z.string() }).loose()).default([]),
  expiresAt: z.string().optional(),
});
export type IdentifyResponse = z.infer<typeof identifyResponseSchema>;

const personWire = z.object({ id: z.string().max(200), name: z.string().max(200) }).loose();

/**
 * One attachment's metadata on a Slack wake: the file's id, its display name
 * (the gate falls back to the title), its mime type and its size in bytes.
 * Metadata only — Step 1 fetches nothing.
 */
export const sessionFileSchema = z
  .object({
    id: z.string().max(200).default(""),
    name: z.string().max(1000).default(""),
    mimeType: z.string().max(200).default(""),
    size: z.number().int().nonnegative().default(0),
  })
  .loose();
export type SessionFile = z.infer<typeof sessionFileSchema>;

/** `event: session` as the service sends it (bb-gate/docs/hooks.md). */
export const sessionEventSchema = z
  .object({
    source: z.literal(SOURCE),
    /** Empty on a `block_action` wake: there is no conversation. */
    session: z.string().max(200),
    /**
     * The opaque proof that this session belongs to `owner`, echoed to
     * `POST /v1/subscribe` to lease it. Empty (and omitted) when `session` is
     * empty, as on a `block_action` wake. Secret-like: it is never logged and
     * never put in a wake's text.
     */
    capability: z.string().max(2000).default(""),
    action: z.enum(["message", "edited", "deleted", "assistant_thread_started", "assistant_thread_context_changed", "block_action"]),
    /** True for a channel app_mention, false for a DM or assistant-thread event. */
    mention: z.boolean().default(false),
    /**
     * True when the message addressed bb directly (a DM or a channel mention),
     * false for an untagged reply in a channel thread bb already follows. A
     * missing field (an older service) is treated as tagged, so the plugin
     * keeps requiring a reply as before.
     */
    tagged: z.boolean().default(true),
    channel: z.string().min(1).max(200),
    /**
     * The channel the user was viewing, on an assistant context change; "" on
     * every other wake. It is the DM's channel (`channel`) that the assistant
     * thread lives in, so this is the only place the viewed channel appears.
     */
    contextChannel: z.string().max(200).default(""),
    /** Empty on a `block_action` wake: there is no thread. */
    thread: z.string().max(200).default(""),
    asker: personWire,
    owner: personWire,
    fromOwner: z.boolean(),
    routedAs: z.string().max(100).default("owner"),
    /** The clicked Block Kit action on a `block_action` wake; empty otherwise. */
    actionId: z.string().max(200).default(""),
    /** The clicked action's value on a `block_action` wake; empty otherwise. */
    value: z.string().max(2000).default(""),
    /**
     * Slack's capability to replace the ephemeral prompt a `block_action` came
     * from (ephemeral messages cannot be updated with `chat.update`). It is
     * secret-like: it reaches this pod and is never logged.
     */
    responseUrl: z.string().max(2000).default(""),
    comment: z.object({ text: z.string(), untrusted: z.boolean() }).loose(),
    /**
     * The message's own Slack timestamp, the key the plugin matches an edit or
     * deletion to the wake it delivered. Set on every `message`, `edited` and
     * `deleted` wake; empty (and omitted) on every other wake.
     */
    ts: z.string().max(200).default(""),
    /**
     * The message's attachments, metadata only. An older service sends no
     * field, which is read as none; nothing is fetched either way.
     */
    files: z.array(sessionFileSchema).max(1000).default([]),
    at: z.string().max(100).default(""),
  })
  .loose();
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** The service refuses a reply body larger than this. */
export const REPLY_BODY_MAX_BYTES = 32 * 1024;
/** Status and title are capped at 256 bytes. */
export const STATUS_MAX_BYTES = 256;

export class HooksRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The answer's body, for the one 404 that means something (`{"error":"unknown-connection"}`). Never the request. */
    readonly body: string = "",
  ) {
    super(message);
    this.name = "HooksRequestError";
  }

  /** The `error` code in the answer's JSON body, or null when it has none. */
  get code(): string | null {
    try {
      const error = (JSON.parse(this.body) as { error?: unknown }).error;
      return typeof error === "string" ? error : null;
    } catch {
      return null;
    }
  }

  /** The service forgot the connection the request named; any other 404 is a wrong URL. */
  get unknownConnection(): boolean {
    return this.status === 404 && this.code === "unknown-connection";
  }
}

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

async function postJson<T>(fetchImpl: FetchLike, baseUrl: string, path: string, body: unknown, schema: z.ZodType<T>, what: string, signal: AbortSignal): Promise<T> {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to ${what}`, response.status, await response.text().catch(() => ""));
  return schema.parse(await response.json());
}

async function getJson<T>(fetchImpl: FetchLike, baseUrl: string, path: string, schema: z.ZodType<T>, what: string, signal: AbortSignal): Promise<T> {
  const response = await fetchImpl(new URL(path, baseUrl), { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to ${what}`, response.status, await response.text().catch(() => ""));
  return schema.parse(await response.json());
}

/**
 * POST /v1/identify: prove which Slack user this server acts for, with the
 * developer's own sign-in token. `teams` is empty (Slack has no teams). The
 * token goes into the body and nowhere else.
 */
export function identify(fetchImpl: FetchLike, baseUrl: string, connection: string, token: string, signal: AbortSignal): Promise<IdentifyResponse> {
  return postJson(fetchImpl, baseUrl, "/v1/identify", { connection, source: SOURCE, token, teams: [] }, identifyResponseSchema, "identify", signal);
}

/** The service refuses more watches than this in one call (413). */
export const SUBSCRIBE_BATCH = 100;

/** A session lease: the owner of record for one Slack conversation. */
export type SessionLease = { kind: "session"; id: string; capability: string };

/** `POST /v1/subscribe`'s answer. */
export const subscribeResponseSchema = z.object({
  leases: z.array(z.object({ kind: z.string(), id: z.string() }).loose()).default([]),
  rejected: z.array(z.object({ kind: z.string(), id: z.string(), reason: z.string() }).loose()).default([]),
});
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
/** A lease the service refused; `reason` is `owned` or `forbidden`. */
export type Rejection = SubscribeResponse["rejected"][number];

/**
 * POST /v1/subscribe for these session leases, in batches the service
 * accepts. No token is needed and none is read: the connection's bound Slack
 * user is the subject, and each capability must verify for that user. The
 * capability goes into the body and nowhere else: never a log line, never an
 * error message.
 */
export async function subscribe(fetchImpl: FetchLike, baseUrl: string, connection: string, leases: SessionLease[], signal: AbortSignal): Promise<SubscribeResponse> {
  const merged: SubscribeResponse = { leases: [], rejected: [] };
  for (let i = 0; i < leases.length; i += SUBSCRIBE_BATCH) {
    const watches = leases.slice(i, i + SUBSCRIBE_BATCH).map(({ kind, id, capability }) => ({ kind, id, capability }));
    const response = await fetchImpl(new URL("/v1/subscribe", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ connection, source: SOURCE, watches }),
      signal,
    });
    if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to subscribe`, response.status, await response.text().catch(() => ""));
    const parsed = subscribeResponseSchema.parse(await response.json());
    merged.leases.push(...parsed.leases);
    merged.rejected.push(...parsed.rejected);
  }
  return merged;
}

/** POST /v1/slack/signin/start: mint a state and an authorize URL for this connection. */
export const signinStartResponseSchema = z.object({ authorizeUrl: z.string().url(), state: z.string().min(1) });
export type SigninStartResponse = z.infer<typeof signinStartResponseSchema>;

export function signinStart(fetchImpl: FetchLike, baseUrl: string, connection: string, signal: AbortSignal): Promise<SigninStartResponse> {
  return postJson(fetchImpl, baseUrl, "/v1/slack/signin/start", { connection }, signinStartResponseSchema, "the Slack sign-in start", signal);
}

/** POST /v1/slack/signin/exchange: swap the callback's code for the user token. */
export const signinExchangeResponseSchema = z.object({ token: z.string().min(1) });

export function signinExchange(fetchImpl: FetchLike, baseUrl: string, connection: string, state: string, code: string, signal: AbortSignal): Promise<{ token: string }> {
  return postJson(fetchImpl, baseUrl, "/v1/slack/signin/exchange", { connection, state, code }, signinExchangeResponseSchema, "the Slack sign-in exchange", signal);
}

/** GET /v1/slack/bot/channels: the ids of the channels the app's bot is in. */
export const botChannelsResponseSchema = z.object({ channels: z.array(z.string()) });
export type BotChannelsResponse = z.infer<typeof botChannelsResponseSchema>;

export function fetchBotChannels(fetchImpl: FetchLike, baseUrl: string, signal: AbortSignal): Promise<BotChannelsResponse> {
  return getJson(fetchImpl, baseUrl, "/v1/slack/bot/channels", botChannelsResponseSchema, "the bot channel list", signal);
}

/**
 * POST /v1/slack/bot/join: have the app's bot join a public channel, so the
 * developer need not /invite it from Slack. The service joins with the bot
 * token it holds; the pod sends only its connection id and the channel id.
 * Throws HooksRequestError with `code` "private-channel", "channel-not-found",
 * "archived", "missing-scope" or "channel-restricted" (the channel does not
 * let the app post) when Slack refused for a reason the settings page can
 * explain.
 */
export function joinChannel(fetchImpl: FetchLike, baseUrl: string, connection: string, channel: string, signal: AbortSignal): Promise<{ ok?: boolean }> {
  return postJson(fetchImpl, baseUrl, "/v1/slack/bot/join", { connection, channel }, okSchema, "the Slack channel join", signal);
}

export type SessionReply = { session: string; connection: string; text: string };
export type SessionStatus = { session: string; connection: string; status: string };
export type SessionTitle = { session: string; connection: string; title: string };

const okSchema = z.object({ ok: z.boolean().optional() }).loose();

/**
 * The answer to a reply. `ephemeral` is present and true when the channel
 * does not let bb post, so the text was shown only to the connection's own
 * bound user; `reason` names why (`channel-restricted`). An older service
 * omits both fields, which is a plain in-channel post.
 */
export const replyResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    ephemeral: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .loose();
export type ReplyResponse = z.infer<typeof replyResponseSchema>;

export function postMessage(fetchImpl: FetchLike, baseUrl: string, reply: SessionReply, signal: AbortSignal): Promise<ReplyResponse> {
  return postJson(fetchImpl, baseUrl, `/v1/slack/sessions/${encodeURIComponent(reply.session)}/message`, { connection: reply.connection, text: reply.text }, replyResponseSchema, "the Slack reply", signal);
}

export function setStatus(fetchImpl: FetchLike, baseUrl: string, status: SessionStatus, signal: AbortSignal): Promise<{ ok?: boolean }> {
  return postJson(fetchImpl, baseUrl, `/v1/slack/sessions/${encodeURIComponent(status.session)}/status`, { connection: status.connection, status: status.status }, okSchema, "the Slack status", signal);
}

export function setTitle(fetchImpl: FetchLike, baseUrl: string, title: SessionTitle, signal: AbortSignal): Promise<{ ok?: boolean }> {
  return postJson(fetchImpl, baseUrl, `/v1/slack/sessions/${encodeURIComponent(title.session)}/title`, { connection: title.connection, title: title.title }, okSchema, "the Slack title", signal);
}

export type SessionEphemeral = {
  connection: string;
  /** The channel the wake delivered to this connection. */
  channel: string;
  /** The connection's own bound user; naming anyone else is refused. */
  user: string;
  text: string;
  /** Optional Block Kit blocks; `text` is the fallback. */
  blocks?: unknown[];
};

/**
 * POST /v1/slack/ephemeral: post as the app an ephemeral message visible only
 * to the connection's own bound user, in a channel a wake delivered here.
 */
export function postEphemeral(fetchImpl: FetchLike, baseUrl: string, ephemeral: SessionEphemeral, signal: AbortSignal): Promise<{ ok?: boolean }> {
  const body: Record<string, unknown> = { connection: ephemeral.connection, channel: ephemeral.channel, user: ephemeral.user, text: ephemeral.text };
  if (ephemeral.blocks !== undefined) body.blocks = ephemeral.blocks;
  return postJson(fetchImpl, baseUrl, "/v1/slack/ephemeral", body, okSchema, "the Slack ephemeral message", signal);
}

// ---- the loop ----------------------------------------------------------------

export interface HooksTiming {
  /** Identify again at this fraction of the identity's life. */
  renewFraction: number;
  /** Identity length assumed until the hello says otherwise. */
  defaultLeaseMs: number;
  /** Reconnect backoff, doubled from the first to the cap. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Silence on the stream that counts as a dead connection. */
  idleMs: number;
}

export const DEFAULT_TIMING: HooksTiming = {
  renewFraction: 0.5,
  defaultLeaseMs: 60 * 60 * 1000,
  backoffMinMs: 1000,
  backoffMaxMs: 60 * 1000,
  idleMs: STREAM_IDLE_MS,
};

export interface HooksLoopDeps {
  fetch: FetchLike;
  baseUrl: string;
  now: () => number;
  log: { info(message: string): void; warn(message: string): void };
  /** The developer's sign-in token, or null when nobody is signed in. */
  identity: () => string | null;
  /** An `event: session` wake routed to this server. Never awaited by the stream. */
  onSession: (event: SessionEvent) => void;
  /** The service's answer to an identify, for the settings view and logs. */
  onIdentified?: (identity: IdentifyResponse) => void;
  /** Everything to hold a session lease for right now: one per live bb thread. */
  leases?: () => SessionLease[];
  /** Leases the service refused. The caller decides what each reason means. */
  onRejected?: (rejections: Rejection[]) => void;
  /** A new connection's hello, for housekeeping that belongs to a fresh stream. */
  onHello?: () => void;
  /** The service refused this token (401): it is bad, expired or revoked, so sign in again. */
  onTokenRefused?: (token: string) => void;
  timing?: Partial<HooksTiming>;
}

export type HooksState = { state: "stopped" | "connecting" | "connected"; since: number };

export interface HooksLoop {
  /** Run until the signal aborts. Never throws for a network reason; it retries. */
  run(signal: AbortSignal): Promise<void>;
  /** Whether a connection is up. */
  readonly connected: boolean;
  /** The connection id from the last hello, or null while connecting. */
  readonly connectionId: string | null;
  /** What the loop is doing; for the settings view. */
  state(): HooksState;
  /** Called whenever the state changes. */
  onStateChange(listener: () => void): void;
  /** Identify again now, if there is a connection and a token. */
  reidentify(): Promise<void>;
  /** Drop the current connection and reconnect, so the service forgets the identity bound to it. */
  reconnect(): void;
  /** Post a reply on a Slack session. Throws HooksRequestError, or an Error when there is no connection. */
  reply(session: string, text: string, signal: AbortSignal): Promise<ReplyResponse>;
  /** Set the assistant thinking status on a Slack session. */
  status(session: string, status: string, signal: AbortSignal): Promise<void>;
  /** Set the assistant conversation title on a Slack session. */
  title(session: string, title: string, signal: AbortSignal): Promise<void>;
  /** Post an ephemeral message, visible only to the connection's own bound user. */
  ephemeral(ephemeral: Omit<SessionEphemeral, "connection">, signal: AbortSignal): Promise<void>;
  /** Have the bot join a public channel. Throws HooksRequestError, or an Error when there is no connection. */
  joinChannel(channel: string, signal: AbortSignal): Promise<void>;
  /** Mint a sign-in URL for this connection. Throws when there is no connection. */
  signinStart(signal: AbortSignal): Promise<SigninStartResponse>;
  /** Complete a sign-in flow on the connection that started it. */
  signinExchange(connection: string, state: string, code: string, signal: AbortSignal): Promise<{ token: string }>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createHooksLoop(deps: HooksLoopDeps): HooksLoop {
  const timing: HooksTiming = { ...DEFAULT_TIMING, ...deps.timing };
  let connection: string | null = null;
  let leaseMs = timing.defaultLeaseMs;
  /** Aborting this drops the current stream so the outer loop reconnects. */
  let stream: AbortController | null = null;
  let identifyUnsupportedLogged = false;
  let wrongUrlLogged = false;

  let state: HooksState["state"] = "stopped";
  let stateSince = deps.now();
  const stateListeners = new Set<() => void>();
  function setState(next: HooksState["state"]): void {
    if (next === state) return;
    state = next;
    stateSince = deps.now();
    for (const listener of stateListeners) listener();
  }

  function requireConnection(): string {
    if (connection === null) throw new Error("This bb server is not connected to bb-gate-hooks right now (it is reconnecting). Try again in a minute.");
    return connection;
  }

  /**
   * Prove who this server acts for, on the current connection. Never throws:
   * a failure costs wakes until the next hello or renewal.
   */
  async function identifyNow(signal: AbortSignal): Promise<void> {
    if (connection === null) return;
    const token = deps.identity();
    if (token === null || token === "") return;
    const current = connection;
    try {
      const result = await identify(deps.fetch, deps.baseUrl, current, token, signal);
      if (connection !== current) return;
      deps.onIdentified?.(result);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof HooksRequestError && error.status === 401) {
        // The token itself was refused: bad, expired or revoked. Tell the
        // caller so it can stop claiming to be signed in.
        deps.log.warn("bb-gate-hooks refused the Slack sign-in token; sign in again");
        deps.onTokenRefused?.(token);
        return;
      }
      if (error instanceof HooksRequestError && error.status === 404) {
        if (error.unknownConnection) {
          if (connection === current) {
            deps.log.warn("bb-gate-hooks forgot our connection; reconnecting");
            stream?.abort();
          }
          return;
        }
        if (!identifyUnsupportedLogged) {
          identifyUnsupportedLogged = true;
          deps.log.info("bb-gate-hooks has no /v1/identify, so Slack DMs are not routed to this server");
        }
        return;
      }
      deps.log.warn(`Slack identity failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Lease every live session on the current connection. A 404 means the
   * connection is gone and drops the stream. Never throws: a failed renewal
   * costs ownership until the next one, and the route table still routes.
   */
  async function leaseNow(signal: AbortSignal): Promise<void> {
    if (connection === null) return;
    // A lease is proved by the connection's bound Slack user, which identify
    // establishes; without a token there is nobody to lease for.
    const token = deps.identity();
    if (token === null || token === "") return;
    const leases = deps.leases?.() ?? [];
    if (leases.length === 0) return;
    const current = connection;
    try {
      const result = await subscribe(deps.fetch, deps.baseUrl, current, leases, signal);
      if (connection !== current) return;
      if (result.rejected.length > 0) deps.onRejected?.(result.rejected);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof HooksRequestError && error.status === 404) {
        if (error.unknownConnection) {
          if (connection === current) {
            deps.log.warn("bb-gate-hooks forgot our connection; reconnecting");
            stream?.abort();
          }
          return;
        }
        if (!wrongUrlLogged) {
          wrongUrlLogged = true;
          deps.log.warn(`${HOOKS_URL_ENV} looks wrong: ${deps.baseUrl} answers 404 to /v1/subscribe without naming the connection`);
        }
        return;
      }
      deps.log.warn(`Slack session lease failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Prove the identity and lease every live session. Identify runs first so
   * the lease has a bound user to prove against. Never throws: it runs from
   * timers and the hello.
   */
  async function renew(signal: AbortSignal): Promise<void> {
    await identifyNow(signal);
    await leaseNow(signal);
  }

  async function consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    try {
      for await (const event of readSse(body, signal, timing.idleMs)) {
        if (event.event === "hello") {
          const hello = helloSchema.safeParse(JSON.parse(event.data));
          if (!hello.success) {
            deps.log.warn("bb-gate-hooks sent a hello this plugin does not understand; reconnecting");
            return;
          }
          connection = hello.data.connection;
          setState("connected");
          leaseMs = hello.data.leaseSeconds === undefined ? timing.defaultLeaseMs : hello.data.leaseSeconds * 1000;
          deps.log.info(`Slack: connected to bb-gate-hooks as ${connection}`);
          deps.onHello?.();
          // Not awaited: wakes behind the hello must not wait for identify or
          // the leases. Identify runs first so the lease has a bound user.
          void renew(signal);
          if (renewTimer !== null) clearInterval(renewTimer);
          renewTimer = setInterval(() => void renew(signal), Math.max(1000, leaseMs * timing.renewFraction));
        } else if (event.event === "session") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          const session = sessionEventSchema.safeParse(parsed);
          if (session.success) deps.onSession(session.data);
          else deps.log.warn("bb-gate-hooks sent a Slack session event this plugin does not understand; dropped");
        }
      }
    } finally {
      if (renewTimer !== null) clearInterval(renewTimer);
      connection = null;
    }
  }

  return {
    get connected() {
      return connection !== null;
    },

    get connectionId() {
      return connection;
    },

    state() {
      return { state, since: stateSince };
    },

    onStateChange(listener) {
      stateListeners.add(listener);
    },

    async reidentify() {
      if (connection === null || stream === null) return;
      await renew(stream.signal);
    },

    reconnect() {
      stream?.abort();
    },

    async reply(session, text, signal) {
      return postMessage(deps.fetch, deps.baseUrl, { session, connection: requireConnection(), text }, signal);
    },

    async status(session, status, signal) {
      await setStatus(deps.fetch, deps.baseUrl, { session, connection: requireConnection(), status }, signal);
    },

    async title(session, title, signal) {
      await setTitle(deps.fetch, deps.baseUrl, { session, connection: requireConnection(), title }, signal);
    },

    async ephemeral(ephemeral, signal) {
      await postEphemeral(deps.fetch, deps.baseUrl, { connection: requireConnection(), ...ephemeral }, signal);
    },

    async joinChannel(channel, signal) {
      await joinChannel(deps.fetch, deps.baseUrl, requireConnection(), channel, signal);
    },

    async signinStart(signal) {
      return signinStart(deps.fetch, deps.baseUrl, requireConnection(), signal);
    },

    async signinExchange(connection, state, code, signal) {
      return signinExchange(deps.fetch, deps.baseUrl, connection, state, code, signal);
    },

    async run(signal) {
      let backoff = timing.backoffMinMs;
      setState("connecting");
      while (!signal.aborted) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        stream = controller;
        try {
          const response = await deps.fetch(new URL("/v1/events", deps.baseUrl), { headers: { accept: "text/event-stream" }, signal: controller.signal });
          if (!response.ok || response.body === null) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to the event stream`, response.status);
          backoff = timing.backoffMinMs;
          await consume(response.body, controller.signal);
          if (!signal.aborted) deps.log.warn("bb-gate-hooks event stream ended; reconnecting");
        } catch (error) {
          if (!signal.aborted && !controller.signal.aborted) deps.log.warn(`bb-gate-hooks event stream: ${errorMessage(error)}`);
        } finally {
          signal.removeEventListener("abort", onAbort);
          controller.abort();
          stream = null;
          setState(signal.aborted ? "stopped" : "connecting");
        }
        if (signal.aborted) break;
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, timing.backoffMaxMs);
      }
      setState("stopped");
    },
  };
}
