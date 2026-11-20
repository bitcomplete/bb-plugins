import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Store, MIGRATIONS } from "../src/store.js";
import { Accounting } from "../src/costs.js";
import { checkConfig, defaultConfig, parseConfig, type Config } from "../src/config.js";
import { NativeTaskRunner } from "../src/native-tasks.js";
import { NativeAccounting } from "../src/native-accounting.js";
import { NativeMiner } from "../src/native-miner.js";
import { NativeChatManager } from "../src/native-chat.js";
import { ActivityAccounting } from "../src/activity-accounting.js";
import { activityCostView } from "../src/activity-view.js";
import { nativeExecution, executionSelectionSchema } from "../src/native-execution.js";
import { Services, Deferred } from "../src/services.js";
import { Runtime } from "../src/runtime.js";
import { syncWorkerPrivacy } from "../src/worker-privacy.js";
import { Exports, dataDirectory } from "../src/exports.js";
import { redact } from "../src/adapters/privacy.js";
import { createBuilder } from "../src/build.js";
import { recoverInterruptedEvaluations } from "../src/evaluation.js";
import { registerReactive } from "../src/reactive.js";
import { createRevalidation } from "../src/revalidation.js";
import { createRevalidationRunner } from "../src/revalidation-runner.js";
import { createRevalidationDraftEditor } from "../src/revalidation-edit.js";
import { createRevalidationOwnerApi } from "../src/revalidation-owner.js";
import { createResearch } from "./research.js";

