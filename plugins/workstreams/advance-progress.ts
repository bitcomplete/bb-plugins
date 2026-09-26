import type { AdvanceBatch, AdvanceJob } from "./bulk-advance";

const ACTIVE = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);
export function canRemoveProgressJob(job: Pick<AdvanceJob, "status" | "uncertain">): boolean {
  return !job.uncertain && !["launching", "running", "verifying"].includes(job.status);
}

export function canRecheckProgressJob(job: Pick<AdvanceJob, "status" | "uncertain">): boolean {
  return job.status !== "cancelled" && (!ACTIVE.has(job.status) || (job.status === "running" && job.uncertain));
}

/** Keep older active work in sight when a more recent completed batch exists. */
export function progressBatches(batches: readonly AdvanceBatch[], history: boolean): AdvanceBatch[] {
  return history ? [...batches] : batches.filter((batch, index) => index === 0 || batch.jobs.some((job) => ACTIVE.has(job.status) || job.uncertain));
}

/** Removed rows remain in history, but never inflate the progress summary. */
export function progressCounts(jobs: readonly AdvanceJob[]) {
  const visible = jobs.filter((job) => !job.hiddenFromProgress);
  return {
    ready: visible.filter((job) => job.status === "ready").length,
    active: visible.filter((job) => ACTIVE.has(job.status)).length,
    attention: visible.filter((job) => job.status === "needs-attention").length,
    waiting: visible.filter((job) => job.status === "waiting-checks" || job.status === "waiting-review").length,
  };
}
