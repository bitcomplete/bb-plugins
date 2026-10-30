import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr } from "./contract.js";
import { ONE_OFFS_SOURCE } from "./effort-assignments.js";
import type { SuggestionGroup } from "./effort-classify.js";
import { createEffortPileStore } from "./effort-piles.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title, isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `reader/change${number}`, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const DEFAULT_AUTHORED = [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"), pr(316, "Remove an unused import")];
/** By default you author #313 and #316, which no effort owns, and #314, which Shelf order owns through ABC-341. */
async function setup(authored: Pr[] = DEFAULT_AUTHORED) {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(bb.storage.database());
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  const grouped = async () => Object.fromEntries((await call("inventory_get", {}) as InventoryView).groups
    .map((group) => [group.effort?.name ?? "No effort", group.rows.map((row) => row.number)]));
  return { bb, harness, efforts, shelf, call, grouped };
}

describe("Assigning PRs to an effort", () => {
  // You author #313 and #321 on ABC-350 (a lowercase key in their branches) and #316; Shelf order owns #314 through ABC-341.
  const authored = [{ ...pr(313, "Update the footer year"), headRefName: "reader/abc-350-footer" }, pr(314, "ABC-341 Group shelves by genre"),
    pr(316, "Remove an unused import"), { ...pr(321, "Footer links"), headRefName: "reader/abc-350-links" }];

  it("assigns PRs, and with their ticket, every later PR on that ticket joins without another click", async () => {
    const prs = [...authored];
    const env = await setup(prs);
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(316)] })).toMatchObject({ ok: true, added: 1, effort: { name: "Shelf order" } });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313, 321] });
    // A ticket brings every PR on it, so each open one must be in the selection: nothing moves that you didn't choose.
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(313)], tickets: ["ABC-350"] }))
      .toEqual({ ok: false, error: "ABC-350 is also on inkwell/folio #321. Choose it too, or leave ABC-350 out." });
    const withTicket = await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(313), url(321)], tickets: ["ABC-350"] });
    expect(withTicket).toMatchObject({ ok: true, added: 2 });
    prs.push({ ...pr(325, "Footer social links"), headRefName: "reader/abc-350-social" });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(await env.grouped()).toEqual({ "Shelf order": [313, 314, 316, 321, 325] });
    // Undo takes back the ticket too, so the later #325 is to sort again.
    await env.call("classify_undo", { actionId: withTicket.actionId });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313, 321, 325] });
  });

  // #314 is in Shelf order through ABC-341 and also names ABC-350. Another effort owning ABC-350 would give #314 two owners, which leaves it in neither.
  it("refuses a ticket that a PR in another effort carries, and a refused new effort is removed again", async () => {
    const env = await setup(authored.map((entry) => entry.number === 314 ? pr(314, "ABC-341 ABC-350 Group shelves by genre") : entry));
    const pickup = env.efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-330"], prUrls: [] } });
    const refusal = { ok: false, error: "inkwell/folio #314 carries ABC-350 and is in Shelf order. Leave ABC-350 out." };
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(321)], tickets: ["ABC-350"] })).toEqual(refusal);
    const count = env.efforts.listAll().length;
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(313), url(321)], tickets: ["ABC-350"],
      requestId: "66666666-6666-4666-8666-666666666666" })).toEqual(refusal);
    expect(env.efforts.listAll().length).toBe(count);
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(321)] })).toMatchObject({ ok: true, added: 2 });
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "Store pickup": [313, 321], "No effort": [316] });
  });

  it("refuses tickets the PRs don't carry, PRs another effort owns, and an effort that is done, and changes nothing", async () => {
    const env = await setup(authored);
    expect(await env.call("classify_assign", { effortKey: env.shelf.key, prUrls: [url(316)], tickets: ["ABC-350"] }))
      .toEqual({ ok: false, error: "These PRs don't carry ABC-350." });
    const pickup = env.efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-330"], prUrls: [] } });
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313), url(314)] }))
      .toEqual({ ok: false, error: "inkwell/folio #314 is in an effort now. Refresh and try again." });
    createEffortPileStore(env.bb.storage.database()).move(pickup, "complete");
    expect(await env.call("classify_assign", { effortKey: pickup.key, prUrls: [url(313)] })).toEqual({ ok: false, error: "Reopen this effort first." });
    // An archived effort is out of use.
    const vault = env.efforts.establish({ sourceKey: "ticket:ABC-360", name: "Vault audits", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-360"], prUrls: [] } });
    env.efforts.setArchived(vault.id, true);
    expect(await env.call("classify_assign", { effortKey: vault.key, prUrls: [url(313)] })).toEqual({ ok: false, error: "Restore this effort first." });
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
  });

  it("starts a new effort from a selection, and undoing it removes the effort so its name is free again", async () => {
    const env = await setup(authored);
    const requestId = "22222222-2222-4222-8222-222222222222";
    const created = await env.call("classify_new_effort", { name: " Footer  refresh ", goal: "A footer readers can use", prUrls: [url(313), url(321)],
      tickets: ["ABC-350"], requestId });
    expect(created).toMatchObject({ ok: true, added: 2, effort: { name: "Footer refresh" } });
    expect(env.efforts.get(created.effort.id)).toMatchObject({ goal: "A footer readers can use", members: { tickets: ["ABC-350"] } });
    expect(await env.grouped()).toEqual({ "Footer refresh": [313, 321], "Shelf order": [314], "No effort": [316] });
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(316)], requestId }))
      .toEqual({ ok: false, error: "This effort was already created. Refresh the deck." });
    expect(await env.call("classify_undo", { actionId: created.actionId })).toEqual({ ok: true });
    expect(env.efforts.get(created.effort.id)).toBeNull();
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316, 321] });
    expect(await env.call("classify_new_effort", { name: "Footer refresh", goal: "", prUrls: [url(313)], requestId: "33333333-3333-4333-8333-333333333333" }))
      .toMatchObject({ ok: true, effort: { name: "Footer refresh" } });
  });

  it("creates no effort when the name is taken or a PR has an owner", async () => {
    const env = await setup(authored);
    const count = () => env.efforts.listAll().length;
    const before = count();
    expect(await env.call("classify_new_effort", { name: "shelf ORDER", goal: "", prUrls: [url(313)], requestId: "44444444-4444-4444-8444-444444444444" }))
      .toEqual({ ok: false, error: "An effort with that name already exists." });
    expect(await env.call("classify_new_effort", { name: "Shelving", goal: "", prUrls: [url(314)], requestId: "55555555-5555-4555-8555-555555555555" }))
      .toMatchObject({ ok: false });
    expect(count()).toBe(before);
  });
});

