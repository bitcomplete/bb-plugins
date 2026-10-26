import { describe, expect, it, vi } from "vitest";
import {
  COMMENTS_SHOWN,
  DESCRIPTION_CHARS,
  LinearRequestError,
  adoptableFilter,
  dataOf,
  findLabels,
  findRelation,
  findState,
  formatIssue,
  formatIssueList,
  graphql,
  isReadOnlyDocument,
  issueFilter,
  parseAdoptablePage,
  parseCommentCreate,
  parseIssue,
  parseIssueCreate,
  parseIssueList,
  parseIssueRef,
  parseIssueUpdate,
  parseSnapshotIssue,
  parseTeam,
  parseTeams,
  parseUsers,
  parseViewer,
  pullKey,
  relationCreateInput,
  searchLimit,
  snapshotOfIssue,
} from "./linear.js";
import { entitySnapshotSchema, SNAPSHOT_COMMENT_CHARS, SNAPSHOT_COMMENTS_MAX, SNAPSHOT_DESCRIPTION_CHARS } from "./source-contract.js";

const issue = {
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Fix login",
  description: "Users cannot log in.",
  url: "https://linear.app/acme/issue/ENG-123",
  branchName: "eng-123-fix-login",
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  dueDate: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  state: { name: "In Progress", type: "started" },
  team: { key: "ENG", name: "Engineering" },
  assignee: { name: "Jane", displayName: "jane", email: "jane@acme.test" },
  creator: { name: "Bob", displayName: null },
  labels: { nodes: [{ name: "bug" }] },
  project: { name: "Auth" },
  cycle: { number: 4, name: null },
  parent: { identifier: "ENG-100", title: "Auth overhaul" },
  children: { nodes: [{ identifier: "ENG-124", title: "Add test", state: { name: "Todo" } }] },
  comments: {
    nodes: [
      { body: "second", createdAt: "2026-10-02T00:00:00.000Z", url: null, user: { displayName: "bob" } },
      { body: "first", createdAt: "2026-10-01T00:00:00.000Z", url: null, user: { name: "Jane" } },
    ],
  },
};

describe("graphql", () => {
  it("posts the document with the bearer token and returns the payload", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("https://api.example/graphql");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer at");
      expect(JSON.parse(String(init.body))).toEqual({ query: "{ viewer { id } }", variables: { a: 1 } });
      return Response.json({ data: { viewer: { id: "u" } } });
    });
    expect(await graphql("https://api.example", "at", "{ viewer { id } }", { a: 1 }, fetchImpl, new AbortController().signal)).toEqual({ data: { viewer: { id: "u" } } });
  });

  it("throws with the status on a non-2xx answer", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ errors: [{ message: "unauthorized" }] }, { status: 401 }));
    const error = await graphql("https://api.example", "at", "{ x }", undefined, fetchImpl, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).status).toBe(401);
    expect((error as Error).message).toContain("unauthorized");
  });
});

describe("dataOf", () => {
  it("names the GraphQL error when there is no data", () => {
    expect(() => dataOf({ errors: [{ message: "Entity not found" }] })).toThrow(/Entity not found/u);
    expect(() => dataOf(null)).toThrow(/without data/u);
  });
});

