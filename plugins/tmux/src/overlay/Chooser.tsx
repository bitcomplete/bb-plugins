import {
  experimental_useSidebarThreads,
  useBbContext,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import { cn } from "../../lib/utils";
import { getUiState, showNotice, updateUiState } from "../bridge";
import { buildChooserItems } from "../chooser-model";
import { isMacPlatform } from "../bb-commands";
import { PLUGIN_ID } from "../constants";
import { CHOOSER_FILTER_KEY } from "../keymap";
import {
  formatStroke,
  isCompositionKey,
  keyStrokeFromEvent,
  terminalKeyOf,
  typedCharacterFromEvent,
  type KeyEventLike,
} from "../keys";
import { LIST_KEYS, shortListKey, type ListCommand } from "../list-keys";
import { openNewThreadInSplit } from "../new-thread";
import { openThread } from "../open-thread";
import type {
  ChooserItem,
  ChooserState,
  Keymap,
  ListSplitKeys,
  Placement,
  SplitPlacement,
} from "../types";
import {
  focusNextTabStop,
  giveFocusBack,
  useCompactAutoFocus,
  useFocusWhenReopened,
  useOpeningKey,
  useReturnFocus,
  useUiState,
} from "./hooks";
import { useDialogPositionStyle } from "./native-views";

type MoveTarget =
  | "next"
  | "previous"
  | "page-up"
  | "page-down"
  | "first"
  | "last";

type KeyHandler = (event: KeyboardEvent<HTMLElement>) => void;

// list goes back from the filter field to the list, and next-field moves the
// cursor as Tab does.
type ChooserCommand =
  | { type: "move"; to: MoveTarget }
  | { type: "open"; placement: SplitPlacement | null }
  | { type: "new-thread" }
  | { type: "filter" }
  | { type: "list" }
  | { type: "next-field" }
  | { type: "close" };

// The keys of thread rows carry a prefix, so no thread id can collide with
// the key of the New thread row.
type ChooserRow =
  | { kind: "new-thread"; key: string }
  | { kind: "thread"; key: string; item: ChooserItem };

const NEW_THREAD_ROW: ChooserRow = { kind: "new-thread", key: "new-thread" };

const CLOSED: ChooserState = { open: false };

const NO_SPLIT_KEYS: ListSplitKeys = { right: [], down: [], newThread: [] };

const MAX_WIDTH_PX = 640;
const CONTENT_CLASS =
  "top-[12%] max-w-[640px] translate-y-0 gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-lg sm:rounded-xl";

const HEADINGS: Record<Placement, string> = {
  replace: "Enter opens the thread in this pane",
  right: "Enter opens the thread in a new pane to the right",
  down: "Enter opens the thread in a new pane below",
};

const NEW_THREAD_HEADINGS: Record<SplitPlacement, string> = {
  right: "Enter starts a new thread in a new pane to the right",
  down: "Enter starts a new thread in a new pane below",
};

const FILTER_HINT =
  "Type to filter · Up/Down move · Enter open · Esc back to the list";
const NEW_THREAD_FILTER_HINT =
  "Type to filter · Up/Down move · Enter new thread · Esc back to the list";
const NEW_THREAD_LABEL = "New thread";
const NO_THREADS_TEXT = "No threads to show";
const NO_MATCHES_TEXT = "No matching threads";
const FALLBACK_PAGE_ROWS = 10;

const CHOOSER_LIST_COMMANDS: Record<ListCommand, ChooserCommand> = {
  previous: { type: "move", to: "previous" },
  next: { type: "move", to: "next" },
  "page-up": { type: "move", to: "page-up" },
  "page-down": { type: "move", to: "page-down" },
  first: { type: "move", to: "first" },
  last: { type: "move", to: "last" },
  choose: { type: "open", placement: null },
  leave: { type: "close" },
};

// The list keys of tmux that are no typed character and that a text field
// has no use of its own for. Escape goes back to the list from there.
const FILTER_FIELD_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "C-n",
  "ArrowUp",
  "C-p",
  "PageDown",
  "PageUp",
  "Enter",
]);

function listCommandEntries(
  isUsed: (key: string) => boolean,
): [string, ChooserCommand][] {
  return [...LIST_KEYS]
    .filter(([key]) => isUsed(key))
    .map(([key, command]) => [key, CHOOSER_LIST_COMMANDS[command]]);
}

