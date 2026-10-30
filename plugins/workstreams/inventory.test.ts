import { describe, expect, it } from "vitest";
import { agesArgv, carryReviewFacts, INVENTORY_LIMIT, OPEN_PRS_QUERY, readAuthoredPrs, readInventoryPrs, readOpenAuthoredPrs } from "./inventory.js";
import { githubRepoFromRemote, parsePrList, PR_FIELDS } from "./gh.js";
import { githubRateLimit, type GhRunner, type Run } from "./ghactions.js";
import type { Pr } from "./contract.js";
import { feedbackToAddress } from "./feedback-to-address.js";

const url = (number: number, repo = "folio") => `https://github.com/inkwell/${repo}/pull/${number}`;
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number, url: url(number), state: "OPEN", title: "Improve manuscript review", isDraft: false,
  reviewDecision: "APPROVED", latestReviews: [], statusCheckRollup: [{ conclusion: "SUCCESS" }],
  mergeStateStatus: "CLEAN", ...extra,
});
const ok = (value: unknown): Run => ({ ok: true, stdout: JSON.stringify(value) });
const threads = (nodes: { isResolved: boolean }[] = [], hasNextPage = false) => ok({
  data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage } } } } },
});
/** Review-thread reads, apart from the one ages read per repository. */
const threadReads = (calls: string[][]) => calls.filter((args) => args[0] === "api" && args.some((arg) => arg.includes("reviewThreads")));
function fake(answers: (args: readonly string[]) => Run) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push([...args]);
    return answers(args);
  };
  return { run, calls };
}