describe("parsing", () => {
  it("reads the viewer", () => {
    expect(parseViewer({ data: { viewer: { id: "u1", name: "Jane", displayName: "jane", email: "j@x" }, organization: { name: "Acme", urlKey: "acme" } } })).toEqual({
      user: { id: "u1", name: "jane", email: "j@x" },
      organization: { name: "Acme", urlKey: "acme" },
    });
  });

  it("reads an issue, a missing issue, and lists", () => {
    expect(parseIssue({ data: { issue } })?.identifier).toBe("ENG-123");
    expect(parseIssue({ data: { issue: null } })).toBeNull();
    expect(parseIssueList({ data: { issues: { nodes: [issue] } } }, "issues")).toHaveLength(1);
    expect(parseIssueList({ data: { searchIssues: { nodes: [] } } }, "searchIssues")).toEqual([]);
  });

  it("reads an issue ref with its team's states", () => {
    const ref = parseIssueRef({
      data: { issue: { id: "uuid-1", identifier: "ENG-123", team: { key: "ENG", states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 1 }] } } } },
    });
    expect(ref?.team.states[0].name).toBe("Todo");
    expect(findState(ref!.team.states, "todo")?.id).toBe("s1");
    expect(findState(ref!.team.states, "Done")).toBeNull();
  });

  it("reads mutation results and refuses failures", () => {
    expect(parseCommentCreate({ data: { commentCreate: { success: true, comment: { url: "https://x" } } } })).toEqual({ url: "https://x" });
    expect(() => parseCommentCreate({ data: { commentCreate: { success: false } } })).toThrow(/did not create/u);
    expect(parseIssueUpdate({ data: { issueUpdate: { success: true, issue: { identifier: "ENG-1", state: { name: "Done" } } } } })).toEqual({ identifier: "ENG-1", state: "Done", assignee: null, labels: [], priority: null });
    expect(
      parseIssueUpdate({ data: { issueUpdate: { success: true, issue: { identifier: "ENG-1", state: { name: "Todo" }, assignee: { name: "Jane Doe", displayName: "jane" }, labels: { nodes: [{ name: "Bug" }] }, priority: 2 } } } }),
    ).toEqual({ identifier: "ENG-1", state: "Todo", assignee: "jane", labels: ["Bug"], priority: 2 });
    expect(() => parseIssueUpdate({ data: { issueUpdate: { success: false, issue: null } } })).toThrow(/did not update/u);
  });
});

describe("creating", () => {
  const team = {
    id: "t-eng",
    key: "ENG",
    name: "Engineering",
    states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 0 }] },
    labels: { nodes: [{ id: "l-bug", name: "Bug" }] },
  };

  it("reads a team with its own and the workspace's labels, and a missing team", () => {
    const parsed = parseTeam({ data: { teams: { nodes: [team] }, issueLabels: { nodes: [{ id: "l-infra", name: "Infra" }] } } })!;
    expect(parsed.id).toBe("t-eng");
    expect(parsed.states.map((s) => s.name)).toEqual(["Todo"]);
    expect(parsed.labels.map((l) => l.name)).toEqual(["Bug", "Infra"]);
    expect(parseTeam({ data: { teams: { nodes: [] }, issueLabels: { nodes: [] } } })).toBeNull();
  });

  it("matches labels by name ignoring case and names the misses", () => {
    const labels = [{ id: "l-bug", name: "Bug" }, { id: "l-infra", name: "Infra" }];
    expect(findLabels(labels, ["bug", "BUG", "Infra", "perf"])).toEqual({ ids: ["l-bug", "l-infra"], missing: ["perf"] });
  });

  it("reads users with a display name and the create result", () => {
    expect(parseUsers({ data: { users: { nodes: [{ id: "u1", name: "Jane", displayName: "jane", email: "jane@acme.test", active: true }, { id: "u2", name: "Old" }] } } })).toEqual([
      { id: "u1", name: "jane", email: "jane@acme.test", active: true },
      { id: "u2", name: "Old", email: null, active: true },
    ]);
    expect(parseIssueCreate({ data: { issueCreate: { success: true, issue: { id: "uuid-124", identifier: "ENG-124", url: "https://linear.app/i/ENG-124" } } } })).toEqual({ id: "uuid-124", identifier: "ENG-124", url: "https://linear.app/i/ENG-124" });
    expect(() => parseIssueCreate({ data: { issueCreate: { success: false, issue: null } } })).toThrow("did not create");
  });
});

describe("issueFilter", () => {
  it("is undefined with nothing to filter by", () => {
    expect(issueFilter({})).toBeUndefined();
    expect(issueFilter({ team: "  " })).toBeUndefined();
  });

  it("builds one clause or an and of several", () => {
    expect(issueFilter({ team: "eng" })).toEqual({ team: { key: { eq: "ENG" } } });
    expect(issueFilter({ team: "ENG", state: "Done" })).toEqual({ and: [{ team: { key: { eq: "ENG" } } }, { state: { name: { eqIgnoreCase: "Done" } } }] });
  });

  it("leaves out closed issues only when no state is named", () => {
    expect(issueFilter({ openOnly: true })).toEqual({ state: { type: { nin: ["completed", "canceled"] } } });
    expect(issueFilter({ openOnly: true, state: "Done" })).toEqual({ state: { name: { eqIgnoreCase: "Done" } } });
  });

  it("understands me and a person", () => {
    expect(issueFilter({ assignee: "ME" })).toEqual({ assignee: { isMe: { eq: true } } });
    expect(issueFilter({ assignee: "jane" })).toEqual({
      assignee: { or: [{ displayName: { containsIgnoreCase: "jane" } }, { name: { containsIgnoreCase: "jane" } }, { email: { eqIgnoreCase: "jane" } }] },
    });
  });

  it("clamps the limit", () => {
    expect(searchLimit(undefined)).toBe(20);
    expect(searchLimit(0)).toBe(1);
    expect(searchLimit(500)).toBe(50);
    expect(searchLimit(7.9)).toBe(7);
  });
});

