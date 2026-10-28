// BB-98: Tailwind's source scanner does not extract a utility that is glued to
// a template substitution (`bg-amber-400${transition}`), so no rule is emitted
// and the element renders without that class. Every class template literal
// needs a space before `${`. This guard fails if one is missing, so the
// invisible unread "you" dot and the lost dark-mode phrase colour cannot come
// back.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

// A class-ish token ending in a class character and glued to `${`. The token
// must contain a hyphen and an alphanumeric, which keeps the plugin's other
// template literals (paths, keys, dates) out without a full parser.
const GLUED = /[\s`"'(]([A-Za-z0-9_:/[\].-]*[A-Za-z0-9_/\]\)])\$\{/g;

const isUtility = (token: string): boolean => token.includes("-") && /[A-Za-z0-9]/.test(token);

/** Every non-test `.ts`/`.tsx` file in the plugin, with an absolute path. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Each glued utility in the plugin source, as `<file>:<line>: <token>${`. */
function gluedUtilities(): string[] {
  const found: string[] = [];
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(GLUED)) {
      if (!isUtility(match[1])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      found.push(`${relative(root, path).split(sep).join("/")}:${line}: ${match[1]}\${`);
    }
  }
  return found;
}

describe("class template literals", () => {
  it("flags a glued utility and not a spaced one", () => {
    expect([..."`bg-amber-400${transition}`".matchAll(GLUED)].map((m) => m[1])).toEqual(["bg-amber-400"]);
    expect([..."`bg-amber-400 ${transition}`".matchAll(GLUED)]).toEqual([]);
    expect([..."`border-2 ${border} ${transition}`".matchAll(GLUED)]).toEqual([]);
  });

  it("never glues a utility to a template substitution", () => {
    expect(gluedUtilities()).toEqual([]);
  });
});

describe("built stylesheet", () => {
  // `bb plugin build` writes dist/app.css; when it has been run, check that
  // Tailwind actually emitted every glyph and phrase colour (BB-98).
  const builtCss = join(root, "dist", "app.css");
  it.skipIf(!existsSync(builtCss))("emits the sidebar glyph and phrase colours", () => {
    const css = readFileSync(builtCss, "utf8");
    for (const cls of ["bg-amber-400", "border-red-500", "border-blue-500", "text-blue-400"]) {
      expect(css).toContain(cls);
    }
    expect(css).toMatch(/border-muted-foreground\\?\/50/);
  });
});