const FILTER_COMMANDS: ReadonlyMap<string, ChooserCommand> = new Map(
  listCommandEntries((key) => FILTER_FIELD_KEYS.has(key)),
);

// The keys of the list: the list keys of tmux, the keys that the prefix table
// binds to a split and to a new window, and the filter key. Escape is left to
// the dialog, which closes on it. The key for a new thread only counts in a
// chooser that was opened for a new pane.
function listCommands(
  splitKeys: ListSplitKeys,
  hasNewThreadKey: boolean,
): ReadonlyMap<string, ChooserCommand> {
  const open = (keys: readonly string[], placement: SplitPlacement) =>
    keys.map((key): [string, ChooserCommand] => [
      key,
      { type: "open", placement },
    ]);
  const newThread = hasNewThreadKey ? splitKeys.newThread : [];
  return new Map<string, ChooserCommand>([
    ...newThread.map((key): [string, ChooserCommand] => [
      key,
      { type: "new-thread" },
    ]),
    ...open(splitKeys.down, "down"),
    ...open(splitKeys.right, "right"),
    ...listCommandEntries((key) => key !== "Escape"),
    [CHOOSER_FILTER_KEY, { type: "filter" }],
  ]);
}

// A character that the keyboard types with Option or AltGr is a chord and a
// typed character at once. As for a key of the window, it counts as the chord
// when that is a key of the list, and as the character otherwise.
function listCommandOf(
  commands: ReadonlyMap<string, ChooserCommand>,
  stroke: string,
  event: KeyEventLike,
): ChooserCommand | undefined {
  const command = commands.get(stroke);
  if (command !== undefined) return command;
  const isMac = isMacPlatform(navigator.platform);
  const typed = typedCharacterFromEvent(event, isMac);
  return typed === null ? undefined : commands.get(typed);
}

// What Escape, Enter and Tab do here, for the key that a terminal sends as
// one of them. The dialog only knows Escape itself and the browser only moves
// the cursor on Tab itself, so their work is a command of the chooser here.
function terminalKeyCommand(
  stroke: string,
  isInFilter: boolean,
): ChooserCommand | undefined {
  const key = terminalKeyOf(stroke);
  if (key === "Escape") return isInFilter ? { type: "list" } : { type: "close" };
  if (key === "Enter") return CHOOSER_LIST_COMMANDS.choose;
  return key === "Tab" ? { type: "next-field" } : undefined;
}

function closeChooser(): void {
  updateUiState({ chooser: CLOSED });
}

function tryOpenThread(threadId: string, placement: Placement): boolean {
  try {
    const result = openThread(threadId, placement);
    return result === "opened" || result === "focused-existing";
  } catch (error) {
    console.error(`[${PLUGIN_ID}] opening the chosen thread failed`, error);
    showNotice("Could not open that thread.");
    return false;
  }
}

function tryStartNewThread(placement: SplitPlacement): boolean {
  try {
    const result = openNewThreadInSplit(placement);
    return result === "started" || result === "focused-existing";
  } catch (error) {
    console.error(`[${PLUGIN_ID}] starting a new thread failed`, error);
    showNotice("Could not start a new thread.");
    return false;
  }
}

function threadRow(item: ChooserItem): ChooserRow {
  return { kind: "thread", key: `thread:${item.threadId}`, item };
}

function keyLabel(key: string | undefined): string | null {
  if (key === undefined) return null;
  return formatStroke(key, isMacPlatform(navigator.platform));
}

function hintPart(key: string | null, text: string): string | null {
  return key === null ? null : `${key} ${text}`;
}

