import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The frontend bundle is built by the *server*, against a production install
 * where `@get-bb/plugin-sdk` has been pruned as a devDependency — and only
 * `@get-bb/plugin-sdk/app` is shimmed for the frontend, never the root. So any
 * runtime import that reaches the SDK root breaks the app build in the image
 * while passing every local check, because local installs keep dev deps.
 *
 * That shipped once: `app.tsx` imported two constants from `contract.ts`, which
 * imports `defineRpcContract` from the SDK root, and the image failed with
 * `Could not resolve "@get-bb/plugin-sdk"`. These tests encode the rule so it
 * cannot happen again without a local failure first.
 */

const read = (name: string) =>
  readFileSync(join(import.meta.dirname, name), "utf8");

/** Modules the frontend bundle is allowed to pull in at runtime. */
const FRONTEND_MODULES = ["app.tsx", "shared.ts", "brief.ts"];

/**
 * Strip comments first: the word "import" inside prose would otherwise anchor a
 * match that runs on into the next real statement.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^[^\n]*?\/\/[^\n]*$/gmu, "");
}

/** `import ... from "<spec>"` statements that are not `import type`. */
function runtimeImports(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const specs: string[] = [];
  const pattern = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const isTypeOnly = match[1] !== undefined;
    const clause = match[2] ?? "";
    const spec = match[3] ?? "";
    if (isTypeOnly) continue;
    // A clause whose every binding is `type X` also erases entirely.
    const bindings = clause
      .replace(/[{}]/gu, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const allTypes =
      bindings.length > 0 && bindings.every((entry) => entry.startsWith("type "));
    if (allTypes) continue;
    specs.push(spec);
  }
  return specs;
}

describe("frontend bundle graph", () => {
  it.each(FRONTEND_MODULES)(
    "%s does not import the SDK root or zod at runtime",
    (name) => {
      const imports = runtimeImports(read(name));
      expect(imports).not.toContain("@get-bb/plugin-sdk");
      expect(imports).not.toContain("zod");
    },
  );

  it("app.tsx imports contract.ts for types only", () => {
    // contract.ts reaches the SDK root, so a runtime import of it would drag
    // the SDK into the app bundle.
    expect(runtimeImports(read("app.tsx"))).not.toContain("./contract.js");
  });

  it("app.tsx gets its runtime constants from shared.ts", () => {
    const source = read("app.tsx");
    expect(source).toMatch(/BRIEFS_CHANGED_CHANNEL[\s\S]*?from "\.\/shared\.js"/u);
  });

  it("shared.ts has no imports at all, so it can never reach the SDK", () => {
    expect(read("shared.ts")).not.toMatch(/^\s*import\s/mu);
  });

  it("the stages have one definition", () => {
    // contract.ts builds its zod enum from shared.ts's list rather than
    // repeating it, so the two can never disagree.
    expect(read("contract.ts")).toMatch(/z\.enum\(BRIEF_STAGES\)/u);
  });
});
