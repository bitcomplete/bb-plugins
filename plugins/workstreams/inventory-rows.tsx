import type { ReactNode } from "react";
import { sendable, type InventoryLine, type LineAction, type RowSuggestion } from "./inventory-view-model";
import { BUTTON, CHECKBOX, GROUP_CARD, PrRef, RING, Spin, TONE, WORKING_ROW } from "./deck-screen";
import type { LiveItems } from "./deck-flow";
import type { TicketChip } from "./deck-view-model";
import { sentText, type Sent } from "./your-turn";
import { cn } from "./lib/utils";

export type SimpleGroup = { key: string; label: string; effortId: string | null; lines: InventoryLine[] };
export type SimpleRowsProps = {
  groups: SimpleGroup[];
  renderActions?(line: InventoryLine): ReactNode;
  /** Your turn rows show why, select, and dismiss; dismissed ones show why and come back; other rows their state, and select. Any row links its sent thread. */
  kind: "turn" | "dismissed" | "other";
  busyKey: string | null;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenEffort(effortId: string): void;
  onNudge(line: InventoryLine, action: LineAction): void;
  /**
   * Rows you selected, by PR, and a click on one's checkbox; Shift takes the range from the last one you clicked. A Your turn row takes one
   * only while Address can take it; any other open row always does, to move.
   */
  selected?: ReadonlySet<string>;
  onSelect?(line: InventoryLine, shift: boolean): void;
  /** Why the last Address didn't send a PR, by PR. */
  notes?: ReadonlyMap<string, string>;
  /** Dismiss a Your turn row, or bring a dismissed one back. */
  onDismiss?(line: InventoryLine, dismiss: boolean): void;
  /** Take back a batch still in its Undo window. */
  onUndo?(batchId: string): void;
  /** Rows a batch call is planning now; and each item of a batch sending now, by PR. */
  working?: ReadonlySet<string>; live?: LiveItems;
  /** ↻ on a row reads it from GitHub again; the rows reading now spin. */
  onRefresh?(line: InventoryLine): void; reading?: ReadonlySet<string>;
  /** A deck card's ticket chip for each row, by PR, with its Linear priority. */
  tickets?: ReadonlyMap<string, TicketChip>;
  /** The classifier's suggestion for each row no effort owns, by PR; accept some rows' suggestions, or hide one row's. */
  suggestions?: ReadonlyMap<string, RowSuggestion>; onAccept?(lines: InventoryLine[]): void; onDismissSuggestion?(line: InventoryLine): void;
};
const CHIP = "inline-flex h-5 min-w-0 max-w-72 items-center gap-1 rounded px-1.5 text-[11px]";
/** One PR's row, taller than the deck's: the PR in its own column, then the title on a line of its own with the why, chips, and action under it. */
const TWO_LINE_ROW = "flex items-start gap-2 py-1 pl-2 pr-1.5 text-[12.5px] leading-5";

const SENT_TONE: Record<Sent["state"], keyof typeof TONE> = { sending: "gray", refused: "red", working: "blue", "needs-you": "amber", failed: "red", idle: "gray" };
/** A sent PR's link to its thread with BB's status for it, grey off Your turn; Sending's is Undo instead, and a refusal says why. */
function SentChip({ sent, quiet, onOpenThread, onUndo }: { sent: Sent; quiet: boolean; onOpenThread(id: string): void; onUndo?(batchId: string): void }) {
  const text = sentText(sent);
  const tone = TONE[quiet ? "gray" : SENT_TONE[sent.state]].chip;
  if (sent.state === "sending") return <span data-inventory-sent="sending" className={cn(CHIP, tone)}>Sending
    {sent.batchId && onUndo ? <> · <button type="button" onClick={() => onUndo(sent.batchId!)} className={cn("rounded-sm font-medium underline", RING)}>Undo</button></> : null}</span>;
  return sent.threadId ? <button type="button" data-inventory-sent={sent.state} onClick={() => onOpenThread(sent.threadId!)} title={`${text} · open “${sent.title ?? "its batch thread"}”`}
    className={cn(CHIP, tone, "hover:underline", RING)}><span className="truncate">{text}</span><span aria-hidden>↗</span></button>
    : <span role={sent.state === "refused" ? "alert" : undefined} data-inventory-sent={sent.state} title={text} className={cn(CHIP, tone)}><span className="truncate">{text}</span></span>;
}
/** A sending batch's item on its row: queued, sending, then what it came to. */
const LIVE: Record<NonNullable<ReturnType<LiveItems["get"]>>["state"], { text: string; tone: keyof typeof TONE }> = { pending: { text: "Queued", tone: "gray" },
  sending: { text: "Sending…", tone: "blue" }, sent: { text: "Sent", tone: "green" }, refused: { text: "Not sent", tone: "red" }, unknown: { text: "May not have sent", tone: "red" } };

