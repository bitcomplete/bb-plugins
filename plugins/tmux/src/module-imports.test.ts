import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Loaded {
  modules: string[];
  packages: string[];
}

interface Specifier {
  name: string;
  isTypeOnly: boolean;
}

const ROOT = new URL("../", import.meta.url);
// A static import or a re-export, with either kind of quote, and a module
// that is loaded by a call of import or require.
const IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
// Node hands out a built-in module by its name through this function too.
const BUILTIN_MODULE_LOOKUP = "getBuiltinModule";
const SOURCE_FILE = /\.tsx?$/;
const EXTENSIONS = ["", ".ts", ".tsx"];
// A name that a module exports where it declares it.
const EXPORTED_NAME =
  /^export\s+(?:async\s+)?(?:const|function|type|interface)\s+(\w+)/gm;
// The source files that lie beside src.
const ROOT_FILES = ["app.tsx", "app.test.tsx", "server.ts", "server.test.ts"];

function sourceFile(specifier: string, importer: URL): URL | null {
  for (const extension of EXTENSIONS) {
    const candidate = new URL(specifier + extension, importer);
    const isSource =
      SOURCE_FILE.test(candidate.pathname) &&
      existsSync(candidate) &&
      statSync(candidate).isFile();
    if (isSource) return candidate;
  }
  return null;
}

function specifiersOf(source: string): Specifier[] {
  return Array.from(source.matchAll(IMPORT), ([, typeOnly, named, called]) => ({
    name: named ?? called,
    isTypeOnly: typeOnly !== undefined,
  }));
}

// What runs when the entry module is loaded: the modules of this plugin that
// it imports, directly or through others, and the packages those import.
// Imports of types are left out, because the build drops them.
function loadedBy(entry: string): Loaded {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [new URL(entry, ROOT)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || modules.has(file.href)) continue;
    modules.add(file.href);
    const source = readFileSync(file, "utf8");
    for (const { name: specifier, isTypeOnly } of specifiersOf(source)) {
      if (isTypeOnly) continue;
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      const imported = sourceFile(specifier, file);
      if (imported !== null) pending.push(imported);
    }
  }
  return {
    modules: [...modules].map((href) => href.slice(ROOT.href.length)).sort(),
    packages: [...packages].sort(),
  };
}

// The text of every source file of the plugin, its tests included, by its
// path from the root.
function allSources(): Map<string, string> {
  const inSrc = (readdirSync(new URL("src/", ROOT), { recursive: true }) as string[])
    .filter((name) => SOURCE_FILE.test(name))
    .map((name) => `src/${name.replaceAll("\\", "/")}`);
  return new Map(
    [...ROOT_FILES, ...inSrc].map((file) => [
      file,
      readFileSync(new URL(file, ROOT), "utf8"),
    ]),
  );
}

function exportedNames(source: string): string[] {
  return Array.from(source.matchAll(EXPORTED_NAME), ([, name]) => name);
}

describe("the lookup of what a module loads", () => {
  it.each([
    'import { execFile } from "node:child_process";',
    "import { execFile } from 'node:child_process';",
    'import "node:child_process";',
    'import {\n  execFile,\n  spawn,\n} from "node:child_process";',
    'import * as processes from "node:child_process";',
    'export { execFile } from "node:child_process";',
    'export * from "node:child_process";',
    "export * as processes from 'node:child_process';",
    'const { execFile } = await import("node:child_process");',
    "const processes = import( 'node:child_process' );",
    'const { execFile } = require("node:child_process");',
    'import processes = require("node:child_process");',
  ])("sees the module that %j loads", (source) => {
    expect(specifiersOf(source)).toEqual([
      { name: "node:child_process", isTypeOnly: false },
    ]);
  });

  it.each([
    'import type { ChildProcess } from "node:child_process";',
    'export type { ChildProcess } from "node:child_process";',
  ])("marks %j as types only", (source) => {
    expect(specifiersOf(source)).toEqual([
      { name: "node:child_process", isTypeOnly: true },
    ]);
  });

  it.each([
    'export const NOTE = "node:child_process";',
    'const imported = "x"; export default imported;',
    "important('node:child_process');",
  ])("finds no module in %j", (source) => {
    expect(specifiersOf(source)).toEqual([]);
  });
});

