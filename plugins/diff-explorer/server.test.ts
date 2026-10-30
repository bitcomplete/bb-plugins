import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import plugin from "./server";

test("commit launches Haiku in the source environment, scopes the prompt, and prevents overlapping agents across reloads", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  let handlers: Record<string, (input: any) => Promise<any>>;
  let cli: { run(argv: string[], context: object): Promise<{ exitCode: number; stdout?: string; stderr?: string }> };
  const hostCalls: { method: string; input: any; options: any }[] = [];
  const snapshot = { head: "a".repeat(40), branch: "refs/heads/feature", tree: "b".repeat(40), index: "c".repeat(64) };
  const spawns: any[] = [];
  let status = "active";
  let queuedMessageCount = 0;
  let files: any[] = [{ path: "new.ts", previousPath: "old.ts" }, { path: "untracked.ts" }];
  let models = [{ model: "claude-sonnet-test" }, { model: "claude-haiku-test" }];
  let spawnFailure = false;
  let finishError = false;
  let idle: (event: any) => Promise<void>;
  const archived: string[] = [];
  const metadata = new Map<string, any>();
  const idleEvent = (id: string, originPluginId = "diff-explorer") => ({ thread: { id, originPluginId, archivedAt: null } });
  const bb = {
    pluginId: "diff-explorer",
    events: { on(_event: string, handler: typeof idle) { idle = handler; } },
    onInstall() {},
    hosts: { experimental_client: () => ({ experimental_onSignal() {}, async call(method: string, input: any, options: any) {
      hostCalls.push({ method, input, options });
      if (method === "reviewCommit") return { snapshot, diff: "reviewed diff" };
      if (method === "finishCommit") return { commit: "d".repeat(40), pushed: finishError ? false : input.push, error: finishError ? "post-commit hook failed" : null };
    } }) },
    cli: { register(value: typeof cli) { cli = value; } },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; } },
    storage: { kv: {
      async get(key: string) {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row === undefined ? undefined : JSON.parse(row.value as string);
      },
      async set(key: string, value: unknown) {
        db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value));
      },
    } },
    sdk: {
      threads: {
        async get({ threadId }: { threadId: string }) {
          return threadId === "source" ? { id: "source", projectId: "project", environmentId: "env" } : { status, queuedMessageCount };
        },
        async getPluginMetadata({ threadId }: { threadId: string }) { return metadata.get(threadId) ?? {}; },
        async updatePluginMetadata({ threadId }: { threadId: string }) { metadata.delete(threadId); },
        async archive({ threadId }: { threadId: string }) { archived.push(threadId); },
        async defaultExecutionOptions() { return { permissionMode: "auto" }; },
        async spawn(args: unknown) {
          spawns.push(args);
          if (spawnFailure) throw new Error("spawn failed");
          metadata.set(`agent-${spawns.length}`, (args as any).pluginMetadata);
          return { id: `agent-${spawns.length}` };
        },
      },
      environments: { async get() { return { path: "/workspace", hostId: "remote-host" }; }, async diffFiles(args: unknown) {
        assert.deepEqual(args, { environmentId: "env", target: "uncommitted" });
        return { outcome: "available", files };
      } },
      providers: { async models(args: unknown) {
        assert.deepEqual(args, { environmentId: "env", providerId: "claude-code" });
        return { providers: [{ id: "claude-code", available: true }], models };
      } },
    },
  } as unknown as BbPluginApi;
  try {
    await plugin(bb);
    const first = handlers!.commit({ threadId: "source", push: false });
    const duplicate = handlers!.commit({ threadId: "source", push: true });
    await assert.rejects(duplicate, /already starting/);
    assert.deepEqual(await first, { threadId: "agent-1" });
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].environment, { type: "reuse", environmentId: "env" });
    assert.equal(spawns[0].parentThreadId, "source");
    assert.equal(spawns[0].projectId, "project");
    assert.equal(spawns[0].providerId, "claude-code");
    assert.equal(spawns[0].model, "claude-haiku-test");
    assert.equal(spawns[0].permissionMode, "auto");
    assert.match(spawns[0].prompt, /one summary sentence.*two or three sentences in bullet points/);
    assert.match(spawns[0].prompt, /Do not push/);
    assert.match(spawns[0].prompt, /Do not write a snapshot script or a rollback/);
    const jobId = /commit-review ([0-9a-f-]{36})/.exec(spawns[0].prompt)![1];
    assert.deepEqual(spawns[0].pluginMetadata, { commitJobId: jobId });
    await idle!(idleEvent("agent-1")); // A review blocker must stay visible.
    await idle!(idleEvent("source", "another-plugin"));
    assert.deepEqual(archived, []);
    const beforeReview = await cli!.run(["commit-finish", jobId, "--message-file", "/tmp/message.txt"], {});
    assert.equal(beforeReview.exitCode, 1);
    assert.equal(hostCalls.length, 0);
    const review = await cli!.run(["commit-review", jobId], {});
    assert.equal(review.exitCode, 0);
    assert.equal(JSON.parse(review.stdout!).diff, "reviewed diff");
    assert.deepEqual(hostCalls.at(-1), { method: "reviewCommit", input: { root: "/workspace", paths: ["old.ts", "new.ts", "untracked.ts"] }, options: { hostId: "remote-host" } });
    await cli!.run(["commit-review", jobId], {});
    assert.deepEqual(hostCalls.at(-1)!.input.snapshot, snapshot);
    assert.equal((await cli!.run(["commit-finish", jobId, "--message-file", "/tmp/message.txt", "--push"], {})).exitCode, 1);
    const finish = await cli!.run(["commit-finish", jobId, "--message-file", "/tmp/message.txt"], {});
    assert.equal(finish.exitCode, 0);
    assert.equal(JSON.parse(finish.stdout!).pushed, false);
    assert.equal(hostCalls.at(-1)!.input.push, false);
    assert.equal(hostCalls.at(-1)!.input.messageFile, "/tmp/message.txt");
    assert.equal((await cli!.run(["commit-finish", jobId, "--message-file", "/tmp/message.txt"], {})).exitCode, 1);
    assert.equal(hostCalls.filter((call) => call.method === "finishCommit").length, 1);
    assert.deepEqual(archived, []); // The helper finished, but the agent is still reporting.
    await plugin(bb);
    await assert.rejects(handlers!.commit({ threadId: "source", push: false }), /already running/);
    await idle!(idleEvent("agent-1")); // A newer turn may have started while the event was delivered.
    assert.deepEqual(archived, []);
    status = "idle";
    queuedMessageCount = 1;
    await idle!(idleEvent("agent-1"));
    assert.deepEqual(archived, []);
    queuedMessageCount = 0;
    await idle!(idleEvent("agent-1")); // The persisted job still closes after a plugin reload.
    assert.deepEqual(archived, ["agent-1"]);
    await idle!(idleEvent("agent-1")); // Unarchiving and using it again must not auto-close it again.
    assert.deepEqual(archived, ["agent-1"]);
    await assert.rejects(handlers!.commit({ threadId: "source", push: false, paths: ["outside.ts"] }), /currently changed files/);
    await handlers!.commit({ threadId: "source", push: true, paths: ["new.ts"] });
    assert.match(spawns[1].prompt, /pushes the current branch to the same-named remote branch/);
    const pushJobId = /commit-review ([0-9a-f-]{36})/.exec(spawns[1].prompt)![1];
    await cli!.run(["commit-review", pushJobId], {});
    assert.deepEqual(hostCalls.at(-1)!.input.paths, ["old.ts", "new.ts"]);
    assert.equal(JSON.parse((await cli!.run(["commit-finish", pushJobId, "--message-file", "/tmp/message.txt"], {})).stdout!).pushed, true);
    await idle!(idleEvent("agent-2"));
    assert.deepEqual(archived, ["agent-1", "agent-2"]);
    files = [];
    await assert.rejects(handlers!.commit({ threadId: "source", push: false }), /no uncommitted changes/);
    files = [{ path: "main.ts" }];
    models = [];
    await assert.rejects(handlers!.commit({ threadId: "source", push: false }), /Haiku is not available/);
    models = [{ model: "claude-haiku-test" }];
    spawnFailure = true;
    await assert.rejects(handlers!.commit({ threadId: "source", push: false }), /spawn failed/);
    spawnFailure = false;
    assert.ok(await handlers!.commit({ threadId: "source", push: false }));
    const failedJobId = /commit-review ([0-9a-f-]{36})/.exec(spawns.at(-1).prompt)![1];
    await cli!.run(["commit-review", failedJobId], {});
    finishError = true;
    assert.equal((await cli!.run(["commit-finish", failedJobId, "--message-file", "/tmp/message.txt"], {})).exitCode, 1);
    const attempts = hostCalls.filter((call) => call.method === "finishCommit").length;
    await plugin(bb);
    assert.equal((await cli!.run(["commit-finish", failedJobId, "--message-file", "/tmp/message.txt"], {})).exitCode, 1);
    assert.equal(hostCalls.filter((call) => call.method === "finishCommit").length, attempts);
    await idle!(idleEvent(`agent-${spawns.length}`));
    assert.deepEqual(archived, ["agent-1", "agent-2"]); // Failed jobs stay open.
  } finally {
    db.close();
  }
});

