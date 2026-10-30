import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pullRequestSchema, savedStateSchema, viewSchema } from "./types.js";

const configurationSchema = z.object({
  project: z.string().optional(), organizationProjects: z.string().optional(),
  repoAllowlist: z.string().optional(), pollMinutes: z.number().optional(),
  provider: z.string().optional(), model: z.string().optional(),
});

export async function importLegacy(bb: BbPluginApi, applySettings: (values: z.infer<typeof configurationSchema>) => Promise<unknown>, hasToken: boolean) {
  if (await bb.storage.kv.get("legacy-imported")) return { imported: false, prs: 0, states: 0 };
  const path = join(bb.server.experimental_dataDir, "plugins", "pr-inbox", "data.db");
  if (!existsSync(path)) throw new Error("No previous PR inbox database was found on this server.");
  const configuration = await bb.sdk.plugins.getSettings({ pluginId: "pr-inbox" });
  if (z.object({ set: z.boolean() }).safeParse(configuration.values.githubToken).data?.set && !hasToken) {
    throw new Error("Set the GitHub token in My PRs before importing. Secret tokens cannot be copied through the settings API.");
  }
  const previous = await bb.sdk.plugins.callRpc({ pluginId: "pr-inbox", method: "inbox_get", input: null, outputSchema: viewSchema });
  const db = bb.storage.database();
  db.prepare("ATTACH DATABASE ? AS legacy").run(path);
  let prs: z.infer<typeof pullRequestSchema>[];
  let states: { id: string; state: z.infer<typeof savedStateSchema> }[];
  try {
    prs = db.prepare("SELECT body FROM legacy.inbox_prs").all().map((row) =>
      pullRequestSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)));
    states = db.prepare("SELECT id, body FROM legacy.inbox_state").all().map((row) => {
      const value = z.object({ id: z.string(), body: z.string() }).parse(row);
      const state = savedStateSchema.parse(JSON.parse(value.body));
      return { id: value.id, state: state.dispatch.kind === "starting" ? { ...state,
        dispatch: { kind: "uncertain" as const, detail: "Start was interrupted. Check your threads before clearing this attempt." } } : state };
    });
  } finally { db.exec("DETACH DATABASE legacy"); }
  await applySettings(configurationSchema.parse(configuration.values));
  const result = db.transaction(() => {
    let copiedPrs = 0;
    let copiedStates = 0;
    const insertPr = db.prepare("INSERT OR IGNORE INTO prs (id, body) VALUES (?, ?)");
    const insertState = db.prepare("INSERT OR IGNORE INTO prs_state (id, body) VALUES (?, ?)");
    for (const pr of prs) copiedPrs += insertPr.run(pr.id, JSON.stringify(pr)).changes;
    for (const { id, state } of states) copiedStates += insertState.run(id, JSON.stringify(state)).changes;
    return { imported: true, prs: copiedPrs, states: copiedStates };
  })();
  if (previous.poll) {
    await bb.storage.kv.set("poll", previous.poll);
    if (previous.poll.retryAt) await bb.storage.kv.set("github-retry-at", previous.poll.retryAt);
  }
  await bb.storage.kv.set("legacy-imported", true);
  bb.realtime.publish("prs-changed", {});
  return result;
}