describe("server part", () => {
  const server = loadedBy("server.ts");

  it("loads the tmux config reader, the folder listing, the store of the chosen config file, the parser, the keymap and the rpc contract", () => {
    expect(server.modules).toEqual([
      "server.ts",
      "src/config-file.ts",
      "src/contract.ts",
      "src/folder-listing.ts",
      "src/home-path.ts",
      "src/keys.ts",
      "src/prefix.ts",
      "src/settings.ts",
      "src/tmux-commands.ts",
      "src/tmux-config.ts",
      "src/tmux-defaults.ts",
      "src/tmux-keymap.ts",
      "src/tmux-syntax.ts",
    ]);
  });

  it("uses file reading, directory listing, the home directory and paths from Node, and nothing that could start tmux or any other process", () => {
    expect(server.packages).toEqual([
      "@get-bb/plugin-sdk",
      "node:fs/promises",
      "node:os",
      "node:path",
      "zod",
    ]);
  });

  it("asks Node for no built-in module by its name", () => {
    const sources = server.modules.map((module) =>
      readFileSync(new URL(module, ROOT), "utf8"),
    );

    expect(sources.filter((source) => source.includes(BUILTIN_MODULE_LOOKUP))).toEqual([]);
  });

  it("keeps Node and every package out of the parser and the keymap, so that the page can load them too", () => {
    expect(loadedBy("src/tmux-keymap.ts")).toEqual({
      modules: [
        "src/keys.ts",
        "src/prefix.ts",
        "src/tmux-commands.ts",
        "src/tmux-defaults.ts",
        "src/tmux-keymap.ts",
        "src/tmux-syntax.ts",
      ],
      packages: [],
    });
  });

  it("keeps the stock keys of tmux in a module that loads nothing", () => {
    expect(loadedBy("src/tmux-defaults.ts")).toEqual({
      modules: ["src/tmux-defaults.ts"],
      packages: [],
    });
  });
});

describe("page", () => {
  const page = loadedBy("app.tsx");

  it("loads the lookup of the tmux config, and the parser and the stock keys for when the server gives no answer", () => {
    expect(page.modules).toEqual(
      expect.arrayContaining([
        "src/overlay/tmux-lookup.ts",
        "src/keymap.ts",
        "src/list-keys.ts",
        "src/prefix.ts",
        "src/tmux-commands.ts",
        "src/tmux-defaults.ts",
        "src/tmux-keymap.ts",
        "src/tmux-syntax.ts",
      ]),
    );
  });

  it("imports the rpc contract for its types only, so that zod stays out of the page bundle", () => {
    expect(page.modules).not.toContain("src/contract.ts");
    expect(page.packages).not.toContain("zod");
    expect(page.packages).not.toContain("@get-bb/plugin-sdk");
  });

  it("loads nothing that reads files", () => {
    expect(page.modules).not.toContain("src/tmux-config.ts");
    expect(
      page.packages.filter((name) => name.startsWith("node:")),
    ).toEqual([]);
  });

  it("loads the settings section, its Browse dialog and what tells it of another chosen file", () => {
    expect(page.modules).toEqual(
      expect.arrayContaining([
        "src/config-file-changes.ts",
        "src/section/BrowseDialog.tsx",
        "src/section/ConfigFileSection.tsx",
        "src/section/browse-model.ts",
        "src/section/controls.ts",
      ]),
    );
  });

  it("loads nothing that lists folders or keeps the chosen file, which only the server part does", () => {
    for (const module of [
      "src/config-file.ts",
      "src/folder-listing.ts",
      "src/home-path.ts",
    ]) {
      expect(page.modules).not.toContain(module);
    }
  });
});

describe("the made-up machine of the tests of the settings section", () => {
  it("is loaded by neither the page nor the server", () => {
    expect(loadedBy("app.tsx").modules).not.toContain("src/section/test-support.ts");
    expect(loadedBy("server.ts").modules).not.toContain("src/section/test-support.ts");
  });
});

describe("the made-up tmux configs of the tests", () => {
  it("are loaded by neither the page nor the server", () => {
    expect(loadedBy("app.tsx").modules).not.toContain("src/tmux-test-support.ts");
    expect(loadedBy("server.ts").modules).not.toContain("src/tmux-test-support.ts");
  });
});

describe("the modules of the choice of the config file", () => {
  const sources = allSources();

  function isUsedOutside(module: string, name: string): boolean {
    const word = new RegExp(`\\b${name}\\b`);
    return [...sources].some(([file, source]) => file !== module && word.test(source));
  }

  it("finds the names that a module exports", () => {
    expect(
      exportedNames(
        'export const A = 1;\nexport async function b() {}\nexport function c() {}\nexport type D = string;\nexport interface E {}\nconst F = 2;\n  export const G = 3;',
      ),
    ).toEqual(["A", "b", "c", "D", "E"]);
  });

  it.each([
    "src/config-file-changes.ts",
    "src/config-file.ts",
    "src/folder-listing.ts",
    "src/home-path.ts",
    "src/section/BrowseDialog.tsx",
    "src/section/ConfigFileSection.tsx",
    "src/section/browse-model.ts",
    "src/section/controls.ts",
  ])("%s exports no name that no other file uses", (module) => {
    const names = exportedNames(sources.get(module) ?? "");

    expect(names).not.toEqual([]);
    expect(names.filter((name) => !isUsedOutside(module, name))).toEqual([]);
  });
});
