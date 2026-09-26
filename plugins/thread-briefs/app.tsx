import { useCallback, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  BRIEFS_CHANGED_CHANNEL,
  type BriefState,
  type BriefStage,
  type ResolvedBrief,
  type RowSignal,
  type rpcContract,
} from "./contract.js";
import { BRIEF_STAGES } from "./contract.js";
import { rowDecoration, STAGE_LABELS, STATUS_LABELS } from "./brief.js";

type Decoration = {
  icon: string;
  label: string;
  tone: "default" | "error" | "running" | "success";
};

/**
 * Row glyphs need two things bb keeps in different places: the briefs (server,
 * over rpc and realtime) and the live sidebar rows (React hooks). Only a React
 * component can read the second, and only a content script can *set* a row
 * status — so a no-op overlay component computes the decorations and this
 * module-level store hands them to the content script.
 */
const store = {
  decorations: new Map<string, Decoration>(),
  listeners: new Set<() => void>(),
};

function publishDecorations(next: Map<string, Decoration>) {
  store.decorations = next;
  for (const listener of store.listeners) listener();
}

function subscribeDecorations(listener: () => void): () => void {
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
  const { threads } = experimental_useSidebarThreads();
  const [signals, setSignals] = useState<readonly RowSignal[]>([]);

  const load = useCallback(() => {
    void rpc
      .call("listRowSignals")
      .then((result) => setSignals(result.signals))
      .catch(() => {
        // A failed poll leaves the previous glyphs in place rather than
        // clearing every row on a transient error.
      });
  }, [rpc]);

  useEffect(load, [load]);
  useRealtime(BRIEFS_CHANGED_CHANNEL, load);

  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      if (thread.hasPendingInteraction) ids.add(thread.id);
    }
    return ids;
  }, [threads]);

  useEffect(() => {
    const next = new Map<string, Decoration>();
    for (const signal of signals) {
      const decoration = rowDecoration(signal, pendingIds.has(signal.threadId));
      if (decoration !== null) next.set(signal.threadId, decoration);
    }
    publishDecorations(next);
  }, [signals, pendingIds]);

  return null;
}

// ---------------------------------------------------------------- the popover

function Field({ label, value }: { label: string; value: string }) {
  if (value.trim() === "") return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm leading-snug text-foreground">{value}</div>
    </div>
  );
}

function StageControl({
  brief,
  onPick,
}: {
  brief: ResolvedBrief;
  onPick: (stage: BriefStage | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Stage
      </div>
      <div className="flex flex-wrap gap-1">
        {BRIEF_STAGES.map((stage) => {
          const isActive = brief.stage === stage;
          const isManual = brief.stageOverride === stage;
          return (
            <button
              key={stage}
              type="button"
              aria-pressed={isActive}
              // Picking the stage that is already manually set clears the
              // override and hands the judgement back to the summarizer.
              onClick={() => onPick(isManual ? null : stage)}
              className={`rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {STAGE_LABELS[stage]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {brief.stageOverride !== null ? (
        <div className="text-[11px] text-muted-foreground">
          Set by hand · clears on the next turn
        </div>
      ) : null}
    </div>
  );
}

function BriefBody({
  state,
  onPick,
  onRefresh,
}: {
  state: BriefState | null;
  onPick: (stage: BriefStage | null) => void;
  onRefresh: () => void;
}) {
  if (state === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.state === "summarizing") {
    return <div className="text-sm text-muted-foreground">Summarizing…</div>;
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {STATUS_LABELS[brief.status]}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="text-[11px] text-muted-foreground hover:text-foreground"
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
          {brief.nextStep.trim() === "" ? (
            <div className="text-sm text-muted-foreground">
              No next step — this thread reads as done.
            </div>
          ) : null}
        </div>
      )}

      <StageControl brief={brief} onPick={onPick} />
    </div>
  );
}

function BriefHeaderAction({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
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

  // Only fetch while the popover is open: the header mounts for every visible
  // thread, including both panes of a split.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useRealtime(
    BRIEFS_CHANGED_CHANNEL,
    useCallback(() => {
      if (open) load();
    }, [open, load]),
  );

  const onPick = useCallback(
    (stage: BriefStage | null) => {
      void rpc
        .call("setStageOverride", { threadId, stage })
        .then(setState)
        .catch(() => load());
    },
    [rpc, threadId, load],
  );

  const onRefresh = useCallback(() => {
    void rpc.call("refresh", { threadId }).then(() => {
      setState({ state: "summarizing" });
    });
  }, [rpc, threadId]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Thread brief"
          className="flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Icon name="ListTodo" className="h-3.5 w-3.5" />
          {isCompactViewport ? null : <span>Brief</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card p-3 shadow-md"
        >
          <BriefBody state={state} onPick={onPick} onRefresh={onRefresh} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ------------------------------------------------------------- registration

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "brief-sync", component: BriefSync });

  app.slots.experimental_threadHeaderAction({
    id: "brief",
    title: "Thread brief",
    component: BriefHeaderAction,
  });

  app.contentScripts.register({
    id: "row-glyphs",
    mount({ signal, experimental_setThreadRowStatus: setRowStatus }) {
      // Older 0.x clients do not ship the setter; the header popover still works.
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

      const unsubscribe = subscribeDecorations(apply);
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