describe("One-offs", () => {
  it("creates One-offs on first use, reuses it after, and undoes a mark back to No effort", async () => {
    const env = await setup();
    const first = await env.call("classify_one_off", { prUrls: [url(313)] });
    expect(first).toEqual({ ok: true, actionId: expect.any(String), effort: { id: expect.any(String), key: expect.any(String), name: "One-offs" }, added: 1 });
    expect(env.efforts.source(ONE_OFFS_SOURCE)?.id).toBe(first.effort.id);
    expect(await env.grouped()).toEqual({ "One-offs": [313], "Shelf order": [314], "No effort": [316] });
    expect((await env.call("classify_one_off", { prUrls: [url(316)] })).effort.id).toBe(first.effort.id);
    expect(await env.call("classify_undo", { actionId: first.actionId })).toEqual({ ok: true });
    expect(await env.grouped()).toEqual({ "One-offs": [316], "Shelf order": [314], "No effort": [313] });
  });

  // Owning through a ticket is still owning: marking #314 one-off would silently take it from Shelf order.
  it("marks only PRs no effort owns, and a refused first use creates nothing", async () => {
    const env = await setup();
    expect(await env.call("classify_one_off", { prUrls: [url(313), url(314)] }))
      .toEqual({ ok: false, error: "inkwell/folio #314 is in an effort now. Refresh and try again." });
    expect(env.efforts.source(ONE_OFFS_SOURCE)).toBeNull();
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316] });
  });

  // Move to One-offs from an effort's card: an explicit move out of the effort that has the PR now, which Undo reverses exactly.
  it("moves PRs an effort owns into One-offs, creating it on first use, and Undo puts each back", async () => {
    const env = await setup();
    // #316 is Shelf order's by its own row; #314 only through ABC-341.
    env.efforts.transfer(env.shelf.key, { tickets: [], prUrls: [url(316)] });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313] });
    const moved = await env.call("classify_one_off", { prUrls: [url(314), url(316)], from: env.shelf.id });
    expect(moved).toEqual({ ok: true, actionId: expect.any(String), effort: { id: expect.any(String), key: expect.any(String), name: "One-offs" }, added: 2 });
    expect(env.efforts.source(ONE_OFFS_SOURCE)?.id).toBe(moved.effort.id);
    expect(await env.grouped()).toEqual({ "One-offs": [314, 316], "No effort": [313] });
    // The audit row names where each came from.
    expect(env.bb.storage.database().prepare(`SELECT ref, source, from_effort_id AS "from" FROM effort_assignments ORDER BY seq`).all()).toEqual([
      { ref: url(314), source: "one-off", from: null }, { ref: url(316), source: "one-off", from: env.shelf.id }]);
    // Its ticket stays with Shelf order.
    expect(env.efforts.owner("ticket", "ABC-341")?.id).toBe(env.shelf.id);

    expect(await env.call("classify_undo", { actionId: moved.actionId })).toEqual({ ok: true });
    expect(await env.grouped()).toEqual({ "Shelf order": [314, 316], "No effort": [313] });
    expect(env.efforts.get(env.shelf.id)!.members.prUrls).toEqual([url(316)]);
  });

  // `from` names the card you moved them from: a PR that left it since, or never had it, moves nowhere, and a refused first use creates nothing.
  it("moves only PRs the named effort has now, and never out of One-offs", async () => {
    const env = await setup();
    expect(await env.call("classify_one_off", { prUrls: [url(314), url(313)], from: env.shelf.id }))
      .toEqual({ ok: false, error: "inkwell/folio #313 isn't in Shelf order now. Refresh and try again." });
    expect(env.efforts.source(ONE_OFFS_SOURCE)).toBeNull();
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316] });
    const { effort } = await env.call("classify_one_off", { prUrls: [url(313)] });
    expect(await env.call("classify_one_off", { prUrls: [url(313)], from: effort.id })).toEqual({ ok: false, error: "These are in One-offs already." });
  });

  it("keeps One-offs on the active pile", async () => {
    const env = await setup();
    const { effort } = await env.call("classify_one_off", { prUrls: [url(313)] });
    for (const method of ["effort_hold", "effort_complete"]) expect(await env.call(method, { effortKey: effort.key }))
      .toEqual({ ok: false, error: "One-offs stays active: each one-off merges on its own." });
  });

  // One-offs holds unrelated PRs, so a ticket a one-off shares with a PR to sort says nothing about where that PR belongs.
  it("is never suggested as an effort to join", async () => {
    const env = await setup([{ ...pr(313, "Update the footer year"), headRefName: "reader/abc-350-footer" }, pr(314, "ABC-341 Group shelves by genre"),
      { ...pr(321, "Footer links"), headRefName: "reader/abc-350-links" }]);
    await env.call("classify_one_off", { prUrls: [url(313)] });
    const { groups } = await env.call("classify_get", null) as { groups: SuggestionGroup[] };
    expect(groups.map((group) => [group.key, group.prs.map((row) => row.number)])).toEqual([["none", [321]]]);
  });
});

