import { describe, expect, it } from "vitest";
import { advanceBatchSchema, advanceJobSchema } from "./bulk-advance";
import { canRecheckProgressJob, canRemoveProgressJob, progressBatches, progressCounts } from "./advance-progress";

const job = (patch: Record<string, unknown> = {}) => advanceJobSchema.parse({ id: "job", prUrl: "https://github.com/acme/app/pull/1", repo: "acme/app", number: 1, title: "Improve account settings", headOid: "a".repeat(40), baseRefName: "main", headRefName: "settings", needsPreparation: true, eligible: true, detail: "Checks passed", workspace: "create", status: "ready", threadId: "worker", path: "/checkout", checkedHeadOid: "b".repeat(40), updatedAt: 1, ...patch });
const batch = (id: string, jobs: ReturnType<typeof job>[]) => advanceBatchSchema.parse({ id, createdAt: 1, cancelled: false, jobs });

describe("compact advance progress", () => {
  it("keeps active and uncertain batches visible behind a more recent completed batch", () => {
    const batches = [batch("new", [job()]), batch("old-active", [job({ status: "running" })]), batch("old-uncertain", [job({ status: "needs-attention", uncertain: true })]), batch("old-done", [job()])];
    expect(progressBatches(batches, false).map((item) => item.id)).toEqual(["new", "old-active", "old-uncertain"]);
    expect(progressBatches(batches, true)).toEqual(batches);
  });
  it("does not count removed history as current progress", () => {
    expect(progressCounts([job({ hiddenFromProgress: true }), job({ status: "needs-attention", hiddenFromProgress: true }), job({ status: "queued" }), job({ status: "waiting-review" })])).toEqual({ ready: 0, active: 1, attention: 0, waiting: 1 });
  });
  it("allows a running job with uncertain ownership to reconcile without rechecking ordinary active work", () => {
    expect(canRecheckProgressJob(job({ status: "running", uncertain: true }))).toBe(true);
    expect(canRecheckProgressJob(job({ status: "running" }))).toBe(false);
    expect(canRecheckProgressJob(job({ status: "queued", uncertain: true }))).toBe(false);
    expect(canRecheckProgressJob(job({ status: "cancelled" }))).toBe(false);
  });
  it("offers removal for queued or stopped jobs while retaining writers and uncertain ownership", () => {
    expect(canRemoveProgressJob(job({ status: "queued" }))).toBe(true);
    expect(canRemoveProgressJob(job({ status: "waiting-checks" }))).toBe(true);
    for (const status of ["running", "launching", "verifying"] as const) expect(canRemoveProgressJob(job({ status }))).toBe(false);
    expect(canRemoveProgressJob(job({ status: "needs-attention", uncertain: true }))).toBe(false);
  });
});