describe("authored PR inventory", () => {
  it("finds authored PRs without checkouts and uses current review facts, never search review matches", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }, { url: url(2) }]) :
      args[0] === "pr" ? ok([pr(1), pr(2, { reviewDecision: "REVIEW_REQUIRED" })]) : threads());
    const result = await readAuthoredPrs(gh.run, ["Inkwell", "inkwell"]);
    expect(result).toMatchObject({ owners: ["inkwell"], complete: true, discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }] });
    expect(result.entries.map((entry) => entry.pr.reviewDecision)).toEqual(["APPROVED", "REVIEW_REQUIRED"]);
    expect(result.entries[0]?.pr.unresolvedReviewThreads).toBe(0);
    expect(result.entries[1]?.pr.unresolvedReviewThreads).toBeNull();
    expect(gh.calls[0]).toEqual(["search", "prs", "--author", "@me", "--state", "open", "--owner", "inkwell", "--limit", "1000", "--json", "url"]);
    expect(gh.calls[1]).toContain(PR_FIELDS);
    expect(threadReads(gh.calls)).toHaveLength(1);
  });

  it("never expands empty or malformed organization scope to all GitHub", async () => {
    const gh = fake(() => ok([]));
    for (const scope of [[], ["--admin"], ["inkwell", ""], Array.from({ length: 51 }, (_, i) => `org${i}`)]) {
      expect(await readAuthoredPrs(gh.run, scope)).toMatchObject({ complete: false, discoveryComplete: false, entries: [] });
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("distinguishes failed discovery from a verified empty authored backlog", async () => {
    const failed = await readAuthoredPrs(async () => ({ ok: false, error: "offline" }), ["inkwell"]);
    const empty = await readAuthoredPrs(async () => ok([]), ["inkwell"]);
    expect(failed).toMatchObject({ complete: false, discoveryComplete: false, entries: [] });
    expect(empty).toMatchObject({ complete: true, discoveryComplete: true, entries: [] });
  });

  it("reports repository membership independently so failures do not hide successful closed-PR removals", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }, { url: url(2, "spine") }]) :
      args.includes("inkwell/spine") ? { ok: false, error: "offline" } : ok([pr(1, { state: "CLOSED" })]));
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result).toMatchObject({ discoveryComplete: true, complete: false, entries: [], repositories: [
      { repo: "inkwell/folio", complete: true }, { repo: "inkwell/spine", complete: false },
    ] });
  });

  it("deduplicates PR URLs and omits merged and closed PRs even if discovery is stale", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }, { url: url(1) }]) :
      args[0] === "pr" ? ok([pr(1), pr(1), pr(2, { state: "CLOSED" }), pr(3, { state: "MERGED" })]) : threads());
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.entries.map((entry) => entry.pr.number)).toEqual([1]);
    expect(result.complete).toBe(true);
    expect(threadReads(gh.calls)).toHaveLength(1);
  });

  it("keeps approval unverified on a failed review read without losing complete membership", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) :
      args[0] === "pr" ? ok([pr(1)]) : { ok: false, error: "offline" });
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result).toMatchObject({ complete: false, discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }] });
    expect(result.entries[0]?.pr.unresolvedReviewThreads).toBeNull();
  });

  it("retains unresolved threads and marks incomplete review pages without claiming readiness", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) :
      args[0] === "pr" ? ok([pr(1)]) : threads([{ isResolved: false }], true));
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.complete).toBe(false);
    expect(result.entries[0]?.pr).toMatchObject({ unresolvedReviewThreads: 1, resolvedReviewThreads: null });
  });

  it("requests follow-up evidence for written approvals, changes requested, and a reviewed draft, but skips a draft nobody reviewed", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([
      pr(1, { latestReviews: [{ state: "APPROVED", body: "Please cover this edge case." }] }),
      pr(2, { reviewDecision: "CHANGES_REQUESTED" }), pr(3, { isDraft: true }), pr(4, { isDraft: true, reviewDecision: "REVIEW_REQUIRED" }),
    ]) : threads());
    await readAuthoredPrs(gh.run, ["inkwell"]);
    const reads = threadReads(gh.calls);
    expect(reads).toHaveLength(3);
    expect(reads.every((args) => args.includes("includeFollowup=true"))).toBe(true);
    expect(reads.some((args) => args.includes("number=4"))).toBe(false);
  });

  // A draft's approval can say the work isn't done, and Your turn lists a draft for that: its read keeps the approval's notes and who spoke
  // last, but not the thread counts a draft's state word skips.
  it("reads a reviewed draft's approval notes for Your turn, keeping its thread counts unread", async () => {
    const approval = { id: "approval-1", state: "APPROVED", body: "Hold this until the migration runs.", submittedAt: "2026-09-29T10:00:00Z",
      author: { __typename: "User", login: "mira-l" }, commit: { oid: "a".repeat(40) } };
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([
      pr(1, { isDraft: true, latestReviews: [{ author: { login: "mira-l" }, state: "APPROVED", submittedAt: approval.submittedAt }] }),
    ]) : ok({ data: { repository: { pullRequest: { headRefOid: "a".repeat(40), author: { login: "ana-w" }, baseRefName: "main",
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [approval] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, comments: { pageInfo: { hasPreviousPage: false }, nodes: [] }, timelineItems: { nodes: [] } } } } }));
    const draft = (await readAuthoredPrs(gh.run, ["inkwell"])).entries[0]!.pr;
    expect(draft).toMatchObject({ isDraft: true, unresolvedReviewThreads: null, approvalFeedback: { status: "present" },
      reviewFeedback: { comment: null, repliedAt: null, noteAt: approval.submittedAt, followUpAt: null } });
    expect(draft.reviewFollowupPosted).toBeUndefined();
    expect(feedbackToAddress(draft, false)).toEqual([{ kind: "approval", login: null, since: Date.parse(approval.submittedAt) }]);
  });

  // Your turn needs a commented PR's feedback too, but its state word stays what the approve-or-change-request read says it is.
  it("reads a PR with only comments for Your turn, keeping its thread counts unread", async () => {
    const reviews = [{ author: { login: "otto-v" }, state: "COMMENTED", submittedAt: "2026-09-29T10:00:00Z" }];
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([
      pr(1, { reviewDecision: "REVIEW_REQUIRED", latestReviews: reviews }), pr(2, { reviewDecision: "REVIEW_REQUIRED" }),
    ]) : ok({ data: { repository: { pullRequest: { author: { login: "ana-w" }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: reviews },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: "otto-v" }, createdAt: "2026-09-29T10:00:00Z" }] } }] },
      comments: { nodes: [] } } } } }));
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    const reads = threadReads(gh.calls);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("includeFollowup=true");
    expect(result.entries[0]?.pr).toMatchObject({ unresolvedReviewThreads: null,
      reviewFeedback: { openThreads: 1, comment: { login: "otto-v", at: "2026-09-29T10:00:00Z" }, repliedAt: null } });
    expect(result.entries[0]?.pr.approvalFeedback).toBeUndefined();
    // No one reviewed #2: nothing to read.
    expect(result.entries[1]?.pr.reviewFeedback).toBeUndefined();
  });

  it("rejects malformed and out-of-scope discovery data without using it as a gh target", async () => {
    const gh = fake(() => ok([{ url: "https://github.com/another/folio/pull/1" }, { url: "--admin" }, null]));
    expect(await readAuthoredPrs(gh.run, ["inkwell"])).toMatchObject({ complete: false, discoveryComplete: false, entries: [] });
    expect(gh.calls).toHaveLength(1);
    expect(await readAuthoredPrs(async () => ({ ok: true, stdout: "invalid" }), ["inkwell"])).toMatchObject({ discoveryComplete: false });
  });

  it("marks malformed repository rows incomplete instead of dropping prior cached PRs", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) :
      args[0] === "pr" ? ok([pr(1, { reviewDecision: null }), null, pr(2, { url: url(2, "spine") }), pr(3, { number: 4 })]) : threads());
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.entries).toHaveLength(1);
    expect(result.repositories).toEqual([{ repo: "inkwell/folio", complete: false }]);
    expect(result.complete).toBe(false);
  });

  it("reports discovery and repository caps as partial and bounds result size", async () => {
    const rows = Array.from({ length: INVENTORY_LIMIT }, (_, index) => pr(index + 1, { reviewDecision: null }));
    const gh = fake((args) => args[0] === "search" ? ok(rows.map((row) => ({ url: row.url }))) : ok(rows));
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.entries).toHaveLength(INVENTORY_LIMIT);
    expect(result).toMatchObject({ complete: false, discoveryComplete: false, repositories: [{ repo: "inkwell/folio", complete: false }] });
  });
});

