import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
// Types only: `contract.ts` reaches the SDK root, which the app build cannot
// resolve, so this import must erase. Runtime values come from `shared.ts`.
import type {
  BriefState,
  RefresherState,
  ResolvedBrief,
  RowSignal,
  rpcContract,
} from "./contract.js";
import {
  BRIEFS_CHANGED_CHANNEL,
  BRIEF_STAGES,
  PROJECT_RING_HUES,
  STALE_DONE_RING_COLOR,
  STORED_BRIEF_STATUSES,
  idleMsSince,
  isLiveWorking,
  isStaleDone,
  projectRingColor,
  type BriefStage,
  type StoredBriefStatus,
} from "./shared.js";
import {
  doneRingIcon,
  DONE_RING_ICON,
  rowDecoration,
  STALE_DONE_RING_ICON,
  stageRingIcon,
  STATUS_LABELS,
  summarizedAgo,
} from "./brief.js";
import { Field, StageControl, StatusControl } from "./controls.js";
import { useNow } from "./clock.js";
import { BoardPage, BOARD_PANEL_ID, BOARD_PATH } from "./board-page.js";

type Decoration = {
  icon: string;
  label: string;
  tone: "default" | "error" | "running" | "success";
};

/** The `threadPanelAction` the header button opens. */
const PANEL_ACTION_ID = "brief";

/**
 * The tab's label. Shorter than the action's own title because a tab strip is
 * narrow and the launcher row, which is a list, has room for the longer name.
 */
const PANEL_TAB_TITLE = "Brief";

/**
 * How often the rows are re-tested for staleness. See the `now` state in
 * {@link BriefSync} for why a timer is needed at all.
 */
const STALE_TICK_MS = 60_000;

/**
 * Row glyphs need two things bb keeps in different places: the briefs (server,
 * over rpc and realtime) and the live sidebar rows (React hooks). Only a React
 * component can read the second, and only a content script can *set* a row
 * status — so a no-op overlay component computes the decorations and this
 * module-level store hands them to the content script.
 */
const store = {
  decorations: new Map<string, Decoration>(),
  /**
   * How many threads are waiting on you right now, for the board's sidebar
   * accessory.
   *
   * Published from here rather than fetched again because the count needs
   * exactly what {@link BriefSync} has already assembled — the briefs off the
   * wire and the live `working` fold — and the accessory is mounted in every
   * sidebar, in every window. A second `listRowSignals` per window on every
   * `briefs-changed` to draw one number would be the most expensive badge in
   * bb. Before the first load it is null, which renders nothing; so does zero,
   * so there is no state where the reading is wrong, only one where it is late.
   */
  waitingOnMe: null as number | null,
  listeners: new Set<() => void>(),
};

