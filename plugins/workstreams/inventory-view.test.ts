import { describe, expect, it } from "vitest";
import type { Pr } from "./contract.js";
import { parsePrList } from "./gh.js";
import { inventoryRow, inventoryText, inventoryView, type InventoryRowInput, type ThreadRef } from "./inventory-view.js";
import type { AttentionReason } from "./pr-attention.js";
import type { ResolvedThreadLink } from "./work-context.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN",
  title: `ABC-${number} Keep shelf order on reload`, isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "a".repeat(40), ...extra }]))!.pr;
const reason = (question: AttentionReason["question"], extra: Partial<AttentionReason> = {}): AttentionReason => ({ question,
  kind: question === "forgotten-draft" ? "draft-ready" : question === "missing-reviewer" ? "missing-reviewer" : "review-waiting",
  action: question === "forgotten-draft" ? "mark-ready" : question === "missing-reviewer" ? "request-review" : "nudge",
  nextStep: question === "forgotten-draft" ? "Mark ready for review" : question === "missing-reviewer" ? "Request a review" : "Nudge @mira",
  owner: question === "needs-nudge" ? "reviewers" : "you", reviewers: question === "needs-nudge" ? ["mira"] : [], since: 0, ageMs: 0, basis: "github", ...extra });
const link = (threadId: string, sources: ResolvedThreadLink["sources"], tier: ResolvedThreadLink["tier"] = "started"): ResolvedThreadLink =>
  ({ prUrl: url(1), threadId, role: "pr", title: threadId, tier, direct: true, sources });
const threads = new Map<string, ThreadRef>([
  ["thr-origin", { title: "Plan shelf order", titleFallback: null, status: "idle", updatedAt: 1 }],
  ["thr-legacy-old", { title: "Advance worker", titleFallback: null, status: "idle", updatedAt: 5 }],
  ["thr-legacy-busy", { title: "Advance worker", titleFallback: null, status: "active", updatedAt: 2 }],
]);
const input = (number: number, extra: Partial<InventoryRowInput> = {}): InventoryRowInput => ({ prUrl: url(number), pr: pr(number), authored: true, stale: false,
  reasons: [], hold: null, observation: { checkedAt: "2026-09-28T21:00:00.000Z", failedAt: null, error: null },
  stackedOn: null, links: [], threads, suggestedReviewers: [], lastAction: null, ...extra });
const META = { checkedAt: "2026-09-28T21:00:00.000Z", attemptedAt: "2026-09-28T21:00:00.000Z", refreshing: false, rateLimitedUntil: null, warnings: [] };
const shelf = { id: "effort-shelf", name: "Shelf order" }, atlas = { id: "effort-atlas", name: "Atlas maps" };

