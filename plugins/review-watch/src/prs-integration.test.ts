import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { draftReadyKeys, prsSnapshotSchema, prsReviewSchema } from "./prs-contract.js";
import type { PullRequest, QueueItem } from "./types.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const head = "b".repeat(40);
const base = "a".repeat(40);
const pr: PullRequest = {
  nodeId: "PR_1", repo: "team/editor", number: 1, title: "Preserve editor history", url: "https://github.com/team/editor/pull/1",
  author: "author", isDraft: false, baseBranch: "main", headBranch: "history", headSha: head,
  headCommittedAt: "2026-11-15T11:00:00Z", updatedAt: "2026-11-15T12:00:00Z",
  additions: 800, deletions: 200, changedFiles: 20, reviewDecision: "CHANGES_REQUESTED", requestedReviewers: [],
  myLastReview: { state: "CHANGES_REQUESTED", submittedAt: "2026-11-14T11:00:00Z", commitSha: base },
};
const item: QueueItem = {
  key: `review-followup:PR_1:${head}`, rule: "review-followup", state: "queued", repo: pr.repo, number: pr.number,
  title: pr.title, author: pr.author, url: pr.url, baseBranch: pr.baseBranch, headBranch: pr.headBranch, headSha: head,
  nodeId: pr.nodeId, reason: "The author pushed after your review", noticedAt: pr.updatedAt, updatedAt: pr.updatedAt,
  reviewBaselineSubmittedAt: pr.myLastReview?.submittedAt, reviewBaselineCommitSha: base,
};
function node(value = pr) {
  return {
    id: value.nodeId, state: "OPEN", number: value.number, title: value.title, url: value.url, isDraft: value.isDraft,
    updatedAt: value.updatedAt, reviewDecision: value.reviewDecision, baseRefName: value.baseBranch, headRefName: value.headBranch,
    headRefOid: value.headSha, author: { login: value.author }, repository: { nameWithOwner: value.repo },
    additions: value.additions, deletions: value.deletions, changedFiles: value.changedFiles,
    commits: { nodes: [{ commit: { committedDate: value.headCommittedAt } }] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: value.requestedReviewers.map((login) => ({ requestedReviewer: { __typename: "User", login } })) },
    reviews: { nodes: value.myLastReview ? [{ ...value.myLastReview, commit: value.myLastReview.commitSha ? { oid: value.myLastReview.commitSha } : null }] : [] },
  };
}
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
async function setup(queue: QueueItem[] = [item], observed: PullRequest[] = [pr]) {
  const host = createFakePluginHost({ settings: { githubToken: "synthetic-token" } });
  hosts.push(host);
  await host.bb.storage.kv.set("queue", queue);
  await host.bb.storage.kv.set("prs-context-v1", { at: "2026-11-15T12:00:00Z", viewer: "reader", pullRequests: observed });
  host.harness.sdk.stub("threads.list", async () => []);
  await plugin(host.bb);
  return host;
}
async function readSnapshot(host: Awaited<ReturnType<typeof setup>>) {
  return prsSnapshotSchema.parse(await host.harness.behavior.callRpc("prs_snapshot", null));
}
async function readDetail(host: Awaited<ReturnType<typeof setup>>, key: string) {
  return prsReviewSchema.parse(await host.harness.behavior.callRpc("prs_detail", { key }));
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  vi.unstubAllGlobals();
});

