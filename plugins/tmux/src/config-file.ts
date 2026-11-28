import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isFullPath } from "./home-path";

type KeyValueStorage = BbPluginApi["storage"]["kv"];

// The row of the plugin's key-value storage that holds the path of the
// chosen config file. No row stands for tmux's usual files.
export const CONFIG_FILE_STORAGE_KEY = "configFile";

// How long the server part looks at the chosen file for an answer to the
// settings section.
export const FILE_LOOK_LIMIT_MS = 3000;

// path is the path as the person gave it. readable says whether the bb
// server gets the text of that file right now, which it does not for a file
// whose read takes longer than FILE_LOOK_LIMIT_MS.
export interface ChosenFile {
  path: string;
  readable: boolean;
}

// file is null while tmux's usual files are in use.
export interface ConfigFileChoice {
  file: ChosenFile | null;
}

// not-absolute: the path is neither a full path nor one that starts with ~,
// so nothing was stored and the choice is as it was.
export type ConfigFileChange =
  | { ok: true; file: ChosenFile | null }
  | { ok: false; reason: "not-absolute" };

// What the storage holds counts as a path only when it is text with more
// than blanks in it, so a row that something else wrote there stands for no
// choice.
export async function storedConfigFile(
  storage: KeyValueStorage,
): Promise<string | null> {
  const stored = await storage.get<unknown>(CONFIG_FILE_STORAGE_KEY);
  if (typeof stored !== "string" || stored.trim() === "") return null;
  return stored;
}

// null clears the choice. False for a path that cannot be stored. The path
// is stored as it is given: the name of a file can end in a blank.
export async function storeConfigFile(
  storage: KeyValueStorage,
  path: string | null,
): Promise<boolean> {
  if (path === null) {
    await storage.delete(CONFIG_FILE_STORAGE_KEY);
    return true;
  }
  if (!isFullPath(path)) return false;
  await storage.set(CONFIG_FILE_STORAGE_KEY, path);
  return true;
}
