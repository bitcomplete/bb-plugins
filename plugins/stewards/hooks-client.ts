// The subscriber side of bb-gate-hooks (bb-gate/docs/hooks.md) for one
// source at a time: one SSE stream for doorbells, a lease per watched entity
// (proven with the plugin's token for a token source, or admitted without one
// for a tokenless source such as Alertmanager), renewed at half-life, and a
// re-check of every watch whenever coverage cannot be proven. The service
// promises nothing beyond "something about this entity changed while you were
// leased", so this module never decides anything about an entity; it only
// says when to look.
//
// A copy of github-watcher's hooks-client.ts with the GitHub parts taken
// out: stewards has no sentry or alertmanager plugin to lease through, so it
// subscribes itself, with the source named per loop. Everything that touches
// the world is injected: fetch, the clock, the source, the token, the watch
// list, and what to do on a doorbell or a rejected lease. The token goes into
// one request body and nowhere else: not a log line, not an error message.
import { z } from "zod";

export const HOOKS_URL_ENV = "BB_HOOKS_URL";
/** The service refuses more watches than this in one call (413). */
export const SUBSCRIBE_BATCH = 100;

/**
 * What a lease hangs off, per source. Sentry: `issue` is one issue by its
 * id; `project` is a whole project, sent as "org/slug" (Sentry needs the
 * organization to read it) and leased under the slug, which is what its
 * doorbells carry as the unit. Alertmanager: `namespace` is a Kubernetes
 * namespace, which is what its `alert` doorbells carry as the unit
 * (bb-gate/docs/hooks.md, "Sentry" and "Alertmanager").
 */
export type LeaseKind = "issue" | "project" | "namespace";
export type Lease = { kind: LeaseKind; id: string };

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
export const doorbellSchema = z.object({ source: z.string(), kind: z.string(), id: z.string().min(1), unit: z.string().optional(), action: z.string().optional() }).loose();
export const subscribeResponseSchema = z.object({
  leases: z.array(z.object({ kind: z.string(), id: z.string() }).loose()).default([]),
  rejected: z.array(z.object({ kind: z.string(), id: z.string(), reason: z.string() }).loose()).default([]),
});
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
export type Rejection = SubscribeResponse["rejected"][number];

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

  /** The service forgot the connection the request named; any other 404 is a wrong URL. */
  get unknownConnection(): boolean {
    if (this.status !== 404) return false;
    try {
      return (JSON.parse(this.body) as { error?: unknown }).error === "unknown-connection";
    } catch {
      return false;
    }
  }

  /** The service does not know the source (HTTP 400, plain `unknown source`); its image predates the source. */
  get unknownSource(): boolean {
    return this.status === 400 && this.body.trim().toLowerCase() === "unknown source";
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
export async function subscribe(fetchImpl: FetchLike, baseUrl: string, connection: string, source: string, token: string, leases: Lease[], signal: AbortSignal): Promise<SubscribeResponse> {
  const merged: SubscribeResponse = { leases: [], rejected: [] };
  for (let i = 0; i < leases.length; i += SUBSCRIBE_BATCH) {
    const watches = leases.slice(i, i + SUBSCRIBE_BATCH).map(({ kind, id }) => ({ kind, id }));
    const response = await fetchImpl(new URL("/v1/subscribe", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ connection, source, token, watches }),
      signal,
    });
    if (!response.ok) throw new HooksRequestError(`bb-gate-hooks answered HTTP ${response.status} to subscribe`, response.status, await response.text().catch(() => ""));
    const parsed = subscribeResponseSchema.parse(await response.json());
    merged.leases.push(...parsed.leases);
    merged.rejected.push(...parsed.rejected);
  }
  return merged;
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
  /** The source this loop leases and rings for: `sentry`, `alertmanager`, ... */
  source: string;
  /**
   * The plugin's token for a source that proves a lease with one; null for a
   * tokenless source (Alertmanager), whose leases are admitted without one.
   */
  token: (() => Promise<string | null>) | null;
  /** Every lease to hold, right now: the projects the project files list, and the issues with open tickets. */
  watchIds: () => Lease[];
  /**
   * A doorbell: the kind (`issue`, `alert`), the entity id, the unit (the
   * project slug or namespace) when the service named one, and the action
   * (`created`, `firing`, `resolved`, ...) when it named one. The caller
   * decides what to look at.
   */
  onDoorbell: (kind: string, id: string, unit: string | null, action: string | null) => void;
  /** Leases the service refused. The caller decides what that means for each watch. */
  onRejected: (rejected: Rejection[]) => Promise<void>;
  /** Check every watch against its cursor. */
  sweep: (reason: string) => Promise<void>;
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
  /**
   * The service cannot lease this source: `unknown` (its image predates the
   * source, or a tokenless subscribe was rejected), `unconfigured` (the
   * adapter is present but its secret is not set, a 503), or null when it is
   * fine. Said once, and only the periodic look sees the watch until it clears.
   */
  sourceProblem: "unknown" | "unconfigured" | null;
};

/** The window the status counts doorbells and sweeps over. */
export const STATUS_WINDOW_MS = 60 * 60 * 1000;

