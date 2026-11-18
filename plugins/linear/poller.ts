// Polling mode: when the server has no hooks service (`BB_HOOKS_URL`
// unset), linear still lets threads watch an issue.
// A plain timer re-checks every open watch and polls the teams and issues
// stewards asked to hear about, so a new labelled ticket, an assignee change
// or a comment is found without a doorbell. The hooks client's baseline
// re-check is the same work; this module only decides when it runs and how
// hard to back off when Linear says the caller is over its rate limit.
//
// Everything that touches the world is injected: the clock, the log and the
// one round of work. The timer never retries in a tight loop: a rate limit
// (429, a rate-limit error, or a near-zero remaining quota) doubles the wait
// up to a cap, and every normal round waits the full interval.
/** How long a poll waits between rounds, and how it backs off when rate-limited. */
export interface PollerTiming {
  /** The normal interval between polls. */
  intervalMs: number;
  /** The first backoff after a rate limit. */
  backoffMinMs: number;
  /** The longest backoff. */
  backoffMaxMs: number;
  /** How many entities one poll may ring stewards for; the rest wait for the next poll. */
  maxEntitiesPerPoll: number;
}

export const DEFAULT_POLL_TIMING: PollerTiming = {
  // The sweep default on a hooks-less server is the same order: five minutes
  // is frequent enough that a new ticket or a comment is seen promptly and
  // slow enough that a developer's token is not spent re-reading unchanged
  // teams.
  intervalMs: 5 * 60_000,
  backoffMinMs: 60_000,
  backoffMaxMs: 30 * 60_000,
  maxEntitiesPerPoll: 100,
};

/** The state the poller is in, for the usage view and the settings page. */
export type PollerState = "stopped" | "idle" | "polling" | "backoff";

/** The poller as the usage view sees it. */
export interface PollerStatus {
  state: PollerState;
  /** When the state last changed. */
  since: number;
  intervalMs: number;
  /** When the last poll started; 0 when none has. */
  lastPollAt: number;
  /** When the next poll is due; 0 when the poller is stopped. */
  nextPollAt: number;
  /** Rounds finished (successfully or not) since start. */
  polls: number;
  /** True when the last poll was rate-limited and the poller is backing off. */
  starved: boolean;
  /** The rate limit's own words, or the last poll's error. */
  lastError: string | null;
  /** When the backoff ends; 0 when not backing off. */
  backoffUntil: number;
}

/**
 * A poll Linear rate-limited. `retryAfterMs` is the server's own hint (the
 * reset time behind a near-zero quota); null means use our own backoff.
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** What one round of work reports back. */
export interface PollResult {
  /** The poll found Linear rate-limiting it; back off rather than wait the interval. */
  rateLimited?: boolean;
  /** The server's retry hint, when it gave one. */
  retryAfterMs?: number;
  /** What the rate limit said, for the settings page; a generic line when the poll did not name one. */
  message?: string;
  /** The per-poll cap left entities for the next poll. */
  capped?: boolean;
}

export interface PollerDeps {
  now: () => number;
  log: { info(message: string): void; warn(message: string): void };
  /**
   * One round of work. It may throw `RateLimitError` (or return
   * `{ rateLimited: true }`) to make the poller back off instead of waiting
   * the normal interval. Any other error is logged and the normal interval
   * resumes.
   */
  poll: (reason: string) => Promise<PollResult | void>;
  timing?: Partial<PollerTiming>;
}

