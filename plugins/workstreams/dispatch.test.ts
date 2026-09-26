import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Board } from "./server.js";
import { DISPATCH_MIGRATIONS, createDispatchStore, gateStillOpen, selectCandidate } from "./dispatch.js";

const URL = "https://github.com/acme/app/pull/42";
const unit = {
  path: "/work/app", dirty: false, observed: { status: true, pr: true }, stack: null,
  lastCommitAt: "2026-09-23T12:00:00Z",
  pr: {
    url: URL, state: "OPEN", isDraft: false, mergeStateStatus: "DIRTY", checkConclusions: ["SUCCESS"],
    reviewDecision: "APPROVED", latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0,
  },
} as Board["groups"][number]["clusters"][number]["units"][number];

function groups(entry = unit, threads: Board["groups"][number]["clusters"][number]["threads"] = []): Board["groups"] {
  return [{ level: "program", key: "leaf", parentKey: null, clusters: [{ units: [entry], threads }] }] as Board["groups"];
}

describe("dispatch candidate selection", () => {
  it("excludes a held PR without changing its GitHub approval or repair gate", () => {
    const holds = { [URL]: { reason: "Await release decision", heldAt: 123 } };
    const mixedCase = { ...unit, pr: { ...unit.pr!, url: "https://github.com/ACME/App/pull/42" } };
    expect(selectCandidate(groups(mixedCase), "leaf", [], [], holds)).toBeNull();
    expect(selectCandidate(groups(mixedCase), "leaf", [], [], {})?.candidate.action).toBe("resolve-conflicts");
    expect(mixedCase.pr.reviewDecision).toBe("APPROVED");
  });
  it("does not auto-dispatch written approval notes without an explicit resolution gate", () => {
    const noted = { ...unit, pr: { ...unit.pr!, mergeStateStatus: "CLEAN" as const, approvalHasBody: true } };
    expect(selectCandidate(groups(noted), "leaf", [], [])).toBeNull();
  });
  it("does not dispatch another review response after a verified PTAL", () => {
    const followed = { ...unit, pr: { ...unit.pr!, mergeStateStatus: "BEHIND" as const, reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true } };
    expect(selectCandidate(groups(followed), "leaf", [], [])).toBeNull();
    expect(gateStillOpen(followed.pr, "address-review")).toBe(false);
  });
  it("selects one eligible PR from a collapsed leaf and ignores unsafe facts", () => {
    expect(selectCandidate(groups(), "leaf", [], [])?.candidate).toMatchObject({ path: unit.path, prUrl: URL, action: "resolve-conflicts" });
    expect(selectCandidate(groups({ ...unit, dirty: true }), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups({ ...unit, rebasing: true }), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups({ ...unit, observed: { status: false, pr: true } }), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups({ ...unit, stack: { id: "s", position: 1, size: 2, blockedBelow: 41 } }), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups({ ...unit, pr: { ...unit.pr!, mergeStateStatus: "UNKNOWN" } }), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups(unit, [{ id: "thread", active: true } as Board["groups"][number]["clusters"][number]["threads"][number]]), "leaf", [], [])).toBeNull();
    expect(selectCandidate(groups(), "leaf", [], [{ path: unit.path, prUrl: URL, status: "running" }])).toBeNull();
  });

  it("does not select a duplicated PR or retry unchanged facts", () => {
    const duplicate = { ...unit, path: "/work/other" };
    const doubled = [{ ...groups()[0]!, clusters: [{ ...groups()[0]!.clusters[0]!, units: [unit, duplicate] }] }] as Board["groups"];
    expect(selectCandidate(doubled, "leaf", [], [])).toBeNull();
    const first = selectCandidate(groups(), "leaf", [], [])!;
    expect(selectCandidate(groups(), "leaf", [{ ...first.candidate, fingerprint: first.fingerprint, id: 1, status: "needs-you", detail: "", threadId: null, startedAt: 1 }], [])).toBeNull();
    expect(selectCandidate(groups({ ...unit, lastCommitAt: "2026-09-24T12:00:00Z" }), "leaf", [{ ...first.candidate, fingerprint: first.fingerprint, id: 1, status: "verified", detail: "", threadId: null, startedAt: 1 }], [])?.candidate).toMatchObject({ action: "resolve-conflicts" });
  });
});

describe("dispatch reservations and verification", () => {
  it("stores one reservation and fails closed after an interrupted launch", () => {
    const db = new Database(":memory:");
    for (const migration of DISPATCH_MIGRATIONS) db.exec(migration);
    const store = createDispatchStore(db, () => 123);
    const choice = selectCandidate(groups(), "leaf", [], [])!;
    expect(store.policy()).toEqual({ mode: "off", effort_key: null });
    store.setPolicy("auto", "leaf");
    expect(store.reserve(choice)).toBe(1);
    expect(store.reserve(choice)).toBeNull();
    store.closeStranded();
    expect(store.attempts()[0]).toMatchObject({ status: "needs-you", startedAt: 123 });
    expect(store.reserve(choice)).toBeNull();
    db.close();
  });

  it("does not let stale verification overwrite an already settled attempt", () => {
    const db = new Database(":memory:");
    for (const migration of DISPATCH_MIGRATIONS) db.exec(migration);
    const store = createDispatchStore(db);
    const id = store.reserve(selectCandidate(groups(), "leaf", [], [])!)!;
    store.update(id, "verifying", "Checking PR");
    store.update(id, "verified", "Fresh full scan cleared the gate");
    store.finishVerification(id, "needs-you", "Stale targeted scan failed");
    expect(store.attempts()[0]).toMatchObject({ status: "verified", detail: "Fresh full scan cleared the gate" });
    db.close();
  });

  it("requires fresh gate facts, including review decisions, to prove movement", () => {
    const review = { ...unit.pr!, mergeStateStatus: "CLEAN" as const, reviewDecision: "CHANGES_REQUESTED", unresolvedReviewThreads: 1 };
    expect(gateStillOpen(review, "address-review")).toBe(true);
    expect(gateStillOpen({ ...review, unresolvedReviewThreads: 0 }, "address-review")).toBe(true);
    expect(gateStillOpen({ ...review, reviewDecision: "APPROVED", latestReviewStates: ["APPROVED"] }, "address-review")).toBe(false);
    expect(gateStillOpen(unit.pr!, "resolve-conflicts")).toBe(true);
    expect(gateStillOpen({ ...unit.pr!, mergeStateStatus: "CLEAN" }, "resolve-conflicts")).toBe(false);
  });
});