export function SimpleInventoryList(props: SimpleRowsProps) {
  // Each group's rows in a card under its title, two lines a row, with no rules between them.
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 pb-1.5 pt-0.5">
    {props.groups.map((group) => { const suggested = props.onAccept ? group.lines.filter((line) => props.suggestions?.has(line.prUrl)) : []; return <section key={group.key}
      data-inventory-group={group.label} className="min-w-0">
      {/* A deck card's move names its rows itself, so their group has no title. Several suggestions here take one click together. */}
      {group.label ? <h3 className="ml-9 flex flex-wrap items-center gap-x-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
        {group.effortId ? <button type="button" onClick={() => props.onOpenEffort(group.effortId!)} className={cn("rounded-sm hover:text-foreground hover:underline", RING)}>{group.label}</button> : group.label}
        {suggested.length > 1 ? <button type="button" data-inventory-action="accept-all" onClick={() => props.onAccept!(suggested)}
          title={`Put each in its suggested effort: ${[...new Set(suggested.map((line) => props.suggestions!.get(line.prUrl)!.name))].join(", ")}`}
          className={cn("rounded-sm font-normal hover:text-foreground hover:underline", RING)}>Accept all suggestions ({suggested.length})</button> : null}
      </h3> : null}
      {/* The card's edge lines up with the section's title, which keeps its rows where they were, under the group's title. */}
      <ul className={cn("ml-[19px] list-none", GROUP_CARD)}>
        {group.lines.map((line) => {
          const nudge = line.actions.find((action) => action.id === "nudge" && action.enabled);
          const next = line.steps[0];
          const turn = props.kind !== "other" ? line.yourTurn : null;
          const mine = props.kind === "turn";
          const info = turn ? `${turn.why}${turn.age ? ` · ${turn.age}` : ""}` : `${line.status}${next ? ` · ${next.text}${next.age ? ` · ${next.age}` : ""}` : ""}`;
          const picked = !!props.selected?.has(line.prUrl);
          // One thing beside it: a batch sending it now, why the last Address didn't send it, its sent thread, or, off Your turn, its Nudge.
          const note = mine ? props.notes?.get(line.prUrl) ?? null : null;
          const sent = note ? { state: "refused" as const, threadId: null, title: null, detail: note, batchId: null } : mine || line.sent?.threadId ? line.sent : null;
          const live = mine ? props.live?.get(line.prUrl) ?? null : null;
          const working = mine && !!props.working?.has(line.prUrl);
          const refresh = props.onRefresh ? line.actions.find((action) => action.id === "refresh") : undefined;
          const reading = !!props.reading?.has(line.prUrl);
          const box = props.kind !== "dismissed" && !!props.onSelect;
          const ticket = props.tickets?.get(line.prUrl);
          const suggestion = props.onAccept ? props.suggestions?.get(line.prUrl) : undefined;
          return <li key={line.prUrl} data-inventory-row={`${line.slug}#${line.number}`} data-inventory-selected={picked || undefined} tabIndex={-1}
            data-inventory-working={working || undefined} aria-busy={working || undefined}
            className={cn("group min-w-0 rounded-md hover:bg-foreground/[0.03] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
              picked && "bg-sky-500/[0.07]", working && WORKING_ROW)}>
            <div className={TWO_LINE_ROW}>
              {box ? !mine || sendable(line) ? <input type="checkbox" tabIndex={-1} checked={picked} aria-label={`Select ${line.slug}#${line.number}`}
                onChange={() => undefined} onClick={(event) => props.onSelect!(line, event.shiftKey)} className={cn(CHECKBOX, "mt-[3px]")} />
                : <span aria-hidden className="size-3.5 shrink-0" /> : null}
              <PrRef repo={line.repo} number={line.number} strong={mine || !!nudge} onClick={() => props.onOpenPr(line.prUrl)} />
              <div className="min-w-0 flex-1">
                <p className={cn("whitespace-normal break-words @min-[720px]:truncate", mine || nudge ? "text-foreground" : "text-foreground/80")} title={line.title}>{line.title}</p>
                {/* Why, then the chips and action at its right; in a narrow pane they wrap under it rather than cut it short. */}
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="min-w-0" title={info}>{info}</span>
                  <span className="ml-auto flex min-w-0 max-w-full items-center gap-1.5">
                    {suggestion ? <span data-inventory-suggestion={suggestion.name} className={cn(CHIP, "gap-0 border border-dashed border-border px-0 text-muted-foreground")}>
                      <button type="button" tabIndex={-1} data-inventory-action="accept" onClick={() => props.onAccept!([line])} title={suggestion.reason}
                        aria-label={`Put it in ${suggestion.name}: ${suggestion.reason}`} className={cn("min-w-0 truncate rounded-l px-1 hover:text-foreground", RING)}>→ {suggestion.name}?</button>
                      {props.onDismissSuggestion ? <button type="button" tabIndex={-1} data-inventory-action="dismiss-suggestion" onClick={() => props.onDismissSuggestion!(line)}
                        aria-label={`Hide the suggestion of ${suggestion.name}`} title="Hide this suggestion" className={cn("shrink-0 rounded-r px-1 hover:text-foreground", RING)}>×</button> : null}
                    </span> : null}
                    {ticket ? <span data-inventory-ticket={ticket.text} title={ticket.title} className={cn(CHIP, "shrink-0 px-1 text-muted-foreground")}>
                      {ticket.glyph ? <span aria-hidden className={cn("text-[10px] font-bold leading-none", TONE[ticket.tone].text)}>{ticket.glyph}</span> : null}
                      <span className="truncate">{ticket.text}</span></span> : null}
                    {refresh ? <button type="button" tabIndex={-1} data-inventory-action="refresh" disabled={reading || !refresh.enabled} aria-busy={reading || undefined}
                      aria-label={reading ? `Reading ${line.slug}#${line.number} from GitHub` : refresh.title} title={reading ? "Reading GitHub now…" : refresh.why ?? `${refresh.title} (g)`}
                      onClick={() => props.onRefresh!(line)} className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:hover:bg-transparent",
                        RING, reading ? "text-sky-700 dark:text-sky-300" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
                      <span aria-hidden className={cn("inline-block leading-none", reading && "motion-safe:animate-spin")}>↻</span></button> : null}
                    {turn && props.onDismiss ? <button type="button" tabIndex={-1} data-inventory-action={mine ? "dismiss" : "undismiss"} onClick={() => props.onDismiss!(line, mine)}
                      title={mine ? "Hide until the head moves or someone says something new" : "Back on Your turn"}
                      className={cn("shrink-0 rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", RING,
                        mine && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>{mine ? "Dismiss" : "Undismiss"}</button> : null}
                    {live ? <span data-inventory-live={live.state} className={cn(CHIP, TONE[LIVE[live.state].tone].chip)}>{live.state === "sending" ? <Spin /> : null}{LIVE[live.state].text}</span>
                      : sent ? <SentChip sent={sent} quiet={!mine} onOpenThread={props.onOpenThread} onUndo={props.onUndo} />
                      : nudge && !props.renderActions ? <button type="button" data-inventory-action="nudge" disabled={props.busyKey === line.prUrl} onClick={() => props.onNudge(line, nudge)}
                      title={nudge.title} className={cn(BUTTON, "h-5 border-border px-1.5 text-[11px] hover:bg-foreground/[0.06]")}>{nudge.label}</button> : null}
                  </span>
                </div>
              </div>
            </div>
            {props.renderActions ? <div className={cn("pb-2 pr-1.5", box ? "pl-[30px]" : "pl-2")}>{props.renderActions(line)}</div> : null}
            {/* The last action's outcome, word for word, under the line rather than truncated in it. */}
            {line.last ? <p role="status" className={cn("pb-1.5 pr-1.5 text-[11px]", box ? "pl-[30px]" : "pl-2", line.last.ok ? "text-muted-foreground" : "text-destructive")}>{line.last.text}</p> : null}
          </li>;
        })}
      </ul>
    </section>; })}
  </div>;
}
