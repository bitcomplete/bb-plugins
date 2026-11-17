// PR board backend: refresh the board on load and every 5 minutes, keep the last good copy, serve it,
// and start one coordinator thread for an authorized selection of PR playbooks.
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
import { batchPrompt, type PreparedTask } from "./batch-prompt.js";
import { registerAgentTools, type PrepareInput } from "./agent-tools.js";
import { agentModelSchema, DEFAULT_AGENT_MODEL, normalizeAgentModel, agentModelRouting, validateAgentModel, type AgentModelChoice } from "./agent-model.js";
import { afterRefresh, busyKeys, isLiveStatus, markerSchema, toView, type Marker, type ThreadInfo, parseQuestion } from "./markers.js";
import { prsSnapshotSchema, prsReviewSchema, reviewsStateSchema, reviewTargetsSchema, reviewStartSchema, reviewBatchSchema, reviewPollSchema } from "./reviews.js";
import { reviewerOptions, requestReview, reviewerOptionsSchema, type Github } from "./reviewers.js";
import { recordReports, type ReportInput } from "./reports.js";

/** Fix and review starts share the saved agent choice, initially Codex Sol at xhigh. */
export const THREAD_DEFAULTS = {
  projectId: "proj_9itb3ud9c5",
  ...DEFAULT_AGENT_MODEL,
} as const;
export const MIGRATIONS = [
  "CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
  "CREATE TABLE board_cache (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
  "CREATE TABLE marker_cache (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)",
];

