import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ConfigFileChange, ConfigFileChoice } from "./config-file";
import type { FolderListing } from "./folder-listing";
import type { TmuxConfig } from "./tmux-keymap";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

const tmuxPrefix = z.object({
  key: z.string(),
  path: z.string(),
  usable: z.boolean(),
});

const direction = z.enum(["left", "down", "up", "right"]);
const placement = z.enum(["replace", "right", "down"]);
const step = z.union([z.literal(1), z.literal(-1)]);
const count = z.number().int().min(1);
const copyMotion = z.enum([
  "char-left",
  "char-right",
  "line-up",
  "line-down",
  "word-forward",
  "word-back",
  "word-end",
  "line-start",
  "line-indent",
  "line-end",
  "paragraph-back",
  "paragraph-forward",
  "document-start",
  "document-end",
  "screen-top",
  "screen-middle",
  "screen-bottom",
  "half-page-up",
  "half-page-down",
  "page-up",
  "page-down",
]);

const tmuxAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pane.focus"), direction }),
  z.object({ type: z.literal("pane.neighbour"), direction }),
  z.object({ type: z.literal("pane.next") }),
  z.object({ type: z.literal("pane.previous") }),
  z.object({ type: z.literal("pane.last") }),
  z.object({ type: z.literal("pane.resize"), direction, cells: count }),
  z.object({ type: z.literal("pane.zoom") }),
  z.object({ type: z.literal("pane.close") }),
  z.object({ type: z.literal("chooser.open"), placement }),
  z.object({ type: z.literal("thread.new") }),
  z.object({ type: z.literal("thread.jump"), index: count }),
  z.object({ type: z.literal("thread.end") }),
  z.object({ type: z.literal("thread.cycle"), delta: step }),
  z.object({ type: z.literal("thread.last") }),
  z.object({ type: z.literal("help.open") }),
  z.object({ type: z.literal("prefix.send"), second: z.boolean() }),
  z.object({ type: z.literal("config.reload") }),
  z.object({ type: z.literal("notice.show"), text: z.string() }),
  z.object({ type: z.literal("copy.enter"), motion: copyMotion.nullable() }),
  z.object({ type: z.literal("copy.move"), motion: copyMotion }),
  z.object({ type: z.literal("copy.scroll"), direction: step }),
  z.object({ type: z.literal("copy.beginSelection") }),
  z.object({ type: z.literal("copy.clearSelection") }),
  z.object({
    type: z.literal("copy.yank"),
    after: z.enum(["exit", "clear", "keep"]),
  }),
  z.object({ type: z.literal("copy.exit") }),
]);

const tmuxKeyBinding = z.object({
  key: z.string(),
  repeat: z.boolean(),
  actions: z.array(tmuxAction),
});

const tmuxConfig = z.object({
  options: z.object({
    prefix: tmuxPrefix.nullable(),
    prefix2: tmuxPrefix.nullable(),
    modeKeys: z.enum(["vi", "emacs"]),
    mouse: z.boolean(),
    repeatTimeMs: z.number().int().min(0),
    prefixTimeoutMs: z.number().int().min(0),
    baseIndex: z.number().int().min(0),
  }),
  tables: z.object({
    prefix: z.array(tmuxKeyBinding),
    root: z.array(tmuxKeyBinding),
    copyMode: z.array(tmuxKeyBinding),
    copyModeVi: z.array(tmuxKeyBinding),
  }),
  files: z.array(z.string()),
  unreadable: z.boolean(),
  namedFile: z.boolean(),
  pastedText: z.enum(["none", "applied", "unreadable"]),
});

// Does not compile once the answer that zod lets through and the keymap that
// the pure modules build are no longer the same type.
export type TmuxConfigAnswer = Assert<
  Same<z.infer<typeof tmuxConfig>, TmuxConfig>
>;

// Longer than any path that a system takes, and short enough for the row of
// the storage that holds one.
const MAX_PATH_LENGTH = 4096;

const givenPath = z.string().max(MAX_PATH_LENGTH);

const folderEntry = z
  .object({ name: z.string(), kind: z.enum(["folder", "file"]) })
  .strict();

const folderListing = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(folderEntry),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        "not-absolute",
        "missing",
        "is-a-file",
        "not-a-folder",
        "unreadable",
      ]),
      path: z.string().nullable(),
      parent: z.string().nullable(),
    })
    .strict(),
]);

const chosenFile = z
  .object({ path: z.string(), readable: z.boolean() })
  .strict();

const configFileChoice = z.object({ file: chosenFile.nullable() }).strict();

const configFileChange = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), file: chosenFile.nullable() }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal("not-absolute") }).strict(),
]);

export type FolderListingAnswer = Assert<
  Same<z.infer<typeof folderListing>, FolderListing>
>;
export type ConfigFileChoiceAnswer = Assert<
  Same<z.infer<typeof configFileChoice>, ConfigFileChoice>
>;
export type ConfigFileChangeAnswer = Assert<
  Same<z.infer<typeof configFileChange>, ConfigFileChange>
>;

// The page imports this file for its types only, so that zod stays out of the
// page bundle.
// listFolder: the folders and the regular files of one folder of the machine
// that the bb server runs on. configFile: the config file chosen in the
// plugin's settings. setConfigFile: chooses one, and null goes back to tmux's
// usual files.
export const rpcContract = defineRpcContract({
  tmuxConfig: {
    input: z.null(),
    output: tmuxConfig,
  },
  listFolder: {
    input: z.object({ path: givenPath }).strict(),
    output: folderListing,
  },
  configFile: {
    input: z.null(),
    output: configFileChoice,
  },
  setConfigFile: {
    input: z.object({ path: givenPath.nullable() }).strict(),
    output: configFileChange,
  },
});