function publish(next: {
  decorations: Map<string, Decoration>;
  waitingOnMe: number;
}) {
  store.decorations = next.decorations;
  store.waitingOnMe = next.waitingOnMe;
  for (const listener of store.listeners) listener();
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function sameDecoration(a: Decoration | undefined, b: Decoration | undefined) {
  if (a === undefined || b === undefined) return a === b;
  return a.icon === b.icon && a.label === b.label && a.tone === b.tone;
}

/**
 * Mounted once per app window, renders nothing. Keeps the decoration store in
 * step with the server's briefs and the sidebar's live rows.
 */
function BriefSync() {
  const rpc = useRpc<typeof rpcContract>();
  const { threads, projects } = experimental_useSidebarThreads();
  const [signals, setSignals] = useState<readonly RowSignal[]>([]);
  const [thresholds, setThresholds] = useState({
    staleAfterMs: 0,
    archiveAfterMs: 0,
  });
  // Recomputed on a timer, because staleness is the one thing on this row that
  // changes with nothing behind it: a window left open overnight would keep
  // painting yesterday's project colour on a thread the sweep is about to
  // archive. A minute is far finer than the threshold it is watching, and the
  // decoration diff in the content script absorbs the ticks that change
  // nothing — `idleFor` is coarse precisely so that is almost all of them.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STALE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(() => {
    void rpc
      .call("listRowSignals")
      .then((result) => {
        setSignals(result.signals);
        setThresholds({
          staleAfterMs: result.staleAfterMs,
          archiveAfterMs: result.archiveAfterMs,
        });
      })
      .catch(() => {
        // A failed poll leaves the previous glyphs in place rather than
        // clearing every row on a transient error.
      });
  }, [rpc]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  // The live half of the status: a thread whose agent is running or queued is
  // `working`, which outranks whatever its last brief concluded.
  const workingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      if (isLiveWorking(thread.status)) ids.add(thread.id);
    }
    return ids;
  }, [threads]);

  /** Every thread this window's sidebar is showing, by id. */
  const sidebarIds = useMemo(
    () => new Set(threads.map((thread) => thread.id)),
    [threads],
  );

  /**
   * The project each row belongs to.
   *
   * Unconditional — not held back until two projects are on screen. A ring that
   * only takes its colour some of the time is a ring whose colour you have to
   * think about before you can read it, and the rule deciding it is invisible
   * from the sidebar. One project in the list is also a temporary fact: a
   * filter, an archive sweep or a second project added later would flip every
   * ring's colour without anything about the threads having changed.
   */
  const projectByThreadId = useMemo(() => {
    const names = new Map(
      projects.map((project) => [project.id, project.name] as const),
    );
    const byThread = new Map<string, { id: string; name: string }>();
    for (const thread of threads) {
      // A thread with no project id cannot be coloured and must not take the
      // whole pass down with it: this effect paints every row, so one bad
      // entry would cost every other row its glyph.
      if (typeof thread.projectId !== "string" || thread.projectId === "") {
        continue;
      }
      byThread.set(thread.id, {
        id: thread.projectId,
        // The row still gets its colour from the id when the project is not in
        // the list yet; only the label's suffix waits for the name.
        name: names.get(thread.projectId) ?? "",
      });
    }
    return byThread;
  }, [projects, threads]);

  /**
   * When each row last had activity worth your attention.
   *
   * bb's own cursor, straight off the sidebar row — so the staleness the ring
   * draws costs no round trip, the same trade `workingIds` makes above and the
   * reason `listRowSignals` can stay a flat kv scan.
   */
  const attentionByThreadId = useMemo(() => {
    const byThread = new Map<string, number>();
    for (const thread of threads) {
      if (typeof thread.latestAttentionAt === "number") {
        byThread.set(thread.id, thread.latestAttentionAt);
      }
    }
    return byThread;
  }, [threads]);

  useEffect(() => {
    const next = new Map<string, Decoration>();
    let waitingOnMe = 0;
    for (const signal of signals) {
      // A brief with no row beside it belongs to a thread this window is not
      // showing — archived, most often, since archiving keeps the brief. The
      // board is driven by the sidebar's threads and never draws such a card,
      // so the badge must not count it either: a "2" over a board of nothing
      // but Done is a badge that cannot be trusted.
      const inSidebar = sidebarIds.has(signal.threadId);
      // The same live fold the decoration below makes, counted before it: a
      // thread whose agent is running is `working`, and is not waiting on you.
      if (
        inSidebar &&
        !workingIds.has(signal.threadId) &&
        signal.status === "waiting-on-me"
      ) {
        waitingOnMe += 1;
      }
      // A thread with no row in the sidebar has no cursor to age, so it simply
      // never greys, and has no glyph to draw either.
      const latestAttentionAt = attentionByThreadId.get(signal.threadId);
      const stale =
        latestAttentionAt !== undefined &&
        isStaleDone({
          status: signal.status,
          latestAttentionAt,
          now,
          afterMs: thresholds.staleAfterMs,
        })
          ? {
              idleMs: idleMsSince(latestAttentionAt, now),
              archiving: thresholds.archiveAfterMs > 0,
            }
          : null;
      const decoration = rowDecoration(
        signal,
        workingIds.has(signal.threadId),
        projectByThreadId.get(signal.threadId) ?? null,
        stale,
      );
      if (decoration !== null) next.set(signal.threadId, decoration);
    }
    publish({ decorations: next, waitingOnMe });
  }, [
    attentionByThreadId,
    now,
    projectByThreadId,
    sidebarIds,
    signals,
    thresholds,
    workingIds,
  ]);

  return null;
}

