import { useSettings } from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useIsCompactViewport } from "../../components/ui/hooks/use-compact-viewport";
import { getUiState, subscribeUiState } from "../bridge";
import { classifyFocus } from "../focus-context";
import {
  settleDomFocus,
  settleIdleDomFocus,
  takeOwedSettle,
} from "../pane-focus";
import { parseSettings, type Settings } from "../settings";
import type { UiState } from "../types";

type SettingValues = Parameters<typeof parseSettings>[0];

export function useUiState<Selected>(
  select: (state: UiState) => Selected,
): Selected {
  return useSyncExternalStore(subscribeUiState, () => select(getUiState()));
}

function isSameSettings(a: Settings, b: Settings): boolean {
  const keys = Object.keys(a) as (keyof Settings)[];
  return keys.every((key) => a[key] === b[key]);
}

export function useStableSettings(values: SettingValues): Settings {
  const parsed = parseSettings(values);
  const [stable, setStable] = useState(parsed);
  if (isSameSettings(stable, parsed)) return stable;
  setStable(parsed);
  return parsed;
}

export interface PluginSettings {
  settings: Settings;
  isLoaded: boolean;
}

// bb reports no values while it loads them and whenever it cannot read them,
// for example while the server part of the plugin is not running. The defaults
// must not stand in for them, so nothing counts as loaded until values have
// arrived once, and the last values that arrived stay in use after that.
export function usePluginSettings(): PluginSettings {
  const { values } = useSettings();
  const latest = useStableSettings(values);
  const [loaded, setLoaded] = useState<Settings | null>(null);
  if (values === undefined) {
    return { settings: loaded ?? latest, isLoaded: loaded !== null };
  }
  if (loaded !== latest) setLoaded(latest);
  return { settings: latest, isLoaded: true };
}

export interface ReturnFocus {
  remember: () => void;
  take: () => Element | null;
}

// For a dialog that closes without having opened a thread. The element that
// had the cursor before gets it back. A cursor that was on the pane itself or
// on nothing, or whose element is gone, goes into the message box of the pane.
// So does every cursor after a pane move or a thread change that bb finished
// showing while the dialog was open: that move ends in the message box of
// its pane. null means that no dialog had been open.
export function giveFocusBack(element: Element | null): void {
  if (takeOwedSettle()) {
    settleDomFocus();
    return;
  }
  if (element === null) return;
  const canTakeFocus = element instanceof HTMLElement && element.isConnected;
  if (!canTakeFocus || classifyFocus(element) === "normal") {
    settleDomFocus();
    return;
  }
  element.focus({ preventScroll: true });
}

// For a dialog that closes without having remembered where the cursor was,
// as the drawer that the dialog is in a narrow window does: it gives a cursor
// back to the text field it was in by itself, and one that it leaves on the
// pane or on nothing goes into the message box.
function settleAfterForgottenOpening(): void {
  if (takeOwedSettle()) {
    settleDomFocus();
    return;
  }
  settleIdleDomFocus();
}

const TAB_STOP_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";
// The panel of the drawer that the vendored Dialog is in a narrow window.
const DRAWER_SELECTOR = '[role="dialog"]';

function isTabStop(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && !element.matches(":disabled");
}

// What Tab does in a dialog, for a key that stands in for Tab: the cursor
// goes to the next element of the dialog that takes it, and from the last
// one to the first.
export function focusNextTabStop(dialog: HTMLElement): void {
  const stops = Array.from(
    dialog.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR),
  ).filter(isTabStop);
  const at = stops.findIndex((stop) => stop === document.activeElement);
  stops[(at + 1) % stops.length]?.focus();
}

// What Enter does in a dialog, for a key that stands in for Enter: it presses
// the button that has the cursor. False while the cursor is on no button of
// the dialog.
export function pressFocusedButton(dialog: HTMLElement): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLButtonElement)) return false;
  if (!dialog.contains(focused)) return false;
  focused.click();
  return true;
}

// Radix only hands focus back to a DialogTrigger and these dialogs have none,
// so the element that had focus is remembered here and given the focus back
// on close. Only the first remember() of an open dialog counts, because a
// later one would see the dialog's own content. take() hands the element to a
// caller that decides about focus itself.
export function useReturnFocus(isOpen: boolean): ReturnFocus {
  const target = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const hasRemembered = useRef(false);

  const returnFocus = useMemo(
    () => ({
      remember: () => {
        hasRemembered.current = true;
        target.current ??= document.activeElement;
      },
      take: () => {
        const element = target.current;
        target.current = null;
        return element;
      },
    }),
    [],
  );

  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    const isForgotten = wasOpen.current && !hasRemembered.current;
    wasOpen.current = false;
    hasRemembered.current = false;
    const element = returnFocus.take();
    if (isForgotten) {
      settleAfterForgottenOpening();
      return;
    }
    giveFocusBack(element);
  }, [isOpen, returnFocus]);

  return returnFocus;
}

// Radix moves focus into a dialog only when the dialog's content mounts. A
// dialog that is opened again while it still fades out never unmounted, so the
// keys would go to whatever had focus underneath.
export function useFocusWhenReopened(
  isOpen: boolean,
  content: RefObject<HTMLElement | null>,
  target: RefObject<HTMLElement | null>,
  returnFocus: ReturnFocus,
): void {
  useEffect(() => {
    if (!isOpen || content.current === null) return;
    if (content.current.contains(document.activeElement)) return;
    returnFocus.remember();
    target.current?.focus({ preventScroll: true });
  }, [isOpen, content, target, returnFocus]);
}

// The vendored Dialog keeps its content mounted while it fades out, so a
// dialog that is opened again in that time would go on with the filter text
// and the highlighted row of the last opening. A new React key for every
// opening gives it a fresh body instead.
export function useOpeningKey(isOpen: boolean): number {
  const [wasOpen, setWasOpen] = useState(isOpen);
  const [openingKey, setOpeningKey] = useState(0);
  if (wasOpen === isOpen) return openingKey;
  setWasOpen(isOpen);
  if (!isOpen) return openingKey;
  setOpeningKey(openingKey + 1);
  return openingKey + 1;
}

// On a compact viewport the vendored Dialog is a drawer that ignores
// onOpenAutoFocus and focuses its own panel, so keys would miss the content.
// A click on the strip of the drawer that holds its handle puts the cursor on
// that panel again, and it goes back to the target from there.
export function useCompactAutoFocus(
  target: RefObject<HTMLElement | null>,
): void {
  const isCompact = useIsCompactViewport();
  useEffect(() => {
    if (!isCompact) return;
    const focusTarget = (): void => target.current?.focus({ preventScroll: true });
    focusTarget();
    const drawer = target.current?.closest(DRAWER_SELECTOR) ?? null;
    if (drawer === null) return;
    drawer.addEventListener("focus", focusTarget);
    return () => drawer.removeEventListener("focus", focusTarget);
  }, [isCompact, target]);
}
