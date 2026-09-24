// Run status and outcome, derived from thread signals without a model. The
// Board reports these back to the user, so a wrong status is a wrong claim.
import { describe, expect, it } from "vitest";
import {
  RESULT_MAX,
  ROW_RUN_MS,
  STRIP_RECENT_MS,
  applySignal,
  badgeValue,
  directOutcome,
  extractResult,
  rowRun,
  runDetail,
  runLabel,
  stripCounts,
  type Run,
  type TrackedRun,
} from "./runs.js";

describe("extractResult", () => {
  it("reads the Result line, because that is the one line every agent prompt asks for", () => {
    expect(extractResult("Rebased onto main.\n\nResult: Resolved 3 conflicts in quill and pushed")).toBe(
      "Resolved 3 conflicts in quill and pushed",
    );
  });

  it("returns null when there is no Result line, so the Board says 'see thread' instead of inventing one", () => {
    expect(extractResult("I rebased and pushed. All tests pass.")).toBeNull();
    expect(extractResult("")).toBeNull();
    expect(extractResult(null)).toBeNull();
    expect(extractResult("Result:   ")).toBeNull();
  });

  it("takes the LAST Result line, because an agent may quote an earlier one before its own", () => {
    const text = "Last time: Result: Nothing to do\n- fixed spine tests\nresult: Fixed the flaky spine test on #57";
    expect(extractResult(text)).toBe("Fixed the flaky spine test on #57");
  });

  it("is case-insensitive and ignores markdown around the line", () => {
    expect(extractResult("**Result:** Replied on 4 threads in folio")).toBe("Replied on 4 threads in folio");
    expect(extractResult("> RESULT: Branch updated")).toBe("Branch updated");
    expect(extractResult("- **Result**: CI green on margin #61 `ok`")).toBe("CI green on margin #61 `ok`");
    expect(extractResult("### Result: Merged cleanly")).toBe("Merged cleanly");
  });

  it("caps a very long line, so a runaway sentence cannot take over a row", () => {
    const result = extractResult(`Result: ${"colophon ".repeat(60)}`);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(RESULT_MAX);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("does not match a word that merely starts with result", () => {
    expect(extractResult("Results: pending")).toBeNull();
  });
});

const RUN = (overrides: Partial<TrackedRun> = {}): TrackedRun => ({
  status: "running",
  startedAt: 1_000,
  armed: true,
  ...overrides,
});

describe("applySignal", () => {
  it("marks a pending interaction as needs-you, and back to running when it settles or the thread goes active", () => {
    const waiting = applySignal(RUN(), { kind: "pending" }, 2_000);
    expect(waiting?.status).toBe("needs-you");
    expect(applySignal(RUN({ status: "needs-you" }), { kind: "settled" }, 3_000)?.status).toBe("running");
    expect(applySignal(RUN({ status: "needs-you" }), { kind: "active" }, 3_000)?.status).toBe("running");
  });

  it("finishes on idle with the extracted result, and on failure with a short error", () => {
    expect(applySignal(RUN(), { kind: "idle", text: "ok\nResult: Pushed the fix" }, 5_000)).toEqual({
      status: "done",
      armed: true,
      finishedAt: 5_000,
      result: "Pushed the fix",
      error: null,
    });
    const failed = applySignal(RUN(), { kind: "failed", text: null, error: "  Provider rate limited  " }, 5_000);
    expect(failed).toMatchObject({ status: "failed", finishedAt: 5_000, result: null, error: "Provider rate limited" });
  });

  it("stores a null result on idle without a Result line, rather than guessing", () => {
    expect(applySignal(RUN(), { kind: "idle", text: "All done." }, 5_000)?.result).toBeNull();
  });

  it("ignores a continue run's thread until its own turn starts, so an earlier turn finishing is not this run finishing", () => {
    const shared = RUN({ armed: false });
    expect(applySignal(shared, { kind: "idle", text: "Result: earlier work" }, 2_000)).toBeNull();
    expect(applySignal(shared, { kind: "pending" }, 2_000)).toBeNull();
    const armed = applySignal(shared, { kind: "active" }, 2_500);
    expect(armed).toMatchObject({ status: "running", armed: true });
    expect(applySignal({ ...shared, armed: true }, { kind: "idle", text: null }, 3_000)?.status).toBe("done");
  });

  it("ignores anything observed before the run started", () => {
    expect(applySignal(RUN({ armed: false }), { kind: "active" }, 999)).toBeNull();
    expect(applySignal(RUN(), { kind: "idle", text: null }, 500)).toBeNull();
  });

  it("never moves a finished run, so a later turn in the same thread cannot rewrite its outcome", () => {
    for (const status of ["done", "failed", "succeeded"] as const) {
      expect(applySignal(RUN({ status }), { kind: "active" }, 9_000)).toBeNull();
      expect(applySignal(RUN({ status }), { kind: "idle", text: "Result: other" }, 9_000)).toBeNull();
    }
  });

  it("closes a run whose thread was archived or deleted, even before its turn was seen, so nothing stays running forever", () => {
    expect(applySignal(RUN({ armed: false }), { kind: "gone", reason: "Thread archived" }, 2_000)).toMatchObject({
      status: "failed",
      finishedAt: 2_000,
      error: "Thread archived",
    });
  });

  it("reports no change for a signal that does not move the run", () => {
    expect(applySignal(RUN(), { kind: "active" }, 2_000)).toBeNull();
    expect(applySignal(RUN(), { kind: "settled" }, 2_000)).toBeNull();
    expect(applySignal(RUN({ status: "needs-you" }), { kind: "pending" }, 2_000)).toBeNull();
  });
});

const NOON = new Date(2026, 8, 23, 12, 0, 0).getTime();
const MIN = 60_000;

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    kind: "agent",
    action: "resolve-conflicts",
    path: "/p/quill-abc-101",
    ticket: "ABC-101",
    prUrl: "https://github.com/inkwell/quill/pull/42",
    prNumber: 42,
    threadId: "thr-quill-1",
    mode: "new",
    startedAt: NOON - 4 * MIN,
    status: "running",
    finishedAt: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe("directOutcome", () => {
  it("keeps a short reason per action, dropping the repo and PR the row already shows", () => {
    expect(directOutcome("merge", { ok: true, detail: "Merged inkwell/quill #42 and deleted its branch." })).toEqual({ ok: true, text: "Merged" });
    expect(directOutcome("update-branch", { ok: true, detail: "Updated the branch of inkwell/folio #47." })).toEqual({ ok: true, text: "Branch updated" });
    expect(
      directOutcome("nudge", { ok: true, detail: "inkwell/margin #61: re-requested 2 reviewers and commented." }),
    ).toEqual({ ok: true, text: "Re-requested 2 reviewers and commented" });
  });

  it("keeps the refusal as the failure reason", () => {
    expect(directOutcome("merge", { ok: false, error: "Not merged: It has merge conflicts with its base." })).toEqual({
      ok: false,
      text: "Not merged: It has merge conflicts with its base.",
    });
  });
});

describe("rowRun", () => {
  it("shows the row's latest run, not an older one on the same row", () => {
    const older = run({ id: 1, status: "done", startedAt: NOON - 60 * MIN, finishedAt: NOON - 50 * MIN });
    const newer = run({ id: 2, kind: "direct", action: "merge", status: "succeeded", startedAt: NOON - 2 * MIN, finishedAt: NOON - 2 * MIN });
    expect(rowRun([older, newer], "/p/quill-abc-101", NOON)?.id).toBe(2);
    expect(rowRun([older, newer], "/p/folio-abc-102", NOON)).toBeNull();
  });

  it("drops a finished run after a day, but keeps an open one however old", () => {
    const stale = run({ status: "done", finishedAt: NOON - ROW_RUN_MS - 1 });
    expect(rowRun([stale], stale.path, NOON)).toBeNull();
    const stuck = run({ status: "needs-you", startedAt: NOON - 3 * ROW_RUN_MS });
    expect(rowRun([stuck], stuck.path, NOON)).toBe(stuck);
  });
});

describe("runLabel", () => {
  it("says what the agent is doing and for how long", () => {
    expect(runLabel(run(), NOON)).toBe("Agent resolving conflicts · 4m");
    expect(runLabel(run({ status: "needs-you" }), NOON)).toBe("Agent needs you");
  });

  it("reports the extracted result, or points at the thread when there was none", () => {
    expect(runLabel(run({ status: "done", result: "Resolved 2 conflicts and pushed" }), NOON)).toBe("Done: Resolved 2 conflicts and pushed");
    expect(runLabel(run({ status: "done", result: null }), NOON)).toBe("Done: see thread");
    expect(runLabel(run({ status: "failed", error: "Provider overloaded" }), NOON)).toBe("Failed: Provider overloaded");
  });

  it("reports a direct run by what happened and when", () => {
    const merged = run({ kind: "direct", action: "merge", status: "succeeded", threadId: null, finishedAt: NOON - 2 * MIN });
    expect(runLabel(merged, NOON)).toBe("Merged 2m ago");
    expect(runLabel({ ...merged, action: "nudge", finishedAt: NOON - 60 * MIN }, NOON)).toBe("Nudged 1h ago");
    expect(runLabel({ ...merged, status: "failed", result: null, error: "Head moved; refused" }, NOON)).toBe("Failed: Head moved; refused");
  });

  it("puts the full outcome and both times in the tooltip", () => {
    const done = run({ status: "done", result: "Pushed", finishedAt: NOON });
    expect(runDetail(done, (at) => `t${at - NOON}`)).toBe(`Pushed\nStarted t${-4 * MIN}\nFinished t0`);
    expect(runDetail(run(), (at) => String(at - NOON))).toBe(`Started ${-4 * MIN}\nStill running`);
  });
});

describe("stripCounts", () => {
  it("counts running, needs-you and today's finished runs", () => {
    const counts = stripCounts(
      [
        run({ status: "running" }),
        run({ status: "running" }),
        run({ status: "needs-you" }),
        run({ status: "done", finishedAt: NOON - 5 * 60 * MIN }),
        run({ kind: "direct", status: "succeeded", finishedAt: NOON - 10 * MIN }),
        run({ status: "failed", finishedAt: NOON - MIN }),
        run({ status: "done", finishedAt: NOON - 20 * 60 * MIN }),
      ],
      NOON,
    );
    expect(counts).toEqual({ running: 2, needsYou: 1, doneToday: 2, failedToday: 1, show: true });
  });

  it("hides when nothing is open and nothing finished in the last few hours", () => {
    expect(stripCounts([run({ status: "done", finishedAt: NOON - STRIP_RECENT_MS - 1 })], NOON).show).toBe(false);
    expect(stripCounts([], NOON).show).toBe(false);
    expect(stripCounts([run({ status: "done", finishedAt: NOON - MIN })], NOON).show).toBe(true);
  });
});

describe("badgeValue", () => {
  it("shows needs-you first, because a waiting agent is blocked on the user", () => {
    expect(badgeValue([run(), run(), run({ status: "needs-you" })])).toEqual({ count: 1, needsYou: true });
  });

  it("falls back to the running count, and shows nothing at zero", () => {
    expect(badgeValue([run(), run({ status: "done" })])).toEqual({ count: 1, needsYou: false });
    expect(badgeValue([run({ status: "done" }), run({ status: "succeeded" })])).toBeNull();
  });
});