// All PRs routes selected rows from any group, so a move takes PRs out of whichever effort has them, and Undo has to know where each was.
describe("Moving PRs from All PRs", () => {
  it("moves PRs from No effort and from another effort into the one you pick, and Undo puts each back where it was", async () => {
    const env = await setup();
    const pickup = env.efforts.establish({ sourceKey: "ticket:ABC-330", name: "Store pickup", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-330"], prUrls: [] } });
    // #314 is Shelf order's only through ABC-341, which stays with Shelf order.
    const moved = await env.call("classify_move", { prUrls: [url(313), url(314)], to: { kind: "effort", effortKey: pickup.id } });
    expect(moved).toMatchObject({ ok: true, added: 2, effort: { name: "Store pickup" } });
    expect(await env.grouped()).toEqual({ "Store pickup": [313, 314], "No effort": [316] });
    expect(env.efforts.owner("ticket", "ABC-341")?.id).toBe(env.shelf.id);
    expect(await env.call("classify_move", { prUrls: [url(313)], to: { kind: "effort", effortKey: pickup.id } }))
      .toEqual({ ok: false, error: "These are in Store pickup already." });
    expect(await env.call("classify_undo", { actionId: moved.actionId })).toEqual({ ok: true });
    expect(await env.grouped()).toEqual({ "Shelf order": [314], "No effort": [313, 316] });
  });

  it("starts a new effort with the PRs and removes it again on Undo; One-offs comes on first use", async () => {
    const env = await setup();
    const count = () => env.efforts.listAll().length;
    const before = count();
    const requestId = "77777777-7777-4777-8777-777777777777";
    const created = await env.call("classify_move", { prUrls: [url(313), url(314)], to: { kind: "new", name: " Footer  work ", requestId } });
    expect(created).toMatchObject({ ok: true, added: 2, effort: { name: "Footer work" } });
    expect(await env.grouped()).toEqual({ "Footer work": [313, 314], "No effort": [316] });
    // A lost reply's retry can't create it twice.
    expect(await env.call("classify_move", { prUrls: [url(316)], to: { kind: "new", name: "Footer work", requestId } }))
      .toEqual({ ok: false, error: "This effort was already created. Refresh and try again." });
    expect(await env.call("classify_undo", { actionId: created.actionId })).toEqual({ ok: true });
    expect([count(), await env.grouped()]).toEqual([before, { "Shelf order": [314], "No effort": [313, 316] }]);
    const oneOff = await env.call("classify_move", { prUrls: [url(314)], to: { kind: "one-off" } });
    expect(oneOff).toMatchObject({ ok: true, added: 1, effort: { name: "One-offs" } });
    expect(await env.grouped()).toEqual({ "One-offs": [314], "No effort": [313, 316] });
  });

  // A refusal changes nothing, and a destination it would have created isn't left behind empty.
  it("refuses a PR that isn't open now, a taken name, and a done effort, and creates nothing", async () => {
    const env = await setup();
    const count = () => env.efforts.listAll().length;
    const before = count();
    expect(await env.call("classify_move", { prUrls: [url(313), url(999)], to: { kind: "one-off" } }))
      .toEqual({ ok: false, error: "inkwell/folio #999 isn't open now. Refresh and try again." });
    expect(await env.call("classify_move", { prUrls: [url(313)], to: { kind: "new", name: "shelf ORDER", requestId: "88888888-8888-4888-8888-888888888888" } }))
      .toEqual({ ok: false, error: "An effort with that name already exists." });
    createEffortPileStore(env.bb.storage.database()).move(env.shelf, "complete");
    expect(await env.call("classify_move", { prUrls: [url(313)], to: { kind: "effort", effortKey: env.shelf.id } })).toEqual({ ok: false, error: "Reopen this effort first." });
    expect([count(), env.efforts.source(ONE_OFFS_SOURCE), await env.grouped()]).toEqual([before, null, { "Shelf order": [314], "No effort": [313, 316] }]);
  });

  // classify_get lists where Move to effort… can send PRs, and the suggestions you dismissed, by the effort each named.
  it("lists the active efforts, One-offs aside, and keeps a dismissed suggestion until you take it back", async () => {
    const env = await setup();
    await env.call("classify_move", { prUrls: [url(316)], to: { kind: "one-off" } });
    const held = env.efforts.establish({ sourceKey: "ticket:ABC-370", name: "Gift cards", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    createEffortPileStore(env.bb.storage.database()).move(held, "hold", "Waiting on the vendor");
    expect(await env.call("classify_dismiss", { prUrl: url(313), effortId: env.shelf.id })).toEqual({ ok: true });
    const read = await env.call("classify_get", null);
    expect([read.efforts, read.dismissed]).toEqual([[{ id: env.shelf.id, name: "Shelf order" }], { [url(313)]: env.shelf.id }]);
    await env.call("classify_dismiss", { prUrl: url(313), effortId: null });
    expect((await env.call("classify_get", null)).dismissed).toEqual({});
  });
});

/**
 * You author #313, #316, #317, #320, and #318 (in the done Quill export). #314 is in Shelf order through ABC-341. "Direct work" links #313
 * and #314 through its own metadata; "Checkout work" names #314 too, but reaches #316 only by running in #316's checkout.
 */
async function setupSuggestions() {
  const thread = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ ...makeThreadResponse({ id, title, projectId: "project-folio",
    originPluginId: "workstreams" }), environmentPath: null, environmentBranchName: null, queuedWork: "none", hasPendingInteraction: false,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, ...extra });
  const metadata: Record<string, Record<string, unknown>> = { "thr-direct": { linkedPrUrl: url(313), prUrl: url(314) }, "thr-checkout": { linkedPrUrl: url(314) } };
  const authored = [pr(313, "Update the footer year"), pr(314, "ABC-341 Group shelves by genre"), { ...pr(316, "Sort shelves by author"), headRefName: "abc-316-sort" },
    pr(317, "Remove an unused import"), pr(318, "ABC-900 Export notes as EPUB"), { ...pr(320, "EPUB cover images"), headRefName: "abc-900-covers" }];
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: {
      list: async () => [thread("thr-direct", "Direct work"), thread("thr-checkout", "Checkout work", { environmentPath: "/p/folio-316", environmentBranchName: "abc-316-sort" })] as never,
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project-folio" }) as never,
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata[threadId] ?? {}) as never, events: { list: async () => [] },
    },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [{ path: "/p/folio-316", dirName: "folio-316", repo: "folio", githubRepo: "inkwell/folio",
      branch: "abc-316-sort", dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: authored[2], shipped: null, changedPaths: [],
      observed: { status: true, pr: true } }], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const efforts = createEffortStore(bb.storage.database());
  const shelf = efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  const quill = efforts.establish({ sourceKey: "pr:318", name: "Quill export", goal: "Export notes", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: [], prUrls: [url(318)] } });
  createEffortPileStore(bb.storage.database()).move(quill, "complete");
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return { shelf, get: async () => await harness.callRpc("classify_get" as never, null as never) as { groups: SuggestionGroup[]; oneOffsId: string | null } };
}

