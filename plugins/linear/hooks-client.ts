// The subscriber side of bb-gate-hooks (bb-gate/docs/hooks.md): one SSE
// stream for doorbells, a lease per watched issue (and per team stewards
// asked about) proven with the developer's own token, renewed at half-life,
// and a re-check of every watch whenever coverage cannot be proven. The service promises nothing beyond
// "something about this entity changed while you were leased", so this
// module never decides anything about an issue; it only says when to look.
//
// The same stream carries `@bb` mentions ("Agent sessions" in hooks.md).
// The server proves which Linear user it acts for with `/v1/identify`,
// beside every lease renewal, and the service routes a mention to it as
// `event: session`. A reply goes back through `postActivity`; the app token
// that posts it on Linear stays in the service.
//
// Everything that touches the world is injected: fetch, the clock, the
// token, the lease set, and what to do on a doorbell or a rejected lease.
// The token goes into one request body and nowhere else: not a log line,
// not an error message.
import { z } from "zod";

export const HOOKS_URL_ENV = "BB_HOOKS_URL";
export const SOURCE = "linear";
/** The service refuses more watches than this in one call (413). */
export const SUBSCRIBE_BATCH = 100;

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

/** The events of a stream body, until it ends or the signal aborts. */
export class StreamIdleError extends Error {
  constructor(idleMs: number) {
    super(`no bytes from bb-gate-hooks for ${Math.round(idleMs / 1000)} s`);
    this.name = "StreamIdleError";
  }
}

/**
 * The events of a stream body, until it ends or the signal aborts. A stream
 * silent for `idleMs` (keepalives included: any bytes count) throws
 * StreamIdleError, because a half-open connection would otherwise look
 * leased forever.
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
/** `unit` is the issue's team UUID, or empty when the delivery did not say (some comments). */
export const doorbellSchema = z.object({ source: z.string(), kind: z.string(), id: z.string().min(1), unit: z.string().optional() }).loose();
export const subscribeResponseSchema = z.object({
  leases: z.array(z.object({ kind: z.string(), id: z.string() }).loose()).default([]),
  rejected: z.array(z.object({ kind: z.string(), id: z.string(), reason: z.string() }).loose()).default([]),
});
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
/** A refused lease, with the workspace it was asked for under. */
export type Rejection = SubscribeResponse["rejected"][number] & { account?: string };

/**
 * One thing to lease. `issue` rings for that issue; `team` (a team UUID)
 * rings for every issue doorbell whose unit is that team. Teams are leased
 * for stewards only: a watch is always on an issue.
 */
export type LeaseKind = "issue" | "team";
/**
 * `account` names the Linear workspace whose token proves the lease; leases
 * for different workspaces go in separate calls on the same connection.
 * Absent is the caller's only account.
 */
export type Lease = { kind: LeaseKind; id: string; account?: string };

/** `POST /v1/identify`'s answer: who the token belongs to, and which of the teams it covers. */
export const identifyResponseSchema = z.object({
  user: z.object({ id: z.string(), name: z.string() }).loose(),
  teams: z.array(z.string()).default([]),
  rejected: z.array(z.object({ kind: z.string(), id: z.string(), reason: z.string() }).loose()).default([]),
  expiresAt: z.string().optional(),
});
export type IdentifyResponse = z.infer<typeof identifyResponseSchema>;

