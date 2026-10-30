import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useBbNavigate, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { threadEffortAssignmentScope, threadEffortMoveScope, type ThreadEffortContext, type ThreadEffortPicker, type ThreadEffortReady } from "./thread-effort";
import { pickedText, pickerItems, pickerStep, startHighlight, type JevAnswer, type PickerItem, type PickerMode } from "./thread-effort-picker";
import { PickerBody, ThreadEffortBar } from "./thread-effort-popover";
import { pickerActionForKey } from "./deck-keys";
import { DECK_CHANGED, SEND_DELAY_MS } from "./deck-shared";
import { readSeen, SEEN_KEY } from "./deck-place";
import { createThreadEffortRefresh } from "./thread-effort-refresh";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The composer surface owns the thread id; remount to discard old thread requests. */
export function ThreadEffortControl() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <ThreadEffortForThread key={view.scope.threadId} threadId={view.scope.threadId} />;
}

/** When the deck last marked each PR's row seen, so the chip counts Needs you as the deck's strip does. */
function seenAt(): Record<string, number> {
  try { return readSeen(window.localStorage.getItem(SEEN_KEY), Date.now()).at; } catch { return {}; }
}
const NO_JEV: JevAnswer = { state: "idle", keys: [], name: null };

/**
 * The effort chip and its popover for one thread. A board or deck change reads the chip again, but never changes the popover's list
 * under your highlight: it lists what opening read, and a refusal reads it again. A pick applies at once and leaves an Undo beside the
 * chip for the deck's Undo window.
 */
