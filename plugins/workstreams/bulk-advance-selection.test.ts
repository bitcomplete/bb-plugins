import { describe, expect, it } from "vitest";
import { ADVANCE_SELECTION_LIMIT, eligibleAdvanceSelection, reconcileAdvanceSelection, selectVisibleApproved } from "./bulk-advance-selection";

const approved = (n: number) => ({ url: `https://github.com/acme/app/pull/${n}`, state: "OPEN", reviewDecision: "APPROVED" });

describe("finite advance selection", () => {
  it("selects approved PRs only while preserving choices outside the current search", () => {
    const selected = selectVisibleApproved([approved(1).url], [approved(2), { ...approved(3), reviewDecision: "CHANGES_REQUESTED" }, { ...approved(4), state: "MERGED" }]);
    expect(selected).toEqual([approved(1).url, approved(2).url]);
  });
  it("drops PRs that closed or lost approval without adding newly approved PRs", () => {
    const selected = eligibleAdvanceSelection([approved(1).url, approved(2).url, approved(3).url], [approved(1), { ...approved(2), state: "CLOSED" }, { ...approved(3), reviewDecision: null }, approved(4)]);
    expect(selected).toEqual([approved(1).url]);
  });
  it("requires a fresh selection when approval returns after a selection was removed", () => {
    const initial = { urls: [approved(1).url, approved(2).url], removed: 0 };
    const afterPush = reconcileAdvanceSelection(initial, [approved(1), { ...approved(2), reviewDecision: null }]);
    expect(afterPush).toEqual({ urls: [approved(1).url], removed: 1 });
    const reapproved = reconcileAdvanceSelection(afterPush, [approved(1), approved(2)]);
    expect(reapproved).toBe(afterPush);
  });
  it("deduplicates inventory and checkout URLs and respects the preview limit", () => {
    const prs = Array.from({ length: ADVANCE_SELECTION_LIMIT + 2 }, (_, index) => approved(index + 1));
    const selected = selectVisibleApproved([`${approved(1).url.toUpperCase()}/`], prs);
    expect(selected).toHaveLength(ADVANCE_SELECTION_LIMIT);
    expect(selected[0]).toBe(approved(1).url);
    expect(new Set(selected).size).toBe(selected.length);
  });
});
