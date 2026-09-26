import { describe, expect, it } from "vitest";
import { advanceJobSchema } from "./bulk-advance";
import { advanceResultForPr, advanceStatus } from "./bulk-advance-results";

const job = (patch: Record<string, unknown> = {}) => advanceJobSchema.parse({
  id: "job-1", prUrl: "https://github.com/acme/app/pull/1", repo: "acme/app", number: 1, title: "Improve account settings",
  headOid: "a".repeat(40), baseRefName: "main", headRefName: "settings", needsPreparation: true, eligible: true,
  detail: "All readiness gates passed", workspace: "create", status: "ready", threadId: "thread-1", path: "/worktree/settings",
  checkedHeadOid: "b".repeat(40), updatedAt: 1, ...patch,
});

describe("inline advance results", () => {
  it.each(["merged", "closed"] as const)("does not show a %s attempt as an active PR result", (status) => {
    const completed = job({ status, hiddenFromProgress: true });
    expect(advanceResultForPr([completed], { url: completed.prUrl }, true)).toBeNull();
    expect(advanceStatus(completed)).toBe(status === "merged" ? "Merged" : "Closed");
  });

  it("does not claim readiness after a newer push or fall back to another old batch", () => {
    expect(advanceResultForPr([job(), job({ id: "old", checkedHeadOid: "c".repeat(40) })], { url: job().prUrl, headRefOid: "c".repeat(40) }, true)).toBeNull();
  });
  it("does not treat GitHub historical baseRefOid as the current base tip", () => {
    const verified = job({ checkedBaseOid: "d".repeat(40) });
    expect(advanceResultForPr([verified], { url: verified.prUrl, headRefOid: verified.checkedHeadOid, baseRefOid: "e".repeat(40) }, true)).toBe(verified);
  });
  it("does not override the current row's blockers with an earlier ready verdict at the same commit", () => {
    const verified = job();
    expect(advanceResultForPr([verified], { url: verified.prUrl, headRefOid: verified.checkedHeadOid }, false)).toBeNull();
  });
  it("shows the latest batch for the verified commit", () => {
    const current = job();
    expect(advanceResultForPr([current, job({ id: "old" })], { url: current.prUrl.toUpperCase() + "/", headRefOid: current.checkedHeadOid }, true)).toBe(current);
  });
  it("keeps a fresh recheck visible while the older verified commit differs", () => {
    const rechecking = job({ status: "verifying" });
    expect(advanceResultForPr([rechecking], { url: rechecking.prUrl, headRefOid: "c".repeat(40) }, true)).toBe(rechecking);
  });
  it("keeps active preparation visible before there is a verified commit", () => {
    const running = job({ status: "running", checkedHeadOid: null });
    expect(advanceResultForPr([running], { url: running.prUrl, headRefOid: "c".repeat(40) }, true)).toBe(running);
  });
});

describe("advance work labels", () => {
  it("identifies active feedback work while preserving saved preparation labels", () => {
    expect(advanceStatus({ status: "running", dedicated: true, needsFeedback: true })).toBe("Repairing PR");
    expect(advanceStatus({ status: "running", needsFeedback: true })).toBe("Addressing feedback");
    expect(advanceStatus({ status: "running" })).toBe("Preparing branch");
    expect(advanceStatus({ status: "needs-attention", needsFeedback: true })).toBe("Needs attention");
  });
});
