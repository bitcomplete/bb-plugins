import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrList } from "./gh.js";
import type { RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import plugin, { type Board } from "./server.js";

const PATH = "/p/folio-abc-101", URL = "https://github.com/inkwell/folio/pull/42";
const pr = parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "ABC-101 Improve manuscript review", headRefName: "abc-101-review", reviewDecision: "APPROVED" }]))!.pr;
const unit: RawUnit = { path: PATH, dirName: "folio-abc-101", repo: "folio", githubRepo: "inkwell/folio", branch: "abc-101-review", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr, shipped: null, changedPaths: ["src/review.ts"], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "proj-inkwell", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: {
      list: async () => [...threads.values()] as never,
      get: async ({ threadId }: { threadId: string }) => { const row = threads.get(threadId); if (!row) throw new Error("missing thread"); return { ...row, canSpawnChild: true } as never; },
      getPluginMetadata: async () => ({}) as never,
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [], discoveryComplete: true, complete: true, repositories: [], warnings: [] };
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const board = async () => await harness.callRpc("board_get", null) as Board;
  return { bb, harness, board, threads };
}

describe("established efforts through the server", () => {
  it("keeps an established effort's group and id across rescans, and reports its archived coordinator as unavailable", async () => {
    const { bb, harness, board, threads } = await setup();
    const group = (await board()).groups.find((entry) => entry.clusters.length > 0)!;
    threads.set("thr-coordinator", makeThreadResponse({ id: "thr-coordinator", projectId: "proj-inkwell", title: "Reliable manuscript review" }));
    const store = createEffortStore(bb.storage.database() as never);
    const established = store.save({ ...store.establish({ sourceKey: group.key, name: "Reliable manuscript review", goal: "Make manuscript review reliable",
      projectId: "proj-inkwell", members: { tickets: ["ABC-101"], prUrls: [URL] } }), coordinatorThreadId: "thr-coordinator", coordinatorState: "ready" });
    await harness.runCli(["refresh"]);
    expect((await board()).groups.some((entry) => entry.key === established.key && entry.name === "Reliable manuscript review")).toBe(true);
    expect((await board()).efforts).toMatchObject([{ id: established.id, coordinatorState: "ready" }]);
    threads.set("thr-coordinator", { ...threads.get("thr-coordinator")!, archivedAt: Date.now() });
    expect((await board()).efforts).toMatchObject([{ id: established.id, coordinatorThreadId: "thr-coordinator", coordinatorState: "unavailable" }]);
  });
});
