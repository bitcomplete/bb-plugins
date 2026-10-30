import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { advancePreviewJobSchema } from "./bulk-advance.js";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { yourTurnRows } from "./inventory-view-model.js";
import type { DeckView } from "./deck.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z", ...extra }]))!.pr;
const unit = (path: string, value: Pr | null): RawUnit => ({ path, dirName: path.split("/").pop()!, repo: "folio", githubRepo: "inkwell/folio", branch: value?.headRefName ?? "main",
  dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: value, shipped: null, changedPaths: [], observed: { status: true, pr: true } });
const CHANGES = { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto-v" }, state: "CHANGES_REQUESTED", submittedAt: "2026-09-22T15:00:00Z" }] };
const BATCH = "00000000-0000-4000-8000-000000000081", JOB = "00000000-0000-4000-8000-000000000082", MERGED_JOB = "00000000-0000-4000-8000-000000000084";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * You author #313 (a green draft), #314 (ABC-341, no reviewer yet, with a legacy Advance worker), #315 (held, with changes requested), and
 * #316 (changes requested). A teammate's #400 is checked out; #401 was never read; #402 belongs to an archived effort; #403 merged; a legacy
 * Advance job saw #404 merge, and nothing else read it.
 */
async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [{ ...makeThreadResponse({ id: "thr-worker", title: "Advance worker for #314", projectId: "project-folio", status: "idle" }),
        queuedWork: "none", hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0,
          activePlanModeCount: 0, activeWorkflowCount: 0 } }] as never,
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project-folio", status: "idle" }) as never,
      getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, output: async () => ({ output: "" }),
    },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [unit("/p/folio", null), unit("/p/folio-400", pr(400, "Shelve box sets together")),
      unit("/p/folio-403", pr(403, "Shelve atlases flat", { state: "MERGED" }))], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [
      pr(313, "Keep shelf order on reload", { isDraft: true }), pr(314, "ABC-341 Group shelves by genre"), pr(315, "Sort shelves by author", CHANGES),
      pr(316, "Shelve series in order", CHANGES),
    ].map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  const facts = { prUrl: url(314), number: 314, title: "ABC-341 Group shelves by genre", repo: "inkwell/folio", headRefName: "branch-314", baseRefName: "main",
    headOid: "a".repeat(40), baseOid: "d".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", needsPreparation: false, readiness: "needs-attention", detail: "Needs a review", unresolvedThreads: 0, threadsComplete: true,
    checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } };
  const db = bb.storage.database();
  db.prepare("CREATE TABLE IF NOT EXISTS advance_batches (id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
  const job = { ...advancePreviewJobSchema.parse({ ...facts, eligible: true, workspace: "create" }), id: JOB, hiddenFromProgress: false, status: "needs-attention",
    attemptId: null, dedicated: false, previousAttempts: [], threadId: "thr-worker", path: null, checkedHeadOid: null, updatedAt: Date.now(), uncertain: false };
  const routing = { eligible: true, workspace: "create", projectId: "project-folio", hostId: HOST, sourcePath: null, path: null, effortId: null, effortKey: null,
    effortMembers: null, needsFeedback: false, needsChecks: false, blockedBy: null };
  const merged = { ...facts, prUrl: url(404), number: 404, title: "Shelve maps flat", state: "MERGED" as const, readiness: "merged" as const };
  db.prepare("INSERT INTO advance_batches (id, body) VALUES (?, ?)").run(BATCH, JSON.stringify({ id: BATCH, token: "00000000-0000-4000-8000-000000000083",
    createdAt: Date.now(), cancelled: false, jobs: [job, { ...job, ...advancePreviewJobSchema.parse({ ...merged, eligible: false, workspace: "create" }), id: MERGED_JOB,
      status: "merged", threadId: null }], facts: { [JOB]: { ...facts, ...routing }, [MERGED_JOB]: { ...merged, ...routing } },
    pollUntil: Date.now() + 60_000, prepared: {}, repairs: {} }));
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(db);
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [url(400), url(401), url(403), url(404)] } });
  const old = efforts.establish({ sourceKey: "pr:402", name: "Old shelving", goal: "Retired", projectId: "project-folio", coordinatorState: "none",
    members: { tickets: [], prUrls: [url(402)] } });
  efforts.setArchived(old.id, true);
  createPrHoldStore(db).set(url(315), true, "Waiting on the store layout review");
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { harness, bb, db, shelf, facts, get: async (input: object = {}) => await harness.callRpc("inventory_get", input) as InventoryView };
}

