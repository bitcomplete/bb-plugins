// The server update banner's state: whether bb-gate has a newer build of
// this server staged, and the restart the developer asks for.
//
// bb-gate no longer restarts a developer's server when a new image lands.
// Its router stages the update and serves GET /_bb-gate/update, answering
// {pending, ready} for the caller's own server, and POST applies it. The
// endpoint is the router's, on the same host as bb, so a plain fetch from
// the page carries the tailnet assertion the gateway adds. A bb that is not
// behind bb-gate gets a 404 (or HTML) there and the banner stays hidden.
//
// One store per page, however many banners are mounted: a composer banner
// per open thread and the home page section all read it.

export const UPDATE_PATH = "/_bb-gate/update";
export const POLL_MS = 60_000;
export const RESTART_POLL_MS = 500;
// A restart the Deployment has not reported within this long is not one the
// banner can explain; reload anyway and let the gate sort it out.
export const RESTART_TIMEOUT_MS = 15_000;

export type UpdateState =
  | { status: "unknown" }
  // Not behind bb-gate, or the router is older than this plugin.
  | { status: "unavailable" }
  | { status: "current" }
  | { status: "pending" }
  // The developer pressed the button; the page reloads as soon as the
  // server has gone down, onto the gate's starting page.
  | { status: "restarting" }
  | { status: "error"; message: string };

export interface GateStatus {
  pending: boolean;
  ready: boolean;
}

export interface UpdateStoreDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  reload: () => void;
  visible: () => boolean;
}

export interface UpdateStore {
  getState(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** Ask the router now, outside the poll. */
  refresh(): Promise<void>;
  /** POST the update and reload once the server has gone down. */
  apply(): Promise<void>;
}

function parseStatus(v: unknown): GateStatus | null {
  if (typeof v !== "object" || v === null) return null;
  const { pending, ready } = v as Record<string, unknown>;
  if (typeof pending !== "boolean" || typeof ready !== "boolean") return null;
  return { pending, ready };
}

export function createUpdateStore(deps: UpdateStoreDeps): UpdateStore {
  let state: UpdateState = { status: "unknown" };
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;

  const set = (next: UpdateState) => {
    state = next;
    for (const l of listeners) l();
  };

  const get = async (): Promise<GateStatus | "unavailable"> => {
    const r = await deps.fetch(UPDATE_PATH, { headers: { Accept: "application/json" } });
    if (r.status === 404) return "unavailable";
    if (!r.ok) throw new Error(`bb-gate answered ${r.status}`);
    const s = parseStatus(await r.json().catch(() => null));
    if (s === null) return "unavailable";
    return s;
  };

  const refresh = async () => {
    if (state.status === "restarting") return;
    try {
      const s = await get();
      // apply() may have started while the request was out.
      if ((state as UpdateState).status === "restarting") return;
      if (s === "unavailable") set({ status: "unavailable" });
      else set({ status: s.pending ? "pending" : "current" });
    } catch (e) {
      set({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const schedule = () => {
    if (timer !== null || listeners.size === 0 || state.status === "unavailable") return;
    timer = deps.setTimeout(() => {
      timer = null;
      if (deps.visible()) void tick();
      else schedule();
    }, POLL_MS);
  };
  const tick = async () => {
    if (inflight === null) inflight = refresh().finally(() => (inflight = null));
    await inflight;
    schedule();
  };

  // Follow the restart only as far as its first step: the Deployment
  // reports not-ready as soon as the old pod is gone, and from then on the
  // router answers a page load with its starting page, which reloads itself
  // until the new pod is up. Handing over to that page right away is the
  // point: a bb whose server has just left is a dead UI, every request and
  // socket failing, and there is nothing it could show that is better than
  // the gate's own page.
  //
  // Waiting for not-ready, rather than reloading at once, keeps the reload
  // from landing on the old pod in its last moments and loading the full
  // app only to lose it again.
  const follow = async () => {
    const started = deps.now();
    while (deps.now() - started < RESTART_TIMEOUT_MS) {
      await new Promise<void>((resolve) => deps.setTimeout(resolve, RESTART_POLL_MS));
      try {
        const s = await get();
        if (s === "unavailable" || !s.ready) break;
      } catch {
        // The router itself is briefly away, or the gateway is; keep waiting.
      }
    }
    deps.reload();
  };

  const apply = async () => {
    if (state.status === "restarting") return;
    set({ status: "restarting" });
    try {
      const r = await deps.fetch(UPDATE_PATH, { method: "POST", headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`bb-gate answered ${r.status}`);
      const { applied } = (await r.json().catch(() => ({}))) as { applied?: unknown };
      if (applied === false) {
        // Nothing to apply after all: the server was already current, or
        // the quiet window got there first. Nothing restarts, so do not
        // wait for it to.
        set({ status: "current" });
        return;
      }
    } catch (e) {
      set({ status: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    await follow();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) void tick();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          deps.clearTimeout(timer);
          timer = null;
        }
      };
    },
    refresh,
    apply,
  };
}

export function browserDeps(): UpdateStoreDeps {
  return {
    fetch: (input, init) => window.fetch(input, { credentials: "same-origin", ...init }),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    now: () => Date.now(),
    reload: () => window.location.reload(),
    visible: () => document.visibilityState === "visible",
  };
}