function ThreadEffortForThread({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [context, setContext] = useState<ThreadEffortReady | null>(null);
  const [snapshot, setSnapshot] = useState<ThreadEffortReady | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PickerMode>("effort");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jev, setJev] = useState<JevAnswer>(NO_JEV);
  const [jevNotice, setJevNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; undoId: string | null } | null>(null);
  const [confirming, setConfirming] = useState<ThreadEffortPicker["linked"][number] | null>(null);
  const flashTimer = useRef<number | null>(null);
  const refresh = useRef<ReturnType<typeof createThreadEffortRefresh<ThreadEffortContext>> | null>(null);
  const saving = useRef(false);
  const createRequest = useRef<{ name: string; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  /** Realtime changes coalesce; a completed read still paints even when another refresh is queued. */
  const refetch = useCallback((list = false) => refresh.current?.request(list), []);
  useEffect(() => {
    const reader = createThreadEffortRefresh({
      read: () => rpc.call("thread_effort_context", { threadId, seen: seenAt() }),
      apply: (result, list) => {
        if (result.ok) { setContext(result); setReadError(null); if (list) setSnapshot(result); }
        else setReadError(result.error);
      },
      failed: (cause) => setReadError(errorMessage(cause)),
    });
    refresh.current = reader;
    reader.request();
    return () => {
      reader.dispose();
      if (refresh.current === reader) refresh.current = null;
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    };
  }, [rpc, threadId]);
  useRealtime("board-changed", () => refetch());
  useRealtime(DECK_CHANGED, () => refetch());

  const say = (text: string, undoId: string | null = null) => {
    setFlash({ text, undoId });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    // The Undo shows for the deck's Undo window; the line goes with it.
    flashTimer.current = window.setTimeout(() => setFlash(null), undoId ? SEND_DELAY_MS : 5_000);
  };
  const reset = () => { setMode("effort"); setQuery(""); setHighlight(-1); setError(null); setConfirming(null); };
  const openChange = (next: boolean) => {
    if (saving.current && next) return;
    if (next) { reset(); setJev(NO_JEV); setJevNotice(null); setSnapshot(context); refetch(true); }
    setOpen(next);
  };

  const chip = context?.picker?.chip ?? null;
  const listed = snapshot ?? context;
  const picker: ThreadEffortPicker | null = listed?.picker ?? null;
  const currentKey = listed?.threadEffort?.key ?? null;
  const current = picker?.choices.find((choice) => choice.key === currentKey) ?? null;
  const items: PickerItem[] = listed && picker ? pickerItems({ picker, currentKey, query, mode, linkable: listed.linkablePrs, linkedUrl: listed.linkedPrUrl, jev }) : [];

  /** Close on a pick, show Saving beside the chip, then use the authoritative response. A refusal reopens the picker. */
  const apply = async (call: () => Promise<ThreadEffortContext>, text: string) => {
    if (saving.current) return;
    saving.current = true;
    refresh.current?.hold();
    setBusy(true);
    setOpen(false);
    setError(null);
    let result: ThreadEffortContext;
    try { result = await call(); } catch (cause) { result = { ok: false, error: errorMessage(cause) }; }
    if (!result.ok) {
      setError(result.error);
      setOpen(true);
      refetch(true);
    } else {
      setContext(result);
      setSnapshot(result);
      setReadError(null);
      reset();
      say(text, result.undoId ?? null);
      // Older servers may omit the picker; current saves return the updated chip themselves.
      if (!result.picker) refetch();
    }
    saving.current = false;
    setBusy(false);
    refresh.current?.resume();
  };

  const pick = async (item: PickerItem | undefined) => {
    const context = listed;
    if (!item || !context || busy) return;
    switch (item.kind) {
      case "effort":
        if (item.current) { setOpen(false); return; }
        return apply(() => rpc.call("thread_effort_set", { threadId, destinationKey: item.key,
          expectedScope: threadEffortAssignmentScope(context, item.key) }), pickedText({ kind: "set", name: item.name }));
      case "remove":
        return apply(() => rpc.call("thread_effort_set", { threadId, destinationKey: null, expectedScope: threadEffortAssignmentScope(context, null) }),
          pickedText({ kind: "remove", name: item.name }));
      case "new": {
        if (!item.name) { setError("Type the new effort's name first."); inputRef.current?.focus(); return; }
        // A retry of the same name reuses its request, so a lost reply can't create it twice.
        if (createRequest.current?.name !== item.name) createRequest.current = { name: item.name, id: crypto.randomUUID() };
        const request = createRequest.current.id;
        return apply(() => rpc.call("thread_effort_create", { threadId, name: item.name, requestId: request,
          expectedScope: threadEffortAssignmentScope(context, null) }), pickedText({ kind: "create", name: item.name }));
      }
      case "jev": {
        if (item.busy) return;
        setJev({ ...NO_JEV, state: "asking" });
        try {
          const result = await rpc.call("thread_effort_suggest", { threadId });
          if (!result.ok) { setJev(NO_JEV); setJevNotice(result.error); return; }
          setJev({ state: "done", keys: result.suggestions.map((suggestion) => suggestion.key), name: result.suggestedName });
          setJevNotice(result.notice);
        } catch (cause) { setJev(NO_JEV); setJevNotice(errorMessage(cause)); }
        setHighlight(-1);
        return;
      }
      case "pr":
        if (item.current) { setMode("effort"); setQuery(""); setHighlight(-1); return; }
        return apply(() => rpc.call("thread_effort_link_pr", { threadId, prUrl: item.url }), pickedText({ kind: "link", ref: item.label.split(" · ")[0]!.split("/").at(-1)! }));
    }
  };

  /** A move that takes more than its PR lists what else it takes and waits for Move all. */
  const move = (pr: ThreadEffortPicker["linked"][number], confirmed = false) => {
    if (!listed || !current || busy) return;
    if (pr.also.length && !confirmed) { setConfirming(pr); setError(null); return; }
    setConfirming(null);
    const expectedScope = threadEffortMoveScope(listed, pr.sourceIds, current.key);
    if (!expectedScope) { setError("That work changed. Pick again."); refetch(true); return; }
    void apply(() => rpc.call("thread_effort_move", { threadId, sourceIds: pr.sourceIds, destinationKey: current.key, expectedScope }),
      pickedText({ kind: "move", ref: pr.ref, name: current.name }));
  };

  const undo = async () => {
    const undoId = flash?.undoId;
    if (!undoId || saving.current) return;
    setFlash(null);
    await apply(() => rpc.call("thread_effort_undo", { threadId, undoId }), "Undone.");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ↵ that ends an input method's composition only commits the text.
    const action = event.nativeEvent.isComposing ? null : pickerActionForKey(event);
    // esc is the popover's own: it backs out of the PR list, then closes (see onEscape).
    if (!action || action === "pick-back") return;
    event.preventDefault();
    const step = pickerStep(action, { highlight, count: items.length, mode });
    if (step && "highlight" in step) {
      setHighlight(step.highlight);
      document.getElementById(`${listId}-${step.highlight}`)?.scrollIntoView({ block: "nearest" });
    } else if (step && "pick" in step) void pick(items[step.pick]);
  };
  const onEscape = () => {
    if (confirming) { setConfirming(null); return true; }
    const step = pickerStep("pick-back", { highlight, count: items.length, mode });
    if (step && "mode" in step) { setMode("effort"); setQuery(""); setHighlight(-1); setError(null); return true; }
    return false;
  };
  const onCard = () => {
    const card = chip?.card ?? null;
    if (card === null) openChange(true);
    else navigate.toPluginPanel("board", { subPath: `deck/${encodeURIComponent(card)}` });
  };

  return <ThreadEffortBar chip={chip} busy={busy} readError={readError} onRetry={() => refetch()} open={open} onOpenChange={openChange} onCard={onCard}
    onEscape={onEscape} inputRef={inputRef} flash={flash && { text: flash.text, undo: flash.undoId !== null }} onUndo={() => void undo()}>
    {listed && picker ? <PickerBody mode={mode} query={query} items={items} highlight={highlight} busy={busy} linked={picker.linked}
      current={current && { id: current.id, name: current.name }} notice={jevNotice ?? listed.inheritanceNotice} error={error} listId={listId} inputRef={inputRef}
      onQuery={(value) => { setQuery(value); setHighlight(startHighlight(value)); setError(null); }} onKeyDown={onKeyDown}
      onPick={(index) => void pick(items[index])} onHighlight={setHighlight}
      onLinkMode={() => { setMode("link"); setQuery(""); setHighlight(-1); setError(null); setConfirming(null); inputRef.current?.focus(); }}
      confirm={confirming} onMove={(pr) => move(pr)} onConfirmMove={() => { if (confirming) move(confirming, true); }} onCancelMove={() => setConfirming(null)}
      onOpenPr={(pr) => { navigate.openUrl(pr.url); }} /> : null}
  </ThreadEffortBar>;
}
