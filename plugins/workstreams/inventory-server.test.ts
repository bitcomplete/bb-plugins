import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import plugin, { type Board } from "./server.js";

const URL = "https://github.com/inkwell/folio/pull/42";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR = { ...parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "Improve manuscript review", reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN", latestReviews: [], reviewRequests: [{ login: "ada" }], statusCheckRollup: [] }]))!.pr, unresolvedReviewThreads: 0 };
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup(options: { local?: boolean; rebasing?: boolean; closed?: boolean; reviewers?: string[] } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan") return { units: [{ ...UNIT, ...(options.local ? { pr: PR } : {}) }], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [{ repo: "inkwell/folio", pr: PR }], discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "checkoutState") return { ok: true, branch: "main", rebasing: options.rebasing ?? false };
    if (method === "prLive") return { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      headRefOid: SHA, stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true } };
    if (method === "prReviewers") return options.closed ? { ok: false, error: "PR is no longer open." } : { ok: true, reviewers: options.reviewers ?? ["ada"] };
    if (method === "prWrite") return { ok: true, detail: "Done." };
    if (method === "inspectPrs") return { entries: [], closed: [URL], failed: [], warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, calls, board: async () => await harness.callRpc("board_get", null) as Board };
}

describe("authored backlog server actions", () => {
  it("derives owner scope from origin identity even when the checkout has no PR", async () => {
    const { calls, board } = await setup();
    expect(calls.find((call) => call.method === "authoredPrs")?.input).toEqual({ owners: ["inkwell"] });
    expect((await board()).prInventory).toMatchObject({ owners: ["inkwell"], complete: true, entries: [{ pr: { number: 42 }, stale: false }] });
  });

  it("refuses unknown URL targets before any GitHub write", async () => {
    const { harness, calls } = await setup();
    expect(await harness.callRpc("action_merge", { prUrl: "https://github.com/inkwell/folio/pull/99", sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false });
    expect(calls.some((call) => call.method === "prWrite" || call.method === "prLive")).toBe(false);
  });

  it("uses the live merge guard and confirmed SHA for remote-only PRs without synthetic run paths", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness, calls, board } = await setup();
    expect(await harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({ ok: true, live: { headRefOid: SHA } });
    expect(await harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: true });
    expect(calls.filter((call) => call.method === "prLive")).toHaveLength(2);
    expect(calls.find((call) => call.method === "prWrite")?.input).toMatchObject({ kind: "merge", prUrl: URL, sha: SHA });
    expect((await board()).runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await board()).prInventory.entries).toEqual([]);
    expect(calls.filter((call) => call.method === "scan")).toHaveLength(1);
  });

  it("does not let a PR URL bypass a matching checkout's live rebase guard", async () => {
    const { harness, calls } = await setup({ local: true, rebasing: true });
    expect(await harness.callRpc("action_update_branch", { prUrl: URL })).toMatchObject({ ok: false, error: expect.stringContaining("rebase") });
    expect(calls.some((call) => call.method === "prWrite")).toBe(false);
  });

  it("checks that a remote PR is still open before updating its branch", async () => {
    const { harness, calls } = await setup({ closed: true });
    expect(await harness.callRpc("action_update_branch", { prUrl: URL })).toMatchObject({ ok: false, error: expect.stringContaining("no longer open") });
    expect(calls.some((call) => call.method === "prWrite")).toBe(false);
  });

  it("rejects a nudge when pending reviewers change after the inventory was read", async () => {
    const { harness, calls } = await setup({ reviewers: ["grace"] });
    expect(await harness.callRpc("action_nudge", { prUrl: URL, rerequest: true, comment: null })).toMatchObject({ ok: false, error: expect.stringContaining("reviewers changed") });
    expect(calls.some((call) => call.method === "prWrite")).toBe(false);
  });
});
