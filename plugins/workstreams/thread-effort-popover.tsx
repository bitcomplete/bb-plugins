// The thread's effort chip and its popover (plan amendment A17.2): the chip
// above the composer names the thread's effort with its color and Your turn
// and opens its card; its ⌄ opens a small popover to type-filter efforts,
// suggested ones first, create one from the typed name, link a PR, or leave
// the effort. A pick applies at once, with an Undo beside the chip; nothing
// waits for a Save. Presentational only: data comes in as props, every
// click goes out through a callback, no SDK hook is called, and imports stay
// relative, so static-markup tests can render it.
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ThreadEffortPicker } from "./thread-effort";
import { moveAlsoText, type PickerItem, type PickerMode } from "./thread-effort-picker";
import { effortColor, SERVICE_COLOR } from "./deck-view-model";
import { Kbd, RING } from "./deck-screen";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";

type Chip = ThreadEffortPicker["chip"];
type Linked = ThreadEffortPicker["linked"][number];
const TURN = "min-w-4 rounded-full bg-amber-500/10 px-1.5 text-center text-[10.5px] font-semibold tabular-nums text-amber-800 dark:text-amber-200";

function Dot({ chip }: { chip: Pick<Chip, "kind" | "effortId" | "oneOff"> }) {
  // A service card's hollow amber dot, as the deck draws it; gray for no effort.
  const color = chip.effortId ? effortColor(chip.effortId, chip.oneOff) : chip.kind === "service" ? SERVICE_COLOR : "#8f8e8a";
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", !chip.effortId && "border border-dashed")}
    style={chip.effortId ? { background: color } : { borderColor: color }} />;
}

/** What the chip opens, in words, for its title and label. */
export function chipLabel(chip: Chip): string {
  const turn = chip.yourTurn ? `, ${chip.yourTurn} your turn` : "";
  return chip.card === null ? `${chip.name}. Choose an effort` : `${chip.name}${turn}. Open its card`;
}

export type ThreadEffortBarProps = {
  /** Null while the first read runs. */
  chip: Chip | null;
  readError: string | null;
  busy?: boolean;
  onRetry(): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Open the chip's card, or the popover when it has none. */
  onCard(): void;
  /** Esc in the popover: false to let it close. */
  onEscape(): boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** What the last pick did, with its Undo while it can still be taken back. */
  flash: { text: string; undo: boolean } | null;
  onUndo(): void;
  children?: ReactNode;
};

