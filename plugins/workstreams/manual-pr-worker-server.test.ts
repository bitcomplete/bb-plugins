import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const PATH = "/p/widget-checkout";
const HOST = "host-example";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const LEGACY_BATCH = "00000000-0000-4000-8000-000000000052";
const LEGACY_JOB = "00000000-0000-4000-8000-000000000053";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(options: { ready?: boolean; legacyJob?: "running" } = {}) {
  const repo = "example/widget";
  const url = `https://github.com/${repo}/pull/42`;
  const pr = { ...parsePrList(JSON.stringify([{ number: 42, url, state: "OPEN", title: "ABC-42 Fix account lookup", reviewDecision: "APPROVED",
    isDraft: false, headRefName: "abc-42-lookup", baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, mergeStateStatus: options.ready ? "CLEAN" : "DIRTY",
    mergeable: options.ready ? "MERGEABLE" : "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }], latestReviews: [], reviewRequests: [] }]))!.pr,
    unresolvedReviewThreads: 0, resolvedReviewThreads: 0 };
  const unit: RawUnit = { path: PATH, dirName: "widget-checkout", repo: "Widget", githubRepo: repo, branch: "abc-42-lookup",
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
  const calls: { method: string; input: unknown }[] = [];
  const spawn = vi.fn(async () => makeThreadResponse({ id: "thr-unexpected" }));
  const send = vi.fn(async () => ({} as never));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-example", name: "Example", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [] as never, spawn: spawn as never, send,
      getPluginMetadata: async () => ({}) as never, output: async () => ({ output: "" }),
      events: { list: async () => [] }, interactions: { list: async () => [] as never },
    },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [unit], warnings: [] };
    if (method === "authoredPrs") return { owners: [repo.split("/")[0]], entries: [{ repo, pr }], discoveryComplete: true,
      repositories: [{ repo, complete: true }], complete: true, warnings: [] };
    if (method === "equalHeadTrees") return { ok: true, priorTreeOid: "c".repeat(40), currentTreeOid: "c".repeat(40) };
    if (method === "prLive") return { ok: true, live: { state: pr.state, isDraft: false, reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus, headRefOid: pr.headRefOid, stackedAbove: [], unresolvedThreads: 0,
      unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } };
    if (method === "inspectPrs") return { entries: [{ repo, pr }], closed: [], failed: [], warnings: [] };
    if (method === "checkoutState") return { ok: true, branch: unit.branch, rebasing: false };
    if (method === "prWrite") return { ok: true, detail: `Wrote ${(input as { kind: string }).kind}.` };
    throw new Error(`Unexpected host method ${method}`);
  } });
  if (options.legacyJob) {
    // A job the removed Advance engine saved mid-run: its worker's outcome was never confirmed.
    const db = bb.storage.database();
    db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
    const job = { prUrl: url, repo, number: 42, title: pr.title, headOid: HEAD, baseOid: BASE, baseRefName: "main", headRefName: "abc-42-lookup",
      needsPreparation: true, needsFeedback: false, needsChecks: false, eligible: true, detail: "Working on branch preparation in the repository thread",
      workspace: "create", id: LEGACY_JOB, status: options.legacyJob, threadId: "thr-legacy", path: "/synthetic/workstreams/batch/repo/job", checkedHeadOid: null,
      updatedAt: Date.now() };
    db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(LEGACY_BATCH, JSON.stringify({ id: LEGACY_BATCH, createdAt: Date.now(), cancelled: false,
      jobs: [job], facts: { [LEGACY_JOB]: { path: PATH } } }));
  }
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { bb, harness, calls, spawn, send, pr, url };
}

describe("PR refresh and manual write fences", () => {
  it("carries complete saved feedback across a code-identical head during a targeted read-only refresh", async () => {
    const env = await setup({ ready: true });
    const snapshot = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["approval-42"] };
    Object.assign(env.pr, { approvalFeedback: snapshot });
    const record = { prUrl: env.url, threadId: "thr-old", attemptId: "attempt-old", headOid: HEAD,
      fingerprint: snapshot.fingerprint, findings: [{ sourceId: "approval-42", resolution: "already-satisfied",
        evidence: "The current fallback handles the reviewed case in src/fallback.ts.",
        validation: { outcome: "passed", detail: "Focused fallback test passed." } }], blockers: [], verifiedAt: 1_000,
      provenance: { kind: "worker" } };
    env.bb.storage.database().prepare("INSERT INTO approval_feedback_verifications (pr_url, body) VALUES (?, ?)")
      .run(env.url, JSON.stringify(record));
    const freshHead = "d".repeat(40);
    env.pr.headRefOid = freshHead;
    const refreshed = await env.harness.callRpc("pr_refresh_many", { prUrls: [env.url] });
    expect(refreshed).toMatchObject({ reads: [{ read: { status: "checked" } }] });
    expect(env.calls.some((call) => call.method === "equalHeadTrees")).toBe(true);
    const saved = env.bb.storage.database().prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?")
      .get(env.url) as { body: string };
    expect(JSON.parse(saved.body)).toMatchObject({ headOid: freshHead, verifiedAt: 1_000,
      equivalence: { sourceHeadOid: HEAD, sourceVerifiedAt: 1_000, treeOid: "c".repeat(40) } });
    const board = await env.harness.callRpc("board_get", null) as { prInventory: { entries: { pr: { approvalFeedbackVerified: boolean } }[] } };
    expect(board.prInventory.entries[0]?.pr.approvalFeedbackVerified).toBe(true);
  });

  // Nothing can settle a job the removed engine left mid-run, so its history fences nothing: no worker will start, and no cancel exists.
  it("writes a PR and its checkout whose only owner is a legacy Advance job that never settled", async () => {
    const env = await setup({ ready: true, legacyJob: "running" });
    expect(await env.harness.callRpc("action_merge", { prUrl: env.url, sha: HEAD, acknowledgeUnresolved: false })).toMatchObject({ ok: true });
    expect(await env.harness.callRpc("inventory_request_review", { prUrl: env.url, logins: ["mira"], shown: { requested: [], reviewed: [] } }))
      .toEqual({ ok: true, detail: "Wrote nudge." });
    expect(env.calls.filter((call) => call.method === "prWrite").map((call) => (call.input as { kind: string }).kind)).toEqual(["merge", "nudge"]);
    expect([env.spawn.mock.calls, env.send.mock.calls]).toEqual([[], []]);
  });
});
