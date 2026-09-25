import { describe, expect, it } from "vitest";
import { attentionDetail, attentionLabel, hasBoardRows, workstreamAttention } from "./workstream-attention.js";
import type { Row } from "./inbox.js";
import type { InboxSection, Lifecycle } from "./workstreams.js";

function row(key: string, name: string, section: InboxSection, lifecycle: Lifecycle, verb: string | null = null, staleness = "fresh", pr = true, prUrl = ""): Row {
  return {
    key: `${key}-${section}`,
    effortKey: key,
    effort: name,
    section,
    verb,
    unit: { lifecycle, staleness, ticket: pr ? "ABC-1" : null, pr: pr ? { number: 1, url: prUrl } : null, observed: { pr: true, status: true } },
  } as Row;
}

describe("workstream attention", () => {
  it("ranks ready, fix/respond, waiting review, then active by the first forward move", () => {
    const items = workstreamAttention([
      row("active", "Able", "in-flight", "active"),
      row("wait", "Beta", "waiting", "awaiting-review"),
      row("fix", "Cedar", "fix", "blocked"),
      row("ready", "Delta", "merge", "awaiting-merge", "Ready to merge"),
      row("respond", "Echo", "respond", "awaiting-followup"),
    ]);
    expect(items.map((item) => item.key)).toEqual(["ready", "fix", "respond", "wait", "active"]);
    expect(attentionLabel(items[0]!)).toBe("1 ready to merge");
    expect(attentionDetail(items[0]!)).toBe("1 ready to merge.");
  });

  it("uses a stable name/key tie break and distinguishes branch updates from ready merges", () => {
    const items = workstreamAttention([
      row("z", "Same", "merge", "awaiting-merge", "Update branch"),
      row("b", "Same", "merge", "awaiting-merge", "Update branch"),
      row("a", "Alpha", "merge", "awaiting-merge", "Update branch"),
    ]);
    expect(items.map((item) => item.key)).toEqual(["a", "b", "z"]);
    expect(attentionLabel(items[0]!)).toBe("1 to update branch");
  });

  it("summarizes global rows including stale and unknown states without treating completed work as active", () => {
    const [item] = workstreamAttention([
      row("x", "X", "fix", "blocked", null, "dead"),
      row("x", "X", "waiting", "unverified", null, "cold"),
      row("x", "X", "shipped", "merged"),
      row("x", "X", "parked", "shipped"),
      row("x", "X", "parked", "up-next", null, "dead", false),
    ]);
    expect(item).toMatchObject({ fix: 1, unknown: 1, merged: 1, inReleaseTag: 1, parked: 0, oldCommits: 2 });
    expect(attentionDetail(item!)).toBe("1 to fix · 1 with unknown status · 1 merged · 1 in release tag · 2 with old or missing commit dates.");
  });

  it("counts one PR once when two checkouts in a workstream point to its URL", () => {
    const items = workstreamAttention([
      row("x", "X", "merge", "awaiting-merge", "Ready to merge", "fresh", true, "https://github.com/acme/repo/pull/1"),
      row("x", "X", "merge", "awaiting-merge", "Ready to merge", "fresh", true, "https://github.com/acme/repo/pull/1"),
      row("x", "X", "respond", "awaiting-followup", null, "fresh", true, "https://github.com/acme/repo/pull/2"),
    ]);
    expect(items[0]).toMatchObject({ ready: 1, respond: 1 });
    expect(attentionLabel(items[0]!)).toBe("1 ready to merge");
  });

  it("counts ticketed checkouts without PRs individually", () => {
    const local = row("local", "Local", "in-flight", "active", null, "fresh", false);
    const items = workstreamAttention([
      { ...local, key: "checkout-a", unit: { ...local.unit, ticket: "ABC-1" } },
      { ...local, key: "checkout-b", unit: { ...local.unit, ticket: "ABC-2" } },
    ]);
    expect(items[0]?.inFlight).toBe(2);
  });

  it("handles no rows and a completed-only workstream", () => {
    expect(workstreamAttention([])).toEqual([]);
    const [done] = workstreamAttention([row("done", "Done", "parked", "shipped")]);
    expect(attentionLabel(done!)).toBe("1 in release tag");
    expect(attentionDetail(done!)).toBe("1 in release tag.");
    expect(hasBoardRows(done!)).toBe(false);
    expect(workstreamAttention([row("open", "Open", "waiting", "awaiting-rereview")]).map(hasBoardRows)).toEqual([true]);
    expect(workstreamAttention([row("open", "Open", "waiting", "awaiting-rereview")])[0]).toMatchObject({ waitingRereview: 1, waitingReview: 0 });
  });

  it("labels a re-review separately from an initial review in the chooser and selected detail", () => {
    const [item] = workstreamAttention([
      row("fail closed for Bridge clinician matching", "Fail closed for Bridge clinician matching", "waiting", "awaiting-rereview", "Awaiting re-review"),
      row("fail closed for Bridge clinician matching", "Fail closed for Bridge clinician matching", "waiting", "awaiting-review", "In review"),
    ]);
    expect(item).toMatchObject({ waitingRereview: 1, waitingReview: 1 });
    expect(attentionLabel(item!)).toBe("1 awaiting re-review");
    expect(attentionDetail(item!)).toBe("1 awaiting re-review · 1 waiting for review.");
  });
});