export interface Poller {
  /** Run until the signal aborts. Never throws for a network reason; it retries. */
  run(signal: AbortSignal): Promise<void>;
  /** Poll now when waiting, or again as soon as the round in flight finishes. */
  poke(): void;
  /** What the poller is doing and how busy it has been; for the usage view. */
  status(): PollerStatus;
  /** Called whenever `status()` changes. */
  onStateChange(listener: () => void): void;
  /** The normal interval, for a result line that names it. */
  readonly intervalMs: number;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createPoller(deps: PollerDeps): Poller {
  const timing: PollerTiming = { ...DEFAULT_POLL_TIMING, ...deps.timing };
  let state: PollerState = "stopped";
  let stateSince = deps.now();
  let lastPollAt = 0;
  let nextPollAt = 0;
  let polls = 0;
  let starved = false;
  let lastError: string | null = null;
  let backoffUntil = 0;
  let backoff = timing.backoffMinMs;
  /** A `poke` that arrived while a poll was running makes the next wait zero. */
  let poked = false;
  /** Resolvers waiting on the timer or a poke; woken to re-evaluate `nextPollAt`. */
  const waiters = new Set<() => void>();
  const listeners = new Set<() => void>();

  function setState(next: PollerState): void {
    if (next === state) return;
    state = next;
    stateSince = deps.now();
    for (const listener of listeners) listener();
  }

  function wakeWaiters(): void {
    for (const resolve of [...waiters]) resolve();
  }

  /** The delay after a round: zero after a poke, the backoff while starved, else the interval. */
  function nextDelay(): number {
    if (poked) {
      poked = false;
      return 0;
    }
    if (starved) return Math.max(0, backoffUntil - deps.now());
    return timing.intervalMs;
  }

  /** Remember a rate limit and double the backoff for next time (or take the server's hint). */
  function backOff(hint: number | null, message: string): void {
    starved = true;
    lastError = message;
    // Clamp the server's hint too: a header in the wrong unit must not
    // overflow the timer and turn the backoff into a tight loop.
    const waited = Math.min(hint !== null && hint > 0 ? hint : backoff, timing.backoffMaxMs);
    backoff = Math.min(Math.max(backoff * 2, timing.backoffMinMs), timing.backoffMaxMs);
    backoffUntil = deps.now() + waited;
    deps.log.warn(`linear: poll rate-limited (${message}); backing off ${Math.round(waited / 1000)}s`);
  }

  function clearBackoff(): void {
    starved = false;
    lastError = null;
    backoff = timing.backoffMinMs;
    backoffUntil = 0;
  }

  async function round(): Promise<void> {
    setState("polling");
    lastPollAt = deps.now();
    try {
      const result = await deps.poll(starved ? "poll (backoff)" : "poll");
      polls += 1;
      if (result !== undefined && result.rateLimited === true) backOff(result.retryAfterMs ?? null, result.message ?? "Linear is rate-limiting this server");
      else {
        clearBackoff();
        if (result !== undefined && result.capped === true) deps.log.info("linear: poll hit its entity cap; the rest will be read on the next poll");
      }
    } catch (error) {
      polls += 1;
      if (error instanceof RateLimitError) backOff(error.retryAfterMs, error.message);
      else {
        // A transient read failure is not a rate limit: keep the normal
        // cadence, but remember the last error for the settings page.
        starved = false;
        lastError = errorMessage(error);
        backoff = timing.backoffMinMs;
        backoffUntil = 0;
        deps.log.warn(`linear: poll failed: ${lastError}`);
      }
    }
  }

  return {
    intervalMs: timing.intervalMs,

    status() {
      return {
        state,
        since: stateSince,
        intervalMs: timing.intervalMs,
        lastPollAt,
        nextPollAt,
        polls,
        starved,
        lastError,
        backoffUntil,
      };
    },

    onStateChange(listener) {
      listeners.add(listener);
    },

    poke() {
      // While starved, a poke does not cut the backoff short: the rate limit
      // is still there, and a new watch or interest change does not remove
      // it. The round happens when the backoff ends.
      if (starved) return;
      nextPollAt = deps.now();
      // A waiting loop wakes and polls at once. A poll already in flight has
      // no waiter; the flag makes the next delay zero so it polls again as
      // soon as it finishes.
      if (waiters.size > 0) wakeWaiters();
      else poked = true;
    },

    async run(signal) {
      setState("idle");
      nextPollAt = deps.now();
      while (!signal.aborted) {
        // Wait out the scheduled delay; a poke or an abort wakes us early.
        await new Promise<void>((resolve) => {
          const remaining = nextPollAt - deps.now();
          if (remaining <= 0) return resolve();
          const timer = setTimeout(done, remaining);
          const onAbort = () => done();
          function done() {
            clearTimeout(timer);
            waiters.delete(done);
            signal.removeEventListener("abort", onAbort);
            resolve();
          }
          waiters.add(done);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        if (signal.aborted) break;
        await round();
        if (signal.aborted) break;
        setState(starved ? "backoff" : "idle");
        nextPollAt = deps.now() + nextDelay();
      }
      setState("stopped");
      nextPollAt = 0;
    },
  };
}
