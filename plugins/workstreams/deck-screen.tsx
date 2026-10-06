// The effort deck's screen (plan amendments A15 and A17.1, design-directions/
// effort-card-v2): the effort strip, one card per effort with its few next
// moves over All PRs' own rows (inventory-rows.tsx), its finish line, its
// chores, and its toggles, a service card's suggestions, and the hint bar,
// plus the bodies of the deck's dialogs. Presentational only: data comes in
// as props, every click goes out through one `run` command, no SDK hook is
// called, and imports stay relative, so static-markup tests can render it.
// Amber means a person waits on you; chores never turn it.
import type { ReactNode, RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { BatchItem, Skipped } from "./deck-batch";
import type { LiveItems } from "./deck-flow";
import type { SeedProposal } from "./linear-seed";
import { ACTION, KEY_GROUPS, type DeckActionId } from "./deck-keys";
import type { Availability, CardScreen, Chip, DeckLine, Finish, Mismatch, Move, NotesScreen, OverviewScreen, PaletteItem, Strength, SuggestGroup, TicketChip, Tone }
  from "./deck-view-model";
import { SEND_DELAY_MS } from "./deck-shared";
import { effortReadSummary, prReadState, prStatuses, threadRefs, threadStatus, threadReadSummary, type PrStatus, type StatusLabel } from "./deck-status";
import { inventoryPrPath, inventoryRoute } from "./view-preference";
import { NOTES_MAX } from "./effort-notes";
import { behind as cardsBehind, LAYERS, layerTransform } from "./deck-flip";
import { SimpleInventoryList } from "./inventory-rows";
import type { InventoryLine } from "./inventory-view-model";
import { Icon } from "./components/ui/icon";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";

/** Everything a click on the deck can ask for; the nav view decides what each does. */
export type DeckCommand =
  | { kind: "action"; id: DeckActionId; line?: DeckLine }
  /** One row's own Nudge, which opens the listing confirm for it, or its ↻. */
  | { kind: "row"; id: "nudge" | "refresh"; prUrl: string }
  | { kind: "go"; id: string } | { kind: "view"; view: HeaderTarget } | { kind: "open"; url: string }
  /** Tick or untick a Your turn row for Address; Shift takes the range from the last one you clicked. */
  | { kind: "select"; prUrl: string; shift: boolean }
  /** Show or hide a move's rows, or the chores'; open or close a toggle's panel. */
  | { kind: "fold"; key: string } | { kind: "panel"; key: Panel }
  | { kind: "group"; key: string } | { kind: "undo-group"; key: string } | { kind: "undo-batch"; batchId: string }
  | { kind: "thread"; id: string } | { kind: "jump"; prUrl: string }
  | { kind: "archive-thread"; id: string; cardId: string; title: string } | { kind: "archived-threads" }
  | { kind: "resume"; id: string } | { kind: "reopen"; id: string }
  | { kind: "rule-remove"; id: string } | { kind: "pile"; pile: "hold" | "done" | null }
  /** The Notes panel's editor: what you typed, save (⌘↵), or cancel (esc). */
  | { kind: "notes-draft"; text: string } | { kind: "notes-save" } | { kind: "notes-cancel" };
export type Run = (command: DeckCommand) => void;

/** The 2px accent ring every control shows on keyboard focus. */
export const RING = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
export const TONE: Record<Tone, { text: string; chip: string; edge: string; button: string; bar: string }> = {
  green: { text: "text-emerald-700 dark:text-emerald-300", chip: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200", edge: "bg-emerald-500/70",
    button: "border-emerald-500/35 bg-emerald-500/[0.07] text-emerald-800 hover:bg-emerald-500/[0.14] dark:text-emerald-200", bar: "bg-emerald-500/55" },
  violet: { text: "text-violet-700 dark:text-violet-300", chip: "bg-violet-500/10 text-violet-800 dark:text-violet-200", edge: "bg-violet-500/70",
    button: "border-violet-500/35 bg-violet-500/[0.07] text-violet-800 hover:bg-violet-500/[0.14] dark:text-violet-200", bar: "bg-violet-500/55" },
  blue: { text: "text-sky-700 dark:text-sky-300", chip: "bg-sky-500/10 text-sky-800 dark:text-sky-200", edge: "bg-sky-500/70",
    button: "border-sky-500/35 bg-sky-500/[0.07] text-sky-800 hover:bg-sky-500/[0.14] dark:text-sky-200", bar: "bg-sky-500/55" },
  amber: { text: "text-amber-700 dark:text-amber-300", chip: "bg-amber-500/10 text-amber-800 dark:text-amber-200", edge: "bg-amber-500/70",
    button: "border-amber-500/35 bg-amber-500/[0.07] text-amber-800 hover:bg-amber-500/[0.14] dark:text-amber-200", bar: "bg-amber-500/60" },
  red: { text: "text-rose-700 dark:text-rose-300", chip: "bg-rose-500/10 text-rose-800 dark:text-rose-200", edge: "bg-rose-500/70",
    button: "border-rose-500/35 bg-rose-500/[0.07] text-rose-800 hover:bg-rose-500/[0.14] dark:text-rose-200", bar: "bg-rose-500/55" },
  gray: { text: "text-muted-foreground", chip: "bg-foreground/[0.05] text-muted-foreground", edge: "bg-muted-foreground/50", button: "border-border hover:bg-foreground/[0.06]",
    bar: "bg-muted-foreground/35" },
};
export const BUTTON = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] disabled:opacity-45 aria-disabled:opacity-45", RING);
export const GHOST = cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The spinner a control shows while it works; still under reduced motion. */
export const Spin = () => <span aria-hidden data-spin className="inline-block leading-none motion-safe:animate-spin">↻</span>;
/** A row a batch is planning: it pulses, or dims under reduced motion. */
export const WORKING_ROW = "motion-safe:animate-pulse motion-reduce:opacity-60";

// The list vocabulary the deck shares with All PRs, so the two views read as one.
/** The centered column a view's content and its docked selection bar sit in. */
export const COLUMN = "mx-auto max-w-3xl";
/** That column's scrolling content: its gutters, which widen in a wide pane, and its top and bottom spacing. */
export const CONTENT = cn(COLUMN, "px-2 pb-10 pt-3 @min-[720px]:px-4");
/** A section's heading line, which its colored bar, title, and count sit in. */
export const SECTION_HEAD = "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-background py-1 pl-2 pr-1";
/** A section's count badge; the caller adds its tone. */
export const COUNT = "min-w-[18px] rounded-full px-1.5 text-center text-[11px] tabular-nums";
/** A row's checkbox: faint until you point at the row. */
export const CHECKBOX = "size-3.5 shrink-0 accent-sky-600 opacity-50 group-hover:opacity-100 disabled:opacity-20";
/** The card a group's rows sit in under the group's title, and a deck card's panels: one border, radius, and tint. */
export const GROUP_CARD = "min-w-0 rounded-[10px] border border-border/50 bg-foreground/[0.015] px-2 py-1";

/**
 * A PR's repository, muted, and its number, bold, in a fixed column so rows line up. A long repository name truncates first, so the
 * number never does. `strong`: the move is yours. With `onClick`, it's a button.
 */
export function PrRef({ repo, number, strong, className, onClick }: { repo: string; number: string | number; strong?: boolean; className?: string | false;
  onClick?(): void }) {
  const title = `${repo} #${number}`;
  const parts = <><span className="min-w-0 truncate">{repo}</span><b className={cn("shrink-0 font-medium", strong ? "text-foreground" : "text-foreground/80")}>#{number}</b></>;
  const column = cn("flex w-[124px] shrink-0 justify-start gap-1 whitespace-nowrap text-muted-foreground @min-[720px]:w-[156px]", className);
  return onClick ? <button type="button" title={title} onClick={onClick} className={cn(column, "rounded-sm hover:underline", RING)}>{parts}</button>
    : <span title={title} className={column}>{parts}</span>;
}

/**
 * A key badge. On a primary button (`inverted`, which fills with the foreground color) it's a translucent wash of the button's own text
 * color with text in that color, so it never reads as an empty box; elsewhere it's a hairline with muted text. No key draws no badge.
 */
export function Kbd({ children, inverted }: { children?: string | null; inverted?: boolean }) {
  if (!children?.trim()) return null;
  return <kbd className={cn("inline-block min-w-4 rounded border px-1 text-center font-mono text-[10.5px] leading-[14px]",
    inverted ? "border-transparent bg-background/20 text-background" : "border-border text-muted-foreground")}>{children}</kbd>;
}
/** A key's hint as kbds: "] →" reads as two keys for one action. */
export function Keys({ keys, inverted }: { keys: string; inverted?: boolean }) {
  const list = keys.split(" ").filter(Boolean);
  return list.length ? <span className="inline-flex gap-0.5">{list.map((key) => <Kbd key={key} inverted={inverted}>{key}</Kbd>)}</span> : null;
}
const Dot = ({ color, hollow }: { color: string; hollow?: boolean }) => <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", hollow && "border border-dashed")}
  style={hollow ? { borderColor: color } : { background: color }} />;
const Changed = ({ title }: { title: string }) => <span title={title} aria-label={title} className="inline-block size-1.5 shrink-0 rounded-full bg-sky-500" />;

const PRIMARY = "border-foreground bg-foreground font-medium text-background hover:bg-foreground/90";
/** A button that names its key: disabled ones stay focusable and say why. `className` replaces its face. */
function ActionButton({ id, on, run, label, tone, primary, className }: { id: DeckActionId; on: Availability; run: Run; label?: string; tone?: Tone;
  primary?: boolean; className?: string }) {
  const available = on[id];
  const key = ACTION[id].keys[0];
  return <button type="button" data-deck-focus={`act-${id}`} aria-disabled={available.on ? undefined : true}
    title={available.on ? `${ACTION[id].title}${key ? ` (${key})` : ""}` : `${ACTION[id].title.replace("…", "")}: ${available.why}`}
    onClick={() => { if (available.on) run({ kind: "action", id }); }}
    className={className ?? cn(BUTTON, primary ? PRIMARY : tone ? TONE[tone].button : "border-border hover:bg-foreground/[0.06]")}>
    {label ?? ACTION[id].title}<Keys keys={key ?? ""} inverted={primary} />
  </button>;
}

// ---------------------------------------------------------------------------
// The strip: the active pile in session order, service cards last, and the piles.
// ---------------------------------------------------------------------------

