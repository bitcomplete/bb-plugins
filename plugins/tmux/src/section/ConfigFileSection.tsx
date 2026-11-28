import {
  useRpc,
  type PluginSettingsSectionProps,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import type { ChosenFile } from "../config-file";
import { useConfigFileChanges } from "../config-file-changes";
import { PLUGIN_ID } from "../constants";
import type { rpcContract } from "../contract";
import { useOpeningKey } from "../overlay/hooks";
import { useDialogPositionStyle } from "../overlay/native-views";
import { CONFIG_TEXT_LABEL } from "../settings";
import { BROWSE_DESCRIPTION, BROWSE_TITLE, BrowseBody } from "./BrowseDialog";
import { OUTLINE_BUTTON } from "./controls";

// unknown: the server part did not say which file is in use.
type Choice =
  | { status: "loading" }
  | { status: "unknown" }
  | { status: "known"; file: ChosenFile | null };

export const SECTION_DESCRIPTION =
  "The tmux config that the keys are read from, on the machine that runs the bb server.";
export const BROWSE_LABEL = "Browse";
export const USUAL_FILES_LABEL = "Use tmux's usual files";
export const RETRY_LABEL = "Try again";
const IN_USE_LABEL = "In use:";
const USUAL_FILES_NAME = "tmux's usual files";
const USUAL_FILES: readonly string[] = [
  "~/.tmux.conf",
  "$XDG_CONFIG_HOME/tmux/tmux.conf",
  "~/.config/tmux/tmux.conf",
];
const USUAL_FILES_NOTE =
  "Each of the three that exists is read, in this order. The second one only counts while XDG_CONFIG_HOME is set for the bb server.";
const CHOSEN_FILE_NOTE =
  "This file is read in the place of tmux's usual files. A change to it is picked up when a bb window loads, and on a key that you bound to source-file.";
const UNREADABLE_TEXT = `This file cannot be read right now. tmux's usual files are not read in its place: until it can be read, you get the keys of stock tmux with the lines of the ${CONFIG_TEXT_LABEL} setting, and the key help says so. Once it can be read again, reload the bb window or choose the file again.`;
const ON_TOP_OF_FILE_TEXT = `The ${CONFIG_TEXT_LABEL} above is applied on top of this file.`;
const ON_TOP_OF_USUAL_FILES_TEXT = `The ${CONFIG_TEXT_LABEL} above is applied on top of these files.`;
export const LOADING_TEXT = "Asking which config file is in use.";
export const UNKNOWN_TEXT =
  "The config file in use is not known, because the server part of the plugin did not answer.";
export const NOT_CLEARED_TEXT =
  "The choice could not be changed, because the server part of the plugin did not answer.";

const LOADING: Choice = { status: "loading" };
const UNKNOWN: Choice = { status: "unknown" };

const MAX_WIDTH_PX = 640;
const CONTENT_CLASS =
  "max-w-[640px] gap-3 border-border bg-popover text-popover-foreground";
const CARD_CLASS =
  "space-y-3 rounded-lg border border-border bg-card px-4 py-3.5 text-sm";
const NOTE_CLASS = "text-xs leading-relaxed text-muted-foreground";

function hasCursor(element: HTMLElement | null): boolean {
  return element !== null && document.activeElement === element;
}

function UsualFilesLines(): ReactElement {
  return (
    <>
      <p>
        <span className="text-muted-foreground">{IN_USE_LABEL}</span>{" "}
        <span className="font-medium">{USUAL_FILES_NAME}</span>
      </p>
      <ol className="list-inside list-decimal font-mono text-xs text-muted-foreground">
        {USUAL_FILES.map((path) => (
          <li key={path} className="break-all">
            {path}
          </li>
        ))}
      </ol>
      <p className={NOTE_CLASS}>{USUAL_FILES_NOTE}</p>
    </>
  );
}

function ChosenFileLines({ file }: { file: ChosenFile }): ReactElement {
  return (
    <>
      <p>
        <span className="text-muted-foreground">{IN_USE_LABEL}</span>{" "}
        <span className="break-all font-mono font-medium">{file.path}</span>
      </p>
      {file.readable ? (
        <p className={NOTE_CLASS}>{CHOSEN_FILE_NOTE}</p>
      ) : (
        <p className="text-xs leading-relaxed text-destructive">{UNREADABLE_TEXT}</p>
      )}
    </>
  );
}

// The settings section in which the config file is chosen. It works the same
// while the plugin is switched off, so that the file can be chosen first. It
// follows a choice made in another bb window.
export function ConfigFileSection(
  _props: PluginSettingsSectionProps,
): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const [choice, setChoice] = useState<Choice>(LOADING);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [hasClearFailed, setHasClearFailed] = useState(false);
  const latestRequest = useRef(0);
  const shouldMoveCursorToBrowse = useRef(false);
  const browseRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const usualFilesRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openingKey = useOpeningKey(isBrowsing);
  const positionStyle = useDialogPositionStyle(isBrowsing, MAX_WIDTH_PX);

  // An answer to an older question never replaces a newer one, and a
  // question that fails leaves what is known as it is. Try again goes away
  // with an answer, whoever asked for it.
  const refresh = useCallback(async (): Promise<void> => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    try {
      const { file } = await rpc.call("configFile", null);
      if (request !== latestRequest.current) return;
      if (hasCursor(retryRef.current)) shouldMoveCursorToBrowse.current = true;
      setChoice({ status: "known", file });
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] asking for the config file failed`, error);
      if (request !== latestRequest.current) return;
      setChoice((current) => (current.status === "known" ? current : UNKNOWN));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);

  useConfigFileChanges(() => void refresh());

  // A cursor that was on Try again when it went away moves to the Browse
  // button, which takes its place. A cursor that is anywhere else, as in a
  // field of the settings above, stays there.
  useEffect(() => {
    if (!shouldMoveCursorToBrowse.current || choice.status !== "known") return;
    shouldMoveCursorToBrowse.current = false;
    browseRef.current?.focus({ preventScroll: true });
  }, [choice]);

  // Radix moves the cursor into a dialog only when its content mounts. A
  // dialog that is opened again while it still fades out never unmounted.
  useEffect(() => {
    if (!isBrowsing || contentRef.current === null) return;
    if (contentRef.current.contains(document.activeElement)) return;
    listRef.current?.focus({ preventScroll: true });
  }, [isBrowsing]);

  const take = (file: ChosenFile | null): void => {
    latestRequest.current += 1;
    setHasClearFailed(false);
    setChoice({ status: "known", file });
  };

  // The button that was pressed goes away with the choice. A cursor that is
  // still on it moves to the Browse button, which stays, and a cursor that
  // went elsewhere before the server part answered stays there.
  const goBackToUsualFiles = async (): Promise<void> => {
    if (isClearing) return;
    setIsClearing(true);
    setHasClearFailed(false);
    try {
      const change = await rpc.call("setConfigFile", { path: null });
      if (!change.ok) {
        setHasClearFailed(true);
        return;
      }
      const hadCursor = hasCursor(usualFilesRef.current);
      take(change.file);
      if (hadCursor) browseRef.current?.focus({ preventScroll: true });
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] clearing the config file failed`, error);
      setHasClearFailed(true);
    } finally {
      setIsClearing(false);
    }
  };

  if (choice.status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {LOADING_TEXT}
      </p>
    );
  }

  if (choice.status === "unknown") {
    return (
      <div className={CARD_CLASS}>
        <p role="alert" className="text-destructive">
          {UNKNOWN_TEXT}
        </p>
        <button
          ref={retryRef}
          type="button"
          className={OUTLINE_BUTTON}
          onClick={() => void refresh()}
        >
          {RETRY_LABEL}
        </button>
      </div>
    );
  }

  const { file } = choice;

  return (
    <div className={CARD_CLASS}>
      <div role="status" className="space-y-1.5">
        {file === null ? <UsualFilesLines /> : <ChosenFileLines file={file} />}
      </div>
      <p className={NOTE_CLASS}>
        {file === null ? ON_TOP_OF_USUAL_FILES_TEXT : ON_TOP_OF_FILE_TEXT}
      </p>
      <div className="flex flex-wrap gap-2">
        <Dialog open={isBrowsing} onOpenChange={setIsBrowsing}>
          <DialogTrigger asChild>
            <button ref={browseRef} type="button" className={OUTLINE_BUTTON}>
              {BROWSE_LABEL}
            </button>
          </DialogTrigger>
          <DialogContent
            ref={contentRef}
            tabIndex={-1}
            className={CONTENT_CLASS}
            style={positionStyle}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              listRef.current?.focus({ preventScroll: true });
            }}
            onAfterCloseAutoFocus={() =>
              browseRef.current?.focus({ preventScroll: true })
            }
          >
            <DialogTitle>{BROWSE_TITLE}</DialogTitle>
            <DialogDescription>{BROWSE_DESCRIPTION}</DialogDescription>
            {isBrowsing ? (
              <BrowseBody
                key={openingKey}
                startPath={file?.path ?? null}
                listRef={listRef}
                onStored={take}
                onClose={() => setIsBrowsing(false)}
              />
            ) : null}
          </DialogContent>
        </Dialog>
        {file === null ? null : (
          <button
            ref={usualFilesRef}
            type="button"
            className={OUTLINE_BUTTON}
            aria-disabled={isClearing}
            onClick={() => void goBackToUsualFiles()}
          >
            {USUAL_FILES_LABEL}
          </button>
        )}
      </div>
      {hasClearFailed ? (
        <p role="alert" className="text-destructive">
          {NOT_CLEARED_TEXT}
        </p>
      ) : null}
    </div>
  );
}
