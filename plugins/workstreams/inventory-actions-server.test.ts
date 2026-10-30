import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { InventoryView } from "./inventory-view.js";
import { inventoryLine } from "./inventory-view-model.js";
import { createApprovalFeedbackStore } from "./approval-feedback.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `branch-${number}`, baseRefName: "main", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  createdAt: daysAgo(12), ...extra }]))!.pr;
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false, ahead: 0, behind: 0,
  lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// mira's approval of #319 left comments; every review thread on it is resolved.
const FEEDBACK = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-319"] };
/** The merge preview's refusal while an approval's comment waits on your answer. */
const NOTE_WAITS = "An approval comment waits on your answer: reply on the PR or confirm it.";

/**
 * You author a green draft (#313), a PR no one was asked to review (#314), a PR mira was asked to review ten days ago (#315), a PR
 * whose change request from otto a push yesterday answered (#318), and a PR mira approved with comments two days ago (#319). mira and
 * otto reviewed #316 and #317.
 */
async function setup() {
  const calls: { method: string; input: unknown }[] = [];
  // What GitHub shows after mira's approval of #319: at first nothing, as in the live case that read as ready.
  const notes = { evidence: { since: daysAgo(2), commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true } };
  const current = new Map<number, Pr>([
    [313, pr(313, { isDraft: true })], [314, pr(314)],
    [315, { ...pr(315, { reviewRequests: [{ login: "mira" }] }), reviewRequestedAt: [{ reviewer: "mira", at: daysAgo(10) }] }],
    [316, pr(316, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: daysAgo(1) }] })],
    [317, pr(317, { latestReviews: [{ author: { login: "otto" }, state: "COMMENTED", submittedAt: daysAgo(3) }] })],
    [318, { ...pr(318, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto" }, state: "CHANGES_REQUESTED", submittedAt: daysAgo(3) }] }),
      reviewFollowupPosted: true, unresolvedReviewThreads: 0, resolvedReviewThreads: 1, headCommittedAt: daysAgo(1) }],
    [319, { ...pr(319, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: daysAgo(2) }] }),
      approvalFeedback: FEEDBACK, unresolvedReviewThreads: 0, resolvedReviewThreads: 2, headCommittedAt: daysAgo(3),
      reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: daysAgo(2), followUpAt: null } }],
  ]);
  const spawn = vi.fn(async () => { throw new Error("An inventory action starts no thread."); });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, spawn },
  }, experimental_callHostRpc: async ({ method, input }) => {
    calls.push({ method, input });
    if (method === "scan" || method === "inspectPaths") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [...current.values()].map((entry) => ({ repo: "inkwell/folio", pr: entry })),
      discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    if (method === "inspectPrs") return { entries: (input as { prUrls: string[] }).prUrls.map((prUrl) => ({ repo: "inkwell/folio", pr: current.get(Number(prUrl.split("/").pop()))! })),
      closed: [], failed: [], warnings: [] };
    if (method === "prWrite") {
      const request = input as { kind: string; prUrl: string };
      if (request.kind === "ready") current.set(313, { ...current.get(313)!, isDraft: false });
      return { ok: true, detail: `Wrote ${request.kind}.` };
    }
    if (method === "approvalHandling") {
      const facts = current.get(Number((input as { prUrl: string }).prUrl.split("/").pop()))!;
      return { ok: true, headOid: facts.headRefOid, fingerprint: facts.approvalFeedback!.fingerprint, evidence: notes.evidence,
        sources: [{ id: "review-319", kind: "review", author: "mira", at: daysAgo(2), body: "Wrap spine labels at 40 characters.", truncated: false, resolved: null }] };
    }
    if (method === "prLive") {
      const live = current.get(Number((input as { prUrl: string }).prUrl.split("/").pop()))!;
      return { ok: true, live: { state: live.state, isDraft: live.isDraft, reviewDecision: live.reviewDecision, mergeStateStatus: live.mergeStateStatus,
        headRefOid: live.headRefOid, stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0,
        approvalNotesComplete: true, approvalFeedback: live.approvalFeedback ?? { status: "none", fingerprint: null, sourceIds: [] },
        reviewFeedback: live.reviewFeedback ?? { openThreads: 0, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } };
    }
    throw new Error(`Unexpected host method ${method}`);
  } });
  const db = bb.storage.database();
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const since = () => { const at = calls.length; return () => calls.slice(at); };
  const row = async (number: number) => ((await harness.callRpc("inventory_get", {})) as InventoryView).groups.flatMap((group) => group.rows).find((entry) => entry.number === number)!;
  return { harness, calls, current, notes, spawn, db, since, row, rpc: (method: string, input: unknown) => harness.callRpc(method as never, input as never) };
}