// ------------------------------------------------------------- the stage rings

/**
 * Quarter arcs of a ring in a 16×16 box, clockwise from twelve o'clock, with a
 * gap either side of every boundary.
 *
 * Four separate arcs rather than one dashed circle. The segment ends have to sit
 * exactly on the quarters, because what you actually read at this size is *where
 * the fill stops* — three o'clock, six, nine, closed — and a `stroke-dasharray`
 * on a circle puts the ends wherever the dash phase happens to fall. Butt caps
 * for the same reason: a round cap extends each arc by half the stroke width,
 * which here is wider than the gap and would close it.
 */
const RING_QUARTERS = [
  "M8.94 2.07A6 6 0 0 1 13.93 7.06",
  "M13.93 8.94A6 6 0 0 1 8.94 13.93",
  "M7.06 13.93A6 6 0 0 1 2.07 8.94",
  "M2.07 7.06A6 6 0 0 1 7.06 2.07",
] as const;

/**
 * A ring with `filled` of its four quarters solid and the rest left as a track,
 * optionally with the centre filled in.
 *
 * The track is what makes the glyph a ratio rather than a count: three quarters
 * against a visible whole reads instantly at 16px, where three marks against
 * nothing has to be counted.
 *
 * A `color` of `currentColor` leaves the host's tone class to paint it, which
 * is what the panel and the stage picker want. An explicit colour overrides
 * that class, so the two modes cannot both colour the same ring — which is what
 * lets one glyph carry three facts at 16px: how far round it goes is the stage,
 * whether the centre is filled is `done`, and the hue is the project (or grey,
 * for a done thread nobody has come back to).
 */
function ring(filled: number, complete = false, color = "currentColor") {
  return function StageRing({ className }: { className?: string }) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        {RING_QUARTERS.map((d, index) => (
          <path
            key={d}
            d={d}
            stroke={color}
            strokeWidth={2}
            opacity={index < filled ? 1 : 0.25}
          />
        ))}
        {complete ? <circle cx={8} cy={8} r={2.75} fill={color} /> : null}
      </svg>
    );
  };
}

/**
 * One ring per stage, plus the closed filled ring for `done`.
 *
 * Mapped over `BRIEF_STAGES` in order, so the artwork and the names cannot
 * drift: `stageRingIcon` is the same function the row decoration calls, and a
 * stage added to the list gets its ring here without a second edit.
 */
function ringSet(colorIndex?: number) {
  const color =
    colorIndex === undefined ? "currentColor" : projectRingColor(colorIndex);
  return [
    ...BRIEF_STAGES.map((stage, index) => ({
      name: stageRingIcon(stage, colorIndex),
      component: ring(index + 1, false, color),
    })),
    {
      name: doneRingIcon(colorIndex),
      component: ring(RING_QUARTERS.length, true, color),
    },
  ];
}

/**
 * The neutral set, plus one set per palette slot.
 *
 * Every combination is registered up front because the registry is keyed by
 * name and filled once, at plugin init, where no project list exists yet —
 * projects arrive later, per window, through `experimental_useSidebarThreads`.
 * Hashing a project into a fixed palette instead of registering an icon per
 * project is what makes that work: the set of names is knowable without knowing
 * the projects, and a project added later already has its artwork waiting.
 */