describe("inventory invalidation reads", () => {
  it("refreshes only known URLs, verifies reviews, and distinguishes closed PRs from failed reads", async () => {
    const gh = fake((args) => args[0] === "api" ? threads([{ isResolved: false }]) :
      args[2] === "1" ? ok(pr(1)) : args[2] === "2" ? ok(pr(2, { state: "MERGED" })) : { ok: false, error: "offline" });
    const result = await readInventoryPrs(gh.run, [url(1), url(2), url(3)]);
    expect(result.entries[0]?.pr.unresolvedReviewThreads).toBe(1);
    expect(result.closed).toEqual([url(2)]);
    expect(result.failed).toEqual([url(3)]);
    expect(gh.calls.some((args) => args[0] === "search" || args[1] === "list")).toBe(false);
  });

  it("names the closed PRs that merged, with GitHub's merge time, title, and branch, so a merge still counts once the PR leaves", async () => {
    const gh = fake((args) => args[2] === "1" ? ok(pr(1, { state: "MERGED", mergedAt: "2026-09-28T10:00:00Z", headRefName: "abc-1-shelf" }))
      : ok(pr(2, { state: "CLOSED" })));
    const result = await readInventoryPrs(gh.run, [url(1), url(2)]);
    expect(result.closed).toEqual([url(1), url(2)]);
    expect(result.merged).toEqual([{ url: url(1), at: "2026-09-28T10:00:00Z", title: "Improve manuscript review", headRefName: "abc-1-shelf" }]);
  });

  it("refuses mismatched PR identities and malformed data rather than overwriting the requested row", async () => {
    const gh = fake((args) => args[2] === "1" ? ok(pr(2)) : { ok: true, stdout: "bad json" });
    expect(await readInventoryPrs(gh.run, [url(1), url(2)])).toMatchObject({ entries: [], closed: [], failed: [url(1), url(2)] });
  });
});

