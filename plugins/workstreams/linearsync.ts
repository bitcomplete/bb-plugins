// Linear detail, fetched and cached. The only module that talks to Linear, and
// it does so through an injected fetch so tests never reach the network. A key
// is used for the Authorization header and nothing else: it is never logged,
// stored or returned — a key is "key #n" in every message.
import {
  LINEAR_BATCH,
  LINEAR_DETAIL_TTL_MS,
  LINEAR_TEAMS_TTL_MS,
  WORKSPACE_QUERY,
  detailQuery,
  parseDetails,
  parseWorkspace,
  planFetch,
  routeTeams,
  type LinearDetail,
  type LinearWorkspace,
} from "./linear.js";
import type { RunDb } from "./runstore.js";

/** Append-only: server.ts adds this to its migration list. `detail` is JSON, or NULL for "Linear has no such issue". */
export const LINEAR_DETAIL_MIGRATION = `CREATE TABLE IF NOT EXISTS linear_detail (
  ticket TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  detail TEXT,
  fetched_at INTEGER NOT NULL
)`;

const ENDPOINT = "https://api.linear.app/graphql";

export type LinearSyncDeps = {
  db: RunDb & { transaction<T>(fn: () => T): () => T };
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
};

export type LinearSync = ReturnType<typeof createLinearSync>;

