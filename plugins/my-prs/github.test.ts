import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubClient, githubTransport, GithubRateLimitError, type Transport } from "./github.js";
import { comment, fixture, page, transportFor } from "./fixtures.js";

describe("GitHub reads", () => {
  it("paginates feedback before classifying, including nested thread comments", async () => {
    const data = [fixture()]; const base = transportFor(() => data); const seen: string[] = [];
    const transport: Transport = async (query, variables, signal) => {
      if (query.includes("viewer { login }") && variables.id) {
        seen.push("first");
        return { viewer: { login: "me" }, node: { ...data[0]?.pr, state: "OPEN",
          reviews: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "review-page-2" } },
          comments: page([]), reviewRequests: page([]),
          reviewThreads: page([{ id: "T1", isResolved: false,
            comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "thread-page-2" } } }]),
        } };
      }
      if (query.includes("reviews(")) {
        seen.push(variables.after ?? "first");
        return { node: { reviews: page(data[0]?.reviews ?? []) } };
      }
      if (variables.id === "T1") {
        expect(variables.after).toBe("thread-page-2");
        return { node: { comments: page([comment()]) } };
      }
      return base(query, variables, signal);
    };
    const result = await createGithubClient(transport).fetchMyPrs([]);
    expect(seen).toEqual(["first", "review-page-2"]);
    expect(result.prs[0]?.turn?.why).toContain("1 open thread");
  });
  it("refuses a truncated search or repeating pagination cursor", async () => {
    const truncated: Transport = async (query) => query.includes("{ viewer {") ? { viewer: { login: "me" } } : { search: { ...page([]), issueCount: 1001 } };
    await expect(createGithubClient(truncated).fetchMyPrs([])).rejects.toThrow("1,000");
    const repeat: Transport = async (query) => query.includes("{ viewer {") ? { viewer: { login: "me" } } : { search: { nodes: [], issueCount: 1, pageInfo: { hasNextPage: true, endCursor: "same" } } };
    await expect(createGithubClient(repeat).fetchMyPrs([])).rejects.toThrow("did not advance");
  });
  it("filters repository allowlists case insensitively before reading feedback", async () => {
    const result = await createGithubClient(transportFor(() => [fixture()])).fetchMyPrs(["EXAMPLE/EDITOR"]);
    expect(result.prs).toHaveLength(1);
    expect((await createGithubClient(transportFor(() => [fixture()])).fetchMyPrs(["other/repo"])).prs).toEqual([]);
  });
});


afterEach(() => vi.unstubAllGlobals());

it("reads a normal PR's feedback in two calls, including the final head check", async () => {
  const base = transportFor(() => [fixture()]);
  const transport = vi.fn(base);
  expect((await createGithubClient(transport).fetchPullRequest("PR_1", []))?.turn).not.toBeNull();
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.every(([query]) => !query.includes("search("))).toBe(true);
});

it("reports GitHub's reset time from HTTP-200 GraphQL rate limit errors", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "API rate limit exceeded" }] }), {
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
  })));
  const result = githubTransport("test-token")("query { viewer { login } }", {});
  await expect(result).rejects.toBeInstanceOf(GithubRateLimitError);
  await expect(result).rejects.toMatchObject({ retryAt: new Date(reset * 1000).toISOString() });
});

it("accepts the last successful response and honors secondary-limit retry-after", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { value: 1 } }), {
    headers: { "x-ratelimit-remaining": "0" },
  })).mockResolvedValueOnce(new Response(JSON.stringify({ message: "secondary rate limit" }), {
    status: 403, headers: { "retry-after": "120" },
  }));
  vi.stubGlobal("fetch", fetcher);
  expect(await githubTransport("test-token")("query", {})).toEqual({ value: 1 });
  const before = Date.now();
  try { await githubTransport("test-token")("query", {}); throw new Error("Expected rate limit"); }
  catch (cause) {
    expect(cause).toBeInstanceOf(GithubRateLimitError);
    if (cause instanceof GithubRateLimitError) expect(Date.parse(cause.retryAt)).toBeGreaterThanOrEqual(before + 120_000);
  }
});
