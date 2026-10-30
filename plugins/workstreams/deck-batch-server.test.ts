import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import type { BatchItem, DeckBatch } from "./deck-batch.js";
import type { DeckView } from "./deck.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `branch-${number}`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: daysAgo(12), ...extra }]))!.pr;
const approved = { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: daysAgo(2) }] };
const FEEDBACK = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-504", "review-504b"] };
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
  lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

/**
 * Shelf order owns six of your PRs, one per move: #501 a green draft (Mark ready), #502 with no reviewer, which mira reviewed #506 in
 * (Request review), #503 mira hasn't answered in ten days (Nudge), #504 approved with two comments to confirm (Confirm), #505 approved and
 * clean (Merge, which no batch sends), and #506, which waits on no one.
 */
async function setup() {
  // The clock moves with the timers, so a restart's remaining window is measured as it would be.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const writes: unknown[] = [];
  const hang = { prUrl: null as string | null };
  const current = new Map<number, Pr>([
    [501, pr(501, { isDraft: true })], [502, pr(502)],
    [503, { ...pr(503, { reviewRequests: [{ login: "mira" }] }), reviewRequestedAt: [{ reviewer: "mira", at: daysAgo(10) }] }],
    [504, { ...pr(504, approved), approvalFeedback: FEEDBACK, unresolvedReviewThreads: 0, resolvedReviewThreads: 2, headCommittedAt: daysAgo(3) }],
    [505, { ...pr(505, approved), approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
      headCommittedAt: daysAgo(3) }],
    [506, pr(506, { latestReviews: [{ author: { login: "mira" }, state: "COMMENTED", submittedAt: daysAgo(3) }] })],
  ]);
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] },
      spawn: async () => { throw new Error("A batch starts no thread."); } },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: "inkwell/folio", pr: entry })),
      discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: "inkwell/folio",
      pr: current.get(Number(prUrl.split("/").pop()))! })), closed: [], failed: [], warnings: [] };
    if (method === "prWrite") {
      const request = input as { kind: string; prUrl: string; reviewers?: string[] };
      writes.push(input);
      if (request.prUrl === hang.prUrl) return new Promise(() => undefined);
      const number = Number(request.prUrl.split("/").pop());
      if (request.kind === "ready") current.set(number, { ...current.get(number)!, isDraft: false });
      if (request.kind === "nudge") current.set(number, { ...current.get(number)!, reviewRequests: request.reviewers!,
        reviewRequestedAt: request.reviewers!.map((reviewer) => ({ reviewer, at: new Date().toISOString() })) });
      return { ok: true, detail: `Wrote ${request.kind}.` };
    }
    // #504's note is in mira's approval body, and nothing came after it: no commit, reply, or thread.
    if (method === "approvalHandling") return { ok: true, headOid: HEAD, fingerprint: FEEDBACK.fingerprint, sources: [],
      evidence: { since: daysAgo(2), commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true } };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  const effort = createEffortStore(bb.storage.database()).establish({ sourceKey: "pr:501", name: "Shelf order", goal: "Keep shelves in order",
    projectId: "project-folio", coordinatorState: "none", members: { tickets: [], prUrls: [501, 502, 503, 504, 505, 506].map(url) } });
  const env = { harness, bb, current, writes, hang, effort, db: bb.storage.database(),
    rpc: (method: string, value: unknown) => env.harness.callRpc(method as never, value as never),
    batch: async (batchId: string) => await env.rpc("deck_batch_get", { batchId }) as DeckBatch,
    card: async (seen: Record<string, number> = {}) => (await env.rpc("deck_get", { seen }) as DeckView).active.find((card) => card.id === effort.id)!,
    /** Restart the plugin on the same database, as a host reload does. */
    restart: async () => { const next = await env.harness.lifecycle.reload(plugin); env.harness = next.harness; env.db = next.bb.storage.database(); },
  };
  cleanups.push(() => env.harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  return env;
}
type Env = Awaited<ReturnType<typeof setup>>;
const plan = async (env: Env, input: Record<string, unknown>) => await env.rpc("deck_batch_plan", { effortId: env.effort.id, ...input }) as
  { ok: true; batchId: string; items: BatchItem[]; skipped: { prUrl: string; reason: string }[] };
const settled = (env: Env, batchId: string) => vi.waitFor(async () => expect((await env.batch(batchId)).state).toBe("done"));

