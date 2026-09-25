import { describe, expect, it } from "vitest";
import { prSchema, type Pr } from "./contract.js";
import type { Row } from "./inbox.js";
import { backlogMatches, prBacklog, type BacklogEntry } from "./pr-backlog.js";
import { prLifecycle, unitLifecycle } from "./workstreams.js";

function pr(patch: Partial<Pr> = {}): Pr {
  return prSchema.parse({ number: 1, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"], url: "https://github.com/acme/app/pull/1", title: "Improve account settings", mergeable: "MERGEABLE", baseRefName: "main", headRefName: "settings", latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0, mergeStateStatus: "CLEAN", ...patch });
}
const entry = (patch: Partial<Pr> = {}, stale = false): BacklogEntry => ({ repo: "acme/app", pr: pr(patch), stale });
const now = Date.parse("2026-09-25T00:00:00Z");

describe("authored PR backlog", () => {
  it("shows each open PR once and ignores closed or merged inventory rows", () => {
    const rows = prBacklog([entry({}, true), entry(), entry({ state: "CLOSED", url: "https://github.com/acme/app/pull/2" }), entry({ state: "MERGED", url: "https://github.com/acme/app/pull/3" })], [], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: "ready", stale: false, local: null, action: { kind: "direct", action: "merge" } });
  });
  it("keeps approved PRs with unresolved work out of ready to merge", () => {
    for (const [patch, verb] of [
      [{ mergeStateStatus: "BEHIND" }, "Update branch"],
      [{ mergeStateStatus: "DIRTY" }, "Resolve conflicts"],
      [{ checkConclusions: ["FAILURE"] }, "CI failing"],
      [{ unresolvedReviewThreads: 1 }, "Approved, comments open"],
      [{ approvalHasBody: true }, "Review approval note"],
    ] as [Partial<Pr>, string][]) {
      expect(prBacklog([entry(patch)], [], now)[0]).toMatchObject({ group: "approved", verb });
    }
  });
  it("preserves approval while checks run and avoids requesting another review", () => {
    expect(prBacklog([entry({ checkConclusions: ["PENDING"] })], [], now)[0]).toMatchObject({ group: "approved", verb: "Checks pending", action: null });
  });
  it("separates stale or unverified reviews from actionable readiness", () => {
    expect(prBacklog([entry({}, true)], [], now)[0]).toMatchObject({ group: "unknown", action: null });
    expect(prBacklog([entry({ unresolvedReviewThreads: null })], [], now)[0]).toMatchObject({ group: "unknown", action: null });
  });
  it("waits for a known open stack parent in the same repository", () => {
    const parent = entry({ number: 2, url: "https://github.com/acme/app/pull/2", headRefName: "base-work", title: "Create account settings foundation" });
    const [child] = prBacklog([entry({ baseRefName: "base-work" }), parent], [], now).filter((row) => row.pr.number === 1);
    expect(child).toMatchObject({ group: "waiting", verb: "Behind #2", parent, action: { kind: "jump", behind: 2 } });
    expect(prBacklog([entry({ baseRefName: "base-work" }), { ...parent, repo: "other/app" }], [], now).find((row) => row.pr.number === 1)?.group).toBe("ready");
  });
  it("maps by PR URL, using inventory facts and retaining a real checkout's rebase guard", () => {
    const local = { key: "/real/app", title: "Old title", effort: "Account settings", unit: { path: "/real/app", pr: pr(), rebasing: true, dirty: true, observed: { status: true }, stack: null } } as Row;
    const [row] = prBacklog([entry({ title: "New title" })], [local, { ...local, key: "/aaa-second/app", unit: { ...local.unit, rebasing: undefined } }], now);
    expect(row).toMatchObject({ group: "draft", verb: "Rebase in progress", action: null, local: { key: "/real/app", title: "New title" } });
    expect(backlogMatches(row!, "app #1 settings")).toBe(true);
    expect(backlogMatches(row!, "#99")).toBe(false);
  });
  it("preserves checkout lifecycle overrides while sharing remote review logic", () => {
    expect(prLifecycle(pr({ reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true }))).toBe("awaiting-rereview");
    expect(unitLifecycle({ pr: pr({ state: "MERGED" }), shipped: true } as Parameters<typeof unitLifecycle>[0])).toBe("shipped");
    expect(unitLifecycle({ pr: pr({ isDraft: true }), dirty: true } as Parameters<typeof unitLifecycle>[0])).toBe("active");
  });
});
