// PR board backend: refresh the board on load and every 5 minutes, keep the last good copy, serve it,
// and start one agent thread per PR when the user confirms a playbook.
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  actionSchema,
  pythonRunner,
  stateSchema,
  stopSchema,
  type Action,
  type BoardState,
  type Runner,
  type Stop,
} from "./board.js";
import { boardText } from "./format.js";
import { afterRefresh, busyKeys, isLiveStatus, markerSchema, toView, type Marker, type ThreadInfo } from "./markers.js";

/** Where started threads run: the Parsley project, on Claude Code with Opus at xhigh reasoning. */
export const THREAD_DEFAULTS = {
  projectId: "proj_9itb3ud9c5",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "xhigh",
} as const;
/** At most this many threads start per click; the rest of a selection is left for later. */
export const MAX_START = 5;

const startItemSchema = z.object({ key: z.string().min(1), action: actionSchema });
export const rpcContract = defineRpcContract({
  board_get: { input: z.null(), output: stateSchema },
  board_refresh: { input: z.null(), output: stateSchema },
  start: {
    input: z.object({ items: z.array(startItemSchema).min(1).max(100), stop: stopSchema }),
    output: z.object({
      starting: z.array(z.string()),
      skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
    }),
  },
});

/** Realtime channel: the stored board, markers or the refreshing flag changed; clients refetch board_get. */
export const BOARD_CHANGED = "board-changed";
const INTERVAL_MS = 5 * 60_000;
const savedSchema = stateSchema.pick({ view: true, lastSuccess: true, lastError: true });
type Saved = z.infer<typeof savedSchema>;
const snapshotPrsSchema = z.object({
  prs: z.record(z.string(), z.object({ head_oid: z.string(), move: z.string() }).passthrough()),
});

