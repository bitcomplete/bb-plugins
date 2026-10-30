// All PRs' effort routing: move selected rows to an effort, One-offs, or a new effort from a small type-to-filter picker, the thread
// effort popover's list and look (thread-effort-picker.ts); or take a row's suggestion, the classifier's pick for a PR no effort owns
// (effort-classify.ts, read through classify_get), or hide it. Each change is one membership action through effort-assignments.ts, as
// the deck's Accept and Move are, applied at once with Undo. Nothing here writes to GitHub; inventory-screen.tsx draws it.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { SuggestionGroup } from "./effort-classify";
import { ACTION, pickerActionForKey } from "./deck-keys";
import type { Undo } from "./deck-flow";
import { BUTTON, Kbd } from "./deck-screen";
import { acceptCalls, INVENTORY_CHANGED, rowSuggestions, type InventoryLine } from "./inventory-view-model";
import { pickerItems, pickerStep, startHighlight, type PickerItem } from "./thread-effort-picker";
import { PickerBody } from "./thread-effort-popover";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";

export type MoveTarget = { kind: "effort"; effortKey: string } | { kind: "one-off" } | { kind: "new"; name: string; requestId: string };
type ClassifyRead = { groups: SuggestionGroup[]; efforts: { id: string; name: string }[]; dismissed: Record<string, string> };
type Result = { ok: true; actionId: string; effort: { name: string }; added: number } | { ok: false; error: string };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const plural = (n: number) => `${n} PR${n === 1 ? "" : "s"}`;

/**
 * classify_get, read again on each inventory change, and what changes membership from All PRs. `say` and `setUndo` are the view's hint
 * bar and z: each change says what moved, with Undo, and a failed read only leaves the rows without suggestions.
 */
