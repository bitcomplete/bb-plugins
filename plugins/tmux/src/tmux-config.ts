import { open, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { absolutePathOf } from "./home-path";
import { CONFIG_TEXT_NAME } from "./settings";
import {
  tmuxConfigFrom,
  type PastedText,
  type TmuxConfig,
  type TmuxConfigFile,
  type TmuxEditorEnvironment,
} from "./tmux-keymap";

// homeDir: null when the home directory of the server's user is not known,
// so that no file is looked for in it.
export interface TmuxConfigLocations {
  homeDir: string | null;
  xdgConfigHome: string | undefined;
}

// What the user chose, empty when nothing was. path is the config file chosen
// in the plugin's settings, the one file that is read in the place of tmux's
// own, as the plugin's storage holds it: no blank of it is dropped, because
// the name of a file can end in one. text holds the lines of the Config text
// setting, which are applied after the files.
export interface TmuxConfigChoices {
  path: string;
  text: string;
}

// missing: no file is there, so tmux has nothing to load either. skipped: a
// file is there, but this process may not read it, or it is too large.
type ConfigRead =
  | { kind: "read"; realPath: string; text: string }
  | { kind: "missing" }
  | { kind: "skipped" };

// unreadable: a file that is there, or the chosen one, could not be read. The
// user is only told that there is one: its name stays out of the answer.
interface ConfigFiles {
  files: TmuxConfigFile[];
  unreadable: boolean;
}

export const MAX_CONFIG_BYTES = 1024 * 1024;

const MISSING_FILE_ERRORS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

const LINE_BREAK = "\n";

// The user's own files in the order tmux loads them. tmux loads its system
// file first, but where that file is depends on how tmux was built.
export function tmuxConfigPaths({
  homeDir,
  xdgConfigHome,
}: TmuxConfigLocations): string[] {
  const paths = homeDir === null ? [] : [join(homeDir, ".tmux.conf")];
  if (xdgConfigHome !== undefined && xdgConfigHome !== "") {
    paths.push(join(xdgConfigHome, "tmux", "tmux.conf"));
  }
  if (homeDir !== null) paths.push(join(homeDir, ".config", "tmux", "tmux.conf"));
  return [...new Set(paths)];
}

function displayPath(path: string, homeDir: string | null): string {
  if (homeDir === null) return path;
  const home = resolve(homeDir);
  const absolute = resolve(path);
  if (!absolute.startsWith(home + sep)) return path;
  return `~${absolute.slice(home.length)}`;
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_FILE_ERRORS.has(code);
}

// What the file holds, null for one that holds more than the limit. No more
// than one byte past the limit is read: a file can grow after the look at
// its size, and some (those of /proc) say that they are empty and go on
// without an end.
async function readUpToLimit(path: string): Promise<Buffer | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.byteLength - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_CONFIG_BYTES ? null : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// The size is checked before the read, so that a huge file is not opened.
async function readConfigNow(path: string): Promise<ConfigRead> {
  try {
    const realPath = await realpath(path);
    const info = await stat(realPath);
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > MAX_CONFIG_BYTES) return { kind: "skipped" };
    const data = await readUpToLimit(realPath);
    if (data === null) return { kind: "skipped" };
    return { kind: "read", realPath, text: data.toString("utf8") };
  } catch (error) {
    return { kind: isMissingFileError(error) ? "missing" : "skipped" };
  }
}

const readsUnderWay = new Map<string, Promise<ConfigRead>>();

// A call that arrives while a read of the same path is under way gets the
// answer of that read, whoever asks and whatever the Config text is. A file
// on a mount that has stopped answering then keeps one of Node's file
// workers busy, and not one more with every call. A read that has ended is
// not used again.
function readConfig(path: string): Promise<ConfigRead> {
  const running = readsUnderWay.get(path);
  if (running !== undefined) return running;
  const started = readConfigNow(path).finally(() => readsUnderWay.delete(path));
  readsUnderWay.set(path, started);
  return started;
}

// Reads the files anew for every call that finds no read of them under way,
// and starts no process. Two names for one file (a symbolic link) count
// once, as they do in tmux.
async function readConfigFiles(
  locations: TmuxConfigLocations,
): Promise<ConfigFiles> {
  const files: TmuxConfigFile[] = [];
  let unreadable = false;
  const seen = new Set<string>();
  for (const path of tmuxConfigPaths(locations)) {
    const config = await readConfig(path);
    if (config.kind === "skipped") unreadable = true;
    if (config.kind !== "read" || seen.has(config.realPath)) continue;
    seen.add(config.realPath);
    files.push({
      path: displayPath(path, locations.homeDir),
      text: config.text,
    });
  }
  return { files, unreadable };
}

// The one file that was chosen in the plugin's settings. The user asked for
// this file, so one that is missing counts as one that could not be read, as
// does a path that is not absolute.
async function readNamedFile(
  path: string,
  homeDir: string | null,
): Promise<ConfigFiles> {
  const absolute = absolutePathOf(path, homeDir);
  if (absolute === null) return { files: [], unreadable: true };
  const config = await readConfig(absolute);
  if (config.kind !== "read") return { files: [], unreadable: true };
  const shown = displayPath(absolute, homeDir);
  return { files: [{ path: shown, text: config.text }], unreadable: false };
}

// The lines count like a file: over the size limit of one they are not read.
// The last one is a whole line as well, which the setting can hold without
// a line break behind it. tmux reads a line differently where a file ends
// with it: it refuses a "$" there.
function pastedTextFrom(text: string): PastedText {
  if (text.trim() === "") return { state: "none" };
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    return { state: "unreadable" };
  }
  const lines = text.endsWith(LINE_BREAK) ? text : text + LINE_BREAK;
  return { state: "applied", lines: { path: CONFIG_TEXT_NAME, text: lines } };
}

// Whether the chosen file is one that readTmuxConfig gets the text of right
// now. It goes through the same read, so the two never disagree about a file
// that is missing, too large, no regular file or closed to the bb server.
export async function canReadConfigFile(
  path: string,
  homeDir: string | null,
): Promise<boolean> {
  const absolute = absolutePathOf(path, homeDir);
  if (absolute === null) return false;
  const config = await readConfig(absolute);
  return config.kind === "read";
}

// Stock tmux with every source that could be read applied to it: the chosen
// file, or else tmux's own files, and then the lines of the Config text
// setting. A source that could not be read does not fail the call: the
// answer says that one was not.
export async function readTmuxConfig(
  locations: TmuxConfigLocations,
  environment: TmuxEditorEnvironment,
  choices: TmuxConfigChoices,
): Promise<TmuxConfig> {
  const namedFile = choices.path.trim() !== "";
  const { files, unreadable } = namedFile
    ? await readNamedFile(choices.path, locations.homeDir)
    : await readConfigFiles(locations);
  return tmuxConfigFrom(
    {
      files,
      unreadable,
      namedFile,
      pastedText: pastedTextFrom(choices.text),
    },
    environment,
  );
}