const startItemSchema = z.object({ key: z.string().min(1), action: actionSchema });
export const rpcContract = defineRpcContract({
  agent_model_get: { input: z.null(), output: z.object({ choice: agentModelSchema, routing: z.object({ kind: z.literal("host"), hostId: z.string().min(1) }) }) },
  agent_model_set: { input: agentModelSchema, output: agentModelSchema },
  prs_integration: { input: z.null(), output: z.object({ version: z.literal(1) }) },
  reviews_get: { input: z.null(), output: reviewsStateSchema },
  reviews_detail: { input: z.object({ key: z.string().min(1) }), output: prsReviewSchema },
  reviews_targets: { input: z.object({ keys: z.array(z.string().min(1)).min(1) }), output: reviewTargetsSchema },
  reviews_start: { input: z.object({ key: z.string().min(1), projectId: z.string().min(1).optional(), agentModel: agentModelSchema.optional() }), output: reviewStartSchema },
  reviews_batch: { input: z.object({ keys: z.array(z.string().min(1)).min(1), projectId: z.string().min(1).optional(), agentModel: agentModelSchema.optional() }), output: reviewBatchSchema },
  reviews_dismiss: { input: z.object({ key: z.string().min(1) }), output: reviewStartSchema },
  reviews_refresh: { input: z.null(), output: reviewPollSchema },
  answer: { input: z.object({ key: z.string(), questionId: z.string(), optionId: z.string() }), output: z.object({ sent: z.literal(true) }) },
  reviewers_get: { input: z.object({ keys: z.array(z.string()).min(1).max(100) }), output: z.array(reviewerOptionsSchema) },
  reviewers_request: { input: z.object({ requests: z.array(z.object({ key: z.string(), reviewers: z.array(z.string()).min(1).max(10) })).min(1).max(100) }), output: z.object({ sent: z.array(z.string()), skipped: z.array(z.object({ key: z.string(), reason: z.string() })) }) },
  board_get: { input: z.null(), output: stateSchema },
  board_refresh: { input: z.null(), output: stateSchema },
  start: {
    input: z.object({ items: z.array(startItemSchema).min(1).max(100), stop: stopSchema, agentModel: agentModelSchema.optional() }),
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
    async function agentModel(): Promise<AgentModelChoice> {
      const saved = await bb.storage.kv.get<unknown>("agent-model");
      return saved === undefined || saved === null ? { ...DEFAULT_AGENT_MODEL } : normalizeAgentModel(agentModelSchema.parse(saved));
    }
    async function saveAgentModel(input: AgentModelChoice, requestSignal: AbortSignal = signal) {
      const choice = normalizeAgentModel(input);
      await validateAgentModel(bb, choice, THREAD_DEFAULTS.projectId, requestSignal);
      requestSignal.throwIfAborted();
      await bb.storage.kv.set("agent-model", choice);
      bb.realtime.publish("agent-model-changed", {});
      return choice;
    }

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
      await initialize();
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
    async function readStoredMarkers(): Promise<Marker[]> {
      const row = z.object({ body: z.string() }).safeParse(db.prepare("SELECT body FROM marker_cache WHERE id = 1").get());
      if (row.success) return z.array(markerSchema).parse(JSON.parse(row.data.body));
      const legacy = z.array(markerSchema).safeParse(await bb.storage.kv.get<unknown>("markers"));
      if (!legacy.success) return [];
      // A late legacy read must not overwrite a newer marker write.
      db.prepare("INSERT OR IGNORE INTO marker_cache (id, body) VALUES (1, ?)").run(JSON.stringify(legacy.data));
      await bb.storage.kv.delete("markers");
      return readStoredMarkers();
    }
    async function writeStoredMarkers(markers: Marker[]) {
      db.prepare("INSERT OR REPLACE INTO marker_cache (id, body) VALUES (1, ?)").run(JSON.stringify(markers));
      await bb.storage.kv.delete("markers");
    }
    let initialization: Promise<void> | null = null;
    function initialize(): Promise<void> {
      // Candidate factories run while the old generation can still write KV.
      // Only activated handlers/services initialize; a rejected candidate moves no data.
      if (!initialization) initialization = initializeStoredState().catch((cause) => {
        initialization = null;
        throw cause;
      });
      return initialization;
    }
    async function initializeStoredState() {
      const markers = (await readStoredMarkers()).map((m): Marker =>
        m.status === "starting"
          ? { ...m, status: "refused", at: new Date().toISOString(), reason: "the start was interrupted; check your threads before trying again" }
          : m.answering ? { ...m, answerError: "Answer delivery was interrupted. Open the thread before answering again." } : m,
      );
      await writeStoredMarkers(markers);

      // Older saved boards predate canonical rows. Upgrade offline after activation too.
      const hasSavedBoard = db.prepare("SELECT 1 FROM board_cache WHERE id = 1").get() !== undefined;
      const old = z.object({ view: z.object({ prs: z.unknown().optional() }).nullable(), lastSuccess: z.string().nullable(), lastError: z.string().nullable() }).safeParse(hasSavedBoard ? null : await bb.storage.kv.get<unknown>("board"));
      if (old.success && old.data.view && old.data.view.prs === undefined) {
        const data = readSnapshot();
        if (data !== null) {
          try {
            const view = await runner.view(data, busyKeys(markers), signal);
            await saveSaved({ view, lastSuccess: old.data.lastSuccess, lastError: old.data.lastError });
          } catch (cause) { bb.log.warn(`saved board upgrade failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      }
    }
    async function readMarkers(): Promise<Marker[]> {
      await initialize();
      return readStoredMarkers();
    }
    function updateMarkers<T>(change: (markers: Marker[]) => { markers: Marker[]; result: T }): Promise<T> {
      const next = markerQueue.then(async () => {
        await initialize();
        const { markers, result } = change(await readStoredMarkers());
        await writeStoredMarkers(markers);
        return result;
      });
      markerQueue = next.catch(() => undefined);
      return next;
    }
    async function report(threadId: string, input: ReportInput, requestSignal: AbortSignal) {
      const result = await updateMarkers((markers) => {
        requestSignal.throwIfAborted();
        const recorded = recordReports(markers, threadId, input);
        return { markers: recorded.assignments, result: recorded.result };
      });
      changed();
      return result;
    }

    async function pendingInput(threadIds: string[]): Promise<Record<string, boolean>> {
      try {
        const ids = [...new Set(threadIds)];
        const batches = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          batches.push(bb.sdk.threads.list({ threadIds: ids.slice(offset, offset + 200), includeHidden: true, limit: 200, signal }));
        }
        return Object.fromEntries((await Promise.all(batches)).flat().map((thread) => [thread.id, thread.hasPendingInteraction]));
      } catch {
        return {};
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

    async function recordQuestion(threadId: string, output: string | null, expected?: { key: string; questionId: string | null; answering: string | null }[]): Promise<"settled" | "stale"> {
      const result = parseQuestion(output);
      if (result.kind === "invalid") return "settled";
      return updateMarkers<"settled" | "stale">((markers) => {
        const related = markers.filter((marker) => marker.threadId === threadId);
        if (expected && (related.length !== expected.length || expected.some((previous) => !related.some((marker) => marker.key === previous.key &&
          (marker.question?.id ?? null) === previous.questionId && marker.answering === previous.answering)))) return { markers, result: "stale" };
        return { markers: markers.map((marker) => {
          if (marker.threadId !== threadId) return marker;
          const question = result.question;
          if (question && (marker.answeredQuestions.includes(question.id) || (marker.answering && marker.question?.id === question.id))) return marker;
          const retired = marker.question && marker.question.id !== question?.id ? [marker.question.id] : [];
          return { ...marker, question, answering: null, answerError: null,
            answeredQuestions: [...new Set([...marker.answeredQuestions, ...retired, ...(marker.answering ? [marker.answering] : [])])].slice(-50) };
        }), result: "settled" };
      });
    }
    const outputVersions = new Map<string, string>();
    async function discoverQuestions(markers: Marker[], threads: Record<string, ThreadInfo>) {
      const groups = new Map<string, Marker[]>();
      for (const marker of markers) {
        if (marker.status !== "started" || marker.threadId === null) continue;
        const group = groups.get(marker.threadId) ?? [];
        group.push(marker);
        groups.set(marker.threadId, group);
      }
      await Promise.all([...groups].map(async ([threadId, group]) => {
        if (group.some((marker) => marker.answering && !marker.answerError)) return;
        const info = threads[threadId];
        if (!info || info.live || outputVersions.get(threadId) === info.updatedAt) return;
        try {
          const { output } = await bb.sdk.threads.output({ threadId, signal });
          const expected = group.map((marker) => ({ key: marker.key, questionId: marker.question?.id ?? null, answering: marker.answering }));
          if (await recordQuestion(threadId, output, expected) !== "stale") outputVersions.set(threadId, info.updatedAt);
        } catch { /* Older/missing threads keep their open-thread fallback. */ }
      }));
    }
    bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
      if (!(await readMarkers()).some((marker) => marker.threadId === thread.id)) return;
      await recordQuestion(thread.id, lastAssistantText);
      outputVersions.set(thread.id, new Date(thread.updatedAt).toISOString());
      changed();
    });
    let reviewThreadIds = new Set<string>();
    const threadChanged = async ({ thread }: { thread: { id: string } }) => {
      if ((await readMarkers()).some((marker) => marker.threadId === thread.id)) changed();
    };
    bb.events.on("thread.active", threadChanged);
    bb.events.on("thread.failed", threadChanged);
    bb.events.on("interaction.pending", async (event) => {
      if (reviewThreadIds.has(event.thread.id)) changed();
      else await threadChanged(event);
    });
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
        needsInput: await pendingInput(markers.flatMap((marker) => marker.threadId ? [marker.threadId] : [])),
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

    async function startJob(items: { key: string; action: Action }[], stop: Stop, choice: AgentModelChoice) {
      await freshRefresh();
      const { lastError } = await readSaved();
      const data = readSnapshot();
      const prepared: PreparedTask[] = [];
      const outcomes: Marker[] = [];
      const base = (item: { key: string; action: Action }) => ({ key: item.key, action: item.action, at: new Date().toISOString(), threadId: null, title: null, head: null, move: null,
        reason: null, question: null, answeredQuestions: [], answering: null, answerError: null, report: null });
      for (const item of items) {
        try {
          if (lastError !== null || data === null) throw new Error(`could not re-check the PR on GitHub: ${lastError ?? "no data yet"}`);
          const result = await runner.prepare(data, { key: item.key, expect: item.action, stop }, signal);
          if (result.ok) prepared.push({ ...item, prepared: result });
          else outcomes.push({ ...base(item), status: "refused", reason: result.reason });
        } catch (cause) {
          outcomes.push({ ...base(item), status: "refused", reason: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      if (prepared.length > 0) {
        try {
          await validateAgentModel(bb, choice, THREAD_DEFAULTS.projectId, signal);
          const prompt = prepared.length === 1 ? prepared[0].prepared : batchPrompt(prepared, stop, choice);
          const metadata: Record<string, JsonValue> = prepared.length === 1
            ? { pr: prepared[0].key, action: prepared[0].action, stop }
            : { prs: prepared.map((task) => task.key), stop };
          const thread = await bb.sdk.threads.spawn({
            projectId: THREAD_DEFAULTS.projectId, ...choice, environment: { type: "project-default" },
            title: prompt.title, prompt: prompt.prompt, pluginMetadata: metadata,
          });
          for (const task of prepared) outcomes.push({ ...base(task), status: "started", threadId: thread.id, title: prompt.title,
            head: task.prepared.head_oid, move: task.prepared.move });
        } catch (cause) {
          for (const task of prepared) outcomes.push({ ...base(task), status: "refused", reason: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      const byKey = new Map(outcomes.map((marker) => [marker.key, marker]));
      await updateMarkers((markers) => ({ markers: markers.map((marker) => byKey.get(marker.key) ?? marker), result: null }));
      changed();
      await rerender();
      changed();
    }

    let jobs: Promise<void> = Promise.resolve();
    async function start({ items, stop, agentModel: override }: z.infer<typeof rpcContract.start.input>, requestSignal: AbortSignal = signal) {
      requestSignal.throwIfAborted();
      const choice = normalizeAgentModel(override ?? await agentModel());
      await validateAgentModel(bb, choice, THREAD_DEFAULTS.projectId, requestSignal);
      requestSignal.throwIfAborted();
      const { starting, skipped } = await updateMarkers((markers) => {
        requestSignal.throwIfAborted();
        const busy = new Set(busyKeys(markers));
        const starting: { key: string; action: Action }[] = [];
        const skipped: { key: string; reason: string }[] = [];
        for (const item of items) {
          if (busy.has(item.key)) skipped.push({ key: item.key, reason: "an agent is already on it" });
          else {
            busy.add(item.key);
            starting.push(item);
          }
        }
        const at = new Date().toISOString();
        const added = starting.map((item): Marker => ({ ...item, status: "starting", at, threadId: null, title: null, head: null, move: null, reason: null, question: null, answeredQuestions: [], answering: null, answerError: null, report: null }));
        const keys = new Set(starting.map((item) => item.key));
        return { markers: [...markers.filter((m) => !keys.has(m.key)), ...added], result: { starting, skipped } };
      });
      if (starting.length > 0) {
        changed();
        jobs = jobs.then(() => startJob(starting, stop, choice)).catch((cause: unknown) => {
          bb.log.error(`start failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
      return { starting: starting.map((item) => item.key), skipped };
    }

    async function answer({ key, questionId, optionId }: { key: string; questionId: string; optionId: string }) {
      const claimed = await updateMarkers((markers) => {
        const marker = markers.find((item) => item.key === key);
        if (!marker || !marker.threadId || marker.question?.id !== questionId || markers.some((item) => item.threadId === marker.threadId && item.question?.id === questionId && item.answering)) throw new Error("This question is no longer available.");
        const option = marker.question.options.find((item) => item.id === optionId);
        if (!option) throw new Error("Choose one of the question's options.");
        return { markers: markers.map((item) => item.threadId === marker.threadId && item.question?.id === questionId ? { ...item, answering: questionId } : item), result: { threadId: marker.threadId, option } };
      });
      changed();
      let attempted = false;
      try {
        const info = await threadInfo(claimed.threadId);
        if (!info || info.live) throw new Error("The thread is already working or unavailable. Open it to continue.");
        await updateMarkers((markers) => {
          const current = markers.filter((item) => item.threadId === claimed.threadId && item.question?.id === questionId);
          if (current.length === 0 || current.some((item) => item.answering !== questionId)) throw new Error("This question is no longer available.");
          return { markers, result: null };
        });
        attempted = true;
        await bb.sdk.threads.send({ threadId: claimed.threadId, mode: "start", input: [{ type: "text", text: claimed.option.message, mentions: [] }] });
        await updateMarkers((markers) => ({ markers: markers.map((item) => item.threadId === claimed.threadId
          ? { ...item, question: item.question?.id === questionId ? null : item.question,
            answering: item.answering === questionId ? null : item.answering,
            answerError: item.answering === questionId ? null : item.answerError,
            answeredQuestions: [...new Set([...item.answeredQuestions, questionId])].slice(-50) } : item), result: null }));
        return { sent: true as const };
      } catch (cause) {
        await updateMarkers((markers) => ({ markers: markers.map((item) => item.threadId === claimed.threadId && item.answering === questionId && item.question?.id === questionId ? { ...item, answering: attempted ? questionId : null,
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
    async function prepare(input: PrepareInput, requestSignal: AbortSignal) {
      requestSignal.throwIfAborted();
      await freshRefresh();
      requestSignal.throwIfAborted();
      const saved = await readSaved();
      const data = readSnapshot();
      if (saved.lastError !== null || data === null) {
        return { ok: false as const, reason: `could not re-check the PR on GitHub: ${saved.lastError ?? "no data yet"}`, lastSuccess: saved.lastSuccess, lastError: saved.lastError };
      }
      return { ...await runner.prepare(data, { key: input.key, expect: input.action, stop: input.stop }, requestSignal), lastSuccess: saved.lastSuccess, lastError: saved.lastError };
    }
    const requesting = new Set<string>();
    const operations = {
      board_get: read, board_refresh: refresh, start, answer,
      agent_model_get: async () => ({ choice: await agentModel(), routing: await agentModelRouting(bb, THREAD_DEFAULTS.projectId) }), agent_model_set: saveAgentModel,
      prs_integration: () => ({ version: 1 as const }),
      reviews_get: async () => {
        try {
          const snapshot = await reviewCall("prs_snapshot", prsSnapshotSchema);
          reviewThreadIds = new Set(snapshot.items.flatMap(({ item }) => item.threadId ? [item.threadId] : []));
          return { kind: "available" as const, snapshot, needsInput: await pendingInput([...reviewThreadIds]) };
        }
        catch (cause) { return { kind: "unavailable" as const, reason: cause instanceof Error ? cause.message : "Review Watch unavailable" }; }
      },
      reviews_detail: (input: z.infer<typeof rpcContract.reviews_detail.input>) => reviewCall("prs_detail", prsReviewSchema, input),
      reviews_targets: (input: z.infer<typeof rpcContract.reviews_targets.input>) => reviewCall("review_targets", reviewTargetsSchema, input),
      reviews_start: async (input: z.infer<typeof rpcContract.reviews_start.input>) => reviewWrite("item_start", reviewStartSchema, { ...input, agentModel: normalizeAgentModel(input.agentModel ?? await agentModel()) }),
      reviews_batch: async (input: z.infer<typeof rpcContract.reviews_batch.input>) => reviewWrite("item_batch_start", reviewBatchSchema, { ...input, agentModel: normalizeAgentModel(input.agentModel ?? await agentModel()) }),
      reviews_dismiss: (input: z.infer<typeof rpcContract.reviews_dismiss.input>) => reviewWrite("item_dismiss", reviewStartSchema, input),
      reviews_refresh: () => reviewWrite("poll_now", reviewPollSchema),
      reviewers_get: async ({ keys }: z.infer<typeof rpcContract.reviewers_get.input>, requestSignal: AbortSignal = signal) => {
        const { author, rows } = await reviewerContext();
        const targets = keys.map((key) => {
          const row = rows.find((item) => item.key === key);
          if (!row || row.group !== "one-click") throw new Error("This PR no longer needs a review request.");
          return row;
        });
        // Reuse repository reads, including missing CODEOWNERS paths, only for this operation.
        const reads = new Map<string, Promise<string>>();
        const read: Github = (args) => {
          requestSignal.throwIfAborted();
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
            requestSignal.throwIfAborted();
            const index = next++;
            options[index] = await reviewerOptions(read, targets[index], author, rows);
          }
        }));
        return options;
      },
      reviewers_request: async ({ requests }: z.infer<typeof rpcContract.reviewers_request.input>) => {
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
    };
    bb.rpc.register(rpcContract, {
      ...operations,
      start: (input) => operations.start(input),
      agent_model_set: (input) => operations.agent_model_set(input),
      reviewers_get: (input, context) => operations.reviewers_get(input, context.experimental_signal),
    });
    registerAgentTools(bb, { ...operations, prepare, report }, rpcContract, signal);

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