describe("isReadOnlyDocument", () => {
  it("accepts queries and anonymous selections", () => {
    expect(isReadOnlyDocument("query { viewer { id } }")).toBe(true);
    expect(isReadOnlyDocument("  { teams { nodes { key } } }")).toBe(true);
    expect(isReadOnlyDocument("# comment\nquery Q($a: Int) { x }")).toBe(true);
  });

  it("refuses mutations, subscriptions and empty documents", () => {
    expect(isReadOnlyDocument("mutation { issueUpdate(id: \"x\", input: {}) { success } }")).toBe(false);
    expect(isReadOnlyDocument("query { x } mutation { y }")).toBe(false);
    expect(isReadOnlyDocument("subscription { x }")).toBe(false);
    expect(isReadOnlyDocument("# query\nmutation { x }")).toBe(false);
    expect(isReadOnlyDocument("")).toBe(false);
    expect(isReadOnlyDocument("fragment F on Issue { id }")).toBe(false);
  });
});

describe("formatting", () => {
  it("writes the whole issue with comments oldest first", () => {
    const text = formatIssue(parseIssue({ data: { issue } })!);
    expect(text).toContain("# ENG-123: Fix login");
    expect(text).toContain("State: In Progress (started)");
    expect(text).toContain("Assignee: jane");
    expect(text).toContain("Creator: Bob");
    expect(text).toContain("Priority: High");
    expect(text).toContain("Labels: bug");
    expect(text).toContain("Parent: ENG-100: Auth overhaul");
    expect(text).toContain("- ENG-124 Add test [Todo]");
    expect(text).toContain("Users cannot log in.");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).toContain("## Comments (2)");
  });

  it("clips long descriptions and shows only the latest comments", () => {
    const long = { ...issue, description: "x".repeat(DESCRIPTION_CHARS + 10), comments: { nodes: Array.from({ length: 30 }, (_, i) => ({ body: `c${i}`, createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, user: null })) } };
    const text = formatIssue(parseIssue({ data: { issue: long } })!);
    expect(text).toContain("… (10 more characters)");
    expect(text).toContain(`## Comments (30, last ${COMMENTS_SHOWN} shown)`);
    expect(text).not.toContain("\nc0\n");
    expect(text).toContain("c29");
  });

  it("writes lists one line per issue", () => {
    const list = formatIssueList([parseIssue({ data: { issue } })!], "Linear issues");
    expect(list).toBe("Linear issues (1):\n- ENG-123 Fix login [In Progress, @jane, High]");
    expect(formatIssueList([], "Linear issues")).toBe("Linear issues: no issues.");
  });

  it("writes relations and inverse relations, and nothing when there are none", () => {
    const withRelations = {
      ...issue,
      children: { nodes: [{ identifier: "ENG-124", title: "Add test", state: { name: "Todo" } }] },
      relations: { nodes: [{ id: "r1", type: "blocks", relatedIssue: { identifier: "ENG-72", state: { name: "Todo" } } }, { id: "r2", type: "duplicate", relatedIssue: { identifier: "ENG-74", state: null } }] },
      inverseRelations: { nodes: [{ id: "r3", type: "blocks", issue: { identifier: "ENG-71", state: { name: "Backlog" } } }] },
    };
    const text = formatIssue(parseIssue({ data: { issue: withRelations } })!);
    expect(text).toContain("Relations:\n- Blocks ENG-72 (Todo)\n- Duplicate of ENG-74\n- Blocked by ENG-71 (Backlog)");
    expect(text.indexOf("Sub-issues:")).toBeLessThan(text.indexOf("Relations:"));
    expect(text.indexOf("Relations:")).toBeLessThan(text.indexOf("## Description"));
    expect(formatIssue(parseIssue({ data: { issue } })!)).not.toContain("Relations:");
  });
});

