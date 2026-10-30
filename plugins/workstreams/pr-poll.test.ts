import { describe, expect, it } from "vitest";
import { createPrPoll } from "./pr-poll.js";

describe("visible PR polling", () => {
  it("coalesces concurrent views behind one cadence", () => {
    let now = 0;
    const poll = createPrPoll({ now: () => now, intervalMs: 45_000, batchSize: 20 });
    expect(poll.select(["a", "b"])).toEqual(["a", "b"]);
    expect(poll.select(["a", "b"])).toEqual([]);
    now = 44_999;
    expect(poll.select(["a", "b"])).toEqual([]);
    now++;
    expect(poll.select(["a", "b"])).toEqual(["a", "b"]);
  });

  it("reads every PR in turn when they outnumber one batch", () => {
    let now = 0;
    const poll = createPrPoll({ now: () => now, intervalMs: 45_000, batchSize: 3 });
    const urls = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const selected = Array.from({ length: 3 }, () => {
      const batch = poll.select(urls);
      now += 45_000;
      return batch;
    });
    expect(selected).toEqual([["a", "b", "c"], ["d", "e", "f"], ["g", "h", "a"]]);
  });
});
