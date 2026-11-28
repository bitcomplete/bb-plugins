import {
  BB_CONTEXT_KEYS,
  BB_DESKTOP_GLOBAL,
  BB_PLATFORM_CONTEXT_KEYS,
} from "./constants";

export interface AppShortcut {
  key: string;
  mod: boolean;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export interface AppKeybinding {
  command: string;
  desktopOnly: boolean;
  shortcut: AppShortcut;
  when: { all: readonly string[]; none: readonly string[] };
}

export interface ClientEnv {
  isDesktop: boolean;
  platform: string;
}

export type CoreCommandResult = "ran" | "unbound" | "declined";

type DesktopHost = Window & { [BB_DESKTOP_GLOBAL]?: unknown };

type KeyboardPlatform = keyof typeof BB_PLATFORM_CONTEXT_KEYS;

const KEYBOARD_PLATFORMS = Object.keys(
  BB_PLATFORM_CONTEXT_KEYS,
) as KeyboardPlatform[];

let keybindings: readonly AppKeybinding[] | null = null;
const syntheticEvents = new WeakSet<Event>();

export function setKeybindings(bindings: readonly AppKeybinding[] | null): void {
  keybindings = bindings;
}

function isDesktopApp(): boolean {
  return ((window as DesktopHost)[BB_DESKTOP_GLOBAL] ?? null) !== null;
}

export function getClientEnv(): ClientEnv {
  return { isDesktop: isDesktopApp(), platform: navigator.platform };
}

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/u.test(platform);
}

function keyboardPlatform(platform: string): KeyboardPlatform {
  if (isMacPlatform(platform) || platform === "darwin" || platform === "mac") {
    return "mac";
  }
  return /Win|windows|win32/u.test(platform) ? "windows" : "linux";
}

function isBindingAvailable(binding: AppKeybinding, env: ClientEnv): boolean {
  const { all, none } = binding.when;
  if (binding.desktopOnly && !env.isDesktop) return false;
  if (all.includes(BB_CONTEXT_KEYS.webSurface) && env.isDesktop) return false;
  if (none.includes(BB_CONTEXT_KEYS.webSurface) && !env.isDesktop) return false;
  const platform = keyboardPlatform(env.platform);
  for (const candidate of KEYBOARD_PLATFORMS) {
    const context = BB_PLATFORM_CONTEXT_KEYS[candidate];
    if (all.includes(context) && platform !== candidate) return false;
    if (none.includes(context) && platform === candidate) return false;
  }
  return true;
}

export function findBinding(
  command: string,
  env: ClientEnv = getClientEnv(),
): AppKeybinding | null {
  if (keybindings === null) return null;
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const candidate = keybindings[index];
    if (candidate === undefined || candidate.command !== command) continue;
    if (!isBindingAvailable(candidate, env)) continue;
    return candidate;
  }
  return null;
}

function codeForKey(key: string): string | null {
  if (/^[a-z]$/iu.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/u.test(key)) return `Digit${key}`;
  return null;
}

export function buildKeydownInit(
  shortcut: AppShortcut,
  isMac: boolean,
): KeyboardEventInit {
  const init: KeyboardEventInit = {
    key: shortcut.key,
    metaKey: shortcut.meta || (shortcut.mod && isMac),
    ctrlKey: shortcut.control || (shortcut.mod && !isMac),
    altKey: shortcut.alt,
    shiftKey: shortcut.shift,
    bubbles: true,
    cancelable: true,
  };
  const code = codeForKey(shortcut.key);
  if (code !== null) init.code = code;
  return init;
}

export function markPluginSyntheticEvent<T extends Event>(event: T): T {
  syntheticEvents.add(event);
  return event;
}

export function isPluginSyntheticEvent(event: Event): boolean {
  return syntheticEvents.has(event);
}

// bb has no API to run a core command by id. Its shortcut handler listens on
// window in the bubble phase, never checks isTrusted and calls preventDefault
// only when a command ran, so a keydown matching the command's binding runs it.
export function runCoreCommand(command: string): CoreCommandResult {
  const env = getClientEnv();
  const binding = findBinding(command, env);
  if (binding === null) return "unbound";
  const event = new KeyboardEvent(
    "keydown",
    buildKeydownInit(binding.shortcut, isMacPlatform(env.platform)),
  );
  syntheticEvents.add(event);
  document.body.dispatchEvent(event);
  return event.defaultPrevented ? "ran" : "declined";
}
