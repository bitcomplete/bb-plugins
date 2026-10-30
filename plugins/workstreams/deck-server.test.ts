import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { DeckView } from "./deck.js";
import type { ThreadEffortReady } from "./thread-effort.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: `branch-${number}`, baseRefName: "main",
  headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: daysAgo(4), ...extra }]))!.pr;
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
  lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** A visible thread of this plugin's, running in `path` when it has one. */
const thread = (id: string, title: string, path: string | null = null) => ({ ...makeThreadResponse({ id, title, projectId: "project-folio", originPluginId: "workstreams" }),
  environmentPath: path, environmentBranchName: null, queuedWork: "none", hasPendingInteraction: false, ...path ? { environment: { path } } : {},
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } });

/**
 * Shelf order owns ABC-500 and folio #401, a green draft; #402 carries ABC-500; #402 and #403 have no reviewer, and #403 has no effort.
 * `threads`, `units`, and `metadata` stand in for BB's threads, the scanned checkouts, and each thread's plugin metadata.
 */
async function setup(world: { threads?: ReturnType<typeof thread>[]; units?: RawUnit[]; metadata?: Record<string, Record<string, unknown>> } = {}) {
  const metadata = world.metadata ?? {};
  const current = new Map<number, Pr>([
    [401, pr(401, "ABC-501 Store shelf order", { isDraft: true })],
    [402, pr(402, "ABC-500 Read shelf order back")],
    [403, pr(403, "ABC-610 Fix the footer year")],
  ]);
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => (world.threads ?? []) as never, getPluginMetadata: async ({ threadId }: { threadId: string }) => (metadata[threadId] ?? {}) as never,
      get: async ({ threadId }: { threadId: string }) => (world.threads ?? []).find((item) => item.id === threadId) ?? Promise.reject(new Error("missing thread")),
      events: { list: async () => [] }, spawn: async () => { throw new Error("The deck starts no thread."); } },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (method === "scan" || method === "inspectPaths") return { units: world.units ?? [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].filter((entry) => entry.state === "OPEN")
      .map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") {
      const read = (input as { prUrls: string[] }).prUrls.map((prUrl) => current.get(Number(prUrl.split("/").pop()))!);
      const open = read.filter((entry) => entry.state === "OPEN"), merged = read.filter((entry) => entry.state === "MERGED");
      return { entries: open.map((entry) => ({ repo: "inkwell/folio", pr: entry })), closed: merged.map((entry) => entry.url), failed: [], warnings: [],
        merged: merged.map((entry) => ({ url: entry.url, at: entry.mergedAt!, title: entry.title, headRefName: entry.headRefName })) };
    }
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const effort = createEffortStore(bb.storage.database()).establish({ sourceKey: "ticket:ABC-500", name: "Shelf order", goal: "Keep shelves in order",
    projectId: "project-folio", coordinatorState: "none", members: { tickets: ["ABC-500"], prUrls: [url(401)] } });
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const deck = async () => await harness.callRpc("deck_get", {}) as DeckView;
  const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "deck-changed").length;
  return { harness, current, effort, deck, signals, metadata, db: bb.storage.database(), rpc: (method: string, value: unknown) => harness.callRpc(method as never, value as never) };
}

