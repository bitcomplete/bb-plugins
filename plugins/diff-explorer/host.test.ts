import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "./host";

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
  const commands: string[] = [];
  const spawn = mock.method(childProcess, "spawn", (command: string) => {
    commands.push(command);
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
    assert.deepEqual(commands, ["npx", "gopls"]);
    assert.deepEqual(opened.sort(), ["go", "typescript"]);
  } finally {
    await host.experimental_dispose();
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});
