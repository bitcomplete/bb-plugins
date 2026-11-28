import { useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { DialogFooter } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { cn } from "../../lib/utils";
import type { ChosenFile } from "../config-file";
import { PLUGIN_ID } from "../constants";
import type { rpcContract } from "../contract";
import type { FolderEntry, FolderListing } from "../folder-listing";
import { isCompositionKey } from "../keys";
import { useCompactAutoFocus } from "../overlay/hooks";
import {
  FAILURE_TEXTS,
  HOME_PATH,
  LISTING_TEXT,
  LIST_MOVES,
  NO_LISTING_TEXT,
  childPath,
  describeListing,
  entryNameAt,
  movedIndex,
  type ListedFolder,
} from "./browse-model";
import { OUTLINE_BUTTON, PRIMARY_BUTTON, TEXT_FIELD } from "./controls";

type Rpc = PluginRpcClient<typeof rpcContract>;
type FailedListing = Extract<FolderListing, { ok: false }>;

// marked is the full path of the entry to highlight in the listing, and
// file the full path of a file that was asked for by its path. Either is
// null for none.
interface Opened {
  answer: FolderListing;
  marked: string | null;
  file: string | null;
}

// failed holds the folder above the one that could not be listed, so that
// the way up still works.
type View =
  | { status: "loading" }
  | { status: "listed"; listing: ListedFolder }
  | { status: "failed"; text: string; parent: string | null };

// onStored hands on the file that the server part names in its answer to a
// store, which is the one that is chosen by then, also for an answer that
// comes after the dialog was closed. onClose closes the dialog.
interface BrowseBodyProps {
  startPath: string | null;
  listRef: RefObject<HTMLDivElement | null>;
  onStored: (file: ChosenFile | null) => void;
  onClose: () => void;
}

interface EntryRowProps {
  id: string;
  entry: FolderEntry;
  isHighlighted: boolean;
  onPress: () => void;
  onConfirm: () => void;
}

export const BROWSE_TITLE = "Choose a tmux config file";
export const BROWSE_DESCRIPTION =
  "The folders and files of the machine that runs the bb server, hidden ones included. Open a folder, choose a file and confirm with Use this file.";
export const PATH_BOX_LABEL = "Path of the folder to list";
export const PATH_BOX_HINT =
  "Type or paste the path of a folder or of a file, then press Enter.";
export const PARENT_LABEL = "Go to the parent folder";
export const GO_LABEL = "Go";
export const LIST_LABEL = "Folders and files";
export const NO_FILE_TEXT = "No file is chosen yet.";
export const CONFIRM_LABEL = "Use this file";
export const CANCEL_LABEL = "Cancel";
export const NOT_STORED_TEXT =
  "The file could not be stored as the config file, because the server part of the plugin did not answer.";
export const NOT_TAKEN_TEXT =
  "The server part of the plugin does not take this path for a config file.";

const LOADING: View = { status: "loading" };
const NO_ENTRIES: readonly FolderEntry[] = [];
const FALLBACK_PAGE_ROWS = 10;

async function listPlain(rpc: Rpc, path: string): Promise<Opened> {
  const answer = await rpc.call("listFolder", { path });
  return { answer, marked: null, file: null };
}

// A path to a file is answered with the folder that holds the file, and the
// file is chosen. So a pasted file path leads to that file, and the dialog
// opens on the file in use. The file is chosen also when its folder does not
// list it, as in a list that was cut, or cannot be listed at all.
async function listWithFile(rpc: Rpc, path: string): Promise<Opened> {
  const first = await rpc.call("listFolder", { path });
  if (first.ok || first.reason !== "is-a-file") {
    return { answer: first, marked: null, file: null };
  }
  if (first.parent === null || first.path === null) {
    return { answer: first, marked: null, file: null };
  }
  const folder = await rpc.call("listFolder", { path: first.parent });
  const answer = folder.ok ? folder : first;
  return { answer, marked: first.path, file: first.path };
}

// A path that was typed or pasted is asked for as it is first, because a
// name can end in a blank. When it leads nowhere like that, it is asked for
// without the blanks around it, which are seldom meant.
async function listTyped(rpc: Rpc, typed: string): Promise<Opened> {
  const asTyped = await listWithFile(rpc, typed);
  const trimmed = typed.trim();
  const { answer } = asTyped;
  const leadsNowhere =
    !answer.ok && (answer.reason === "missing" || answer.reason === "not-absolute");
  if (trimmed === typed || !leadsNowhere) return asTyped;
  return listWithFile(rpc, trimmed);
}

// Where the dialog opens: on the file in use, or in the folder that held it
// when the file is gone, or else in the home folder.
async function listStart(rpc: Rpc, startPath: string | null): Promise<Opened> {
  if (startPath === null) return listPlain(rpc, HOME_PATH);
  const first = await listWithFile(rpc, startPath);
  if (first.answer.ok) return first;
  const { parent } = first.answer;
  if (parent !== null) {
    const above = await listPlain(rpc, parent);
    if (above.answer.ok) return above;
  }
  return listPlain(rpc, HOME_PATH);
}

// answer is null when the server part did not answer.
function failedView(answer: FailedListing | null): View {
  if (answer === null) {
    return { status: "failed", text: NO_LISTING_TEXT, parent: null };
  }
  return {
    status: "failed",
    text: FAILURE_TEXTS[answer.reason],
    parent: answer.parent,
  };
}

function parentOf(view: View): string | null {
  if (view.status === "listed") return view.listing.parent;
  return view.status === "failed" ? view.parent : null;
}

// As many rows as the list shows at once, less one, so that a row of the
// page before stays in view.
function pageRowsOf(list: HTMLElement | null): number {
  const row = list?.querySelector('[role="option"]');
  const rowHeight = row?.getBoundingClientRect().height ?? 0;
  if (list === null || rowHeight <= 0) return FALLBACK_PAGE_ROWS;
  return Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1);
}