describe("PR ages", () => {
  const head = "a".repeat(40);
  const isAges = (args: readonly string[]) => args.some((arg) => arg.includes("fragment ages"));
  const numbersOf = (args: readonly string[]) => args.flatMap((arg) => /^n\d+=(\d+)$/u.exec(arg)?.[1] ?? []).map(Number);
  const asked = (login: string, createdAt: string) => ({ createdAt, requestedReviewer: login.includes("/") ? { combinedSlug: login } : { login } });
  const node = (oid: string, events: unknown[]) => ({ commits: { nodes: [{ commit: { oid, committedDate: "2026-09-25T10:00:00Z" } }] }, timelineItems: { nodes: events } });
  const requested = pr(1, { headRefOid: head, reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: [{ login: "mira" }, { __typename: "Team", slug: "editors", organization: { login: "inkwell" } }] });

  it("dates the last push and each reviewer still requested from one read per repository, keeping each reviewer's latest request", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }, { url: url(2, "spine") }]) :
      args.includes("inkwell/spine") ? ok([pr(2, { url: url(2, "spine"), headRefOid: head, reviewDecision: null })]) : args[0] === "pr" ? ok([requested]) :
      isAges(args) ? ok({ data: { repository: { p0: node(head, [asked("mira", "2026-09-22T09:00:00Z"), asked("inkwell/editors", "2026-09-23T09:00:00Z"),
        asked("Mira", "2026-09-24T09:00:00Z"), asked("otto", "2026-09-21T09:00:00Z"), { createdAt: "2026-09-21T09:00:00Z", requestedReviewer: null }]) } } }) : threads());
    const result = await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.complete).toBe(true);
    expect(result.entries.find((entry) => entry.repo === "inkwell/folio")?.pr).toMatchObject({ headCommittedAt: "2026-09-25T10:00:00Z",
      // otto was asked once but is no longer requested, so his request dates nothing.
      reviewRequestedAt: [{ reviewer: "mira", at: "2026-09-24T09:00:00Z" }, { reviewer: "inkwell/editors", at: "2026-09-23T09:00:00Z" }] });
    const reads = gh.calls.filter(isAges);
    expect(reads.map((args) => args[args.indexOf("-f", 4) + 1])).toEqual(["owner=inkwell", "owner=inkwell"]);
    expect(reads.map(numbersOf)).toEqual([[1], [2]]);
    // Every value is a typed field; the query text never carries one.
    expect(reads.every((args) => !args[3]!.includes("inkwell") && !args[3]!.includes("folio"))).toBe(true);
  });

  it("leaves the push undated when the head moved between reads, and keeps request times", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([requested]) :
      isAges(args) ? ok({ data: { repository: { p0: node("b".repeat(40), [asked("mira", "2026-09-22T09:00:00Z")]) } } }) : threads());
    const [entry] = (await readAuthoredPrs(gh.run, ["inkwell"])).entries;
    expect(entry?.pr.headCommittedAt).toBeUndefined();
    expect(entry?.pr.reviewRequestedAt).toEqual([{ reviewer: "mira", at: "2026-09-22T09:00:00Z" }]);
  });

  it("reports a failed ages read and leaves those PRs undated, so none of them is nudged on a guess", async () => {
    for (const answer of [{ ok: false, error: "rate limit" } as Run, ok({ errors: [{ message: "Field 'combinedSlug' doesn't exist" }] }), { ok: true, stdout: "{" } as Run]) {
      const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([requested]) : isAges(args) ? answer : threads());
      const result = await readAuthoredPrs(gh.run, ["inkwell"]);
      expect(result.complete).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining("inkwell/folio: PR ages could not be read")]);
      expect(result.entries[0]?.pr).not.toHaveProperty("headCommittedAt");
      expect(result.entries[0]?.pr).not.toHaveProperty("reviewRequestedAt");
    }
  });

  it("reads a repository's PRs 25 at a time", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => pr(index + 1, { reviewDecision: null }));
    const gh = fake((args) => args[0] === "search" ? ok(rows.map((row) => ({ url: row.url }))) : args[0] === "pr" ? ok(rows) : ok({ data: { repository: {} } }));
    await readAuthoredPrs(gh.run, ["inkwell"]);
    expect(gh.calls.filter(isAges).map((args) => numbersOf(args).length).sort((a, b) => a - b)).toEqual([5, 25]);
    expect(agesArgv("inkwell/folio", [7, 9])).toEqual(expect.arrayContaining(["owner=inkwell", "name=folio", "n0=7", "n1=9"]));
  });

  it("dates a single PR refresh too, so a nudge from the refreshed row reads fresh request times", async () => {
    const gh = fake((args) => args[0] === "pr" ? ok(requested) :
      isAges(args) ? ok({ data: { repository: { p0: node(head, [asked("mira", "2026-09-22T09:00:00Z")]) } } }) : threads());
    const result = await readInventoryPrs(gh.run, [url(1)]);
    expect(result.entries[0]?.pr).toMatchObject({ headCommittedAt: "2026-09-25T10:00:00Z", reviewRequestedAt: [{ reviewer: "mira", at: "2026-09-22T09:00:00Z" }] });
    expect(gh.calls.filter(isAges)).toHaveLength(1);
  });
});