export type Pile = { id: string; key: string; name: string; note: string; archived?: boolean };
export function Strip({ chips, cur, deck, held, done, pile, run, chipsRef }: { chips: readonly Chip[]; cur: string | null; deck: boolean; held: readonly Pile[];
  done: readonly Pile[]; pile: "hold" | "done" | null; run: Run; chipsRef?: RefObject<HTMLDivElement | null> }) {
  return <nav aria-label="Efforts" className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
    <button type="button" data-deck-focus="prev" title="Previous effort ([ or ←)" aria-label="Previous effort" onClick={() => run({ kind: "action", id: "prev" })}
      className={cn("size-7 shrink-0 rounded-md border border-border/70 text-[13px] text-muted-foreground hover:text-foreground", RING)}>←</button>
    <div ref={chipsRef} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]">
      {chips.map((chip) => <button key={chip.id} type="button" data-deck-focus={`chip-${chip.id}`} data-deck-chip={chip.id} aria-current={deck && chip.id === cur ? "true" : undefined}
        title={chip.id === "overview" ? "Overview" : `${chip.name}: ${chip.count} your turn${chip.n ? ` (${chip.n})` : ""}`} onClick={() => run({ kind: "go", id: chip.id })}
        className={cn("relative flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[12px]", RING,
          chip.service && "border-dashed", deck && chip.id === cur ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
        {chip.n ? <span className="font-mono text-[10.5px] text-muted-foreground/80">{chip.n}</span> : null}
        {chip.id === "overview" ? null : <Dot color={chip.color} hollow={chip.service} />}
        <span className="max-w-[150px] truncate">{chip.name}</span>
        {chip.id === "overview" ? null : <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums", chip.count ? TONE.amber.chip : "font-normal text-muted-foreground")}>
          {chip.count}</span>}
        {chip.ping ? <span aria-label="Changed since you looked" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500" /> : null}
      </button>)}
    </div>
    <button type="button" data-deck-focus="next" title="Next effort (] or →)" aria-label="Next effort" onClick={() => run({ kind: "action", id: "next" })}
      className={cn("size-7 shrink-0 rounded-md border border-border/70 text-[13px] text-muted-foreground hover:text-foreground", RING)}>→</button>
    <div className="flex shrink-0 items-center gap-1 border-l border-border/70 pl-1.5">
      <PilePopover pile="hold" items={held} open={pile === "hold"} run={run} />
      <PilePopover pile="done" items={done} open={pile === "done"} run={run} />
    </div>
  </nav>;
}

/** On hold or Done: a stack you open to resume or reopen an effort, which joins the end of the active pile. */
function PilePopover({ pile, items, open, run }: { pile: "hold" | "done"; items: readonly Pile[]; open: boolean; run: Run }) {
  const scope = usePortalScopeProps();
  const label = pile === "hold" ? "On hold" : "Done";
  return <PopoverPrimitive.Root open={open} onOpenChange={(next) => run({ kind: "pile", pile: next ? pile : null })}>
    <PopoverPrimitive.Trigger asChild>
      <button type="button" data-deck-focus={`pile-${pile}`} data-deck-pile={pile} title={`The ${label} pile`}
        className={cn("flex h-[30px] items-center gap-1.5 rounded-lg px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground", RING)}>
        <PileCards empty={!items.length} />
        {pile === "hold" ? "Hold" : "Done"} <b className="font-semibold text-foreground/80">{items.length}</b>
      </button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content {...scope} align="end" sideOffset={6} collisionPadding={8}
        className={cn("z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-2 text-[12px] text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}>
        <p className="px-1 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label} · {items.length}</p>
        {items.length ? items.map((item) => <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1 py-1 hover:bg-foreground/[0.04]">
          <span className="truncate">{item.name}</span>
          {pile === "hold" ? <button type="button" onClick={() => run({ kind: "resume", id: item.id })} className={cn(BUTTON, "border-border")}>Resume</button>
            : item.archived ? <span className="text-[11px] text-muted-foreground" title="Restore it from Efforts admin first">Archived</span>
            : <button type="button" onClick={() => run({ kind: "reopen", id: item.id })} className={cn(BUTTON, "border-border")}>Reopen</button>}
          <span className="col-span-2 truncate text-[11px] text-muted-foreground">{item.note}</span>
        </div>) : <p className="px-1 text-muted-foreground">Empty.</p>}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

/** A pile's tiny stack, drawn like the deck's: three cards, each one behind a little further right and smaller. An empty pile is an outline. */
function PileCards({ empty }: { empty: boolean }) {
  return <span aria-hidden data-deck-pile-cards={empty ? "empty" : "stacked"} className="relative inline-block h-[13px] w-3.5 shrink-0">
    {empty ? <i className="absolute left-0 top-0 h-[13px] w-2.5 rounded-[2.5px] border border-dashed border-border" />
      : [2, 1, 0].map((depth) => <i key={depth} className="absolute left-0 top-0 h-[13px] w-2.5 origin-right rounded-[2.5px] border"
        style={{ transform: `translateX(${depth * 2}px) scale(${1 - depth * 0.1})`, background: `color-mix(in srgb, var(--background) ${100 - 6 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${34 - 9 * depth}%, transparent)` }} />)}
  </span>;
}

// ---------------------------------------------------------------------------
// The stack: the card shown on top, and the next few in the ring peeking out to its right.
// ---------------------------------------------------------------------------

/**
 * The deck as a stack of cards: the one shown on top, over the next few a flip forward reaches, each further right, smaller, and darker, as
 * → and ] move, with the next one's name up its edge, which flips to it. The deepest edge's room is a gutter on the right, inside the deck's
 * width. A flip draws the card it takes away in the ghost, over or under the top one (deck-flip.ts); the ghost is otherwise empty. It's
 * clipped at the top card's bottom edge, so a taller card taken away never hangs over the rows below, while its slide and tilt still show
 * above and to the sides.
 */
function Stack({ behind, run, children }: { behind: readonly Chip[]; run: Run; children: ReactNode }) {
  return <div className="mb-2.5" style={{ paddingRight: LAYERS[behind.length]!.x }}>
    <div data-deck-stack className="relative isolate">
      {behind.map((chip, index) => { const depth = index + 1; return <div key={chip.id} data-deck-layer={depth} aria-hidden={depth > 1 || undefined}
        className="absolute inset-0 origin-right rounded-[14px] border shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_12px_-8px_rgb(0_0_0/0.35)]"
        style={{ zIndex: 4 - depth, transform: layerTransform(depth), background: `color-mix(in srgb, var(--background) ${100 - 4 * depth}%, #000)`,
          borderColor: `color-mix(in srgb, var(--foreground) ${14 - 3 * depth}%, transparent)` }}>
        {depth === 1 ? <button type="button" tabIndex={-1} data-deck-peek={chip.id} onClick={() => run({ kind: "action", id: "next" })} title={`Next: ${chip.name} (] or →)`}
          aria-label={`Next effort: ${chip.name}`} style={{ width: LAYERS[1].x }}
          className="absolute inset-y-0 right-0 flex flex-col items-center gap-1.5 rounded-r-[14px] py-4 text-[11px] leading-none text-muted-foreground hover:text-foreground">
          {chip.id === "overview" ? null : <Dot color={chip.color} hollow={chip.service} />}<span className="min-h-0 truncate [writing-mode:vertical-rl]">{chip.name}</span></button> : null}
      </div>; })}
      <div data-deck-top className="relative z-[5] origin-right rounded-[14px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.2),0_8px_22px_-10px_rgb(0_0_0/0.6)]">{children}</div>
      <div data-deck-ghost aria-hidden className="pointer-events-none absolute inset-0" style={{ clipPath: "inset(-60px -60px 0 -60px)" }} />
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// The effort card: its header, its finish line, its few moves over All PRs' rows, its chores, and its toggles.
// ---------------------------------------------------------------------------

/**
 * What the card's rows draw from: each open PR as All PRs words it, by PR; the Your turn rows ticked for Address; a batch sending now and
 * why the last Address left a PR out; the rows a batch is planning; and the rows a Refresh is reading.
 */
export type RowKit = { lines: ReadonlyMap<string, InventoryLine>; picked: ReadonlySet<string>; live?: LiveItems; left?: ReadonlyMap<string, string>;
  working?: ReadonlySet<string>; reading?: ReadonlySet<string>; archivingThread?: string | null;
  /** Each row's ticket chip, which the card fills in from its screen. */
  tickets?: ReadonlyMap<string, TicketChip>;
  /** Why the last Address started nothing. */
  refusal?: string | null };
/** A footer toggle's panel, one open at a time. */
export type Panel = "notes" | "threads" | "linear" | "held" | "all";

/** All PRs' two-line rows for `prUrls`, in the card that rows sit in there: ticked for Address on its own rows (`turn`), else as Other open PRs. */
function Rows({ prUrls, kit, run, turn }: { prUrls: readonly string[]; kit: RowKit; run: Run; turn?: boolean }) {
  const lines = prUrls.flatMap((prUrl) => kit.lines.get(prUrl) ?? []);
  return lines.length ? <SimpleInventoryList groups={[{ key: "rows", label: "", effortId: null, lines }]} kind={turn ? "turn" : "other"} busyKey={null}
    selected={kit.picked} live={kit.live} notes={kit.left} working={kit.working} reading={kit.reading} tickets={kit.tickets}
    onSelect={turn ? (line, shift) => run({ kind: "select", prUrl: line.prUrl, shift }) : undefined} onOpenPr={(url) => run({ kind: "open", url })}
    onOpenThread={(id) => run({ kind: "thread", id })} onOpenEffort={() => undefined} onUndo={(batchId) => run({ kind: "undo-batch", batchId })}
    // A row's Nudge opens the deck's listing confirm for it, as n does: the deck never writes on one click.
    onNudge={(line) => run({ kind: "row", id: "nudge", prUrl: line.prUrl })} onRefresh={(line) => run({ kind: "row", id: "refresh", prUrl: line.prUrl })} /> : null;
}

/** A Reconcile line's one button: Show folds the open PRs it names; the other opens its first ticket's Linear page, when Linear gave one. */
function MismatchButton({ line, shown, run, className }: { line: Mismatch; shown: boolean; run: Run; className: string }) {
  return line.kind === "done" ? <button type="button" data-deck-focus="move-reconcile" aria-expanded={shown} title={`${shown ? "Hide" : "Show"} their open PRs`}
    onClick={() => run({ kind: "fold", key: "reconcile" })} className={className}>{line.button}</button>
    : line.url ? <button type="button" title={`Open ${line.tickets[0]} in Linear`} onClick={() => run({ kind: "open", url: line.url! })} className={className}>{line.button}</button>
    : null;
}

/**
 * One move: its outcome and a line of detail, which fold its rows, and its one verb with its key. Address starts at once for the rows you
 * leave ticked, with 8 s to Undo; every other verb opens its listing confirm or the fresh merge preview first. The first move leads.
 * Reconcile writes nothing: a line per mismatch, each with its tickets and one button.
 */
function MoveBlock({ move, lead, shown, kit, on, run }: { move: Move; lead: boolean; shown: boolean; kit: RowKit; on: Availability; run: Run }) {
  const face = cn(BUTTON, "h-7 px-2.5", lead ? PRIMARY : TONE[move.tone].button);
  const picked = move.prUrls.filter((prUrl) => kit.picked.has(prUrl)).length;
  return <li data-deck-move={move.kind} className="relative min-w-0 rounded-[10px] py-1 pl-3">
    <span aria-hidden className={cn("absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full", TONE[move.tone].edge)} />
    {move.kind === "reconcile" ? move.lines?.map((line) => <div key={line.kind} data-deck-mismatch={line.kind} className="flex min-h-10 items-center gap-3 pr-1">
      <div className="min-w-0 flex-1"><b className="block truncate text-[13px] font-semibold leading-5">{line.text}</b>
        <span className="block truncate text-[11.5px] text-muted-foreground" title={line.tickets.join(", ")}>{line.tickets.join(", ")}</span></div>
      <MismatchButton line={line} shown={shown} run={run} className={cn(BUTTON, "h-7 px-2.5", TONE.gray.button)} /></div>)
    : <div className="flex min-h-10 items-center gap-3 pr-1">
      <button type="button" data-deck-focus={`move-${move.kind}`} aria-expanded={shown} onClick={() => run({ kind: "fold", key: move.kind })}
        title={shown ? "Hide its rows (↵)" : "Show its rows (↵)"} className={cn("min-w-0 flex-1 rounded text-left", RING)}>
        <b className="block truncate text-[13px] font-semibold leading-5">{move.title}</b>
        <span className="block truncate text-[11.5px] text-muted-foreground">{move.meta}</span>
      </button>
      {move.kind === "address" ? <button type="button" data-deck-focus="act-address" aria-disabled={on.address.on ? undefined : true}
        title={on.address.on ? "Starts one thread for the ticked PRs now, with 8 s to Undo. Nothing merges. (b)" : `Address: ${on.address.why}`}
        onClick={() => run({ kind: "action", id: "address" })} className={face}>Address {picked}<Kbd inverted={lead}>{ACTION.address.keys[0]}</Kbd></button>
        : <ActionButton id={move.kind} on={on} run={run} label={move.verb} primary={lead} className={face} />}
    </div>}
    {move.kind === "address" && kit.refusal ? <p role="alert" data-deck-refusal className="truncate pb-1 text-[12px] text-destructive" title={kit.refusal}>{kit.refusal}</p> : null}
    {shown ? <Rows prUrls={move.prUrls} kit={kit} run={run} turn={move.kind === "address"} /> : null}
  </li>;
}

/** The finish line, "4 of 12 done · Target Oct 14 · 12d left · ETA Oct 20 at 1.5/wk", which p opens to five one-line answers. */
function FinishLine({ finish, open, run }: { finish: Finish; open: boolean; run: Run }) {
  const dot = <span aria-hidden>·</span>;
  return <div data-deck-finish className={cn("mt-2 rounded-lg", open && "bg-foreground/[0.03]")}>
    <button type="button" data-deck-focus="progress" aria-expanded={open} onClick={() => run({ kind: "action", id: "progress" })} title={`Where it stands (${ACTION.progress.keys[0]})`}
      className={cn("flex w-full flex-wrap items-center gap-x-2 rounded-lg px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-foreground/[0.04]", RING)}>
      <span className="text-foreground/90">{finish.done}</span>{dot}
      <span className={finish.date ? TONE[finish.date.tone].text : undefined}>{finish.date?.text ?? "No date"}</span>
      {finish.eta ? <>{dot}<span className={TONE[finish.eta.tone].text}>{finish.eta.text}</span></> : null}
      <span aria-hidden className={cn("ml-auto text-[10px] transition-transform motion-reduce:transition-none", open && "rotate-90")}>▶</span>
    </button>
    {open ? <dl data-deck-answers className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-2 pb-2 pt-0.5 text-[12px]">
      {finish.answers.map(([label, value]) => <div key={label} className="contents"><dt className="text-[11px] leading-[18px] text-muted-foreground">{label}</dt>
        <dd className="min-w-0 break-words">{value}</dd></div>)}</dl> : null}
  </div>;
}

function ThreadList({ threads, run, screen, archiving }: { threads: CardScreen["threads"]; run: Run; screen?: CardScreen; archiving?: string | null }) {
  return threads.length ? <ul className="grid list-none">{threads.map((thread) => {
    const refs = screen ? threadRefs(screen, thread) : thread.ref;
    const at = screen?.card.threads.find((t) => t.id === thread.id)?.lastActivityAt;
    return <li key={thread.id} className="flex min-w-0 items-center gap-1.5">
      <button type="button" onClick={() => run({ kind: "thread", id: thread.id })} data-deck-thread={thread.id} title={`Open "${thread.title}"`}
        className={cn("grid min-h-9 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-foreground/[0.04] @min-[480px]:grid-cols-[minmax(0,1fr)_auto]", RING)}>
        <span className="min-w-0"><span className="block break-words @min-[480px]:truncate">{thread.dot ? <><Changed title="Changed since you looked" /> </> : null}{thread.title}</span>
          <small className="block break-words text-[11px] text-muted-foreground @min-[480px]:truncate" title={`${refs || "Linked thread"}${at != null ? ` · Last activity ${new Date(at).toLocaleString()}` : ""}`}>
            {refs === "parent" ? "Effort thread" : refs || "Linked thread"} · {thread.age ? `Last activity ${thread.age} ago` : "Activity unknown"}</small></span>
        <span className={cn("text-[11.5px]", TONE[threadStatus(thread).tone].text)}>{threadStatus(thread).text}</span>
      </button>
      {screen ? <button type="button" data-deck-thread-archive={thread.id} disabled={!!archiving || thread.status !== "idle"}
        aria-label={`Archive ${thread.title}`} aria-busy={archiving === thread.id || undefined}
        title={thread.status === "idle" ? "Archive this idle thread. Threads with subthreads must be archived from BB." : "Only idle threads can be archived here."}
        onClick={() => run({ kind: "archive-thread", id: thread.id, cardId: screen.card.id, title: thread.title })} className={cn(GHOST, "shrink-0 px-1 text-[11px]")}>{archiving === thread.id ? "Archiving…" : "Archive"}</button> : null}
    </li>;
  })}</ul> : <p className="text-[12px] text-muted-foreground">No threads yet.</p>;
}

function StatusBadge({ status }: { status: StatusLabel }) {
  return <span className={cn("inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-4", TONE[status.tone].chip)}>{status.text}</span>;
}

/** One roster, one state per PR. Links open the PR workbench, never dispatch a write. */
function PrStatusList({ prs, run, kit }: { prs: readonly PrStatus[]; run: Run; screen?: CardScreen; kit?: RowKit }) {
  return <ul data-deck-pr-statuses className="grid list-none divide-y divide-border/40">
    {prs.map((pr) => { const state = prReadState(pr); const note = kit?.left?.get(pr.prUrl) ?? kit?.lines.get(pr.prUrl)?.last?.text;
      return <li key={pr.prUrl} data-deck-pr-status={pr.prUrl} data-inventory-row={inventoryRoute(inventoryPrPath(pr.prUrl)) ?? pr.ref} tabIndex={-1}
        className={cn("grid min-w-0 gap-x-4 gap-y-1 px-1 py-3 @min-[480px]:grid-cols-[minmax(0,1fr)_auto]", RING)}>
        <button type="button" data-deck-pr-link={pr.prUrl} onClick={() => run({ kind: "jump", prUrl: pr.prUrl })}
          className={cn("grid min-w-0 gap-0.5 rounded-sm text-left hover:underline", RING)} title={`Open ${pr.ref} in All PRs`}>
          <span className="text-[11px] text-muted-foreground">{pr.ref}</span><span className="truncate text-[13px]">{pr.title}</span>
        </button>
        <span data-deck-pr-state className={cn("self-center text-[11.5px] @min-[480px]:max-w-[260px] @min-[480px]:text-right", state.tone === "amber" || state.tone === "red" ? TONE[state.tone].text : "text-muted-foreground")}>{state.text}</span>
        {pr.detail ? <p className="break-words text-[11.5px] text-muted-foreground @min-[480px]:col-span-2">{pr.detail}</p> : null}
        {pr.thread ? <button type="button" data-deck-thread={pr.thread.id} onClick={() => run({ kind: "thread", id: pr.thread!.id })}
          title={`Open ${pr.thread.title}`} className={cn("flex min-w-0 items-center gap-1.5 justify-self-start rounded-sm text-[11.5px] text-muted-foreground hover:text-foreground @min-[480px]:col-span-2", RING)}>
          <span aria-hidden>↗</span><span className="truncate">{pr.thread.title}</span><span className={cn("shrink-0", TONE[pr.thread.status.tone].text)}>{pr.thread.status.text}</span>
        </button> : null}
        {note ? <p role="status" className="break-words text-[11px] text-muted-foreground @min-[480px]:col-span-2">{note}</p> : null}
      </li>; })}
  </ul>;
}

/** The Notes panel's editor while it's open: what you typed, and a save that's running or was refused. */
export type NotesEdit = { draft: string; busy: boolean; error: string | null };

/** Editing notes in place: Markdown in a plain field, ⌘↵ saves, esc cancels. */
function NotesEditor({ edit, run }: { edit: NotesEdit; run: Run }) {
  return <div className="grid gap-1.5">
    <textarea data-deck-notes-editor autoFocus value={edit.draft} maxLength={NOTES_MAX} rows={Math.min(14, Math.max(4, edit.draft.split("\n").length + 1))}
      aria-label="Notes, in Markdown" placeholder="Flags, experiments, anything else. Markdown works." spellCheck
      onChange={(event) => run({ kind: "notes-draft", text: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run({ kind: "notes-save" }); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); run({ kind: "notes-cancel" }); }
      }}
      className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px] leading-[18px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
    {edit.error ? <p role="alert" className="text-[12px] text-destructive">{edit.error}</p> : null}
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto text-[11px] text-muted-foreground">Markdown</span>
      <button type="button" onClick={() => run({ kind: "notes-cancel" })} className={cn(BUTTON, "border-border")}>Cancel<Kbd>esc</Kbd></button>
      <button type="button" data-deck-notes-save disabled={edit.busy} onClick={() => run({ kind: "notes-save" })}
        className={cn(BUTTON, PRIMARY)}>{edit.busy ? "Saving…" : "Save"}<Kbd inverted>⌘↵</Kbd></button>
    </div>
  </div>;
}

/** A footer toggle's panel: the notes, the threads, what Linear says, the held PRs with Release, or every open PR. */
function PanelBody({ panel, screen, kit, on, run, notes, markdown }: { panel: Panel; screen: CardScreen; kit: RowKit; on: Availability; run: Run; notes: NotesEdit | null;
  markdown?: (body: string) => ReactNode }) {
  const live = screen.lines.filter((line) => line.row);
  switch (panel) {
    case "notes": return notes ? <NotesEditor edit={notes} run={run} /> : <div className="grid gap-1.5">
      {screen.notes?.body ? <div data-deck-notes-body className="min-w-0 text-[12.5px]">{markdown ? markdown(screen.notes.body)
        : <p className="whitespace-pre-wrap break-words">{screen.notes.body}</p>}</div> : <p className="text-[12px] text-muted-foreground">No notes yet.</p>}
      <span><button type="button" data-deck-focus="notes-edit" onClick={() => run({ kind: "action", id: "notes" })} className={GHOST}>Edit<Kbd>{ACTION.notes.keys[0]}</Kbd></button></span>
    </div>;
    case "threads": return <ThreadList threads={screen.threads} run={run} />;
    case "linear": {
      const { linear } = screen;
      const states = `Tickets: ${linear.bar.map((state) => `${state.count} ${state.name}`).join(" · ")}`;
      return <div className="grid gap-1.5">
        <div data-deck-linear-line className="flex flex-wrap items-center gap-1">
          {linear.chips.map((chip) => <span key={`${chip.kind}-${chip.text}`} title={chip.kind === "label" ? "Linear label" : `Linear ${chip.kind}`}
            className={cn("inline-flex max-w-[230px] items-center gap-1 truncate rounded-md px-1.5 text-[11.5px] leading-5", chip.kind === "label" ? "text-muted-foreground" : "border border-border")}>
            {chip.kind === "label" ? "#" : <span aria-hidden className="text-[10.5px] text-muted-foreground">{chip.kind === "project" ? "▣" : "◇"}</span>}{chip.text}</span>)}
          {linear.bar.length ? <span role="img" aria-label={states} title={states} className="mx-1 inline-flex h-1.5 w-[70px] gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
            {linear.bar.map((state) => <i key={state.name} className={cn("block h-full", TONE[state.tone].bar)} style={{ flex: state.count }} />)}</span> : null}
          {linear.target ? <span title="Project target date" className="text-[11px] text-muted-foreground">{linear.target}</span> : null}
          {linear.chips.length || linear.bar.length ? null : <span className="text-[12px] text-muted-foreground">{linear.summary}</span>}
        </div>
        {linear.lines.length ? <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[12px]">{linear.lines.map(([label, value]) => <div key={label} className="contents">
          <dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl> : null}
      </div>;
    }
    case "held": {
      const held = live.filter((line) => line.section === "held");
      return <div className="grid gap-1">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><span className="flex-1">Nothing acts on a held PR until you release it.</span>
          <ActionButton id="release" on={on} run={run} label={`Release ${held.length}…`} /></div>
        <Rows prUrls={held.map((line) => line.prUrl)} kit={kit} run={run} />
      </div>;
    }
    case "all": return <Rows prUrls={live.map((line) => line.prUrl)} kit={kit} run={run} />;
  }
}

/**
 * An effort's read card: goal and summary, one PR roster with worker links, and unlinked threads.
 * Notes, Linear, progress, and effort management stay behind their controls. `notes` is the Notes editor while it's open here, and `markdown` renders notes; without it they show as plain text.
 */
export function Card({ screen, kit, open, panel, run, on, notes, markdown }: { screen: CardScreen; kit: RowKit; open: ReadonlySet<string>; panel: Panel | null;
  run: Run; on: Availability; notes?: NotesEdit | null; markdown?: (body: string) => ReactNode }) {
  const { card } = screen;
  const statuses = prStatuses(screen, kit.live);
  const toggles = ([["notes", screen.notes ? "Notes" : null], ["linear", card.linear.known ? "Linear details" : null]] as [Panel, string | null][]).filter(([, label]) => label);
  return <section data-deck-card={card.id} aria-label={card.name} className="@container min-w-0 rounded-[10px] border border-border/60 bg-background p-4">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0"><h1 tabIndex={-1} data-deck-focus="heading" className="truncate rounded text-[20px] font-semibold tracking-tight outline-none">{card.name}</h1>
        {card.goal ? <p className="mt-1 break-words text-[12.5px] text-muted-foreground">{card.goal}</p> : null}</div>
      <details className="shrink-0 text-[11.5px] text-muted-foreground"><summary className={cn("cursor-pointer rounded-sm", RING)}>Manage effort</summary>
        <div className="mt-2 grid gap-1">
          <button type="button" onClick={() => run({ kind: "archived-threads" })} className={GHOST}>Archived threads…</button>
          {card.pile === "held" ? <button type="button" onClick={() => run({ kind: "resume", id: card.id })} className={GHOST}>Resume</button>
            : card.kind === "service" ? <ActionButton id="promote" on={on} run={run} label="Promote to effort…" />
            : card.kind === "effort" && !card.oneOff ? <><ActionButton id="hold" on={on} run={run} label="Hold effort…" /><ActionButton id="complete" on={on} run={run} label="Complete effort…" /></> : <span>No effort changes</span>}
        </div>
      </details>
    </div>
    <p data-deck-summary className="mb-1 mt-5 text-[12.5px] text-muted-foreground">{effortReadSummary(screen, statuses)}</p>
    {statuses.length ? <section aria-label="Pull request status" className="mt-3 border-t border-border/50">
      <PrStatusList prs={statuses} run={run} kit={kit} />
      <p className="mt-2 text-[11px] text-muted-foreground">{plural(statuses.length, "open PR")} · Open a PR to advance it in All PRs.</p>
    </section> : <p data-deck-empty className="py-3 text-[12px] text-muted-foreground">No open PRs.</p>}
    {screen.threads.length ? <section aria-label="Thread status" className="mt-3 border-t border-border/50 pt-2">
      <details data-deck-threads open={!statuses.length || undefined}>
        <summary className={cn("cursor-pointer rounded-sm text-[12px] font-medium", RING)}>Threads <span className="text-muted-foreground">{screen.threads.length}</span>
          <span data-deck-thread-summary className="mt-0.5 block text-[11.5px] font-normal text-muted-foreground">{threadReadSummary(screen)}</span></summary>
        <div className="mt-2"><ThreadList threads={screen.threads} screen={screen} run={run} archiving={kit.archivingThread} /></div>
        <button type="button" onClick={() => run({ kind: "archived-threads" })} className={cn(GHOST, "mt-1")}>Archived threads…</button>
      </details>
    </section> : null}
    {screen.finish || toggles.length ? <div data-deck-toggles className="mt-4 border-t border-border/50 pt-2">
      {screen.finish ? <FinishLine finish={screen.finish} open={open.has("progress")} run={run} /> : null}
      <div className="flex flex-wrap gap-1">{toggles.map(([key, label]) => <button key={key} type="button" data-deck-focus={`panel-${key}`} aria-pressed={panel === key}
        onClick={() => run({ kind: "panel", key })} className={cn(GHOST, panel === key && "bg-foreground/[0.04] text-foreground")}>{label}</button>)}</div>
      {panel && toggles.some(([key]) => key === panel) ? <div data-deck-panel={panel} className="mt-2 px-1">
        <PanelBody panel={panel} screen={screen} kit={kit} on={on} run={run} notes={notes ?? null} markdown={markdown} /></div> : null}
    </div> : null}
  </section>;
}

// ---------------------------------------------------------------------------
// A service card's suggestions: where each group of its PRs could go, with one button each, and the standing rules.
// ---------------------------------------------------------------------------

export type RuleItem = { id: string; text: string };
const STRENGTH_DOTS: Record<Strength, number> = { weak: 1, moderate: 2, strong: 3 };
/** The refs a suggestion line names before it says how many more. */
const REFS = 4;
function Suggestion({ group, run }: { group: SuggestGroup; run: Run }) {
  const bar = <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: group.color }} />;
  if (group.accepted) return <div data-deck-sec={group.key} className="flex min-h-8 items-center gap-2 py-0.5 pl-1 pr-1 text-[12.5px]">
    {bar}<span className={TONE.green.text}>✓</span><span className="truncate">{group.accepted.text}</span><span className="flex-1" />
    <button type="button" data-deck-focus={`undo-group-${group.key}`} onClick={() => run({ kind: "undo-group", key: group.key })}
      className={cn("rounded px-1 text-[11.5px] text-sky-700 hover:underline dark:text-sky-300", RING)}>Undo</button>
  </div>;
  const target = group.target;
  const live = group.button.count > 0;
  const detail = group.signals.length ? group.signals.join(" · ") : group.reason;
  const more = group.lines.length - REFS;
  return <div data-deck-sec={group.key} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 pl-1 pr-1">
    {bar}
    {target ? <span className="text-[12px] text-muted-foreground">→{target.kind === "new" ? " new" : ""}</span> : null}
    {target ? <Dot color={group.color} /> : null}
    <h3 className={cn("truncate text-[12.5px]", target ? "font-semibold" : "font-medium text-muted-foreground")}>{group.title}</h3>
    {group.strength ? <span data-deck-strength={group.strength} title={`${group.strength} signals`}
      className={cn("inline-flex shrink-0 items-center gap-0.5 text-[11.5px]", group.strength === "weak" ? TONE.amber.text : "text-muted-foreground")}>
      {[1, 2, 3].map((dot) => <i key={dot} aria-hidden className={cn("inline-block size-1 rounded-full", dot <= STRENGTH_DOTS[group.strength!] ? "bg-current" : "bg-border")} />)}
      <span className="ml-1 capitalize">{group.strength}</span></span> : null}
    {/* What it rests on, before you accept it: the specific signals, or why there are none. */}
    <span data-deck-signals className="min-w-0 flex-[1_1_160px] truncate text-[11.5px] text-muted-foreground" title={detail}>{detail}</span>
    <span className="flex shrink-0 gap-1">{group.lines.slice(0, REFS).map((line) => <button key={line.prUrl} type="button" tabIndex={-1} title={`Show ${line.ref}: ${line.title}`}
      onClick={() => run({ kind: "jump", prUrl: line.prUrl })} className={cn("rounded px-1 text-[11.5px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING)}>
      {line.ref}</button>)}{more > 0 ? <span className="text-[11.5px] text-muted-foreground">+{more}</span> : null}</span>
    <button type="button" data-deck-focus={`group-${group.key}`} aria-disabled={live ? undefined : true} onClick={() => { if (live) run({ kind: "group", key: group.key }); }}
      title={group.button.kind === "pick" ? `Pick an effort for each PR (${ACTION.move.keys[0]})` : group.button.confirm ? "Weak signals: lists each PR and its signals before it moves them"
        : "Moves nothing until you press it; Undo takes it back"}
      className={cn(BUTTON, "border-border hover:bg-foreground/[0.06]")}>{group.button.label}<Kbd>{ACTION[group.button.kind === "pick" ? "move" : "accept"].keys[0]}</Kbd></button>
  </div>;
}

/** Under a service card: its suggestions, Seed from Linear, and the standing rules, which place new PRs on every read. */
export function Suggestions({ screen, rules, run }: { screen: CardScreen; rules: readonly RuleItem[]; run: Run }) {
  return <section aria-label="Suggestions" data-deck-suggest className="mb-1.5 rounded-[10px] border border-border/50 px-1.5 pb-1 pt-0.5">
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 pl-1">
      <h2 className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Suggestions</h2>
      <span className="text-[11.5px] text-muted-foreground">Nothing moves until you press it.</span>
      <span className="flex-1" />
      <button type="button" data-deck-focus="seed" onClick={() => run({ kind: "action", id: "seed" })} title="Propose one effort per Linear project on your open PRs"
        className={GHOST}>Seed from Linear…</button>
      <button type="button" data-deck-focus="rule" onClick={() => run({ kind: "action", id: "rule" })} className={GHOST}>+ Standing rule</button>
    </div>
    <RuleList rules={rules} onRemove={(id) => run({ kind: "rule-remove", id })} className="pb-1 pl-1" />
    {screen.suggest.map((group) => <Suggestion key={group.key} group={group} run={run} />)}
  </section>;
}

/** The standing rules, each with × to remove it: on a service card's suggestions, and in the rules dialog, which ⌘K reaches from any card. */
function RuleList({ rules, onRemove, className }: { rules: readonly RuleItem[]; onRemove(id: string): void; className?: string }) {
  return rules.length ? <div data-deck-rules className={cn("flex flex-wrap items-center gap-1.5 text-[12px]", className)}>
    {rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground/[0.03] px-2">{rule.text}
      <button type="button" aria-label={`Remove the rule ${rule.text}`} title="Remove this rule; the PRs it placed stay" onClick={() => onRemove(rule.id)}
        className={cn("rounded text-muted-foreground hover:text-foreground", RING)}>×</button></span>)}
  </div> : null;
}

// ---------------------------------------------------------------------------
// Chrome: the header every Workstreams view shares, the batch bar docked under the rows, and the hint bar.
// ---------------------------------------------------------------------------

const TABS = [{ id: "deck", title: "Efforts", tip: "One effort per card" }, { id: "inventory", title: "All PRs", tip: "Every open PR in one list" }] as const;
/** The views behind More ▾, which ends with How it works. */
export const MORE_VIEWS = [{ id: "map", title: "Map" }, { id: "efforts", title: "Efforts admin" }] as const;
export type HeaderView = (typeof TABS)[number]["id"] | (typeof MORE_VIEWS)[number]["id"];
/** Where a header click goes: a view, or the How this works tab. */
export type HeaderTarget = HeaderView | "how";
export type HeaderProps = {
  /** The view under the header. */
  view: HeaderView;
  /** How fresh this view's read is; `title` gives the exact times. `onRefresh`: a click reads every open PR again, except while one reads. */
  read: { text: string; error: string | null; title?: string; busy?: boolean; onRefresh?(): void };
  /** Mark seen, on a view that has it, with its key and what it settles there. */
  seen?: { changed: number; available: boolean; note: string | null; key: string; title?: string };
  /** What ⌘K opens here: this view's actions, or the views. */
  palette: "all actions" | "go to";
  /** What ? opens here. */
  help: string;
  /** The view's own controls, after More. */
  tools?: ReactNode;
  onView(target: HeaderTarget): void; onSeen?(): void; onPalette(): void; onHelp(): void;
};

/**
 * One header on every view: Efforts · All PRs · More ▾, then the same right side everywhere: freshness, Mark seen where it applies, ⌘K, and ?.
 * On a narrow panel the right side wraps to its own line as one group, so no control is cut off and freshness truncates only there.
 */
export function WorkstreamsHeader(props: HeaderProps) {
  const scope = usePortalScopeProps();
  const { read, seen } = props;
  const more = MORE_VIEWS.find((item) => item.id === props.view) ?? null;
  const go = (target: HeaderTarget) => { if (target !== props.view) props.onView(target); };
  return <header data-ws-header={props.view} className="@container flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-3 py-1">
    <nav aria-label="Workstreams views" className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
      {TABS.map((tab) => <button key={tab.id} type="button" data-deck-focus={tab.id === "deck" ? "view-deck" : "view-prs"} aria-pressed={props.view === tab.id} title={tab.tip}
        onClick={() => go(tab.id)} className={cn("h-6 px-2.5 text-[12px]", RING, props.view === tab.id ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground")}>
        {tab.title}</button>)}
    </nav>
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild><button type="button" data-ws-more aria-label={more ? `More views: ${more.title}` : "More views"}
        className={cn(GHOST, more && "bg-foreground/[0.08] text-foreground")}>{more?.title ?? "More"} ▾</button></PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...scope} align="start" sideOffset={4} className={cn("z-50 grid w-44 rounded-lg border border-border bg-popover p-1 text-[12px] shadow-md outline-none", POINTER_CURSORS)}>
          <MoreItems view={props.view} go={go} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
    {props.tools}
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <span role={read.error ? "alert" : "status"} title={read.title} className={cn("inline-flex min-w-0 items-center gap-1.5 text-[11.5px]", read.error ? "text-destructive" : "text-muted-foreground")}>
        {read.busy && !read.error ? <Icon name="Loading" className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden /> : null}
        {read.onRefresh ? <button type="button" data-ws-read disabled={read.busy} onClick={read.onRefresh} title="Read every open PR from GitHub again"
          className={cn("inline-flex min-w-0 items-center gap-1 rounded hover:text-foreground disabled:hover:text-inherit", RING)}>
          {read.busy ? null : <span aria-hidden>↻</span>}<span className="truncate">{read.error ?? read.text}</span></button>
          : <span className="truncate">{read.error ?? read.text}</span>}</span>
      {seen?.note ? <span role="status" className="shrink-0 text-[11.5px] text-muted-foreground"><span className={TONE.green.text}>✓</span> {seen.note}</span>
        : seen?.available ? <button type="button" data-deck-focus="seen" onClick={props.onSeen}
          title={seen.title ?? "Settles this view only: rows a read changed, rows that left, and rows you acted on"}
          className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-sky-500/10 px-2 text-[11.5px] text-sky-800 hover:bg-sky-500/20 dark:text-sky-200", RING)}>
          {seen.changed ? <><Changed title="Changed here" /><b>{seen.changed}</b> changed here ·</> : null} Mark seen <Kbd>{seen.key}</Kbd></button> : null}
      <button type="button" data-deck-focus="palette" onClick={props.onPalette} title={props.palette === "all actions" ? "Every action and its key (⌘K)" : "Go to a view (⌘K)"}
        className={cn(BUTTON, "border-border text-muted-foreground hover:text-foreground")}><Kbd>⌘K</Kbd><span className="hidden @min-[720px]:inline">{props.palette}</span></button>
      <button type="button" data-deck-focus="help" onClick={props.onHelp} title={`${props.help} (?)`} aria-label={`${props.help} (?)`}
        className={cn(BUTTON, "w-6 justify-center border-border px-0 text-muted-foreground hover:text-foreground")}>?</button>
    </div>
  </header>;
}

/** More ▾'s items, each closing it: the other views, the current one marked, then How it works. */
export function MoreItems({ view, go }: { view: HeaderProps["view"]; go(target: HeaderTarget): void }) {
  return <>
    {MORE_VIEWS.map((item) => <PopoverPrimitive.Close key={item.id} asChild><button type="button" data-ws-more-item={item.id} aria-current={item.id === view ? "page" : undefined}
      onClick={() => go(item.id)} className={cn("rounded px-2 py-1 text-left hover:bg-foreground/[0.06]", item.id === view && "font-medium", RING)}>{item.title}</button>
    </PopoverPrimitive.Close>)}
    <PopoverPrimitive.Close asChild><button type="button" data-ws-more-item="how" onClick={() => go("how")}
      className={cn("mt-1 rounded border-t border-border/60 px-2 py-1 text-left hover:bg-foreground/[0.06]", RING)}>How it works</button></PopoverPrimitive.Close>
  </>;
}

/** ⌘K on a view without actions of its own: every view, then How it works. */
export function viewPaletteItems(view: HeaderProps["view"]): PaletteItem[] {
  return [...[...TABS, ...MORE_VIEWS].map((item) => ({ key: item.id, group: "Go to", title: item.title, keys: [], on: item.id !== view, why: "you're here", action: null })),
    { key: "how", group: "Help", title: "How it works", keys: [], on: true, why: "", action: null }];
}

/** Refresh (N) on a selection bar: reads the selected rows from GitHub, saying how far it got. */
export function RefreshSelected({ count, busy, progress, onClick }: { count: number; busy: boolean; progress: string | null; onClick(): void }) {
  return <button type="button" data-batch-refresh disabled={busy} aria-busy={busy || undefined} onClick={onClick} title="Read the selected PRs from GitHub again"
    className={cn(BUTTON, "border-border", busy && "disabled:opacity-100")}>{busy ? <><Spin />{progress ?? "Reading…"}</> : <>Refresh ({count})<Kbd>{ACTION.refresh.keys[0]}</Kbd></>}</button>;
}

/** The few keys that matter now, or one status line, which never covers a row; ⌘K and ? stay on the right. */
/** `flash.busy`: a batch sending now, which spins beside its line. */
export function HintBar({ hints, flash, onPalette, onHelp, onUndo }: { hints: readonly [string, string][]; flash: { text: string; undo: boolean; busy?: boolean } | null;
  onPalette(): void; onHelp(): void; onUndo(): void }) {
  return <footer aria-label="Keys for what you're doing" className="@container flex h-7 shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-border/70 bg-foreground/[0.02] px-3 text-[11.5px] text-muted-foreground">
    <span role="status" className="flex min-w-0 items-center gap-3.5 overflow-hidden">
      {flash ? <span className="flex min-w-0 items-center gap-2.5 text-foreground">{flash.busy ? <Spin /> : null}<span className="truncate">{flash.text}</span>
        {flash.undo ? <button type="button" tabIndex={-1} onClick={onUndo} className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-700 hover:underline dark:text-sky-300">Undo <Kbd>z</Kbd></button> : null}</span>
        : hints.map(([keys, label], index) => <span key={keys} className={cn("inline-flex items-center gap-1.5", index >= 4 && "hidden @min-[720px]:inline-flex")}><Keys keys={keys} />{label}</span>)}
    </span>
    <span className="ml-auto flex shrink-0 gap-3">
      <button type="button" tabIndex={-1} onClick={onPalette} className="inline-flex items-center gap-1.5 hover:text-foreground"><Kbd>⌘K</Kbd>all actions</button>
      <button type="button" tabIndex={-1} onClick={onHelp} className="inline-flex items-center gap-1.5 hover:text-foreground"><Kbd>?</Kbd>keys</button>
    </span>
  </footer>;
}

// ---------------------------------------------------------------------------
// Dialog bodies. The nav view puts each in a dialog that returns focus where it came from.
// ---------------------------------------------------------------------------

/** What a confirm lists: each PR's one write, every PR it leaves out and why, and what Advance never does. */
export type ConfirmPlan = { title: string; sub: string; verb: string;
  items: readonly (Pick<BatchItem, "prUrl" | "ref" | "title" | "kind" | "what" | "notes"> & Partial<Pick<BatchItem, "feedback" | "where">>)[];
  skipped: readonly Pick<Skipped, "prUrl" | "ref" | "reason">[]; excluded: string | null; request: boolean;
  /** What happens after the window, as its footer says it: "Sends", or "Releases" for a release. */
  when?: string };
const KIND_TONE: Record<BatchItem["kind"], Tone> = { confirm: "violet", nudge: "blue", request: "blue", ready: "blue", release: "gray", ask: "violet", fix: "amber",
  address: "amber" };

/**
 * The listing confirm: nothing is written until you press its button (or ⌘↵), and then only after SEND_DELAY_MS, which Undo cancels.
 * A request can ask someone else instead of each PR's suggestion; that plans again.
 */
export function ConfirmBody({ plan, busy, error, reviewer, dirty, onReviewer, onReplan, onConfirm, onCancel }: { plan: ConfirmPlan; busy: boolean; error: string | null;
  /** The reviewer you typed differs from the one this listing asks: nothing sends until it plans again. */
  reviewer: string; dirty: boolean; onReviewer(value: string): void; onReplan(): void; onConfirm(): void; onCancel(): void }) {
  const seconds = Math.round(SEND_DELAY_MS / 1_000);
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-deck-plan className="grid max-h-[50vh] gap-2 overflow-y-auto">
      {plan.items.map((item) => <li key={`${item.kind}-${item.prUrl}`} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5">
        <span className={cn("mt-px rounded px-1.5 text-[11px] leading-[18px]", TONE[KIND_TONE[item.kind]].chip)}>{item.what}</span>
        <span className="min-w-0"><b className="font-medium">{item.ref}</b> <span className="text-muted-foreground">{item.title}</span>
          {item.feedback ? <span data-deck-feedback className="block text-[11.5px] text-muted-foreground">{[item.feedback, item.where].filter(Boolean).join(" · ")}</span> : null}</span>
      </li>)}
    </ul>
    {plan.skipped.length ? <div className="grid gap-1 border-t border-border/60 pt-2 text-[12px]"><p className="text-muted-foreground">Left out:</p>
      <ul className="grid gap-0.5">{plan.skipped.map((item) => <li key={item.prUrl}><b className="font-medium">{item.ref}</b> <span className="text-muted-foreground">{item.reason}</span></li>)}</ul></div> : null}
    {plan.excluded ? <p className="border-t border-border/60 pt-2 text-[12px] text-muted-foreground">{plan.excluded}</p> : null}
    {plan.request ? <label className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">Ask instead
      <input value={reviewer} onChange={(event) => onReviewer(event.target.value)} placeholder="login" autoComplete="off" spellCheck={false}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onReplan(); } }}
        className="h-7 w-40 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
      <button type="button" onClick={onReplan} disabled={!dirty || busy} className={cn(BUTTON, "border-border")}>Plan again</button></label> : null}
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
      <span className="mr-auto text-[11.5px] text-muted-foreground">{dirty ? "Plan again first" : `${plan.when ?? "Sends"} after ${seconds} s · Undo until then`}</span>
      <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
      <button type="button" data-deck-confirm disabled={busy || dirty || plan.items.length === 0} onClick={onConfirm}
        className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Starting…" : `${plan.verb} ${plan.items.length}`}<Kbd inverted>⌘↵</Kbd></button>
    </div>
  </div>;
}

/**
 * One PR's review notes and the evidence since them, from a fresh read, with any follow-ups that linked the PR. With evidence, Confirm
 * handled leads (⌘↵); without it, asking its thread leads (⌘↵), and Confirm anyway is a click only, recorded as confirmed without evidence.
 */
export function NotesBody({ screen, failed, busy, error, onConfirm, onAnyway, onAsk, onCancel }: { screen: NotesScreen | null;
  /** Why GitHub couldn't be read for the notes. */
  failed: string | null; busy: boolean; error: string | null; onConfirm(): void; onAnyway(): void; onAsk(): void; onCancel(): void }) {
  if (!screen) return <div className="grid gap-3 text-[12.5px]">
    <p role={failed ? "alert" : "status"} className={failed ? "text-destructive" : "text-muted-foreground"}>{failed ? `Couldn't read the notes: ${failed}` : "Reading GitHub…"}</p>
    <div className="flex justify-end border-t border-border/60 pt-2.5"><button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Close<Kbd>esc</Kbd></button></div>
  </div>;
  const lead = cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90");
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-notes className="grid max-h-[45vh] gap-2.5 overflow-y-auto">
      {screen.notes.map((note) => <li key={note.id} className="grid gap-0.5">
        <span className="text-[11.5px] text-muted-foreground">{note.who} · {note.what} · {note.age}</span>
        <p className="whitespace-pre-wrap break-words rounded-md bg-foreground/[0.03] px-2.5 py-1.5">{note.body}{note.truncated ? "…" : ""}</p>
      </li>)}
    </ul>
    <p data-notes-evidence className={cn("rounded px-2 py-1 text-[12px]", screen.evidence.handled ? "text-muted-foreground" : TONE.amber.chip)}>{screen.evidence.text}</p>
    {screen.evidence.linked ? <p data-notes-linked className="px-2 text-[12px] text-muted-foreground">{screen.evidence.linked}</p> : null}
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    {screen.primary !== "confirm" ? <p className="text-[11.5px] text-muted-foreground">{"to" in screen.ask
      ? `Ask ${screen.ask.to} · listed first, then sent after ${Math.round(SEND_DELAY_MS / 1_000)} s with Undo` : screen.ask.why}</p> : null}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-2.5">
      {screen.primary !== "confirm" ? <>
        <button type="button" data-notes-anyway disabled={busy} onClick={onAnyway} title="Records that nothing showed them handled"
          className={cn(GHOST, "h-7")}>{busy ? "Confirming…" : "Confirm anyway"}</button>
        <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
        {screen.primary === "ask" ? <button type="button" data-notes-ask disabled={busy} onClick={onAsk} className={lead}>Ask its thread to address it<Kbd inverted>⌘↵</Kbd></button> : null}
      </> : <>
        <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
        <button type="button" data-notes-confirm disabled={busy} onClick={onConfirm} className={lead}>{busy ? "Confirming…" : "Confirm handled"}<Kbd inverted>⌘↵</Kbd></button>
      </>}
    </div>
  </div>;
}

/** Hold: the effort leaves the active pile with an optional reason; its PRs stop counting until you resume it. */
export function HoldBody({ reason, onReason, busy, error, onHold, onCancel }: { reason: string; onReason(value: string): void; busy: boolean; error: string | null;
  onHold(): void; onCancel(): void }) {
  return <div className="grid gap-3 text-[12.5px]">
    <label className="grid gap-1 text-[12px] text-muted-foreground">Reason (optional)
      <input value={reason} maxLength={500} onChange={(event) => onReason(event.target.value)} placeholder="Waiting on the design review"
        className="h-8 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500" /></label>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Hold" onOk={onHold} onCancel={onCancel} />
  </div>;
}
function DialogButtons({ busy, label, onOk, onCancel, disabled }: { busy: boolean; label: string; onOk(): void; onCancel(): void; disabled?: boolean }) {
  return <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
    <button type="button" onClick={onCancel} className={cn(BUTTON, "h-7 border-border")}>Cancel<Kbd>esc</Kbd></button>
    <button type="button" data-deck-confirm disabled={busy || disabled} onClick={onOk}
      className={cn(BUTTON, "h-7 border-foreground bg-foreground font-medium text-background hover:bg-foreground/90")}>{busy ? "Working…" : label}<Kbd inverted>⌘↵</Kbd></button>
  </div>;
}

/** Complete: what is still open first. Its PRs and threads stay with it on the Done pile. */
export function CompleteBody({ screen, busy, error, onComplete, onCancel }: { screen: CardScreen; busy: boolean; error: string | null; onComplete(): void; onCancel(): void }) {
  const active = screen.threads.filter((thread) => thread.status === "active");
  return <div className="grid gap-3 text-[12.5px]">
    <ul className="grid gap-1.5">
      <li><b className="font-medium">{plural(screen.card.stats.open, "open PR")}</b> <span className="text-muted-foreground">{screen.yourTurn} your turn</span></li>
      {active.length ? <li><b className="font-medium">{plural(active.length, "active thread")}</b> <span className="text-muted-foreground">{active.map((thread) => thread.title).join(", ")}</span></li> : null}
    </ul>
    <p className="text-[12px] text-muted-foreground">Its PRs and threads stay with it on the Done pile, and stop counting. Reopen puts it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Complete" onOk={onComplete} onCancel={onCancel} />
  </div>;
}

export type RuleDraft = { kind: "ticket-prefix" | "branch" | "repo" | "stack" | "linear-project"; value: string; effortId: string; now: boolean };
export const RULE_WORDS: Record<RuleDraft["kind"], string> = { "ticket-prefix": "Ticket prefix", branch: "Branch", repo: "Repo", stack: "Stacked on a PR in an effort",
  "linear-project": "Linear project" };
/**
 * The standing rules, each with × to remove it, then a new one: a standing rule places new PRs on every read; `now` also moves the open
 * PRs it matches today, which the preview counts.
 */
export function RuleBody({ draft, efforts, rules, matches, busy, error, onDraft, onAdd, onRemove, onCancel }: { draft: RuleDraft;
  efforts: readonly { id: string; name: string }[]; rules: readonly RuleItem[]; matches: number | null; busy: boolean; error: string | null;
  onDraft(draft: RuleDraft): void; onAdd(): void; onRemove(id: string): void; onCancel(): void }) {
  const field = "h-8 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return <div className="grid gap-3 text-[12.5px]">
    <RuleList rules={rules} onRemove={onRemove} />
    <div className="flex flex-wrap items-center gap-2">Always put
      <select aria-label="Rule kind" value={draft.kind} onChange={(event) => onDraft({ ...draft, kind: event.target.value as RuleDraft["kind"] })} className={field}>
        {Object.entries(RULE_WORDS).map(([kind, word]) => <option key={kind} value={kind}>{word}</option>)}</select>
      {draft.kind === "stack" ? null : <input aria-label="Rule value" value={draft.value} onChange={(event) => onDraft({ ...draft, value: event.target.value })}
        placeholder={draft.kind === "branch" ? "billing/*" : draft.kind === "repo" ? "inkwell/folio" : draft.kind === "linear-project" ? "Reading lists" : "ABC"}
        className={cn(field, "w-36", draft.kind !== "linear-project" && "font-mono")} />}
      {draft.kind === "stack" ? "with its base" : <>in <select aria-label="Effort" value={draft.effortId} onChange={(event) => onDraft({ ...draft, effortId: event.target.value })} className={field}>
        {efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</select></>}
    </div>
    <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.now} onChange={(event) => onDraft({ ...draft, now: event.target.checked })} />
      Also move the {matches === null ? "open PRs" : plural(matches, "open PR")} it matches now</label>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Add rule" onOk={onAdd} onCancel={onCancel} disabled={draft.kind !== "stack" && !draft.value.trim()} />
  </div>;
}

/** A new effort from chosen PRs: its name and goal, and the PRs it takes. */
export function NewEffortBody({ name, goal, refs, busy, error, onName, onGoal, onCreate, onCancel }: { name: string; goal: string; refs: readonly string[]; busy: boolean;
  error: string | null; onName(value: string): void; onGoal(value: string): void; onCreate(): void; onCancel(): void }) {
  const field = "h-8 rounded-md border border-input bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return <div className="grid gap-3 text-[12.5px]">
    <label className="grid gap-1 text-[12px] text-muted-foreground">Name<input value={name} maxLength={120} onChange={(event) => onName(event.target.value)} className={field} /></label>
    <label className="grid gap-1 text-[12px] text-muted-foreground">Goal (optional)<input value={goal} maxLength={500} onChange={(event) => onGoal(event.target.value)}
      placeholder="What's true when it's done" className={field} /></label>
    <p className="text-[12px] text-muted-foreground">Takes {refs.join(", ")}. The card joins the end of the pile; Undo takes it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label="Create effort" onOk={onCreate} onCancel={onCancel} disabled={!name.trim()} />
  </div>;
}

/**
 * Seed from Linear: one proposed effort per Linear project on your open PRs. Nothing is picked until you check it, each shows how many of
 * its PRs it would take and which effort it may duplicate, and Create makes only the ones you checked.
 */
export function SeedBody({ proposals, keyed, picked, busy, error, onPick, onCreate, onCancel }: { proposals: readonly SeedProposal[] | null; keyed: boolean;
  picked: ReadonlySet<string>; busy: boolean; error: string | null; onPick(projectId: string): void; onCreate(): void; onCancel(): void }) {
  const free = (proposal: SeedProposal) => proposal.prs.filter((pr) => !pr.effort).length;
  const MATCH = { name: "has its name", members: "owns", seed: "was seeded from it" } as const;
  return <div className="grid gap-3 text-[12.5px]">
    {proposals === null ? <p role="status" className="text-muted-foreground">Reading Linear projects…</p>
      : !proposals.length ? <p className="text-muted-foreground">{keyed ? "No Linear project has tickets on your open PRs yet. Projects show after the next scan reads Linear."
        : "No Linear API key is set. Add one under Linear API keys in the Workstreams settings."}</p>
      : <ul data-deck-seed className="grid max-h-[50vh] gap-1 overflow-y-auto">{proposals.map((proposal) => {
        const count = free(proposal);
        // Create skips a project an effort has the name of or was seeded from, so it can't be checked.
        const exists = proposal.matches.some((match) => match.by !== "members");
        return <li key={proposal.projectId}><label className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md px-1.5 py-1",
          count && !exists ? "hover:bg-foreground/[0.04]" : "opacity-60")}>
          <input type="checkbox" checked={picked.has(proposal.projectId)} disabled={!count || exists} onChange={() => onPick(proposal.projectId)} className="mt-[3px]" />
          <span className="min-w-0"><b className="font-medium">{proposal.name}</b>{proposal.goal ? <span className="block truncate text-[12px] text-muted-foreground"
            title={proposal.goal}>{proposal.goal}</span> : null}
            {proposal.matches.map((match) => <span key={`${match.by}-${match.id}`} className={cn("block text-[11.5px]", TONE.amber.text)}>
              {match.name} {MATCH[match.by]}{match.by === "members" ? ` ${match.prs} of its PRs` : ""}</span>)}</span>
          <span className="whitespace-nowrap text-[11.5px] text-muted-foreground" title={proposal.prs.map((pr) => `${pr.repo.split("/").at(-1)} #${pr.number}`).join(", ")}>
            {exists ? "already exists" : count ? `takes ${count} of ${plural(proposal.prs.length, "PR")}` : "all in efforts"}</span>
        </label></li>;
      })}</ul>}
    <p className="text-[12px] text-muted-foreground">Each takes only PRs no effort owns. It never syncs with Linear after; Undo takes it back.</p>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label={picked.size ? `Create ${plural(picked.size, "effort")}` : "Create"} onOk={onCreate} onCancel={onCancel} disabled={!picked.size} />
  </div>;
}

/** A weak suggestion asks before it moves anything: each PR with the signals behind it, then one button. */
export function WeakBody({ lines, label, busy, error, onAccept, onCancel }: { lines: readonly Pick<DeckLine, "prUrl" | "ref" | "title" | "signals">[]; label: string;
  busy: boolean; error: string | null; onAccept(): void; onCancel(): void }) {
  return <div className="grid gap-3 text-[12.5px]">
    <ul data-deck-weak className="grid max-h-[50vh] gap-1.5 overflow-y-auto">{lines.map((line) => <li key={line.prUrl} className="min-w-0">
      <b className="font-medium">{line.ref}</b> <span className="text-muted-foreground">{line.title}</span>
      <span className="block truncate text-[11.5px] text-muted-foreground">{line.signals.length ? line.signals.join(" · ") : "No signal of its own; it goes with its group"}</span>
    </li>)}</ul>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    <DialogButtons busy={busy} label={label} onOk={onAccept} onCancel={onCancel} />
  </div>;
}

/** Move: the efforts a PR can join, One-offs, or a new effort from these. */
export function MoveBody({ refs, efforts, busy, error, onMove, onNew }: { refs: readonly string[]; efforts: readonly { id: string; name: string; color: string; open: number }[];
  busy: boolean; error: string | null; onMove(effortId: string): void; onNew(): void }) {
  return <div className="grid gap-1 text-[12.5px]">
    <p className="mb-1 text-[12px] text-muted-foreground">{refs.join(", ")}</p>
    {efforts.map((effort) => <button key={effort.id} type="button" disabled={busy} onClick={() => onMove(effort.id)}
      className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/[0.06]", RING)}>
      <Dot color={effort.color} />{effort.name}<span className="ml-auto text-[11px] text-muted-foreground">{effort.open} open</span></button>)}
    <button type="button" disabled={busy} onClick={onNew} className={cn("mt-1 flex items-center gap-2 border-t border-border/60 px-2 pb-1 pt-2 text-left hover:bg-foreground/[0.04]", RING)}>
      <span className="text-muted-foreground">+</span>New effort from {refs.length > 1 ? "these" : "this"}…</button>
    {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
  </div>;
}

/** ⌘K: every action with its key, grayed with why where it can't run; ↑ ↓ choose, ↵ runs. */
export function PaletteBody({ query, items, highlight, onQuery, onRun, onHighlight }: { query: string; items: readonly PaletteItem[]; highlight: number;
  onQuery(value: string): void; onRun(item: PaletteItem): void; onHighlight(index: number): void }) {
  const live = items.filter((item) => item.on);
  let group: string | null = null;
  return <div className="grid text-[12.5px]">
    <input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Type an action or a key…" aria-label="Filter actions" autoComplete="off" spellCheck={false}
      className="h-10 border-b border-border bg-transparent px-3.5 text-[14px] outline-none" />
    <div role="listbox" aria-label="Actions" className="max-h-[min(460px,60vh)] overflow-y-auto px-1.5 pb-1.5 pt-1">
      {items.length ? items.map((item) => {
        const head = item.group !== group ? (group = item.group) : null;
        const index = live.indexOf(item);
        return <div key={item.key}>
          {head ? <p className="px-2 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">{head}</p> : null}
          <button type="button" role="option" tabIndex={-1} aria-selected={item.on && index === highlight} aria-disabled={item.on ? undefined : true}
            onMouseMove={() => { if (item.on) onHighlight(index); }} onClick={() => { if (item.on) onRun(item); }}
            className={cn("flex min-h-7 w-full items-center gap-2.5 rounded-md px-2 text-left", item.on ? "text-foreground/90" : "cursor-default text-muted-foreground/70",
              item.on && index === highlight && "bg-foreground/[0.07] text-foreground shadow-[inset_2px_0_0_theme(colors.sky.500)]")}>
            <span>{item.title}</span>{item.on ? null : <span className="text-[11px] text-muted-foreground/80">· {item.why}</span>}
            <span className="flex-1" />{item.keys.length ? <Keys keys={item.keys.join(" ")} /> : null}
          </button>
        </div>;
      }) : <p className="py-6 text-center text-muted-foreground">No matching action.</p>}
    </div>
    <p className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11.5px] text-muted-foreground"><span><Keys keys="↑ ↓" /> choose</span><span><Kbd>↵</Kbd> run</span>
      <span><Kbd>esc</Kbd> close</span><span className="ml-auto">{live.length} of {items.length} available here</span></p>
  </div>;
}

/** ?: every key by group, grayed where it doesn't apply here, then what the colors mean and how writes stay safe. */
export function HelpBody({ items }: { items: readonly PaletteItem[] }) {
  const keyed = items.filter((item) => item.action && item.keys.length);
  return <div className="grid gap-4 text-[12px]">
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-3.5">
      {KEY_GROUPS.map((group) => { const list = keyed.filter((item) => item.group === group); return list.length ? <div key={group}>
        <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1">{list.map((item) => <div key={item.key} className="contents">
          <dt><Keys keys={item.keys.join(" ")} /></dt><dd className={item.on ? "" : "text-muted-foreground/70"}>{item.title}</dd></div>)}</dl>
      </div> : null; })}
    </div>
    <div className="grid gap-1.5 border-t border-border/60 pt-3">
      <h3 className="text-[11px] font-medium">Reading and advancing</h3>
      <p className="text-muted-foreground">Overview triages efforts. Cards show exact PR and worker states. Open a PR in All PRs to advance it, or open its linked thread to answer it.</p>
      <p className="text-muted-foreground">Address starts one thread for the rows you leave ticked, with {Math.round(SEND_DELAY_MS / 1_000)} s to Undo. Every other GitHub
        write lists each PR first, then waits the same with Undo. Merges run only from the fresh preview, on a click or ⌘↵.</p>
    </div>
  </div>;
}
/** The rule rankMoves follows, as ? says it: each rank, its keys, and its color. */
const RANK: readonly [string, string, Tone][] = [["Someone waits on you", "b", "amber"], ["One step from merged", "m c", "green"], ["Your blockers", "f", "blue"],
  ["A reviewer holds it 4+ days", "n", "gray"], ["Linear and GitHub disagree", "", "gray"]];

