import { describe, expect, it } from "vitest";
import { parseDependabotAlerts, parseDeploymentStatus, parseDeployments, parseOpenPulls, parseRef, parseRefKey, parseRepo, parseRepoCheck, parseSnapshot, parseTarget, refKey, TARGET_QUERY } from "./github.js";
import { entitySnapshotSchema, SNAPSHOT_COMMENT_CHARS, SNAPSHOT_COMMENTS_MAX, SNAPSHOT_DESCRIPTION_CHARS } from "./source-contract.js";

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
    expect(parseRepo(" Acme/Widgets ")).toEqual({ owner: "Acme", name: "Widgets" });
    for (const input of ["Acme", "Acme/Widgets#1", "a/b/c", ""]) expect(parseRepo(input), input).toBeNull();
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

describe("parseSnapshot", () => {
  it("maps a pull request onto the contract: state words, every review with its commit, ids, signatures, the head's author and the viewer", () => {
    const payload = pull({
      body: "Adds widgets.",
      comments: { nodes: [{ id: "IC_1", author: { login: "bob" }, body: "Looks fine\n\n_— from bb thread thr-7_", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/1" }] },
      reviews: {
        nodes: [
          { id: "PRR_1", author: { login: "bob" }, state: "COMMENTED", body: "", createdAt: "2026-10-09T08:00:00Z", submittedAt: "2026-10-09T08:30:00Z", url: "https://github.com/r/1", commit: { oid: "aaaa" }, comments: { nodes: [{ id: "RC_1", author: { login: "bob" }, body: "nit", createdAt: "2026-10-09T08:10:00Z", url: "https://github.com/rc/1", path: "src/a.ts" }] } },
          { id: "PRR_2", author: { login: "carol" }, state: "APPROVED", body: "", createdAt: "2026-10-09T10:00:00Z", submittedAt: "2026-10-09T10:00:00Z", url: "https://github.com/r/2", commit: { oid: "bbbb" }, comments: { nodes: [] } },
          { id: "PRR_3", author: { login: "jane" }, state: "PENDING", body: "draft", createdAt: "2026-10-09T11:00:00Z", submittedAt: null, url: null, commit: null, comments: { nodes: [] } },
        ],
      },
    });
    (payload.data.repository.issueOrPullRequest.commits.nodes[0]!.commit as Record<string, unknown>).author = { user: { login: "jane" } };
    const s = parseSnapshot({ data: { viewer: { login: "dev" }, ...payload.data } })!;
    expect(entitySnapshotSchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({
      source: "github",
      kind: "pull",
      id: "Acme/Widgets#12",
      key: "Acme/Widgets#12",
      unit: "Acme/Widgets",
      state: "open",
      stateType: null,
      labels: ["backend", "feature"],
      author: "jane",
      assignees: ["jane"],
      priority: null,
      estimate: null,
      description: "Adds widgets.",
      parent: null,
      children: [],
      linkedPulls: [],
      viewer: "dev",
    });
    expect(s.comments).toEqual([
      { id: "RC_1", author: "bob", did: "commented on src/a.ts", body: "nit", createdAt: "2026-10-09T08:10:00Z", url: "https://github.com/rc/1", signedBy: null },
      { id: "IC_1", author: "bob", did: "commented", body: "Looks fine\n\n_— from bb thread thr-7_", createdAt: "2026-10-09T09:00:00Z", url: "https://github.com/c/1", signedBy: "thr-7" },
      { id: "PRR_2", author: "carol", did: "approved", body: "", createdAt: "2026-10-09T10:00:00Z", url: "https://github.com/r/2", signedBy: null },
    ]);
    expect(s.pull).toEqual({
      draft: false,
      merged: false,
      base: "main",
      head: "feature/widgets",
      headSha: "0123456789abcdef",
      headAuthor: "jane",
      reviewDecision: "review required",
      requestedReviewers: ["backend", "carol"],
      reviews: [
        { author: "bob", state: "commented", submittedAt: "2026-10-09T08:30:00Z", commit: "aaaa" },
        { author: "carol", state: "approved", submittedAt: "2026-10-09T10:00:00Z", commit: "bbbb" },
      ],
      checks: { state: "failure", failing: ["ci/deploy (https://ci/deploy)", "test (https://ci/test)"] },
    });
    expect(TARGET_QUERY).toContain("viewer { login }");
  });

  it("words the state as a playbook keys on it: draft, merged, closed; an issue is open or closed", () => {
    expect(parseSnapshot(pull({ isDraft: true }))!.state).toBe("draft");
    expect(parseSnapshot(pull({ isDraft: true }))!.pull!.draft).toBe(true);
    expect(parseSnapshot(pull({ state: "MERGED", merged: true }))!).toMatchObject({ state: "merged", pull: { merged: true } });
    expect(parseSnapshot(pull({ state: "CLOSED", isDraft: true }))!.state).toBe("closed");
    const changes = parseSnapshot(pull({ reviews: { nodes: [{ author: { login: "carol" }, state: "CHANGES_REQUESTED", body: "no", createdAt: "2026-10-09T12:00:00Z", submittedAt: null, url: null, comments: { nodes: [] } }] } }))!;
    // Without a node id or URL a comment is still named, by who and when.
    expect(changes.comments.at(-1)!.id).toBe("carol@2026-10-09T12:00:00Z");
    expect(changes.pull!.reviews).toEqual([{ author: "carol", state: "changes requested", submittedAt: "2026-10-09T12:00:00Z", commit: null }]);
    const issue = parseSnapshot({ data: { repository: { nameWithOwner: "Acme/Widgets", issueOrPullRequest: { __typename: "Issue", number: 3, title: "Bug", body: null, state: "CLOSED", stateReason: "COMPLETED", comments: { nodes: [] } } } } })!;
    expect(issue).toMatchObject({ kind: "issue", key: "Acme/Widgets#3", state: "closed", description: null, pull: null, viewer: null });
    expect(parseSnapshot({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] })).toBeNull();
  });

  it("bounds what crosses: the newest comments, clipped bodies (signed before clipping), a clipped description", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `IC_${i}`, author: { login: "bob" }, body: i === 59 ? `${"x".repeat(SNAPSHOT_COMMENT_CHARS + 10)}\n\n_— from bb thread thr-1_` : `c${i}`, createdAt: `2026-10-09T09:${String(i).padStart(2, "0")}:00Z`, url: null }));
    const s = parseSnapshot(pull({ body: "d".repeat(SNAPSHOT_DESCRIPTION_CHARS + 5), comments: { nodes: many }, reviews: { nodes: [] } }))!;
    expect(s.comments).toHaveLength(SNAPSHOT_COMMENTS_MAX);
    expect(s.comments[0]!.id).toBe("IC_10");
    const last = s.comments.at(-1)!;
    expect(last.signedBy).toBe("thr-1");
    expect(last.body.startsWith("x".repeat(SNAPSHOT_COMMENT_CHARS))).toBe(true);
    expect(last.body).toContain("more characters");
    expect(s.description!.length).toBeLessThan(SNAPSHOT_DESCRIPTION_CHARS + 40);
    expect(s.description).toContain("(5 more characters)");
  });
});