const RING_ICONS = [
  ...ringSet(),
  ...PROJECT_RING_HUES.flatMap((_hue, colorIndex) => ringSet(colorIndex)),
  // One, not a set: the grey replaces a project's hue rather than varying with
  // it. See {@link STALE_DONE_RING_ICON}.
  {
    name: STALE_DONE_RING_ICON,
    component: ring(RING_QUARTERS.length, true, STALE_DONE_RING_COLOR),
  },
];

// ------------------------------------------------------------------ the panel

function BriefBody({
  now,
  state,
  onPick,
  onPickStatus,
  onRefresh,
}: {
  now: number;
  state: BriefState | null;
  onPick: (stage: BriefStage | null) => void;
  onPickStatus: (status: StoredBriefStatus | null) => void;
  onRefresh: () => void;
}) {
  if (state === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.state === "summarizing") {
    return <div className="text-sm text-muted-foreground">Summarizing…</div>;
  }
  if (state.state === "absent") {
    // Threads that were already dormant when the plugin arrived are not
    // backfilled, so say so and offer to make one rather than spinning.
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          No brief for this thread yet.
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-card"
        >
          Summarize now
        </button>
      </div>
    );
  }
  if (state.state === "unconfigured" || state.state === "error") {
    return <div className="text-sm text-muted-foreground">{state.message}</div>;
  }

  const { brief } = state;
  const allEmpty =
    [brief.goal, brief.currentState, brief.nextStep, brief.blockedOn, brief.constraints]
      .every((value) => value.trim() === "");

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            {/*
              The glyph this thread's sidebar row draws, beside the words it
              stands for. A done thread is the case that needs it: its row shows
              a closed ring and no stage, so the stage control below cannot
              explain it.
            */}
            <Icon
              name={
                brief.status === "done"
                  ? DONE_RING_ICON
                  : stageRingIcon(brief.stage)
              }
              className={`h-3.5 w-3.5 shrink-0 ${
                brief.status === "done"
                  ? "text-success-foreground"
                  : "text-muted-foreground"
              }`}
              aria-hidden
            />
            {STATUS_LABELS[brief.status]}
          </div>
          {/*
            A panel stays open across turns, so unlike the popover it can be
            read long after the brief it shows was written. Saying when says
            whether the prose below describes the turn you just watched.
          */}
          <div className="text-[11px] text-muted-foreground">
            Summarized {summarizedAgo(brief.lastSummarizedAt, now)}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Re-summarize
        </button>
      </div>

      {allEmpty ? (
        <div className="text-sm text-muted-foreground">
          Nothing recorded for this thread yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          <Field label="Goal" value={brief.goal} />
          <Field label="Current state" value={brief.currentState} />
          <Field label="Next step" value={brief.nextStep} />
          <Field label="Blocked on" value={brief.blockedOn} />
          <Field label="Constraints" value={brief.constraints} />
          {/*
            Why the status above may not follow from the prose here: either the
            brief recorded nothing outstanding, or you overrode it — worth
            saying, because a "Done" heading over a live next step otherwise
            reads as a bug.
          */}
          {brief.statusOverride !== null ? (
            <div className="text-sm text-muted-foreground">
              Status set by hand to {STATUS_LABELS[brief.statusOverride]} —
              whatever this brief says is outstanding.
            </div>
          ) : brief.nextStep.trim() === "" ? (
            <div className="text-sm text-muted-foreground">
              No next step — this thread reads as done.
            </div>
          ) : null}
        </div>
      )}

      <StatusControl
        status={brief.status}
        statusOverride={brief.statusOverride}
        onPick={onPickStatus}
      />
      <StageControl
        stage={brief.stage}
        stageOverride={brief.stageOverride}
        onPick={onPick}
      />
    </div>
  );
}

/**
 * The brief for one thread plus the three writes the panel offers.
 *
 * The panel mounts only while its tab is active in a visible pane, so it
 * re-reads on every mount rather than trusting state from the last time it was
 * on screen, and subscribes unconditionally while it is.
 */
