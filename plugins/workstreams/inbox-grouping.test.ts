import { describe, expect, it } from "vitest";
import { groupInboxRows, partitionCompletedRows, visibleCompletedRows, visibleInboxRows } from "./inbox-grouping.js";
import type { Row } from "./inbox.js";
import type { InboxSection } from "./workstreams.js";

function row(key: string, effortKey: string, effort: string, section: InboxSection, since: number): Row {
  return {
    key,
    effortKey,
    effort,
    section,
    repo: "folio",
    age: { since, basis: "state" },
    unit: { path: key, pr: { number: Number(key.slice(1)) } },
  } as Row;
}

describe("Board grouping", () => {
  const older = row("p1", "effort-a", "Payments", "fix", 10);
  const newer = row("p2", "effort-a", "Payments", "fix", 20);
  const merge = row("p3", "effort-a", "Payments", "merge", 1);
  const sameName = row("p4", "effort-b", "Payments", "respond", 5);

  it("keeps same-named efforts separate and orders work by next action, then age", () => {
    const sections = new Map<InboxSection, Row[]>([
      ["merge", [merge]],
      ["respond", [sameName]],
      ["fix", [newer, older]],
    ]);
    const groups = groupInboxRows(sections, "effort");
    expect(groups.map((group) => [group.key, group.label, group.rows.map((entry) => entry.key)])).toEqual([
      ["effort-a", "Payments", ["p1", "p2", "p3"]],
      ["effort-b", "Payments", ["p4"]],
    ]);
  });

  it("keeps Action's section order and includes empty sections", () => {
    const groups = groupInboxRows(new Map([["merge", [merge]]]), "action");
    expect(groups.map((group) => [group.key, group.rows.length])).toEqual([
      ["fix", 0], ["respond", 0], ["merge", 1], ["waiting", 0],
      ["in-flight", 0], ["shipped", 0], ["parked", 0],
    ]);
  });

  it("traverses only filtered rows in expanded groups, in their displayed order", () => {
    const filtered = new Map<InboxSection, Row[]>([["fix", [older]], ["respond", [sameName]]]);
    const groups = groupInboxRows(filtered, "effort");
    expect(visibleInboxRows(groups, () => true).map((entry) => entry.key)).toEqual(["p1", "p4"]);
    expect(visibleInboxRows(groups, (group) => group.key !== "effort-a").map((entry) => entry.key)).toEqual(["p4"]);
  });

  it("counts merged and release-tagged rows across recent and parked sections after filtering", () => {
    const merged = { ...row("p5", "effort-a", "Payments", "shipped", 1), unit: { lifecycle: "merged" } } as Row;
    const olderMerged = { ...row("p6", "effort-a", "Payments", "parked", 1), unit: { lifecycle: "merged" } } as Row;
    const tagged = { ...row("p7", "effort-a", "Payments", "parked", 1), unit: { lifecycle: "shipped" } } as Row;
    const filtered = new Map<InboxSection, Row[]>([["fix", [older]], ["shipped", [merged]], ["parked", [olderMerged, tagged]]]);
    const completed = partitionCompletedRows(filtered);
    expect(completed.merged.map((entry) => entry.key)).toEqual(["p5", "p6"]);
    expect(completed.inReleaseTag.map((entry) => entry.key)).toEqual(["p7"]);
    expect(groupInboxRows(completed.active, "effort").flatMap((group) => group.rows.map((entry) => entry.key))).toEqual(["p1"]);
    expect(visibleCompletedRows(completed, { merged: false, inReleaseTag: false })).toEqual([]);
    expect(visibleCompletedRows(completed, { merged: true, inReleaseTag: false }).map((entry) => entry.key)).toEqual(["p5", "p6"]);
    expect(visibleCompletedRows(completed, { merged: true, inReleaseTag: true }).map((entry) => entry.key)).toEqual(["p5", "p6", "p7"]);
  });
});