// ---------------------------------------------------------------------------
// The whole deck.
// ---------------------------------------------------------------------------

export function Overview({ screen, run, live }: { screen: OverviewScreen; run: Run; live?: LiveItems; kit?: RowKit }) {
  const needs = (item: CardScreen) => item.yourTurn + item.threads.filter((thread) => ["Needs you", "Failed"].includes(threadStatus(thread).text)).length;
  const active = [...screen.cards].sort((a, b) => needs(b) - needs(a));
  const tile = (item: CardScreen, held = false) => {
    const prs = prStatuses(item, live);
    const needingResponse = new Set(item.lines.filter((l) => l.row?.turn.list === "turn" || l.row?.section === "merge" && !l.dim && !l.row.waitsOn && l.row.stackedOn === null).map((l) => l.prUrl));
    const attention = prs.filter((pr) => needingResponse.has(pr.prUrl) || pr.held || pr.advance || pr.thread && ["Needs you", "Failed"].includes(pr.thread.status.text));
    const threads = item.threads.filter((thread) => ["Needs you", "Failed"].includes(threadStatus(thread).text));
    const linked = new Set(attention.flatMap((pr) => pr.thread ? [pr.thread.id] : []));
    return <section key={item.card.id} data-deck-overview-effort={item.card.id} aria-label={item.card.name}
      className="min-w-0 rounded-[10px] border border-border/60 bg-background p-4">
      <button type="button" data-deck-focus={`overview-effort-${item.card.id}`} onClick={() => run(held ? { kind: "pile", pile: "hold" } : { kind: "go", id: item.card.id })}
        className={cn("flex w-full min-w-0 items-center justify-between gap-3 rounded-sm text-left hover:underline", RING)}>
        <strong className="truncate text-[15px] font-semibold">{item.card.name}</strong><span aria-hidden className="text-muted-foreground">→</span>
      </button>
      <p data-deck-summary className="mb-3 mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{effortReadSummary(item, prs)}</p>
      {attention.length ? <div className="border-t border-border/40"><PrStatusList prs={attention} run={run} /></div> : null}
      {threads.filter((thread) => !linked.has(thread.id)).length ? <ThreadList threads={threads.filter((thread) => !linked.has(thread.id))} screen={item} run={run} /> : null}
      <p className="mt-2 text-[11px] text-muted-foreground">{plural(prs.length, "open PR")}{item.stats.mergedWeek ? ` · ${item.stats.mergedWeek} merged this week` : ""}</p>
    </section>;
  };
  return <section data-deck-overview aria-label="Overview">
    <h1 data-deck-focus="heading" tabIndex={-1} className={cn("mb-1 text-[20px] font-semibold tracking-tight", RING)}>Your workstreams</h1>
    <p className="mb-5 text-[12.5px] text-muted-foreground">{active.some((item) => needs(item)) ? "Efforts needing your attention come first." : "Open an effort to see its PRs and threads."}</p>
    {active.length ? <div className="grid items-start gap-3 @min-[680px]:grid-cols-2">{active.map((item) => tile(item))}</div> : <p className="text-[12px] text-muted-foreground">No active efforts yet.</p>}
    {screen.held?.length ? <section data-deck-overview-held aria-label="Held efforts" className="mt-5">
      <h2 className="mb-2 text-[13px] font-medium">Efforts on hold</h2><div className="grid items-start gap-3 @min-[680px]:grid-cols-2">{screen.held.map((item) => tile(item, true))}</div>
    </section> : null}
    {screen.other?.length ? <section aria-label="Repository and loose work" className="mt-5">
      <h2 className="mb-2 text-[13px] font-medium">Repository & loose work</h2><div className="grid items-start gap-3 @min-[680px]:grid-cols-2">{screen.other.map((item) => tile(item))}</div>
    </section> : null}
  </section>;
}

