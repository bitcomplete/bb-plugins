import { describe, expect, it } from "vitest";
import { type Event } from "./contract.js";
import { formatLines, median, mergedPrs, reviewLoad, sizeBucket, sizeSummary } from "./size.js";

function event(overrides: Partial<Event> = {}): Event {
  return { id: "merged:https://github.com/bitcomplete/app/pull/1", metric: "merged", login: "alice", repo: "bitcomplete/app",
    number: 1, title: "Change", url: "https://github.com/bitcomplete/app/pull/1", at: "2026-09-29T12:00:00Z",
    additions: 30, deletions: 10, changedFiles: 3, ...overrides };
}
function pr(number: number, additions: number, overrides: Partial<Event> = {}): Event {
  const url = `https://github.com/bitcomplete/app/pull/${number}`;
  return event({ id: `merged:${url}`, number, url, additions, deletions: 0, changedFiles: number, ...overrides });
}

describe("PR size", () => {
  it("buckets lines changed at each threshold", () => {
    expect([0, 9, 10, 49, 50, 249, 250, 999, 1000, 398095].map(sizeBucket)).toEqual(["XS", "XS", "S", "S", "M", "M", "L", "L", "XL", "XL"]);
  });
  it("takes the middle value, averaging the two middles of an even count", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 300])).toBe(5);
    expect(median([1, 300, 10, 20])).toBe(15);
  });
  it("formats large line counts compactly", () => {
    expect([999, 1000, 1250, 12_340, 398_095].map(formatLines)).toEqual(["999", "1k", "1.3k", "12.3k", "398k"]);
  });
  it("summarizes distinct PRs and leaves PRs without size data out of the medians", () => {
    const summary = sizeSummary([pr(1, 5), pr(2, 300), pr(2, 300), pr(3, 2000), pr(4, 40, { additions: undefined })]);
    expect(summary).toMatchObject({ total: 4, known: 3, medianLines: 300, medianFiles: 2, lines: 2305, largeShare: 2 / 3 });
    expect(summary.buckets.map(({ id, items }) => [id, items.map((item) => item.number)])).toEqual([["XS", [1]], ["S", []], ["M", []], ["L", [2]], ["XL", [3]]]);
    expect(sizeSummary([pr(1, 5, { changedFiles: undefined })])).toMatchObject({ total: 1, known: 0, medianLines: null, largeShare: null });
  });
  it("uses only merged PRs for the merged distribution", () => {
    expect(mergedPrs([pr(1, 5), pr(2, 5, { metric: "opened" }), pr(3, 5, { metric: "reviewed", login: "bob" })]).map((item) => item.number)).toEqual([1]);
  });
  it("counts each reviewed PR once per reviewer and reports partial size coverage", () => {
    const review = (login: string, number: number, overrides: Partial<Event> = {}) =>
      pr(number, 100, { metric: "reviewed", login, id: `review:${login}:${number}`, deletions: 20, ...overrides });
    const loads = reviewLoad([review("bob", 1), review("bob", 1), review("bob", 2, { additions: undefined }), review("carol", 1), pr(3, 900)]);
    expect(loads.get("bob")).toEqual({ prs: 2, known: 1, lines: 120, files: 1 });
    expect(loads.get("carol")).toEqual({ prs: 1, known: 1, lines: 120, files: 1 });
    expect(loads.has("alice")).toBe(false);
  });
});
