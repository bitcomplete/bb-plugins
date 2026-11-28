import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rpcContract } from "./contract";
import { PLUGIN_ID } from "./constants";
import { FOLDER_LIMITS } from "./folder-listing";
import { BROWSE_LABEL, USUAL_FILES_LABEL } from "./section/ConfigFileSection";
import { CONFIRM_LABEL } from "./section/BrowseDialog";
import { CONFIG_FILE_CHANGED, CONFIG_FILE_LABEL } from "./settings";

function document(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const README = document("README.md");
const SKILL = document("skills/tmux/SKILL.md");
const OVERVIEW = document("PLUGIN_OVERVIEW.md");
const DOCUMENTS: [string, string][] = [
  ["README.md", README],
  ["skills/tmux/SKILL.md", SKILL],
  ["PLUGIN_OVERVIEW.md", OVERVIEW],
];
const GUIDES = DOCUMENTS.slice(0, 2);

const EM_DASH = String.fromCharCode(0x2014);
const SET_COMMAND = `bb plugin rpc call ${PLUGIN_ID} setConfigFile --input-file`;
const SHOW_COMMAND = `bb plugin rpc call ${PLUGIN_ID} configFile`;

// What a paragraph of a document says, without its line breaks.
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("the documents about the config file", () => {
  it.each(DOCUMENTS)("%s names no setting for the path of the config file", (_name, text) => {
    expect(text).not.toContain("tmuxConfigPath");
    expect(text).not.toContain("Config file setting");
  });

  it.each(GUIDES)("%s says that no setting names the file", (_name, text) => {
    expect(flat(text)).toMatch(/No setting names (?:the file|it)/);
  });

  it.each(GUIDES)("%s gives the commands that show and make the choice without the settings page, with the methods that the server part answers", (_name, text) => {
    expect(Object.keys(rpcContract)).toEqual(
      expect.arrayContaining(["configFile", "setConfigFile", "listFolder"]),
    );
    expect(flat(text)).toContain(SET_COMMAND);
    expect(flat(text)).toContain(SHOW_COMMAND);
    expect(text).toContain('{"path":"~/dotfiles/tmux.conf"}');
    expect(flat(text)).toContain("`null`");
  });

  it.each(GUIDES)("%s says that the server part keeps the path of a choice as it is written", (_name, text) => {
    expect(flat(text)).toMatch(/ke(?:eps it|pt) as written/);
  });

  it.each(GUIDES)("%s says where the file is chosen, by the names that the page shows", (_name, text) => {
    expect(flat(text)).toContain(`"${CONFIG_FILE_LABEL}"`);
    expect(flat(text)).toContain(BROWSE_LABEL);
    expect(flat(text)).toContain(`"${CONFIRM_LABEL}"`);
    expect(flat(text)).toContain(`"${USUAL_FILES_LABEL}"`);
  });

  it.each(GUIDES)("%s says that the dialog lists the machine that runs the bb server, hidden entries too, and where it stops", (_name, text) => {
    expect(flat(text)).toContain("folders and files of the machine that runs the bb server");
    expect(flat(text)).toMatch(/hidden ones (?:included|too)/);
    expect(flat(text)).toMatch(
      new RegExp(`(?:cut after|at most) ${FOLDER_LIMITS.entries} (?:entries|per folder)`),
    );
  });

  it.each(GUIDES)("%s gives the order of the sources: the usual files or the chosen file, then the Config text", (_name, text) => {
    expect(flat(text)).toMatch(
      /stock bindings, (?:then )?the usual files or the chosen file, (?:then the )?pasted lines/,
    );
  });

  it("README.md says in its notes for developers what the methods return", () => {
    const notes = flat(README.slice(README.indexOf("## For developers")));

    for (const part of [
      "`configFile` returns `{ file }`",
      "`{ path, readable }`",
      '`{ ok: false, reason: "not-absolute" }`',
      "`{ ok: true, path, parent, entries, truncated }`",
      "`{ name, kind }`",
      "`{ ok: false, reason, path, parent }`",
      "`bb.storage.kv`",
      `\`${CONFIG_FILE_CHANGED}\``,
    ]) {
      expect(notes).toContain(part);
    }
    for (const reason of ["not-absolute", "missing", "is-a-file", "not-a-folder", "unreadable"]) {
      expect(notes).toContain(`\`${reason}\``);
    }
  });

  it("PLUGIN_OVERVIEW.md says that the config file is browsed for on the machine of the bb server, and that pasted lines go on top", () => {
    expect(flat(OVERVIEW)).toContain(
      "you can browse that server's machine for another config file, and paste config lines that are applied on top",
    );
  });

  it.each(DOCUMENTS)("%s never uses an em dash", (_name, text) => {
    expect(text).not.toContain(EM_DASH);
  });
});
