// The app bundle runs in BB's browser, where node:* builtins don't exist and
// the SDK root's server helpers can't load. One runtime import of a server
// module anywhere under app.tsx breaks the whole plugin UI, as one import of
// a module that reached node:crypto once did (plan amendment A12.1).
// Type-only imports are erased and never reach the bundle, so they're fine.
import { build, type Metafile } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const BUILTINS = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
/** Server modules the browser must never run: the RPC contract and the server. */
const SERVER_ONLY = ["contract.ts", "server.ts"];

/** Every import in the bundle built from `entry` that the browser can't or mustn't run, naming the file that imports it. */
async function serverReach(entry: { file: string } | { contents: string }): Promise<string[]> {
  const { metafile } = await build({
    ...("file" in entry ? { entryPoints: [entry.file] } : { stdin: { contents: entry.contents, resolveDir: ROOT, loader: "ts" as const } }),
    absWorkingDir: ROOT, bundle: true, write: false, metafile: true, outdir: "out", platform: "browser", format: "esm", jsx: "automatic",
    logLevel: "silent", external: BUILTINS,
  });
  const inputs: Metafile["inputs"] = metafile.inputs;
  const reach: string[] = [];
  for (const [file, input] of Object.entries(inputs)) {
    for (const item of input.imports) {
      if (item.external) reach.push(`${file} imports ${item.path}`);
      else if (item.original === "@get-bb/plugin-sdk") reach.push(`${file} imports the SDK root`);
      else if (SERVER_ONLY.includes(item.path)) reach.push(`${file} imports ${item.path}`);
    }
  }
  return reach.sort();
}

describe("browser bundle", () => {
  it("reaches no builtin, SDK root, or server module from app.tsx", async () => {
    expect(await serverReach({ file: "app.tsx" })).toEqual([]);
  }, 30_000);

  it("names the file behind each kind of server import", async () => {
    const reach = await serverReach({ contents: `import "./contract"; import "./ghactions"; import "@get-bb/plugin-sdk"; import "node:path";` });
    expect(reach).toEqual(expect.arrayContaining([
      "<stdin> imports contract.ts",
      "<stdin> imports the SDK root",
      "<stdin> imports node:path",
      // The break A12.1 reproduced: the GitHub helpers reach node:crypto.
      "ghactions.ts imports node:crypto",
      "contract.ts imports the SDK root",
    ]));
  }, 30_000);
});