describe("the PR inventory read model", () => {
  it("lists your open PRs and every open PR an effort names, under the effort that owns each, explicitly or by ticket", async () => {
    const env = await setup();
    const view = await env.get();
    expect(view.groups.map((group) => [group.effort?.name ?? null, group.rows.map((row) => row.number)])).toEqual([
      // #402's effort is archived, and #403 and #404 merged, so none is open work here.
      ["Shelf order", [314, 400, 401]], [null, [313, 315, 316]]]);
    const rows = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.number, row]));
    expect(rows.get(313)).toMatchObject({ authored: true, draft: true, status: "Draft", attention: [{ question: "forgotten-draft", action: "mark-ready", owner: "you" }],
      checkedAt: expect.any(String), failure: null });
    expect(rows.get(314)).toMatchObject({ authored: true, status: "No reviewer", attention: [{ question: "missing-reviewer", nextStep: "Request a review" }],
      threads: { origin: null, executor: { id: "thr-worker", active: false } } });
    // Held: every step would be refused, so none is offered.
    expect(rows.get(315)).toMatchObject({ hold: { reason: "Waiting on the store layout review" }, status: "On hold", attention: [] });
    // A teammate's PR reads its checkout and asks nothing of you.
    expect(rows.get(400)).toMatchObject({ authored: false, title: "Shelve box sets together", status: "No reviewer", attention: [] });
    expect(rows.get(401)).toMatchObject({ authored: false, title: "", status: "Not read yet", checkedAt: null });
    expect(view.counts).toEqual({ "forgotten-draft": 1, "missing-reviewer": 1, "needs-nudge": 0 });
    expect(view).toMatchObject({ checkedAt: expect.any(String), refreshing: false, rateLimitedUntil: null });
  });

  // Your turn is one rule (turnOf) over the server's facts in both read models, so the badge, All PRs, and the deck agree; a held PR waits
  // in Held on its card.
  it("marks Your turn in inventory_get and deck_get, never on a held PR, and signals when a release makes it yours again", async () => {
    const env = await setup();
    const turns = async () => yourTurnRows(await env.get(), Date.now()).map((line) => [line.number, line.yourTurn!.why]);
    expect(await turns()).toEqual([[316, "Changes requested by @otto-v"]]);
    const deck = await env.harness.callRpc("deck_get", {}) as DeckView;
    const rows = [...deck.active, ...deck.held].flatMap((card) => card.sections.flatMap((section) => section.rows));
    expect(rows.find((row) => row.number === 316)?.turn).toEqual({ list: "turn", addressable: true });
    expect(rows.find((row) => row.number === 315)).toMatchObject({ section: "held", turn: { list: "held", addressable: "On hold. Release it first." } });
    const before = env.harness.inspection.realtimeSignals.length;
    await env.harness.callRpc("pr_hold_set", { prUrl: url(315), held: false });
    expect(env.harness.inspection.realtimeSignals.slice(before).map((signal) => signal.channel)).toContain("inventory-changed");
    expect(await turns()).toEqual([[315, "Changes requested by @otto-v"], [316, "Changes requested by @otto-v"]]);
  });

  // Dismiss, as Reviews dismisses: one plugin KV key per PR and no table, so a rollback reads nothing new. It holds on the head and the
  // newest word its row showed; a new head, or a word newer than that, brings the PR back. Drop the head check and it never returns.
  it("hides a dismissed PR from Your turn on the head and word it saw, kept in plugin KV, until either moves or you bring it back", async () => {
    const env = await setup();
    const row = async () => (await env.get()).groups.flatMap((group) => group.rows).find((item) => item.number === 316)!;
    const shown = async () => [yourTurnRows(await env.get(), Date.now()).map((line) => line.number), (await row()).dismissed];
    const latest = (await row()).yourTurn!.latest;
    expect([await shown(), latest]).toEqual([[[316], false], expect.any(Number)]);
    expect(await env.harness.callRpc("inventory_dismiss", { prUrl: url(316), head: "a".repeat(40), latest })).toEqual({ ok: true });
    expect(await shown()).toEqual([[], true]);
    expect(await env.bb.storage.kv.list("yourTurnDismissed:")).toEqual([`yourTurnDismissed:${url(316)}`]);
    // Dismissed on an older head, or before the reviewer's word: the PR moved since, so it's back.
    await env.harness.callRpc("inventory_dismiss", { prUrl: url(316), head: "b".repeat(40), latest });
    expect(await shown()).toEqual([[316], false]);
    await env.harness.callRpc("inventory_dismiss", { prUrl: url(316), head: "a".repeat(40), latest: latest! - 1 });
    expect(await shown()).toEqual([[316], false]);
    await env.harness.callRpc("inventory_dismiss", { prUrl: url(316), head: null, latest: null });
    expect([await shown(), await env.bb.storage.kv.list("yourTurnDismissed:")]).toEqual([[[316], false], []]);
  });

  it("filters by question while still counting every row", async () => {
    const env = await setup();
    const reviewer = await env.get({ attention: "missing-reviewer" });
    expect(reviewer.groups.flatMap((group) => group.rows)).toMatchObject([{ number: 314, status: "No reviewer" }]);
    expect(reviewer.counts).toEqual({ "forgotten-draft": 1, "missing-reviewer": 1, "needs-nudge": 0 });
  });

  it("prints the inventory from the CLI, filters it, and signals each change", async () => {
    const env = await setup();
    const text = await env.harness.runCli(["inventory"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("1 forgotten in draft · 1 missing a reviewer · 0 need a nudge");
    expect(text.stdout).toContain("  inkwell/folio #314 · ABC-341 Group shelves by genre · no reviewer · No reviewer · Request a review (you, ");
    const drafts = JSON.parse((await env.harness.runCli(["inventory", "--attention", "draft", "--json"])).stdout) as InventoryView;
    expect(drafts.groups.flatMap((group) => group.rows.map((row) => row.number))).toEqual([313]);
    const before = env.harness.inspection.realtimeSignals.length;
    await env.harness.callRpc("pr_hold_set", { prUrl: url(313), held: true });
    expect(env.harness.inspection.realtimeSignals.slice(before).map((signal) => signal.channel)).toContain("inventory-changed");
  });
});
