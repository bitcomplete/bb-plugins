import type { AdvanceJob } from "./bulk-advance";
import { advancePrKey } from "./bulk-advance-selection";

export const ADVANCE_STATUS: Record<AdvanceJob["status"], string> = {
  queued: "Queued", launching: "Starting worker", running: "Preparing branch", verifying: "Verifying",
  ready: "Ready to merge", "waiting-checks": "Waiting for checks", "waiting-review": "Waiting for review",
  "needs-attention": "Needs attention", cancelled: "Stopped before starting",
};

export function advanceStatus(job: Pick<AdvanceJob, "status"> & { needsFeedback?: boolean }): string {
  return job.status === "running" && job.needsFeedback ? "Addressing feedback" : ADVANCE_STATUS[job.status];
}

/** Jobs arrive newest batch first. An older verification cannot describe a newer commit. */
export function advanceResultForPr(jobs: readonly AdvanceJob[], pr: { url: string; headRefOid?: string | null; baseRefOid?: string | null }, readyNow: boolean): AdvanceJob | null {
  const job = jobs.find((item) => advancePrKey(item.prUrl) === advancePrKey(pr.url));
  if (job === undefined) return null;
  const inProgress = ["queued", "launching", "running", "verifying"].includes(job.status);
  if (!inProgress && ((job.checkedHeadOid !== null && pr.headRefOid && job.checkedHeadOid !== pr.headRefOid) || (job.checkedBaseOid && pr.baseRefOid && job.checkedBaseOid !== pr.baseRefOid))) return null;
  if (job.status === "ready" && !readyNow) return null;
  return job;
}