export interface HooksLoop {
  /** Run until the signal aborts. Never throws for a network reason; it retries. */
  run(signal: AbortSignal): Promise<void>;
  /** A watch or an interest was just added: lease it now if there is a connection. The next hello covers it otherwise. */
  added(kind: LeaseKind, ...ids: string[]): Promise<void>;
  /** Whether a connection is up and leased; for status lines and tests. */
  readonly connected: boolean;
  /** What the loop is doing and how busy it has been; for the usage view. */
  status(): HooksStatus;
  /** Called whenever `status().state` changes. */
  onStateChange(listener: () => void): void;
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

/**
 * Why the service cannot lease this source, or null when the failure is not
 * about the source. A tokenless subscribe rejected with 400 is the old
 * service's `bad request` (before it knew the source) as much as a 400
 * `unknown source`; a 503 is the adapter present but not configured.
 */
function sourceProblemOf(error: unknown, tokenless: boolean): "unknown" | "unconfigured" | null {
  if (!(error instanceof HooksRequestError)) return null;
  if (error.unknownSource || (tokenless && error.status === 400)) return "unknown";
  if (error.status === 503) return "unconfigured";
  return null;
}

const sourceProblemMessage = (source: string, problem: "unknown" | "unconfigured"): string =>
  problem === "unknown" ? `bb-gate-hooks does not know the ${source} source yet; the periodic look carries it until the service is updated` : `bb-gate-hooks has no ${source} adapter configured (its secret is not set); the periodic look carries it until the service is updated`;

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
  /** The service cannot lease this source; said once per problem, then only the periodic look carries the watch. */
  let sourceProblem: "unknown" | "unconfigured" | null = null;

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
    deps.sweep(reason).catch((error: unknown) => deps.log.warn(`${deps.source} watch sweep (${reason}) failed: ${errorMessage(error)}`));
  }

  /**
   * Lease these on the current connection. Returns whether the service
   * accepted the call; a 404 means the connection is gone and drops the
   * stream. A token source without a token proves nothing, so nothing is
   * sent and the loop counts as unleased: the sweeps carry the watch until
   * one is set. A tokenless source sends no token at all. A 401 is the token
   * itself, refused by the source on the service's side; there is no refresh
   * path, so it is said (once per token) and the next renewal tries again
   * with whatever the setting holds then. A 400 `unknown source` is an image
   * that predates the source: said once, and the periodic look carries it.
   */
  let refusedLogged = false;
  async function lease(ids: Lease[], signal: AbortSignal): Promise<boolean> {
    if (connection === null) return false;
    const current = connection;
    const started = deps.now();
    try {
      const tokenFn = deps.token;
      const token = tokenFn === null ? "" : ((await tokenFn())?.trim() ?? "");
      if (tokenFn !== null && token === "") return false;
      const result = await subscribe(deps.fetch, deps.baseUrl, current, deps.source, token, ids, signal);
      refusedLogged = false;
      sourceProblem = null;
      if (connection === current) leasedUntil = Math.max(leasedUntil, started + leaseMs);
      if (result.rejected.length > 0) await deps.onRejected(result.rejected);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof HooksRequestError && error.status === 401) {
        if (!refusedLogged) deps.log.warn(`bb-gate-hooks says ${deps.source} refused the token; check the ${deps.source} token setting of the stewards plugin`);
        refusedLogged = true;
        return false;
      }
      const problem = sourceProblemOf(error, deps.token === null);
      if (problem !== null) {
        if (sourceProblem !== problem) deps.log.warn(sourceProblemMessage(deps.source, problem));
        sourceProblem = problem;
        return false;
      }
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
      deps.log.warn(`${deps.source} watch lease failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Renew every lease; a failed or late renewal means a gap, so everything is checked. Never throws: it runs from timers. */
  async function renew(reason: "hello" | "renewal", signal: AbortSignal): Promise<void> {
    try {
      const ids = deps.watchIds();
      const late = reason === "renewal" && leasedUntil !== 0 && deps.now() >= leasedUntil;
      let ok = true;
      if (ids.length === 0) leasedUntil = deps.now() + leaseMs;
      else ok = await lease(ids, signal);
      if (reason === "hello" || !ok || late) runSweep(reason === "hello" ? "connected" : ok ? "late renewal" : "failed renewal");
    } catch (error) {
      if (!signal.aborted) deps.log.warn(`${deps.source} watch renewal failed: ${errorMessage(error)}`);
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
          deps.log.info(`${deps.source} watches: connected to bb-gate-hooks as ${connection}`);
          // Not awaited: doorbells behind the hello must not wait for a look.
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
          // The unit and the action are passed on so a lease can tell which
          // of its doorbells it was rung for and how. The caller filters the
          // kinds it knows.
          if (doorbell.success && doorbell.data.source === deps.source) {
            doorbells.push();
            const unit = doorbell.data.unit?.trim() ?? "";
            const action = doorbell.data.action?.trim() ?? "";
            deps.onDoorbell(doorbell.data.kind, doorbell.data.id, unit === "" ? null : unit, action === "" ? null : action);
          }
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
        sourceProblem,
      };
    },

    onStateChange(listener) {
      stateListeners.add(listener);
    },

    async added(kind, ...ids) {
      if (connection === null || stream === null || ids.length === 0) return;
      await lease(ids.map((id) => ({ kind, id })), stream.signal);
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
