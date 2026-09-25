import { describe, expect, it } from "vitest";
import { advanceChecks, readAdvancePr } from "./advance-host.js";
import type { GhRunner } from "./ghactions.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const url = "https://github.com/example/widget/pull/42";
const view = {
  url, number: 42, title: "Fix account lookup", state: "OPEN", isDraft: false, isCrossRepository: false,
  headRefName: "fix-account", baseRefName: "main", headRefOid: head, baseRefOid: base,
  reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
  latestReviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};

function fixture(options: { view?: Record<string, unknown>; review?: Record<string, unknown>; bases?: unknown; views?: Record<string, unknown>[] } = {}) {
  let views = 0;
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === "api") value = { data: { repository: { pullRequest: {
      headRefOid: head, baseRefOid: base, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, ...options.review,
    } } } };
    else if (args[1] === "list") value = options.bases ?? [];
    else { value = { ...view, ...options.view, ...options.views?.[views] }; views++; }
    return { ok: true, stdout: JSON.stringify(value) };
  };
  return { run, calls };
}

describe("bulk advance verification", () => {
  it("calls a PR ready only after approval, feedback, checks, stack, and commit identities agree", async () => {
    const result = await readAdvancePr(fixture().run, url);
    expect(result).toMatchObject({ ok: true, facts: { readiness: "ready", headOid: head, baseOid: base, needsPreparation: false } });
  });

  it("keeps approved comments as attention even after the branch is mergeable", async () => {
    const result = await readAdvancePr(fixture({ review: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } } }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { readiness: "needs-attention", unresolvedThreads: 1 } });
  });

  it("prepares a blocked approved PR without claiming its comments have been addressed", async () => {
    const result = await readAdvancePr(fixture({ view: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }, review: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } } }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { needsPreparation: true, readiness: "needs-attention", unresolvedThreads: 1 } });
  });

  it("does not turn approved-with-note into ready when follow-up is unconfirmed", async () => {
    const result = await readAdvancePr(fixture({ view: { latestReviews: [{ state: "APPROVED", body: "Fix the fallback" }] } }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { approvalNotePending: true, readiness: "needs-attention" } });
  });

  it("leaves empty pending conclusions waiting, and distinguishes lost approval", async () => {
    expect(await readAdvancePr(fixture({ view: { statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "waiting-checks", checks: "pending" } });
    expect(await readAdvancePr(fixture({ view: { reviewDecision: "REVIEW_REQUIRED" } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "waiting-review" } });
  });

  it("refuses readiness when approval history or check data is incomplete", async () => {
    for (const options of [
      { review: { reviews: { pageInfo: { hasPreviousPage: true }, nodes: [] } } },
      { view: { statusCheckRollup: [{}] } },
    ]) expect(await readAdvancePr(fixture(options).run, url)).toMatchObject({ ok: true, facts: { readiness: "needs-attention" } });
    expect(await readAdvancePr(fixture({ review: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } } }).run, url)).toMatchObject({ ok: false });
  });

  it("reports a live open base PR as a dependency even when all checks pass", async () => {
    expect(await readAdvancePr(fixture({ bases: [{ number: 41, headRefName: "main" }] }).run, url))
      .toMatchObject({ ok: true, facts: { basePrNumber: 41, readiness: "needs-attention" } });
  });

  it("retries a head change and accepts only the coherent second attempt", async () => {
    const fake = fixture({ views: [{ headRefOid: "c".repeat(40) }] });
    expect(await readAdvancePr(fake.run, url)).toMatchObject({ ok: true, facts: { headOid: head } });
    expect(fake.calls.filter((args) => args[1] === "view")).toHaveLength(4);
  });

  it("fails boundedly if review facts describe an old head or base", async () => {
    for (const review of [{ headRefOid: "c".repeat(40) }, { baseRefOid: "c".repeat(40) }]) {
      const fake = fixture({ review });
      expect(await readAdvancePr(fake.run, url)).toMatchObject({ ok: false, error: expect.stringContaining("changed during verification") });
      expect(fake.calls.filter((args) => args[1] === "view")).toHaveLength(6);
    }
  });

  it("allows read-only verification of an already ready fork", async () => {
    expect(await readAdvancePr(fixture({ view: { isCrossRepository: true } }).run, url)).toMatchObject({ ok: true, facts: { readiness: "ready" } });
  });

  it("rejects partial API results and ambiguous base branches", async () => {
    expect(await readAdvancePr(fixture({ view: { baseRefOid: undefined } }).run, url)).toMatchObject({ ok: false });
    expect(await readAdvancePr(fixture({ bases: [{ number: 40, headRefName: "main" }, { number: 41, headRefName: "main" }] }).run, url)).toMatchObject({ ok: false });
  });
});

describe("advance checks", () => {
  it("fails closed for unknown states while permitting explicit skipped and neutral checks", () => {
    expect(advanceChecks([{ status: "COMPLETED", conclusion: "NEUTRAL" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passed");
    expect(advanceChecks([{ status: "NEW_STATE", conclusion: "SUCCESS" }])).toBe("unknown");
    expect(advanceChecks([{ state: "FAILURE" }])).toBe("failed");
    expect(advanceChecks([{ state: "PENDING" }])).toBe("pending");
  });
});
