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

async function setup(options: { local?: boolean; rebasing?: boolean; closed?: boolean; reviewers?: string[]; cohort?: boolean } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const beforeLive = vi.fn(async () => {});
  const primary = options.cohort ? { ...PR, title: "EPD-42: Improve manuscript review", headRefName: "epd-42-review" } : PR;
  const entries = [{ repo: "inkwell/folio", pr: primary }, ...(options.cohort ? [{ repo: "inkwell/folio", pr: { ...primary, number: 43, url: URL.replace("/42", "/43"), title: "EPD-42: Improve manuscript review validation" } }] : [])];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan") return { units: [{ ...UNIT, ...(options.local ? { pr: primary } : {}) }], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries, discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "checkoutState") return { ok: true, branch: "main", rebasing: options.rebasing ?? false };
    if (method === "prLive") { await beforeLive(); return { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      headRefOid: SHA, stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true } }; }
    if (method === "prReviewers") return options.closed ? { ok: false, error: "PR is no longer open." } : { ok: true, reviewers: options.reviewers ?? ["ada"] };
    if (method === "prWrite") return { ok: true, detail: "Done." };
    if (method === "inspectPrs") return { entries: [], closed: [URL], failed: [], warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, calls, beforeLive, entries, board: async () => await harness.callRpc("board_get", null) as Board };
}

describe("authored backlog server actions", () => {
  it("projects a repeated remote ticket into one effort without inventing checkouts", async () => {
    const env = await setup({ cohort: true });
    const board = await env.board();
    const group = board.groups.find((entry) => entry.key === "ticket:EPD-42");
    expect(group).toMatchObject({ level: "effort", clusters: [], repoCount: 1, total: 2 });
    expect(group?.name).toContain("Improve manuscript review");
    expect(board.prInventory.entries.every((entry) => entry.effortKey === group?.key)).toBe(true);
    expect(await env.harness.callRpc("effort_plan", { groupKey: group!.key })).toMatchObject({ ok: true,
      members: { tickets: ["EPD-42"], prUrls: [URL, URL.replace("/42", "/43")] }, projects: [{ id: "project-folio" }] });
    env.entries.pop();
    await env.harness.runCli(["refresh"]);
    expect((await env.board()).groups.some((entry) => entry.key === "ticket:EPD-42")).toBe(false);
  });
  it("keeps a PR hold across rescans and blocks merge without changing approval facts", async () => {
    const env = await setup({ local: true });
    await env.harness.callRpc("pr_hold_set", { prUrl: "https://github.com/Inkwell/Folio/pull/42/?tab=files", held: true, reason: "Await product sign-off" });
    expect((await env.board()).prHolds).toEqual({ [URL]: { reason: "Await product sign-off", heldAt: expect.any(Number) } });
    await env.harness.runCli(["refresh"]);
    expect((await env.board()).prHolds[URL]?.reason).toBe("Await product sign-off");
    expect((await env.board()).prInventory.entries[0]?.pr.reviewDecision).toBe("APPROVED");
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({ ok: true, refusals: [expect.stringContaining("On hold")] });
    expect(await env.harness.callRpc("action_merge", { path: UNIT.path, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false, error: expect.stringContaining("On hold") });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: false });
    expect((await env.board()).prHolds).toEqual({});
  });
  it("refuses a merge when a hold arrives after preview or during the final live read", async () => {
    const env = await setup();
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({ ok: true, refusals: [] });
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true });
    expect(await env.harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false, error: expect.stringContaining("On hold") });
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: false });
    env.beforeLive.mockImplementationOnce(async () => { await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true }); });
    expect(await env.harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false, error: expect.stringContaining("On hold") });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);
  });
  it("allows manual branch preparation while a PR is held", async () => {
    const env = await setup();
    await env.harness.callRpc("pr_hold_set", { prUrl: URL, held: true });
    expect(await env.harness.callRpc("action_update_branch", { prUrl: URL })).toMatchObject({ ok: true });
    expect(env.calls.find((call) => call.method === "prWrite")?.input).toMatchObject({ kind: "update-branch" });
    expect((await env.board()).prHolds[URL]).toBeDefined();
  });
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