export function createLinearSync(deps: LinearSyncDeps) {
  const now = deps.now ?? Date.now;
  let discovered: { at: number; keyCount: number; workspaces: LinearWorkspace[] } | null = null;
  /** Each distinct failure or warning is logged once per load, not once per scan. */
  const said = new Set<string>();
  const once = (message: string) => {
    if (said.has(message)) return;
    said.add(message);
    deps.log.warn(message);
  };

  async function post(key: string, query: string, signal: AbortSignal): Promise<unknown> {
    const response = await deps.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Each key's workspace and team keys, re-read once a day or after `invalidate`. */
  async function workspaces(keys: readonly string[], signal: AbortSignal): Promise<LinearWorkspace[]> {
    if (discovered !== null && discovered.keyCount === keys.length && now() - discovered.at < LINEAR_TEAMS_TTL_MS) {
      return discovered.workspaces;
    }
    const found: LinearWorkspace[] = [];
    for (const [index, key] of keys.entries()) {
      try {
        const workspace = parseWorkspace(index, await post(key, WORKSPACE_QUERY, signal));
        if (workspace === null) once(`Linear key #${index + 1}: workspace lookup returned no workspace; its tickets get no Linear detail.`);
        else found.push(workspace);
      } catch (error) {
        if (signal.aborted) throw error;
        once(`Linear key #${index + 1}: workspace lookup failed (${errorText(error)}); its tickets get no Linear detail.`);
      }
    }
    const { duplicates } = routeTeams(found);
    for (const team of duplicates) once(`Linear team ${team} is visible to more than one key; using the first key that sees it.`);
    // A failed key may own any otherwise unclaimed prefix. Retry discovery on
    // the next scan rather than keeping a partial ownership map for a day.
    discovered = found.length === keys.length ? { at: now(), keyCount: keys.length, workspaces: found } : null;
    deps.log.info(`linear: ${found.length} of ${keys.length} key(s) resolved to a workspace, ${found.reduce((sum, one) => sum + one.teams.length, 0)} team(s)`);
    return found;
  }

  function readRows(tickets: readonly string[]): Map<string, { source: string; detail: LinearDetail | null; fetchedAt: number }> {
    const out = new Map<string, { source: string; detail: LinearDetail | null; fetchedAt: number }>();
    for (let index = 0; index < tickets.length; index += 500) {
      const slice = tickets.slice(index, index + 500);
      const rows = deps.db
        .prepare(`SELECT ticket, source, detail, fetched_at FROM linear_detail WHERE ticket IN (${slice.map(() => "?").join(",")})`)
        .all(...slice) as { ticket: string; source: string; detail: string | null; fetched_at: number }[];
      for (const row of rows) {
        let detail: LinearDetail | null = null;
        try {
          detail = row.detail === null ? null : (JSON.parse(row.detail) as LinearDetail);
        } catch {
          detail = null;
        }
        out.set(row.ticket, { source: row.source, detail, fetchedAt: row.fetched_at });
      }
    }
    return out;
  }

  /** Persist entries. A null detail records "no such issue" so it is not re-asked within the TTL. */
  function store(entries: readonly { ticket: string; detail: LinearDetail | null }[], source: "key" | "agent"): void {
    const upsert = deps.db.prepare(
      `INSERT INTO linear_detail (ticket, source, detail, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticket) DO UPDATE SET source = excluded.source, detail = excluded.detail, fetched_at = excluded.fetched_at`,
    );
    const at = now();
    deps.db.transaction(() => {
      for (const entry of entries) upsert.run(entry.ticket, source, entry.detail === null ? null : JSON.stringify(entry.detail), at);
    })();
  }

  return {
    /**
     * Every team key the keys can see, and whether EVERY key answered. The
     * caller keeps a partial answer out of anything that decides tickets.
     */
    async teams(keys: readonly string[], signal: AbortSignal): Promise<{ keys: string[]; names: Record<string, string>; complete: boolean }> {
      if (keys.length === 0) return { keys: [], names: {}, complete: true };
      const found = await workspaces(keys, signal);
      const { owner } = routeTeams(found);
      const names: Record<string, string> = {};
      for (const [team, index] of owner) {
        const name = found.find((workspace) => workspace.keyIndex === index)?.teamNames?.[team];
        if (name !== undefined) names[team] = name;
      }
      return { keys: [...owner.keys()].sort(), names, complete: found.length === keys.length };
    },

    /** Forget the discovered workspaces: the keys changed. */
    invalidate(): void {
      discovered = null;
    },

    /** Known detail for these tickets, from any source. Tickets Linear has no issue for are absent. */
    read(tickets: readonly string[]): Map<string, LinearDetail> {
      const out = new Map<string, LinearDetail>();
      for (const [ticket, row] of readRows(tickets)) if (row.detail !== null) out.set(ticket, row.detail);
      return out;
    },

    store,

    /**
     * Fetch detail for every ticket a key covers whose cache is missing or past
     * its TTL, batched per key. Never throws for a Linear failure: that is
     * logged once, the prior cache is kept, and the scan goes on. Returns the
     * tickets no key covers — the only ones the agent fallback may ask about.
     */
    async sync(keys: readonly string[], tickets: readonly string[], signal: AbortSignal): Promise<{ fetched: number; unowned: string[] }> {
      if (keys.length === 0) return { fetched: 0, unowned: [...tickets] };
      const found = await workspaces(keys, signal);
      const complete = found.length === keys.length;
      const { owner } = routeTeams(found);
      const { byKey, unowned } = planFetch(tickets, owner);
      const rows = readRows(tickets);
      const cutoff = now() - LINEAR_DETAIL_TTL_MS;
      let fetched = 0;
      for (const [index, owned] of byKey) {
        const key = keys[index];
        if (key === undefined) continue;
        // An agent-sourced row for a ticket a key now covers is replaced: the key is authoritative.
        const stale = owned.filter((ticket) => {
          const row = rows.get(ticket);
          return row === undefined || row.source !== "key" || row.fetchedAt < cutoff;
        });
        for (let start = 0; start < stale.length; start += LINEAR_BATCH) {
          const batch = stale.slice(start, start + LINEAR_BATCH);
          try {
            const details = parseDetails(batch, await post(key, detailQuery(batch), signal));
            if (details === null) {
              once(`Linear key #${index + 1}: an issue lookup returned no data; keeping the cached detail.`);
              break;
            }
            const entries = [...details].map(([ticket, detail]) => ({ ticket, detail }));
            if (entries.length < batch.length) {
              once(`Linear key #${index + 1}: an issue lookup returned partial data; missing tickets will be retried.`);
            }
            if (entries.length > 0) store(entries, "key");
            fetched += entries.length;
          } catch (error) {
            if (signal.aborted) throw error;
            once(`Linear key #${index + 1}: issue lookup failed (${errorText(error)}); keeping the cached detail.`);
            break;
          }
        }
      }
      if (fetched > 0) deps.log.info(`linear: fetched ${fetched} ticket(s)`);
      return { fetched, unowned: complete ? unowned : [] };
    },

    /** Tickets no key covers, using the last discovery (running one if there is none yet). */
    async unowned(keys: readonly string[], tickets: readonly string[], signal: AbortSignal): Promise<string[]> {
      if (keys.length === 0) return [...tickets];
      const found = await workspaces(keys, signal);
      return found.length === keys.length ? planFetch(tickets, routeTeams(found).owner).unowned : [];
    },
  };
}

/** An error, reduced to a line that cannot carry a request header. */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/gu, "[key]").slice(0, 120);
}