test("load routes working and commit diffs, skipping read-root failures while preserving other files and errors", async () => {
  let handlers: Record<string, (input: any) => Promise<any>>;
  const link = ".agents/skills/workers-best-practices";
  let failure = new Error(`HTTP 400: Path "/workspace/${link}" escapes read root`);
  const readPaths: string[] = [];
  const hostCalls: { method: string; input: any }[] = [];
  const sha = "a".repeat(40);
  let selectedTarget = "uncommitted";
  const bb = {
    events: { on() {} },
    onInstall() {},
    hosts: { experimental_client: () => ({
      experimental_onSignal() {},
      async call(method: string, input: unknown) {
        hostCalls.push({ method, input });
        if (method === "definition") return { locations: [] };
        if (method === "commits") return [{ sha, subject: "Recent commit" }];
      },
    }) },
    cli: { register() {} },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; } },
    sdk: {
      threads: { async get() { return { environmentId: "env" }; } },
      environments: {
        async get() { return { path: "/workspace", hostId: "host", defaultBranch: "main" }; },
        async diffFiles(input: unknown) {
          assert.deepEqual(input, selectedTarget === sha ? { environmentId: "env", target: "commit", sha }
            : selectedTarget === "all" ? { environmentId: "env", target: "all", mergeBaseBranch: "main" }
            : { environmentId: "env", target: "uncommitted" });
          return {
            outcome: "available", mergeBaseRef: "base",
            files: [
              { path: link, changeKind: "added", origin: "untracked", additions: 1, deletions: 0 },
              { path: "main.ts", changeKind: "modified", additions: 1, deletions: 1 },
              { path: "image.png", binary: true },
              { path: "huge.txt", loadMode: "too_large" },
            ],
          };
        },
        async diffFile(input: { path: string; side: string; target: string; sha?: string }) {
          const { path, side } = input;
          if (selectedTarget === sha) assert.deepEqual(input, { environmentId: "env", target: "commit", sha, path, side });
          readPaths.push(path);
          if (path === link) throw failure;
          return { contentEncoding: "utf8", content: side === "old" ? "before" : "after" };
        },
      },
    },
  } as unknown as BbPluginApi;
  await plugin(bb);
  assert.deepEqual(await handlers!.commits({ threadId: "thread" }), [{ sha, subject: "Recent commit" }]);
  assert.deepEqual(hostCalls.at(-1), { method: "commits", input: { root: "/workspace" } });
  for (const target of ["uncommitted", "all", sha]) {
    selectedTarget = target;
    const result = rpcContract.load.output.parse(await handlers!.load({ threadId: "thread", target }));
    assert.deepEqual(result.files, [{ path: "main.ts", changeKind: "modified", additions: 1, deletions: 1, oldText: "before", newText: "after" }]);
    assert.deepEqual(result.skipped, ["image.png", "huge.txt", link]);
  }
  assert.ok(readPaths.every((path) => path === link || path === "main.ts"));
  assert.ok(hostCalls.filter((call) => call.method === "warm").every((call) =>
    JSON.stringify(call.input.paths) === JSON.stringify(["/workspace/main.ts"])));
  await handlers!.definition({ environmentId: "env", path: "/workspace/main.ts", line: 2, column: 3, content: "unsaved edit" });
  assert.deepEqual(hostCalls.at(-1), {
    method: "definition", input: { root: "/workspace", path: "/workspace/main.ts", line: 2, column: 3, content: "unsaved edit" },
  });
  failure = new Error("HTTP 500: Host unavailable");
  selectedTarget = "uncommitted";
  await assert.rejects(handlers!.load({ threadId: "thread", target: "uncommitted" }), /Host unavailable/);
  assert.equal(rpcContract.load.input.safeParse({ threadId: "thread", target: "HEAD~1" }).success, false);
});

