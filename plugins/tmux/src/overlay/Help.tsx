import {
  Fragment,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import { isMacPlatform } from "../bb-commands";
import { updateUiState } from "../bridge";
import {
  describeKeymap,
  describeKeymapPrefix,
  describeSource,
  describeTerminalKeys,
  type HelpSection,
  type TmuxSource,
} from "../keymap";
import { formatStroke, keyStrokeFromEvent, terminalKeyOf } from "../keys";
import { LIST_KEYS, shortListKey, type ListCommand } from "../list-keys";
import type { Settings } from "../settings";
import type { Keymap } from "../types";
import {
  focusNextTabStop,
  pressFocusedButton,
  useCompactAutoFocus,
  useFocusWhenReopened,
  useReturnFocus,
  useUiState,
} from "./hooks";
import { useDialogPositionStyle } from "./native-views";

const MAX_WIDTH_PX = 832;
const CONTENT_CLASS =
  "max-w-[832px] gap-3 border-border bg-popover text-popover-foreground";

const KEYS_NOT_KNOWN_TEXT = "The tmux config is still being read.";

// The keys of tmux's lists, as they are named in list-keys.ts.
const DESCRIPTION = `${formatStroke(shortListKey("leave"))} or Escape closes. ${formatStroke(shortListKey("next"))} and ${formatStroke(shortListKey("previous"))} scroll, as do the other list keys of tmux.`;

const TERMINAL_KEYS_NOTE = describeTerminalKeys();

function closeHelp(): void {
  updateUiState({ helpOpen: false });
}

// Where a list key of tmux takes the key list, which has no rows to choose.
function scrollTarget(
  body: HTMLElement,
  command: ListCommand,
  stepPx: number,
): number | null {
  switch (command) {
    case "previous":
      return body.scrollTop - stepPx;
    case "next":
      return body.scrollTop + stepPx;
    case "page-up":
      return body.scrollTop - body.clientHeight;
    case "page-down":
      return body.scrollTop + body.clientHeight;
    case "first":
      return 0;
    case "last":
      return body.scrollHeight;
    default:
      return null;
  }
}

function HelpSectionView({ section }: { section: HelpSection }): ReactElement {
  return (
    <section className="mb-4 break-inside-avoid">
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
        {section.title}
      </h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {section.rows.map((row) => (
          <Fragment key={`${row.keys} ${row.description}`}>
            <dt className="font-mono text-xs leading-5">{row.keys}</dt>
            <dd className="m-0 leading-5 text-muted-foreground">
              {row.description}
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

interface SourceLinesProps {
  keymap: Keymap;
  source: TmuxSource;
}

function SourceLines({ keymap, source }: SourceLinesProps): ReactElement {
  const isMac = isMacPlatform(navigator.platform);
  return (
    <div className="text-xs text-muted-foreground">
      <p>{describeKeymapPrefix(keymap, source, isMac)}</p>
      <p>{describeSource(source)}</p>
    </div>
  );
}

interface HelpBodyProps {
  settings: Settings;
  keymap: Keymap;
  bodyRef: RefObject<HTMLDivElement | null>;
}

interface HelpProps {
  settings: Settings;
  keymap: Keymap | null;
  source: TmuxSource | null;
}

// Shown while the keys are not known. In the drawer of a narrow window the
// cursor then goes onto the dialog itself, so that it still takes the keys
// that close it.
function KeysNotKnown({
  contentRef,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
}): ReactElement {
  useCompactAutoFocus(contentRef);
  return <p className="text-sm text-muted-foreground">{KEYS_NOT_KNOWN_TEXT}</p>;
}

function HelpBody({ settings, keymap, bodyRef }: HelpBodyProps): ReactElement {
  const sections = useMemo(
    () => describeKeymap(keymap, settings, isMacPlatform(navigator.platform)),
    [keymap, settings],
  );
  useCompactAutoFocus(bodyRef);

  return (
    <div
      ref={bodyRef}
      role="region"
      aria-label="Key list"
      tabIndex={0}
      className="max-h-[70dvh] min-h-0 overflow-y-auto outline-none"
    >
      <div className="sm:columns-2 sm:gap-8">
        {sections.map((section) => (
          <HelpSectionView key={section.title} section={section} />
        ))}
      </div>
    </div>
  );
}

export function Help({ settings, keymap, source }: HelpProps): ReactElement {
  const isOpen = useUiState((state) => state.helpOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus(isOpen);
  const positionStyle = useDialogPositionStyle(isOpen, MAX_WIDTH_PX);
  useFocusWhenReopened(isOpen, contentRef, bodyRef, returnFocus);
  const isKnown = keymap !== null && source !== null;

  // Escape is left to the dialog, which closes on it, and Tab and Enter to
  // the browser, which moves the cursor on Tab and presses the button that
  // has the cursor on Enter. None of them knows the key that a terminal sends
  // as Escape, Tab or Enter, so what that key does is done here.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const stroke = keyStrokeFromEvent(event);
    if (stroke === null || stroke === "Escape") return;
    const key = LIST_KEYS.has(stroke) ? stroke : (terminalKeyOf(stroke) ?? stroke);
    if (key === "Tab" && stroke !== "Tab") {
      event.preventDefault();
      focusNextTabStop(event.currentTarget);
      return;
    }
    if (key === "Enter" && stroke !== "Enter") {
      if (pressFocusedButton(event.currentTarget)) event.preventDefault();
      return;
    }
    const command = LIST_KEYS.get(key);
    if (command === undefined) return;
    if (command === "leave") {
      event.preventDefault();
      closeHelp();
      return;
    }
    if (bodyRef.current === null) return;
    const target = scrollTarget(bodyRef.current, command, settings.scrollStepPx);
    if (target === null) return;
    event.preventDefault();
    bodyRef.current.scrollTop = target;
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeHelp();
      }}
    >
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className={CONTENT_CLASS}
        style={positionStyle}
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.remember();
          const target = bodyRef.current ?? contentRef.current;
          target?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle>Tmux keys</DialogTitle>
        <DialogDescription>{DESCRIPTION}</DialogDescription>
        <p className="text-xs text-muted-foreground">{TERMINAL_KEYS_NOTE}</p>
        {isOpen && isKnown ? (
          <SourceLines keymap={keymap} source={source} />
        ) : null}
        {isOpen && isKnown ? (
          <HelpBody settings={settings} keymap={keymap} bodyRef={bodyRef} />
        ) : null}
        {isOpen && !isKnown ? <KeysNotKnown contentRef={contentRef} /> : null}
      </DialogContent>
    </Dialog>
  );
}
