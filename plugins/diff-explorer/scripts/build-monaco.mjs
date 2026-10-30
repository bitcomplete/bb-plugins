import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, version as esbuildVersion } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const monaco = path.join(root, "node_modules/monaco-editor");
const editor = path.join(monaco, "esm/vs/editor");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const installed = JSON.parse(await readFile(path.join(monaco, "package.json"), "utf8"));
assert.equal(installed.version, pkg.dependencies["monaco-editor"], "Installed Monaco must match its exact package pin");
assert.equal(esbuildVersion, pkg.dependencies.esbuild, "Installed esbuild must match its exact package pin");
// BB omits optional packages and npm scripts. esbuild's pinned installer supplies and verifies its platform binary.
const require = createRequire(import.meta.url);
await promisify(execFile)(process.execPath, [path.join(path.dirname(require.resolve("esbuild/package.json")), "install.js")], { maxBuffer: 1024 * 1024 });

// Keep syntax highlighting and editor contributions; host language servers replace Monaco's language workers.
const contents = (await readFile(path.join(editor, "editor.main.js"), "utf8")).split("\n")
  .filter((line) => !/languages\/features\/|__src_languages_features|monaco-lsp-client|index as lsp/.test(line)).join("\n")
  + `\nexport * as monaco from ${JSON.stringify(path.join(editor, "editor.api.js"))};`
  + `\nexport { createMultiDiffEditor } from ${JSON.stringify(path.join(root, "scripts/multi-diff.js"))};\n`;
const output = path.join(root, "monaco");
// Build completely before replacing assets that a running panel may still be using.
const staging = await mkdtemp(path.join(root, "node_modules/.monaco-build-"));
try {
  const options = { bundle: true, format: "esm", minify: true, logLevel: "warning" };
  await build({
    ...options,
    stdin: { contents, resolveDir: editor, sourcefile: ".monaco-entry.js", loader: "js" },
    loader: { ".ttf": "file" },
    // BB's File Editor overwrites the shared MonacoEnvironment global.
    define: { "globalThis.MonacoEnvironment": "globalThis.DiffExplorerMonacoEnvironment" },
    outfile: path.join(staging, "editor.js"),
  });
  await build({ ...options, entryPoints: [path.join(editor, "editor.worker.js")], outfile: path.join(staging, "editor.worker.js") });
  for (const name of ["LICENSE", "ThirdPartyNotices.txt"]) await cp(path.join(monaco, name), path.join(staging, name));
  for (const name of ["editor.js", "editor.css", "editor.worker.js", "LICENSE", "ThirdPartyNotices.txt"]) {
    assert.ok((await stat(path.join(staging, name))).size > 0, `Missing Monaco asset: ${name}`);
  }
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`Built Monaco ${installed.version} assets with esbuild ${esbuildVersion}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
