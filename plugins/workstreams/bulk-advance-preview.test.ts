import { describe, expect, it } from "vitest";
import { advancePreviewAction, advancePreviewSummary } from "./bulk-advance-preview";

const job = (patch: Partial<Parameters<typeof advancePreviewAction>[0]> = {}) => ({ repo: "acme/app", eligible: true, needsPreparation: false, needsFeedback: false, ...patch });

describe("advance preview scope", () => {
  it("requires an agent and explicit feedback scope even when the branch is current", () => {
    const feedback = job({ needsFeedback: true });
    expect(advancePreviewAction(feedback)).toBe("Address feedback + verify");
    expect(advancePreviewSummary([feedback])).toEqual({ agentJobs: 1, verifyJobs: 0, skipped: 0, workers: 1, hasFeedback: true, hasPreparation: false });
  });
  it("counts mixed work once and shares a repository worker across feedback and branch jobs", () => {
    const jobs = [job({ needsFeedback: true, needsPreparation: true }), job({ needsFeedback: true }), job({ needsPreparation: true }), job(), job({ eligible: false, needsFeedback: true, repo: "acme/skipped" })];
    expect(advancePreviewSummary(jobs)).toEqual({ agentJobs: 3, verifyJobs: 1, skipped: 1, workers: 1, hasFeedback: true, hasPreparation: true });
    expect(jobs.map(advancePreviewAction)).toEqual(["Address feedback + prepare + verify", "Address feedback + verify", "Prepare branch + verify", "Verify only", "Skip"]);
  });
  it("keeps legacy preparation-only previews and true read-only verification distinct", () => {
    const legacy = { repo: "acme/app", eligible: true, needsPreparation: true };
    expect(advancePreviewAction(legacy)).toBe("Prepare branch + verify");
    expect(advancePreviewSummary([legacy]).hasFeedback).toBe(false);
    expect(advancePreviewSummary([job()])).toMatchObject({ agentJobs: 0, verifyJobs: 1, workers: 0 });
  });
});