describe("repositories", () => {
  it("checks a repository and its label; not there is found false, anything else throws", () => {
    expect(parseRepoCheck({ data: { viewer: { login: "dev" }, repository: { nameWithOwner: "Acme/Widgets", label: { name: "bb-managed" } } } })).toEqual({ viewer: "dev", found: true, labelFound: true });
    expect(parseRepoCheck({ data: { viewer: { login: "dev" }, repository: { nameWithOwner: "Acme/Widgets", label: null } } })).toEqual({ viewer: "dev", found: true, labelFound: false });
    expect(parseRepoCheck({ data: { viewer: { login: "dev" }, repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] })).toEqual({ viewer: "dev", found: false, labelFound: false });
    expect(() => parseRepoCheck({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })).toThrow(/rate limit/u);
  });

  it("reads a page of open pull requests named as doorbells name them, with the next cursor", () => {
    const page = (hasNextPage: boolean) => ({
      data: {
        viewer: { login: "dev" },
        repository: {
          nameWithOwner: "Acme/Widgets",
          pullRequests: { pageInfo: { hasNextPage, endCursor: "Y3Vy" }, nodes: [{ number: 4, isDraft: true, createdAt: "2026-10-01T00:00:00Z", author: { login: "jane" }, labels: { nodes: [{ name: "b" }, { name: "a" }] } }] },
        },
      },
    });
    expect(parseOpenPulls(page(true))).toEqual({
      viewer: "dev",
      entities: [{ id: "Acme/Widgets#4", key: "Acme/Widgets#4", unit: "Acme/Widgets", kind: "pull", state: "draft", labels: ["a", "b"], author: "jane", draft: true, createdAt: "2026-10-01T00:00:00Z" }],
      next: "Y3Vy",
    });
    expect(parseOpenPulls(page(false))!.next).toBeNull();
    expect(parseOpenPulls({ data: { viewer: { login: "dev" }, repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] })).toBeNull();
  });
});

