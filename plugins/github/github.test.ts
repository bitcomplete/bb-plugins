import { describe, expect, it } from "vitest";
import { parseRef, parseRefKey, parseTarget, refKey, TARGET_QUERY } from "./github.js";

describe("refs", () => {
  it("reads a URL, owner/repo#n and owner/repo/pull/n, keeping the casing", () => {
    for (const input of [
      "https://github.com/Acme/Widgets/pull/12",
      "https://github.com/Acme/Widgets/pull/12/files",
      "https://github.com/Acme/Widgets/issues/12#issuecomment-5",
      "http://www.github.com/Acme/Widgets/pulls/12",
      " Acme/Widgets#12 ",
      "Acme/Widgets/pull/12",
      "Acme/Widgets/issues/12",
    ]) {
      expect(parseRef(input), input).toEqual({ repo: "Acme/Widgets", number: 12 });
    }
    expect(refKey({ repo: "Acme/Widgets", number: 12 })).toBe("Acme/Widgets#12");
    expect(parseRefKey("Acme/Widgets#12")).toEqual({ repo: "Acme/Widgets", number: 12 });
  });

  it("refuses what is not one", () => {
    for (const input of ["", "#12", "Acme#12", "Acme/Widgets", "Acme/Widgets#0", "Acme/Widgets#x", "https://gitlab.com/a/b/-/merge_requests/1", "https://github.com/Acme/Widgets/commit/abc", "a/b/c#1"]) {
      expect(parseRef(input), input).toBeNull();
    }
    expect(parseRefKey("nope")).toBeNull();
  });
});

const pull = (over: Record<string, unknown> = {}) => ({
  data: {
    repository: {
      nameWithOwner: "Acme/Widgets",
      issueOrPullRequest: {
        __typename: "PullRequest",
        number: 12,
        title: "Add widgets",
        url: "https://github.com/Acme/Widgets/pull/12",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-09T10:00:00Z",
        author: { login: "jane" },
        assignees: { nodes: [{ login: "jane" }] },
        labels: { nodes: [{ name: "feature" }, { name: "backend" }] },
        milestone: null,
        comments: { nodes: [{ author: { login: "bob" }, body: "Looks fine", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/1" }] },
        state: "OPEN",
        isDraft: false,
        merged: false,
        reviewDecision: "REVIEW_REQUIRED",
        headRefName: "feature/widgets",
        headRefOid: "0123456789abcdef",
        baseRefName: "main",
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "carol" } }, { requestedReviewer: { __typename: "Team", name: "backend" } }, { requestedReviewer: null }] },
        latestReviews: { nodes: [{ author: { login: "bob" }, state: "COMMENTED" }, { author: { login: "jane" }, state: "PENDING" }] },
        reviews: {
          nodes: [
            { author: { login: "bob" }, state: "COMMENTED", body: "", createdAt: "2026-10-09T08:00:00Z", submittedAt: "2026-10-09T08:30:00Z", url: "https://github.com/r/1", comments: { nodes: [{ author: { login: "bob" }, body: "nit", createdAt: "2026-10-09T08:10:00Z", url: "https://github.com/rc/1", path: "src/a.ts" }] } },
            { author: { login: "jane" }, state: "PENDING", body: "draft", createdAt: "2026-10-09T11:00:00Z", submittedAt: null, url: null, comments: { nodes: [] } },
          ],
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: "0123456789abcdef",
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/test" },
                      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/lint" },
                      { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
                      { __typename: "StatusContext", context: "ci/deploy", state: "ERROR", targetUrl: "https://ci/deploy" },
                    ],
                  },
                },
              },
            },
          ],
        },
        ...over,
      },
    },
  },
});

describe("parseTarget", () => {
  it("reads a pull request: fields, the latest review per reviewer, failing checks, and one feed of comments and reviews", () => {
    const t = parseTarget(pull())!;
    expect(t).toMatchObject({
      kind: "pull",
      repo: "Acme/Widgets",
      number: 12,
      key: "Acme/Widgets#12",
      title: "Add widgets",
      state: "open",
      author: "jane",
      assignees: ["jane"],
      labels: ["backend", "feature"],
      milestone: null,
      updatedAt: "2026-10-09T10:00:00Z",
    });
    expect(t.pull).toEqual({
      base: "main",
      head: "feature/widgets",
      headSha: "0123456789abcdef",
      reviewDecision: "review required",
      requestedReviewers: ["backend", "carol"],
      reviews: ["bob: commented"],
      checks: { state: "failure", failing: ["ci/deploy (https://ci/deploy)", "test (https://ci/test)"] },
    });
    // The empty COMMENTED review is told by its inline comment; the pending review is not news.
    expect(t.comments).toEqual([
      { author: "bob", did: "commented on src/a.ts", body: "nit", createdAt: "2026-10-09T08:10:00Z", url: "https://github.com/rc/1" },
      { author: "bob", did: "commented", body: "Looks fine", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/1" },
    ]);
    expect(TARGET_QUERY).toContain("issueOrPullRequest(number: $number)");
  });

  it("words the state: draft, merged, closed; an approval counts as a comment even without words", () => {
    expect(parseTarget(pull({ isDraft: true }))!.state).toBe("open (draft)");
    expect(parseTarget(pull({ state: "MERGED", merged: true }))!.state).toBe("merged");
    expect(parseTarget(pull({ state: "CLOSED" }))!.state).toBe("closed");
    const approved = parseTarget(pull({ reviews: { nodes: [{ author: { login: "carol" }, state: "APPROVED", body: "", createdAt: "2026-10-09T12:00:00Z", submittedAt: "2026-10-09T12:00:01Z", url: "https://github.com/r/2", comments: { nodes: [] } }] } }))!;
    expect(approved.comments.at(-1)).toEqual({ author: "carol", did: "approved", body: "", createdAt: "2026-10-09T12:00:01Z", url: "https://github.com/r/2" });
    expect(parseTarget(pull({ commits: { nodes: [{ commit: { oid: "abc", statusCheckRollup: null } }] } }))!.pull!.checks).toBeNull();
  });

  it("reads an issue, with the close reason, and no pull request fields", () => {
    const t = parseTarget({
      data: {
        repository: {
          nameWithOwner: "Acme/Widgets",
          issueOrPullRequest: { __typename: "Issue", number: 3, title: "Bug", url: "https://github.com/Acme/Widgets/issues/3", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", author: { login: "bob" }, assignees: { nodes: [] }, labels: { nodes: [] }, milestone: { title: "v1" }, comments: { nodes: [] }, state: "CLOSED", stateReason: "NOT_PLANNED" },
        },
      },
    })!;
    expect(t).toMatchObject({ kind: "issue", key: "Acme/Widgets#3", state: "closed (not planned)", milestone: "v1", pull: null, comments: [] });
  });

  it("is null for a missing repository or number, and throws for any other error", () => {
    expect(parseTarget({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] })).toBeNull();
    expect(parseTarget({ data: { repository: { nameWithOwner: "Acme/Widgets", issueOrPullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] })).toBeNull();
    expect(() => parseTarget({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })).toThrow(/rate limit/u);
    expect(() => parseTarget({ errors: [{ message: "Bad credentials" }] })).toThrow(/Bad credentials/u);
    expect(() => parseTarget(null)).toThrow(/without data/u);
  });
});
