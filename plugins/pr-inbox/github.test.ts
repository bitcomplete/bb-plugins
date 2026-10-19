import { describe, expect, it } from "vitest";
import { createGithubClient, type Transport } from "./github.js";
import { comment, fixture, page, transportFor } from "./fixtures.js";

describe("GitHub reads", () => {
  it("paginates feedback before classifying, including nested thread comments", async () => {
    const data = [fixture()]; const base = transportFor(() => data); const seen: string[] = [];
    const transport: Transport = async (query, variables, signal) => {
      if (query.includes("reviews(")) {
        seen.push(variables.after ?? "first");
        return { node: { reviews: variables.after ? page(data[0]?.reviews ?? []) : { nodes: [], pageInfo: { hasNextPage: true, endCursor: "review-page-2" } } } };
      }
      if (query.includes("reviewThreads(")) return { node: { reviewThreads: page([{ id: "T1", isResolved: false,
        comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "thread-page-2" } } }]) } };
      if (variables.id === "T1") return { node: { comments: page([comment()]) } };
      return base(query, variables, signal);
    };
    const result = await createGithubClient(transport).fetchInbox([]);
    expect(seen).toEqual(["first", "review-page-2"]);
    expect(result.prs[0]?.turn?.why).toContain("1 open thread");
  });
  it("refuses a truncated search or repeating pagination cursor", async () => {
    const truncated: Transport = async (query) => query.includes("{ viewer {") ? { viewer: { login: "me" } } : { search: { ...page([]), issueCount: 1001 } };
    await expect(createGithubClient(truncated).fetchInbox([])).rejects.toThrow("1,000");
    const repeat: Transport = async (query) => query.includes("{ viewer {") ? { viewer: { login: "me" } } : { search: { nodes: [], issueCount: 1, pageInfo: { hasNextPage: true, endCursor: "same" } } };
    await expect(createGithubClient(repeat).fetchInbox([])).rejects.toThrow("did not advance");
  });
  it("filters repository allowlists case insensitively before reading feedback", async () => {
    const result = await createGithubClient(transportFor(() => [fixture()])).fetchInbox(["EXAMPLE/EDITOR"]);
    expect(result.prs).toHaveLength(1);
    expect((await createGithubClient(transportFor(() => [fixture()])).fetchInbox(["other/repo"])).prs).toEqual([]);
  });
});
