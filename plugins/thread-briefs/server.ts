import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BRIEFS_CHANGED_CHANNEL,
  rpcContract,
  storedBriefSchema,
  type BriefStage,
  type BriefState,
  type RefresherState,
  type StoredBlockReason,
  type StoredBrief,
  type StoredRefresher,
} from "./contract.js";
import {
  briefCardFor,
  briefKey,
  effectiveStatus,
  overrideHolds,
  planRename,
  resolveBrief,
  rowSignalFor,
  threadIdFromKey,
} from "./brief.js";
import { chooseRefresher, refresherSeenKey } from "./refresher.js";
import {
  planArchives,
  type ArchiveBriefFacts,
  type ArchiveCandidate,
} from "./archive.js";
import {
  hoursToMs,
  DEFAULT_DONE_ARCHIVE_HOURS,
  DEFAULT_DONE_STALE_HOURS,
} from "./shared.js";
import {
  buildUserPrompt,
  parseSummary,
  requestSummary,
  type CompletionConfig,
} from "./summarize.js";
import {
  ENV_API_KEY,
  resolveApiKey,
  resolveCompletion,
  settingDefaults,
} from "./config.js";
import { endsWithQuestion, renderTranscript, type OutlineItem } from "./transcript.js";
import {
  mergeSectionOrder,
  planAssignments,
  planSections,
  sectionNameForStatus,
  storedStatus,
  OWNED_SECTION_NAMES,
  type SectionedThread,
} from "./sections.js";

/** Cap on one summarizer call, so a hung endpoint cannot stall the queue. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Backstop sweep: catches activity whose `thread.idle` we never saw. */
const SWEEP_CRON = "*/10 * * * *";
/** Threads considered per sweep, newest first. */
const SWEEP_LIMIT = 200;
/**
 * The auto-archive sweep, on its own schedule rather than folded into the brief
 * sweep above: that one returns early without an API key, and archiving a
 * finished thread has nothing to do with whether a summarizer is configured.
 *
 * Hourly, on a minute nothing else runs on. The thresholds it compares against
 * are measured in days, so a sweep that is up to an hour late is invisible —
 * and running it at :00 alongside the brief sweep would put a burst of archive
 * writes on top of a burst of summaries.
 */
const ARCHIVE_CRON = "17 * * * *";
/**
 * Threads considered per archive sweep, newest first.
 *
 * The same cap as the brief sweep, and it self-corrects the same way: anything
 * beyond it is caught on a later pass, because a thread that is eligible today
 * is still eligible in an hour.
 */
const ARCHIVE_LIMIT = 500;
/** The plugin that owns the sidebar list, and so its layout preferences. */
const THREAD_LIST_PLUGIN_ID = "thread-list";
/** Where the grouping records what it changed, so `off` can put it back. */
const SIDEBAR_STATE_KEY = "sidebar-grouping-state";
/** One page of the thread list while reconciling sections. */
const SECTION_PAGE_SIZE = 200;
/**
 * Cap on a reconcile, so a very long thread list cannot turn one brief write
 * into an unbounded walk.
 */
const SECTION_THREAD_LIMIT = 2_000;
/**
 * Quiet period before a reconcile. Brief writes arrive one per summarized
 * thread; this coalesces a burst of them into a single pass.
 */
const SECTION_SYNC_DEBOUNCE_MS = 2_000;

/** The `thread-list` preferences the grouping takes over, and their targets. */
const GROUPED_PREFS = {
  organizationMode: "chronological",
  chronologicalSort: "updated",
} as const;

/** The `thread-list` preference holding the sidebar's section order. */
const ORDER_PREF = "manualSectionOrder";

/** Every preference the grouping can write, and so has to put back. */
const RESTORED_PREFS: readonly string[] = [...Object.keys(GROUPED_PREFS), ORDER_PREF];

