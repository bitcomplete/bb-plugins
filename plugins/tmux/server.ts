import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  FILE_LOOK_LIMIT_MS,
  storeConfigFile,
  storedConfigFile,
  type ChosenFile,
} from "./src/config-file";
import { rpcContract } from "./src/contract";
import { listFolder } from "./src/folder-listing";
import {
  CONFIG_FILE_CHANGED,
  CONFIG_FILE_LABEL,
  CONFIG_TEXT_LABEL,
  COPY_ON_SELECT_MODES,
  DEFAULT_SETTINGS,
  ENABLED_LABEL,
  NUMBER_RANGES,
  THREAD_ORDER_MODES,
} from "./src/settings";
import {
  canReadConfigFile,
  readTmuxConfig,
  type TmuxConfigChoices,
} from "./src/tmux-config";

// bb stores and shows a number as it was entered, so the settings page has to
// say which values count.
function rangeNote(setting: keyof typeof NUMBER_RANGES): string {
  const { min, max } = NUMBER_RANGES[setting];
  return `${min} to ${max}. A value outside that counts as the nearest allowed one.`;
}

const WINDOWS = "win32";

// With HOME set to an empty text Node answers with that text, and a path in
// it would be looked for in the folder the server runs in. tmux then asks the
// system for the home directory of the user (find_home in tmux.c). null when
// the system does not know one either. Node fails both questions for a user
// that the system has no entry for, which counts as not known as well.
function homeDirectory(): string | null {
  try {
    const home = homedir();
    if (isAbsolute(home)) return home;
    const { homedir: ofUser } = userInfo();
    return isAbsolute(ofUser) ? ofUser : null;
  } catch {
    return null;
  }
}

// tmux looks for "vi" in what follows the last "/" of VISUAL or EDITOR. A
// path of Windows is written with "\", which is part of a file name on
// other systems.
function editorCommand(value: string | undefined): string | undefined {
  if (value === undefined || process.platform !== WINDOWS) return value;
  return value.replaceAll("\\", "/");
}

// Calls that arrive while the same question is under way get its answer. A
// folder on a mount that has stopped answering then keeps one of Node's
// file workers busy, and not one more with every call. For a config file
// the reader sees to that itself, by the path of the file alone: a call
// with another Config text is a question of its own here, and still waits
// for the one read of the file. An answer that was given is not used again.
function sharedWhileUnderWay<Asked, Answer>(
  read: (asked: Asked) => Promise<Answer>,
  keyOf: (asked: Asked) => string,
): (asked: Asked) => Promise<Answer> {
  const underWay = new Map<string, Promise<Answer>>();
  return (asked) => {
    const key = keyOf(asked);
    const running = underWay.get(key);
    if (running !== undefined) return running;
    const started = read(asked).finally(() => underWay.delete(key));
    underWay.set(key, started);
    return started;
  };
}