const personWire = z.object({ id: z.string().max(200), name: z.string().max(200) }).loose();
/** `event: session` as the service sends it. The issue's key is `identifier` on the wire. */
export const sessionEventSchema = z
  .object({
    source: z.literal(SOURCE),
    session: z.string().min(1).max(200),
    action: z.enum(["created", "prompted"]),
    issue: z.object({ id: z.string().min(1).max(200), identifier: z.string().min(1).max(100), team: z.string().max(200).default(""), teamKey: z.string().max(100).default("") }).loose(),
    asker: personWire,
    owner: personWire,
    fromOwner: z.boolean(),
    routedAs: z.enum(["assignee", "asker"]),
    comment: z.object({ text: z.string(), untrusted: z.boolean() }).loose(),
    at: z.string().max(100).default(""),
  })
  .loose();
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** What a reply on an agent session is. Thoughts are the service's own. */
export const REPLY_KINDS = ["response", "elicitation", "error"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
/** The service refuses a reply body larger than this. */
export const REPLY_BODY_MAX_BYTES = 64 * 1024;

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

/** The service guarantees a keepalive every 20 s; this much silence means the stream is dead. */
export const STREAM_IDLE_MS = 60_000;

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * POST /v1/subscribe for these leases, in batches the service accepts.
 * A 404 means the connection is gone and is thrown as such so the caller
 * reconnects; nothing about the request body is ever put in an error.
 */
export async function subscribe(fetchImpl: FetchLike, baseUrl: string, connection: string, token: string, leases: Lease[], signal: AbortSignal): Promise<SubscribeResponse> {
  const merged: SubscribeResponse = { leases: [], rejected: [] };
  for (let i = 0; i < leases.length; i += SUBSCRIBE_BATCH) {
    const watches = leases.slice(i, i + SUBSCRIBE_BATCH).map(({ kind, id }) => ({ kind, id }));
    const response = await fetchImpl(new URL("/v1/subscribe", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ connection, source: SOURCE, token, watches }),
      signal,
    });
    if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to subscribe`, response.status, await response.text().catch(() => ""));
    const parsed = subscribeResponseSchema.parse(await response.json());
    merged.leases.push(...parsed.leases);
    merged.rejected.push(...parsed.rejected);
  }
  return merged;
}

/**
 * POST /v1/identify: prove which Linear user this server acts for, and which
 * of these teams (UUIDs) its projects cover. Each call replaces the last.
 * The token goes into the body and nowhere else.
 */
export async function identify(fetchImpl: FetchLike, baseUrl: string, connection: string, token: string, teams: string[], signal: AbortSignal): Promise<IdentifyResponse> {
  const response = await fetchImpl(new URL("/v1/identify", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ connection, source: SOURCE, token, teams: teams.slice(0, SUBSCRIBE_BATCH) }),
    signal,
  });
  if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to identify`, response.status, await response.text().catch(() => ""));
  return identifyResponseSchema.parse(await response.json());
}

/**
 * POST /v1/linear/sessions/{session}/activity: post a reply on an agent
 * session, as the bb app. The service accepts it only for a session it
 * routed to the user this connection proved it is.
 */
