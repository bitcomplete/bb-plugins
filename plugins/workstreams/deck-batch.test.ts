import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeckBatches, DECK_BATCH_MIGRATION, planBatch, type PlannedRoute, type PlanRow } from "./deck-batch.js";
import type { DeckSection } from "./deck-shared.js";
import { turnOf } from "./your-turn.js";

const HEAD = "c".repeat(40);
let next = 600;
const row = (section: DeckSection, patch: Partial<PlanRow["row"]> = {}, facts: Partial<Omit<PlanRow, "row">> = {}): PlanRow => {
  const number = next++;
  // Its turn as deckRow reads it: the feedback Address names waits on you, under the row's hold and its card's pile.
  const turn = turnOf({ owes: !!facts.address?.feedback, hold: !!patch.hold, pile: facts.pile ?? "active", dismissed: false, executor: null, batchThread: null, sent: null });
  return { row: { prUrl: `https://github.com/inkwell/quill/pull/${number}`, repo: "inkwell/quill", number, title: `ABC-${number} Print hold slips`, section,
    suggested: ["kai"], nudge: section === "nudge" ? ["mira"] : [], notes: section === "confirm" ? 1 : 0, acted: null, hold: null, turn, ...patch },
  pile: "active", head: HEAD, fingerprint: section === "confirm" ? "f".repeat(64) : null, shown: { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] },
  ...facts };
};
const brief = (plan: ReturnType<typeof planBatch>) => ({ items: plan.items.map((item) => `${item.kind} ${item.ref}: ${item.what}`),
  skipped: plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`) });

describe("planning a deck batch", () => {
  it("plans Advance as every safe move in the effort, nudge through mark ready, and leaves merges and a thread's work to their own paths", () => {
    next = 600;
    const rows = [row("ready"), row("merge"), row("request"), row("work"), row("nudge"), row("confirm"), row("flight"), row("blocked")];
    expect(brief(planBatch("advance", rows, { selected: false }))).toEqual({ items: [
      "nudge quill #604: Nudge @mira", "request quill #602: Request @kai", "ready quill #600: Mark ready"], skipped: [] });
  });

  // A batched confirmation once read a PR ready to merge though nobody had answered its approval's note: notes are confirmed one PR at a
  // time, after reading them, so no Advance, row Advance, or selection ever carries one.
  it("never plans a confirmation of review notes, in Advance, on a row's own Advance, or in a selection", () => {
    next = 605;
    const confirm = row("confirm");
    expect(brief(planBatch("advance", [confirm], { selected: false }))).toEqual({ items: [], skipped: [] });
    expect(brief(planBatch("advance", [confirm], { selected: true }))).toEqual({ items: [], skipped: ["quill #605: Its review notes are confirmed from its own row."] });
    expect(brief(planBatch("nudge", [confirm, row("nudge")], { selected: true })).items).toEqual(["nudge quill #606: Nudge @mira"]);
  });

  it("asks the reviewers you pick on every PR in a request, and keeps what each row showed so the request can check it", () => {
    next = 610;
    const plan = planBatch("request", [row("request"), row("request", { suggested: [] })], { selected: false, reviewers: ["dana", "lee"] });
    expect(plan.items.map((item) => [item.ref, item.reviewers, item.shown])).toEqual([
      ["quill #610", ["dana", "lee"], { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] }],
      ["quill #611", ["dana", "lee"], { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] }]]);
  });

  it("names why each selected PR can't take the write, so the confirm lists what won't happen as well as what will", () => {
    next = 620;
    const rows = [row("nudge"), row("nudge", {}, { pile: "held" }), row("nudge", {}, { pile: "done" }), row("merge"),
      row("nudge", { acted: { kind: "nudge", state: "queued", at: 1, batchId: "b" } }), row("blocked", { hold: { reason: "Counter redesign", since: 1 } }),
      row("request", { suggested: [] }), row("ready", {}, { head: null }), row("nudge", { nudge: [] })];
    expect(brief(planBatch("advance", rows, { selected: true }))).toEqual({ items: ["nudge quill #620: Nudge @mira"], skipped: [
      "quill #621: Its effort is on hold.", "quill #622: Its effort is done.", "quill #623: Merges go through the merge preview.",
      "quill #624: A write on it is waiting or just ran.", "quill #625: On hold. Release it first.", "quill #626: No reviewer to suggest. Pick one.",
      "quill #627: Not read in full yet. Refresh it first.", "quill #628: No reviewer needs a nudge now."] });
    // A selection for one kind names the move a row needs instead.
    expect(brief(planBatch("ready", [row("nudge")], { selected: true })).skipped).toEqual(["quill #629: Its next move is a nudge."]);
  });

});

describe("planning an ask", () => {
  // The confirm's answer to notes nobody answered: the PR's thread is asked, through the listing and its Undo window, and nothing is confirmed.
  it("asks the thread of each chosen PR whose next move is its notes, bound to the head and notes it showed, and never in Advance", () => {
    next = 690;
    const rows = [row("confirm", { notes: 2 }), row("nudge"), row("confirm", { hold: { reason: "Counter redesign", since: 1 } }), row("confirm", {}, { fingerprint: null }),
      row("confirm", { acted: { kind: "ask", state: "queued", at: 1, batchId: "b" } }), row("confirm", {}, { pile: "held" })];
    expect(brief(planBatch("ask", rows, { selected: true }))).toEqual({ items: ["ask quill #690: Ask its thread to address 2 notes"], skipped: [
      "quill #691: Its approval has no notes waiting.", "quill #692: On hold. Release it first.", "quill #693: Not read in full yet. Refresh it first.",
      "quill #694: A write on it is waiting or just ran.", "quill #695: Its effort is on hold."] });
    expect(planBatch("ask", rows.slice(0, 1), { selected: true }).items[0]).toMatchObject({ headOid: HEAD, fingerprint: "f".repeat(64), notes: 2 });
    expect(brief(planBatch("advance", rows, { selected: false })).items).toEqual(["nudge quill #691: Nudge @mira"]);
  });

  it("names where the ask goes, and leaves the PR out with why when it can go nowhere yet", () => {
    next = 700;
    const plan = (ask: { to: string } | { why: string }) => brief(planBatch("ask", [row("confirm", {}, { ask })], { selected: true }));
    expect(plan({ to: "Start a thread under Counter redesign" }).items).toEqual(["ask quill #700: Start a thread under Counter redesign to address 1 note"]);
    expect(plan({ why: "This PR has no thread, and nothing to start one under yet." })).toEqual({ items: [],
      skipped: ["quill #701: This PR has no thread, and nothing to start one under yet."] });
  });
});

describe("planning a fix", () => {
  // Code work is each PR's thread's. Asking threads to fix names each PR's own fix and where it goes, and leaves out what can't take it.
  it("asks each chosen PR in Work in threads for its own fix, bound to the head it showed, and never in Advance", () => {
    next = 720;
    const to = (fixes: ("conflicts" | "checks" | "changes")[], where = "Ask “Hold slips”", route: PlannedRoute = { kind: "thread", id: "thr_slips" }) =>
      ({ fix: { to: where, route, fixes } });
    const rows = [row("work", {}, to(["conflicts", "checks"])), row("work", {}, to(["changes"], "Start a thread under Store pickup", { kind: "new", parentThreadId: "thr_pickup" })),
      row("nudge"),
      row("work", { acted: { kind: "fix", state: "queued", at: 1, batchId: "b" } }, to(["checks"])), row("work", {}, { head: null, ...to(["checks"]) }),
      row("work", {}, { fix: { why: "This PR has no thread, and nothing to start one under yet." } }), row("work", {}, to([])), row("work", {}, { pile: "held", ...to(["checks"]) }),
      row("held", { hold: { reason: "Counter redesign", since: 1 } })];
    expect(brief(planBatch("fix", rows, { selected: true }))).toEqual({ items: [
      "fix quill #720: Ask “Hold slips”: resolve conflicts, fix CI", "fix quill #721: Start a thread under Store pickup: address changes"], skipped: [
      "quill #722: Its next move isn't a thread's work.", "quill #723: A write on it is waiting or just ran.", "quill #724: Not read in full yet. Refresh it first.",
      "quill #725: This PR has no thread, and nothing to start one under yet.", "quill #726: Nothing a thread can fix: no conflict, failing check, or requested change.",
      "quill #727: Its effort is on hold.", "quill #728: On hold. Release it first."] });
    // Each keeps where its listing said it goes, which its send checks again.
    expect(planBatch("fix", rows.slice(0, 2), { selected: true }).items.map(({ kind, headOid, fixes, route }) => ({ kind, headOid, fixes, route }))).toEqual([
      { kind: "fix", headOid: HEAD, fixes: ["conflicts", "checks"], route: { kind: "thread", id: "thr_slips" } },
      { kind: "fix", headOid: HEAD, fixes: ["changes"], route: { kind: "new", parentThreadId: "thr_pickup" } }]);
    // A section's button plans its own rows; Advance never plans a thread's work.
    expect(brief(planBatch("fix", rows, { selected: false })).items).toHaveLength(2);
    expect(brief(planBatch("advance", rows, { selected: false })).items).toEqual(["nudge quill #722: Nudge @mira"]);
  });
});

describe("planning Address for Your turn PRs", () => {
  const feedback = (text: string | null, patch: Partial<NonNullable<PlanRow["address"]>> = {}) =>
    ({ address: { feedback: text, busy: null, checkout: "folio-abc-42", source: null, ...patch } });

  // One batch thread takes every PR whose feedback waits on you, and the listing says why each other one stays out, so what it lists is
  // exactly what the thread gets. A PR with no checkout is worked in a new worktree from its repository's checkout, never a fresh clone,
  // so one with neither stays out.
  it("lists each PR one batch thread takes, with its feedback and where it's worked, and why any other stays out", () => {
    next = 800;
    const rows = [row("work", {}, feedback("Changes requested by @otto")), row("confirm", {}, feedback("Approval comment from @mira", { checkout: null, source: "folio" })),
      row("work", { hold: { reason: "Counter redesign", since: 1 } }, feedback("2 open threads")), row("work", {}, { pile: "held", ...feedback("2 open threads") }),
      row("work", {}, { pile: "done", ...feedback("2 open threads") }),
      row("work", {}, feedback("2 open threads", { busy: "An agent is already working on it." })), row("nudge", {}, feedback(null)),
      row("work", { acted: { kind: "address", state: "queued", at: 1, batchId: "b" } }, feedback("2 open threads")),
      row("work", {}, { head: null, ...feedback("2 open threads") }), row("work", {}, feedback("2 open threads", { checkout: null }))];
    const plan = planBatch("address", rows, { selected: true });
    expect(plan.items.map((item) => [item.kind, item.ref, item.what, item.feedback, item.where, item.headOid])).toEqual([
      ["address", "quill #800", "Batch thread", "Changes requested by @otto", "In folio-abc-42", HEAD],
      ["address", "quill #801", "Batch thread", "Approval comment from @mira", "No checkout: a new worktree from folio", HEAD]]);
    expect(brief(plan).skipped).toEqual(["quill #802: On hold. Release it first.", "quill #803: Its effort is on hold.", "quill #804: Its effort is done.",
      "quill #805: An agent is already working on it.", "quill #806: No feedback waits on you.",
      "quill #807: A write on it is waiting or just ran.", "quill #808: Not read in full yet. Refresh it first.",
      "quill #809: No local checkout of its repository to add a worktree from."]);
    // Never Advance, and never a merge.
    expect(planBatch("advance", rows, { selected: false }).items.map((item) => item.kind)).toEqual(["nudge"]);
  });

  // Approval notes you answered wait only on your Confirm, which no batch gives: sent, they would start a thread for nothing. Beside other
  // feedback, the batch takes the PR for that.
  it("leaves out a PR whose answered approval notes wait only on your Confirm, and says why", () => {
    next = 810;
    const plan = planBatch("address", [row("confirm", {}, feedback(null, { confirm: true })), row("confirm", {}, feedback("1 bot note", { confirm: true }))], { selected: true });
    expect(brief(plan).skipped).toEqual(["quill #810: Answered. Confirm it yourself."]);
    expect(plan.items.map((item) => item.ref)).toEqual(["quill #811"]);
  });

  // Each PR in its own thread is the Ask its thread path: the approval's notes through Ask and fixes through Fix, only to a thread it has.
  it("asks each PR's own thread for its notes or fixes, and leaves out a PR with no thread", () => {
    next = 820;
    const thread = { kind: "thread" as const, id: "thr_slips" };
    const rows = [row("confirm", {}, { ask: { to: "Ask “Hold slips”" }, ...feedback("Approval comment from @mira") }),
      row("work", {}, { fix: { to: "Ask “Hold slips”", route: thread, fixes: ["comments"] }, ...feedback("New comments from @otto") }),
      row("work", {}, { fix: { why: "It has no thread. Use One batch thread." }, ...feedback("Changes requested by @otto") }),
      row("nudge", {}, feedback("Changes requested by @otto"))];
    const plan = planBatch("address", rows, { selected: true, mode: "each" });
    expect(plan.items.map((item) => [item.kind, item.ref, item.what, item.feedback, item.route ?? null])).toEqual([
      ["ask", "quill #820", "Ask “Hold slips” to address 1 note", "Approval comment from @mira", null],
      ["fix", "quill #821", "Ask “Hold slips”: answer comments", "New comments from @otto", thread]]);
    expect(brief(plan).skipped).toEqual(["quill #822: It has no thread. Use One batch thread.", "quill #823: Its thread has nothing to ask for now."]);
  });
});

describe("planning a release", () => {
  it("lists each held PR on the card, never a PR that isn't held, and leaves a release out of Advance", () => {
    next = 640;
    const hold = { reason: "Counter redesign", since: 1 };
    const rows = [row("held", { hold }), row("nudge"), row("held", { hold: { reason: "", since: 2 } })];
    expect(brief(planBatch("release", rows, { selected: false }))).toEqual({ items: ["release quill #640: Release", "release quill #642: Release"], skipped: [] });
    // Advance never lifts a hold: only Release does, and only on your click.
    expect(brief(planBatch("advance", rows, { selected: false })).items).toEqual(["nudge quill #641: Nudge @mira"]);
  });

  it("says why a selected PR won't be released: not held, or its release already waiting; a paused effort's hold releases like any other", () => {
    next = 650;
    const hold = { reason: "Counter redesign", since: 1 };
    const rows = [row("nudge"), row("held", { hold }, { pile: "held" }), row("held", { hold, acted: { kind: "release", state: "queued", at: 1, batchId: "b" } }),
      row("held", { hold, acted: { kind: "release", state: "sent", at: 1, batchId: "b" } }), row("held", { hold }, { pile: "done" })];
    // A release writes nothing to GitHub, so it runs on any pile, as holding a PR does.
    expect(brief(planBatch("release", rows, { selected: true }))).toEqual({ items: ["release quill #651: Release", "release quill #653: Release",
      "release quill #654: Release"], skipped: ["quill #650: It isn't on hold.", "quill #652: Its release is waiting to send."] });
  });
});

describe("sending a deck batch", () => {
  afterEach(() => { vi.useRealTimers(); });
  const store = () => {
    const db = new Database(":memory:");
    db.exec(DECK_BATCH_MIGRATION);
    const sent: string[] = [];
    const hang = { next: false };
    const deps = { db, now: Date.now, changed: () => undefined, piles: async () => () => "active" as const, run: async (item: { prUrl: string }) => {
      sent.push(item.prUrl);
      if (hang.next) { hang.next = false; return await new Promise<never>(() => undefined); }
      return { ok: true as const, detail: "Wrote ready." };
    } };
    const batch = (load: ReturnType<typeof createDeckBatches>, ...rows: PlanRow[]) => load.plan("ready", null, planBatch("ready", rows, { selected: false })).batchId!;
    return { db, sent, hang, deps, batch };
  };
  // A reload loads the replacement, which re-arms each waiting batch, before it disposes the old load, which may still take an Undo.
  it("sends each item once when a replacement load overlaps the old one inside the window, and keeps an Undo the old load took", async () => {
    vi.useFakeTimers();
    next = 640;
    const db = new Database(":memory:");
    db.exec(DECK_BATCH_MIGRATION);
    const sent: string[] = [];
    const deps = { db, now: Date.now, changed: () => undefined, piles: async () => () => "active" as const,
      run: async (item: { prUrl: string }) => { sent.push(item.prUrl); return { ok: true as const, detail: "Wrote ready." }; } };
    const old = createDeckBatches(deps), replacement = createDeckBatches(deps);
    const [undone, kept] = [row("ready"), row("ready")].map((item) => old.plan("ready", null, planBatch("ready", [item], { selected: false })).batchId!);
    for (const id of [undone, kept]) expect(await old.start(id!)).toMatchObject({ ok: true });
    replacement.resume();
    expect(old.undo(undone!)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent).toEqual(["https://github.com/inkwell/quill/pull/641"]);
    expect([replacement.get(undone!)?.state, replacement.get(kept!)?.state]).toEqual(["cancelled", "done"]);
    db.close();
  });

  it("finishes what a reload's old load started or was sending after this load resumed, once that load is gone, and never sends twice", async () => {
    vi.useFakeTimers();
    next = 650;
    const { db, sent, hang, deps, batch } = store();
    const old = createDeckBatches(deps), replacement = createDeckBatches(deps);
    const cut = batch(old, row("ready"), row("ready"));
    expect(await old.start(cut)).toMatchObject({ ok: true });
    replacement.resume();
    // The old load wins the send, and GitHub never answers its first write.
    hang.next = true;
    await vi.advanceTimersByTimeAsync(8_000);
    // Still loaded, it takes a start the replacement never saw, then goes before that batch's window ends.
    const late = batch(old, row("ready"));
    expect(await old.start(late)).toMatchObject({ ok: true });
    old.dispose();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sent).toEqual([650, 651, 652].map((number) => `https://github.com/inkwell/quill/pull/${number}`));
    expect([replacement.get(cut), replacement.get(late)].map((item) => [item?.state, item?.items.map((entry) => entry.state)]))
      .toEqual([["done", ["unknown", "sent"]], ["done", ["sent"]]]);
    replacement.dispose();
    db.close();
  });

  // One batch thread takes every PR at once, only after the window, and a restart mid-start never starts a second: it can't know whether
  // BB made the first, so each PR reads as maybe sent.
  it("starts one batch thread for every PR at once after the window, never after an Undo, and never twice across a restart", async () => {
    vi.useFakeTimers();
    next = 680;
    const db = new Database(":memory:");
    db.exec(DECK_BATCH_MIGRATION);
    const calls: string[][] = [];
    const hang = { next: false };
    const piles = new Map<string, "active" | "held">();
    const deps = { db, now: Date.now, changed: () => undefined, piles: async () => (prUrl: string) => piles.get(prUrl) ?? "active" as const,
      run: async () => { throw new Error("Address never sends one PR at a time."); },
      address: async (_batch: unknown, items: readonly { prUrl: string }[]) => {
        calls.push(items.map((item) => item.prUrl));
        if (hang.next) { hang.next = false; return await new Promise<never>(() => undefined); }
        return new Map(items.map((item) => [item.prUrl, { ok: true as const, detail: "Started “Address feedback on 2 PRs”." }]));
      } };
    const address = (load: ReturnType<typeof createDeckBatches>) => load.plan("address", null, planBatch("address",
      [row("work", {}, { address: { feedback: "2 open threads", busy: null, checkout: null, source: "folio" } }),
        row("confirm", {}, { address: { feedback: "Approval comment from @mira", busy: null, checkout: null, source: "folio" } })],
      { selected: true }), { projectId: "proj-inkwell", parentThreadId: null, under: null }).batchId!;
    const load = createDeckBatches(deps);
    const undone = address(load), sent = address(load);
    for (const id of [undone, sent]) expect(await load.start(id)).toMatchObject({ ok: true });
    // The PR whose effort you hold during the window is refused; the thread takes the rest.
    piles.set(load.get(sent)!.items[1]!.prUrl, "held");
    expect(load.undo(undone)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([[load.get(sent)!.items[0]!.prUrl]]);
    expect(load.get(sent)!.items.map((item) => [item.state, item.detail])).toEqual([["sent", "Started “Address feedback on 2 PRs”."],
      ["refused", "Its effort is on hold. Nothing was started."]]);
    expect(load.get(sent)!.thread).toEqual({ projectId: "proj-inkwell", parentThreadId: null, under: null });
    expect(load.get(undone)!.state).toBe("cancelled");

    // BB never answers the start before a reload: the next load starts nothing again.
    piles.clear();
    const cut = address(load);
    expect(await load.start(cut)).toMatchObject({ ok: true });
    hang.next = true;
    await vi.advanceTimersByTimeAsync(8_100);
    expect(calls).toHaveLength(2);
    load.dispose();
    const reopened = createDeckBatches(deps);
    reopened.resume();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    expect(reopened.get(cut)).toMatchObject({ state: "done", items: [{ state: "unknown" }, { state: "unknown" }] });
    reopened.dispose();
    db.close();
  });

  // An older build planned confirmations into Advance; one of those batches still waiting when this build loads must record nothing.
  it("refuses a confirmation left in a batch an older build planned, and sends the rest of that batch", async () => {
    vi.useFakeTimers();
    next = 670;
    const { db, sent, deps } = store();
    const ready = planBatch("ready", [row("ready")], { selected: false }).items[0]!;
    const confirm = { ...ready, prUrl: "https://github.com/inkwell/quill/pull/699", ref: "quill #699", kind: "confirm", what: "Confirm 1 comment handled",
      headOid: HEAD, fingerprint: "f".repeat(64), notes: 1 };
    db.prepare("INSERT INTO deck_batches (id, created_at, state, dispatch_at, body) VALUES (?, ?, 'scheduled', ?, ?)").run("legacy", Date.now(), Date.now() + 1_000,
      JSON.stringify({ kind: "advance", effortId: null, skipped: [], items: [confirm, ready].map((item) => ({ ...item, state: "pending", detail: null, at: null })) }));
    const load = createDeckBatches(deps);
    load.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([ready.prUrl]);
    expect(load.get("legacy")?.items.map((item) => [item.kind, item.state, item.detail])).toEqual([
      ["confirm", "refused", "Review notes are confirmed one PR at a time now, after reading them. Nothing was recorded."], ["ready", "sent", "Wrote ready."]]);
    load.dispose();
    db.close();
  });

  it("sends nothing of a batch the plugin was closed through past its window, and refuses each PR so its row asks you again", async () => {
    vi.useFakeTimers();
    next = 660;
    const { db, sent, deps, batch } = store();
    const closed = createDeckBatches(deps);
    const id = batch(closed, row("ready"));
    expect(await closed.start(id)).toMatchObject({ ok: true });
    closed.dispose();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    const reopened = createDeckBatches(deps);
    reopened.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(reopened.get(id)).toMatchObject({ state: "done", items: [{ state: "refused", detail: expect.stringContaining("The plugin wasn't running when this was due") }] });
    reopened.dispose();
    db.close();
  });
});