describe("deck batches on the server", () => {
  it("sends exactly what Advance planned, 8 seconds after you confirm, each through the inventory's guarded action, and never a merge", async () => {
    const env = await setup();
    const planned = await plan(env, { kind: "advance" });
    // Nudge, request, then mark ready. #504's review notes, #505's merge, and #506, which needs nothing, are not in it.
    expect(planned.items.map(({ prUrl, kind, what, reviewers, headOid, fingerprint, notes }) => ({ prUrl, kind, what, reviewers, headOid, fingerprint, notes }))).toEqual([
      { prUrl: url(503), kind: "nudge", what: "Nudge @mira", reviewers: ["mira"], headOid: null, fingerprint: null, notes: 0 },
      { prUrl: url(502), kind: "request", what: "Request @mira", reviewers: ["mira"], headOid: null, fingerprint: null, notes: 0 },
      { prUrl: url(501), kind: "ready", what: "Mark ready", reviewers: [], headOid: HEAD, fingerprint: null, notes: 0 }]);
    expect(planned.skipped).toEqual([]);
    expect(env.writes).toEqual([]);

    const started = await env.rpc("deck_batch_start", { batchId: planned.batchId }) as { ok: true; dispatchAt: number };
    expect(started).toEqual({ ok: true, dispatchAt: expect.any(Number) });
    // Waiting out its Undo window, each row is yours no more and sends nothing; #504's notes and #505's merge still need you.
    await vi.advanceTimersByTimeAsync(7_900);
    expect(env.writes).toEqual([]);
    expect(await env.card()).toMatchObject({ needsYou: 2, sections: expect.arrayContaining([expect.objectContaining({ key: "ready",
      rows: [expect.objectContaining({ acted: { kind: "ready", state: "queued", at: expect.any(Number), batchId: planned.batchId } })] })]) });

    await vi.advanceTimersByTimeAsync(200);
    await settled(env, planned.batchId);
    expect(env.writes).toEqual([{ kind: "nudge", prUrl: url(503), reviewers: ["mira"], comment: null }, { kind: "nudge", prUrl: url(502), reviewers: ["mira"], comment: null },
      { kind: "ready", prUrl: url(501), headOid: HEAD }]);
    expect((await env.batch(planned.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #503", "sent", "Wrote nudge."], ["folio #502", "sent", "Wrote nudge."], ["folio #501", "sent", "Wrote ready."]]);
    // No batch records a confirmation, so #504 doesn't read as ready.
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM approval_feedback_verifications").get()).toEqual({ n: 0 });
    // Each landed write keeps its row out of Needs you, and out of the next plan, until the view marks it seen; #504's notes and #505's
    // merge still count. Seen, #501, out of draft, needs a reviewer.
    expect(await env.card()).toMatchObject({ needsYou: 2 });
    expect(await env.card({ [url(501)]: Date.now() })).toMatchObject({ needsYou: 3 });
  });

  // The live false readiness: a batch recorded #504's notes handled though nobody had answered them.
  it("never plans a confirmation of review notes: not in Advance, not for the row alone, not as a batch of its own", async () => {
    const env = await setup();
    expect((await plan(env, { kind: "advance" })).items.map((item) => item.ref)).not.toContain("folio #504");
    const alone = await env.rpc("deck_batch_plan", { kind: "advance", effortId: env.effort.id, prUrls: [url(504)] });
    expect(alone).toEqual({ ok: true, batchId: null, items: [], skipped: [{ prUrl: url(504), ref: "folio #504", reason: "Its review notes are confirmed from its own row." }] });
    await expect(env.rpc("deck_batch_plan", { kind: "confirm", effortId: env.effort.id })).rejects.toThrow();
    // Its row offers no Advance, and still needs you.
    expect((await env.card()).sections.find((section) => section.key === "confirm")?.rows.map((row) => [row.number, row.acted])).toEqual([[504, null]]);
  });

  it("stops a confirmed batch at each PR whose effort you hold or complete before it sends, and won't start one for a paused effort", async () => {
    const env = await setup();
    const held = await plan(env, { kind: "advance" });
    expect(await env.rpc("deck_batch_start", { batchId: held.batchId })).toMatchObject({ ok: true });
    expect(await env.rpc("effort_hold", { effortKey: env.effort.id, reason: "Store layout first" })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(8_000);
    await settled(env, held.batchId);
    expect(new Set((await env.batch(held.batchId)).items.map((item) => `${item.state}: ${item.detail}`)))
      .toEqual(new Set(["refused: Its effort is on hold. Nothing was written."]));
    expect(env.writes).toEqual([]);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM approval_feedback_verifications").get()).toEqual({ n: 0 });

    expect(await env.rpc("effort_resume", { effortKey: env.effort.id })).toMatchObject({ ok: true });
    const done = await plan(env, { kind: "ready" });
    expect(await env.rpc("effort_complete", { effortKey: env.effort.id })).toMatchObject({ ok: true });
    expect(await env.rpc("deck_batch_start", { batchId: done.batchId })).toEqual({ ok: false, error: "folio #501: Its effort is done. Review the batch again." });
  });

  it("refuses only the PR a hold reached during the Undo window, and sends the rest", async () => {
    const env = await setup();
    const planned = await plan(env, { kind: "advance" });
    expect(await env.rpc("deck_batch_start", { batchId: planned.batchId })).toMatchObject({ ok: true });
    await env.rpc("pr_hold_set", { prUrl: url(503), held: true, reason: "Store layout first" });
    await vi.advanceTimersByTimeAsync(8_000);
    await settled(env, planned.batchId);
    expect((await env.batch(planned.batchId)).items.map((item) => [item.ref, item.state, item.detail])).toEqual([
      ["folio #503", "refused", "On hold: Store layout first. Release the hold first; nothing was written."],
      ["folio #502", "sent", "Wrote nudge."],
      ["folio #501", "sent", "Wrote ready."]]);
    expect(env.writes).toEqual([{ kind: "nudge", prUrl: url(502), reviewers: ["mira"], comment: null }, { kind: "ready", prUrl: url(501), headOid: HEAD }]);
  });

  it("sends nothing once you Undo inside the window, and says so when an Undo comes too late", async () => {
    const env = await setup();
    const first = await plan(env, { kind: "ready" });
    expect(first.items.map((item) => item.prUrl)).toEqual([url(501)]);
    expect(await env.rpc("deck_batch_start", { batchId: first.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await env.rpc("deck_batch_undo", { batchId: first.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.writes).toEqual([]);
    expect(await env.batch(first.batchId)).toMatchObject({ state: "cancelled", items: [{ state: "pending" }] });
    // Undone, the row is yours again: all five moves count.
    expect(await env.card()).toMatchObject({ needsYou: 5 });
    expect(await env.rpc("deck_batch_undo", { batchId: first.batchId })).toEqual({ ok: false, error: "This batch is already undone." });
    expect(await env.rpc("deck_batch_start", { batchId: first.batchId })).toEqual({ ok: false, error: "This batch already started." });

    const second = await plan(env, { kind: "ready" });
    await env.rpc("deck_batch_start", { batchId: second.batchId });
    await vi.advanceTimersByTimeAsync(8_000);
    await settled(env, second.batchId);
    expect(await env.rpc("deck_batch_undo", { batchId: second.batchId })).toEqual({ ok: false, error: "It already sent. Nothing was undone." });
    expect(env.writes).toEqual([{ kind: "ready", prUrl: url(501), headOid: HEAD }]);
    // A held effort asks nothing, so nothing is planned for it.
    expect(await env.rpc("effort_hold", { effortKey: env.effort.id })).toMatchObject({ ok: true });
    expect(await env.rpc("deck_batch_plan", { kind: "advance", effortId: env.effort.id })).toEqual({ ok: false, error: "Resume or reopen this effort first." });
  });

  it("releases a hold only after its Undo window, keeps it when you Undo, and files the row under Held until then", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: url(503), held: true, reason: "Store layout first" });
    const held = (await env.card()).sections.find((section) => section.key === "held")!;
    expect(held.rows.map((row) => [row.number, row.hold?.reason])).toEqual([[503, "Store layout first"]]);
    // Advance leaves a held PR alone; Release lists it.
    expect((await plan(env, { kind: "advance" })).items.map((item) => item.ref)).not.toContain("folio #503");
    const holds = () => env.db.prepare("SELECT pr_url FROM pr_holds").all();

    const undone = await plan(env, { kind: "release" });
    expect(undone.items.map((item) => [item.ref, item.kind, item.what])).toEqual([["folio #503", "release", "Release"]]);
    expect(await env.rpc("deck_batch_start", { batchId: undone.batchId })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await env.rpc("deck_batch_undo", { batchId: undone.batchId })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(holds()).toHaveLength(1);

    const released = await plan(env, { kind: "release", prUrls: [url(503)] });
    await env.rpc("deck_batch_start", { batchId: released.batchId });
    await vi.advanceTimersByTimeAsync(7_900);
    // Waiting out its window, the hold stands and the row says so.
    expect(holds()).toHaveLength(1);
    expect((await env.card()).sections.find((section) => section.key === "held")!.rows[0]!.acted).toMatchObject({ kind: "release", state: "queued" });
    await vi.advanceTimersByTimeAsync(200);
    await settled(env, released.batchId);
    expect((await env.batch(released.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Released."]]);
    expect(holds()).toEqual([]);
    // Released, it's a nudge again, and nothing went to GitHub. It counts once the view marks its row seen.
    const rows = (await env.card()).sections.flatMap((section) => section.rows.map((row) => [row.number, section.key]));
    expect(rows).toContainEqual([503, "nudge"]);
    expect(env.writes).toEqual([]);
  });

  it("releases a hold while its effort is paused, from the card or from All PRs, since a release writes nothing to GitHub", async () => {
    const env = await setup();
    const holds = () => env.db.prepare("SELECT pr_url FROM pr_holds").all();
    await env.rpc("pr_hold_set", { prUrl: url(503), held: true, reason: "Store layout first" });
    await env.rpc("pr_hold_set", { prUrl: url(504), held: true });
    // You can hold a PR on a paused effort, so you can release one there too; the effort's own hold still stops every other batch.
    expect(await env.rpc("effort_hold", { effortKey: env.effort.id })).toMatchObject({ ok: true });
    expect(await env.rpc("deck_batch_plan", { kind: "nudge", effortId: env.effort.id })).toEqual({ ok: false, error: "Resume or reopen this effort first." });
    const fromCard = await plan(env, { kind: "release", prUrls: [url(503)] });
    // All PRs plans a release with no effort.
    const fromAll = await env.rpc("deck_batch_plan", { kind: "release", prUrls: [url(504)] }) as typeof fromCard;
    expect([fromCard.items.map((item) => item.ref), fromCard.skipped, fromAll.items.map((item) => item.ref), fromAll.skipped])
      .toEqual([["folio #503"], [], ["folio #504"], []]);
    for (const batch of [fromCard, fromAll]) expect(await env.rpc("deck_batch_start", { batchId: batch.batchId })).toMatchObject({ ok: true });
    // Completing the effort inside the window doesn't stop a release either.
    expect(await env.rpc("effort_complete", { effortKey: env.effort.id })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(8_000);
    for (const batch of [fromCard, fromAll]) {
      await settled(env, batch.batchId);
      expect((await env.batch(batch.batchId)).items.map((item) => [item.state, item.detail])).toEqual([["sent", "Released."]]);
    }
    expect([holds(), env.writes]).toEqual([[], []]);
  });

  it("stops offering a row's Undo once its batch starts sending, though that PR still waits its turn", async () => {
    const env = await setup();
    env.hang.prUrl = url(503);
    const planned = await plan(env, { kind: "advance" });
    await env.rpc("deck_batch_start", { batchId: planned.batchId });
    await vi.advanceTimersByTimeAsync(8_000);
    // #503's nudge is out and GitHub hasn't answered; #502's request hasn't gone yet, and Undo can no longer stop it.
    await vi.waitFor(() => expect(env.writes).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    const rows = (await env.card()).sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.prUrl === url(502))?.acted).toEqual({ kind: "request", state: "sending", at: expect.any(Number), batchId: planned.batchId });
    expect(await env.rpc("deck_batch_undo", { batchId: planned.batchId })).toEqual({ ok: false, error: "It's already sending. Nothing was undone." });
  });

  it("keeps a batch through a restart: it sends once after the rest of its window, stays undone if you undid it, and never resends a write cut off mid-send", async () => {
    const env = await setup();
    const waiting = await plan(env, { kind: "ready" });
    await env.rpc("deck_batch_start", { batchId: waiting.batchId });
    await vi.advanceTimersByTimeAsync(3_000);
    await env.restart();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(env.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await settled(env, waiting.batchId);
    expect(env.writes).toEqual([{ kind: "ready", prUrl: url(501), headOid: HEAD }]);

    const undone = await plan(env, { kind: "nudge" });
    await env.rpc("deck_batch_start", { batchId: undone.batchId });
    expect(await env.rpc("deck_batch_undo", { batchId: undone.batchId })).toEqual({ ok: true });
    await env.restart();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await env.batch(undone.batchId)).toMatchObject({ state: "cancelled" });
    expect(env.writes).toHaveLength(1);

    // GitHub never answers the nudge before the restart; the requests after it still go. Out of draft, #501 needs a reviewer too, which
    // Advance asks for once the view marks its landed write seen.
    env.hang.prUrl = url(503);
    expect((await plan(env, { kind: "advance" })).items.map((item) => item.ref)).toEqual(["folio #503", "folio #502"]);
    const cut = await plan(env, { kind: "advance", seen: { [url(501)]: Date.now() } });
    expect(cut.items.map((item) => item.ref)).toEqual(["folio #503", "folio #501", "folio #502"]);
    await env.rpc("deck_batch_start", { batchId: cut.batchId });
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(env.writes).toHaveLength(2));
    await env.restart();
    await settled(env, cut.batchId);
    expect((await env.batch(cut.batchId)).items.map((item) => [item.ref, item.state])).toEqual([["folio #503", "unknown"],
      ["folio #501", "sent"], ["folio #502", "sent"]]);
    expect(env.writes.slice(1)).toEqual([{ kind: "nudge", prUrl: url(503), reviewers: ["mira"], comment: null },
      { kind: "nudge", prUrl: url(501), reviewers: ["mira"], comment: null }, { kind: "nudge", prUrl: url(502), reviewers: ["mira"], comment: null }]);
  });
});
