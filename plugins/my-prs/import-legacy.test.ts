import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { feedbackOf } from "./feedback.js";
import { fixture } from "./fixtures.js";
import { createPlugin } from "./server.js";
import { viewSchema } from "./types.js";

it("imports settings, linked threads, holds, dismissals and rate limits once from the previous identity", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "my-prs-import-"));
  mkdirSync(join(dataDir, "plugins", "pr-inbox"), { recursive: true });
  const previousHost = createFakePluginHost({ pluginId: "pr-inbox" });
  const old = previousHost.bb.storage.database();
  const pr = feedbackOf({ ...fixture(), requested: [] });
  const state = { dismissedActivity: pr.activity, dispatch: { kind: "linked", threadId: "thread-existing" }, holdUntil: "2099-01-01T00:00:00Z" };
  old.exec("CREATE TABLE inbox_prs (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE inbox_state (id TEXT PRIMARY KEY, body TEXT)");
  old.prepare("INSERT INTO inbox_prs VALUES (?, ?)").run(pr.id, JSON.stringify(pr));
  old.prepare("INSERT INTO inbox_state VALUES (?, ?)").run(pr.id, JSON.stringify(state));
  await old.backup(join(dataDir, "plugins", "pr-inbox", "data.db"));
  const poll = { at: "2026-10-29T00:00:00Z", lastSuccess: null, login: "me", error: "rate limit", retryAt: "2099-01-01T00:00:00Z" };
  const host = createFakePluginHost({ pluginId: "my-prs", dataDir });
  host.harness.inspection.sdk.stub("plugins.getSettings", async () => ({ ok: true, schema: {}, values: {
    project: "project-existing", organizationProjects: '{"example":"project-existing"}', pollMinutes: 8, githubToken: { set: false },
  } }));
  host.harness.inspection.sdk.stub("plugins.callRpc", async () => ({ rows: [], poll, project: "project-existing" }));
  try {
    await createPlugin()(host.bb);
    const result = await host.harness.behavior.runCli(["import", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({ imported: true, prs: 1, states: 1 });
    const view = viewSchema.parse(await host.harness.behavior.callRpc("prs_get", null));
    expect(view.project).toBe("project-existing");
    expect(view.poll).toEqual(poll);
    expect(view.rows[0]).toMatchObject({ id: pr.id, dismissed: true, dispatch: state.dispatch, holdUntil: state.holdUntil });
    expect(await host.bb.storage.kv.get("github-retry-at")).toBe(poll.retryAt);
    await host.harness.behavior.callRpc("hold", { id: pr.id, activity: pr.activity, until: null });
    expect((await host.harness.behavior.runCli(["import", "--json"])).exitCode).toBe(0);
    expect(viewSchema.parse(await host.harness.behavior.callRpc("prs_get", null)).rows[0]?.holdUntil).toBeNull();
  } finally { await host.harness.lifecycle.dispose(); await previousHost.harness.lifecycle.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
});