// The hint under the list names one key for each thing the list can do.
function listHint(
  splitKeys: ListSplitKeys,
  isSplit: boolean,
  isNewThreadHighlighted: boolean,
): string {
  const newThreadKey = isSplit ? keyLabel(splitKeys.newThread[0]) : null;
  const choose = shortListKey("choose");
  const chooseHint =
    isNewThreadHighlighted && newThreadKey !== null
      ? `${choose} or ${newThreadKey} new thread`
      : hintPart(choose, isNewThreadHighlighted ? "new thread" : "open");
  const parts = [
    `${shortListKey("next")}/${shortListKey("previous")} move`,
    `${shortListKey("first")}/${shortListKey("last")} first/last`,
    hintPart(CHOOSER_FILTER_KEY, "filter"),
    chooseHint,
    hintPart(keyLabel(splitKeys.right[0]), "right"),
    hintPart(keyLabel(splitKeys.down[0]), "below"),
    isNewThreadHighlighted ? null : hintPart(newThreadKey, "new thread"),
    hintPart(shortListKey("leave"), "close"),
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

function hintText(
  splitKeys: ListSplitKeys,
  isFiltering: boolean,
  isSplit: boolean,
  isNewThreadHighlighted: boolean,
): string {
  if (isFiltering) {
    return isNewThreadHighlighted ? NEW_THREAD_FILTER_HINT : FILTER_HINT;
  }
  return listHint(splitKeys, isSplit, isNewThreadHighlighted);
}

// As in tmux's lists: a move by one row goes around from the last row to the
// first and back, and a move by a page stops at the first and the last row.
function movedIndex(
  to: MoveTarget,
  index: number,
  count: number,
  pageRows: number,
): number {
  if (to === "first") return 0;
  if (to === "last") return count - 1;
  if (to === "next") return index === count - 1 ? 0 : index + 1;
  if (to === "previous") return index === 0 ? count - 1 : index - 1;
  const rows = to === "page-down" ? pageRows : -pageRows;
  return Math.min(count - 1, Math.max(0, index + rows));
}

// As many rows as the list shows at once, less one, so that a row of the
// page before stays in view.
function pageRowsOf(list: HTMLElement | null): number {
  const row = list?.querySelector('[role="option"]');
  const rowHeight = row?.getBoundingClientRect().height ?? 0;
  if (list === null || rowHeight <= 0) return FALLBACK_PAGE_ROWS;
  return Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1);
}

function paneMark(item: ChooserItem): string | null {
  if (item.isFocusedPane) return "focused pane";
  return item.isVisibleInPane ? "in a pane" : null;
}

function rowMarks(item: ChooserItem): string[] {
  const marks = [
    paneMark(item),
    item.isRunning ? "running" : null,
    item.isUnread ? "unread" : null,
    item.isChild ? "child thread" : null,
  ];
  return marks.filter((mark): mark is string => mark !== null);
}

interface ChooserRowProps {
  id: string;
  item: ChooserItem;
  isHighlighted: boolean;
  onHighlight: () => void;
  onChoose: () => void;
}

function ChooserRow({
  id,
  item,
  isHighlighted,
  onHighlight,
  onChoose,
}: ChooserRowProps): ReactElement {
  return (
    <div
      id={id}
      role="option"
      aria-selected={isHighlighted}
      className={cn(
        "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        isHighlighted && "bg-accent text-accent-foreground",
        item.isChild && "pl-6",
      )}
      onPointerMove={onHighlight}
      onClick={onChoose}
    >
      <span
        className={cn("min-w-0 truncate", item.isUnread && "font-semibold")}
      >
        {item.title}
      </span>
      {item.projectName === null ? null : (
        <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">
          {item.projectName}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {rowMarks(item).map((mark) => (
          <span
            key={mark}
            className="rounded-sm border border-border px-1.5 py-0.5 text-xs leading-none text-muted-foreground"
          >
            {mark}
          </span>
        ))}
      </span>
    </div>
  );
}

interface NewThreadRowProps {
  id: string;
  keyHint: string | null;
  isHighlighted: boolean;
  onHighlight: () => void;
  onChoose: () => void;
}

function NewThreadRow({
  id,
  keyHint,
  isHighlighted,
  onHighlight,
  onChoose,
}: NewThreadRowProps): ReactElement {
  return (
    <div
      id={id}
      role="option"
      aria-selected={isHighlighted}
      className={cn(
        "mb-1 flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-sm",
        isHighlighted && "bg-accent text-accent-foreground",
      )}
      onPointerMove={onHighlight}
      onClick={onChoose}
    >
      <span className="min-w-0 truncate font-medium">{NEW_THREAD_LABEL}</span>
      {keyHint === null ? null : (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          press {keyHint}
        </span>
      )}
    </div>
  );
}

interface ChooserBodyProps {
  placement: Placement;
  splitKeys: ListSplitKeys;
  listRef: RefObject<HTMLDivElement | null>;
  filterRef: RefObject<HTMLInputElement | null>;
  keyHandlerRef: RefObject<KeyHandler | null>;
  onChoose: (threadId: string, placement: Placement) => void;
  onStartNewThread: (placement: SplitPlacement) => void;
}

function ChooserBody({
  placement,
  splitKeys,
  listRef,
  filterRef,
  keyHandlerRef,
  onChoose,
  onStartNewThread,
}: ChooserBodyProps): ReactElement {
  const { threads, projects } = experimental_useSidebarThreads();
  const layout = useSidebarSplitLayout();
  const contextThreadId = useBbContext().threadId;
  const [query, setQuery] = useState("");
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [isFiltering, setIsFiltering] = useState(false);
  const shouldRevealHighlight = useRef(false);
  const listId = useId();
  useCompactAutoFocus(listRef);

  const items = useMemo(
    () =>
      buildChooserItems({ threads, projects, layout, contextThreadId, query }),
    [threads, projects, layout, contextThreadId, query],
  );
  const splitPlacement = placement === "replace" ? null : placement;
  const offersNewThread = splitPlacement !== null && query.trim() === "";
  const rows = useMemo(() => {
    const threadRows = items.map(threadRow);
    return offersNewThread ? [NEW_THREAD_ROW, ...threadRows] : threadRows;
  }, [items, offersNewThread]);
  const highlightedIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === highlightedKey),
  );
  const highlighted = rows.at(highlightedIndex) ?? null;
  const highlightedRowKey = highlighted?.key ?? null;
  const isNewThreadHighlighted = highlighted?.kind === "new-thread";

  useEffect(() => {
    if (!shouldRevealHighlight.current) return;
    shouldRevealHighlight.current = false;
    const row = listRef.current?.querySelector('[aria-selected="true"]');
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [listRef, highlightedRowKey]);

  const move = (to: MoveTarget): void => {
    const pageRows = pageRowsOf(listRef.current);
    const target = rows.at(
      movedIndex(to, highlightedIndex, rows.length, pageRows),
    );
    if (target === undefined || target.key === highlightedRowKey) return;
    shouldRevealHighlight.current = true;
    setHighlightedKey(target.key);
  };

  const chooseRow = (row: ChooserRow, asked: SplitPlacement | null): void => {
    if (row.kind === "thread") {
      onChoose(row.item.threadId, asked ?? placement);
      return;
    }
    const target = asked ?? splitPlacement;
    if (target !== null) onStartNewThread(target);
  };

  const run = (command: ChooserCommand, dialog: HTMLElement): void => {
    if (command.type === "move") {
      move(command.to);
      return;
    }
    if (command.type === "close") {
      closeChooser();
      return;
    }
    if (command.type === "filter") {
      filterRef.current?.focus({ preventScroll: true });
      return;
    }
    if (command.type === "list") {
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    if (command.type === "next-field") {
      focusNextTabStop(dialog);
      return;
    }
    if (command.type === "new-thread") {
      if (splitPlacement !== null) onStartNewThread(splitPlacement);
      return;
    }
    if (highlighted === null) return;
    chooseRow(highlighted, command.placement);
  };

  const commands = useMemo(
    () => listCommands(splitKeys, splitPlacement !== null),
    [splitKeys, splitPlacement],
  );

  // The Enter that ends a composition of an input method in the filter field
  // only confirms that text.
  const handleKeyDown: KeyHandler = (event) => {
    if (isCompositionKey(event.nativeEvent) || !getUiState().chooser.open) return;
    const stroke = keyStrokeFromEvent(event);
    if (stroke === null) return;
    const isInFilter = event.target === filterRef.current;
    const command =
      (isInFilter
        ? FILTER_COMMANDS.get(stroke)
        : listCommandOf(commands, stroke, event)) ??
      terminalKeyCommand(stroke, isInFilter);
    if (command === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    run(command, event.currentTarget);
  };
  // The dialog itself listens, not this body: a click on the heading or the
  // hint line puts focus on the dialog, which is outside the body. In the
  // drawer of a narrow window the dialog only takes that focus because it is
  // given a tabIndex.
  useImperativeHandle(keyHandlerRef, () => handleKeyDown);

  const handleQueryChange = (nextQuery: string): void => {
    setQuery(nextQuery);
    setHighlightedKey(null);
    if (listRef.current !== null) listRef.current.scrollTop = 0;
  };

  const activeOptionId =
    highlighted === null ? undefined : `${listId}-${highlightedIndex}`;
  const heading =
    isNewThreadHighlighted && splitPlacement !== null
      ? NEW_THREAD_HEADINGS[splitPlacement]
      : HEADINGS[placement];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border px-3 pt-2.5 pb-1">
        <DialogDescription className="text-xs">{heading}</DialogDescription>
        <input
          ref={filterRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-label="Filter threads by title or project"
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Press / to filter by title or project"
          className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onFocus={() => setIsFiltering(true)}
          onBlur={() => setIsFiltering(false)}
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={0}
        aria-label="Threads"
        aria-activedescendant={activeOptionId}
        className="max-h-[min(24rem,50dvh)] min-h-0 overflow-y-auto p-1 outline-none"
      >
        {rows.map((row, index) =>
          row.kind === "new-thread" ? (
            <NewThreadRow
              key={row.key}
              id={`${listId}-${index}`}
              keyHint={keyLabel(splitKeys.newThread[0])}
              isHighlighted={index === highlightedIndex}
              onHighlight={() => setHighlightedKey(row.key)}
              onChoose={() => chooseRow(row, null)}
            />
          ) : (
            <ChooserRow
              key={row.key}
              id={`${listId}-${index}`}
              item={row.item}
              isHighlighted={index === highlightedIndex}
              onHighlight={() => setHighlightedKey(row.key)}
              onChoose={() => chooseRow(row, null)}
            />
          ),
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">
          {query.trim() === "" ? NO_THREADS_TEXT : NO_MATCHES_TEXT}
        </p>
      ) : null}
      <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {hintText(
          splitKeys,
          isFiltering,
          splitPlacement !== null,
          isNewThreadHighlighted,
        )}
      </p>
    </div>
  );
}

// keymap is null while the keys are not known. The list keys of tmux work all
// the same, and the keys for a split and a new thread do not.
export function Chooser({ keymap }: { keymap: Keymap | null }): ReactElement {
  const chooser = useUiState((state) => state.chooser);
  const openingKey = useOpeningKey(chooser.open);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const keyHandlerRef = useRef<KeyHandler>(null);
  const returnFocus = useReturnFocus(chooser.open);
  const positionStyle = useDialogPositionStyle(chooser.open, MAX_WIDTH_PX);
  useFocusWhenReopened(chooser.open, contentRef, listRef, returnFocus);

  const closeThenRun = useCallback(
    (run: () => boolean): void => {
      if (!getUiState().chooser.open) return;
      const focusedBefore = returnFocus.take();
      // bb ignores its own shortcuts while a modal dialog is in the page, and
      // opening a pane may send one (to unzoom), so the dialog must be closed
      // in the DOM first, not only in the store.
      flushSync(closeChooser);
      if (run()) return;
      giveFocusBack(focusedBefore);
    },
    [returnFocus],
  );

  const choose = useCallback(
    (threadId: string, placement: Placement): void =>
      closeThenRun(() => tryOpenThread(threadId, placement)),
    [closeThenRun],
  );

  const startNewThread = useCallback(
    (placement: SplitPlacement): void =>
      closeThenRun(() => tryStartNewThread(placement)),
    [closeThenRun],
  );

  return (
    <Dialog
      open={chooser.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeChooser();
      }}
    >
      <DialogContent
        ref={contentRef}
        hideCloseButton
        tabIndex={-1}
        compactContentClassName="h-[min(32rem,80dvh)]"
        className={CONTENT_CLASS}
        style={positionStyle}
        onKeyDown={(event) => keyHandlerRef.current?.(event)}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.remember();
          listRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (document.activeElement !== filterRef.current) return;
          event.preventDefault();
          listRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">Thread chooser</DialogTitle>
        {chooser.open ? (
          <ChooserBody
            key={openingKey}
            placement={chooser.placement}
            splitKeys={keymap?.listSplitKeys ?? NO_SPLIT_KEYS}
            listRef={listRef}
            filterRef={filterRef}
            keyHandlerRef={keyHandlerRef}
            onChoose={choose}
            onStartNewThread={startNewThread}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
