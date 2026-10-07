import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import plugin from "./server";

test("inbox records survive registration reloads and are readable by RPC and CLI", async () => {
  // Real SQLite via Node's stdlib; no optional native test dependency.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  let handlers: Record<string, (input: any) => Promise<any>>;
  let cli: { run(argv: string[], context: object): Promise<{ exitCode: number; stdout?: string }> };
  const bb = {
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
