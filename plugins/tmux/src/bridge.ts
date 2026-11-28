import { noteLayout, resetHistory } from "./history";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import type { Bridge, UiState } from "./types";

const INITIAL_UI_STATE: UiState = {
  chooser: { open: false },
  helpOpen: false,
  prefixArmed: false,
  prefixArmedBy: null,
  paused: false,
  switchState: "unknown",
  notice: null,
  copyMode: { active: false },
};

let bridge: Bridge | null = null;
let uiState: UiState = INITIAL_UI_STATE;
let noticeCounter = 0;
const uiListeners = new Set<() => void>();

export function getBridge(): Bridge | null {
  return bridge;
}

// The bridge is taken away when the plugin is switched off. What bb shows and
// focuses meanwhile is not seen, so what was remembered is dropped with it.
export function setBridge(next: Bridge | null): void {
  bridge = next;
  if (next === null) {
    resetHistory();
    return;
  }
  noteLayout(next.layout, next.context.threadId);
}

export function getSettings(): Settings {
  return bridge?.settings ?? DEFAULT_SETTINGS;
}

export function getUiState(): UiState {
  return uiState;
}

export function subscribeUiState(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => {
    uiListeners.delete(listener);
  };
}

export function updateUiState(patch: Partial<UiState>): void {
  const keys = Object.keys(patch) as (keyof UiState)[];
  const changed = keys.some((key) => patch[key] !== uiState[key]);
  if (!changed) return;
  uiState = { ...uiState, ...patch };
  for (const listener of uiListeners) listener();
}

export function showNotice(text: string): void {
  noticeCounter += 1;
  updateUiState({ notice: { id: noticeCounter, text } });
}

export function resetStore(): void {
  bridge = null;
  uiState = INITIAL_UI_STATE;
  noticeCounter = 0;
  uiListeners.clear();
  resetHistory();
}