export async function postActivity(
  fetchImpl: FetchLike,
  baseUrl: string,
  connection: string,
  session: string,
  reply: { kind: ReplyKind; body: string; externalUrl?: string | undefined },
  signal: AbortSignal,
): Promise<{ activity: string }> {
  const response = await fetchImpl(new URL(`/v1/linear/sessions/${encodeURIComponent(session)}/activity`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ connection, kind: reply.kind, body: reply.body, ...(reply.externalUrl === undefined ? {} : { externalUrl: reply.externalUrl }) }),
    signal,
  });
  if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to the session reply`, response.status, await response.text().catch(() => ""));
  return z.object({ activity: z.string() }).loose().parse(await response.json());
}

// ---- the loop ----------------------------------------------------------------

export interface HooksTiming {
  /** Renew at this fraction of the lease. */
  renewFraction: number;
  /** Lease length assumed until the hello says otherwise. */
  defaultLeaseMs: number;
  /** Re-check everything this often while leased. */
  baselineMs: number;
  /** Re-check everything this often while the stream is down. */
  downSweepMs: number;
  /** Reconnect backoff, doubled from the first to the cap. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Silence on the stream that counts as a dead connection. */
  idleMs: number;
}

export const DEFAULT_TIMING: HooksTiming = {
  renewFraction: 0.5,
  defaultLeaseMs: 60 * 60 * 1000,
  baselineMs: 10 * 60 * 1000,
  downSweepMs: 2 * 60 * 1000,
  backoffMinMs: 1000,
  backoffMaxMs: 60 * 1000,
  idleMs: STREAM_IDLE_MS,
};

export interface HooksLoopDeps {
  fetch: FetchLike;
  baseUrl: string;
  now: () => number;
  log: { info(message: string): void; warn(message: string): void };
  /** The developer's current access token for a workspace, refreshed if it is about to expire. */
  token: (account?: string) => Promise<string>;
  /** A new token for a workspace, whatever the old one's expiry says: the service reported Linear refused it. */
  refreshToken: (account?: string) => Promise<string>;
  /** Everything to hold leases for, right now: watched issues, and stewards' issues and teams. */
  leases: () => Lease[];
  /** A doorbell for an issue: look at it again. `unit` is its team's UUID, or null when the doorbell did not name one. */
  onDoorbell: (issueId: string, unit: string | null) => void;
  /** Leases the service refused. The caller decides what that means for each watch or team. */
  onRejected: (rejected: Rejection[]) => Promise<void>;
  /** Check every watch against its cursor. */
  sweep: (reason: string) => Promise<void>;
  /**
   * Whom to identify as for agent sessions: the workspace whose token proves
   * it, and the team UUIDs this server's projects list. Null while there is
   * nothing to identify with. Absent: never identify.
   */
  identity?: () => { account?: string; teams: string[] } | null;
  /** The service's answer to an identify, for the usage view and logs. */
  onIdentified?: (identity: IdentifyResponse & { account?: string }) => void;
  /** An `@bb` mention routed to this server. Already parsed; never awaited by the stream. */
  onSession?: (event: SessionEvent) => void;
  timing?: Partial<HooksTiming>;
}

/**
 * The loop as a usage view sees it. `stopped`: `run` is not running (no
 * service, or nothing to prove a lease with). `connecting`: running, no
 * stream with a hello on it yet, so checks fall back to the slow down-sweep.
 * `connected`: a stream is up; `leased` says whether the leases on it are
 * current. Counts are over the last `windowMs`.
 */
export type HooksStatus = {
  state: "stopped" | "connecting" | "connected";
  /** When the state last changed. */
  since: number;
  leased: boolean;
  /** When the current leases run out; 0 while there are none. */
  leasedUntil: number;
  windowMs: number;
  doorbells: number;
  lastDoorbellAt: number;
  sweeps: number;
  lastSweepAt: number;
  lastSweepReason: string | null;
};

/** The window the status counts doorbells and sweeps over. */
export const STATUS_WINDOW_MS = 60 * 60 * 1000;

export interface HooksLoop {
  /** Run until the signal aborts. Never throws for a network reason; it retries. */
  run(signal: AbortSignal): Promise<void>;
  /** Leases were just added (a watch, or stewards' interest): lease them now if there is a connection. The next hello covers them otherwise. */
  added(kind: LeaseKind, ...ids: string[]): Promise<void>;
  /** The same, for leases that name their workspace. */
  addedLeases(leases: Lease[]): Promise<void>;
  /** Whether a connection is up and leased; for status lines and tests. */
  readonly connected: boolean;
  /** What the loop is doing and how busy it has been; for the usage view. */
  status(): HooksStatus;
  /** Called whenever `status().state` changes. */
  onStateChange(listener: () => void): void;
  /** Identify again now (the teams changed), if there is a connection. The next renewal covers it otherwise. */
  reidentify(): Promise<void>;
  /** Post a reply on an agent session over the current connection. Throws HooksRequestError, or an Error when there is no connection. */
  reply(session: string, reply: { kind: ReplyKind; body: string; externalUrl?: string | undefined }, signal: AbortSignal): Promise<{ activity: string }>;
}

/** How many events fell in the window ending now, and when the last one was (however long ago). */
function createWindowCounter(windowMs: number, now: () => number) {
  let stamps: number[] = [];
  let lastAt = 0;
  return {
    push() {
      lastAt = now();
      stamps.push(lastAt);
      stamps = stamps.filter((t) => t > lastAt - windowMs);
    },
    count: () => {
      const at = now();
      stamps = stamps.filter((t) => t > at - windowMs);
      return stamps.length;
    },
    last: () => lastAt,
  };
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
  /** When the current leases run out; 0 while there are none. */
  let leasedUntil = 0;
  /** Aborting this drops the current stream so the outer loop reconnects. */
  let stream: AbortController | null = null;
  let lastSweepAt = 0;
  let lastSweepReason: string | null = null;
  let wrongUrlLogged = false;

  const doorbells = createWindowCounter(STATUS_WINDOW_MS, deps.now);
  const sweeps = createWindowCounter(STATUS_WINDOW_MS, deps.now);
  let state: HooksStatus["state"] = "stopped";
  let stateSince = deps.now();
  const stateListeners = new Set<() => void>();
  function setState(next: HooksStatus["state"]): void {
    if (next === state) return;
    state = next;
    stateSince = deps.now();
    for (const listener of stateListeners) listener();
  }

  function runSweep(reason: string): void {
    lastSweepAt = deps.now();
    lastSweepReason = reason;
    sweeps.push();
    deps.sweep(reason).catch((error: unknown) => deps.log.warn(`Linear watch sweep (${reason}) failed: ${errorMessage(error)}`));
  }

  /**
   * Lease these on the current connection. Returns whether the service
   * accepted the call; a 404 means the connection is gone and drops the
   * stream. The token comes from the caller's refresh path, so a lease is
   * always proven with one Linear would accept right now.
   */
  async function lease(leases: Lease[], signal: AbortSignal): Promise<boolean> {
    if (connection === null) return false;
    const current = connection;
    const started = deps.now();
    // One workspace's token proves only its own issues and teams, so each
    // workspace's leases are a call of their own. Every group must succeed
    // for the renewal to count; a failed one fails the renewal and triggers
    // the sweep.
    const groups = new Map<string | undefined, Lease[]>();
    for (const l of leases) groups.set(l.account, [...(groups.get(l.account) ?? []), l]);
    let ok = true;
    for (const [account, group] of groups) {
      if (!(await leaseGroup(current, account, group, signal))) ok = false;
      if (connection !== current) return false;
    }
    if (ok && connection === current) leasedUntil = Math.max(leasedUntil, started + leaseMs);
    return ok;
  }

  async function leaseGroup(current: string, account: string | undefined, leases: Lease[], signal: AbortSignal): Promise<boolean> {
    const named = account === undefined ? "" : ` for ${account}`;
    try {
      let result: SubscribeResponse;
      try {
        result = await subscribe(deps.fetch, deps.baseUrl, current, await deps.token(account), leases, signal);
      } catch (error) {
        // 401 is about the token, not any entity: Linear refused it on the
        // service's side. Refresh regardless of what the expiry says and try
        // once more; nothing was admitted or dropped.
        if (!(error instanceof HooksRequestError && error.status === 401)) throw error;
        deps.log.warn(`bb-gate-hooks says Linear refused the token${named}; refreshing and retrying`);
        result = await subscribe(deps.fetch, deps.baseUrl, current, await deps.refreshToken(account), leases, signal);
      }
      if (result.rejected.length > 0) await deps.onRejected(result.rejected.map((r) => (account === undefined ? r : { ...r, account })));
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof HooksRequestError && error.status === 404) {
        if (error.unknownConnection) {
          if (connection === current) {
            deps.log.warn("bb-gate-hooks forgot our connection; reconnecting");
            stream?.abort();
          }
          return false;
        }
        // A 404 from the path itself: the URL is wrong. Say so once; the
        // normal renewal and reconnect cadence keeps trying.
        if (!wrongUrlLogged) {
          wrongUrlLogged = true;
          deps.log.warn(`${HOOKS_URL_ENV} looks wrong: ${deps.baseUrl} answers 404 to /v1/subscribe without naming the connection`);
        }
        return false;
      }
      deps.log.warn(`Linear watch lease${named} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Prove who this server acts for, on the current connection. Independent
   * of the leases: a failure here costs agent sessions until the next
   * renewal, never a watch. Never throws.
   */
  let identifyUnsupportedLogged = false;
  async function identifyNow(signal: AbortSignal): Promise<void> {
    if (deps.identity === undefined || connection === null) return;
    const current = connection;
    const who = deps.identity();
    if (who === null) return;
    const named = who.account === undefined ? "" : ` for ${who.account}`;
    try {
      let result: IdentifyResponse;
      try {
        result = await identify(deps.fetch, deps.baseUrl, current, await deps.token(who.account), who.teams, signal);
      } catch (error) {
        if (!(error instanceof HooksRequestError && error.status === 401)) throw error;
        deps.log.warn(`bb-gate-hooks says Linear refused the token${named} on identify; refreshing and retrying`);
        result = await identify(deps.fetch, deps.baseUrl, current, await deps.refreshToken(who.account), who.teams, signal);
      }
      if (connection !== current) return;
      if (result.rejected.length > 0) deps.log.warn(`bb-gate-hooks did not admit ${result.rejected.length} team${result.rejected.length === 1 ? "" : "s"} for agent sessions (${[...new Set(result.rejected.map((r) => r.reason))].join(", ")}); a mention on their issues routed here by assignee gets an error until a renewal admits them`);
      deps.onIdentified?.(who.account === undefined ? result : { ...result, account: who.account });
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
        // An older service with no agent sessions: say so once, keep the watches.
        if (!identifyUnsupportedLogged) {
          identifyUnsupportedLogged = true;
          deps.log.info("bb-gate-hooks has no /v1/identify, so @bb mentions in Linear are not routed to this server");
        }
        return;
      }
      deps.log.warn(`Linear identity for agent sessions${named} failed: ${errorMessage(error)}`);
    }
  }

  /** Renew every lease; a failed or late renewal means a gap, so everything is checked. Never throws: it runs from timers. */
  async function renew(reason: "hello" | "renewal", signal: AbortSignal): Promise<void> {
    // The identity lasts as long as a lease, so it is renewed beside them.
    void identifyNow(signal);
    try {
      const leases = deps.leases();
      const late = reason === "renewal" && leasedUntil !== 0 && deps.now() >= leasedUntil;
      let ok = true;
      if (leases.length === 0) leasedUntil = deps.now() + leaseMs;
      else ok = await lease(leases, signal);
      if (reason === "hello" || !ok || late) runSweep(reason === "hello" ? "connected" : ok ? "late renewal" : "failed renewal");
    } catch (error) {
      if (!signal.aborted) deps.log.warn(`Linear watch renewal failed: ${errorMessage(error)}`);
    }
  }

  async function consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    let baselineTimer: ReturnType<typeof setInterval> | null = null;
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
          deps.log.info(`Linear watches: connected to bb-gate-hooks as ${connection}`);
          // Not awaited: doorbells behind the hello must not wait for Linear.
          void renew("hello", signal);
          if (renewTimer !== null) clearInterval(renewTimer);
          if (baselineTimer !== null) clearInterval(baselineTimer);
          renewTimer = setInterval(() => void renew("renewal", signal), Math.max(1000, leaseMs * timing.renewFraction));
          baselineTimer = setInterval(() => runSweep("baseline"), timing.baselineMs);
        } else if (event.event === "doorbell") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          const doorbell = doorbellSchema.safeParse(parsed);
          // `action` and `at` are for the service's logs; the reaction to any
          // doorbell is the same check. Every Linear doorbell is an issue,
          // including those a team lease brought; `unit` says which team.
          if (doorbell.success && doorbell.data.source === SOURCE && doorbell.data.kind === "issue") {
            doorbells.push();
            const unit = doorbell.data.unit ?? "";
            deps.onDoorbell(doorbell.data.id, unit === "" ? null : unit);
          }
        } else if (event.event === "session") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          const session = sessionEventSchema.safeParse(parsed);
          if (session.success) deps.onSession?.(session.data);
          else deps.log.warn("bb-gate-hooks sent an agent session event this plugin does not understand; dropped");
        }
      }
    } finally {
      if (renewTimer !== null) clearInterval(renewTimer);
      if (baselineTimer !== null) clearInterval(baselineTimer);
      connection = null;
      leasedUntil = 0;
    }
  }

  return {
    get connected() {
      return connection !== null && leasedUntil > deps.now();
    },

    status() {
      return {
        state,
        since: stateSince,
        leased: connection !== null && leasedUntil > deps.now(),
        leasedUntil: connection === null ? 0 : leasedUntil,
        windowMs: STATUS_WINDOW_MS,
        doorbells: doorbells.count(),
        lastDoorbellAt: doorbells.last(),
        sweeps: sweeps.count(),
        lastSweepAt,
        lastSweepReason,
      };
    },

    onStateChange(listener) {
      stateListeners.add(listener);
    },

    async added(kind, ...ids) {
      if (connection === null || stream === null || ids.length === 0) return;
      await lease(ids.map((id) => ({ kind, id })), stream.signal);
    },

    async reidentify() {
      if (connection === null || stream === null) return;
      await identifyNow(stream.signal);
    },

    async reply(session, reply, signal) {
      if (connection === null) throw new Error("This bb server is not connected to bb-gate-hooks right now (it is reconnecting). Try again in a minute.");
      return postActivity(deps.fetch, deps.baseUrl, connection, session, reply, signal);
    },

    async addedLeases(leases) {
      if (connection === null || stream === null || leases.length === 0) return;
      await lease(leases, stream.signal);
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
        // Down: nobody is ringing, so look for ourselves, slowly.
        if (deps.now() - lastSweepAt >= timing.downSweepMs) runSweep("stream down");
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, timing.backoffMaxMs);
      }
      setState("stopped");
    },
  };
}