export default function tmux(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: ENABLED_LABEL,
      description:
        "The plugin handles no key, and copies nothing when you select text with the mouse, until you turn this on.",
      default: DEFAULT_SETTINGS.enabled,
    },
    tmuxConfigText: {
      type: "string",
      label: CONFIG_TEXT_LABEL,
      description:
        `These lines of tmux config are applied on top of whatever is in the config file (the one chosen under ${CONFIG_FILE_LABEL} below, or tmux's usual files), so a line here wins over the same setting or key there. Use it when the machine that runs the bb server does not have your tmux config, or for lines that you want in bb only. Nothing in it is ever run. Example: bind -r H resize-pane -L 5`,
      experimental_multiline: true,
      default: DEFAULT_SETTINGS.tmuxConfigText,
    },
    threadOrder: {
      type: "select",
      label: "Thread order for tmux's window keys",
      description:
        "The order that the keys for a window number, the next window and the previous window go through the threads in. Sidebar order follows the thread list as shown. Recent order puts running threads first, then the thread with the latest activity.",
      options: [...THREAD_ORDER_MODES],
      experimental_optionLabels: {
        sidebar: "Sidebar order",
        recent: "Most recent first",
      },
      default: DEFAULT_SETTINGS.threadOrder,
    },
    scrollStepPx: {
      type: "number",
      label: "Scroll step (px)",
      description: `How far one scroll step of copy mode (tmux's scroll-up and scroll-down) moves the conversation, and how far one line step scrolls the key help. ${rangeNote("scrollStepPx")}`,
      default: DEFAULT_SETTINGS.scrollStepPx,
    },
    copyOnSelect: {
      type: "select",
      label: "Copy thread text on mouse selection",
      description:
        "Copy text you select with the mouse in a conversation as soon as you release the button. The first choice follows tmux: it copies when your tmux config turns the mouse option on.",
      options: [...COPY_ON_SELECT_MODES],
      experimental_optionLabels: {
        auto: "Follow tmux's mouse option",
        on: "On",
        off: "Off",
      },
      default: DEFAULT_SETTINGS.copyOnSelect,
    },
    resizeCellPx: {
      type: "number",
      label: "Pane resize cell (px)",
      description: `How many pixels one cell of tmux's resize-pane is worth. tmux resizes by terminal cells, and bb's panes are measured in pixels. ${rangeNote("resizeCellPx")}`,
      default: DEFAULT_SETTINGS.resizeCellPx,
    },
  });

  const readConfig = sharedWhileUnderWay(
    (choices: TmuxConfigChoices) =>
      readTmuxConfig(
        { homeDir: homeDirectory(), xdgConfigHome: process.env.XDG_CONFIG_HOME },
        {
          visual: editorCommand(process.env.VISUAL),
          editor: editorCommand(process.env.EDITOR),
        },
        choices,
      ),
    (choices) => JSON.stringify([choices.path, choices.text]),
  );
  const listFolderShared = sharedWhileUnderWay(
    (path: string) => listFolder(path, homeDirectory()),
    (path) => path,
  );
  const canRead = sharedWhileUnderWay(
    (path: string) => canReadConfigFile(path, homeDirectory()),
    (path) => path,
  );

  // A look that takes longer than the limit, as on a mount that has stopped
  // answering, counts as a file that cannot be read right now, so that the
  // settings section still shows the choice and the way to another one.
  function canReadInTime(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), FILE_LOOK_LIMIT_MS);
      canRead(path)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  async function chosenFile(): Promise<ChosenFile | null> {
    const path = await storedConfigFile(bb.storage.kv);
    if (path === null) return null;
    return { path, readable: await canReadInTime(path) };
  }

  // A call must not fail any more once the choice is stored, or the page
  // would say that nothing was stored: a look at the file that fails counts
  // as a file that cannot be read.
  function canReadStoredFile(path: string): Promise<boolean> {
    return canReadInTime(path).catch((error: unknown) => {
      bb.log.warn(`the look at the chosen config file failed: ${String(error)}`);
      return false;
    });
  }

  // The answer to a choice that was stored a moment ago. Another choice can
  // be stored while the file is looked at, and the page shows what the
  // answer names: it names the file that is chosen by then.
  async function fileJustStored(path: string | null): Promise<ChosenFile | null> {
    if (path === null) return null;
    const readable = await canReadStoredFile(path);
    const chosenNow = await storedConfigFile(bb.storage.kv).catch(() => path);
    if (chosenNow === path) return { path, readable };
    if (chosenNow === null) return null;
    return { path: chosenNow, readable: await canReadStoredFile(chosenNow) };
  }

  // Every bb window is told only after the choice was stored, so that a
  // window that asks at once gets the keys of the new choice. A window that
  // is not told asks when it loads.
  function tellWindowsOfChoice(): void {
    try {
      bb.realtime.publish(CONFIG_FILE_CHANGED, {});
    } catch (error) {
      bb.log.warn(`the bb windows were not told of the chosen config file: ${String(error)}`);
    }
  }

  bb.rpc.register(rpcContract, {
    tmuxConfig: async () => {
      const [path, { tmuxConfigText }] = await Promise.all([
        storedConfigFile(bb.storage.kv),
        settings.get(),
      ]);
      return readConfig({ path: path ?? "", text: tmuxConfigText });
    },
    listFolder: ({ path }) => listFolderShared(path),
    configFile: async () => ({ file: await chosenFile() }),
    setConfigFile: async ({ path }) => {
      const isStored = await storeConfigFile(bb.storage.kv, path);
      if (!isStored) return { ok: false as const, reason: "not-absolute" as const };
      tellWindowsOfChoice();
      return { ok: true as const, file: await fileJustStored(path) };
    },
  });
}
