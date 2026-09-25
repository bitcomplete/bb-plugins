import { describe, expect, it } from "vitest";
import { INVENTORY_LIMIT, readAuthoredPrs, readInventoryPrs } from "./inventory.js";
import { githubRepoFromRemote, PR_FIELDS } from "./gh.js";
import type { GhRunner, Run } from "./ghactions.js";

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
    expect(gh.calls.filter((args) => args[0] === "api")).toHaveLength(1);
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
    expect(gh.calls.filter((args) => args[0] === "api")).toHaveLength(1);
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

  it("requests follow-up evidence for written approvals and changes requested, but skips drafts", async () => {
    const gh = fake((args) => args[0] === "search" ? ok([{ url: url(1) }]) : args[0] === "pr" ? ok([
      pr(1, { latestReviews: [{ state: "APPROVED", body: "Please cover this edge case." }] }),
      pr(2, { reviewDecision: "CHANGES_REQUESTED" }), pr(3, { isDraft: true }),
    ]) : threads());
    await readAuthoredPrs(gh.run, ["inkwell"]);
    const reads = gh.calls.filter((args) => args[0] === "api");
    expect(reads).toHaveLength(2);
    expect(reads.every((args) => args.includes("includeFollowup=true"))).toBe(true);
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

  it("refuses mismatched PR identities and malformed data rather than overwriting the requested row", async () => {
    const gh = fake((args) => args[2] === "1" ? ok(pr(2)) : { ok: true, stdout: "bad json" });
    expect(await readInventoryPrs(gh.run, [url(1), url(2)])).toMatchObject({ entries: [], closed: [], failed: [url(1), url(2)] });
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
