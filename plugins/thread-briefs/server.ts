import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  BRIEFS_CHANGED_CHANNEL,
  rpcContract,
  storedBriefSchema,
  type BriefStage,
  type BriefState,
  type RowSignal,
  type StoredBrief,
} from "./contract.js";
import {
  awaitingUser,
  briefKey,
  deriveStatus,
  isStageOverrideStale,
  resolveBrief,
  rowSignalFor,
  threadIdFromKey,
} from "./brief.js";
import {
  buildUserPrompt,
  parseSummary,
  requestSummary,
  type CompletionConfig,
} from "./summarize.js";
import { endsWithQuestion, renderTranscript, type OutlineItem } from "./transcript.js";

/** Cap on one summarizer call, so a hung endpoint cannot stall the queue. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Backstop sweep: catches activity whose `thread.idle` we never saw. */
const SWEEP_CRON = "*/10 * * * *";
/** Threads considered per sweep, newest first. */
const SWEEP_LIMIT = 200;

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "API base URL",
      default: "https://api.openai.com/v1",
    },
    apiKey: { type: "string", label: "API key", secret: true },
    model: { type: "string", label: "Model", default: "gpt-4o-mini" },
    jsonMode: {
      type: "boolean",
      label: "Request JSON mode",
      default: true,
    },
    quietSeconds: {
      type: "number",
      label: "Quiet period before summarizing (seconds)",
      default: 120,
    },
  });

  const initial = await settings.get();
  if (
    typeof initial.apiKey !== "string" ||
    initial.apiKey.trim() === ""
  ) {
    bb.status.needsConfiguration(
      `Set an API key with \`bb plugin config ${bb.pluginId} set apiKey <key>\`, then reload.`,
    );
  }

  // ---------------------------------------------------------------- storage

  const readBrief = async (threadId: string): Promise<StoredBrief | null> => {
    const raw = await bb.storage.kv.get<unknown>(briefKey(threadId));
    if (raw === undefined) return null;
    const parsed = storedBriefSchema.safeParse(raw);
    if (!parsed.success) {
      // A row written by an older/newer shape is not worth crashing a read
      // over; drop it and let the next summary rewrite it.
      bb.log.warn(`discarding unreadable brief for ${threadId}`);
      await bb.storage.kv.delete(briefKey(threadId));
      return null;
    }
    return parsed.data;
  };

  const writeBrief = async (brief: StoredBrief) => {
    await bb.storage.kv.set(briefKey(brief.threadId), brief);
  };

  const deleteBrief = async (threadId: string) => {
    await bb.storage.kv.delete(briefKey(threadId));
  };

  const announce = () => {
    bb.realtime.publish(BRIEFS_CHANGED_CHANNEL, { at: Date.now() });
  };

  // ------------------------------------------------------------ queue/timers

  const lifetime = new AbortController();
  /** Per-thread debounce timers: the thread must stay quiet to be summarized. */
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  /** Threads waiting for the single worker, in arrival order. */
  const queue: string[] = [];
  /** Threads to summarize even when the activity cursor has not moved. */
  const forced = new Set<string>();
  let draining = false;

  const enqueue = (threadId: string) => {
    if (!queue.includes(threadId)) queue.push(threadId);
    void drain();
  };

  /**
   * Debounce a thread. `thread.idle` fires on every turn boundary, so a thread
   * in active back-and-forth would otherwise be re-summarized every turn; we
   * want the brief written once the burst has actually stopped.
   */
  const scheduleSummary = (threadId: string, delayMs: number) => {
    const existing = debounces.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounces.delete(threadId);
      enqueue(threadId);
    }, delayMs);
    // Never hold the process open for a brief.
    timer.unref?.();
    debounces.set(threadId, timer);
  };

  const cancelSummary = (threadId: string) => {
    const existing = debounces.get(threadId);
    if (existing !== undefined) {
      clearTimeout(existing);
      debounces.delete(threadId);
    }
  };

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !lifetime.signal.aborted) {
        const threadId = queue.shift();
        if (threadId === undefined) break;
        const force = forced.delete(threadId);
        try {
          const changed = await summarizeThread(threadId, force);
          if (changed) announce();
        } catch (error) {
          bb.log.warn(
            `brief for ${threadId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      draining = false;
    }
  }

  // ------------------------------------------------------------- summarizing

  const completionConfig = async (): Promise<CompletionConfig> => {
    const values = await settings.get();
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    if (apiKey === "") {
      throw Object.assign(new Error("no API key configured"), {
        name: "NeedsConfigurationError",
      });
    }
    return {
      baseUrl: values.baseUrl,
      apiKey,
      model: values.model,
      jsonMode: values.jsonMode,
    };
  };

  /** Returns true when a brief was written (so callers know to announce). */
  async function summarizeThread(
    threadId: string,
    force: boolean,
  ): Promise<boolean> {
    const thread = await bb.sdk.threads
      .get({ threadId })
      .catch(() => null);
    if (thread === null) {
      await deleteBrief(threadId);
      return true;
    }
    // Hidden threads are plugin workers, not work the user is tracking.
    if (thread.visibility === "hidden" || thread.deletedAt !== null) {
      await deleteBrief(threadId);
      return true;
    }

    const outline = await bb.sdk.threads.conversationOutline({ threadId });
    if (outline.items.length === 0) return false;

    const stored = await readBrief(threadId);
    if (
      !force &&
      stored !== null &&
      stored.lastActivitySeen >= outline.maxSeq
    ) {
      // Nothing new has happened since the last brief.
      return false;
    }

    const config = await completionConfig();
    const { output } = await bb.sdk.threads.output({ threadId });

    // An override in force is passed to the model as fixed; a stale one is
    // dropped here, which is what "sticks until real thread activity" means.
    const overrideInForce =
      stored !== null && !isStageOverrideStale(stored)
        ? stored.stageOverride
        : null;

    const transcript = renderTranscript({
      title: thread.title ?? thread.titleFallback,
      outline: outline.items.map(
        (item): OutlineItem => ({ role: item.role, preview: item.preview }),
      ),
      lastAssistantText: output,
      previousBrief: stored?.fields ?? null,
    });

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, lifetime.signal]);
    const reply = await requestSummary(
      config,
      buildUserPrompt({ transcript, fixedStage: overrideInForce }),
      signal,
    );
    const summary = parseSummary(reply, overrideInForce);

    await writeBrief({
      version: 1,
      threadId,
      fields: {
        goal: summary.goal,
        currentState: summary.currentState,
        nextStep: summary.nextStep,
        blockedOn: summary.blockedOn,
        constraints: summary.constraints,
      },
      modelStage: summary.stage,
      stageOverride: overrideInForce,
      stageOverrideSeq: overrideInForce === null ? null : outline.maxSeq,
      endedWithQuestion: endsWithQuestion(output),
      lastSummarizedAt: Date.now(),
      lastActivitySeen: outline.maxSeq,
    });
    return true;
  }

  // -------------------------------------------------------------- reading

  const hasPendingInteraction = async (threadId: string): Promise<boolean> => {
    const interactions = await bb.sdk.threads.interactions
      .list({ threadId })
      .catch(() => []);
    return interactions.length > 0;
  };

  const briefState = async (threadId: string): Promise<BriefState> => {
    const stored = await readBrief(threadId);
    if (stored === null) {
      const values = await settings.get();
      if (typeof values.apiKey !== "string" || values.apiKey.trim() === "") {
        return {
          state: "unconfigured",
          message: "Add an API key in this plugin's settings to generate briefs.",
        };
      }
      return { state: "summarizing" };
    }
    return {
      state: "ready",
      brief: resolveBrief(stored, {
        hasPendingInteraction: await hasPendingInteraction(threadId),
      }),
    };
  };

  // ------------------------------------------------------------------- rpc

  bb.rpc.register(rpcContract, {
    getBrief: ({ threadId }) => briefState(threadId),

    listRowSignals: async () => {
      const keys = await bb.storage.kv.list("brief:");
      const signals: RowSignal[] = [];
      for (const key of keys) {
        const stored = await readBrief(threadIdFromKey(key));
        if (stored === null) continue;
        // No interaction lookups here: the client folds that in per row.
        signals.push(
          rowSignalFor(
            resolveBrief(stored, { hasPendingInteraction: false }),
          ),
        );
      }
      return { signals };
    },

    setStageOverride: async ({ threadId, stage }) => {
      const stored = await readBrief(threadId);
      if (stored === null) return briefState(threadId);
      await writeBrief({
        ...stored,
        stageOverride: stage,
        // Anchor the override to the activity the user was looking at, so the
        // next real turn retires it.
        stageOverrideSeq: stage === null ? null : stored.lastActivitySeen,
      });
      announce();
      return briefState(threadId);
    },

    refresh: ({ threadId }) => {
      cancelSummary(threadId);
      forced.add(threadId);
      enqueue(threadId);
      return { queued: true };
    },
  });

  // ---------------------------------------------------------------- events

  bb.events.on("thread.idle", ({ thread }) => {
    void settings.get().then((values) => {
      scheduleSummary(thread.id, Math.max(1, values.quietSeconds) * 1000);
    });
  });

  // A thread that started running again is not quiet; let the next idle
  // restart its debounce rather than summarizing mid-turn.
  bb.events.on("thread.active", ({ thread }) => {
    cancelSummary(thread.id);
  });

  // The thread now wants something from the user. No new summary is needed —
  // status is derived — but the sidebar should repaint.
  bb.events.on("interaction.pending", () => {
    announce();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    cancelSummary(thread.id);
    void deleteBrief(thread.id).then(announce);
  });

  // ---------------------------------------------------------------- sweep

  /**
   * Backstop for activity whose `thread.idle` never reached us: the server was
   * restarting, the plugin was reloading, or the turn ended in an error rather
   * than idle. Cheap because it compares stored cursors and only summarizes
   * threads that actually moved.
   */
  bb.background.schedule("brief-sweep", SWEEP_CRON, async () => {
    const values = await settings.get();
    if (typeof values.apiKey !== "string" || values.apiKey.trim() === "") return;

    const threads = await bb.sdk.threads.list({ limit: SWEEP_LIMIT });
    const quietBefore = Date.now() - Math.max(1, values.quietSeconds) * 1000;

    for (const thread of threads) {
      if (thread.visibility === "hidden") continue;
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.status === "active" || thread.status === "starting") continue;
      if (thread.updatedAt > quietBefore) continue;
      if (debounces.has(thread.id) || queue.includes(thread.id)) continue;

      const stored = await readBrief(thread.id);
      // A thread with no brief yet, or one whose timestamp predates its last
      // activity, is a candidate. `summarizeThread` re-checks the real cursor
      // before spending a request.
      if (stored === null || stored.lastSummarizedAt < thread.updatedAt) {
        enqueue(thread.id);
      }
    }
  });

  bb.onDispose(() => {
    lifetime.abort();
    for (const timer of debounces.values()) clearTimeout(timer);
    debounces.clear();
    queue.length = 0;
    forced.clear();
  });
}

// Re-exported for tests that exercise the derivation without a server.
export { awaitingUser, deriveStatus };
export type { BriefStage };