test("inbox records survive registration reloads and are readable by RPC and CLI", async () => {
  // Real SQLite via Node's stdlib; no optional native test dependency.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  let handlers: Record<string, (input: any) => Promise<any>>;
  let cli: { run(argv: string[], context: object): Promise<{ exitCode: number; stdout?: string }> };
  const bb = {
    events: { on() {} },
    onInstall() {},
    hosts: { experimental_client: () => ({ experimental_onSignal() {} }) },
    cli: { register: (command: typeof cli) => { cli = command; } },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; } },
    storage: { kv: {
      async set(key: string, value: unknown) {
        db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value));
      },
      async get(key: string) {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row === undefined ? undefined : JSON.parse(row.value as string);
      },
      async list(prefix: string) {
        return db.prepare("SELECT key FROM kv").all().map((row) => row.key as string).filter((key) => key.startsWith(prefix));
      },
    } },
  } as unknown as BbPluginApi;
  try {
    await plugin(bb);
    const setup = rpcContract.report.input.parse({ threadId: "source-thread", pluginVersion: "test", worker: { error: "failed" } });
    const saved = await handlers!.report(setup);
    await plugin(bb); // Fresh registrations read the same stored rows.
    const listed = await handlers!.reports(null);
    assert.equal(listed[0].id, saved.id);
    assert.ok(!("setup" in listed[0]));
    const record = await handlers!.getReport({ id: saved.id });
    assert.deepEqual(record.setup, setup);
    assert.equal(record.threadId, "source-thread");
    assert.deepEqual(JSON.parse((await cli!.run(["report", saved.id], {})).stdout!), record);
    await assert.rejects(handlers!.getReport({ id: "missing" }), /not found/);
    assert.equal(rpcContract.report.input.safeParse({ ...setup, oversized: "x".repeat(65 * 1024) }).success, false);
  } finally {
    db.close();
  }
});
