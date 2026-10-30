import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import plugin, { type Board } from "./server.js";
import { createApprovalFeedbackStore } from "./approval-feedback.js";

const URL = "https://github.com/inkwell/folio/pull/42";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR = { ...parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "Improve manuscript review", reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN", latestReviews: [], reviewRequests: [{ login: "ada" }], statusCheckRollup: [] }]))!.pr, unresolvedReviewThreads: 0 };
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup(options: { local?: boolean; rebasing?: boolean; cohort?: boolean; approvalFeedback?: boolean; inspection?: "open" | "closed" | "failed" } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const beforeLive = vi.fn(async () => {});
  const primary = { ...(options.cohort ? { ...PR, title: "ABC-42: Improve manuscript review", headRefName: "abc-42-review" } : PR),
    headRefOid: SHA,
    approvalFeedback: options.approvalFeedback
      ? { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-42"] }
      : { status: "none" as const, fingerprint: null, sourceIds: [] } };
  const entries = [{ repo: "inkwell/folio", pr: primary }, ...(options.cohort ? [{ repo: "inkwell/folio", pr: { ...primary, number: 43, url: URL.replace("/42", "/43"), title: "ABC-42: Improve manuscript review validation" } }] : [])];
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
      headRefOid: SHA, stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true,
      approvalFeedback: primary.approvalFeedback, reviewFeedback: primary.reviewFeedback ?? { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } }; }
    if (method === "prWrite") return { ok: true, detail: "Done." };
    if (method === "inspectPrs") return options.inspection === "open"
      ? { entries: [entries[0]], closed: [], failed: [], warnings: [] }
      : options.inspection === "failed"
        ? { entries: [], closed: [], failed: [URL], warnings: ["GitHub unavailable"] }
        : { entries: [], closed: [URL], failed: [], warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, calls, beforeLive, entries, db: bb.storage.database(), feedbackStore: createApprovalFeedbackStore(bb.storage.database()),
    board: async () => await harness.callRpc("board_get", null) as Board };
}

