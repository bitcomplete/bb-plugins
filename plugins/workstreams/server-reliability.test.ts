import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { RawUnit } from "./contract.js";
import plugin, { type Board } from "./server.js";

const PATH = "/p/quill-abc-101";
const PR_URL = "https://github.com/inkwell/quill/pull/42";
const unit: RawUnit = {
  path: PATH,
  dirName: "quill-abc-101",
  repo: "quill",
  branch: "abc-101",
  dirty: false,
  ahead: 0,
  behind: 0,
  lastCommitAt: "2026-09-20T10:00:00Z",
  defaultBranch: "main",
  pr: {
    number: 42,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    checkConclusions: [],
    url: PR_URL,
    title: "Gift cards",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    headRefName: "abc-101",
    latestReviewStates: [],
    reviewRequests: ["inkwell/reviewers"],
    latestReviews: [],
    unresolvedReviewThreads: null,
    mergedAt: null,
  },
  shipped: null,
  changedPaths: [],
};

async function load(threads: ReturnType<typeof makeThreadResponse>[] = []) {
  const hostCalls: string[] = [];
  let liveReviewers = ["inkwell/reviewers"];
  const { bb, harness } = createFakePluginHost({
    pluginId: "workstreams",
    settings: { scanRoots: "/p" },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
      projects: { list: async () => [{ id: "proj-inkwell", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
      threads: {
        list: async ({ limit = 500, offset = 0 }: { limit?: number; offset?: number } = {}) => threads.slice(offset, offset + limit) as never,
        getPluginMetadata: async () => ({}) as never,
        events: { list: async () => [] },
      },
    },
    experimental_callHostRpc: ({ method }) => {
      hostCalls.push(method);
      if (method === "scan") return { units: [unit], warnings: [] };
      if (method === "prReviewers") return { ok: true, reviewers: liveReviewers };
      if (method === "prWrite") return { ok: true, detail: "Re-requested review." };
      throw new Error(`unexpected host call ${method}`);
    },
  });
  await plugin(bb);
  const refresh = await harness.runCli(["refresh"]);
  expect(refresh, refresh.stderr).toMatchObject({ exitCode: 0 });
  return { harness, hostCalls, setLiveReviewers: (reviewers: string[]) => { liveReviewers = reviewers; } };
}

describe("backend reliability", () => {
  it("lists beyond the first 500 threads so old work remains linked", async () => {
    const threads = Array.from({ length: 501 }, (_, index) => ({
      ...makeThreadResponse({ id: `thr_${index}`, title: index === 500 ? "ABC-101 follow-up" : null }),
      environmentPath: null,
      environmentBranchName: null,
    }));
    const { harness } = await load(threads);
    const board = (await harness.callRpc("board_get", null)) as Board;
    expect(board.threadCoverage.threads).toBe(501);
    expect(board.threadCoverage.linked).toBeGreaterThan(0);
    expect(harness.sdk.callsTo("threads.list").some(([args]) => (args as { offset?: number }).offset === 500)).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("refuses a nudge when pending reviewers changed since confirmation", async () => {
    const { harness, hostCalls, setLiveReviewers } = await load();
    setLiveReviewers(["another-reviewer"]);
    expect(await harness.callRpc("action_nudge", { path: PATH, rerequest: true, comment: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Rescan"),
    });
    expect(hostCalls).not.toContain("prWrite");
    setLiveReviewers(["inkwell/reviewers"]);
    expect(await harness.callRpc("action_nudge", { path: PATH, rerequest: true, comment: null })).toMatchObject({ ok: true });
    expect(hostCalls).toContain("prWrite");
    await harness.lifecycle.dispose();
  });
});