describe("suggestions over RPC", () => {
  it("suggests only for your PRs no effort owns, from threads' own links, never into a done effort", async () => {
    const env = await setupSuggestions();
    const { groups, oneOffsId } = await env.get();
    expect(oneOffsId).toBeNull();
    expect(groups.map((group) => [group.key, group.prs.map((row) => row.number), group.prs.map((row) => row.signals.map((signal) => signal.text))])).toEqual([
      [`effort:${env.shelf.id}:medium`, [313], [["thread “Direct work”"]]],
      // "Checkout work" names Shelf order's #314, but only runs in #316's checkout, so #316 stays standalone.
      ["one-off", [316], [["standalone ticket ABC-316"]]],
      // #320 shares ABC-900 with the done Quill export, which takes no new work.
      ["none", [317, 320], [[], []]],
    ]);
  });
});

describe("Standing rules", () => {
  const later = () => new Date(Date.now() + 60_000).toISOString();
  /**
   * You author #313 (on OPS-40, opened long ago), #316, and #311, which Vault audits owns and which is also on OPS-40: a high-confidence
   * suggestion puts #313 in Vault audits. Shelf order owns #314.
   */
  async function setupRules() {
    const authored = [{ ...pr(313, "Update the footer year"), headRefName: "reader/ops-40-footer" }, pr(314, "ABC-341 Group shelves by genre"),
      pr(316, "Remove an unused import"), { ...pr(311, "Rotate vault audit keys"), headRefName: "ops-40-keys" }];
    const env = await setup(authored);
    const vault = env.efforts.establish({ sourceKey: "pr:311", name: "Vault audits", goal: "Audit the vault", projectId: "", coordinatorState: "none",
      members: { tickets: [], prUrls: [url(311)] } });
    const audit = () => env.bb.storage.database().prepare(`SELECT source, rule_id AS ruleId, ref, undone_at AS undoneAt, action_id AS actionId
      FROM effort_assignments ORDER BY seq`).all() as { source: string; ruleId: string | null; ref: string; undoneAt: number | null; actionId: string }[];
    const refresh = async () => expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    return { ...env, authored, vault, audit, refresh };
  }

  it("moves nothing on a suggestion alone, and a rule you add places only PRs opened after it, each with an audit row", async () => {
    const env = await setupRules();
    const suggested = (await env.call("classify_get", null)).groups.find((group: SuggestionGroup) => group.prs.some((row) => row.number === 313));
    expect(suggested).toMatchObject({ key: `effort:${env.vault.id}:high` });
    await env.refresh();
    expect(await env.grouped()).toMatchObject({ "No effort": [313, 316] });
    const added = await env.call("classify_rule_add", { kind: "ticket-prefix", value: "ops", effortKey: env.vault.key, now: false });
    expect(added).toEqual({ ok: true, rule: { id: expect.any(String), kind: "ticket-prefix", value: "OPS", effortId: env.vault.id, createdAt: expect.any(Number) },
      actions: [] });
    env.authored.push({ ...pr(322, "Rotate reader tokens"), headRefName: "reader/ops-44-rotate", createdAt: later() });
    await env.refresh();
    await vi.waitFor(async () => expect(await env.grouped()).toMatchObject({ "Vault audits": [311, 322] }));
    // #313 matches too, but was open before the rule: it waits for your click.
    expect((await env.grouped())["No effort"]).toEqual([313, 316]);
    expect(env.audit()).toEqual([{ source: "rule", ruleId: added.rule.id, ref: url(322), undoneAt: null, actionId: expect.any(String) }]);
    expect((await env.call("classify_get", null)).rules).toEqual([{ ...added.rule, effortName: "Vault audits", hits: 1 }]);
  });

  it("places what a new rule matches today when you ask, as one undoable action, after showing exactly what will move", async () => {
    const env = await setupRules();
    expect(await env.call("classify_rule_preview", { kind: "ticket-prefix", value: "ops", effortKey: env.vault.key })).toEqual({ ok: true, prUrls: [url(313)] });
    expect(await env.call("classify_rule_preview", { kind: "ticket-prefix", value: "OPS-4", effortKey: env.vault.key }))
      .toEqual({ ok: false, error: "Enter a ticket prefix such as ABC." });
    expect(await env.grouped()).toMatchObject({ "No effort": [313, 316] });
    const added = await env.call("classify_rule_add", { kind: "ticket-prefix", value: "OPS", effortKey: env.vault.key, now: true });
    expect(added.actions).toEqual([{ ok: true, actionId: expect.any(String), effort: { id: env.vault.id, key: env.vault.key, name: "Vault audits" }, added: 1 }]);
    expect(await env.grouped()).toMatchObject({ "Vault audits": [311, 313], "No effort": [316] });
    expect(await env.call("classify_undo", { actionId: added.actions[0].actionId })).toEqual({ ok: true });
    expect(await env.grouped()).toMatchObject({ "Vault audits": [311], "No effort": [313, 316] });
  });

  it("never places a PR again after you undo a rule's placement of it", async () => {
    const env = await setupRules();
    await env.call("classify_rule_add", { kind: "ticket-prefix", value: "OPS", effortKey: env.vault.key, now: false });
    env.authored.push({ ...pr(322, "Rotate reader tokens"), headRefName: "reader/ops-44-rotate", createdAt: later() });
    await env.refresh();
    await vi.waitFor(async () => expect(await env.grouped()).toMatchObject({ "Vault audits": [311, 322] }));
    expect(await env.call("classify_undo", { actionId: env.audit()[0]!.actionId })).toEqual({ ok: true });
    env.authored.push({ ...pr(324, "Expire reader tokens"), headRefName: "ops-45-expire", createdAt: later() });
    await env.refresh();
    await vi.waitFor(async () => expect(await env.grouped()).toMatchObject({ "Vault audits": [311, 324] }));
    expect((await env.grouped())["No effort"]).toEqual([313, 316, 322]);
  });

  it("files a stacked PR with its base's effort under a stack rule", async () => {
    const env = await setupRules();
    env.authored.push({ ...pr(323, "Shelf drag handles"), baseRefName: "reader/change314", createdAt: later() });
    await env.refresh();
    expect(await env.call("classify_rule_add", { kind: "stack", value: "", effortKey: null, now: true })).toMatchObject({ ok: true,
      actions: [{ effort: { name: "Shelf order" }, added: 1 }] });
    expect(await env.grouped()).toMatchObject({ "Shelf order": [314, 323] });
  });

  it("refuses rules it can't apply as written, and removing one leaves the PRs it placed", async () => {
    const env = await setupRules();
    const add = (input: object) => env.call("classify_rule_add", { now: false, ...input });
    expect(await add({ kind: "stack", value: "", effortKey: env.shelf.key })).toMatchObject({ ok: false, error: expect.stringContaining("A stack rule names no effort") });
    expect(await add({ kind: "ticket-prefix", value: "OPS-4", effortKey: env.vault.key })).toEqual({ ok: false, error: "Enter a ticket prefix such as ABC." });
    createEffortPileStore(env.bb.storage.database()).move(env.shelf, "complete");
    expect(await add({ kind: "repo", value: "folio", effortKey: env.shelf.key })).toEqual({ ok: false, error: "Choose an effort that isn't archived or done." });
    const rule = (await env.call("classify_rule_add", { kind: "branch", value: "reader/ops-*", effortKey: env.vault.key, now: true })).rule;
    expect(await add({ kind: "branch", value: "Reader/OPS-*", effortKey: env.vault.key })).toEqual({ ok: false, error: "That rule already exists." });
    expect(await env.call("classify_rule_remove", { ruleId: rule.id })).toEqual({ ok: true });
    expect(await env.grouped()).toMatchObject({ "Vault audits": [311, 313] });
    expect((await env.call("classify_get", null)).rules).toEqual([]);
  });
});
