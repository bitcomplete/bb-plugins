// PR board backend: refresh the board on load and every 5 minutes, keep the last good copy, serve it,
// and start one agent thread per PR when the user confirms a playbook.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi, type JsonValue } from "@get-bb/plugin-sdk";
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
import { afterRefresh, busyKeys, isLiveStatus, markerSchema, toView, type Marker, type ThreadInfo, parseQuestion } from "./markers.js";
import { prsSnapshotSchema, prsReviewSchema, reviewsStateSchema, reviewTargetsSchema, reviewStartSchema, reviewBatchSchema, reviewPollSchema } from "./reviews.js";
import { reviewerOptions, requestReview, reviewerOptionsSchema, type Github } from "./reviewers.js";

/** Where started threads run: the Parsley project, on Claude Code with Opus at xhigh reasoning. */
export const THREAD_DEFAULTS = {
  projectId: "proj_9itb3ud9c5",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "xhigh",
} as const;
/** At most this many threads start per click; the rest of a selection is left for later. */
export const MAX_START = 5;
export const MIGRATIONS = [
  "CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
  "CREATE TABLE board_cache (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
];

const startItemSchema = z.object({ key: z.string().min(1), action: actionSchema });
export const rpcContract = defineRpcContract({
  prs_integration: { input: z.null(), output: z.object({ version: z.literal(1) }) },
  reviews_get: { input: z.null(), output: reviewsStateSchema },
  reviews_detail: { input: z.object({ key: z.string().min(1) }), output: prsReviewSchema },
  reviews_targets: { input: z.object({ keys: z.array(z.string().min(1)).min(1) }), output: reviewTargetsSchema },
  reviews_start: { input: z.object({ key: z.string().min(1), projectId: z.string().min(1).optional() }), output: reviewStartSchema },
  reviews_batch: { input: z.object({ keys: z.array(z.string().min(1)).min(1), projectId: z.string().min(1).optional() }), output: reviewBatchSchema },
  reviews_dismiss: { input: z.object({ key: z.string().min(1) }), output: reviewStartSchema },
  reviews_refresh: { input: z.null(), output: reviewPollSchema },
  answer: { input: z.object({ key: z.string(), questionId: z.string(), optionId: z.string() }), output: z.object({ sent: z.literal(true) }) },
  reviewers_get: { input: z.object({ keys: z.array(z.string()).min(1).max(100) }), output: z.array(reviewerOptionsSchema) },
  reviewers_request: { input: z.object({ requests: z.array(z.object({ key: z.string(), reviewers: z.array(z.string()).min(1).max(10) })).min(1).max(100) }), output: z.object({ sent: z.array(z.string()), skipped: z.array(z.object({ key: z.string(), reason: z.string() })) }) },
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

export function createPlugin(options: { runner?: Runner; github?: Github } = {}) {
  return async function plugin(bb: BbPluginApi) {
    const runner = options.runner ?? pythonRunner();
    const lifecycle = new AbortController();
    bb.onDispose(() => lifecycle.abort());
    const signal = lifecycle.signal;
    const github: Github = options.github ?? (async (args) => {
      const { stdout } = await promisify(execFile)("gh", args, { signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    });
    const changed = () => bb.realtime.publish(BOARD_CHANGED, {});

    // The last data.json, so the board can be redrawn when markers change without refetching GitHub.
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const readSnapshot = () => {
      const row = z.object({ body: z.string() }).safeParse(db.prepare("SELECT body FROM snapshot WHERE id = 1").get());
      return row.success ? row.data.body : null;
    };
    const saveSnapshot = (body: string) =>
      db.prepare("INSERT OR REPLACE INTO snapshot (id, body) VALUES (1, ?)").run(body);

    async function saveSaved(saved: Saved): Promise<void> {
      db.prepare("INSERT OR REPLACE INTO board_cache (id, body) VALUES (1, ?)").run(JSON.stringify(saved));
      await bb.storage.kv.delete("board");
    }
    async function readSaved(): Promise<Saved> {
      const row = z.object({ body: z.string() }).safeParse(db.prepare("SELECT body FROM board_cache WHERE id = 1").get());
      if (row.success) return savedSchema.parse(JSON.parse(row.data.body));
      const legacy = savedSchema.safeParse(await bb.storage.kv.get<unknown>("board"));
      if (legacy.success) {
        // Concurrent first reads must not replace a newer refresh with the legacy copy.
        db.prepare("INSERT OR IGNORE INTO board_cache (id, body) VALUES (1, ?)").run(JSON.stringify(legacy.data));
        await bb.storage.kv.delete("board");
        return readSaved();
      }
      return { view: null, lastSuccess: null, lastError: null };
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
          : m.answering ? { ...m, answerError: "Answer delivery was interrupted. Open the thread before answering again." } : m,
      ),
      result: null,
    }));

    // Older saved boards predate the canonical rows. Rebuild from our own saved snapshot offline.
    const hasSavedBoard = db.prepare("SELECT 1 FROM board_cache WHERE id = 1").get() !== undefined;
    const old = z.object({ view: z.object({ prs: z.unknown().optional() }).nullable(), lastSuccess: z.string().nullable(), lastError: z.string().nullable() }).safeParse(hasSavedBoard ? null : await bb.storage.kv.get<unknown>("board"));
    if (old.success && old.data.view && old.data.view.prs === undefined) {
      const data = readSnapshot();
      if (data !== null) {
        try {
          const view = await runner.view(data, busyKeys(await readMarkers()), signal);
          await saveSaved({ view, lastSuccess: old.data.lastSuccess, lastError: old.data.lastError });
        } catch (cause) { bb.log.warn(`saved board upgrade failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    }

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

    async function recordQuestion(threadId: string, output: string | null, expected?: { questionId: string | null; answering: string | null }) {
      const result = parseQuestion(output);
      if (result.kind === "invalid") return;
      await updateMarkers((markers) => ({
        markers: markers.map((marker) => {
          if (marker.threadId !== threadId) return marker;
          // An output read that began before a newer question/claim cannot overwrite it.
          if (expected && ((marker.question?.id ?? null) !== expected.questionId || marker.answering !== expected.answering)) return marker;
          const question = result.question;
          if (question && (marker.answeredQuestions.includes(question.id) || (marker.answering && marker.question?.id === question.id))) return marker;
          const retired = marker.question && marker.question.id !== question?.id ? [marker.question.id] : [];
          return { ...marker, question, answering: null, answerError: null,
            answeredQuestions: [...new Set([...marker.answeredQuestions, ...retired, ...(marker.answering ? [marker.answering] : [])])].slice(-50) };
        }), result: null,
      }));
    }
    const outputVersions = new Map<string, string>();
    async function discoverQuestions(markers: Marker[], threads: Record<string, ThreadInfo>) {
      await Promise.all(markers.map(async (marker) => {
        if (marker.status !== "started" || marker.threadId === null || (marker.answering && !marker.answerError)) return;
        const info = threads[marker.threadId];
        if (!info || info.live || outputVersions.get(marker.threadId) === info.updatedAt) return;
        try {
          const { output } = await bb.sdk.threads.output({ threadId: marker.threadId, signal });
          await recordQuestion(marker.threadId, output, { questionId: marker.question?.id ?? null, answering: marker.answering });
          outputVersions.set(marker.threadId, info.updatedAt);
        } catch { /* Older/missing threads keep their open-thread fallback. */ }
      }));
    }
    bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
      if (!(await readMarkers()).some((marker) => marker.threadId === thread.id)) return;
      await recordQuestion(thread.id, lastAssistantText);
      outputVersions.set(thread.id, new Date(thread.updatedAt).toISOString());
      changed();
    });
    const threadChanged = async ({ thread }: { thread: { id: string } }) => {
      if ((await readMarkers()).some((marker) => marker.threadId === thread.id)) changed();
    };
    bb.events.on("thread.active", threadChanged);
    bb.events.on("thread.failed", threadChanged);
    let running: Promise<void> | null = null;
    async function read(): Promise<BoardState> {
      let markers = await readMarkers();
      const threads = await threadInfos(markers);
      await discoverQuestions(markers, threads);
      markers = await readMarkers();
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
        await saveSaved({ ...(await readSaved()), view });
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
        const currentMarkers = await readMarkers();
        const threads = await threadInfos(currentMarkers);
        await discoverQuestions(currentMarkers, threads);
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
      await saveSaved(next);
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
      const base = { key: item.key, action: item.action, threadId: null, title: null, head: null, move: null, reason: null, question: null, answeredQuestions: [], answering: null, answerError: null };
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
                reason: `could not re-check the PR on GitHub: ${lastError ?? "no data yet"}`, question: null, answeredQuestions: [], answering: null, answerError: null }
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
        const skipped: { key: string; reason: string }[] = items.slice(MAX_START).map((item) => ({ key: item.key, reason: `at most ${MAX_START} agents start per click` }));
        for (const item of taken) {
          if (busy.has(item.key)) skipped.push({ key: item.key, reason: "an agent is already on it" });
          else {
            busy.add(item.key);
            starting.push(item);
          }
        }
        const at = new Date().toISOString();
        const added = starting.map((item): Marker => ({ ...item, status: "starting", at, threadId: null, title: null, head: null, move: null, reason: null, question: null, answeredQuestions: [], answering: null, answerError: null }));
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

    async function answer({ key, questionId, optionId }: { key: string; questionId: string; optionId: string }) {
      const claimed = await updateMarkers((markers) => {
        const marker = markers.find((item) => item.key === key);
        if (!marker || !marker.threadId || marker.question?.id !== questionId || marker.answering) throw new Error("This question is no longer available.");
        const option = marker.question.options.find((item) => item.id === optionId);
        if (!option) throw new Error("Choose one of the question's options.");
        return { markers: markers.map((item) => item.key === key ? { ...item, answering: questionId } : item), result: { threadId: marker.threadId, option } };
      });
      changed();
      let attempted = false;
      try {
        const info = await threadInfo(claimed.threadId);
        if (!info || info.live) throw new Error("The thread is already working or unavailable. Open it to continue.");
        await updateMarkers((markers) => {
          const current = markers.find((item) => item.key === key);
          if (current?.question?.id !== questionId || current.answering !== questionId) throw new Error("This question is no longer available.");
          return { markers, result: null };
        });
        attempted = true;
        await bb.sdk.threads.send({ threadId: claimed.threadId, mode: "start", input: [{ type: "text", text: claimed.option.message, mentions: [] }] });
        await updateMarkers((markers) => ({ markers: markers.map((item) => item.key === key
          ? { ...item, question: item.question?.id === questionId ? null : item.question,
            answering: item.answering === questionId ? null : item.answering,
            answerError: item.answering === questionId ? null : item.answerError,
            answeredQuestions: [...new Set([...item.answeredQuestions, questionId])].slice(-50) } : item), result: null }));
        return { sent: true as const };
      } catch (cause) {
        await updateMarkers((markers) => ({ markers: markers.map((item) => item.key === key && item.answering === questionId && item.question?.id === questionId ? { ...item, answering: attempted ? questionId : null,
          answerError: attempted ? "Could not confirm answer delivery. Open the thread before answering again." : null } : item), result: null }));
        throw cause;
      } finally { changed(); }
    }
    const reviewCall = <T>(method: string, outputSchema: z.ZodType<T>, input: JsonValue = null) =>
      bb.sdk.plugins.callRpc({ pluginId: "review-watch", method, input, outputSchema, signal });
    const reviewWrite = async <T>(method: string, outputSchema: z.ZodType<T>, input: JsonValue = null) => {
      const result = await reviewCall(method, outputSchema, input);
      changed();
      return result;
    };
    async function reviewerContext() {
      const snapshot = readSnapshot();
      const login = snapshot === null ? null : z.object({ login: z.string() }).safeParse(JSON.parse(snapshot));
      const view = (await readSaved()).view;
      if (!login || !login.success || !view) throw new Error("Refresh the board before choosing reviewers.");
      return { author: login.data.login, rows: view.prs };
    }
    const requesting = new Set<string>();
    bb.rpc.register(rpcContract, {
      board_get: read, board_refresh: refresh, start, answer,
      prs_integration: () => ({ version: 1 as const }),
      reviews_get: async () => {
        try { return { kind: "available" as const, snapshot: await reviewCall("prs_snapshot", prsSnapshotSchema) }; }
        catch (cause) { return { kind: "unavailable" as const, reason: cause instanceof Error ? cause.message : "Review Watch unavailable" }; }
      },
      reviews_detail: (input) => reviewCall("prs_detail", prsReviewSchema, input),
      reviews_targets: (input) => reviewCall("review_targets", reviewTargetsSchema, input),
      reviews_start: (input) => reviewWrite("item_start", reviewStartSchema, input),
      reviews_batch: (input) => reviewWrite("item_batch_start", reviewBatchSchema, input),
      reviews_dismiss: (input) => reviewWrite("item_dismiss", reviewStartSchema, input),
      reviews_refresh: () => reviewWrite("poll_now", reviewPollSchema),
      reviewers_get: async ({ keys }, context) => {
        const { author, rows } = await reviewerContext();
        const targets = keys.map((key) => {
          const row = rows.find((item) => item.key === key);
          if (!row || row.group !== "one-click") throw new Error("This PR no longer needs a review request.");
          return row;
        });
        // Reuse repository reads, including missing CODEOWNERS paths, only for this operation.
        const reads = new Map<string, Promise<string>>();
        const read: Github = (args) => {
          context.experimental_signal.throwIfAborted();
          const key = JSON.stringify(args);
          const previous = reads.get(key);
          if (previous) return previous;
          const result = github(args);
          reads.set(key, result);
          return result;
        };
        const options: z.infer<typeof reviewerOptionsSchema>[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
          while (next < targets.length) {
            context.experimental_signal.throwIfAborted();
            const index = next++;
            options[index] = await reviewerOptions(read, targets[index], author, rows);
          }
        }));
        return options;
      },
      reviewers_request: async ({ requests }) => {
        const sent: string[] = [], skipped: { key: string; reason: string }[] = [];
        const claimed = requests.filter((request) => {
          if (requesting.has(request.key)) { skipped.push({ key: request.key, reason: "A review request is already sending." }); return false; }
          requesting.add(request.key);
          return true;
        });
        if (!claimed.length) return { sent, skipped };
        try {
          await freshRefresh();
          if ((await readSaved()).lastError) throw new Error("Could not re-check GitHub. No review requests sent.");
          const { author, rows } = await reviewerContext();
          for (const request of claimed) {
            try {
              const row = rows.find((item) => item.key === request.key);
              if (!row) throw new Error("The PR is no longer open.");
              await requestReview(github, row, request.reviewers, author, rows);
              sent.push(request.key);
            } catch (cause) { skipped.push({ key: request.key, reason: cause instanceof Error ? cause.message : String(cause) }); }
          }
          if (sent.length) await refresh();
          changed();
          return { sent, skipped };
        } finally { for (const request of claimed) requesting.delete(request.key); }
      },
    });

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
