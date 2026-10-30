// Address selected with no listing: one click plans one batch thread and starts it into the Undo window, and every way it can start
// nothing comes back in the server's words for the selection bar and the rows. Every name here is synthetic.
import { describe, expect, it } from "vitest";
import { addressToast, oneAtATime, readOutcomes, refresher, sendingText, startAddress, workingLabel, type PrRead, type Working } from "./deck-flow.js";
import { readNote } from "./inventory-view-model.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const held = { prUrl: url(45), ref: "folio #45", reason: "On hold. Release it first." };
/** The two RPCs Address makes, answering as told and recording each call. */
function fake(plan: unknown, start: unknown = { ok: true, dispatchAt: 8_000 }) {
  const calls: string[] = [];
  const answer = (value: unknown) => value instanceof Error ? Promise.reject(value) : Promise.resolve(value as never);
  return { calls, rpc: { plan: (input: { kind: string; prUrls: string[] }) => { calls.push(`plan ${input.kind} ${input.prUrls.length}`); return answer(plan); },
    start: (batchId: string) => { calls.push(`start ${batchId}`); return answer(start); } } };
}

describe("Address selected", () => {
  // Reviews' flow: select, one click, one thread starts. The thread does any GitHub work, and dispatch checks every PR again first.
  it("plans and starts at once with no listing between, and says what it left out beside Undo", async () => {
    const { calls, rpc } = fake({ ok: true, batchId: "b-1", items: [{}, {}], skipped: [held] });
    const outcome = await startAddress(rpc, null, [42, 43, 45].map(url), {});
    expect(calls).toEqual(["plan address 3", "start b-1"]);
    expect(outcome).toEqual({ ok: true, batchId: "b-1", dispatchAt: 8_000, count: 2, skipped: [held] });
    expect(addressToast(outcome as Extract<typeof outcome, { ok: true }>)).toBe("Addressing 2 PRs in one thread · left out folio #45: On hold. Release it first.");
    expect(addressToast({ ok: true, batchId: "b-2", dispatchAt: 0, count: 1, skipped: [] })).toBe("Addressing 1 PR in one thread");
  });

  // Each way it starts nothing names why, and starts nothing after it.
  it("returns the server's reason when the plan is refused, fails, leaves every PR out, or its start is refused", async () => {
    const refused = fake({ ok: false, error: "Resume or reopen this effort first." });
    expect(await startAddress(refused.rpc, "effort-1", [url(42)], {})).toEqual({ ok: false, error: "Resume or reopen this effort first.", skipped: [] });
    expect(refused.calls).toEqual(["plan address 1"]);
    const failed = fake(new Error("RPC timed out"));
    expect(await startAddress(failed.rpc, null, [url(42)], {})).toEqual({ ok: false, error: "RPC timed out", skipped: [] });
    const busy = { prUrl: url(42), ref: "folio #42", reason: "An agent is already working on it." };
    const none = fake({ ok: true, batchId: null, items: [], skipped: [busy, held] });
    expect(await startAddress(none.rpc, null, [42, 45].map(url), {})).toEqual({ ok: false, error: "Nothing started. folio #42: An agent is already working on it.",
      skipped: [busy, held] });
    expect(none.calls).toEqual(["plan address 2"]);
    const late = fake({ ok: true, batchId: "b-3", items: [{}], skipped: [held] }, { ok: false, error: "folio #42: Its effort is on hold. Review the batch again." });
    expect(await startAddress(late.rpc, null, [42, 45].map(url), {})).toEqual({ ok: false,
      error: "Nothing started. folio #42: Its effort is on hold. Review the batch again.", skipped: [held] });
  });
});

// Matt: "it takes a while to advance any checked PRs and there's zero UI feedback." A batch button works from its click until its plan
// answers, a second click or key while one is out plans nothing, and the rows it takes show pending until it answers or fails.
describe("a batch button while its plan is out", () => {
  /** A plan that answers when told, and the states the button and rows went through. */
  function deferred() {
    const shown: (Working | null)[] = [];
    let settle!: { resolve(): void; reject(error: Error): void };
    const calls: string[] = [];
    const plan = (kind: string) => () => { calls.push(kind); return new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }); };
    return { shown, calls, plan, settle: () => settle, run: oneAtATime((working) => shown.push(working)) };
  }

  it("shows the pressed button working and its rows pending until the plan answers, and ignores a repeat press meanwhile", async () => {
    const flow = deferred();
    const rows = new Set([url(42), url(43)]);
    const first = flow.run({ kind: "advance", prUrls: rows }, flow.plan("advance"));
    expect(flow.shown).toEqual([{ kind: "advance", prUrls: rows }]);
    expect(workingLabel(flow.shown[0]!)).toBe("Planning…");
    // The key pressed again, and another button, while the plan is out: neither plans.
    expect(await flow.run({ kind: "advance", prUrls: rows }, flow.plan("advance"))).toBe(false);
    expect(await flow.run({ kind: "nudge", prUrls: rows }, flow.plan("nudge"))).toBe(false);
    expect(flow.calls).toEqual(["advance"]);
    flow.settle().resolve();
    expect(await first).toBe(true);
    // Answered: nothing works or pends, and the next press plans.
    expect(flow.shown.at(-1)).toBeNull();
    void flow.run({ kind: "nudge", prUrls: rows }, flow.plan("nudge"));
    expect(flow.calls).toEqual(["advance", "nudge"]);
  });

  it("clears the working button and pending rows when the call fails, and says Starting… for Address", async () => {
    const flow = deferred();
    const out = flow.run({ kind: "address", prUrls: new Set([url(42)]) }, flow.plan("address"));
    expect(workingLabel(flow.shown[0]!)).toBe("Starting…");
    flow.settle().reject(new Error("RPC timed out"));
    await expect(out).rejects.toThrow("RPC timed out");
    expect(flow.shown).toEqual([{ kind: "address", prUrls: new Set([url(42)]) }, null]);
    expect(await flow.run({ kind: "address", prUrls: new Set([url(42)]) }, async () => undefined)).toBe(true);
  });
});