export function useRouting({ say, setUndo }: { say(text: string, withUndo?: boolean): void; setUndo(undo: Undo): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [read, setRead] = useState<ClassifyRead | null>(null);
  const [busy, setBusy] = useState(false);
  const out = useRef(false);
  const load = useCallback(() => { rpc.call("classify_get", null).then(setRead, () => undefined); }, [rpc]);
  useEffect(load, [load]);
  useRealtime(INVENTORY_CHANGED, () => load());
  useRealtime("board-changed", () => { if (document.visibilityState === "visible") load(); });
  const suggestions = useMemo(() => rowSuggestions(read?.groups ?? [], read?.dismissed ?? {}), [read]);

  /**
   * Membership actions run in turn as one change, one at a time: the first refusal stops the rest, and Undo takes back each that ran,
   * newest first. Resolves the refusal when nothing ran, else null.
   */
  async function run(calls: readonly (() => Promise<Result>)[]): Promise<string | null> {
    if (out.current || !calls.length) return null;
    out.current = true;
    setBusy(true);
    const done: { actionId: string; added: number; name: string }[] = [];
    let refusal: string | null = null;
    for (const call of calls) {
      const result = await call().catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
      if (!result.ok) { refusal = result.error; break; }
      done.push({ actionId: result.actionId, added: result.added, name: result.effort.name });
    }
    out.current = false;
    setBusy(false);
    if (!done.length) return refusal;
    const text = `${plural(done.reduce((sum, item) => sum + item.added, 0))} → ${[...new Set(done.map((item) => item.name))].join(", ")}`;
    let used = false;
    setUndo({ label: text, live: () => !used, run: async () => {
      used = true;
      for (const item of [...done].reverse()) {
        const undone = await rpc.call("classify_undo", { actionId: item.actionId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
        if (!undone.ok) { say(undone.error); return; }
      }
      say("Undone.");
    } });
    say(refusal ? `${text}. ${refusal}` : text, true);
    return null;
  }
  const dismissed = (prUrl: string, effortId: string | null) => {
    setRead((current) => current && { ...current, dismissed: Object.fromEntries([...Object.entries(current.dismissed).filter(([key]) => key !== prUrl),
      ...effortId ? [[prUrl, effortId]] : []]) });
    return rpc.call("classify_dismiss", { prUrl, effortId });
  };
  return {
    suggestions, efforts: read?.efforts ?? null, busy,
    /** Move PRs from wherever they are now; a refusal resolves for the picker to show. */
    move: (prUrls: string[], to: MoveTarget) => run([() => rpc.call("classify_move", { prUrls, to })]),
    /** Put each row with a suggestion in its suggested effort, as the deck's Accept does: one action per effort. */
    accept: (lines: readonly InventoryLine[]) => void run(acceptCalls(lines, suggestions).map(({ effortId, prUrls }) =>
      () => rpc.call("classify_assign", { effortKey: effortId, prUrls }))).then((refusal) => { if (refusal) say(refusal); }),
    /** Hide one row's suggestion of its effort, with Undo; a later suggestion of another effort still shows. */
    dismiss: (line: InventoryLine) => {
      const suggestion = suggestions.get(line.prUrl);
      if (!suggestion) return;
      void dismissed(line.prUrl, suggestion.effortId).then(() => {
        let used = false;
        setUndo({ label: "Hide suggestion", live: () => !used, run: async () => { used = true; await dismissed(line.prUrl, null).catch(() => load()); say("Undone."); } });
        say(`Hid → ${suggestion.name}? on ${line.repo} #${line.number}`, true);
      }, (cause: unknown) => { say(message(cause)); load(); });
    },
  };
}

const ONE_OFFS = "one-offs";
const NO_JEV = { state: "idle" as const, keys: [], name: null };
/**
 * The picker's list for what you typed, as the thread effort popover builds it: the active efforts that match by name, then One-offs,
 * then a new effort by the typed name unless one has it exactly.
 */
export function moveItems(efforts: readonly { id: string; name: string }[], query: string): PickerItem[] {
  const choice = (key: string, name: string, oneOff: boolean) => ({ key, id: key, name, oneOff, held: false, yourTurn: 0, signal: null, score: 0 });
  const items = pickerItems({ picker: { choices: [...efforts.map((effort) => choice(effort.id, effort.name, false)), choice(ONE_OFFS, "One-offs", true)], jev: false },
    currentKey: null, query, mode: "effort", linkable: [], linkedUrl: null, jev: NO_JEV });
  const rank = (item: PickerItem) => item.kind !== "effort" ? 2 : item.oneOff ? 1 : 0;
  return items.sort((a, b) => rank(a) - rank(b));
}
export type MovePickerProps = { open: boolean; onOpenChange(open: boolean): void;
  /** The active efforts, by name; null while the first read runs. */
  efforts: readonly { id: string; name: string }[] | null; busy: boolean;
  /** Move the selection; resolves why nothing moved, or null. */
  onMove(to: MoveTarget): Promise<string | null> };

/**
 * The selection bar's Move to effort…, which e opens too: type to narrow the active efforts and One-offs, or to name a new effort, then ↵
 * or a click moves the selection at once. A refusal stays in the picker, and esc closes it.
 */
export function MovePicker({ open, onOpenChange, efforts, busy, onMove }: MovePickerProps) {
  const scope = usePortalScopeProps();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ name: string; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  useEffect(() => { if (open) { setQuery(""); setHighlight(-1); setError(null); } }, [open]);
  const items = moveItems(efforts ?? [], query);
  const pick = async (item: PickerItem | undefined) => {
    if (!item || busy || (item.kind !== "effort" && item.kind !== "new")) return;
    if (item.kind === "new" && !item.name) { setError("Type the new effort's name first."); inputRef.current?.focus(); return; }
    // A retry of the same name reuses its request, so a lost reply can't create it twice.
    if (item.kind === "new" && request.current?.name !== item.name) request.current = { name: item.name, id: crypto.randomUUID() };
    setError(await onMove(item.kind === "new" ? { kind: "new", name: item.name, requestId: request.current!.id }
      : item.key === ONE_OFFS ? { kind: "one-off" } : { kind: "effort", effortKey: item.key }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ↵ that ends an input method's composition only commits the text; esc is the popover's own.
    const action = event.nativeEvent.isComposing ? null : pickerActionForKey(event);
    if (!action || action === "pick-back") return;
    event.preventDefault();
    const step = pickerStep(action, { highlight, count: items.length, mode: "effort" });
    if (step && "highlight" in step) {
      setHighlight(step.highlight);
      document.getElementById(`${listId}-${step.highlight}`)?.scrollIntoView({ block: "nearest" });
    } else if (step && "pick" in step) void pick(items[step.pick]);
  };
  return <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <PopoverPrimitive.Trigger asChild>
      <button type="button" data-inventory-action="move" title="Move them to an effort, One-offs, or a new effort, with Undo"
        className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>Move to effort…<Kbd>{ACTION.move.keys[0]}</Kbd></button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content {...scope} side="top" align="start" sideOffset={6} collisionPadding={8}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        className={cn("z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover text-[12px] text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}>
        <PickerBody mode="effort" query={query} items={items} highlight={highlight} busy={busy} current={null} confirm={null}
          notice={efforts ? null : "Reading efforts…"} error={error} listId={listId} inputRef={inputRef}
          onQuery={(value) => { setQuery(value); setHighlight(startHighlight(value)); setError(null); }} onKeyDown={onKeyDown}
          onPick={(index) => void pick(items[index])} onHighlight={setHighlight} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}