/** The chip, split into its card link and the ⌄ that opens the popover, and the last pick's Undo beside it. */
export function ThreadEffortBar(props: ThreadEffortBarProps) {
  const scope = usePortalScopeProps();
  const { chip } = props;
  if (chip === null) return <div className="px-1 pb-1 text-[11px] text-muted-foreground" role="status">{props.readError === null ? "Reading thread effort…"
    : <button type="button" onClick={props.onRetry} className="text-destructive underline underline-offset-2">Could not read thread effort. Retry</button>}</div>;
  return <div className="flex min-w-0 items-center gap-2 px-1 pb-1 text-[11px] text-muted-foreground">
    <PopoverPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverPrimitive.Anchor asChild>
        <div role="group" aria-label="Thread effort" className="inline-flex h-6 min-w-0 items-stretch rounded-md border border-border/70">
          <button type="button" data-effort-chip={chip.kind} onClick={props.onCard} title={chipLabel(chip)} aria-label={chipLabel(chip)}
            className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-l-md px-1.5 hover:bg-foreground/[0.06] hover:text-foreground", RING,
              chip.kind === "effort" && "text-foreground")}>
            <Dot chip={chip} /><span className="truncate">{chip.name}</span>
            {chip.yourTurn ? <span className={TURN}>{chip.yourTurn}</span> : null}
          </button>
          <PopoverPrimitive.Trigger asChild>
            <button type="button" data-effort-open disabled={props.busy} aria-label="Change the thread's effort" title="Change the thread's effort"
              className={cn("rounded-r-md border-l border-border/70 px-1.5 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50", RING)}>⌄</button>
          </PopoverPrimitive.Trigger>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...scope} side="top" align="start" sideOffset={6} collisionPadding={8}
          onOpenAutoFocus={(event) => { event.preventDefault(); props.inputRef?.current?.focus(); }}
          onEscapeKeyDown={(event) => { if (props.onEscape()) event.preventDefault(); }}
          className={cn("z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover text-[12px] text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}>
          {props.children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
    {props.busy ? <span role="status" aria-live="polite">Saving effort…</span> : props.flash ? <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{props.flash.text}</span>
      {props.flash.undo ? <button type="button" data-effort-undo onClick={props.onUndo}
        className={cn("shrink-0 rounded px-1 font-medium text-foreground underline-offset-2 hover:underline", RING)}>Undo</button> : null}
    </span> : null}
    {props.readError === null ? null : <span role="status" title={props.readError}>Could not refresh effort</span>}
  </div>;
}

export type PickerBodyProps = {
  mode: PickerMode;
  query: string;
  items: readonly PickerItem[];
  /** The highlighted item's index; -1 for none. */
  highlight: number;
  busy: boolean;
  /** The thread's linked PRs, under the list; All PRs' Move to effort… has none. */
  linked?: readonly Linked[];
  /** The thread's own effort: linked PRs elsewhere offer to move here. */
  current: { id: string; name: string } | null;
  /** A Move here that takes more than its PR, waiting on Move all with what else it takes listed. */
  confirm: Linked | null;
  notice: string | null;
  error: string | null;
  listId: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onQuery(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  onPick(index: number): void;
  onHighlight(index: number): void;
  onLinkMode?(): void;
  onMove?(pr: Linked): void;
  onConfirmMove?(): void;
  onCancelMove?(): void;
  onOpenPr?(pr: Linked): void;
};

/** One list row, as the popover draws it. */
function ItemRow({ item, current }: { item: PickerItem; current: boolean }) {
  switch (item.kind) {
    case "effort": return <>
      <Dot chip={{ kind: "effort", effortId: item.id, oneOff: item.oneOff }} />
      <span className={cn("min-w-0 truncate", item.current && "font-medium")}>{item.name}</span>
      <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 pl-2 text-[11px] text-muted-foreground">
        {item.suggested && item.signal ? <span className="min-w-0 truncate" title={item.signal}>{item.signal}</span> : null}
        {item.held ? <span className="shrink-0">on hold</span> : null}
        {!item.suggested && item.yourTurn ? <span className={TURN}>{item.yourTurn}</span> : null}
        {item.current ? <span aria-label="The thread's effort" className="shrink-0 text-foreground">✓</span> : null}
        {current ? <Kbd>↵</Kbd> : null}
      </span>
    </>;
    case "new": return <>
      <span aria-hidden className="w-2 shrink-0 text-center text-muted-foreground">+</span>
      <span className="min-w-0 truncate">{item.name ? <>New effort “{item.name}”</> : <span className="text-muted-foreground">New effort… type its name</span>}</span>
      {current ? <span className="ml-auto pl-2"><Kbd>↵</Kbd></span> : null}
    </>;
    case "jev": return <>
      <span aria-hidden className="w-2 shrink-0" />
      <span className="text-muted-foreground">{item.busy ? "Asking Jev…" : "Ask Jev to suggest"}</span>
      {current ? <span className="ml-auto pl-2"><Kbd>↵</Kbd></span> : null}
    </>;
    case "remove": return <>
      <span aria-hidden className="w-2 shrink-0" />
      <span className="min-w-0 truncate text-muted-foreground">Remove from effort</span>
      {current ? <span className="ml-auto pl-2"><Kbd>↵</Kbd></span> : null}
    </>;
    case "pr": return <>
      <span className="min-w-0 truncate" title={item.url}>{item.label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        {item.current ? <span aria-label="Linked now">✓</span> : null}
        {current ? <Kbd>↵</Kbd> : null}
      </span>
    </>;
  }
}

const itemKey = (item: PickerItem) => item.kind === "effort" ? `effort:${item.key}` : item.kind === "pr" ? `pr:${item.url}` : item.kind;

/**
 * The popover: the field that filters and names, the list (suggested efforts first with their signal, then every effort, and "+ New
 * effort" last), a line for a notice or refusal, the thread's linked PRs as chips with "+ Link PR", and Remove at the bottom. The field
 * keeps focus; ↑ ↓ move the highlight through the list and on to Remove, ↵ picks it, and esc backs out.
 */
export function PickerBody(props: PickerBodyProps) {
  const { items, highlight, mode } = props;
  const optionId = (index: number) => `${props.listId}-${index}`;
  const firstOther = items.findIndex((item) => item.kind === "effort" && !item.suggested);
  const suggested = items.some((item) => item.kind === "effort" && item.suggested);
  const option = (item: PickerItem, index: number) => <div key={itemKey(item)} id={optionId(index)} role="option" aria-selected={index === highlight}
    aria-disabled={props.busy || undefined} data-picker-item={item.kind} onMouseMove={() => { if (index !== highlight) props.onHighlight(index); }}
    onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!props.busy) props.onPick(index); }}
    className={cn("flex h-7 min-w-0 items-center gap-2 rounded-md px-2", index === highlight && "bg-foreground/[0.07]", props.busy && "opacity-60")}>
    <ItemRow item={item} current={index === highlight} />
  </div>;
  const removeAt = items.findIndex((item) => item.kind === "remove");
  return <div className="flex max-h-[min(28rem,calc(100dvh-6rem))] flex-col">
    <div className="flex items-center gap-2 border-b border-border px-2.5">
      <input ref={props.inputRef} value={props.query} onChange={(event) => props.onQuery(event.target.value)} onKeyDown={props.onKeyDown}
        role="combobox" aria-expanded aria-controls={`${props.listId} ${props.listId}-leave`} aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? optionId(highlight) : undefined}
        aria-label={mode === "link" ? "Find a PR to link" : "Find or name an effort"} placeholder={mode === "link" ? "Find a PR to link" : "Find or name an effort"}
        maxLength={120} spellCheck={false} autoComplete="off" readOnly={props.busy} aria-busy={props.busy || undefined}
        className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground read-only:opacity-60" />
      <Kbd>esc</Kbd>
    </div>
    <div id={props.listId} role="listbox" aria-label={mode === "link" ? "PRs" : "Efforts"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
      {mode === "link" && !items.length ? <p className="px-2 py-1.5 text-muted-foreground">No tracked PR matches.</p> : null}
      {items.map((item, index) => item.kind === "remove" ? null : <div key={itemKey(item)} className="contents">
        {index === 0 && suggested ? <p role="presentation" className="px-2 pb-0.5 pt-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">Suggested</p> : null}
        {index === firstOther && suggested ? <div role="presentation" className="mx-2 my-1 border-t border-border/70" /> : null}
        {option(item, index)}
      </div>)}
    </div>
    {props.error || props.notice ? <p role={props.error ? "alert" : "status"} title={props.error ?? props.notice ?? undefined}
      className={cn("line-clamp-2 border-t border-border px-2.5 py-1.5 text-[11px]", props.error ? "text-destructive" : "text-muted-foreground")}>{props.error ?? props.notice}</p> : null}
    {mode === "effort" && props.linked ? <div className="flex flex-wrap items-center gap-1 border-t border-border px-2.5 py-1.5" aria-label="Linked PRs" role="group">
      <span className="pr-0.5 text-[10.5px] uppercase tracking-wide text-muted-foreground">PRs</span>
      {props.linked.map((pr) => {
        const elsewhere = props.current !== null && pr.effortId !== props.current.id;
        return <span key={pr.url} data-linked-pr={pr.ref} className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border px-1.5 text-[11px]">
          <button type="button" onClick={() => props.onOpenPr?.(pr)} title={`${pr.title} · open on GitHub`} className={cn("shrink-0 rounded", RING)}>{pr.ref}</button>
          {pr.effortName && pr.effortId !== props.current?.id ? <span className="min-w-0 truncate text-muted-foreground" title={`In ${pr.effortName}`}>· {pr.effortName}</span> : null}
          {elsewhere ? <button type="button" data-linked-move onClick={() => props.onMove?.(pr)} disabled={props.busy}
            title={`${pr.effortName ? "Move" : "Add"} ${pr.ref}${pr.sourceIds.some((id) => id.startsWith("ticket:")) ? " with its ticket" : ""} to ${props.current!.name}`}
            className={cn("shrink-0 rounded px-0.5 text-foreground underline-offset-2 hover:underline disabled:opacity-50", RING)}>{pr.effortName ? "Move here" : "Add"}{pr.also.length ? "…" : ""}</button> : null}
        </span>;
      })}
      <button type="button" data-link-pr onClick={props.onLinkMode} disabled={props.busy}
        className={cn("inline-flex h-5 items-center rounded-full border border-dashed border-border px-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50", RING)}>
        + Link PR</button>
    </div> : null}
    {mode === "effort" && props.confirm ? <div role="group" aria-label="Confirm the move" data-move-confirm
      className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border px-2.5 py-1.5 text-[11px]">
      <span className="mr-auto min-w-0">{moveAlsoText(props.confirm)}</span>
      <button type="button" onClick={props.onCancelMove} className={cn("rounded px-1 text-muted-foreground hover:text-foreground", RING)}>Cancel</button>
      <button type="button" data-move-all onClick={props.onConfirmMove} disabled={props.busy}
        className={cn("rounded border border-foreground bg-foreground px-1.5 font-medium text-background hover:bg-foreground/90 disabled:opacity-50", RING)}>Move all</button>
    </div> : null}
    {removeAt >= 0 ? <div id={`${props.listId}-leave`} role="listbox" aria-label="Leave the effort" className="border-t border-border p-1">{option(items[removeAt]!, removeAt)}</div> : null}
  </div>;
}