// Once the Undo window closes, dispatch sends one item at a time; the status line counts them as each settles.
describe("a batch while it sends", () => {
  const items = (...states: ("pending" | "sending" | "sent" | "refused" | "unknown")[]) => states.map((state) => ({ state }));
  it("says which item of how many is sending, from the items' states, and nothing once it isn't sending", () => {
    expect(sendingText({ state: "dispatching", kind: "advance", items: items("sending", "pending", "pending") })).toBe("Sending 1 of 3…");
    expect(sendingText({ state: "dispatching", kind: "advance", items: items("sent", "refused", "sending", "pending", "pending", "pending", "pending") }))
      .toBe("Sending 3 of 7…");
    expect(sendingText({ state: "dispatching", kind: "nudge", items: items("sent", "sent", "sent") })).toBe("Sending 3 of 3…");
    expect(sendingText({ state: "dispatching", kind: "address", items: items("sending", "sending") })).toBe("Starting a thread for 2 PRs…");
    expect(sendingText({ state: "scheduled", kind: "advance", items: items("pending") })).toBeNull();
    expect(sendingText({ state: "done", kind: "advance", items: items("sent") })).toBeNull();
  });
});

describe("Refresh from GitHub", () => {
  /** A refresher whose reads answer on the next tick, recording what it read, how many PRs read at once, and what it said. */
  function reads(answer: (prUrl: string) => PrRead["read"] | Error = () => ({ status: "checked", checkedAt: "2026-09-30T10:00:00Z" })) {
    const log = { read: [] as string[], most: 0, now: 0, progress: [] as (string | null)[], rows: [] as (number | null)[], answered: [] as PrRead[] };
    const run = refresher(async (prUrls) => {
      log.read.push(...prUrls);
      log.now += prUrls.length;
      log.most = Math.max(log.most, log.now);
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.now -= prUrls.length;
      const failed = prUrls.map(answer).find((item) => item instanceof Error);
      if (failed) throw failed;
      return prUrls.map((prUrl) => ({ prUrl, read: answer(prUrl) as PrRead["read"] }));
    }, { rows: (prUrls) => log.rows.push(prUrls?.size ?? null), progress: (text) => log.progress.push(text), reads: (items) => log.answered.push(...items) });
    return { log, run };
  }

  // A selection of seven reads four, then three: never more at once, which keeps GitHub's limit in reach.
  it("reads exactly the selected PRs, four at a time, saying how far it got, and ignores another Refresh while it reads", async () => {
    const { log, run } = reads();
    const seven = [301, 302, 303, 304, 305, 306, 307].map(url);
    const first = run(seven);
    expect(await run([url(301)])).toBe(false);
    expect(await first).toBe(true);
    expect(log.read).toEqual(seven);
    expect(log.most).toBe(4);
    expect(log.progress).toEqual(["Reading 4 of 7…", "Reading 7 of 7…", null]);
    expect(log.rows).toEqual([7, null]);
    expect(log.answered.map((item) => item.prUrl)).toEqual(seven);
    // Once it ends, a row's ↻ reads again; one row needs no progress line.
    expect(await run([url(301)])).toBe(true);
    expect(log.progress.at(-1)).toBe(null);
    expect(log.progress).toHaveLength(4);
  });

  it("leaves Read just now on a row its read answered, and why on a row it couldn't, a call that failed answering for each of its PRs", async () => {
    const { log, run } = reads((prUrl) => prUrl === url(302) ? { status: "failed", checkedAt: null, error: "GraphQL: API rate limit exceeded" }
      : prUrl === url(305) ? new Error("The plugin host stopped") : { status: "checked", checkedAt: "2026-09-30T10:00:00Z" });
    await run([301, 302, 303, 304, 305].map(url));
    const at = 1_000_000;
    const kept = readOutcomes(new Map(), log.answered, at);
    const note = (number: number, now = at) => readNote(kept.get(url(number))!, now);
    expect([note(301), note(302), note(305)]).toEqual([{ text: "Read just now", ok: true },
      { text: "Refresh failed 0s ago: GraphQL: API rate limit exceeded", ok: false }, { text: "Refresh failed 0s ago: The plugin host stopped", ok: false }]);
    // A good read goes quiet after a minute; a failure stays until a read answers.
    expect([note(301, at + 60_000), note(302, at + 60_000)?.ok]).toEqual([null, false]);
    expect(readNote(readOutcomes(kept, [{ prUrl: url(302), read: { status: "checked", checkedAt: "2026-09-30T10:01:00Z" } }], at + 1).get(url(302))!, at + 2))
      .toEqual({ text: "Read just now", ok: true });
  });
});