describe("the effort deck on the server", () => {
  it("draws each effort's card from the inventory's rows by the move each needs, and a service card for the PRs no effort owns", async () => {
    const env = await setup();
    const view = await env.deck();
    expect(view.active.map((card) => ({ name: card.name, kind: card.kind, needsYou: card.needsYou,
      sections: card.sections.map((section) => [section.key, section.rows.map((row) => row.number)]) }))).toEqual([
      { name: "Shelf order", kind: "effort", needsYou: 2, sections: [["request", [402]], ["ready", [401]]] },
      // #403 has no effort, so it's on folio's service card, and its move is yours like any other.
      { name: "folio · service", kind: "service", needsYou: 1, sections: [["request", [403]]] }]);
    expect(view.counts).toEqual({ needsYou: 3, held: 0, done: 0 });
  });

  it("plans a batch on a service card as on an effort's, from its own rows only, and starts it: a service card is always active", async () => {
    const env = await setup();
    const service = "service:inkwell/folio";
    const plan = await env.rpc("deck_batch_plan", { kind: "request", effortId: service, reviewers: ["mira-l"] }) as { ok: true; batchId: string;
      items: { ref: string; what: string }[]; skipped: unknown[] };
    expect(plan).toMatchObject({ ok: true, items: [{ ref: "folio #403", what: "Request @mira-l" }], skipped: [] });
    expect(await env.rpc("deck_batch_start", { batchId: plan.batchId })).toMatchObject({ ok: true });
    expect(await env.rpc("deck_batch_undo", { batchId: plan.batchId })).toEqual({ ok: true });
    // Shelf order's #402 isn't on the service card, so a selection there leaves it out, and says why.
    expect(await env.rpc("deck_batch_plan", { kind: "request", effortId: service, prUrls: [url(402)], reviewers: ["mira-l"] }))
      .toMatchObject({ ok: true, batchId: null, items: [], skipped: [{ ref: "folio #402", reason: "Not an open PR on this card." }] });
  });

  it("promotes a service card to an effort with its PRs on one confirm, and Undo puts the service card back", async () => {
    const env = await setup();
    const made = await env.rpc("classify_new_effort", { name: "folio", goal: "", prUrls: [url(403)], requestId: crypto.randomUUID() }) as { ok: true; actionId: string };
    expect(made).toMatchObject({ ok: true, effort: { name: "folio" }, added: 1 });
    const view = await env.deck();
    expect(view.active.map((card) => [card.name, card.kind, card.sections.flatMap((section) => section.rows.map((row) => row.number))])).toEqual([
      ["Shelf order", "effort", [402, 401]], ["folio", "effort", [403]]]);
    expect(await env.rpc("classify_undo", { actionId: made.actionId })).toEqual({ ok: true });
    expect((await env.deck()).active.map((card) => card.name)).toEqual(["Shelf order", "folio · service"]);
  });

  it("says what became of each row the view drew that left: merged, with when, or closed, and nothing of one still open", async () => {
    const env = await setup();
    env.current.set(402, { ...env.current.get(402)!, state: "MERGED", mergedAt: daysAgo(1) });
    expect(await env.rpc("pr_refresh_many", { prUrls: [url(402)] })).toMatchObject({ reads: [{ read: { status: "checked" } }] });
    env.current.set(403, { ...env.current.get(403)!, state: "CLOSED" });
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const view = await env.harness.callRpc("deck_get", { ghosts: [url(401), url(402), url(403), url(402)] }) as DeckView;
    expect(view.gone).toEqual([{ prUrl: url(402), how: "merged", at: Date.parse(env.current.get(402)!.mergedAt!) }, { prUrl: url(403), how: "closed", at: null }]);
    // Asked nothing, it says nothing.
    expect((await env.deck()).gone).toEqual([]);
  });

  it("counts a merge a read saw on the card of the effort whose ticket it carries, after the PR leaves the inventory", async () => {
    const env = await setup();
    env.current.set(402, { ...env.current.get(402)!, state: "MERGED", mergedAt: daysAgo(1) });
    expect(await env.rpc("pr_refresh_many", { prUrls: [url(402)] })).toMatchObject({ reads: [{ read: { status: "checked" } }] });
    const card = (await env.deck()).active[0]!;
    expect(card).toMatchObject({ name: "Shelf order", stats: { open: 1, mergedWeek: 1 }, progress: { merged: 1, open: 1 } });
    expect(card.activity.filter((item) => item.kind === "merged")).toEqual([{ kind: "merged", prUrl: url(402), ref: "folio #402", who: null,
      at: Date.parse(env.current.get(402)!.mergedAt!) }]);
  });

  it("tells the deck when an inventory read lands and when an effort moves piles, and files a held effort's card on hold", async () => {
    const env = await setup();
    const before = env.signals();
    expect(await env.rpc("inventory_refresh", null)).toEqual({ started: true });
    await vi.waitFor(() => expect(env.signals()).toBeGreaterThan(before));
    const moved = env.signals();
    expect(await env.rpc("effort_hold", { effortKey: env.effort.id, reason: "Design review" })).toMatchObject({ ok: true });
    expect(env.signals()).toBeGreaterThan(moved);
    // Its PRs pause with it; #403 still counts on the service card.
    expect(await env.deck()).toMatchObject({ active: [{ name: "folio · service" }], held: [{ name: "Shelf order", needsYou: 0, status: { text: "On hold: Design review" } }],
      counts: { needsYou: 1, held: 1 } });
  });

  it("keeps an archived effort's open PRs on the deck with the done efforts, and tells the deck it was archived", async () => {
    const env = await setup();
    const { scopes } = await env.rpc("effort_admin_list", null) as { scopes: Record<string, string> };
    const before = env.signals();
    expect(await env.rpc("effort_admin_archive", { effortKey: env.effort.key, archived: true, expectedScope: scopes[env.effort.key] })).toMatchObject({ ok: true });
    expect(env.signals()).toBeGreaterThan(before);
    // #401 and #402 pause, as a done effort's PRs do, and #403 is still on the service card.
    expect(await env.deck()).toMatchObject({ active: [{ name: "folio · service" }], done: [{ name: "Shelf order", archived: true, open: 2 }],
      counts: { needsYou: 1, held: 0, done: 1 } });
  });

  // The real case behind A17.1: many threads ran in one shared clone, and its checkout now has #403's branch. Each of them links to #403
  // through that checkout, which says nothing about #403, so none of them may land on its service card.
  it("puts every thread on a card by its own evidence: never a checkout it shares, a checkout of its own, a linked PR, or its effort", async () => {
    const clone: RawUnit = { ...UNIT, branch: "branch-403", pr: pr(403, "ABC-610 Fix the footer year") };
    const scratch: RawUnit = { ...UNIT, path: "/p/folio-scratch", dirName: "folio-scratch", branch: "scratch", pr: null };
    const env = await setup({ units: [clone, scratch], threads: [thread("thr-clone-a", "Check the footer", "/p/folio"),
      thread("thr-clone-b", "Look at a flaky test", "/p/folio"), thread("thr-scratch", "Try a quieter layout", "/p/folio-scratch"),
      thread("thr-linked", "Footer follow-up"), thread("thr-notes", "Shelf notes")],
      metadata: { "thr-linked": { linkedPrUrl: url(403) } } });
    // You put "Shelf notes" in Shelf order yourself.
    env.metadata["thr-notes"] = { workEffortId: env.effort.id };
    env.db.prepare(`INSERT INTO thread_work_intent_ids (thread_id) VALUES (?)`).run("thr-notes");
    const view = await env.deck();
    const threads = (id: string) => view.active.find((card) => card.id === id)?.threads.map((item) => `${item.id}${item.prUrl ? ` #${item.prUrl.split("/").pop()}` : ""}`).sort();
    expect(view.active.map((card) => card.name)).toEqual(["Shelf order", "folio · service", "Loose threads"]);
    expect(threads(env.effort.id)).toEqual(["thr-notes"]);
    expect(threads("service:inkwell/folio")).toEqual(["thr-linked #403", "thr-scratch"]);
    expect(threads("loose")).toEqual(["thr-clone-a", "thr-clone-b"]);
    // The thread's chip agrees with the deck: the popover still lists #403, which assigning the thread takes in, but the chip doesn't
    // file the thread under it.
    const shared = (await env.rpc("thread_effort_context", { threadId: "thr-clone-a", seen: {} }) as ThreadEffortReady).picker!;
    expect([shared.chip.name, shared.chip.card, shared.linked.map((item) => item.ref)]).toEqual(["No effort", null, ["folio #403"]]);
    const own = (await env.rpc("thread_effort_context", { threadId: "thr-scratch", seen: {} }) as ThreadEffortReady).picker!;
    expect([own.chip.name, own.chip.card, own.chip.yourTurn]).toEqual(["folio · service", "service:inkwell/folio", 0]);
    // Archiving Shelf order drops it from "Shelf notes", whose chip then says No effort, so the thread is on Loose threads, not lost.
    const { scopes } = await env.rpc("effort_admin_list", null) as { scopes: Record<string, string> };
    expect(await env.rpc("effort_admin_archive", { effortKey: env.effort.key, archived: true, expectedScope: scopes[env.effort.key] })).toMatchObject({ ok: true });
    const archived = await env.deck();
    expect(archived.active.find((card) => card.id === "loose")?.threads.map((item) => item.id).sort()).toEqual(["thr-clone-a", "thr-clone-b", "thr-notes"]);
    const notes = (await env.rpc("thread_effort_context", { threadId: "thr-notes", seen: {} }) as ThreadEffortReady).picker!;
    expect([notes.chip.kind, notes.chip.name]).toEqual(["none", "No effort"]);
  });

  // Two views can edit one effort's notes: a save names the revision it edited, so the later one is refused rather than silently lost.
  it("keeps each effort's notes with a revision, on its card, and refuses a save over notes that changed since they were opened", async () => {
    const env = await setup();
    const card = async () => (await env.deck()).active.find((item) => item.id === env.effort.id)!;
    expect((await card()).notes).toEqual({ body: "", revision: 0, updatedAt: null });
    const before = env.signals();
    const saved = await env.rpc("effort_notes_save", { effortKey: env.effort.key, body: "- `shelf_v2` on for staff\n\n", revision: 0 });
    expect(saved).toEqual({ ok: true, notes: { body: "- `shelf_v2` on for staff", revision: 1, updatedAt: expect.any(Number) } });
    expect(env.signals()).toBeGreaterThan(before);
    expect((await card()).notes).toMatchObject({ body: "- `shelf_v2` on for staff", revision: 1 });
    expect(await env.rpc("effort_notes_save", { effortKey: env.effort.id, body: "Stale edit", revision: 0 }))
      .toEqual({ ok: false, error: "These notes changed since you opened them. Copy your text, then open them again." });
    expect(await env.rpc("effort_notes_save", { effortKey: env.effort.id, body: "", revision: 1 })).toMatchObject({ ok: true, notes: { body: "", revision: 2 } });
    // A service card has no effort to keep notes in.
    expect((await env.deck()).active.find((item) => item.kind === "service")?.notes).toBeNull();
    expect(await env.rpc("effort_notes_save", { effortKey: "effort:missing", body: "x", revision: 0 })).toEqual({ ok: false, error: "The effort changed. Refresh the deck." });
  });
});
