import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { calmRowSchema, stateSchema, viewModelSchema, type Runner } from "./board";
import { createPlugin } from "./server";
import { DEFAULT_AGENT_MODEL } from "./agent-model";
import { prsReviewSchema } from "./reviews";
import type { Github } from "./reviewers";

const key = "acme/repo#7";
const row = calmRowSchema.parse({ key, number: 7, repo: "acme/repo", url: "https://github.com/acme/repo/pull/7", title: "Route the purchase", area: "repo", tone: 0,
  sentence: "nobody is asked to review it", blocked: null, depth: 0, after: null, reviewers: [], size: { lines: 20, files: 1, bar: 0, label: "20 lines · 1 file" },
  stack: null, action: null, gate_blocked: false, segment: "on-you", group: "one-click", move: "review", pushed_at: null, parent_key: null,
  stack_front: false, gate_links: [], review_summary: "No review", review_targets: [], waiting: [], checks: [] });
const view = viewModelSchema.parse({ fetched_at: "2026-11-15T10:00:00Z", prs: [row], summary: { work: 0, mine: 0, ready: 0, held: 0, theirs: 0, drafts: 0, other: 1 },
  suggestions: [], trains: [], sections: [], reviewer_batches: [], reviewer_load: { reviewers: [], none: { count: 0, keys: [] } } });
const review = prsReviewSchema.parse({ item: { key: "review-followup:node:head", rule: "review-followup", state: "queued", repo: "acme/repo", number: 7,
  title: "Retry lab fetches", author: "example-author", url: row.url, baseBranch: "main", headBranch: "retry", headSha: "head", nodeId: "node",
  reason: "Author pushed after your review", noticedAt: view.fetched_at, updatedAt: view.fetched_at }, segment: "on-you", agentState: "none", evidence: "Review follow-up on current head", total: { kind: "known", additions: 1000, deletions: 200, files: 10 },
  delta: { kind: "unknown", reason: "No last-reviewed commit is available" }, lastReview: null, resolution: { kind: "unknown", reason: "Not fetched" } });

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

async function host() {
  const control = { view, fetches: 0, fetchError: false, reviewError: false, githubGate: null as Promise<void> | null, codeowners: null as string | null, githubDelay: 0, active: 0, maxActive: 0 };
  const remote: Array<{ method: string; input: unknown }> = [];
  const githubCalls: string[][] = [];
  const github: Github = async (args) => {
    githubCalls.push(args);
    control.active++; control.maxActive = Math.max(control.maxActive, control.active);
    try {
      if (control.githubDelay) await new Promise((resolve) => setTimeout(resolve, control.githubDelay));
      if (control.githubGate) await control.githubGate;
      if (args.includes("POST")) return "{}";
      if (args[1]?.includes("collaborators")) return JSON.stringify([[{ login: "alice", type: "User" }]]);
      if (args[1]?.includes("contents")) {
        if (control.codeowners !== null) return control.codeowners;
        throw new Error("HTTP 404: Not found");
      }
      if (args[1]?.includes("/files")) return JSON.stringify([[{ filename: "src/cart.ts" }]]);
      throw new Error("Unexpected GitHub request");
    } finally { control.active--; }
  };
  const runner: Runner = {
    fetch: async () => {
      control.fetches++;
      if (control.fetchError) throw new Error("GitHub unavailable");
      return JSON.stringify({ login: "me", prs: { [key]: { head_oid: "head", move: "review" } } });
    },
    view: async () => control.view,
    prepare: async () => ({ ok: false, reason: "not an agent step" }),
  };
  const instance = createFakePluginHost({ pluginId: "pr-board", sdk: { plugins: {
    callRpc: async (args) => {
      remote.push({ method: args.method, input: args.input });
      if (control.reviewError) throw new Error("Review Watch is disabled");
      const output = (() => {
        switch (args.method) {
          case "prs_snapshot": return { version: 1, items: [review], lastPoll: null, lastSuccessAt: view.fetched_at };
          case "prs_detail": return review;
          case "review_targets": return { projectId: null, reason: "choose", projects: [{ id: "project-1", name: "Example" }] };
          case "item_start": return { item: { ...review.item, state: "started", threadId: "draft-1" } };
          case "item_batch_start": return { threadId: "draft-1", items: [{ ...review.item, state: "started", threadId: "draft-1" }] };
          case "item_dismiss": return { item: { ...review.item, state: "dismissed" } };
          case "poll_now": return { ok: true, added: 0, removed: 0, total: 1, changed: false };
          default: throw new Error("Unexpected Review Watch method");
        }
      })();
      return args.outputSchema.parse(output);
    },
  } } });
  await createPlugin({ runner, github })(instance.bb);
  disposers.push(() => instance.harness.lifecycle.dispose());
  await instance.harness.behavior.callRpc("board_refresh", null);
  return { ...instance, control, remote, githubCalls };
}