describe("authored backlog server actions", () => {
  it("shares the visible-view PR poll across callers", async () => {
    const { harness, calls } = await setup({ inspection: "open" });
    expect(await harness.callRpc("pr_poll", null)).toEqual({ scheduled: 1 });
    expect(await harness.callRpc("pr_poll", null)).toEqual({ scheduled: 0 });
    expect(calls.filter((call) => call.method === "inspectPrs")).toHaveLength(0);
  });

  it("shares one explicit PR read between concurrent callers and reports its observation time", async () => {
    const { harness, calls, board } = await setup({ inspection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const [first, second] = await Promise.all([
      harness.callRpc("pr_refresh_many", { prUrls: [URL] }),
      harness.callRpc("pr_refresh_many", { prUrls: [URL] }),
    ]) as { reads: { prUrl: string; read: { status: string; checkedAt: string } }[] }[];
    expect(first!.reads).toEqual([{ prUrl: URL, read: { status: "checked", checkedAt: expect.any(String) } }]);
    expect(second).toEqual(first);
    expect(calls.filter((call) => call.method === "inspectPrs")).toHaveLength(1);
    expect((await board()).prObservations[URL]?.checkedAt).toBe(first!.reads[0]!.read.checkedAt);
  });

  it("keeps the last successful check time when an explicit refresh fails", async () => {
    const { harness, board } = await setup({ inspection: "failed" });
    const previous = (await board()).prObservations[URL]?.checkedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await harness.callRpc("pr_refresh_many", { prUrls: [URL] })).toMatchObject({ reads: [{ read: { status: "failed", checkedAt: previous } }] });
    expect((await board()).prObservations[URL]).toMatchObject({ checkedAt: previous, failedAt: expect.any(String) });
  });
  it("keeps legacy cached approval replies visible without clearing missing or current feedback", async () => {
    const env = await setup({ local: true });
    const legacy = { ...env.entries[0]!.pr, approvalFeedback: undefined, approvalNoteFollowedUp: true };
    const persist = (pr: Pr) => {
      env.db.prepare(`UPDATE authored_prs SET entry = ? WHERE url = ?`)
        .run(JSON.stringify({ repo: "inkwell/folio", pr }), URL.toLowerCase());
      env.db.prepare(`UPDATE units SET unit = ? WHERE path = ?`).run(JSON.stringify({ ...UNIT, pr }), UNIT.path);
    };
    persist(legacy);
    const unknown = await env.board();
    expect(unknown.prInventory.entries).toMatchObject([{ pr: { approvalNoteFollowedUp: true, approvalFeedbackVerified: false } }]);
    expect(unknown.groups.flatMap((group) => group.clusters).find((cluster) => cluster.units.some((unit) => unit.path === UNIT.path))?.lifecycle).toBe("unverified");
    persist({ ...legacy, approvalFeedback: { status: "present", fingerprint: "f".repeat(64), sourceIds: ["review-42"] } });
    const current = await env.board();
    expect(current.prInventory.entries).toMatchObject([{ pr: { approvalNoteFollowedUp: true, approvalFeedbackVerified: false } }]);
    expect(current.groups.flatMap((group) => group.clusters).find((cluster) => cluster.units.some((unit) => unit.path === UNIT.path))?.lifecycle).toBe("approved-with-note");
  });

  it("uses current review evidence for local and remote Ready states and manual merge", async () => {
    const env = await setup({ local: true, approvalFeedback: true });
    expect((await env.board()).prInventory.entries[0]?.pr.approvalFeedbackVerified).toBe(false);
    expect((await env.board()).groups.flatMap((group) => group.clusters).find((cluster) => cluster.units.some((unit) => unit.path === UNIT.path))?.lifecycle).not.toBe("awaiting-merge");
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({
      ok: true, refusals: [expect.stringContaining("Approval feedback"), expect.stringContaining("approval comment waits")],
    });
    expect(await env.harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: true })).toMatchObject({
      ok: false, error: expect.stringContaining("Approval feedback"),
    });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);

    env.feedbackStore.save(URL, "thread-1", {
      attemptId: "job-1", headOid: SHA, fingerprint: "f".repeat(64), blockers: [],
      findings: [{ sourceId: "review-42", resolution: "no-change-needed", evidence: "The requested behavior is already covered.",
        validation: { outcome: "not-needed", detail: "No code change is needed." } }],
    }, Date.now());
    expect((await env.board()).prInventory.entries[0]?.pr.approvalFeedbackVerified).toBe(true);
    // A worker's evidence verifies the head, but the reviewer saw no answer: the approval's comment still holds the merge (the live case
    // that once read Ready to merge).
    const lifecycle = async () => (await env.board()).groups.flatMap((group) => group.clusters).find((cluster) => cluster.units.some((unit) => unit.path === UNIT.path))?.lifecycle;
    expect(await lifecycle()).toBe("approved-with-note");
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({ ok: true,
      refusals: ["An approval comment waits on your answer: reply on the PR or confirm it."] });
    expect(await env.harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false,
      error: expect.stringContaining("approval comment waits") });
    expect(env.calls.some((call) => call.method === "prWrite")).toBe(false);

    // Your reply after the note answers it.
    env.entries[0]!.pr.reviewFeedback = { openThreads: 0, comment: null, repliedAt: "2026-09-25T10:00:00Z", noteAt: "2026-09-25T09:00:00Z", followUpAt: null };
    await env.harness.runCli(["refresh"]);
    expect(await lifecycle()).toBe("awaiting-merge");
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({ ok: true, refusals: [] });
    expect(await env.harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: true });

    // mira adds to her note: a new fingerprint, and a note newer than your reply.
    env.entries[0]!.pr.approvalFeedback = { status: "present", fingerprint: "e".repeat(64), sourceIds: ["review-42"] };
    env.entries[0]!.pr.reviewFeedback = { ...env.entries[0]!.pr.reviewFeedback!, noteAt: "2026-09-25T11:00:00Z" };
    await env.harness.runCli(["refresh"]);
    expect((await env.board()).prInventory.entries[0]?.pr.approvalFeedbackVerified).toBe(false);
    expect(await env.harness.callRpc("action_merge_preview", { prUrl: URL })).toMatchObject({
      ok: true, refusals: [expect.stringContaining("Approval feedback"), expect.stringContaining("approval comment waits")],
    });
  });
  it("projects a repeated remote ticket into one effort without inventing checkouts", async () => {
    const env = await setup({ cohort: true });
    const board = await env.board();
    const group = board.groups.find((entry) => entry.key === "ticket:ABC-42");
    expect(group).toMatchObject({ level: "effort", clusters: [], repoCount: 1, total: 2 });
    expect(group?.name).toContain("Improve manuscript review");
    expect(board.prInventory.entries.every((entry) => entry.effortKey === group?.key)).toBe(true);
    env.entries.pop();
    await env.harness.runCli(["refresh"]);
    expect((await env.board()).groups.some((entry) => entry.key === "ticket:ABC-42")).toBe(false);
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
    expect(await harness.callRpc("action_merge", { prUrl: URL, sha: SHA, acknowledgeUnresolved: false })).toMatchObject({ ok: false, error: expect.stringContaining("rebase") });
    expect(calls.some((call) => call.method === "prWrite")).toBe(false);
  });
});
