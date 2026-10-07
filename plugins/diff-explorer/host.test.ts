import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "./host";
import type { FileAction } from "./contract";

test("file actions delete only files and append literal, idempotent local and shared ignore entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "diff-explorer-actions-"));
  const root = path.join(dir, "workspace");
  const outside = path.join(dir, "outside.txt");
  const host = experimental_createHostEntryHarness(entry);
  const act = (file: string, action: FileAction) => host.experimental_call("fileAction", { root, path: file, action });
  try {
    await mkdir(root);
    await promisify(childProcess.execFile)("git", ["init", "--quiet", root]);
    const file = path.join(root, "special [a]*? .txt");
    await writeFile(file, "text");
    await writeFile(outside, "keep");
    await writeFile(path.join(root, ".gitignore"), "existing");
    const exclude = path.join(root, ".git", "info", "exclude");
    await writeFile(exclude, "# existing local rules");
    await Promise.all([act(file, "ignore-local"), act(file, "ignore-local")]);
    const content = await readFile(exclude, "utf8");
    assert.equal(content.split("\n").length, 3);
    assert.ok(content.startsWith("# existing local rules\n/"));
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "existing");
    await promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", path.basename(file)]);
    await assert.rejects(promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "special aZZx .txt"]));
    await mkdir(path.join(root, ".playwright-mcp"));
    await mkdir(path.join(root, "logs"));
    await host.experimental_call("fileAction", { root: path.join(root, "logs"), path: path.join(root, "logs", "local.txt"), action: "ignore-local" });
    assert.ok((await readFile(exclude, "utf8")).includes("/logs/local.txt\n"));
    await promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "logs/local.txt"]);
    await act(file, "ignore");
    assert.ok((await readFile(path.join(root, ".gitignore"), "utf8")).includes(content.split("\n")[1]));
    await mkdir(path.join(root, "local-logs"));
    await mkdir(path.join(root, "local-artifacts"));
    await act(path.join(root, "local-logs", "one.log"), "ignore-local-extension");
    await act(path.join(root, "local-artifacts", "one.log"), "ignore-local-directory");
    const localRules = await readFile(exclude, "utf8");
    const sharedRules = await readFile(path.join(root, ".gitignore"), "utf8");
    assert.ok(localRules.includes("/local-logs/*.log\n") && localRules.includes("/local-artifacts/\n"));
    assert.ok(!sharedRules.includes("local-logs") && !sharedRules.includes("local-artifacts"));
    await promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "local-logs/two.log", "local-artifacts/nested/two.txt"]);
    await assert.rejects(promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "local-logs/two.txt"]));
    await act(path.join(root, "logs", "one.log"), "ignore-extension");
    await promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "logs/two.log"]);
    await assert.rejects(promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", "logs/two.txt"]));
    await assert.rejects(promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", ".playwright-mcp/two.log"]));
    await act(path.join(root, ".playwright-mcp", "one.log"), "ignore-directory");
    await promisify(childProcess.execFile)("git", ["-C", root, "check-ignore", "--", ".playwright-mcp/two.txt"]);
    await assert.rejects(act(file, "ignore-directory"), /whole workspace/);
    await assert.rejects(act(path.join(root, "no-extension"), "ignore-extension"), /no extension/);
    await assert.rejects(act(outside, "delete"), /outside the workspace/);
    await assert.rejects(act(root, "delete"), /root/);
    await mkdir(path.join(root, "folder"));
    await assert.rejects(act(path.join(root, "folder"), "delete"));
    await symlink(dir, path.join(root, "link"));
    await assert.rejects(act(path.join(root, "link", "outside.txt"), "delete"), /outside the workspace/);
    await symlink(outside, path.join(root, "file-link"));
    await act(path.join(root, "file-link"), "delete");
    assert.equal(await readFile(outside, "utf8"), "keep");
    await act(file, "delete");
    await assert.rejects(readFile(file));
    await rm(path.join(root, ".gitignore"));
    await symlink(outside, path.join(root, ".gitignore"));
    await assert.rejects(act(path.join(root, "logs", "one.log"), "ignore-extension"));
    await rm(exclude);
    await symlink(outside, exclude);
    await assert.rejects(act(file, "ignore-local"));
    assert.equal(await readFile(outside, "utf8"), "keep");
  } finally {
    await host.experimental_dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("overlapping stale saves conflict and a failed save does not block the queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "diff-explorer-write-"));
  const file = path.join(dir, "file.txt");
  const host = experimental_createHostEntryHarness(entry);
  const save = (content: string, expected: string) => host.experimental_call("write", { path: file, content, expected });
  try {
    await writeFile(file, "base");
    const results = await Promise.allSettled([save("first", "base"), save("second", "base")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = results.find((result) => result.status === "rejected");
    assert.ok(conflict?.status === "rejected");
    assert.match(conflict.reason.message, /changed on disk/);
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    assert.equal(await readFile(file, "utf8"), winner);

    const recovery = await Promise.allSettled([save("stale", "base"), save("next", winner)]);
    assert.equal(recovery[0].status, "rejected");
    assert.equal(recovery[1].status, "fulfilled");
    assert.equal(await readFile(file, "utf8"), "next");
  } finally {
    await host.experimental_dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("warm opens one file per server and shares the TypeScript server with JavaScript", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "diff-explorer-warm-"));
  const opened: string[] = [];
  const commands: string[][] = [];
  const spawn = mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    commands.push([command, ...args]);
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdin: { write(body: string | Buffer) {
        if (!Buffer.isBuffer(body)) return;
        const message = JSON.parse(body.toString());
        if (message.method === "textDocument/didOpen") opened.push(message.params.textDocument.languageId);
      } },
      kill() { child.emit("exit", 0); },
    });
    setImmediate(() => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      stdout.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    });
    return child;
  });
  syncBuiltinESMExports();
  const host = experimental_createHostEntryHarness(entry);
  try {
    const paths = ["a.ts", "b.js", "c.go", "notes.txt"].map((file) => path.join(dir, file));
    await Promise.all(paths.map((file) => writeFile(file, "text")));
    await host.experimental_call("warm", { root: dir, paths });
    assert.deepEqual(commands, [
      ["npx", "--yes", "--ignore-scripts", "-p", "typescript@5.9.3", "-p", "typescript-language-server@5.1.3", "typescript-language-server", "--stdio"],
      ["gopls"],
    ]);
    assert.deepEqual(opened.sort(), ["go", "typescript"]);
  } finally {
    await host.experimental_dispose();
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});
