import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableJson } from "./domain/shared.js";

export type NativeTaskSdk = Pick<BbPluginApi["sdk"], "threads">;
type Spawn = Parameters<NativeTaskSdk["threads"]["spawn"]>[0];
export type NativeExecution = Pick<Spawn, "projectId" | "environment" | "reasoningLevel" | "serviceTier" | "permissionMode"> & { providerId: string; model: string };
export interface NativeTaskRequest {
  id: string; instructions: string; input: string; stage: string; runId?: string; solutionId?: string;
  execution: NativeExecution; privacyGeneration: string; timeoutMs?: number; maxReplyCharacters?: number;
}
export interface NativeTaskIdentity {
  taskId: string; stage: string; runId?: string; solutionId?: string; providerId: string; model: string; startedAtMs: number;
}
export interface NativeTaskReceipt extends NativeTaskIdentity {
  threadId: string; text: string; promptHash: string; endedAtMs: number;
  requestId: string; turnId: string;
  /** Selection is pinned; some BB providers do not report the model actually used. */
  modelIdentitySource: "requested-selection";
}
export interface TaskRunner {
  execute(request: NativeTaskRequest, signal?: AbortSignal): Promise<NativeTaskReceipt>;
  /** Positive acknowledgement durably prevents this unregistered ID from ever dispatching. */
  retireUnregistered?(taskId: string): boolean;
}
export interface NativeTaskSettlement extends NativeTaskIdentity {
  threadId: string | null; status: "completed" | "failed" | "cancelled" | "uncertain";
  endedAtMs: number; error: string | null; dispatched: boolean; cleanupPending: boolean;
}
export interface NativeTaskHooks {
  /** Must be idempotent by taskId: recovery may repeat a reservation whose acknowledgement was lost. */
  beforeStart?(task: NativeTaskIdentity): Promise<void>;
  /** Synchronous server-owned guard after durable dispatch identity checks; public metadata grants no authority. */
  beforeDispatch?(record: Readonly<NativeTaskRecord>): void;
  /** Must upsert by taskId/status. A later recovery can settle an uncertain dispatch. No prompt or output is supplied. */
  onSettled?(task: NativeTaskSettlement): Promise<void>;
}
export interface NativeCleanupOptions { signal?: AbortSignal; maxTasks?: number; timeoutMs?: number }
export interface NativeCleanupResult { checked: number; pending: number }
export interface NativeTaskOptions {
  sdk: NativeTaskSdk; store: Store; currentPrivacyGeneration: () => string; hooks?: NativeTaskHooks; now?: () => number;
}
const id = z.string().min(1).max(500).refine(value => value.trim() === value && value.trim().length > 0);
const recordSchema = z.object({
  taskId: id, nonce: z.string().uuid(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  stage: id, runId: id.optional(), solutionId: id.optional(), projectId: id, providerId: id, model: id, privacyGeneration: id,
  permissionMode: z.enum(["accept-edits", "auto", "full"]), reasoningLevel: z.string().nullable(), serviceTier: z.string().nullable(),
  expectedEnvironmentId: id.nullable(), resolvedEnvironmentId: id.nullable(),
  threadId: id.nullable(), state: z.enum(["prepared", "admitting", "dispatching", "running", "completed", "failed", "cancelled", "uncertain"]),
  startedAtMs: z.number().finite().nonnegative(), deadlineAtMs: z.number().finite().nonnegative(), endedAtMs: z.number().finite().nullable(),
  error: z.string().nullable(), outputDigest: z.string().nullable(), dispatched: z.boolean(), active: z.boolean(), cleanupPending: z.boolean(),
}).strict();
export type NativeTaskRecord = z.infer<typeof recordSchema>;
export type NativeTaskThread = Pick<Awaited<ReturnType<NativeTaskSdk["threads"]["get"]>>, "id" | "projectId" | "providerId" | "originPluginId" | "environmentId">;
export interface NativeTaskDispatch {
  originPluginId: string | null; attempt: "start-turn" | "join-turn"; inputText: string;
  requestedExecution: { providerId: string; model: string | null; permissionMode: string | null; reasoningLevel: string | null; serviceTier: string | null };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const NS = "native-tasks", INDEX = "native-task-threads", RETIREMENTS = "native-task-retirements", SETTLEMENTS = "native-task-settlements", RECONCILE = "native-task-reconcile";
const retirementSchema = z.object({ taskId: id, retiredAtMs: z.number().finite().nonnegative(), neverDispatched: z.literal(true), reasonCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).optional() }).strict();
export class NativeTaskError extends Error { constructor(readonly code: string) { super(code); this.name = "NativeTaskError"; } }
const fail = (code: string): never => { throw new NativeTaskError(code); };
function identity(record: NativeTaskRecord): NativeTaskIdentity {
  return { taskId: record.taskId, stage: record.stage, ...(record.runId ? { runId: record.runId } : {}), ...(record.solutionId ? { solutionId: record.solutionId } : {}), providerId: record.providerId, model: record.model, startedAtMs: record.startedAtMs };
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(new NativeTaskError("native-task-aborted")); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new NativeTaskError("native-task-aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** One fresh BB thread per task. No vendor protocol, native tool filtering or context-isolation guarantee. */
export class NativeTaskRunner implements TaskRunner {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly taskControllers = new Map<string, AbortController>();
  /** Reason codes for in-flight work revoked by this process; reconciliation-driven cancellation keeps its timeout/abort code. */
  private readonly revokedReasons = new Map<string, string>();
  private readonly disposeSignal = new AbortController();
  private readonly now: () => number;
  private cleanupSweep: Promise<NativeCleanupResult> | null = null;
  private disposalCleanupSignal: AbortSignal | null = null;
  constructor(private readonly options: NativeTaskOptions) { this.now = options.now ?? Date.now; }

  retireUnregistered(taskId: string): boolean {
    if (!id.safeParse(taskId).success) return fail("native-task-input-invalid");
    return this.options.store.transaction(() => {
      // Presence is enough to refuse: malformed or uncertain records are not proof of non-dispatch.
      if (this.options.store.get(NS, taskId) !== null) return false;
      const previous = this.options.store.get(RETIREMENTS, taskId);
      if (previous !== null) {
        const parsed = retirementSchema.safeParse(previous);
        if (!parsed.success || parsed.data.taskId !== taskId) return fail("native-task-retirement-invalid");
      } else this.options.store.put(RETIREMENTS, taskId, { taskId, retiredAtMs: this.now(), neverDispatched: true }, this.now());
      return true;
    });
  }
  /** Trusted cancellation of named work only. Durable revocation precedes any cleanup RPC. */
  revoke(taskIds: readonly string[], reasonCode: string): void {
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 100 || taskIds.some(taskId => !id.safeParse(taskId).success) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(reasonCode)) return fail("native-task-revocation-invalid");
    const selected = [...new Set(taskIds)], revokedNow = new Set<string>();
    this.options.store.transaction(() => {
      for (const taskId of selected) {
        const record = this.read(taskId);
        if (!record) {
          const previous = this.options.store.get(RETIREMENTS, taskId);
          if (previous !== null) {
            const parsed = retirementSchema.safeParse(previous);
            if (!parsed.success || parsed.data.taskId !== taskId) return fail("native-task-retirement-invalid");
          } else this.options.store.put(RETIREMENTS, taskId, { taskId, retiredAtMs: this.now(), neverDispatched: true, reasonCode }, this.now());
        } else if (!["completed", "failed", "cancelled"].includes(record.state)) {
          this.write({ ...record, active: false, state: "cancelled", error: reasonCode, endedAtMs: this.now() });
          revokedNow.add(taskId);
        }
      }
    });
    for (const taskId of selected) {
      const controller = this.taskControllers.get(taskId);
      if (!controller) continue;
      if (revokedNow.has(taskId)) this.revokedReasons.set(taskId, reasonCode);
      controller.abort();
    }
    // A failed stop/archive/settlement remains durable for the existing fair reconciler.
    queueMicrotask(() => { void this.reconcileCleanup({ maxTasks: selected.length, timeoutMs: 5000 }).catch(() => {}); });
  }
  private notRetired(taskId: string): void {
    if (this.options.store.get(RETIREMENTS, taskId) !== null) fail("native-task-retired-before-dispatch");
  }

  private read(taskId: string): NativeTaskRecord | null {
    const raw = this.options.store.get(NS, taskId); if (raw === null) return null;
    const parsed = recordSchema.safeParse(raw); if (!parsed.success || parsed.data.taskId !== taskId) return fail("native-task-record-invalid");
    return parsed.data;
  }
  private write(record: NativeTaskRecord): void {
    this.options.store.put(NS, record.taskId, record, this.now());
    if (record.threadId) this.options.store.put(INDEX, record.threadId, { taskId: record.taskId }, this.now());
  }
  get(threadId: string): NativeTaskRecord | null {
    const index = this.options.store.get<{ taskId?: unknown }>(INDEX, threadId);
    if (!index || typeof index.taskId !== "string") return null;
    const record = this.read(index.taskId); return record?.threadId === threadId ? record : null;
  }
  owns(threadId: string): boolean { return this.get(threadId) !== null; }
  private current(record: NativeTaskRecord): void {
    this.notRetired(record.taskId);
    if (record.privacyGeneration !== this.options.currentPrivacyGeneration()) fail("native-task-privacy-changed");
    if (this.disposeSignal.signal.aborted) fail("native-task-disposed");
    const latest = this.read(record.taskId);
    if (record.active && latest && !latest.active && ["cancelled", "failed"].includes(latest.state)) fail("native-task-inactive");
  }
  private binding(record: NativeTaskRecord, thread: NativeTaskThread, metadata: Record<string, unknown>): void {
    if (thread.originPluginId !== "self-improve" || thread.projectId !== record.projectId || thread.providerId !== record.providerId ||
      metadata.nativeTaskId !== record.taskId || metadata.nativeTaskNonce !== record.nonce || metadata.nativeTaskDigest !== record.requestDigest ||
      (record.threadId !== null && record.threadId !== thread.id)) fail("native-task-binding-mismatch");
    if (thread.environmentId !== null && (typeof thread.environmentId !== "string" || !thread.environmentId ||
      (record.expectedEnvironmentId !== null && record.expectedEnvironmentId !== thread.environmentId) ||
      (record.resolvedEnvironmentId !== null && record.resolvedEnvironmentId !== thread.environmentId))) fail("native-task-environment-changed");
  }
  /** Install in message.dispatch. Metadata only points at an already persisted task; it is not authority by itself. */
  async admit(thread: NativeTaskThread, dispatch: NativeTaskDispatch): Promise<NativeTaskRecord | null> {
    if (thread.originPluginId !== "self-improve") return null;
    const metadata = await this.options.sdk.threads.getPluginMetadata({ threadId: thread.id });
    if (typeof metadata.nativeTaskId !== "string") return null; // another self-improve worker, such as chat
    return this.options.store.transaction(() => {
      const record = this.read(metadata.nativeTaskId as string); if (!record) return fail("native-task-not-registered");
      this.current(record); this.binding(record, thread, metadata);
      if (!record.active || !["dispatching", "running"].includes(record.state) || this.now() >= record.deadlineAtMs) return fail("native-task-inactive");
      if (!dispatch || dispatch.originPluginId !== "self-improve" || dispatch.attempt !== "start-turn" || typeof dispatch.inputText !== "string" || sha(dispatch.inputText) !== record.promptHash) return fail("native-task-dispatch-mismatch");
      if (dispatch.requestedExecution.providerId !== record.providerId) return fail("native-task-binding-mismatch");
      this.executionBinding(record, dispatch.requestedExecution);
      const bound = { ...record, threadId: thread.id, resolvedEnvironmentId: thread.environmentId ?? record.resolvedEnvironmentId, state: "running" as const, cleanupPending: true };
      const guarded: unknown = this.options.hooks?.beforeDispatch?.(Object.freeze({ ...bound }));
      if (guarded && typeof (guarded as { then?: unknown }).then === "function") {
        void Promise.resolve(guarded).catch(() => {}); return fail("native-task-dispatch-guard-must-be-synchronous");
      }
      this.write(bound); return bound;
    });
  }
  private async recover(record: NativeTaskRecord, signal: AbortSignal): Promise<NativeTaskRecord> {
    const matches = new Map<string, NativeTaskThread>();
    for (const archived of [false, true]) {
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const batch = await bounded(this.options.sdk.threads.list({ projectId: record.projectId, includeHidden: true, archived, limit: 100, offset: page * 100, signal }), signal);
        for (const thread of batch) {
          if (thread.originPluginId !== "self-improve") continue;
          const meta = await bounded(this.options.sdk.threads.getPluginMetadata({ threadId: thread.id, signal }), signal);
          if (meta.nativeTaskId !== record.taskId || meta.nativeTaskNonce !== record.nonce) continue;
          this.binding(record, thread, meta); matches.set(thread.id, thread);
        }
        if (batch.length < 100) { complete = true; break; }
      }
      if (!complete) return fail("native-task-recovery-incomplete");
    }
    if (matches.size !== 1) return fail(matches.size ? "native-task-ambiguous" : "native-task-dispatch-uncertain");
    const thread = [...matches.values()][0]!;
    const latest = this.read(record.taskId)!;
    if (latest.threadId && latest.threadId !== thread.id) return fail("native-task-binding-mismatch");
    const bound = { ...latest, threadId: thread.id, resolvedEnvironmentId: thread.environmentId ?? latest.resolvedEnvironmentId, cleanupPending: true };
    this.write(bound); return bound;
  }
  private async checkThread(record: NativeTaskRecord, signal: AbortSignal) {
    const thread = await bounded(this.options.sdk.threads.get({ threadId: record.threadId!, signal }), signal);
    const meta = await bounded(this.options.sdk.threads.getPluginMetadata({ threadId: record.threadId!, signal }), signal);
    this.current(record); this.binding(record, thread, meta);
    if (thread.deletedAt !== null) fail("native-task-thread-deleted");
    // BB returns a pending/starting row before asynchronous provisioning finishes.
    if (record.resolvedEnvironmentId === null && thread.environmentId !== null) { record.resolvedEnvironmentId = thread.environmentId; this.write(record); }
    this.current(record); return thread;
  }
  private executionBinding(record: NativeTaskRecord, execution: { model?: string | null; permissionMode?: string | null; reasoningLevel?: string | null; serviceTier?: string | null }): void {
    if (execution.model !== record.model) fail("native-task-model-changed");
    if (execution.permissionMode !== record.permissionMode ||
      (record.reasoningLevel !== null && execution.reasoningLevel !== record.reasoningLevel) ||
      (record.serviceTier !== null && execution.serviceTier !== record.serviceTier)) fail("native-task-execution-changed");
  }
  /** Check public semantic events, never provider tool names or wire messages. */
  private async turnIdentity(record: NativeTaskRecord, signal: AbortSignal): Promise<{ requestId: string; turnId: string }> {
    const events = await bounded(this.options.sdk.threads.events.list({ threadId: record.threadId!, limit: "100", order: "asc", types: ["client/turn/requested", "turn/input/accepted", "turn/started", "turn/completed", "provider/modelFallback"], signal }), signal);
    if (!Array.isArray(events) || events.length >= 100 || events.some(event => event.threadId !== record.threadId)) return fail("native-task-turn-history-invalid");
    const requests = events.filter(event => event.type === "client/turn/requested");
    const accepted = events.filter(event => event.type === "turn/input/accepted");
    const starts = events.filter((event): event is Extract<(typeof events)[number], {type:"turn/started"}> => event.type === "turn/started" && !event.data.parentToolCallId);
    if (requests.length !== 1 || accepted.length !== 1 || starts.length !== 1) return fail("native-task-turn-history-unmatched");
    const sent = requests[0]!, ack = accepted[0]!, start = starts[0]!;
    if (sent.data.source !== "spawn" || sent.data.originPluginId !== "self-improve" || sent.data.target.kind !== "thread-start" ||
      sent.data.retryOfRequestId !== undefined || sent.data.input.length !== 1 || sent.data.input[0]?.type !== "text" || sha(sent.data.input[0].text) !== record.promptHash ||
      ack.data.clientRequestId !== sent.data.requestId || ack.scope.kind !== "turn" || start.scope.kind !== "turn" || ack.scope.turnId !== start.scope.turnId ||
      ack.data.providerThreadId !== start.data.providerThreadId) return fail("native-task-turn-history-unmatched");
    this.executionBinding(record, sent.data.execution);
    if (events.some(event => event.type === "provider/modelFallback")) return fail("native-task-model-changed");
    const turnId = ack.scope.turnId;
    const completions = events.filter(event => event.type === "turn/completed" && event.scope.kind === "turn" && event.scope.turnId === turnId);
    if (completions.length !== 1 || completions[0]!.type !== "turn/completed" || completions[0]!.data.status !== "completed" || completions[0]!.data.providerThreadId !== ack.data.providerThreadId || completions[0]!.seq <= Math.max(ack.seq, start.seq)) return fail("native-task-turn-not-completed");
    return { requestId: sent.data.requestId, turnId };
  }
  private async output(record: NativeTaskRecord, maxCharacters: number, signal: AbortSignal): Promise<string> {
    const result = await bounded(this.options.sdk.threads.output({ threadId: record.threadId!, signal }), signal);
    if (typeof result.output !== "string" || !result.output.trim() || result.output.length > maxCharacters) return fail("native-task-output-invalid");
    if (record.outputDigest !== null && record.outputDigest !== sha(result.output)) return fail("native-task-output-changed");
    this.current(record); return result.output;
  }
  private cleanupSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : []), ...(this.disposalCleanupSignal ? [this.disposalCleanupSignal] : [])]);
  }
  private async cleanup(taskId: string, parentSignal?: AbortSignal): Promise<void> {
    const record = this.read(taskId); if (!record?.threadId || !record.cleanupPending) return;
    const signal = this.cleanupSignal(parentSignal);
    let stopped = false, archived = false;
    if (!signal.aborted) try { await bounded(this.options.sdk.threads.stop({ threadId: record.threadId, signal }), signal); stopped = true; } catch { /* retained for reconciliation */ }
    if (!signal.aborted) try { await bounded(this.options.sdk.threads.archive({ threadId: record.threadId, signal }), signal); archived = true; } catch { /* retained for reconciliation */ }
    const current = this.read(taskId); if (current && current.threadId === record.threadId) this.write({ ...current, cleanupPending: current.cleanupPending && !(stopped && archived) });
  }
  private settlement(record: NativeTaskRecord): NativeTaskSettlement | null {
    if (record.endedAtMs === null || record.state === "prepared" || record.state === "admitting" || record.state === "dispatching" || record.state === "running") return null;
    return { ...identity(record), threadId: record.threadId, status: record.state, endedAtMs: record.endedAtMs, error: record.error, dispatched: record.dispatched, cleanupPending: record.cleanupPending };
  }
  private settlementPending(record: NativeTaskRecord): boolean {
    const value = this.settlement(record); if (!value) return false;
    return this.options.store.get<{ digest: string }>(SETTLEMENTS, record.taskId)?.digest !== sha(stableJson(value));
  }
  private async settled(taskId: string, parentSignal?: AbortSignal): Promise<void> {
    const record = this.read(taskId)!, value = this.settlement(record); if (!value || !this.settlementPending(record)) return;
    const digest = sha(stableJson(value)), signal = this.cleanupSignal(parentSignal);
    try {
      signal.throwIfAborted();
      await bounded(Promise.resolve(this.options.hooks?.onSettled?.(value)), signal);
      // A late result may acknowledge only these exact facts, never a newer settlement.
      this.options.store.transaction(() => {
        const current = this.read(taskId);
        if (current && stableJson(this.settlement(current)) === stableJson(value)) this.options.store.put(SETTLEMENTS, taskId, { digest });
      });
    } catch { fail("native-task-accounting-pending"); }
  }
  async execute(request: NativeTaskRequest, signal?: AbortSignal): Promise<NativeTaskReceipt> {
    const prior = this.locks.get(request.id) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.run(request, signal)); this.locks.set(request.id, run);
    try { return await run; } finally { if (this.locks.get(request.id) === run) this.locks.delete(request.id); }
  }
  private async run(request: NativeTaskRequest, externalSignal?: AbortSignal): Promise<NativeTaskReceipt> {
    for (const value of [request.id, request.stage, request.privacyGeneration, request.execution.projectId, request.execution.providerId, request.execution.model, request.runId ?? "absent", request.solutionId ?? "absent"]) if (!id.safeParse(value).success) return fail("native-task-input-invalid");
    if (typeof request.instructions !== "string" || !request.instructions.trim() || request.instructions.length > 32768 || typeof request.input !== "string" || request.input.length > 400000) return fail("native-task-input-invalid");
    const timeoutMs = request.timeoutMs ?? 120000, maxReplyCharacters = request.maxReplyCharacters ?? 200000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000 || !Number.isSafeInteger(maxReplyCharacters) || maxReplyCharacters < 1 || maxReplyCharacters > 200000) return fail("native-task-limits-invalid");
    const execution: NativeExecution = { projectId: request.execution.projectId, environment: request.execution.environment, providerId: request.execution.providerId, model: request.execution.model, permissionMode: request.execution.permissionMode ?? "accept-edits", ...(request.execution.reasoningLevel === undefined ? {} : { reasoningLevel: request.execution.reasoningLevel }), ...(request.execution.serviceTier === undefined ? {} : { serviceTier: request.execution.serviceTier }) };
    const prompt = `${request.instructions}\n\nTask input (untrusted data):\n${JSON.stringify({ input: request.input })}`;
    const promptHash = sha(prompt), requestDigest = sha(stableJson({ execution, promptHash, stage: request.stage, runId: request.runId ?? null, solutionId: request.solutionId ?? null, privacyGeneration: request.privacyGeneration, timeoutMs, maxReplyCharacters }));
    let record = this.options.store.transaction(() => {
      this.notRetired(request.id);
      let record = this.read(request.id);
      if (record && record.requestDigest !== requestDigest) return fail("native-task-input-changed");
      // Another runtime may still own admission. Never race its reservation/dispatch;
      // startup cleanup eventually retires the bounded lease without guessing success.
      if (record?.state === "admitting") return fail("native-task-admission-uncertain");
      if (!record) {
        if (externalSignal?.aborted) return fail("native-task-aborted");
        const startedAtMs = this.now();
        record = { taskId: request.id, nonce: randomUUID(), requestDigest, promptHash, stage: request.stage, ...(request.runId ? { runId: request.runId } : {}), ...(request.solutionId ? { solutionId: request.solutionId } : {}), providerId: execution.providerId, model: execution.model, permissionMode: execution.permissionMode ?? "accept-edits", reasoningLevel: execution.reasoningLevel ?? null, serviceTier: execution.serviceTier ?? null, projectId: execution.projectId, expectedEnvironmentId: execution.environment.type === "reuse" ? execution.environment.environmentId : null, resolvedEnvironmentId: null, privacyGeneration: request.privacyGeneration, threadId: null, state: "prepared", startedAtMs, deadlineAtMs: startedAtMs + timeoutMs, endedAtMs: null, error: null, outputDigest: null, dispatched: false, active: true, cleanupPending: false };
        this.current(record);
        if (!this.options.store.insert(NS, request.id, record, startedAtMs)) return fail("native-task-concurrent-registration");
      }
      return record;
    });
    const controller = new AbortController();
    this.taskControllers.set(request.id, controller);
    const remaining = record.state === "completed" ? timeoutMs : Math.max(1, record.deadlineAtMs - this.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    const combined = AbortSignal.any([controller.signal, this.disposeSignal.signal, ...(externalSignal ? [externalSignal] : [])]);
    try {
      this.current(record);
      if (combined.aborted) return fail("native-task-aborted");
      if (record.state === "failed" || record.state === "cancelled") return fail(record.error ?? "native-task-failed");
      if (record.state !== "completed" && this.now() >= record.deadlineAtMs) return fail("native-task-timeout");
      if (record.state === "prepared") {
        record = { ...record, state: "admitting" }; this.write(record);
        try { await bounded(Promise.resolve(this.options.hooks?.beforeStart?.(identity(record))), combined); }
        catch { if (combined.aborted) return fail("native-task-aborted"); return fail("native-task-admission-denied"); }
        this.current(record);
        if (this.read(record.taskId)?.state !== "admitting") return fail("native-task-admission-revoked");
        record = { ...record, state: "dispatching", dispatched: true }; this.write(record);
        // BB spawn has no AbortSignal. A late response is observed and cleaned, never allowed to dispatch twice.
        const spawn = this.options.sdk.threads.spawn({ ...execution, prompt, visibility: "hidden", parentNotifications: "off", title: `Self improve · ${request.stage}`, pluginMetadata: { nativeTaskId: record.taskId, nativeTaskNonce: record.nonce, nativeTaskDigest: record.requestDigest, threadBriefs: false } });
        void spawn.then(async thread => {
          const latest = this.read(request.id);
          if (latest && !latest.active) {
            const guard = this.cleanupSignal(); if (guard.aborted) return;
            const meta = await bounded(this.options.sdk.threads.getPluginMetadata({ threadId: thread.id, signal: guard }), guard);
            this.binding(latest, thread, meta);
            this.write({ ...latest, threadId: thread.id, cleanupPending: true });
            await this.cleanup(request.id);
          }
        }).catch(() => {});
        try {
          const spawned = await bounded(spawn, combined);
          record = this.read(record.taskId)!;
          if (record.threadId !== spawned.id || record.state !== "running") {
            // A missing admission hook must not silently weaken ownership checks.
            // Retain an authenticated cleanup binding, including across failed stop RPCs.
            const guard = AbortSignal.timeout(5000);
            const meta = await bounded(this.options.sdk.threads.getPluginMetadata({ threadId: spawned.id, signal: guard }), guard);
            this.binding(record, spawned, meta);
            record = { ...record, threadId: spawned.id, cleanupPending: true }; this.write(record);
            return fail("native-task-gate-not-bound");
          }
        } catch (error) {
          if (error instanceof NativeTaskError) throw error;
          record = this.read(record.taskId)!;
          if (!record.threadId) record = await this.recover(record, combined);
        }
      } else if (!record.threadId) record = await this.recover(record, combined);
      let thread = await this.checkThread(record, combined);
      if (record.state === "completed" && (thread.status !== "idle" || thread.queuedMessageCount !== 0)) return fail("native-task-thread-reused");
      if (record.state !== "completed") {
        if (thread.status === "error") return fail("native-task-turn-failed");
        if (thread.status !== "idle" || thread.queuedMessageCount > 0) {
          await bounded(this.options.sdk.threads.wait({ threadId: record.threadId!, status: "idle", timeoutMs: Math.max(1, record.deadlineAtMs - this.now()), pollIntervalMs: 250, signal: combined }), combined);
          thread = await this.checkThread(record, combined);
        }
        if (thread.status !== "idle" || thread.queuedMessageCount !== 0) return fail("native-task-result-not-terminal");
      }
      if (thread.environmentId === null) return fail("native-task-environment-unresolved");
      const initialTurn = await this.turnIdentity(record, combined);
      const text = await this.output(record, maxReplyCharacters, combined);
      const finalTurn = await this.turnIdentity(record, combined);
      if (initialTurn.requestId !== finalTurn.requestId || initialTurn.turnId !== finalTurn.turnId) return fail("native-task-output-changed");
      record = { ...record, state: "completed", active: false, outputDigest: sha(text), endedAtMs: record.endedAtMs ?? this.now(), error: null }; this.write(record);
      return { ...identity(record), ...finalTurn, threadId: record.threadId!, text, promptHash: record.promptHash, endedAtMs: record.endedAtMs!, modelIdentitySource: "requested-selection" };
    } catch (error) {
      record = this.read(request.id)!;
      const revokedReason = this.revokedReasons.get(request.id);
      const code = revokedReason && record.state === "cancelled" ? revokedReason : externalSignal?.aborted || this.disposeSignal.signal.aborted ? "native-task-aborted" : controller.signal.aborted || this.now() >= record.deadlineAtMs ? "native-task-timeout" : error instanceof NativeTaskError ? error.code : "native-task-sdk-unavailable";
      if (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled") {
        const uncertain = record.dispatched && !record.threadId && !["native-task-admission-denied"].includes(code);
        this.write({ ...record, active: false, state: uncertain ? "uncertain" : code === "native-task-aborted" ? "cancelled" : "failed", error: code, endedAtMs: this.now() });
      }
      throw new NativeTaskError(code);
    } finally {
      clearTimeout(timer);
      if (this.taskControllers.get(request.id) === controller) { this.taskControllers.delete(request.id); this.revokedReasons.delete(request.id); }
      const latest = this.read(request.id); if (latest?.active) this.write({ ...latest, active: false });
      await this.cleanup(request.id);
      await this.settled(request.id);
    }
  }
  private cleanupLimits(options: NativeCleanupOptions): { maxTasks: number; timeoutMs: number } {
    const maxTasks = options.maxTasks ?? 100, timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return fail("native-task-cleanup-limits-invalid");
    return { maxTasks, timeoutMs };
  }
  /** Revoke every stale identity before any network await, independently of the cleanup batch size. */
  private revokeStale(): void {
    this.options.store.transaction(() => {
      for (const entry of this.options.store.entries(NS)) {
        const record = this.read(entry.key)!;
        if (record.active && (this.disposeSignal.signal.aborted || this.now() >= record.deadlineAtMs || record.privacyGeneration !== this.options.currentPrivacyGeneration())) {
          this.write({ ...record, active: false, state: "cancelled", error: "native-task-stale", endedAtMs: this.now() });
        }
      }
    });
  }
  private outstanding(): NativeTaskRecord[] {
    return this.options.store.entries(NS).map(entry => this.read(entry.key)!).filter(record => !record.active &&
      (record.cleanupPending || (!record.threadId && record.dispatched) || this.settlementPending(record)))
      .sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  }
  /** Bounded fair cleanup/settlement only: never restart model work or perform a full-history usage scan. */
  async reconcileCleanup(options: NativeCleanupOptions = {}): Promise<NativeCleanupResult> {
    const { maxTasks, timeoutMs } = this.cleanupLimits(options), deadline = performance.now() + timeoutMs;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : []),
      // An in-progress normal sweep yields to disposal. Disposal itself may clean up already-revoked work.
      ...(!this.disposeSignal.signal.aborted ? [this.disposeSignal.signal] : [])]);
    this.revokeStale(); options.signal?.throwIfAborted();
    const previous = this.cleanupSweep;
    const sweep = (async () => {
      if (previous) try { await bounded(previous.catch(() => ({ checked: 0, pending: 0 })), signal); } catch { options.signal?.throwIfAborted(); return { checked: 0, pending: this.outstanding().length }; }
      const pending = this.outstanding(), cursor = this.options.store.get<string>(RECONCILE, "cursor");
      const index = cursor === null ? 0 : pending.findIndex(record => record.taskId > cursor), offset = index < 0 ? 0 : index;
      const selected = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, maxTasks);
      let checked = 0;
      for (const item of selected) {
        options.signal?.throwIfAborted(); if (signal.aborted || performance.now() >= deadline) break;
        // Persist before network work so one stalled identity cannot starve its successors across restarts.
        this.options.store.put(RECONCILE, "cursor", item.taskId); checked++;
        let record = this.read(item.taskId)!;
        if (record.active) continue;
        if (!record.threadId && record.dispatched) {
          try { record = await this.recover(record, this.cleanupSignal(signal)); } catch { /* uncertain identity remains durable */ }
        }
        if (signal.aborted) break;
        await this.cleanup(record.taskId, signal);
        if (signal.aborted) break;
        try { await this.settled(record.taskId, signal); } catch { /* failed acknowledgement remains pending for the next fair sweep */ }
      }
      options.signal?.throwIfAborted();
      return { checked, pending: this.outstanding().length };
    })();
    this.cleanupSweep = sweep;
    try { return await sweep; } finally { if (this.cleanupSweep === sweep) this.cleanupSweep = null; }
  }
  async dispose(options: NativeCleanupOptions = {}): Promise<void> {
    const limits = this.cleanupLimits(options), signal = AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    this.disposalCleanupSignal = signal; this.disposeSignal.abort(); this.revokeStale();
    try {
      await bounded(Promise.allSettled([...this.locks.values()]), signal);
      if (!signal.aborted) await this.reconcileCleanup({ ...limits, signal });
    } catch { if (!signal.aborted) throw new NativeTaskError("native-task-cleanup-pending"); }
    // Unfinished cleanup and settlement are persisted for the next manager; no model identity is re-enabled.
  }
}