export type DeckPaneProps = {
  chips: readonly Chip[]; cur: string | null;
  /** The card shown; null before the first read, on Overview, or when nothing is open. */
  card: CardScreen | null; rules: readonly RuleItem[];
  /** Overview's panels while it shows; null before the first read. */
  overview?: OverviewScreen | null;
  held: readonly Pile[]; done: readonly Pile[];
  read: HeaderProps["read"];
  seen: { changed: number; available: boolean; note: string | null };
  /** What the card's rows draw from; the moves and chores you opened or folded, and its finish line's expand ("progress"); and its open panel. */
  kit: RowKit; open: ReadonlySet<string>; panel: Panel | null; pile: "hold" | "done" | null;
  /** The card a flip landed on, said once to screen readers; empty otherwise. */
  announce?: string;
  on: Availability; hints: readonly [string, string][]; flash: { text: string; undo: boolean; busy?: boolean } | null;
  run: Run; onPalette(): void; onHelp(): void; onUndo(): void;
  rootRef?: RefObject<HTMLDivElement | null>; scrollerRef?: RefObject<HTMLDivElement | null>; slackRef?: RefObject<HTMLDivElement | null>;
  chipsRef?: RefObject<HTMLDivElement | null>; viewRef?: RefObject<HTMLDivElement | null>;
  /** The Notes editor while it's open on the card shown, and what renders notes as Markdown. */
  notes?: NotesEdit | null; markdown?: (body: string) => ReactNode;
};

