import { describe, expect, it } from "vitest";
import { prSchema, type Pr } from "./contract.js";
import { stackParent } from "./pr-backlog.js";
import { prLifecycle, unitLifecycle } from "./workstreams.js";

function pr(patch: Partial<Pr> = {}): Pr {
  return prSchema.parse({ number: 1, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"], url: "https://github.com/acme/app/pull/1", title: "Improve account settings", mergeable: "MERGEABLE", baseRefName: "main", headRefName: "settings", latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0, mergeStateStatus: "CLEAN", approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, ...patch });
}
const entry = (patch: Partial<Pr> = {}) => ({ repo: "acme/app", pr: pr(patch) });

describe("stacked PRs and lifecycle", () => {
  it("stacks a PR on the open PR whose head is its base, only in the same repository", () => {
    const child = entry({ baseRefName: "base-work" });
    const parent = entry({ number: 2, url: "https://github.com/acme/app/pull/2", headRefName: "base-work", title: "Create account settings foundation" });
    expect(stackParent(child, [child, parent])).toBe(parent);
    expect(stackParent(child, [child, { ...parent, repo: "other/app" }])).toBeNull();
  });
  it("preserves checkout lifecycle overrides while sharing remote review logic", () => {
    expect(prLifecycle(pr({ reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true }))).toBe("awaiting-rereview");
    expect(unitLifecycle({ pr: pr({ state: "MERGED" }), shipped: true } as Parameters<typeof unitLifecycle>[0])).toBe("shipped");
    expect(unitLifecycle({ pr: pr({ isDraft: true }), dirty: true } as Parameters<typeof unitLifecycle>[0])).toBe("active");
  });
});