function useBrief(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BriefState | null>(null);

  const load = useCallback(() => {
    void rpc
      .call("getBrief", { threadId })
      .then(setState)
      .catch((error: unknown) =>
        setState({
          state: "error",
          message: error instanceof Error ? error.message : "Could not load the brief.",
        }),
      );
  }, [rpc, threadId]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  const setStage = useCallback(
    (stage: BriefStage | null) => {
      void rpc
        .call("setStageOverride", { threadId, stage })
        .then(setState)
        .catch(() => load());
    },
    [rpc, threadId, load],
  );

  const setStatus = useCallback(
    (status: StoredBriefStatus | null) => {
      void rpc
        .call("setStatusOverride", { threadId, status })
        .then(setState)
        .catch(() => load());
    },
    [rpc, threadId, load],
  );

  const refresh = useCallback(() => {
    void rpc.call("refresh", { threadId }).then(() => {
      setState({ state: "summarizing" });
    });
  }, [rpc, threadId]);

  return { state, setStage, setStatus, refresh };
}

/**
 * The whole brief, in a tab of the thread's side panel.
 *
 * A panel rather than a popover because reading the brief is a deliberate shift
 * out of chatting and into orienting: it wants to stay open while the transcript
 * is scrolled beside it, which a popover — dismissed by the first click outside
 * it — cannot do. The host owns the padding, the scrolling and the width, so
 * none of that is this component's problem.
 */
function BriefPanel({ threadId }: { threadId: string }) {
  const { state, setStage, setStatus, refresh } = useBrief(threadId);
  const now = useNow(30_000);
  return (
    <BriefBody
      now={now}
      state={state}
      onPick={setStage}
      onPickStatus={setStatus}
      onRefresh={refresh}
    />
  );
}

/**
 * The header button. Opens the panel tab; holds no brief state of its own.
 *
 * It exists because panel tabs are per-thread and per-device: a Brief tab opened
 * on one thread is not open on the next one, so without a fixed control in the
 * header, seeing a brief would mean walking the panel's new-tab launcher on
 * every thread — friction landing on exactly the moment this plugin is for.
 */
function BriefHeaderAction({
  isCompactViewport,
}: {
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  const onClick = useCallback(() => {
    // Declines only where the surface has no side panel, and bb renders thread
    // header actions in the main thread view alone — which always has one. On a
    // compact viewport the host reveals the drawer as part of the open.
    navigate.openThreadPanel({
      actionId: PANEL_ACTION_ID,
      title: PANEL_TAB_TITLE,
    });
  }, [navigate]);

  return (
    <button
      type="button"
      aria-label="Thread brief"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <Icon name="ListTodo" className="h-3.5 w-3.5" />
      {isCompactViewport ? null : <span>Brief</span>}
    </button>
  );
}

// ------------------------------------------------------ the sidebar accessory

/**
 * How many threads are waiting on you, at the trailing edge of the board's own
 * sidebar row.
 *
 * The reason to open the board, on the thing you click to open it. It costs no
 * request: {@link BriefSync} has already folded the briefs against the live
 * thread list to draw the row glyphs, so the count is read out of the same store
 * the content script reads. `useSyncExternalStore` rather than an effect because
 * the store is written outside React and this must not lag a frame behind the
 * glyphs beside it.
 *
 * Nothing is drawn at zero. An accessory is clipped to about 4rem by 1.25rem and
 * shares the row's trailing column with the host's own options button, so the
 * only badge worth that space is one that means "there is something here".
 */
function WaitingBadge() {
  const waitingOnMe = useSyncExternalStore(
    subscribe,
    () => store.waitingOnMe,
    () => null,
  );
  if (waitingOnMe === null || waitingOnMe === 0) return null;
  const label = `${waitingOnMe} thread${waitingOnMe === 1 ? "" : "s"} waiting on you`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="rounded-full bg-amber-500/15 px-1.5 font-mono text-[10.5px] leading-4 tabular-nums text-amber-700 dark:text-amber-300"
    >
      {waitingOnMe}
    </span>
  );
}

// -------------------------------------------------------- the re-entry card

/** The composer customization the banner is registered under. */
const COMPOSER_CUSTOMIZATION_ID = "refresher";
const REFRESHER_BANNER_ID = "re-entry";

/**
 * Two sentences above the composer, on a thread you have been away from.
 *
 * **Why a composer banner.** bb renders this in the prompt stack, beside its
 * own Goal, Todo and context cards — the strip directly above the input, which
 * is where your eyes already are when you sit down to type. The host owns the
 * position, so the card structurally cannot cover the composer, cannot take a
 * keystroke meant for it, and follows the composer to the bottom of a phone
 * screen for free. A card we positioned ourselves — fixed, measured off bb's
 * composer element — would float over the transcript as literally asked, at the
 * price of a private DOM attribute to measure and a list of viewports where it
 * covers something. The requirement that settles it is "if it can't render
 * without getting in the way, better to not render": a surface that cannot get
 * in the way beats one that has to keep checking whether it has.
 *
 * **Why it asks once.** The state is fetched when this mounts — bb keys the
 * banner on the composer scope, so opening a thread mounts a fresh one — and
 * never re-fetched. It deliberately does not subscribe to `briefs-changed`: a
 * refresher is for the moment you arrive, and one that faded in while you were
 * already reading the transcript would be an interruption. The decision is
 * made on arrival or not at all.
 */
function ReentryRefresher() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;

  const [state, setState] = useState<RefresherState | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    void rpc
      .call("getRefresher", { threadId })
      .then((result) => {
        // A late reply for a thread we have navigated away from would paint a
        // sentence about the wrong thread; bb remounts per scope, so the guard
        // only has to cover this component's own lifetime.
        if (live) setState(result.refresher);
      })
      .catch(() => {
        // Nothing to show and nothing to say. The refresher is an extra, and a
        // server hiccup should cost the composer nothing at all.
      });
    return () => {
      live = false;
    };
  }, [rpc, threadId]);

  const dismiss = useCallback(() => {
    if (state === null) return;
    setIsDismissed(true);
    void rpc
      .call("dismissRefresher", {
        threadId: state.threadId,
        // The cursor this card was shown for, not whatever the thread reads by
        // now: a turn that landed while the card was on screen is new activity
        // the user has not seen, and must not be dismissed along with it.
        attentionAt: state.attentionAt,
      })
      .catch(() => {
        // The card is gone either way. A failed write means it may reappear on
        // the next open, which is a far better failure than a card that will
        // not go away.
      });
  }, [rpc, state]);

  // Sending is the strongest possible signal that you are reoriented, so the
  // card goes before the message does. Subscribed through a ref because the
  // composer handle is rebuilt as the draft changes, and re-subscribing on
  // every keystroke would be the one thing this card must never cost.
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);
  useEffect(
    () => composer.onSubmitted(() => dismissRef.current()),
    [composer],
  );

  if (state === null || isDismissed) return null;
  // A turn that starts while the card is up — a queued message, a background
  // agent — makes the sentence describe a position that is already moving.
  // Hidden rather than dismissed: nothing was read, so nothing is recorded, and
  // the card is still owed when the thread goes quiet again.
  if (composer.isRunning) return null;

  return (
    // The card chrome is drawn here rather than taken from the host's
    // `chrome: "card"`, which cannot work for a banner that usually renders
    // nothing: bb wraps every plugin surface in a `data-bb-plugin-root`
    // element, so the host card is never `:empty`, its `empty:hidden` never
    // fires, and every thread in bb would carry an empty bordered box above its
    // composer. `chrome: "bare"` puts this component straight into the prompt
    // stack's grid through a `display: contents` wrapper, so rendering null
    // really does render nothing — no box, and no gap between the rows either
    // side of it. What is below is bb's own prompt-stack card, matched.
    <section
      aria-label="Where you left off"
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2"
    >
      <Icon
        name="ListTodo"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
        {state.text}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss the thread refresher"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground"
      >
        <Icon name="X" className="h-3.5 w-3.5" aria-hidden />
      </button>
    </section>
  );
}

