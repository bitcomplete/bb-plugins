// Workstreams owns feedback on your own PRs and reads GitHub itself: it never calls another plugin's RPC or HTTP routes, so another
// plugin's install, state, or failure can't change what it shows or does. Its own RPC goes through the SDK's client, which names no route.
import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
/** A plugin's route, as BB mounts them: /api/v1/plugins/<id>/rpc/<method> and /api/v1/plugins/<id>/http/<path>. */
const ROUTE = /\/api\/v1\/plugins\//u;
const SKIP = new Set(["node_modules", "dist"]);

function sources(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sources(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** The bundle `entry` builds, as BB would load it, with every route it names. */
async function routes(entry: { file: string; platform: "browser" | "node" } | { contents: string }): Promise<string[]> {
  const { outputFiles } = await build({
    ...("file" in entry ? { entryPoints: [entry.file], platform: entry.platform } : { stdin: { contents: entry.contents, resolveDir: ROOT, loader: "ts" as const } }),
    absWorkingDir: ROOT, bundle: true, write: false, outdir: "out", format: "esm", jsx: "automatic", logLevel: "silent",
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  });
  return outputFiles.flatMap((file) => file.text.match(new RegExp(`${ROUTE.source}[^\`"'\\s]*`, "gu")) ?? []);
}

describe("plugin isolation", () => {
  it("names no plugin route in any source file", () => {
    const offenders = sources().filter((file) => ROUTE.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("names no plugin route in the app, server, or host bundle", async () => {
    for (const entry of [{ file: "app.tsx", platform: "browser" as const }, { file: "server.ts", platform: "node" as const }, { file: "host.ts", platform: "node" as const }]) {
      expect({ entry: entry.file, routes: await routes(entry) }).toEqual({ entry: entry.file, routes: [] });
    }
  }, 60_000);

  // The check itself: the call Workstreams once made to the Reviews plugin's queue, built as a bundle, is caught.
  it("catches a call to another plugin's RPC in a bundle", async () => {
    expect(await routes({ contents: "export const read = (method: string) => fetch(`/api/v1/plugins/review-watch/rpc/${method}`, { method: \"POST\" });" }))
      .toEqual(["/api/v1/plugins/review-watch/rpc/${method}"]);
  }, 30_000);
});