export function DeckPane(props: DeckPaneProps) {
  const { card } = props;
  const behind = cardsBehind(props.chips, props.cur);
  return <div ref={props.rootRef} role="region" aria-label="Effort deck" className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground", POINTER_CURSORS)}>
    <WorkstreamsHeader view="deck" read={props.read} seen={{ ...props.seen, key: "s" }} palette="all actions" help="Keys and colors" onView={(view) => props.run({ kind: "view", view })}
      onSeen={() => props.run({ kind: "action", id: "seen" })} onPalette={props.onPalette} onHelp={props.onHelp} />
    <Strip chips={props.chips} cur={props.cur} deck held={props.held} done={props.done} pile={props.pile} run={props.run} chipsRef={props.chipsRef} />
    <div ref={props.scrollerRef} data-deck-scroller className="@container relative min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
      <div ref={props.slackRef} aria-hidden data-deck-slack />
      <div ref={props.viewRef} className={CONTENT}>
        {props.cur === "overview" && props.overview ? <Overview screen={props.overview} run={props.run} live={props.kit?.live} kit={props.kit} />
          : card ? <><Stack behind={behind} run={props.run}><Card screen={card} kit={props.kit} open={props.open} panel={props.panel} run={props.run} on={props.on}
            notes={props.notes} markdown={props.markdown} /></Stack>
            {card.suggest.length ? <details className="mt-3 text-[12px] text-muted-foreground"><summary className={cn("cursor-pointer rounded-sm", RING)}>Grouping suggestions</summary><Suggestions screen={card} rules={props.rules} run={props.run} /></details> : null}</>
          : <p role="status" className="py-8 text-center text-[12px] text-muted-foreground">{props.read.error ? "Couldn't read the deck." : "Reading your efforts…"}</p>}
      </div>
    </div>
    <HintBar hints={props.hints} flash={props.flash} onPalette={props.onPalette} onHelp={props.onHelp} onUndo={props.onUndo} />
    <p role="status" data-deck-announce className="sr-only">{props.announce}</p>
  </div>;
}