// A press opens a folder and chooses a file. The second press of a double
// click counts for nothing, and the double click itself only confirms a file
// that the first press chose: the list changes under the pointer when a
// folder opens, and a habitual double click on a folder must not choose
// whatever file then lies there.
function EntryRow({
  id,
  entry,
  isHighlighted,
  onPress,
  onConfirm,
}: EntryRowProps): ReactElement {
  const isFolder = entry.kind === "folder";
  return (
    <div
      id={id}
      role="option"
      aria-selected={isHighlighted}
      className={cn(
        "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-state-hover",
        isHighlighted && "bg-accent text-accent-foreground hover:bg-accent",
      )}
      onClick={(event) => {
        if (event.detail <= 1) onPress();
      }}
      onDoubleClick={() => {
        if (isHighlighted) onConfirm();
      }}
    >
      <Icon
        name={isFolder ? "Folder" : "File"}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 truncate" title={entry.name}>
        {entry.name}
      </span>
      <span className="sr-only">{isFolder ? ", folder" : ", file"}</span>
      {isFolder ? (
        <Icon
          name="ChevronRight"
          className="ml-auto size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

// The body of the Browse dialog: a path box, a way up, and the list of one
// folder of the machine that runs the bb server. It takes the keys of a
// plain list and of a text field only. startPath is the config file in use,
// null while tmux's usual files are.
export function BrowseBody({
  startPath,
  listRef,
  onStored,
  onClose,
}: BrowseBodyProps): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const [openedAt] = useState(startPath);
  const [typedPath, setTypedPath] = useState(startPath ?? HOME_PATH);
  const [view, setView] = useState<View>(LOADING);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [fileByPath, setFileByPath] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(true);
  const [isStoring, setIsStoring] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const shouldReveal = useRef(false);
  const pathBoxText = useRef(typedPath);
  const isShown = useRef(true);
  const listId = useId();
  const hintId = useId();
  useCompactAutoFocus(listRef);

  const writePathBox = useCallback((path: string): void => {
    pathBoxText.current = path;
    setTypedPath(path);
  }, []);

  // An answer to an older question never replaces a newer one. The path box
  // names the folder that the answer is about, also one that could not be
  // listed, unless the person wrote in the box while the answer was under
  // way: what they wrote stays. askedFor is the path that the box names for
  // a folder that could not be listed, null for a path from the box itself,
  // which then keeps what was written. True when the folder was listed and
  // the box names it.
  const show = useCallback(
    async (ask: () => Promise<Opened>, askedFor: string | null): Promise<boolean> => {
      latestRequest.current += 1;
      const request = latestRequest.current;
      const textWhenAsked = pathBoxText.current;
      setIsBusy(true);
      const opened = await ask().catch((error: unknown) => {
        console.warn(`[${PLUGIN_ID}] listing a folder failed`, error);
        return null;
      });
      if (request !== latestRequest.current) return false;
      const isBoxAsItWas = pathBoxText.current === textWhenAsked;
      setIsBusy(false);
      setStoreError(null);
      setFileByPath(opened?.file ?? null);
      const answer = opened?.answer ?? null;
      if (answer === null || !answer.ok) {
        setView(failedView(answer));
        setHighlighted(null);
        if (isBoxAsItWas && askedFor !== null) writePathBox(answer?.path ?? askedFor);
        return false;
      }
      if (listRef.current !== null) listRef.current.scrollTop = 0;
      shouldReveal.current = true;
      setView({ status: "listed", listing: answer });
      setHighlighted(entryNameAt(answer, opened?.marked ?? null));
      if (isBoxAsItWas) writePathBox(answer.path);
      return isBoxAsItWas;
    },
    [listRef, writePathBox],
  );

  useEffect(() => {
    void show(() => listStart(rpc, openedAt), openedAt ?? HOME_PATH);
    return () => {
      latestRequest.current += 1;
    };
  }, [rpc, show, openedAt]);

  // The dialog can be closed, and opened again with another body, while an
  // answer of the server part is under way.
  useEffect(() => {
    isShown.current = true;
    return () => {
      isShown.current = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldReveal.current) return;
    shouldReveal.current = false;
    const row = listRef.current?.querySelector('[aria-selected="true"]');
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [listRef, highlighted, view]);

  const entries = view.status === "listed" ? view.listing.entries : NO_ENTRIES;
  const folderPath = view.status === "listed" ? view.listing.path : null;
  const parent = parentOf(view);
  const chosenEntry = entries.find((entry) => entry.name === highlighted) ?? null;
  const chosenIndex = chosenEntry === null ? null : entries.indexOf(chosenEntry);
  const highlightedFile =
    folderPath !== null && chosenEntry?.kind === "file"
      ? childPath(folderPath, chosenEntry.name)
      : null;
  const chosenFile = fileByPath ?? highlightedFile;

  // A row that the person highlights takes the place of a file that was
  // asked for by its path.
  const highlight = (name: string): void => {
    setFileByPath(null);
    setHighlighted(name);
  };

  const openFolder = (path: string, marked: string | null): void => {
    void show(async () => ({ ...(await listPlain(rpc, path)), marked }), path);
  };

  const goUp = (): void => {
    if (parent !== null) openFolder(parent, folderPath);
  };

  // After the jump the cursor goes into the list, so that the arrow keys go
  // on from there, unless the person moved it or went on typing meanwhile.
  const goToTypedPath = async (): Promise<void> => {
    const cursorWhenAsked = document.activeElement;
    const isListed = await show(() => listTyped(rpc, typedPath), null);
    if (!isListed || document.activeElement !== cursorWhenAsked) return;
    listRef.current?.focus({ preventScroll: true });
  };

  // The server part stores the file also when the dialog was closed before
  // it answered. The file is handed on then, and the answer closes no dialog
  // that was opened since.
  const store = async (path: string): Promise<void> => {
    if (isStoring) return;
    setIsStoring(true);
    setStoreError(null);
    try {
      const change = await rpc.call("setConfigFile", { path });
      if (change.ok) {
        onStored(change.file);
        if (isShown.current) onClose();
        return;
      }
      setStoreError(NOT_TAKEN_TEXT);
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] storing the config file failed`, error);
      setStoreError(NOT_STORED_TEXT);
    } finally {
      setIsStoring(false);
    }
  };

  const press = (entry: FolderEntry): void => {
    if (folderPath === null) return;
    if (entry.kind === "folder") {
      openFolder(childPath(folderPath, entry.name), null);
      return;
    }
    highlight(entry.name);
  };

  const confirm = (entry: FolderEntry): void => {
    if (folderPath === null || entry.kind !== "file") return;
    void store(childPath(folderPath, entry.name));
  };

  // The Enter that ends a composition of an input method only confirms that
  // text, and an Enter that is held down counts once.
  const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.repeat) return;
    if (isCompositionKey(event.nativeEvent)) return;
    event.preventDefault();
    void goToTypedPath();
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const move = LIST_MOVES.get(event.key);
    if (move !== undefined) {
      event.preventDefault();
      const index = movedIndex(
        move,
        chosenIndex,
        entries.length,
        pageRowsOf(listRef.current),
      );
      const target = index === null ? undefined : entries[index];
      if (target === undefined) return;
      shouldReveal.current = true;
      highlight(target.name);
      return;
    }
    // An Enter that is still held down from the press that opened the dialog
    // or a folder confirms nothing.
    if (event.key !== "Enter" || event.repeat) return;
    if (chosenEntry?.kind === "folder") {
      event.preventDefault();
      press(chosenEntry);
      return;
    }
    if (chosenFile === null) return;
    event.preventDefault();
    void store(chosenFile);
  };

  const activeOptionId =
    chosenIndex === null ? undefined : `${listId}-${chosenIndex}`;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(OUTLINE_BUTTON, "w-8 px-0")}
          aria-label={PARENT_LABEL}
          aria-disabled={parent === null}
          onClick={goUp}
        >
          <Icon name="ArrowUp" className="size-4" aria-hidden />
        </button>
        <input
          type="text"
          aria-label={PATH_BOX_LABEL}
          aria-describedby={hintId}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={TEXT_FIELD}
          value={typedPath}
          onChange={(event) => writePathBox(event.target.value)}
          onKeyDown={handlePathKeyDown}
        />
        <button
          type="button"
          className={OUTLINE_BUTTON}
          onClick={() => void goToTypedPath()}
        >
          {GO_LABEL}
        </button>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {PATH_BOX_HINT}
      </p>
      {view.status === "failed" && !isBusy ? (
        <p role="alert" className="text-sm text-destructive">
          {view.text}
        </p>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {view.status === "listed" && !isBusy
            ? describeListing(view.listing)
            : LISTING_TEXT}
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={0}
        aria-label={LIST_LABEL}
        aria-busy={isBusy}
        aria-activedescendant={activeOptionId}
        className={cn(
          "h-[min(18rem,40dvh)] min-h-0 overflow-y-auto rounded-md border border-border p-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isBusy && "opacity-60",
        )}
        onKeyDown={handleListKeyDown}
      >
        {entries.map((entry, index) => (
          <EntryRow
            key={entry.name}
            id={`${listId}-${index}`}
            entry={entry}
            isHighlighted={entry === chosenEntry}
            onPress={() => press(entry)}
            onConfirm={() => confirm(entry)}
          />
        ))}
      </div>
      <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">
        {chosenFile ?? NO_FILE_TEXT}
      </p>
      {storeError === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {storeError}
        </p>
      )}
      <DialogFooter>
        <button type="button" className={OUTLINE_BUTTON} onClick={onClose}>
          {CANCEL_LABEL}
        </button>
        {/* A button that is disabled while it holds the cursor drops the
            cursor to the page in Chromium, and Enter would no longer try
            again after a store that failed. A store under way only marks
            it. */}
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={chosenFile === null}
          aria-disabled={isStoring}
          onClick={() => {
            if (chosenFile !== null) void store(chosenFile);
          }}
        >
          {CONFIRM_LABEL}
        </button>
      </DialogFooter>
    </div>
  );
}