describe("unified review transport", () => {
  it("reads cached sizes without fetching GitHub, preserves unknown deltas, and counts a PR once", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const host = await setup([item, { ...item, key: `review-requested:PR_1:${head}`, rule: "review-requested", state: "archived" }]);
    const snapshot = await readSnapshot(host);
    expect(snapshot.version).toBe(1);
    expect(snapshot.lastSuccessAt).toBe("2026-11-15T12:00:00Z");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ segment: "on-you", agentState: "none", total: { kind: "known", additions: 800, deletions: 200, files: 20 }, delta: { kind: "unknown" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("uses the submitted review commit for real per-file deltas and counts only your threads", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("/compare/")) return new Response(JSON.stringify({ base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [{ filename: "src/editor.ts", additions: 12, deletions: 4 }] }));
      const query = JSON.parse(String(init.body)).query;
      if (query.includes("query Viewer")) return response({ viewer: { login: "reader" } });
      if (query.includes("ReviewThreadResolution")) return response({ node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { isResolved: true, comments: { pageInfo: { hasNextPage: false }, nodes: [{ author: { login: "reader" } }] } },
        { isResolved: false, comments: { pageInfo: { hasNextPage: false }, nodes: [{ author: { login: "reader" } }] } },
        { isResolved: true, comments: { pageInfo: { hasNextPage: false }, nodes: [{ author: { login: "someone-else" } }] } },
      ] } } });
      return response({ nodes: [node()] });
    }));
    const host = await setup();
    const detail = await readDetail(host, item.key);
    expect(detail.delta).toEqual({ kind: "known", baseSha: base, headSha: head, additions: 12, deletions: 4, files: [{ path: "src/editor.ts", additions: 12, deletions: 4 }] });
    expect(detail.lastReview).toEqual(pr.myLastReview);
    expect(detail.resolution).toEqual({ kind: "known", resolved: 1, unresolved: 1 });
    expect(calls.find((url) => url.includes("/compare/"))).toContain(`${base}...${head}`);
    const count = calls.length;
    expect((await readSnapshot(host)).items[0]?.delta).toEqual(detail.delta);
    expect(calls).toHaveLength(count);
  });

  it.each(["missing-baseline", "compare-error", "force-push", "truncated-files"])("reports %s as unknown, never as the full PR size", async (failure) => {
    const current: PullRequest = failure === "missing-baseline" ? { ...pr, myLastReview: { state: "COMMENTED", submittedAt: "2026-11-14T11:00:00Z", commitSha: null } } : pr;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/compare/")) {
        if (failure === "compare-error") return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ base_commit: { sha: base }, merge_base_commit: { sha: failure === "force-push" ? "c".repeat(40) : base }, files: failure === "truncated-files" ? Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}`, additions: 1, deletions: 0 })) : [] }));
      }
      const query = JSON.parse(String(init.body)).query;
      if (query.includes("query Viewer")) return response({ viewer: { login: "reader" } });
      if (query.includes("ReviewThreadResolution")) return response({ node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
      return response({ nodes: [node(current)] });
    }));
    const host = await setup([{ ...item, reviewBaselineCommitSha: failure === "missing-baseline" ? null : base }], [current]);
    const detail = await readDetail(host, item.key);
    expect(detail.delta.kind).toBe("unknown");
    expect(detail.delta).not.toHaveProperty("additions");
    expect(detail.total).toMatchObject({ additions: 800, deletions: 200 });
  });

  it("derives Back with authors from a submitted review and honors an explicit dismissal", async () => {
    const reviewed: PullRequest = { ...pr, myLastReview: { state: "COMMENTED", submittedAt: "2026-11-15T12:00:00Z", commitSha: head } };
    const host = await setup([], [reviewed]);
    const snapshot = await readSnapshot(host);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.segment).toBe("with-authors");
    const key = snapshot.items[0]?.item.key;
    if (key === undefined) throw new Error("Missing projected history key");
    await host.harness.behavior.callRpc("item_dismiss", { key });
    expect((await readSnapshot(host)).items).toEqual([]);
    expect((await host.bb.storage.kv.get<QueueItem[]>("queue"))?.[0]?.state).toBe("dismissed");
  });

  it("does not infer Back with authors from an archived row without GitHub evidence", async () => {
    const host = await setup([{ ...item, state: "archived", threadId: "old-thread" }], []);
    expect((await readSnapshot(host)).items).toEqual([]);
  });

  it("keeps live reviewers separate from stopped threads and requires per-item completion evidence", async () => {
    const host = await setup([{ ...item, state: "started", threadId: "reviewer" }]);
    let status: "active" | "idle" = "active";
    host.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "reviewer", status })]);
    expect((await readSnapshot(host)).items[0]).toMatchObject({ segment: "agent", agentState: "running" });
    status = "idle";
    expect((await readSnapshot(host)).items[0]).toMatchObject({ segment: "on-you", agentState: "stopped" });
    await host.bb.storage.kv.set("review-drafts-v1", { reviewer: ["other-item"] });
    expect((await readSnapshot(host)).items[0]?.agentState).toBe("stopped");
    await host.bb.storage.kv.set("review-drafts-v1", { reviewer: [item.key] });
    expect((await readSnapshot(host)).items[0]?.agentState).toBe("draft-ready");
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "reviewer", status: "active" }) });
    expect(await host.bb.storage.kv.get("review-drafts-v1")).toEqual({});
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const query = JSON.parse(String(init.body)).query;
      if (query.includes("query Viewer")) return response({ viewer: { login: "reader" } });
      return response({ search: { nodes: [node()], pageInfo: { hasNextPage: false, endCursor: null } } });
    }));
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "reviewer", status: "idle" }),
      lastAssistantText: `Findings.\n\`\`\`review-watch-result\n${JSON.stringify({ version: 1, status: "draft-ready", itemKeys: [item.key] })}\n\`\`\``,
    });
    expect((await readSnapshot(host)).items[0]?.agentState).toBe("draft-ready");
  });

  it("does not overwrite a newer poll when an expanded comparison finishes late", async () => {
    let finishCompare: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/compare/")) return new Promise<Response>((resolve) => { finishCompare = resolve; });
      const query = JSON.parse(String(init.body)).query;
      if (query.includes("query Viewer")) return response({ viewer: { login: "reader" } });
      if (query.includes("ReviewThreadResolution")) return response({ node: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
      return response({ nodes: [node()] });
    }));
    const host = await setup();
    const pending = readDetail(host, item.key);
    await vi.waitFor(() => expect(finishCompare).toBeTypeOf("function"));
    const nextHead = "c".repeat(40);
    const nextPr = { ...pr, headSha: nextHead, updatedAt: "2026-11-15T13:00:00Z" };
    await host.bb.storage.kv.set("prs-context-v1", { at: nextPr.updatedAt, viewer: "reader", pullRequests: [nextPr] });
    await host.bb.storage.kv.set("queue", [{ ...item, key: `review-followup:PR_1:${nextHead}`, headSha: nextHead }]);
    finishCompare?.(new Response(JSON.stringify({ base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [] })));
    await expect(pending).rejects.toThrow("changed while loading");
    expect((await readSnapshot(host)).items[0]?.item.headSha).toBe(nextHead);
  });
});

it("requires a strict final result block instead of guessing draft completion from prose", () => {
  const block = `\`\`\`review-watch-result\n${JSON.stringify({ version: 1, status: "draft-ready", itemKeys: [item.key] })}\n\`\`\``;
  expect([...draftReadyKeys(`Findings are drafted.\n${block}`)]).toEqual([item.key]);
  for (const output of ["Draft ready!", `${block}\nActually I need your answer.`, block.replace('"draft-ready"', '"asking"'), block.replace('"version":1', '"version":2')]) expect(draftReadyKeys(output).size).toBe(0);
});