describe("Dependabot alerts", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    number: 4,
    state: "open",
    dependency: { package: { ecosystem: "npm", name: "lodash" }, manifest_path: "package-lock.json" },
    security_advisory: { ghsa_id: "GHSA-xxxx-yyyy-zzzz", severity: "high", summary: "Prototype pollution" },
    security_vulnerability: { severity: "high", first_patched_version: { identifier: "4.17.21" } },
    html_url: "https://github.com/Acme/Widgets/security/dependabot/4",
    url: "https://api.github.com/repos/Acme/Widgets/dependabot/alerts/4",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    ...over,
  });

  it("reads a page as the shared contract wants it, with the alert's own number", () => {
    expect(parseDependabotAlerts([node()], "Acme/Widgets")).toEqual([
      {
        id: "Acme/Widgets#4",
        repo: "Acme/Widgets",
        number: 4,
        severity: "high",
        package: "lodash",
        ecosystem: "npm",
        manifestPath: "package-lock.json",
        state: "open",
        ghsaId: "GHSA-xxxx-yyyy-zzzz",
        fixedVersion: "4.17.21",
        summary: "Prototype pollution",
        url: "https://github.com/Acme/Widgets/security/dependabot/4",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ]);
  });

  it("falls back to the vulnerability's severity, and to low for anything unexpected, and tolerates a bare alert", () => {
    const bare = parseDependabotAlerts([node({ dependency: null, security_advisory: null, security_vulnerability: { severity: "medium", first_patched_version: null } })], "Acme/Widgets")[0]!;
    expect(bare).toMatchObject({ severity: "medium", package: "(unknown)", ecosystem: "unknown", ghsaId: null, fixedVersion: null });
    expect(parseDependabotAlerts([node({ security_advisory: { severity: "banana" } })], "Acme/Widgets")[0]!.severity).toBe("low");
  });

  it("throws on anything that is not an alert list", () => {
    expect(() => parseDependabotAlerts({ message: "Not Found" }, "Acme/Widgets")).toThrow(/Dependabot alert list/u);
  });
});

describe("deployments", () => {
  const node = (over: Record<string, unknown> = {}) => ({ id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", url: "https://github.com/Acme/Widgets/actions/runs/9", ...over });

  it("reads a page newest first, tolerating a bare deployment", () => {
    expect(parseDeployments([node({ id: 6 }), node({ id: 7 })])).toEqual([
      { id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", url: "https://github.com/Acme/Widgets/actions/runs/9" },
      { id: 6, environment: "production", ref: "main", sha: "bbbbbbb2", url: "https://github.com/Acme/Widgets/actions/runs/9" },
    ]);
    expect(parseDeployments([node({ environment: null, ref: null, sha: null, url: null })])[0]).toEqual({ id: 7, environment: "", ref: "", sha: "", url: null });
  });

  it("throws on anything that is not a deployment list", () => {
    expect(() => parseDeployments({ message: "Not Found" })).toThrow(/deployment list/u);
  });

  it("reads the newest status, or an empty state when none has been reported", () => {
    expect(parseDeploymentStatus([{ state: "success" }, { state: "in_progress" }])).toBe("success");
    expect(parseDeploymentStatus([])).toBe("");
    expect(() => parseDeploymentStatus({ message: "Not Found" })).toThrow(/deployment status list/u);
  });
});
