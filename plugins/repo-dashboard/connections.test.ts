import { describe, expect, it } from "vitest";
import { type Event } from "./contract.js";
import { connectionKey, reviewConnections } from "./connections.js";

const week = "2026-09-28";
function review(reviewer: string, author: string | undefined, number: number, at = "2026-09-29T12:00:00Z"): Event {
  return { id: `${reviewer}:${number}`, metric: "reviewed", login: reviewer, authorLogin: author,
    repo: "bitcomplete/app", number, title: "Change", url: `https://github.com/bitcomplete/app/pull/${number}`, at };
}

describe("review connections", () => {
  it("counts each reviewer and PR once, even after repeat reviews, and excludes self review", () => {
    const data = reviewConnections([review("Alice", "Bob", 1), review("alice", "Bob", 1, "2026-09-30T12:00:00Z"), review("Alice", "Alice", 2)], week);
    expect(data.total).toBe(2);
    expect(data.known).toBe(2);
    expect(data.cells.get(connectionKey("alice", "bob"))).toBe(1);
    expect(data.cells.size).toBe(1);
  });
  it("reports missing author coverage and prefers a known duplicate", () => {
    const data = reviewConnections([review("a", undefined, 1), review("a", "b", 1), review("a", undefined, 2)], week);
    expect([data.known, data.total]).toEqual([1, 2]);
    expect(data.cells.get(connectionKey("a", "b"))).toBe(1);
  });
  it("uses ET week boundaries and sorts equal totals lexically", () => {
    const data = reviewConnections([review("z", "c", 1, "2026-09-28T03:59:59Z"), review("z", "c", 2, "2026-09-28T04:00:00Z"), review("a", "b", 3, "2026-10-05T03:59:59Z"), review("a", "b", 4, "2026-10-05T04:00:00Z")], week);
    expect(data.total).toBe(2);
    expect(data.reviewers).toEqual(["a", "z"]);
    expect(data.authors).toEqual(["b", "c"]);
    expect(data.max).toBe(1);
  });
});