describe("inventory actions on the server", () => {
  it("marks a draft ready from its row: reads first, writes on the shown head, reads back, and records it", async () => {
    const env = await setup();
    const after = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: (await env.row(313)).head })).toEqual({ ok: true, detail: "Wrote ready." });
    expect(after().map((call) => call.method)).toEqual(["inspectPrs", "prWrite", "inspectPrs"]);
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "ready", prUrl: url(313), headOid: HEAD });
    // Ready now, it asks the next question: who reviews it.
    expect(await env.row(313)).toMatchObject({ draft: false, attention: [{ question: "missing-reviewer" }],
      lastAction: { action: "mark-ready", ok: true, detail: "Wrote ready." } });
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it("refuses on the facts its row showed, even after a board read already stored newer ones", async () => {
    const env = await setup();
    const shown = await env.row(313);
    env.current.set(313, { ...env.current.get(313)!, headRefOid: "b".repeat(40) });
    // A board read (the poll, a scan, a Refresh) lands between the row and the click.
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const after = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: shown.head }))
      .toMatchObject({ ok: false, error: expect.stringContaining("New commits landed") });
    expect(after().map((call) => call.method)).not.toContain("prWrite");
  });

  it("suggests reviewers from the repository's reviews and requests the ones you choose", async () => {
    const env = await setup();
    expect(await env.row(314)).toMatchObject({ attention: [{ action: "request-review" }], suggestedReviewers: ["mira", "otto"] });
    const after = env.since();
    expect(await env.rpc("inventory_request_review", { prUrl: url(314), logins: ["mira"], shown: (await env.row(314)).reviewers })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(314), reviewers: ["mira"], comment: null });
  });

  it("nudges the reviewer an overdue request names", async () => {
    const env = await setup();
    expect(await env.row(315)).toMatchObject({ attention: [{ action: "nudge", reviewers: ["mira"] }] });
    const after = env.since();
    expect(await env.rpc("inventory_nudge", { prUrl: url(315), reviewers: ["mira"] })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(315), reviewers: ["mira"], comment: null });
  });

  it("re-requests the reviewer whose change request a push answered, even when the click's read can't date that push", async () => {
    const env = await setup();
    expect(await env.row(318)).toMatchObject({ attention: [{ kind: "rereview-needed", action: "rerequest", reviewers: ["otto"] }] });
    // GitHub's ages read failed on the click: the read has no push date, and the row's stored one still describes this head.
    const { headCommittedAt: _undated, ...undated } = env.current.get(318)!;
    env.current.set(318, undated);
    const after = env.since();
    expect(await env.rpc("inventory_nudge", { prUrl: url(318), reviewers: ["otto"] })).toMatchObject({ ok: true });
    expect(after().find((call) => call.method === "prWrite")?.input).toEqual({ kind: "nudge", prUrl: url(318), reviewers: ["otto"], comment: null });
  });

  it("refuses under a hold, writes nothing, and says why on the row", async () => {
    const env = await setup();
    await env.rpc("pr_hold_set", { prUrl: url(313), held: true, reason: "Store layout first" });
    const held = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD })).toEqual({ ok: false, error: "On hold: Store layout first. Release the hold first; nothing was written." });
    expect(held()).toEqual([]);
    expect(await env.row(313)).toMatchObject({ lastAction: { action: "mark-ready", ok: false } });
  });

  it("holds every PR of an effort you put on hold: no row action, merge preview, or merge writes to one until you resume it", async () => {
    const env = await setup();
    const effort = createEffortStore(env.db).establish({ sourceKey: "pr:313", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(313), url(316)] } });
    expect(await env.rpc("effort_hold", { effortKey: effort.id, reason: "Store layout first" })).toMatchObject({ ok: true });
    const held = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD }))
      .toEqual({ ok: false, error: "Its effort is on hold. Resume it first; nothing was written." });
    expect(held()).toEqual([]);
    const refusal = "Its effort is on hold. Resume it before merging this PR.";
    expect((await env.rpc("action_merge_preview", { prUrl: url(316) }) as { ok: true; refusals: string[] }).refusals).toContain(refusal);
    expect(await env.rpc("action_merge", { prUrl: url(316), sha: HEAD, acknowledgeUnresolved: false })).toEqual({ ok: false, error: refusal });
    expect(held().map((call) => call.method)).not.toContain("prWrite");
    // Resumed, its PRs take writes again.
    expect(await env.rpc("effort_resume", { effortKey: effort.id })).toMatchObject({ ok: true });
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD })).toEqual({ ok: true, detail: "Wrote ready." });
  });

  it("refuses every write and merge on a done effort's PRs with why, and says the pile so the rows offer none", async () => {
    const env = await setup();
    const effort = createEffortStore(env.db).establish({ sourceKey: "pr:313", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
      coordinatorState: "none", members: { tickets: [], prUrls: [url(313), url(316)] } });
    expect(await env.rpc("effort_complete", { effortKey: effort.id })).toMatchObject({ ok: true });
    expect((await env.rpc("inventory_get", {}) as InventoryView).groups.find((group) => group.effort?.id === effort.id)?.effort)
      .toEqual({ id: effort.id, name: "Shelf order", pile: "done" });
    const done = env.since();
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD }))
      .toEqual({ ok: false, error: "Its effort is done. Reopen it first; nothing was written." });
    const refusal = "Its effort is done. Reopen it before merging this PR.";
    expect((await env.rpc("action_merge_preview", { prUrl: url(316) }) as { ok: true; refusals: string[] }).refusals).toContain(refusal);
    expect(await env.rpc("action_merge", { prUrl: url(316), sha: HEAD, acknowledgeUnresolved: false })).toEqual({ ok: false, error: refusal });
    expect(done().map((call) => call.method)).not.toContain("prWrite");
    expect(await env.rpc("effort_reopen", { effortKey: effort.id })).toMatchObject({ ok: true });
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD })).toEqual({ ok: true, detail: "Wrote ready." });
    // An archived effort stops its PRs like a done one, and names its own way back, on the rows and from the server.
    createEffortStore(env.db).setArchived(effort.id, true);
    expect((await env.rpc("inventory_get", {}) as InventoryView).groups.find((group) => group.effort?.id === effort.id)?.effort?.pile).toBe("archived");
    expect(await env.rpc("inventory_mark_ready", { prUrl: url(313), headOid: HEAD }))
      .toEqual({ ok: false, error: "Its effort is archived. Restore it first; nothing was written." });
  });

  // A confirmation clears the merge gate, so it binds to what the row showed, refused under a hold or after a push or a new comment, and
  // once recorded, the row asks to merge through the same fresh preview, which accepts it.
  it("confirms an approval's comments from its row, as yours and on its head, after which the row and the fresh preview offer the merge", async () => {
    const env = await setup();
    const shown = await env.row(319);
    expect(shown).toMatchObject({ head: HEAD, feedbackFingerprint: FEEDBACK.fingerprint, attention: [{ kind: "approval-note", action: "confirm-handled",
      nextStep: "Answer the approval's comment", owner: "you" }] });
    const preview = () => env.rpc("action_merge_preview", { prUrl: url(319) }) as Promise<{ ok: true; refusals: string[] }>;
    expect((await preview()).refusals).toEqual(["Approval feedback needs verified follow-up on the current head.", NOTE_WAITS]);
    const confirm = () => env.rpc("inventory_confirm_handled", { prUrl: url(319), headOid: shown.head, fingerprint: shown.feedbackFingerprint });
    const stored = () => env.db.prepare("SELECT body FROM approval_feedback_verifications").all();

    await env.rpc("pr_hold_set", { prUrl: url(319), held: true, reason: "Store layout first" });
    const held = env.since();
    expect(await confirm()).toEqual({ ok: false, error: "On hold: Store layout first. Release the hold first; nothing was written." });
    expect(held()).toEqual([]);
    await env.rpc("pr_hold_set", { prUrl: url(319), held: false });
    // mira adds a comment to her approval, then a push lands, after the row was shown.
    const original = env.current.get(319)!;
    env.current.set(319, { ...original, approvalFeedback: { ...FEEDBACK, fingerprint: "e".repeat(64), sourceIds: ["review-319", "review-320"] } });
    expect(await confirm()).toMatchObject({ ok: false, error: expect.stringContaining("The approval's comments changed since the row was shown") });
    env.current.set(319, { ...original, headRefOid: "b".repeat(40) });
    expect(await confirm()).toMatchObject({ ok: false, error: expect.stringContaining("New commits landed") });
    expect(stored()).toEqual([]);

    env.current.set(319, original);
    // The confirm reads the note and what came after it from GitHub first, and shows both.
    expect(await env.rpc("inventory_confirm_read", { prUrl: url(319) })).toEqual({ ok: true, headOid: HEAD, fingerprint: FEEDBACK.fingerprint,
      ask: { kind: "none", why: "This PR has no thread or checkout yet." },
      evidence: env.notes.evidence, sources: [expect.objectContaining({ id: "review-319", kind: "review", author: "mira", body: "Wrap spine labels at 40 characters." })] });
    // Nothing since mira's approval shows her note handled: one click records nothing.
    expect(await confirm()).toEqual({ ok: false,
      error: "No commits, reply, or resolved threads since this approval. Ask its thread to address it, or confirm anyway; nothing was written." });
    expect(stored()).toEqual([]);
    // The author replies on the PR; now the same click confirms, with that evidence on the record and an audit row.
    env.notes.evidence = { ...env.notes.evidence, replies: 1 };
    const after = env.since();
    const signals = env.harness.inspection.realtimeSignals.length;
    expect(await confirm()).toEqual({ ok: true, detail: `Confirmed the approval's comments handled on ${HEAD.slice(0, 7)}: 1 reply since this approval.` });
    expect(after().map((call) => call.method)).toEqual(["inspectPrs", "approvalHandling"]);
    // The board and deck panes gate on the record, so they're told after it's saved, not only by the read before it.
    expect(env.harness.inspection.realtimeSignals.slice(signals).map((signal) => signal.channel).slice(-3))
      .toEqual(["board-changed", "inventory-changed", "deck-changed"]);
    expect(stored().map((row) => JSON.parse((row as { body: string }).body))).toMatchObject([{ prUrl: url(319), headOid: HEAD,
      fingerprint: FEEDBACK.fingerprint, provenance: { kind: "user", evidence: env.notes.evidence } }]);
    expect(env.db.prepare("SELECT pr_url AS prUrl, action, body FROM approval_confirmation_audit").all().map((row) => ({ ...row as object,
      body: JSON.parse((row as { body: string }).body) }))).toEqual([{ prUrl: url(319), action: "confirm",
      body: { headOid: HEAD, fingerprint: FEEDBACK.fingerprint, evidence: env.notes.evidence } }]);
    expect(await env.row(319)).toMatchObject({ attention: [{ kind: "merge-waiting", action: "merge" }], lastAction: { action: "confirm-handled", ok: true } });
    expect((await preview()).refusals).toEqual([]);
  });

  // Ready on your word must never read as checked, and must not outlive the head you confirmed on.
  it("says a PR you confirmed is confirmed by you with no check, until a new head asks for its notes again, and a worker's evidence never answers them", async () => {
    const env = await setup();
    const status = async () => inventoryLine(await env.row(319), new Map(), { now: Date.now(), limitedUntil: null }).status;
    env.notes.evidence = { ...env.notes.evidence, commits: 1 };
    expect(await env.rpc("inventory_confirm_handled", { prUrl: url(319), headOid: HEAD, fingerprint: FEEDBACK.fingerprint })).toMatchObject({ ok: true });
    expect([await status(), (await env.row(319)).confirmation]).toEqual(["Ready · your word", { at: expect.any(Number), current: true, evidence: true }]);
    // A new head with different code lands: the confirmation covers the old one only, so the notes need you again, and nothing merges.
    const original = env.current.get(319)!;
    env.current.set(319, { ...original, headRefOid: "b".repeat(40) });
    await env.rpc("pr_refresh_many", { prUrls: [url(319)] });
    expect([await status(), (await env.row(319)).attention.map((reason) => reason.kind), (await env.row(319)).confirmation?.current])
      .toEqual(["Approval comment to address", ["approval-note"], false]);
    expect((await env.rpc("action_merge_preview", { prUrl: url(319) }) as { refusals: string[] }).refusals)
      .toEqual(["Approval feedback needs verified follow-up on the current head.", NOTE_WAITS]);
    // A worker's evidence for the new head replaces your word and verifies the head, but mira saw no answer: her comment still waits.
    const feedback = createApprovalFeedbackStore(env.db);
    feedback.save(url(319), "thr-worker", { attemptId: "A-9", headOid: "b".repeat(40), fingerprint: FEEDBACK.fingerprint, blockers: [],
      findings: [{ sourceId: "review-319", resolution: "fixed", evidence: "Labels wrap at 40 characters in src/spine.ts.",
        validation: { outcome: "passed", detail: "Spine label tests passed." } }] }, Date.now());
    await env.rpc("pr_refresh_many", { prUrls: [url(319)] });
    expect([await status(), (await env.row(319)).confirmation]).toEqual(["Approval comment to address", null]);
    expect((await env.rpc("action_merge_preview", { prUrl: url(319) }) as { refusals: string[] }).refusals).toEqual([NOTE_WAITS]);
  });

  // Your word can be taken back whenever you doubt it: the notes need you again, and the merge preview refuses until they're handled.
  it("revokes your confirmation at any age, even once a push left it stale, with an audit row, and the notes need you again", async () => {
    const env = await setup();
    env.notes.evidence = { ...env.notes.evidence, replies: 1 };
    expect(await env.rpc("inventory_confirm_handled", { prUrl: url(319), headOid: HEAD, fingerprint: FEEDBACK.fingerprint })).toMatchObject({ ok: true });
    expect(await env.row(319)).toMatchObject({ confirmation: { current: true, evidence: true } });
    // Nothing about an older or stale confirmation stops a revoke: a push lands, and it's still yours to take back.
    const original = env.current.get(319)!;
    env.current.set(319, { ...original, headRefOid: "b".repeat(40) });
    await env.rpc("pr_refresh_many", { prUrls: [url(319)] });
    expect(await env.row(319)).toMatchObject({ confirmation: { current: false, evidence: true } });
    env.current.set(319, original);
    await env.rpc("pr_refresh_many", { prUrls: [url(319)] });
    await env.rpc("pr_hold_set", { prUrl: url(319), held: true, reason: "Store layout first" });
    const after = env.since();
    expect(await env.rpc("inventory_confirm_revoke", { prUrl: url(319) })).toEqual({ ok: true, detail: "Revoked your confirmation; its notes need you again." });
    expect(after().map((call) => call.method)).toEqual([]);
    expect(env.db.prepare("SELECT body FROM approval_feedback_verifications").all()).toEqual([]);
    expect(env.db.prepare("SELECT action, body FROM approval_confirmation_audit ORDER BY seq").all().map((row) => ({ ...row as object,
      body: JSON.parse((row as { body: string }).body) }))).toEqual([{ action: "confirm", body: expect.objectContaining({ headOid: HEAD }) },
      { action: "revoke", body: { headOid: HEAD, fingerprint: FEEDBACK.fingerprint, confirmedAt: expect.any(Number), evidence: env.notes.evidence } }]);
    await env.rpc("pr_hold_set", { prUrl: url(319), held: false });
    expect(await env.row(319)).toMatchObject({ confirmation: null, attention: [{ kind: "approval-note" }], lastAction: { action: "revoke-confirmation", ok: true } });
    expect((await env.rpc("action_merge_preview", { prUrl: url(319) }) as { refusals: string[] }).refusals)
      .toEqual(["Approval feedback needs verified follow-up on the current head.", NOTE_WAITS]);
    expect(await env.rpc("inventory_confirm_revoke", { prUrl: url(319) })).toEqual({ ok: false, error: "There's no confirmation of yours on this PR; nothing changed." });
  });
});