export function createPlugin(options: { runner?: Runner } = {}) {
  return async function plugin(bb: BbPluginApi) {
    const runner = options.runner ?? pythonRunner();
    const lifecycle = new AbortController();
    bb.onDispose(() => lifecycle.abort());
    const signal = lifecycle.signal;
    const changed = () => bb.realtime.publish(BOARD_CHANGED, {});

    // The last data.json, so the board can be redrawn when markers change without refetching GitHub.
    const db = bb.storage.database();
    bb.storage.migrate(db, ["CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)"]);
    const readSnapshot = () => {
      const row = z.object({ body: z.string() }).safeParse(db.prepare("SELECT body FROM snapshot WHERE id = 1").get());
      return row.success ? row.data.body : null;
    };
    const saveSnapshot = (body: string) =>
      db.prepare("INSERT OR REPLACE INTO snapshot (id, body) VALUES (1, ?)").run(body);

    async function readSaved(): Promise<Saved> {
      const saved = savedSchema.safeParse(await bb.storage.kv.get<unknown>("board"));
      return saved.success ? saved.data : { view: null, lastSuccess: null, lastError: null };
    }

    // Marker writes are serialized so a refresh and a start never overwrite each other.
    let markerQueue: Promise<unknown> = Promise.resolve();
    async function readMarkers(): Promise<Marker[]> {
      const parsed = z.array(markerSchema).safeParse(await bb.storage.kv.get<unknown>("markers"));
      return parsed.success ? parsed.data : [];
    }
    function updateMarkers<T>(change: (markers: Marker[]) => { markers: Marker[]; result: T }): Promise<T> {
      const next = markerQueue.then(async () => {
        const { markers, result } = change(await readMarkers());
        await bb.storage.kv.set("markers", markers);
        return result;
      });
      markerQueue = next.catch(() => undefined);
      return next;
    }
    // A start that was cut off by a reload may or may not have created its thread.
    await updateMarkers((markers) => ({
      markers: markers.map((m): Marker =>
        m.status === "starting"
          ? { ...m, status: "refused", at: new Date().toISOString(), reason: "the start was interrupted; check your threads before trying again" }
          : m,
      ),
      result: null,
    }));

    async function threadInfo(threadId: string): Promise<ThreadInfo> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { live: isLiveStatus(thread.status), updatedAt: new Date(thread.updatedAt).toISOString() };
      } catch {
        return null;
      }
    }
    async function threadInfos(markers: Marker[]): Promise<Record<string, ThreadInfo>> {
      const ids = [...new Set(markers.flatMap((m) => (m.threadId ? [m.threadId] : [])))];
      return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await threadInfo(id)] as const)));
    }

    let running: Promise<void> | null = null;
    async function read(): Promise<BoardState> {
      const markers = await readMarkers();
      const threads = await threadInfos(markers);
      return {
        ...(await readSaved()),
        refreshing: running !== null,
        markers: markers.map((m) => toView(m, m.threadId ? threads[m.threadId] : undefined)),
      };
    }

    /** Redraw the stored board from the last snapshot, e.g. after markers change which PRs are busy. */
    async function rerender() {
      const data = readSnapshot();
      if (data === null) return;
      try {
        const view = await runner.view(data, busyKeys(await readMarkers()), signal);
        await bb.storage.kv.set("board", { ...(await readSaved()), view });
      } catch (cause) {
        bb.log.warn(`redraw failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    async function work() {
      const startedAt = new Date().toISOString();
      const previous = await readSaved();
      let next: Saved;
      try {
        const data = await runner.fetch(signal);
        saveSnapshot(data);
        const prs = snapshotPrsSchema.parse(JSON.parse(data)).prs;
        const threads = await threadInfos(await readMarkers());
        const markers = await updateMarkers((current) => {
          const kept = afterRefresh(current, prs, threads, startedAt);
          return { markers: kept, result: kept };
        });
        next = { view: await runner.view(data, busyKeys(markers), signal), lastSuccess: new Date().toISOString(), lastError: null };
      } catch (cause) {
        if (signal.aborted) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`refresh failed: ${error}`);
        next = { view: previous.view, lastSuccess: previous.lastSuccess, lastError: error };
      }
      await bb.storage.kv.set("board", next);
    }

    /** Runs one refresh, or joins the one in flight; runs never overlap. */
    async function refresh(): Promise<BoardState> {
      if (!running) {
        running = work().finally(() => {
          running = null;
          changed();
        });
        changed();
      }
      await running;
      return read();
    }

    /** A refresh that starts after this call, so its data is at least as new as the click. */
    async function freshRefresh() {
      if (running) await running;
      await refresh();
    }

    async function startOne(data: string, item: { key: string; action: Action }, stop: Stop): Promise<Marker> {
      const now = () => new Date().toISOString();
      const base = { key: item.key, action: item.action, threadId: null, title: null, head: null, move: null, reason: null };
      try {
        const prepared = await runner.prepare(data, { key: item.key, expect: item.action, stop }, signal);
        if (!prepared.ok) return { ...base, status: "refused", at: now(), reason: prepared.reason };
        const thread = await bb.sdk.threads.spawn({
          ...THREAD_DEFAULTS,
          environment: { type: "project-default" },
          title: prepared.title,
          prompt: prepared.prompt,
          pluginMetadata: { pr: item.key, action: item.action, stop },
        });
        return { ...base, status: "started", at: now(), threadId: thread.id, title: prepared.title, head: prepared.head_oid, move: prepared.move };
      } catch (cause) {
        return { ...base, status: "refused", at: now(), reason: cause instanceof Error ? cause.message : String(cause) };
      }
    }

    async function startJob(items: { key: string; action: Action }[], stop: Stop) {
      await freshRefresh();
      const { lastError } = await readSaved();
      const data = readSnapshot();
      for (const item of items) {
        const marker: Marker =
          lastError !== null || data === null
            ? { key: item.key, action: item.action, status: "refused", at: new Date().toISOString(), threadId: null, title: null, head: null, move: null,
                reason: `could not re-check the PR on GitHub: ${lastError ?? "no data yet"}` }
            : await startOne(data, item, stop);
        await updateMarkers((markers) => ({ markers: [...markers.filter((m) => m.key !== item.key), marker], result: null }));
        changed();
      }
      await rerender();
      changed();
    }

    let jobs: Promise<void> = Promise.resolve();
    async function start({ items, stop }: { items: { key: string; action: Action }[]; stop: Stop }) {
      const taken = items.slice(0, MAX_START);
      const { starting, skipped } = await updateMarkers((markers) => {
        const busy = new Set(busyKeys(markers));
        const starting: { key: string; action: Action }[] = [];
        const skipped: { key: string; reason: string }[] = [];
        for (const item of taken) {
          if (busy.has(item.key)) skipped.push({ key: item.key, reason: "an agent is already on it" });
          else {
            busy.add(item.key);
            starting.push(item);
          }
        }
        const at = new Date().toISOString();
        const added = starting.map((item): Marker => ({ ...item, status: "starting", at, threadId: null, title: null, head: null, move: null, reason: null }));
        const keys = new Set(starting.map((item) => item.key));
        return { markers: [...markers.filter((m) => !keys.has(m.key)), ...added], result: { starting, skipped } };
      });
      if (starting.length > 0) {
        changed();
        jobs = jobs.then(() => startJob(starting, stop)).catch((cause: unknown) => {
          bb.log.error(`start failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
      return { starting: starting.map((item) => item.key), skipped };
    }

    bb.rpc.register(rpcContract, { board_get: read, board_refresh: refresh, start });

    bb.cli.register({
      name: "pr-board",
      summary: "Show the plain-language board of your open GitHub PRs",
      commands: [
        { name: "show", summary: "Print the board (default); --json prints the view model", usage: "bb pr-board [show] [--json]" },
        { name: "refresh", summary: "Fetch from GitHub now, then print the board", usage: "bb pr-board refresh [--json]" },
      ],
      async run(argv) {
        const json = argv.includes("--json");
        const [command = "show", ...rest] = argv.filter((arg) => arg !== "--json");
        if (rest.length > 0 || (command !== "show" && command !== "refresh")) {
          return { exitCode: 1, stderr: "Usage: bb pr-board [show|refresh] [--json]" };
        }
        const state = command === "refresh" ? await refresh() : await read();
        const failed = command === "refresh" && state.lastError !== null;
        return {
          exitCode: failed || state.view === null ? 1 : 0,
          stdout: json ? JSON.stringify(state.view) : boardText(state),
          ...(json && state.lastError ? { stderr: `Last refresh failed: ${state.lastError}` } : {}),
        };
      },
    });

    bb.background.service("refresh", {
      async start(serviceSignal) {
        serviceSignal.addEventListener("abort", () => lifecycle.abort(), { once: true }); // stop an in-flight run too
        while (!serviceSignal.aborted) {
          await refresh();
          try {
            await delay(INTERVAL_MS, undefined, { signal: serviceSignal });
          } catch (cause) {
            if (!serviceSignal.aborted) throw cause;
          }
        }
      },
    });
  };
}

export default createPlugin();