describe("relations", () => {
  it("maps a requested relation onto issueRelationCreate", () => {
    expect(relationCreateInput({ type: "blockedBy", issueId: "uuid-71" }, "uuid-1")).toEqual({ issueId: "uuid-71", relatedIssueId: "uuid-1", type: "blocks" });
    expect(relationCreateInput({ type: "blocks", issueId: "uuid-72" }, "uuid-1")).toEqual({ issueId: "uuid-1", relatedIssueId: "uuid-72", type: "blocks" });
    expect(relationCreateInput({ type: "related", issueId: "uuid-73" }, "uuid-1")).toEqual({ issueId: "uuid-1", relatedIssueId: "uuid-73", type: "related" });
    expect(relationCreateInput({ type: "duplicate", issueId: "uuid-74" }, "uuid-1")).toEqual({ issueId: "uuid-1", relatedIssueId: "uuid-74", type: "duplicate" });
  });

  it("finds an existing relation in either direction", () => {
    const existing = [
      { id: "rel-blocks", type: "blocks", issue: "ENG-123", relatedIssue: "ENG-71" },
      { id: "rel-blocked", type: "blocks", issue: "ENG-70", relatedIssue: "ENG-123" },
      { id: "rel-related", type: "related", issue: "ENG-123", relatedIssue: "ENG-73" },
      { id: "rel-duplicate", type: "duplicate", issue: "ENG-123", relatedIssue: "ENG-74" },
      { id: "rel-dupby", type: "duplicate", issue: "ENG-75", relatedIssue: "ENG-123" },
    ];
    expect(findRelation(existing, { type: "blocks", issue: "ENG-71" })?.id).toBe("rel-blocks");
    expect(findRelation(existing, { type: "blockedBy", issue: "ENG-70" })?.id).toBe("rel-blocked");
    expect(findRelation(existing, { type: "related", issue: "ENG-73" })?.id).toBe("rel-related");
    expect(findRelation(existing, { type: "duplicate", issue: "ENG-74" })?.id).toBe("rel-duplicate");
    expect(findRelation(existing, { type: "duplicate", issue: "ENG-75" })?.id).toBe("rel-dupby");
    expect(findRelation(existing, { type: "blocks", issue: "ENG-70" })).toBeNull();
    expect(findRelation(existing, { type: "blockedBy", issue: "ENG-71" })).toBeNull();
  });
});