/** Builds the plugin's services and background work and wires them to BB. The returned context is shared by the RPC, agent and CLI modules. */
export async function createContext(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Run scheduled improvements", default: false },
    config: { type: "string", label: "Configuration (JSON)", experimental_multiline: true, default: JSON.stringify(defaultConfig(), null, 2) },
    dairToken: { type: "string", secret: true, label: "DAIR OAuth access token" },
    evaluationSuite: { type: "string", secret: true, label: "Development evaluation suite (JSON)", description: "Test cases for trying fixes: inputs with the exact expected answer. See the setup guide for the format." },
  });
  let values = await settings.get();
  const db = bb.storage.database(); bb.storage.migrate(db, MIGRATIONS); const store = new Store(db);
  recoverInterruptedEvaluations(store);
  let config = defaultConfig(), configurationError: string | null = null;
  const applyConfig = () => {
    try { config = parseConfig(values.config); configurationError = null; }
    catch { config = defaultConfig(); configurationError = "Invalid configuration"; }
  };
  applyConfig();
  const privacy = () => ({ clientNames: config.redactedNames, secrets: [values.dairToken ?? ""].filter(Boolean), maxCharacters: 100000 });
  const clean = (text: string) => redact(text, privacy());
  let privacyGeneration = syncWorkerPrivacy(store, privacy());
  const execution = () => {
    if (configurationError) throw new Deferred("repair-configuration");
    try { return nativeExecution({ providerId: config.providerId, model: config.model,
      projectId: config.projectId, environmentId: config.environmentId,
      permissionMode: config.permissionMode, reasoningLevel: config.reasoningLevel, serviceTier: config.serviceTier }); }
    catch { throw new Deferred("configure-bb-provider-model-project-environment"); }
  };

  // Costs: BB usage for agent tasks and chats, owner-recorded charges and detector reservations, and the one budget check over all of them.
  let activity: ActivityAccounting;
  const accounting = new Accounting(store, () => config.budgets, admission => activity.legacyGuard(admission));
  accounting.recoverInterrupted();
  const nativeAccounting = new NativeAccounting({ store, sdk: bb.sdk, maxConcurrent: () => config.concurrency,
    admissionGuard: (admission, atMs) => activity.nativeGuard(admission, atMs) });
  const nativeTasks = new NativeTaskRunner({ store, sdk: bb.sdk, currentPrivacyGeneration: () => privacyGeneration, hooks: nativeAccounting.hooks() });
  const chats = new NativeChatManager({ store, sdk: bb.sdk, execution, privacy,
    privacyGeneration: () => privacyGeneration, hooks: { beforeDispatch: async admission => { activity.admitChat(admission); } } });
  activity = new ActivityAccounting({ store, policy: () => config.budgets,
    native: () => nativeAccounting, legacy: () => accounting, chats: () => chats.observations() });

  const owns = (id: string) => nativeTasks.owns(id) || chats.owns(id) || store.get("worker-threads", id) !== null;
  let miner: NativeMiner | null = null;
  const getMiner = () => miner ??= new NativeMiner({ store, runner: nativeTasks, execution, privacy,
    privacyGeneration: () => privacyGeneration, owns, timeoutMs: config.taskTimeoutMs });
  const stop = new AbortController();
  bb.onDispose(() => stop.abort());
  const exporter = new Exports(store, dataDirectory(store), accounting, activity);
  let exportError: string | null = null;
  const changed = () => {
    bb.realtime.publish("self-improve:changed", {});
    void exporter.flush().then(() => { exportError = null; }, () => { exportError = "Ledger file export failed; database remains authoritative"; });
  };
  const research = createResearch({ store, config: () => config, token: () => values.dairToken, signal: stop.signal });

  const workerSelection = () => {
    const parsed = executionSelectionSchema.safeParse({ providerId: config.providerId, model: config.model, projectId: config.projectId,
      environmentId: config.environmentId, permissionMode: config.permissionMode, ...(config.reasoningLevel === undefined ? {} : { reasoningLevel: config.reasoningLevel }),
      ...(config.serviceTier === undefined ? {} : { serviceTier: config.serviceTier }) });
    return parsed.success ? parsed.data : null;
  };
  const revalidation = createRevalidation(store, { redact: clean });
  const editRevalidationDraft = createRevalidationDraftEditor(revalidation.plans);
  const revalidationRunner = createRevalidationRunner({ store, revalidation, runner: nativeTasks, selection: workerSelection,
    allowed: () => values.enabled && configurationError === null && !stop.signal.aborted,
    privacyGeneration: () => privacyGeneration, taskTimeoutMs: () => config.taskTimeoutMs });
  const runtime = new Runtime({ bb, store, config: () => config, privacy, runner: nativeTasks, execution, privacyGeneration: () => privacyGeneration, workers: getMiner,
    dair: research.dair, weeklyIssue: research.weeklyIssue, revalidation: ctx => revalidationRunner.handle(ctx),
    build: createBuilder({ store, config: () => config, runner: nativeTasks, execution, privacyGeneration: () => privacyGeneration, suite: () => values.evaluationSuite, privacy }),
  });
  const services = new Services(bb, store, runtime.handlers, async () => values.enabled && configurationError === null, changed);
  const revalidationOwner = createRevalidationOwnerApi({ store, domain: revalidation, editDraft: editRevalidationDraft, runner: revalidationRunner,
    selection: workerSelection, redact: clean, changed, costs: runId => activityCostView(activity.forRun(runId)) });
  revalidationRunner.recover();
  revalidationOwner.repairQueuedJobs();
  services.register();
  // Reactive hints coalesce separately from the 15-minute sweep, including after that sweep completed.
  registerReactive({ bb, store, accounting, config: () => config, enabled: () => values.enabled && configurationError === null, privacy, redact: clean, owns,
    enqueue: () => { if (values.enabled) services.enqueue("miner", `reactive:${Math.floor(Date.now() / 30000)}`); } });

  let reconciliation: Promise<void> | null = null;
  const reconcile = () => {
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      await nativeTasks.reconcileCleanup();
      await chats.reconcile();
      await chats.reconcileUsage({ maxChats: 100, signal: stop.signal });
      await nativeAccounting.reconcileUsage({ maxTasks: 100, signal: stop.signal });
      store.remove("native-execution-health", "latest");
    })().catch(() => {
      store.put("native-execution-health", "latest", { atMs: Date.now(), issue: "native-reconciliation-pending" });
    }).finally(() => { reconciliation = null; if (!stop.signal.aborted) changed(); });
    return reconciliation;
  };
  bb.background.schedule("native-execution-reconciliation", "*/1 * * * *", async () => { await reconcile(); });
  void reconcile();
  /** After execution or privacy settings change: new privacy generation, fresh workers, and recheck of admitted threads. */
  const refreshExecution = () => {
    privacyGeneration = syncWorkerPrivacy(store, privacy()); miner = null;
    changed(); void reconcile(); void bb.experimental_hooks.recheck("message.dispatch");
  };
  settings.onChange(next => {
    values = next; applyConfig(); research.reset();
    refreshExecution();
  });
  bb.onDispose(async () => {
    await nativeTasks.dispose(); await chats.dispose();
    if (reconciliation) await reconciliation;
    await exporter.flush();
  });
  bb.experimental_hooks.on("message.dispatch", async context => {
    if (context.thread.originPluginId !== "self-improve" && !owns(context.thread.id)) return { action: "proceed" };
    try {
      if (configurationError) return { action: "reject", message: configurationError };
      const task = await nativeTasks.admit(context.thread, {
        originPluginId: context.originPluginId, attempt: context.attempt,
        inputText: context.input.text, requestedExecution: context.requestedExecution,
      });
      if (task) return task.active ? { action: "proceed" } : { action: "reject", message: "Self improve task is inactive" };
      const chat = await chats.admit(context.thread, context);
      return chat?.active ? { action: "proceed" } : { action: "reject", message: "Self improve conversation is inactive; reopen it from the ledger" };
    } catch { return { action: "reject", message: "Self improve execution is unavailable or its settings changed" }; }
  });

  let configurationWrite: Promise<unknown> = Promise.resolve();
  /**
   * Writes the configuration setting, one write at a time. A partial patch is merged into the saved configuration;
   * a function receives the saved configuration and its raw text and returns the complete next value.
   * The result is validated once; an invalid value is refused with the failing field path.
   */
  const updateConfig = (patch: Partial<Config> | ((current: Config, raw: string) => unknown | Promise<unknown>)): Promise<Config> => {
    const next = configurationWrite.catch(() => {}).then(async () => {
      const raw = (await settings.get()).config, current = parseConfig(raw);
      const value = checkConfig(typeof patch === "function" ? await patch(current, raw) : { ...current, ...patch });
      await settings.experimental_set({ config: JSON.stringify(value) });
      values = await settings.get(); applyConfig();
      return value;
    });
    configurationWrite = next; return next;
  };

  return {
    bb, store, settings, accounting, nativeAccounting, activity, nativeTasks, chats, services, research,
    revalidation, revalidationOwner, editRevalidationDraft,
    get config() { return config; }, get values() { return values; },
    get configurationError() { return configurationError; }, get exportError() { return exportError; },
    signal: stop.signal, privacy, clean, owns, changed, refreshExecution, updateConfig,
  };
}
export type Context = Awaited<ReturnType<typeof createContext>>;