// ------------------------------------------------------------- registration

export default definePluginApp((app) => {
  // Optional chaining because a client predating the app icon registry would
  // otherwise throw here and take the panel and the header button down with it.
  // Unregistered names fall back to bb's Zap glyph, so the row degrades alone.
  for (const icon of RING_ICONS) app.experimental_icons?.register(icon);

  app.slots.experimental_appOverlay({ id: "brief-sync", component: BriefSync });

  // The board. A nav panel rather than anything sidebar-shaped: bb gives it the
  // whole main area, a route of its own, and a host-owned sidebar item beside
  // Plugins and Skills that the user can reorder, hide or bind a shortcut to,
  // none of which is this plugin's code. See {@link BoardPage}.
  app.slots.navPanel({
    id: BOARD_PANEL_ID,
    title: "Briefs",
    // Two columns rather than the plugin's own ListTodo: the sidebar item has to
    // say "board", and the branding icon is already what the thread-header
    // button and the refresher card wear.
    icon: "Columns3",
    path: BOARD_PATH,
    component: BoardPage,
    experimental_sidebarAccessory: WaitingBadge,
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Thread brief",
    component: BriefPanel,
    // Both entry points — this launcher row and the header button — label the
    // tab the same short way.
    run: ({ openPanel }) => {
      openPanel({ title: PANEL_TAB_TITLE });
    },
  });

  app.slots.experimental_threadHeaderAction({
    id: "brief",
    title: "Thread brief",
    component: BriefHeaderAction,
  });

  app.composer.customize({
    id: COMPOSER_CUSTOMIZATION_ID,
    // Threads only. There is nothing to be reoriented about in a new-thread
    // composer, and a queued-message editor or a side chat is a place you are
    // already typing rather than a place you have just arrived at.
    scopes: ["thread"],
    banners: [
      {
        id: REFRESHER_BANNER_ID,
        // Bare, not the host card. The host card's `empty:hidden` cannot fire
        // for a plugin banner — bb wraps every surface in a
        // `data-bb-plugin-root` element, so the card is never `:empty` — and
        // this banner renders nothing on the overwhelming majority of threads.
        // Taking the host chrome would put an empty bordered box above every
        // composer in bb. See {@link ReentryRefresher}.
        chrome: "bare",
        component: ReentryRefresher,
      },
    ],
  });

  app.contentScripts.register({
    id: "row-glyphs",
    mount({ signal, experimental_setThreadRowStatus: setRowStatus }) {
      // Older 0.x clients do not ship the setter; the header button still works.
      if (setRowStatus === undefined) return;

      let applied = new Map<string, Decoration>();

      const apply = () => {
        const next = store.decorations;
        for (const [threadId, decoration] of next) {
          if (!sameDecoration(applied.get(threadId), decoration)) {
            setRowStatus(threadId, {
              icon: decoration.icon,
              label: decoration.label,
              tone: decoration.tone,
            });
          }
        }
        for (const threadId of applied.keys()) {
          if (!next.has(threadId)) setRowStatus(threadId, null);
        }
        applied = new Map(next);
      };

      const unsubscribe = subscribe(apply);
      apply();

      signal.addEventListener("abort", unsubscribe, { once: true });
      return () => {
        unsubscribe();
        // The host clears statuses when the generation deactivates, but a
        // plain disable/reload should not leave glyphs behind either.
        for (const threadId of applied.keys()) setRowStatus(threadId, null);
        applied = new Map();
      };
    },
  });
});