describe("the inventory poll's batched read", () => {
  const head = "a".repeat(40);
  const committedDate = "2026-09-25T10:00:00Z";
  const events = [{ createdAt: "2026-09-24T09:00:00Z", requestedReviewer: { login: "mira" } }];
  const threadNodes = [{ isResolved: false }, { isResolved: true }];
  const rows = [
    pr(1, { headRefOid: head, reviewRequests: [{ __typename: "User", login: "mira" }], createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-25T11:00:00Z",
      latestReviews: [{ author: { login: "otto" }, state: "APPROVED", submittedAt: "2026-09-23T09:00:00Z", body: "" }], body: "Fixes ABC-12",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
        { __typename: "StatusContext", state: "FAILURE" }] }),
    pr(2, { headRefOid: head, isDraft: true, reviewRequests: [{ __typename: "Team", slug: "editors", organization: { login: "inkwell" } }] }),
  ];
  /** A `gh pr list` row as the search returns it. */
  const node = (row: Record<string, unknown>, threads: { hasNextPage: boolean; nodes: { isResolved: boolean }[] } = { hasNextPage: false, nodes: threadNodes }) => ({
    ...row, latestReviews: { nodes: row.latestReviews ?? [] }, reviewRequests: { nodes: ((row.reviewRequests ?? []) as unknown[]).map((requestedReviewer) => ({ requestedReviewer })) },
    commits: { nodes: [{ commit: { oid: head, committedDate, statusCheckRollup: { contexts: { nodes: row.statusCheckRollup } } } }] },
    timelineItems: { nodes: events }, reviewThreads: { pageInfo: { hasNextPage: threads.hasNextPage }, nodes: threads.nodes } });
  const page = (nodes: unknown[], endCursor: string | null = null) => ok({ data: { search: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } });

  it("reads what discovery, each repository's listing, the ages read, and the thread reads would, in one GraphQL call", async () => {
    const ages = { commits: { nodes: [{ commit: { oid: head, committedDate } }] }, timelineItems: { nodes: events } };
    const full = fake((args) => args[0] === "search" ? ok(rows.map((row) => ({ url: row.url }))) : args[0] === "pr" ? ok(rows) :
      args.some((arg) => arg.includes("fragment ages")) ? ok({ data: { repository: { p0: ages, p1: ages } } }) : threads(threadNodes));
    const batched = fake(() => page(rows.map((row) => node(row))));
    const polled = await readOpenAuthoredPrs(batched.run, ["Inkwell"]);
    expect(batched.calls).toEqual([["api", "graphql", "-f", `query=${OPEN_PRS_QUERY}`, "-f", "q=is:pr is:open author:@me sort:created-asc user:inkwell"]]);
    expect(polled).toMatchObject({ complete: true, discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }] });
    // The same facts a full refresh keeps, so a poll and a refresh never flip a row between two readings; only the evidence a PR's own
    // review read proves is left out.
    const withoutEvidence = ({ approvalFeedback: _feedback, reviewFollowupPosted: _followup, ...rest }: Pr) => rest;
    expect(polled.entries).toEqual((await readAuthoredPrs(full.run, ["inkwell"])).entries.map((entry) => ({ ...entry, pr: withoutEvidence(entry.pr) })));
    expect(polled.entries[0]?.pr).toMatchObject({ checkConclusions: ["SUCCESS", "PENDING", "FAILURE"], unresolvedReviewThreads: 1, resolvedReviewThreads: 1,
      headCommittedAt: committedDate, reviewRequestedAt: [{ reviewer: "mira", at: "2026-09-24T09:00:00Z" }], ticketRefs: { mentions: ["ABC-12"] } });
    expect(polled.entries[0]?.pr).not.toHaveProperty("approvalFeedback");
    // A draft's threads aren't read, as the per-PR read skips them.
    expect(polled.entries[1]?.pr).toMatchObject({ reviewRequests: ["inkwell/editors"], unresolvedReviewThreads: null });
  });

  it("pages with the cursor as a typed field, and reads a failed page as partial membership that keeps what it read", async () => {
    const gh = fake((args) => args.includes("after=cursor-1") ? { ok: false, error: "GraphQL: API rate limit exceeded for user ID 1." } : page([node(rows[0]!)], "cursor-1"));
    const result = await readOpenAuthoredPrs(gh.run, ["inkwell"]);
    expect(gh.calls).toHaveLength(2);
    expect(result).toMatchObject({ complete: false, discoveryComplete: false, repositories: [{ repo: "inkwell/folio", complete: false }] });
    expect(result.entries.map((entry) => entry.pr.number)).toEqual([1]);
    // The caller waits for the limit to reset instead of reading again.
    expect(githubRateLimit(result.warnings.join("\n"))).toBe("primary");
  });

  it("never widens an empty or malformed scope, and drops what the search returns from outside it", async () => {
    const gh = fake(() => page([node(rows[0]!), node(pr(3, { url: "https://github.com/another/folio/pull/3" }))]));
    for (const scope of [[], ["--admin"], ["inkwell", ""]]) expect(await readOpenAuthoredPrs(gh.run, scope)).toMatchObject({ discoveryComplete: false, entries: [] });
    expect(gh.calls).toHaveLength(0);
    const result = await readOpenAuthoredPrs(gh.run, ["inkwell"]);
    expect(result.entries.map((entry) => entry.pr.number)).toEqual([1]);
    expect(result).toMatchObject({ complete: false, discoveryComplete: false });
  });

  it("counts review threads only as far as it read them", async () => {
    const unread = (nodes: { isResolved: boolean }[]) => fake(() => page([node(rows[0]!, { hasNextPage: true, nodes })]));
    expect((await readOpenAuthoredPrs(unread([{ isResolved: true }]).run, ["inkwell"])).entries[0]?.pr)
      .toMatchObject({ unresolvedReviewThreads: null, resolvedReviewThreads: null });
    expect((await readOpenAuthoredPrs(unread([{ isResolved: false }]).run, ["inkwell"])).entries[0]?.pr)
      .toMatchObject({ unresolvedReviewThreads: 1, resolvedReviewThreads: null });
  });
});

