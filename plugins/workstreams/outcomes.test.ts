import { describe, expect, it } from "vitest";
import { latestEffortOutcome } from "./outcomes.js";
import type { Row } from "./inbox.js";
import type { Board, WireRun } from "./server.js";

const row = (path: string, effortKey = "care") => ({
  key: path,
  effortKey,
  effort: "Care support",
  repo: "marketing-www",
  title: "Fail closed for clinician matching",
  section: "respond",
  verb: "Changes requested",
  unit: { pr: { number: 1098, url: "https://github.com/bitcomplete/marketing-www/pull/1098" } },
}) as Row;

const run = (path: string, at: number, result: string | null): WireRun => ({
  id: at, kind: "agent", action: "address-review", path, ticket: null,
  prUrl: "https://github.com/bitcomplete/marketing-www/pull/1098", prNumber: 1098,
  threadId: `thr-${path}`, mode: "subthread", startedAt: at - 100,
  status: "done", finishedAt: at, result, error: null,
});

type Attempt = Board["dispatch"]["attempts"][number];
const attempt = (path: string, status: Attempt["status"], startedAt: number): Attempt => ({
  id: startedAt, path, prUrl: "https://github.com/bitcomplete/marketing-www/pull/1098",
  action: "address-review", status, detail: "Review gate cleared on fresh scan",
  threadId: `thr-${path}`, startedAt,
});

describe("effort outcome", () => {
  it("keeps an agent's recorded result distinct from a newer PR scan and unrelated efforts", () => {
    const outcome = latestEffortOutcome(
      [row("care-path")],
      [run("other-path", 400, "Unrelated"), run("care-path", 300, "Ten threads resolved; decision remains open")],
      [],
    );
    expect(outcome).toMatchObject({
      source: "Agent reported at action finish", outcome: "Ten threads resolved; decision remains open",
      prState: "Changes requested",
    });
  });

  it("uses explicit dispatch verification instead of calling the linked agent run verified", () => {
    expect(latestEffortOutcome([row("care-path")], [run("care-path", 300, "Fixed")], [attempt("care-path", "verified", 150)]))
      .toMatchObject({ source: "Scan verified", outcome: "Review gate cleared on fresh scan" });
  });

  it("does not invent a result when an agent finishes without one", () => {
    expect(latestEffortOutcome([row("care-path")], [run("care-path", 300, null)], []))
      .toMatchObject({ source: "Agent finished without a result", outcome: "Finished; see thread" });
  });

  it("keeps the latest manual action when two actions reuse one thread", () => {
    const first = run("care-path", 300, "Addressed review threads");
    const latest = { ...run("care-path", 500, "Posted PTAL"), action: "address-comments" };
    expect(latestEffortOutcome([row("care-path")], [first, latest], []))
      .toMatchObject({ action: "Address comments", outcome: "Posted PTAL", source: "Agent reported at action finish", at: 500 });
  });

  it("keeps a later manual action after a dispatched action in the same thread", () => {
    const dispatched = run("care-path", 300, "Fixed review feedback");
    const manual = { ...run("care-path", 500, "Asked reviewer to take another look"), action: "address-comments" };
    expect(latestEffortOutcome([row("care-path")], [dispatched, manual], [attempt("care-path", "verified", 150)]))
      .toMatchObject({ action: "Address comments", outcome: "Asked reviewer to take another look", source: "Agent reported at action finish", at: 500 });
  });

  it("dates a dispatch outcome from its matching run, not an earlier run in the same thread", () => {
    const earlier = { ...run("care-path", 300, "Investigated CI"), action: "investigate-ci" };
    const dispatched = { ...run("care-path", 500, "Addressed review"), startedAt: 410 };
    expect(latestEffortOutcome([row("care-path")], [earlier, dispatched], [attempt("care-path", "verified", 400)]))
      .toMatchObject({ action: "Address review", outcome: "Review gate cleared on fresh scan", source: "Scan verified", at: 500 });
  });
});