describe("the PR inventory", () => {
  it("groups rows under the effort that owns them with No effort last, and counts each question over every row even when filtered", () => {
    const rows = [
      { effort: null, ...inventoryRow(input(3, { reasons: [reason("forgotten-draft")] })) },
      { effort: shelf, ...inventoryRow(input(2, { reasons: [reason("missing-reviewer")] })) },
      { effort: atlas, ...inventoryRow(input(4, { reasons: [reason("needs-nudge"), reason("needs-nudge", { kind: "ci-red" })] })) },
      { effort: shelf, ...inventoryRow(input(1)) },
    ];
    const all = inventoryView(rows, META);
    expect(all.groups.map((group) => [group.effort?.name ?? null, group.rows.map((row) => row.number)])).toEqual([
      ["Atlas maps", [4]], ["Shelf order", [1, 2]], [null, [3]]]);
    // A PR with two nudge reasons is one PR needing a nudge.
    expect(all.counts).toEqual({ "forgotten-draft": 1, "missing-reviewer": 1, "needs-nudge": 1 });
    const drafts = inventoryView(rows, META, "forgotten-draft");
    expect(drafts.groups.map((group) => group.rows.map((row) => row.number))).toEqual([[3]]);
    expect(drafts.counts).toEqual(all.counts);
  });

  it("names the thread the work started in, and the one working on it: a busy legacy worker over a newer idle one", () => {
    const links = [link("thr-legacy-old", ["advance"]), link("thr-legacy-busy", ["advance"]), link("thr-origin", ["cluster"]), link("thr-gone", ["metadata"])];
    expect(inventoryRow(input(1, { links })).threads).toEqual({ origin: { id: "thr-origin", title: "Plan shelf order", active: false },
      executor: { id: "thr-legacy-busy", title: "Advance worker", active: true } });
    // A thread linked only by its path isn't where the work started, and a thread BB no longer lists is no one's.
    expect(inventoryRow(input(1, { links: [link("thr-origin", ["cluster"], "paths"), link("thr-gone", ["advance"])] })).threads).toEqual({ origin: null, executor: null });
  });

  it("shows each PR's state in the board's words, and says when nothing read it", () => {
    expect(inventoryRow(input(1)).status).toBe("No reviewer");
    // A stacked PR waits on its parent, and names it, so its row files under the parent's.
    expect(inventoryRow(input(2, { stackedOn: 1 }))).toMatchObject({ stackedOn: 1, status: "Behind #1" });
    expect(inventoryRow(input(1, { pr: pr(1, { reviewRequests: [{ login: "mira" }] }) })).reviewers).toEqual({ requested: ["mira"], reviewed: [] });
    expect(inventoryRow(input(1, { hold: { reason: "Store layout first", heldAt: 0 } })).status).toBe("On hold");
    expect(inventoryRow(input(1, { pr: null, authored: false, observation: null }))).toMatchObject({ status: "Not read yet", draft: null, head: null, stage: null });
    expect(inventoryRow(input(1, { observation: { checkedAt: null, failedAt: "2026-09-28T21:01:00.000Z", error: "HTTP 502" } })).failure)
      .toEqual({ at: "2026-09-28T21:01:00.000Z", error: "HTTP 502" });
  });

  // A teammate's PR asks nothing of you. A PR you hold still has its feedback, which turnOf parks in Held until you release it: the row
  // keeps the facts, not the verdict.
  it("reads the feedback waiting on you on your own PR, held or not, never on a teammate's", () => {
    const changes = pr(1, { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ author: { login: "otto-v" }, state: "CHANGES_REQUESTED", submittedAt: "2026-09-28T20:00:00Z" }] });
    expect(inventoryRow(input(1, { pr: changes })).yourTurn).toEqual({ why: "Changes requested by @otto-v",
      since: Date.parse("2026-09-28T20:00:00Z"), latest: Date.parse("2026-09-28T20:00:00Z") });
    expect(inventoryRow(input(1, { pr: changes, authored: false })).yourTurn).toBeNull();
    expect(inventoryRow(input(1, { pr: changes, hold: { reason: "Store layout first", heldAt: 0 } })).yourTurn).toMatchObject({ why: "Changes requested by @otto-v" });
    expect(inventoryRow(input(1)).yourTurn).toBeNull();
  });

  it("prints each row as a line under its effort, with the counts, the next steps, and when GitHub last answered", () => {
    const now = Date.parse("2026-09-28T21:00:30.000Z");
    const view = inventoryView([
      { effort: shelf, ...inventoryRow(input(1, { pr: pr(1, { reviewRequests: [{ login: "mira" }] }), reasons: [reason("needs-nudge", { since: now - 2 * 86_400_000 })] })) },
      { effort: null, ...inventoryRow(input(2, { hold: { reason: "Store layout first", heldAt: 0 },
        observation: { checkedAt: "2026-09-28T20:00:00.000Z", failedAt: "2026-09-28T20:59:00.000Z", error: "rate limit" } })) },
    ], { ...META, rateLimitedUntil: Date.parse("2026-09-28T21:05:00.000Z") });
    expect(inventoryText(view, now).split("\n")).toEqual([
      "0 forgotten in draft · 0 missing a reviewer · 1 need a nudge · last read just now",
      "GitHub rate limit: the next read waits until 2026-09-28T21:05:00.000Z.",
      "Shelf order",
      "  inkwell/folio #1 · ABC-1 Keep shelf order on reload · @mira (requested) · Awaiting review · Nudge @mira (reviewers, 2d) · checked just now",
      "No effort",
      "  inkwell/folio #2 · ABC-2 Keep shelf order on reload · no reviewer · On hold · read failed 1m ago: rate limit · held: Store layout first",
    ]);
  });
});
