import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import { createPrHoldStore } from "./pr-hold-store.js";
import plugin, { type Board } from "./server.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number),
  state: "OPEN", title, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", latestReviews: [],
  reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z", ...extra }]))!.pr;
/** Approved by mira at `at`, green and clean, with every merge gate the board reads passing. */
const approvedPr = (number: number, title: string, at: string, extra: Record<string, unknown> = {}): Pr => ({
  ...pr(number, title, { reviewDecision: "APPROVED", latestReviews: [{ author: { login: "mira" }, state: "APPROVED", submittedAt: at }], ...extra }),
  unresolvedReviewThreads: 0, resolvedReviewThreads: 0, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } });
const UNIT: RawUnit = { path: "/p/folio", dirName: "folio", repo: "folio", githubRepo: "inkwell/folio", branch: "main", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: null, shipped: null, changedPaths: [], observed: { status: true, pr: true } };
const cleanups: (() => Promise<void>)[] = [];
const zone = process.env.TZ;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

async function setup(prs: Pr[], settings: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p", ...settings }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan") return { units: [UNIT], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: prs.map((entry) => ({ repo: "inkwell/folio", pr: entry })),
      discoveryComplete: true, repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const attention = async () => new Map(((await harness.callRpc("board_get", null)) as Board).prInventory.entries
    .map((entry) => [entry.pr.number, entry.attention]));
  return { db: bb.storage.database(), attention, refresh: async () => expect((await harness.runCli(["refresh"])).exitCode).toBe(0) };
}

describe("PR attention on the board", () => {
  it("answers each authored PR's questions under the effort that owns it, and keeps held PRs quiet", async () => {
    const env = await setup([
      pr(313, "ABC-340 Keep shelf order on reload", { isDraft: true }),
      pr(314, "ABC-341 Group shelves by genre"),
      pr(315, "ABC-342 Sort shelves by author"),
    ]);
    // Owned through its ticket, not a PR link.
    const effort = createEffortStore(env.db).establish({ sourceKey: "ticket:ABC-340", name: "Shelf order", goal: "Keep shelves in order",
      projectId: "project-folio", coordinatorState: "none", members: { tickets: ["ABC-340"], prUrls: [] } });
    createPrHoldStore(env.db).set(url(315), true, "Waiting on the store layout review");
    const attention = await env.attention();
    expect(attention.get(313)).toMatchObject({ effort: { id: effort.id, name: "Shelf order" }, held: false,
      reasons: [{ kind: "draft-ready", action: "mark-ready", owner: "you" }] });
    expect(attention.get(314)).toMatchObject({ effort: null, held: false,
      reasons: [{ kind: "missing-reviewer", action: "request-review", owner: "you", since: Date.parse("2026-09-21T15:00:00Z") }] });
    expect(attention.get(315)).toEqual({ effort: null, held: true, reasons: [] });
  });

  it("ages each wait from GitHub's dates and the local state record, against the thresholds in settings", async () => {
    // A Wednesday afternoon: the two days before it are weekdays in every time zone the server might run in.
    const now = Date.UTC(2026, 8, 30, 15);
    vi.useFakeTimers({ toFake: ["Date"], now });
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const env = await setup([
      { ...pr(313, "ABC-340 Keep shelf order on reload", { reviewRequests: [{ login: "mira" }, { login: "otto" }] }),
        reviewRequestedAt: [{ reviewer: "mira", at: ago(2) }, { reviewer: "otto", at: ago(1) }] },
      { ...approvedPr(314, "ABC-341 Group shelves by genre", ago(1), { headRefName: "abc-341-genre" }), headCommittedAt: ago(3) },
      pr(315, "ABC-342 Sort shelves by author", { reviewRequests: [{ login: "otto" }], statusCheckRollup: [{ conclusion: "FAILURE" }] }),
      approvedPr(316, "ABC-343 Shelve sequels after the first book", ago(1), { baseRefName: "abc-341-genre" }),
    ], { nudgeAfterBusinessDays: 2 });
    let attention = await env.attention();
    // Two business days is the setting, so only mira's request is overdue.
    expect(attention.get(313)?.reasons).toMatchObject([{ kind: "review-waiting", owner: "reviewers", reviewers: ["mira"], since: Date.parse(ago(2)) }]);
    expect(attention.get(314)?.reasons).toMatchObject([{ kind: "merge-waiting", action: "merge", since: Date.parse(ago(1)), basis: "github" }]);
    // Stacked on #314, which merges first, so the merge preview would refuse it however green it looks.
    expect(attention.get(316)?.reasons).toEqual([]);
    // GitHub doesn't date red checks: the refresh that first saw them starts the clock.
    expect(attention.get(315)?.reasons).toEqual([]);
    vi.setSystemTime(now + 86_400_000);
    await env.refresh();
    attention = await env.attention();
    expect(attention.get(315)?.reasons).toMatchObject([{ kind: "ci-red", action: "open-thread", since: now, ageMs: 86_400_000, basis: "observed" }]);
  });

  it("counts business days in the server's time zone and reads each threshold from settings", async () => {
    process.env.TZ = "America/Los_Angeles";
    // Friday 22:00 in Los Angeles, already Saturday in UTC.
    const now = Date.UTC(2026, 9, 3, 5);
    vi.useFakeTimers({ toFake: ["Date"], now });
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const pending = { isDraft: true, statusCheckRollup: [{ status: "IN_PROGRESS" }] };
    const env = await setup([
      // Asked Thursday 20:00 in Los Angeles: 26 weekday hours there, but 21 in UTC, where the weekend began first.
      { ...pr(313, "ABC-340 Keep shelf order on reload", { reviewRequests: [{ login: "mira" }] }), reviewRequestedAt: [{ reviewer: "mira", at: "2026-10-02T03:00:00Z" }] },
      { ...pr(314, "ABC-341 Group shelves by genre", pending), headCommittedAt: ago(4) },
      { ...pr(315, "ABC-342 Sort shelves by author", pending), headCommittedAt: ago(5) },
      approvedPr(316, "ABC-343 Shelve sequels after the first book", ago(1)),
      approvedPr(317, "ABC-344 Shelve box sets together", ago(2)),
    ], { draftIdleDays: 5, stuckAfterDays: 2 });
    const attention = await env.attention();
    expect(attention.get(313)?.reasons).toMatchObject([{ kind: "review-waiting", reviewers: ["mira"] }]);
    // Five idle days and two stuck days are the settings, not the defaults of three and one.
    expect(attention.get(314)?.reasons).toEqual([]);
    expect(attention.get(315)?.reasons).toMatchObject([{ kind: "draft-idle" }]);
    expect(attention.get(316)?.reasons).toEqual([]);
    expect(attention.get(317)?.reasons).toMatchObject([{ kind: "merge-waiting" }]);
  });
});