describe("review evidence across polls", () => {
  const read: Pr = { ...parsePrList(JSON.stringify([pr(1, { headRefOid: "a".repeat(40), updatedAt: "2026-09-25T11:00:00Z",
    latestReviews: [{ author: { login: "otto" }, state: "APPROVED", submittedAt: "2026-09-23T09:00:00Z" }] })]))!.pr,
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, reviewFollowupPosted: false,
    reviewFeedback: { openThreads: 2, comment: null, repliedAt: null, noteAt: null, followUpAt: null } };
  const { approvalFeedback: _feedback, reviewFollowupPosted: _followup, reviewFeedback: _turn, ...polled } = read;

  it("carries a PR's approval evidence while nothing on it moved, and asks for its own read once anything did", () => {
    expect(carryReviewFacts(polled, read)).toEqual(read);
    for (const moved of [{ headRefOid: "b".repeat(40) }, { reviewDecision: "CHANGES_REQUESTED" }, { updatedAt: "2026-09-26T09:00:00Z" }, { latestReviews: [] }]) {
      expect(carryReviewFacts({ ...polled, ...moved }, read)).toBeNull();
    }
    expect(carryReviewFacts(polled, undefined)).toBeNull();
    // A read from before Your turn proves no feedback facts, and one from before feedback to address dated no answer: each is read again once.
    expect(carryReviewFacts(polled, { ...read, reviewFeedback: undefined })).toBeNull();
    expect(carryReviewFacts(polled, { ...read, reviewFeedback: { openThreads: 2, comment: null, repliedAt: null } })).toBeNull();
    // A draft nobody reviewed has nothing to read. A reviewed one carries its feedback and approval evidence, but no thread facts.
    const unreviewed = { ...polled, isDraft: true, reviewDecision: "REVIEW_REQUIRED", latestReviews: [] };
    expect(carryReviewFacts(unreviewed, undefined)).toEqual(unreviewed);
    expect(carryReviewFacts({ ...polled, isDraft: true }, undefined)).toBeNull();
    expect(carryReviewFacts({ ...polled, isDraft: true }, { ...read, isDraft: true })).toEqual({ ...polled, isDraft: true,
      approvalFeedback: read.approvalFeedback, reviewFeedback: read.reviewFeedback });
  });

  // Threads this poll saw resolved are no longer open, even while GitHub's update time stands still.
  it("never carries more open threads than the poll counted", () => {
    expect(carryReviewFacts({ ...polled, unresolvedReviewThreads: 0 }, read)?.reviewFeedback).toEqual({ openThreads: 0, comment: null, repliedAt: null,
      noteAt: null, followUpAt: null });
  });

  // A PR with only comments has its reviews read for Your turn, but keeps its thread counts and approval evidence as they were.
  it("carries a commented PR's feedback facts, and nothing its state word reads", () => {
    const commented: Pr = { ...polled, reviewDecision: "REVIEW_REQUIRED", latestReviews: [{ login: "otto", state: "COMMENTED", submittedAt: "2026-09-23T09:00:00Z" }] };
    const stored: Pr = { ...commented, reviewFeedback: { openThreads: 1, comment: { login: "otto", at: "2026-09-23T09:00:00Z" }, repliedAt: null,
      noteAt: null, followUpAt: null } };
    expect(carryReviewFacts(commented, undefined)).toBeNull();
    expect(carryReviewFacts(commented, stored)).toEqual(stored);
    expect(carryReviewFacts(commented, stored)).not.toHaveProperty("approvalFeedback");
    // No one has reviewed it: nothing to read.
    expect(carryReviewFacts({ ...commented, latestReviews: [] }, undefined)).toEqual({ ...commented, latestReviews: [] });
  });
});

describe("GitHub organization scope from checkout origins", () => {
  it("keeps exact repository identity for supported origins including checkouts with no PR", () => {
    for (const remote of ["https://github.com/inkwell/folio.git", "git@github.com:inkwell/folio.git", "ssh://git@github.com/inkwell/folio.git"]) {
      expect(githubRepoFromRemote(remote)).toBe("inkwell/folio");
    }
    for (const remote of ["/local/path", "https://another.example/inkwell/folio.git", "github.com/folio", "--flag"]) {
      expect(githubRepoFromRemote(remote)).toBeNull();
    }
  });
});