describe("what stewards reads", () => {
  const raw = {
    id: "uuid-1",
    identifier: "ENG-123",
    title: "Fix login",
    description: "Users cannot log in.",
    url: "https://linear.app/acme/issue/ENG-123",
    priority: 2,
    priorityLabel: "High",
    estimate: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    team: { id: "team-uuid", key: "ENG" },
    assignee: { name: "Jane Doe", displayName: "jane" },
    creator: { name: "Bob" },
    labels: { nodes: [{ name: "bb-managed" }, { name: "bug" }] },
    parent: { id: "uuid-100", identifier: "ENG-100" },
    children: { nodes: [{ id: "uuid-124", identifier: "ENG-124", title: "Add test", state: { name: "Todo", type: "unstarted" }, labels: { nodes: [{ name: "bb-managed" }] } }] },
    comments: {
      nodes: [
        { id: "c-2", body: "On it.\n\n_— from bb thread thr_abc_", createdAt: "2026-10-01T02:00:00Z", url: "https://linear.app/c/2", user: { displayName: "jane" } },
        { id: "c-1", body: "Repro?", createdAt: "2026-10-01T01:00:00Z", url: null, user: null },
      ],
    },
    attachments: {
      nodes: [
        { url: "https://github.com/Acme/web/pull/42", sourceType: "github" },
        { url: "https://github.com/Acme/web/pull/42", sourceType: "github" },
        { url: "https://github.com/acme/web/issues/7", sourceType: "github" },
        { url: "https://sentry.io/x", sourceType: "sentry" },
      ],
    },
  };

  it("maps an issue to the contract's snapshot", () => {
    const snapshot = snapshotOfIssue(parseSnapshotIssue({ data: { issue: raw } })!, "jane");
    expect(entitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toEqual({
      source: "linear",
      kind: "issue",
      id: "uuid-1",
      key: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Fix login",
      state: "In Progress",
      stateType: "started",
      unit: "ENG",
      labels: ["bb-managed", "bug"],
      author: "Bob",
      assignees: ["jane"],
      priority: "High",
      estimate: 3,
      description: "Users cannot log in.",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      comments: [
        { id: "c-1", author: "someone", did: "commented", body: "Repro?", createdAt: "2026-10-01T01:00:00Z", url: null, signedBy: null },
        { id: "c-2", author: "jane", did: "commented", body: "On it.\n\n_— from bb thread thr_abc_", createdAt: "2026-10-01T02:00:00Z", url: "https://linear.app/c/2", signedBy: "thr_abc" },
      ],
      parent: { id: "uuid-100", key: "ENG-100" },
      children: [{ id: "uuid-124", key: "ENG-124", title: "Add test", state: "Todo", stateType: "unstarted", labels: ["bb-managed"] }],
      linkedPulls: [{ url: "https://github.com/Acme/web/pull/42", key: "Acme/web#42" }],
      pull: null,
      viewer: "jane",
    });
    expect(parseSnapshotIssue({ data: { issue: null } })).toBeNull();
  });

  it("clips long bodies after reading their signature, and keeps the newest comments", () => {
    const long = {
      ...raw,
      description: "d".repeat(SNAPSHOT_DESCRIPTION_CHARS + 5),
      assignee: null,
      comments: {
        nodes: Array.from({ length: SNAPSHOT_COMMENTS_MAX + 5 }, (_, i) => ({
          id: `c-${i}`,
          body: i === SNAPSHOT_COMMENTS_MAX + 4 ? `${"x".repeat(SNAPSHOT_COMMENT_CHARS + 10)}\n\n_— from bb thread thr_long_` : `c${i}`,
          createdAt: `2026-10-01T00:${String(i).padStart(2, "0")}:00Z`,
          url: null,
          user: null,
        })),
      },
    };
    const snapshot = snapshotOfIssue(parseSnapshotIssue({ data: { issue: long } })!, null);
    expect(snapshot.assignees).toEqual([]);
    expect(snapshot.description).toContain("… (5 more characters)");
    expect(snapshot.comments).toHaveLength(SNAPSHOT_COMMENTS_MAX);
    expect(snapshot.comments[0]!.id).toBe("c-5");
    const last = snapshot.comments.at(-1)!;
    expect(last.body).not.toContain("thr_long");
    expect(last.signedBy).toBe("thr_long");
  });

  it("names GitHub pull requests by owner/repo#n and nothing else", () => {
    expect(pullKey("https://github.com/acme/web/pull/42")).toBe("acme/web#42");
    expect(pullKey("https://github.com/acme/web.js/pull/42/files")).toBe("acme/web.js#42");
    expect(pullKey("https://github.com/acme/web/pull/42#discussion")).toBe("acme/web#42");
    expect(pullKey("https://github.com/acme/web/pulls")).toBeNull();
    expect(pullKey("https://gitlab.com/acme/web/pull/42")).toBeNull();
  });

  it("reads team lists from teams and from the viewer", () => {
    const nodes = { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: null }] };
    const expected = [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "OPS" }];
    expect(parseTeams({ data: { teams: nodes } })).toEqual(expected);
    expect(parseTeams({ data: { viewer: { teams: nodes } } })).toEqual(expected);
  });

  it("filters adoptable issues by team, label and open state, and reads them a page at a time", () => {
    expect(adoptableFilter("ENG", "bb-managed")).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { some: { name: { eqIgnoreCase: "bb-managed" } } },
      state: { type: { nin: ["completed", "canceled"] } },
    });
    const node = { id: "uuid-1", identifier: "ENG-1", createdAt: "2026-10-01T00:00:00Z", state: { name: "Todo" }, team: { key: "ENG" }, creator: { displayName: "bob" }, labels: { nodes: [{ name: "bb-managed" }] } };
    expect(parseAdoptablePage({ data: { issues: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: "cur" } } } })).toEqual({
      entities: [{ id: "uuid-1", key: "ENG-1", unit: "ENG", kind: "issue", state: "Todo", labels: ["bb-managed"], author: "bob", draft: false, createdAt: "2026-10-01T00:00:00Z" }],
      next: "cur",
    });
    expect(parseAdoptablePage({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }).next).toBeNull();
  });
});
