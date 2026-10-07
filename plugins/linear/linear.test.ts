import { describe, expect, it, vi } from "vitest";
import {
  COMMENTS_SHOWN,
  DESCRIPTION_CHARS,
  LinearRequestError,
  dataOf,
  findLabels,
  findState,
  formatIssue,
  formatIssueList,
  graphql,
  isReadOnlyDocument,
  issueFilter,
  parseCommentCreate,
  parseIssue,
  parseIssueCreate,
  parseIssueList,
  parseIssueRef,
  parseIssueUpdate,
  parseTeam,
  parseUsers,
  parseViewer,
  searchLimit,
} from "./linear.js";

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
    expect(parseIssueCreate({ data: { issueCreate: { success: true, issue: { identifier: "ENG-124", url: "https://linear.app/i/ENG-124" } } } })).toEqual({ identifier: "ENG-124", url: "https://linear.app/i/ENG-124" });
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
});