it("proxies the independent Review Watch contract, including unknown delta and explicit project choice", async () => {
  const { harness, remote, githubCalls } = await host();
  expect(await harness.behavior.callRpc("reviews_get", null)).toMatchObject({ kind: "available", snapshot: { version: 1, items: [{ delta: { kind: "unknown" } }] } });
  expect(await harness.behavior.callRpc("reviews_detail", { key: review.item.key })).toEqual(review);
  expect(await harness.behavior.callRpc("reviews_targets", { keys: [review.item.key] })).toMatchObject({ reason: "choose", projects: [{ id: "project-1" }] });
  expect(remote.map((call) => call.method)).toEqual(["prs_snapshot", "prs_detail", "review_targets"]);
  expect(remote[2]?.input).toEqual({ keys: [review.item.key] });
  expect(githubCalls).toEqual([]);
  await harness.behavior.callRpc("reviews_start", { key: review.item.key, projectId: "project-1" });
  expect(remote.at(-1)).toEqual({ method: "item_start", input: { key: review.item.key, projectId: "project-1", agentModel: DEFAULT_AGENT_MODEL } });
  await harness.behavior.callRpc("reviews_batch", { keys: [review.item.key], projectId: "project-1" });
  expect(remote.at(-1)).toEqual({ method: "item_batch_start", input: { keys: [review.item.key], projectId: "project-1", agentModel: DEFAULT_AGENT_MODEL } });
  await harness.behavior.callRpc("reviews_dismiss", { key: review.item.key });
  expect(remote.at(-1)).toEqual({ method: "item_dismiss", input: { key: review.item.key } });
});

it("keeps Mine available when the companion fails", async () => {
  const { harness, control } = await host(); control.reviewError = true;
  expect(await harness.behavior.callRpc("reviews_get", null)).toEqual({ kind: "unavailable", reason: "Review Watch is disabled" });
  expect(stateSchema.parse(await harness.behavior.callRpc("board_get", null)).view).toEqual(view);
});

it("loads eligible choices without writes and refuses a changed PR after refetching at the click", async () => {
  const { harness, control, githubCalls } = await host();
  expect(await harness.behavior.callRpc("reviewers_get", { keys: [key] })).toMatchObject([{ candidates: [{ login: "alice" }] }]);
  expect(githubCalls.some((args) => args.includes("POST"))).toBe(false);
  const before = control.fetches;
  control.view = { ...view, prs: [{ ...row, segment: "ready", group: null }] };
  expect(await harness.behavior.callRpc("reviewers_request", { requests: [{ key, reviewers: ["alice"] }] })).toMatchObject({ sent: [], skipped: [{ key, reason: expect.stringMatching(/no longer needs/) }] });
  expect(control.fetches).toBe(before + 1);
  expect(githubCalls.some((args) => args.includes("POST"))).toBe(false);
});

it("claims reviewer requests before refetching so concurrent clicks cannot duplicate the write", async () => {
  const { harness, control, githubCalls } = await host();
  let release = () => {}; control.githubGate = new Promise<void>((resolve) => { release = resolve; });
  const first = harness.behavior.callRpc("reviewers_request", { requests: [{ key, reviewers: ["alice"] }] });
  await vi.waitFor(() => expect(githubCalls.length).toBeGreaterThan(0));
  expect(await harness.behavior.callRpc("reviewers_request", { requests: [{ key, reviewers: ["alice"] }] })).toEqual({ sent: [], skipped: [{ key, reason: "A review request is already sending." }] });
  release();
  expect(await first).toEqual({ sent: [key], skipped: [] });
  expect(githubCalls.filter((args) => args.includes("POST"))).toHaveLength(1);
});

it("sends no review requests when GitHub cannot be rechecked", async () => {
  const { harness, control, githubCalls } = await host(); control.fetchError = true;
  await expect(harness.behavior.callRpc("reviewers_request", { requests: [{ key, reviewers: ["alice"] }] })).rejects.toThrow(/No review requests sent/);
  expect(githubCalls).toEqual([]);
});


it("bounds a large reviewer picker and reuses repository eligibility and ownership reads within the operation", async () => {
  const { harness, control, githubCalls } = await host();
  control.codeowners = "* @alice"; control.githubDelay = 2;
  control.view = { ...view, prs: Array.from({ length: 100 }, (_, index) => ({ ...row, key: `acme/repo#${index + 1}`, number: index + 1 })) };
  await harness.behavior.callRpc("board_refresh", null);
  const choices = await harness.behavior.callRpc("reviewers_get", { keys: control.view.prs.map((item) => item.key) });
  expect(choices).toHaveLength(100);
  expect(control.maxActive).toBeLessThanOrEqual(4);
  expect(githubCalls.filter((args) => args[1]?.includes("collaborators"))).toHaveLength(1);
  expect(githubCalls.filter((args) => args[1]?.includes("contents"))).toHaveLength(1);
  expect(githubCalls.filter((args) => args[1]?.includes("/files"))).toHaveLength(100);
  expect(githubCalls.some((args) => args.includes("POST"))).toBe(false);
});

it("reuses missing ownership results while keeping the next picker attempt fresh", async () => {
  const { harness, control, githubCalls } = await host();
  control.view = { ...view, prs: [row, { ...row, key: "acme/repo#8", number: 8 }] };
  await harness.behavior.callRpc("board_refresh", null);
  await harness.behavior.callRpc("reviewers_get", { keys: control.view.prs.map((item) => item.key) });
  expect(githubCalls.filter((args) => args[1]?.includes("collaborators"))).toHaveLength(1);
  expect(githubCalls.filter((args) => args[1]?.includes("contents"))).toHaveLength(3);
  await harness.behavior.callRpc("reviewers_get", { keys: [key] });
  expect(githubCalls.filter((args) => args[1]?.includes("collaborators"))).toHaveLength(2);
  expect(githubCalls.filter((args) => args[1]?.includes("contents"))).toHaveLength(6);
});