/** What the grouping changed, recorded before the first write. */
interface SidebarGroupingState {
  applied: boolean;
  /** Prior preference values, or null for one bb had never been given. */
  previous: Record<string, unknown> | null;
}

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  // The server's environment can carry deployment-wide summarizer defaults
  // (THREAD_BRIEFS_*), so a fleet of servers shares one key and endpoint. A
  // stored setting wins over them; see config.ts.
  const env = process.env;
  const envDefaults = settingDefaults(env);
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "API base URL (root or full /chat/completions endpoint)",
      description:
        "Unset, the server's THREAD_BRIEFS_BASE_URL is used when the deployment sets one.",
      default: envDefaults.baseUrl,
    },
    apiKey: {
      type: "string",
      label: "API key",
      description:
        "Unset, the server's THREAD_BRIEFS_API_KEY is used when the deployment sets one.",
      secret: true,
    },
    model: {
      type: "string",
      label: "Model",
      description:
        "Unset, the server's THREAD_BRIEFS_MODEL is used when the deployment sets one.",
      default: envDefaults.model,
    },
    jsonMode: {
      type: "boolean",
      label: "Request JSON mode",
      description:
        "Send response_format json_object. Turn off for endpoints that reject it. The deployment's THREAD_BRIEFS_JSON_MODE sets the default.",
      default: envDefaults.jsonMode,
    },
    refresherIdleHours: {
      type: "number",
      label: "Show the re-entry refresher after this many idle hours",
      description:
        "Opening a thread that has sat idle this long, and whose last activity you have not already dismissed, shows a two-line reorientation above the composer. Threads idle for three times this long get the fuller version. Set to 0 to turn the refresher off.",
      // An hour: long enough that you have genuinely context-switched away,
      // short enough to catch the ordinary return — after a meeting, after
      // lunch, after an afternoon on another thread. Eight was the first guess
      // and it was too conservative by far. It fired only on threads left
      // overnight, which is a small enough slice of returns that the feature
      // read as broken rather than as quiet. The worry it was guarding against
      // — a banner you learn to close is one you stop reading on the day it
      // matters — turns out to be the dismissal record's job, not the
      // threshold's: a dismissed banner stays gone until the thread does
      // something new, however low this is set.
      default: 1,
    },
    renameThreads: {
      type: "boolean",
      label: "Rename threads to the brief's title",
      description:
        "Replaces bb's opening-prompt title with the short name the summarizer chose, refreshed on every summary. Stops renaming a thread for good once you rename it yourself. bb's original title is not kept anywhere, so turning this off leaves the last name it wrote in place.",
      default: false,
    },
    doneStaleHours: {
      type: "number",
      label: "Grey out a done thread's ring after this many idle hours",
      description:
        "A thread whose brief says done and which has had no activity for this long draws a grey ring instead of its project's colour, so a finished-and-forgotten thread reads differently from one that finished this morning. Set to 0 to keep every done ring in its project colour.",
      default: DEFAULT_DONE_STALE_HOURS,
    },
    doneArchiveHours: {
      type: "number",
      label: "Archive a done thread after this many idle hours",
      description:
        "Archives a thread whose brief says done and which has had no activity for this long. Pinned threads are never archived, and a thread you un-archive is left alone until you work in it again. Set to 0 to never archive automatically.",
      default: DEFAULT_DONE_ARCHIVE_HOURS,
    },
    sidebarGrouping: {
      type: "select",
      label: "Group sidebar threads by brief status",
      description:
        '"status" replaces the sidebar\'s project grouping with Waiting on you / Blocked / Done sections, newest first inside each. Reorder the sections in the sidebar and that order is kept. "off" puts the previous grouping back and removes the sections.',
      options: ["off", "status"],
      default: "off",
    },
  });

  /** Whether a summary can be requested at all: a key stored or in the environment. */
  const hasApiKey = (values: { apiKey?: unknown }): boolean =>
    resolveApiKey(values.apiKey, env) !== null;

  const initial = await settings.get();
  if (!hasApiKey(initial)) {
    bb.status.needsConfiguration(
      `Set an API key with \`bb plugin config ${bb.pluginId} set apiKey <key>\` (or ${ENV_API_KEY} in the server's environment), then reload.`,
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
    // The dismissal is meaningless without the brief it silenced, and leaving
    // it would silence the *next* brief this thread earns if its attention
    // cursor had not moved on in the meantime.
    await bb.storage.kv.delete(refresherSeenKey(threadId));
  };

  /**
   * The thread's attention cursor when its refresher was last dismissed.
   *
   * A plain number rather than a parsed row: the only thing stored is the
   * cursor, and a value that will not read as one is treated as no dismissal
   * at all — showing a refresher one extra time is the harmless failure.
   */
  const readDismissal = async (threadId: string): Promise<number | null> => {
    const raw = await bb.storage.kv.get<unknown>(refresherSeenKey(threadId));
    const at = (raw as { attentionAt?: unknown } | undefined)?.attentionAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  };

  /**
   * Record a dismissal, never moving the cursor backwards.
   *
   * Monotonic because two windows can have the same thread open: the one you
   * typed in dismisses at the cursor it was shown for, and a stale dismiss from
   * the other window must not reopen the question.
   */
  const writeDismissal = async (threadId: string, attentionAt: number) => {
    const existing = (await readDismissal(threadId)) ?? Number.NEGATIVE_INFINITY;
    if (attentionAt <= existing) return;
    await bb.storage.kv.set(refresherSeenKey(threadId), { attentionAt });
  };

  const announce = () => {
    // A summary already in flight when the plugin is disposed still runs its
    // `finally`, and publishing on a torn-down handle throws. Nobody is
    // listening on a dead generation anyway.
    if (lifetime.signal.aborted) return;
    bb.realtime.publish(BRIEFS_CHANGED_CHANNEL, { at: Date.now() });
  };

  // ------------------------------------------------------------ queue/timers

  const lifetime = new AbortController();
  /**
   * When this plugin generation started. The cutoff for "has there been
   * activity?": threads that last moved before we were running are not
   * backfilled.
   */
  const loadedAt = Date.now();
  /**
   * Aborts the summary the worker is running right now. A later turn boundary
   * on the same thread trips it: the brief it was about to write describes a
   * state the thread has already left, so it is dropped and the thread is
   * summarized again from the newer transcript. See {@link supersede}.
   */
  let inFlightRun: AbortController | null = null;
  /** Threads waiting for the single worker, in arrival order. */
  const queue: string[] = [];
  /** Threads to summarize even when the activity cursor has not moved. */
  const forced = new Set<string>();
  /**
   * Threads queued from `thread.active` — a first brief written from the opening
   * prompt, before the turn it describes has finished. Flagged because such a
   * brief must not name the thread: see {@link summarizeThread}.
   */
  const preTurn = new Set<string>();
  /** The thread the single worker is summarizing right now, if any. */
  let inFlight: string | null = null;
  let draining = false;

  /** Whether a summary for this thread is genuinely pending or running. */
  const isPending = (threadId: string) =>
    queue.includes(threadId) || inFlight === threadId;

  const enqueue = (threadId: string) => {
    if (!queue.includes(threadId)) queue.push(threadId);
    void drain();
  };

  /**
   * Summarize a thread now, dropping any summary of it still in flight.
   *
   * There is no quiet period. `thread.idle` fires at every turn boundary and
   * each one starts a summary at once, so the brief, ring and status follow
   * the turn by the length of one summarizer call rather than by a timer. A
   * thread in quick back-and-forth is protected the other way round: a turn
   * that ends while its predecessor's summary is still running aborts that
   * request — its result was going to be stale on arrival — and the newest
   * transcript is summarized instead. The last turn boundary always wins, and
   * the brief that lands is never older than the thread it describes.
   */
  const supersede = (threadId: string) => {
    if (inFlight === threadId) inFlightRun?.abort();
    enqueue(threadId);
  };

  async function drain() {
    if (draining) return;
    draining = true;
    let wrote = false;
    try {
      while (queue.length > 0 && !lifetime.signal.aborted) {
        const threadId = queue.shift();
        if (threadId === undefined) break;
        const force = forced.delete(threadId);
        const beforeFirstTurn = preTurn.delete(threadId);
        inFlight = threadId;
        const run = new AbortController();
        inFlightRun = run;
        try {
          const changed = await summarizeThread(threadId, {
            force,
            beforeFirstTurn,
            signal: run.signal,
          });
          if (changed) {
            wrote = true;
            announce();
          }
        } catch (error) {
          // Superseded by a later turn boundary, and already re-queued: not a
          // failure, and not worth a line in the log.
          if (run.signal.aborted) continue;
          bb.log.warn(
            `brief for ${threadId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          inFlight = null;
          inFlightRun = null;
          // The thread drops back to `absent` on failure, so the UI stops
          // saying "summarizing" and offers an explicit retry instead.
          announce();
        }
      }
    } finally {
      draining = false;
      // One reconcile for the whole batch, once the queue is empty.
      if (wrote) scheduleReconcile();
    }
  }

  // ------------------------------------------------------------- summarizing

  const completionConfig = async (): Promise<CompletionConfig> => {
    const config = resolveCompletion(await settings.get(), env);
    if (config === null) {
      throw Object.assign(new Error("no API key configured"), {
        name: "NeedsConfigurationError",
      });
    }
    return config;
  };

  /**
   * Put the brief's title on the thread, and report the title we are now on
   * record as having written.
   *
   * Returns the previous `appliedTitle` unchanged whenever nothing was written
   * — including on failure — because that value is what makes a hand-rename
   * stick: see {@link planRename}.
   *
   * The thread is re-read first. `summarizeThread` fetched it before a
   * summarizer call that can take a minute, and a rename during that minute is
   * exactly the case this must not lose.
   */
  async function applyTitle(args: {
    threadId: string;
    title: string | undefined;
    applied: string | null;
    /** The title as of before the summarizer call. */
    staleCurrent: string | null;
  }): Promise<string | null> {
    if (!(await settings.get()).renameThreads) return args.applied;
    // Cheap pre-check on what we already hold, so a settled thread costs no
    // extra round trip; the authoritative check is below.
    if (
      planRename({
        current: args.staleCurrent,
        desired: args.title,
        applied: args.applied,
      }) === null
    ) {
      return args.applied;
    }

    const fresh = await bb.sdk.threads.get({ threadId: args.threadId }).catch(() => null);
    if (fresh === null) return args.applied;
    const title = planRename({
      current: fresh.title,
      observed: args.staleCurrent,
      desired: args.title,
      applied: args.applied,
    });
    if (title === null) return args.applied;

    try {
      await bb.sdk.threads.update({ threadId: args.threadId, title });
    } catch (error) {
      // A rename is not worth losing the brief over. Keeping the old
      // `appliedTitle` also keeps the thread eligible for a retry next time.
      bb.log.warn(
        `could not rename ${args.threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return args.applied;
    }
    return title;
  }

  /**
   * Carry a manual override through a summary, or drop it.
   *
   * An override is anchored to the cursor it was set at and survives only while
   * the thread has not moved past it: a forced re-summary of an unchanged thread
   * keeps the pin, and a summary that follows a real turn retires it. The
   * original anchor is kept rather than re-stamped to the new cursor — restamping
   * would make every override permanent, since the pin would advance in step with
   * the activity meant to expire it.
   */
  function carryOverride<T>(
    value: T | null | undefined,
    anchorSeq: number | null | undefined,
    cursor: number,
  ): { value: T | null; seq: number | null } {
    const kept = value ?? null;
    if (kept === null || !overrideHolds(anchorSeq, cursor)) {
      return { value: null, seq: null };
    }
    return { value: kept, seq: anchorSeq ?? cursor };
  }

  /** How many user messages an outline holds: the cursor a block note sits on. */
  const countUserMessages = (items: readonly { role: string }[]): number =>
    items.filter((item) => item.role === "user").length;

  /**
   * A block reason as stored, placed at the thread's current user-message
   * count. Null for a blank, which is how both callers spell "clear".
   */
  async function recordBlockReason(
    threadId: string,
    text: string | null | undefined,
  ): Promise<StoredBlockReason | null> {
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") return null;
    const outline = await bb.sdk.threads.conversationOutline({ threadId });
    return {
      text: trimmed,
      recordedAt: Date.now(),
      userMessagesSeen: countUserMessages(outline.items),
    };
  }

  /**
   * Returns true when a brief was written (so callers know to announce).
   *
   * `beforeFirstTurn` marks a brief written from the opening prompt while the
   * first turn is still running. It is summarized like any other, and it renames
   * the thread only where bb left it unnamed — a null `title`, so the row is
   * showing `titleFallback`: the opening prompt clamped to 80 characters. A
   * four-word name read off that prompt beats the prompt itself, and waiting for
   * the turn to end means a long first turn spends its whole length under a
   * truncated sentence.
   *
   * Where bb did guess a name the wait still applies, because that guess came
   * from the same opening prompt: a pre-turn title is no better than what is
   * already there, the summary after the turn will choose better, and applying
   * this one would rename the thread twice within a minute — each rename also
   * dispatching a command into the thread's environment.
   */
  async function summarizeThread(
    threadId: string,
    {
      force,
      beforeFirstTurn,
      signal: superseded,
    }: { force: boolean; beforeFirstTurn: boolean; signal: AbortSignal },
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

    // A stage override in force is passed to the model as fixed; one the thread
    // has moved past is dropped here, which is what "sticks until real thread
    // activity" means. The status override expires on the same terms, but is not
    // passed as fixed: the model still judges the status from the transcript,
    // and only the refresher prose is told about the pin.
    const stagePin = carryOverride(
      stored?.stageOverride,
      stored?.stageOverrideSeq,
      outline.maxSeq,
    );
    const statusPin = carryOverride(
      stored?.statusOverride,
      stored?.statusOverrideSeq,
      outline.maxSeq,
    );

    const blockReason = stored?.blockReason ?? null;
    const transcript = renderTranscript({
      title: thread.title ?? thread.titleFallback,
      outline: outline.items.map(
        (item): OutlineItem => ({ role: item.role, preview: item.preview }),
      ),
      lastAssistantText: output,
      previousBrief: stored?.fields ?? null,
      blockReason,
    });

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, lifetime.signal, superseded]);
    const reply = await requestSummary(
      config,
      buildUserPrompt({
        transcript,
        fixedStage: stagePin.value,
        // The pin reaches the prompt for the refresher prose alone: the five
        // fields keep describing the work, and only the paragraph that tells
        // the user what to do is asked to agree with what they pinned.
        pinnedStatus: statusPin.value,
        hasBlockReason: blockReason !== null,
      }),
      signal,
    );
    // The request can return in the same tick the abort lands. A superseded
    // summary writes nothing: a newer one is already queued behind it.
    if (superseded.aborted) return false;
    const summary = parseSummary(reply, stagePin.value);

    // The reason outlives the pin, but not the user's own say-so: a summary
    // that follows a *new user message* and still reads the thread as not
    // blocked means the model read that message as resolving it, and the
    // reason is released. A summary over the same messages — a forced
    // re-summary, an agent turn finishing — keeps it whatever the model said,
    // because nothing the user did has changed, and a small model's one bad
    // reading must not quietly un-park a thread.
    const userMessages = countUserMessages(outline.items);
    const keepReason =
      blockReason !== null &&
      !(
        userMessages > blockReason.userMessagesSeen &&
        summary.status !== "waiting-on-other"
      );
    if (blockReason !== null && !keepReason) {
      bb.log.info(`block reason on ${threadId} released: the thread moved on`);
    }

    // A thread bb has already named waits for its first turn to end before this
    // plugin renames it; one showing nothing but its own opening prompt does
    // not. See {@link summarizeThread}.
    const appliedTitle = beforeFirstTurn && thread.title !== null
      ? (stored?.appliedTitle ?? null)
      : await applyTitle({
          threadId,
          title: summary.title,
          applied: stored?.appliedTitle ?? null,
          staleCurrent: thread.title,
        });

    const fields = {
      title: summary.title,
      goal: summary.goal,
      currentState: summary.currentState,
      nextStep: summary.nextStep,
      nextStepActor: summary.nextStepActor,
      blockedOn: summary.blockedOn,
      constraints: summary.constraints,
    };
    // The reading the prose was written against, stamped from the same pin and
    // the same fields the summary just produced rather than re-derived later.
    // A status pinned *after* this write makes the two disagree, and that
    // disagreement is exactly what stops the refresher showing: see
    // {@link chooseRefresher}.
    const refresher: StoredRefresher | null =
      summary.refresher === null
        ? null
        : {
            ...summary.refresher,
            writtenForStatus: statusPin.value ?? summary.status,
          };

    await writeBrief({
      version: 1,
      threadId,
      fields,
      modelStage: summary.stage,
      modelStatus: summary.status,
      stageOverride: stagePin.value,
      stageOverrideSeq: stagePin.seq,
      statusOverride: statusPin.value,
      statusOverrideSeq: statusPin.seq,
      blockReason: keepReason ? blockReason : null,
      endedWithQuestion: endsWithQuestion(output),
      appliedTitle,
      refresher,
      lastSummarizedAt: Date.now(),
      lastActivitySeen: outline.maxSeq,
    });
    return true;
  }

  // -------------------------------------------------------------- reading

  const briefState = async (threadId: string): Promise<BriefState> => {
    const stored = await readBrief(threadId);
    if (stored === null) {
      if (!hasApiKey(await settings.get())) {
        return {
          state: "unconfigured",
          message: "Add an API key in this plugin's settings to generate briefs.",
        };
      }
      // Only claim a summary is coming when one actually is. A thread that was
      // already dormant when the plugin arrived is never backfilled, so it sits
      // at `absent` until someone asks for a brief.
      return isPending(threadId) ? { state: "summarizing" } : { state: "absent" };
    }
    return { state: "ready", brief: resolveBrief(stored) };
  };

  /** The configured idle threshold in ms; 0 when the refresher is off. */
  const refresherThresholdMs = async (): Promise<number> => {
    const hours = Number((await settings.get()).refresherIdleHours);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return hours * 3_600_000;
  };

  /**
   * The reorientation for one thread, decided in a single pass.
   *
   * Three reads at most, and the first two short-circuit the rest: the
   * threshold comes from settings already in memory, and a thread with no brief
   * never costs a `threads.get`. This runs once per thread open, so it is on
   * the path of every navigation in the app — it has to stay cheap enough that
   * a thread the refresher will never fire on pays almost nothing.
   */
  const refresherState = async (
    threadId: string,
  ): Promise<RefresherState | null> => {
    const thresholdMs = await refresherThresholdMs();
    if (thresholdMs === 0) return null;

    const stored = await readBrief(threadId);
    if (stored === null || (stored.refresher ?? null) === null) return null;

    // `latestAttentionAt` rather than `updatedAt`: this plugin writes a thread's
    // title and its section, and both move `updatedAt`. A rename is not
    // activity you were away from, and counting it as such would reset the
    // idle clock on exactly the threads this is for.
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (thread === null) return null;

    const choice = chooseRefresher({
      prose: stored.refresher,
      status: effectiveStatus(stored),
      threadStatus: thread.status,
      latestAttentionAt: thread.latestAttentionAt,
      dismissedAt: await readDismissal(threadId),
      now: Date.now(),
      thresholdMs,
    });
    return choice === null ? null : { threadId, ...choice };
  };

  // ------------------------------------------------------------------- rpc

  /**
   * Every stored brief, projected into whatever the caller's surface wants.
   *
   * One kv scan and no `threads.get` per row, which is what lets both list calls
   * stay cheap enough to run on every `briefs-changed` in every open window. The
   * two callers differ only in the projection, so sharing the scan is also what
   * keeps the sidebar's signals and the board's cards from drifting apart about
   * which briefs exist.
   */
  const mapStoredBriefs = async <Value>(
    project: (stored: StoredBrief) => Value,
  ): Promise<Value[]> => {
    const values: Value[] = [];
    for (const key of await bb.storage.kv.list("brief:")) {
      const stored = await readBrief(threadIdFromKey(key));
      if (stored === null) continue;
      values.push(project(stored));
    }
    return values;
  };

  /**
   * The two done-thread thresholds, sent with every list call.
   *
   * On the wire rather than read from settings on the client, because the
   * archive sweep decides with these same numbers: one source, so a grey card
   * cannot promise an archiving the sweep is not about to do.
   */
  const ringThresholds = async () => {
    const values = await settings.get();
    return {
      staleAfterMs: hoursToMs(values.doneStaleHours),
      archiveAfterMs: hoursToMs(values.doneArchiveHours),
    };
  };

  bb.rpc.register(rpcContract, {
    getBrief: ({ threadId }) => briefState(threadId),

    listRowSignals: async () => ({
      // No live thread lookups here: the client folds the running/queued
      // override and the staleness in per row, off the sidebar view it
      // already has.
      signals: await mapStoredBriefs((stored) =>
        rowSignalFor(resolveBrief(stored)),
      ),
      ...(await ringThresholds()),
    }),

    listBriefCards: async () => ({
      cards: await mapStoredBriefs(briefCardFor),
      ...(await ringThresholds()),
    }),

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
      rewriteRefresher(threadId);
      return briefState(threadId);
    },

    setStatusOverride: async ({ threadId, status, reason }) => {
      const stored = await readBrief(threadId);
      if (stored === null) return briefState(threadId);
      // The reason rides with a Blocked pin and is cleared by any other pin:
      // pinning a thread done or waiting-on-you is the user saying the block
      // is over, and a note that kept telling the summarizer otherwise would
      // argue with them on the next summary. Clearing the pin (null) leaves
      // the note alone — the pin retiring is not a change of mind.
      const blockReason =
        status === "waiting-on-other"
          ? reason === undefined
            ? (stored.blockReason ?? null)
            : await recordBlockReason(threadId, reason)
          : status === null
            ? (stored.blockReason ?? null)
            : null;
      await writeBrief({
        ...stored,
        statusOverride: status,
        // Anchored to the activity the user was looking at, so the next real
        // turn retires it — the same contract as the stage override.
        statusOverrideSeq: status === null ? null : stored.lastActivitySeen,
        blockReason,
      });
      announce();
      // The status is what the sidebar sections are keyed on, so a pin has to
      // move the thread as well as its glyph. Debounced, so clicking through a
      // few threads is still one pass.
      scheduleReconcile();
      rewriteRefresher(threadId);
      return briefState(threadId);
    },

    setBlockReason: async ({ threadId, text }) => {
      const stored = await readBrief(threadId);
      if (stored === null) return briefState(threadId);
      await writeBrief({
        ...stored,
        blockReason: await recordBlockReason(threadId, text),
      });
      announce();
      // The note changes what the summarizer writes for `blockedOn` and
      // `status`, and the sections key on the status, so it is re-read now
      // rather than on the next turn. Same path as a pin.
      rewriteRefresher(threadId);
      return briefState(threadId);
    },

    refresh: ({ threadId }) => {
      // An explicit Re-summarize is a full brief, title included, even if a
      // pre-turn one was already queued for this thread.
      preTurn.delete(threadId);
      forced.add(threadId);
      enqueue(threadId);
      return { queued: true };
    },

    getRefresher: async ({ threadId }) => ({
      refresher: await refresherState(threadId),
    }),

    dismissRefresher: async ({ threadId, attentionAt }) => {
      await writeDismissal(threadId, attentionAt);
      // No announce: nothing else on screen reads the dismissal, and the banner
      // that sent this has already hidden itself. Poking the realtime channel
      // would repaint every sidebar row in every window to record a click.
      return { dismissed: true };
    },
  });

  /**
   * Re-summarize because a manual override changed what the refresher should
   * say.
   *
   * The five fields are not what moved — a pin does not touch the transcript —
   * but the refresher prose is written *to* the user about what to do next, and
   * a pin is a statement that the derivation was wrong about that. The prose
   * cannot be patched: it is sentences, not fields, and regenerating it is a
   * model call, which this design refuses to make when a thread is opened. So
   * it is made here instead, when the pin is set, where a second's latency
   * costs nothing and the user is not waiting on it.
   *
   * Until it lands the refresher simply does not show — `writtenForStatus` no
   * longer matches the effective status, so {@link chooseRefresher} declines.
   * That is also the whole recovery path if this call fails: nothing is shown
   * rather than something wrong, and the next real turn re-summarizes anyway.
   *
   * Forced, because the thread's activity cursor has not moved and
   * `summarizeThread` would otherwise decide there is nothing new to say.
   */
  const rewriteRefresher = (threadId: string) => {
    forced.add(threadId);
    enqueue(threadId);
  };

  // -------------------------------------------------------- sidebar sections

  const prefsResult = z.object({
    preferences: z.record(z.string(), z.unknown()),
  });
  const prefResult = z.object({ key: z.string(), value: z.unknown() });

  const readThreadListPrefs = async (): Promise<Record<string, unknown>> => {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "listPreferences",
      input: null,
      outputSchema: prefsResult,
    });
    return result.preferences;
  };

  const writeThreadListPref = async (key: string, value: JsonValue) => {
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "setPreference",
      input: { key, value },
      outputSchema: prefResult,
    });
  };

  const resetThreadListPref = async (key: string) => {
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "resetPreference",
      input: { key },
      outputSchema: prefResult,
    });
  };

  const readSidebarState = async (): Promise<SidebarGroupingState> =>
    (await bb.storage.kv.get<SidebarGroupingState>(SIDEBAR_STATE_KEY)) ?? {
      applied: false,
      previous: null,
    };

  /** Our sections in display order, creating, renaming and retiring as needed. */
  const ensureSections = async (): Promise<{ name: string; id: string }[]> => {
    const plan = planSections(await bb.sdk.threadSections.list());
    const sections: { name: string; id: string }[] = [];
    // Created in display order, so creation order — which is the order bb hands
    // sections to a sidebar — already agrees with `manualSectionOrder`.
    for (const step of plan.steps) {
      if (step.id === null) {
        const created = await bb.sdk.threadSections.create({ name: step.name });
        sections.push({ name: step.name, id: created.id });
        continue;
      }
      // Renamed in place, so the section keeps its id and every thread already
      // filed in it stays where it is.
      if (step.renameFrom !== null) {
        await bb.sdk.threadSections.update({ id: step.id, name: step.name });
        bb.log.info(
          `sidebar grouping: renamed "${step.renameFrom}" to "${step.name}"`,
        );
      }
      sections.push({ name: step.name, id: step.id });
    }
    for (const id of plan.retire) {
      await bb.sdk.threadSections.delete({ id });
    }
    return sections;
  };

  /** Visible, live threads, in pages, capped. */
  const listGroupableThreads = async (): Promise<SectionedThread[]> => {
    const threads: SectionedThread[] = [];
    for (let offset = 0; offset < SECTION_THREAD_LIMIT; offset += SECTION_PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        limit: SECTION_PAGE_SIZE,
        offset,
      });
      for (const thread of page) {
        if (thread.visibility === "hidden") continue;
        // Archived threads are out regardless of status: the grouping is for
        // work still in front of you.
        if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
        threads.push({ id: thread.id, sectionId: thread.sectionId ?? null });
      }
      if (page.length < SECTION_PAGE_SIZE) break;
    }
    return threads;
  };

  /** Target section per thread, read from stored briefs only. */
  const sectionIdByThreadId = async (
    sectionIds: ReadonlyMap<string, string>,
  ): Promise<Map<string, string>> => {
    const targets = new Map<string, string>();
    for (const key of await bb.storage.kv.list("brief:")) {
      const threadId = threadIdFromKey(key);
      const stored = await readBrief(threadId);
      if (stored === null) continue;
      const name = sectionNameForStatus(storedStatus(stored));
      if (name === null) continue;
      const sectionId = sectionIds.get(name);
      if (sectionId !== undefined) targets.set(threadId, sectionId);
    }
    return targets;
  };

  /** Hand the sidebar back: delete our sections, restore what we changed. */
  async function teardownGrouping(state: SidebarGroupingState) {
    // Collected before the first delete: never iterate a list while mutating
    // what produced it.
    const ours = (await bb.sdk.threadSections.list())
      .filter((section) => OWNED_SECTION_NAMES.includes(section.name))
      .map((section) => section.id);
    // Deleting a section removes its thread assignments, so the threads fall
    // back into bb's Threads group without a pass over them.
    for (const id of ours) {
      await bb.sdk.threadSections.delete({ id });
    }
    for (const key of RESTORED_PREFS) {
      const previous = state.previous?.[key];
      // Reset rather than guess when we never saw a prior value: thread-list
      // owns its own defaults and they can change without us.
      if (previous === undefined || previous === null) {
        await resetThreadListPref(key);
      } else {
        // Round-tripped through kv JSON, so this really is a JsonValue.
        await writeThreadListPref(key, previous as JsonValue);
      }
    }
    await bb.storage.kv.set(SIDEBAR_STATE_KEY, { applied: false, previous: null });
    bb.log.info("sidebar grouping off: sections removed, preferences restored");
  }

  /**
   * Reconcile every thread's section against its stored brief.
   *
   * Always a full pass rather than a per-thread update: one `threads.list` plus
   * one kv scan costs less than a `threads.get` per changed brief once a batch
   * is more than a handful, it is self-healing after a missed write, and it is
   * the same code path on startup as on a brief write. The debounce is what
   * turns a burst of brief writes into one pass, so the preference writes below
   * happen once per batch rather than once per thread.
   */
  async function reconcileSections() {
    const state = await readSidebarState();
    if ((await settings.get()).sidebarGrouping !== "status") {
      if (state.applied) await teardownGrouping(state);
      return;
    }

    const sections = await ensureSections();
    const sectionIds = new Map(sections.map(({ name, id }) => [name, id]));
    const prefs = await readThreadListPrefs();
    // null when the stored order already holds our sections in some order of
    // its own: a hand-drag in the sidebar outranks our top-to-bottom default.
    const order = mergeSectionOrder(
      prefs[ORDER_PREF],
      sections.map(({ id }) => id),
    );
    const desired: Record<string, JsonValue> = {
      ...GROUPED_PREFS,
      ...(order === null ? {} : { [ORDER_PREF]: order }),
    };

    if (!state.applied) {
      await bb.storage.kv.set(SIDEBAR_STATE_KEY, {
        applied: true,
        // The order pref is snapshotted whether or not we are writing it this
        // pass: teardown restores every key we own, and on a first apply that
        // leaves the order alone we still have to remember what it was.
        previous: Object.fromEntries(
          RESTORED_PREFS.map((key) => [key, prefs[key] ?? null]),
        ),
      });
    }
    for (const [key, value] of Object.entries(desired)) {
      // Only write a preference that is actually wrong, so a settled sidebar
      // costs no writes and a user's own sort choice is not re-stomped hourly.
      if (JSON.stringify(prefs[key]) !== JSON.stringify(value)) {
        await writeThreadListPref(key, value);
      }
    }

    const moves = planAssignments({
      threads: await listGroupableThreads(),
      sectionIdByThreadId: await sectionIdByThreadId(sectionIds),
      ownedSectionIds: new Set(sectionIds.values()),
    });
    for (const move of moves) {
      await bb.sdk.threads
        .update({ threadId: move.threadId, sectionId: move.sectionId })
        .catch((error: unknown) => {
          bb.log.warn(
            `could not move ${move.threadId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    if (moves.length > 0) {
      bb.log.info(`sidebar grouping: moved ${moves.length} thread(s)`);
    }
  }

  let sectionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciling = false;
  let reconcileAgain = false;

  async function runReconcile() {
    if (reconciling) {
      // A brief landed mid-pass; its thread would be missed otherwise.
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        await reconcileSections();
      } while (reconcileAgain && !lifetime.signal.aborted);
    } catch (error) {
      bb.log.warn(
        `sidebar grouping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      reconciling = false;
    }
  }

  /** Coalesce a burst of brief writes into one reconcile. */
  const scheduleReconcile = () => {
    if (sectionTimer !== null) clearTimeout(sectionTimer);
    sectionTimer = setTimeout(() => {
      sectionTimer = null;
      void runReconcile();
    }, SECTION_SYNC_DEBOUNCE_MS);
    sectionTimer.unref?.();
  };

  // A grouping that is turned on or off should take effect without a reload;
  // `reconcileSections` reads the setting itself and tears down when it is off.
  settings.onChange((next, prev) => {
    if (next.sidebarGrouping !== prev.sidebarGrouping) void runReconcile();
    // The thresholds reach the sidebar with the row signals, so a changed one
    // has to be pushed for the rings to go grey — or come back — without a
    // reload.
    if (
      next.doneStaleHours !== prev.doneStaleHours ||
      next.doneArchiveHours !== prev.doneArchiveHours
    ) {
      announce();
    }
  });

  // ---------------------------------------------------------------- events

  bb.events.on("thread.idle", ({ thread }) => {
    // A turn boundary has been reached, so whatever we write now is a real
    // brief and may name the thread — including a pre-turn brief still in
    // flight, which `supersede` aborts and this re-queues as a post-turn one.
    preTurn.delete(thread.id);
    supersede(thread.id);
  });

  bb.events.on("thread.active", ({ thread }) => {
    // A summary already running or queued was started by a `thread.idle`. It
    // describes a real turn boundary, so it is left to finish: the turn that
    // just started will supersede it when it ends.
    if (isPending(thread.id)) return;
    if (thread.visibility === "hidden") return;
    void (async () => {
      if (!hasApiKey(await settings.get())) return;
      // A thread that already has a brief is not summarized mid-turn. One with
      // no brief at all is: the opening prompt is enough for a goal, a
      // discovery-stage ring and a sidebar section, and waiting for the turn
      // to end means a long first turn spends its whole length looking like a
      // thread the plugin has never heard of. Every field is corrected by the
      // summary that follows the turn.
      if ((await readBrief(thread.id)) !== null) return;
      preTurn.add(thread.id);
      enqueue(thread.id);
    })();
  });

  // The thread now wants something from the user. No new summary is needed —
  // status is derived — but the sidebar should repaint.
  bb.events.on("interaction.pending", () => {
    announce();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    if (inFlight === thread.id) inFlightRun?.abort();
    preTurn.delete(thread.id);
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
    if (!hasApiKey(values)) return;

    const threads = await bb.sdk.threads.list({ limit: SWEEP_LIMIT });

    for (const thread of threads) {
      if (thread.visibility === "hidden") continue;
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.status === "active" || thread.status === "starting") continue;
      if (isPending(thread.id)) continue;

      const stored = await readBrief(thread.id);
      if (stored === null) {
        // Briefs are never backfilled. A thread gets its first brief from
        // activity — `thread.idle` while we are running — so the sweep only
        // considers a briefless thread whose activity postdates this load,
        // which is activity whose event we should have seen and may have
        // missed. Anything older stays briefless until it is next worked on.
        //
        // Without this bound every briefless thread would be re-enqueued on
        // every sweep forever: an unbounded burst across the whole thread list
        // the first time a key is configured, and an endless ten-minute retry
        // for any thread whose summary keeps failing.
        if (thread.updatedAt > loadedAt) enqueue(thread.id);
        continue;
      }
      // A stored brief older than the thread's last activity means activity we
      // missed. `summarizeThread` re-checks the real cursor before spending a
      // request.
      if (stored.lastSummarizedAt < thread.updatedAt) enqueue(thread.id);
    }
  });

  // ------------------------------------------------------------ auto-archive

  /**
   * Archive the threads that finished and were never come back to.
   *
   * The end of the same arc the grey ring draws: `planArchives` and the ring
   * both go through `isStaleDone`, so a row that has gone grey is exactly a row
   * this will take, one threshold later. That is the whole user-facing promise
   * — the colour draining out of a ring is the warning — and it only holds
   * because there is one predicate rather than two agreeing ones.
   *
   * Independent of the summarizer: no API key check, because archiving reads
   * briefs that already exist and writes no new ones.
   */
  bb.background.schedule("archive-done", ARCHIVE_CRON, async () => {
    const values = await settings.get();
    const archiveAfterMs = hoursToMs(values.doneArchiveHours);
    if (archiveAfterMs <= 0) return;

    const threads = await bb.sdk.threads.list({ limit: ARCHIVE_LIMIT });
    const candidates: ArchiveCandidate[] = threads.map((thread) => ({
      id: thread.id,
      latestAttentionAt: thread.latestAttentionAt,
      pinnedAt: thread.pinnedAt,
      archivedAt: thread.archivedAt,
      deletedAt: thread.deletedAt,
      visibility: thread.visibility,
      status: thread.status,
    }));

    // Briefs read per candidate rather than by scanning the kv prefix: the
    // list is already bounded and this is one pass an hour, where the section
    // reconcile's scan runs on every brief write.
    const briefs = new Map<string, ArchiveBriefFacts>();
    for (const candidate of candidates) {
      const stored = await readBrief(candidate.id);
      if (stored === null) continue;
      briefs.set(candidate.id, {
        status: effectiveStatus(stored),
        autoArchivedAt: stored.autoArchivedAt ?? null,
      });
    }

    const ids = planArchives({
      threads: candidates,
      briefs,
      now: Date.now(),
      archiveAfterMs,
    });
    if (ids.length === 0) return;

    let archived = 0;
    for (const threadId of ids) {
      try {
        await bb.sdk.threads.archive({ threadId });
      } catch (error) {
        // One thread that will not archive is not worth abandoning the rest of
        // the sweep over, and the next pass retries it anyway.
        bb.log.warn(
          `could not archive ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      archived += 1;
      // Stamped only after the archive actually landed, so a failed call
      // leaves the thread eligible rather than silently exempt for good. Read
      // again rather than reusing the row above: a summary may have landed
      // during the sweep, and that brief's `autoArchivedAt` of absent is the
      // one this must not resurrect.
      const stored = await readBrief(threadId);
      if (stored !== null) {
        await writeBrief({ ...stored, autoArchivedAt: Date.now() });
      }
    }
    if (archived > 0) {
      bb.log.info(`auto-archived ${archived} done thread(s)`);
      // The rows are gone from the sidebar; drop their glyphs with them.
      announce();
    }
  });

  // Reconcile once on startup: briefs may have changed while this plugin was
  // not running, and a section a thread was moved out of by hand is put back.
  void runReconcile();

  bb.onDispose(() => {
    lifetime.abort();
    if (sectionTimer !== null) clearTimeout(sectionTimer);
    queue.length = 0;
    forced.clear();
    preTurn.clear();
  });
}

export type { BriefStage };
