import { expect, it } from "vitest";
import { calmRowSchema } from "./board";
import { reviewerOptions, requestReview, type Github } from "./reviewers";

const row = calmRowSchema.parse({
  key: "acme/repo#7", number: 7, repo: "acme/repo", url: "https://github.com/acme/repo/pull/7", title: "Route the purchase", area: "repo", tone: 0,
  sentence: "nobody is asked to review it", blocked: null, depth: 0, after: null, reviewers: [], size: { lines: 20, files: 1, bar: 0, label: "20 lines · 1 file" },
  stack: null, action: null, gate_blocked: false, segment: "on-you", group: "one-click", move: "review", pushed_at: null, parent_key: null,
  stack_front: false, gate_links: [], review_summary: "No review", review_targets: [], waiting: [], checks: [],
});

function api(codeowners = "* @alice\n/src/ @bob # @alice") {
  const calls: string[][] = [];
  const github: Github = async (args) => {
    calls.push(args);
    if (args.includes("POST")) return "{}";
    if (args[1]?.includes("/collaborators")) return JSON.stringify([[{ login: "alice", type: "User" }, { login: "bob", type: "User" }, { login: "me", type: "User" }, { login: "robot", type: "Bot" }]]);
    if (args[1]?.includes("/files")) return JSON.stringify([[{ filename: "src/cart.ts" }]]);
    if (args[1]?.includes("/contents/")) return codeowners;
    throw new Error("Unexpected GitHub call");
  };
  return { github, calls };
}

it("suggests real eligible individual owners before reviewer load, without sending a request", async () => {
  const { github, calls } = api();
  const waiting = { ...row, segment: "on-reviewers" as const, waiting: [{ login: "bob", name: "Bob", days: 1, approx: false }] };
  const options = await reviewerOptions(github, row, "me", [waiting]);
  expect(options).toEqual({ key: row.key, note: null, candidates: [{ login: "bob", owned: true, load: 1 }, { login: "alice", owned: false, load: 0 }] });
  expect(calls.some((args) => args.includes("POST"))).toBe(false);
});

it("keeps a real picker when ownership names a team or a person who is not eligible", async () => {
  const { github } = api("* @acme/owners @outside");
  const options = await reviewerOptions(github, row, "me", []);
  expect(options.note).toContain("No eligible individual CODEOWNER");
  expect(options.candidates.map((candidate) => candidate.login)).toEqual(["alice", "bob"]);
});

it("sends only explicitly chosen eligible users, with exact GitHub arguments", async () => {
  const { github, calls } = api();
  await requestReview(github, row, ["alice", "alice"], "me", []);
  expect(calls.filter((args) => args.includes("POST"))).toEqual([
    ["api", "--method", "POST", "repos/acme/repo/pulls/7/requested_reviewers", "-f", "reviewers[]=alice"],
  ]);
});

it("refuses a stale, gated, self, or ineligible selection before any GitHub write", async () => {
  const { github, calls } = api();
  await expect(requestReview(github, { ...row, segment: "ready", group: null }, ["alice"], "me", [])).rejects.toThrow(/no longer needs/);
  await expect(requestReview(github, { ...row, blocked: "staging" }, ["alice"], "me", [])).rejects.toThrow(/no longer needs/);
  await expect(requestReview(github, row, ["me"], "me", [])).rejects.toThrow(/eligible/);
  await expect(requestReview(github, row, ["outside"], "me", [])).rejects.toThrow(/eligible/);
  expect(calls.some((args) => args.includes("POST"))).toBe(false);
});
