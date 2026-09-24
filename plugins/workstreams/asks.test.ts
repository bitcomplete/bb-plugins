import { describe, expect, it } from "vitest";
import { PIN_AFTER, planClusterAsks, type AskMemory } from "./asks.js";
import type { ClusterDecision } from "./workstreams.js";

const assigned = (label: string): ClusterDecision => ({ summary: null, assignment: { label, fit: 0.8 } });

describe("why a cluster is re-asked", () => {
  it("says new for a cluster never seen, and semantic-hash-changed for one whose content moved", () => {
    const memory = new Map<string, AskMemory>([["ABC-2", { hash: "old", streak: 0, pinned: false }]]);
    const plan = planClusterAsks({
      clusters: [
        { key: "ABC-1", hash: "h1", decision: undefined },
        { key: "ABC-2", hash: "h2", decision: undefined },
      ],
      labels: new Set(["Gift cards"]),
      memory,
    });
    expect(plan.ask).toEqual([
      { key: "ABC-1", hash: "h1", reason: "new" },
      { key: "ABC-2", hash: "h2", reason: "semantic-hash-changed" },
    ]);
  });

  it("says label-vanished when the cached candidate is gone, and asks nothing when it still exists", () => {
    const plan = planClusterAsks({
      clusters: [
        { key: "ABC-1", hash: "h1", decision: assigned("Gone") },
        { key: "ABC-2", hash: "h2", decision: assigned("Gift cards") },
      ],
      labels: new Set(["Gift cards"]),
      memory: new Map(),
    });
    expect(plan.ask).toEqual([{ key: "ABC-1", hash: "h1", reason: "label-vanished" }]);
  });

  it("counts a change that is ONLY Linear detail arriving, so the one-time regroup after adding a key is logged as such", () => {
    const plan = planClusterAsks({
      clusters: [{ key: "ABC-1", hash: "with-linear", baseHash: "without-linear", decision: undefined }],
      labels: new Set(),
      memory: new Map([["ABC-1", { hash: "without-linear", streak: 0, pinned: false }]]),
    });
    expect(plan.linearArrivals).toBe(1);
  });
});

describe("the label-vanished damper", () => {
  /** A cluster whose chosen candidate disappears on every scan: the flip-flop seen in live logs. */
  function scans(count: number, hashAt: (scan: number) => string = () => "h1") {
    let memory = new Map<string, AskMemory>();
    const asked: number[] = [];
    const pins: number[] = [];
    for (let scan = 1; scan <= count; scan += 1) {
      const plan = planClusterAsks({
        clusters: [{ key: "ABC-1", hash: hashAt(scan), decision: assigned(`Label from scan ${scan - 1}`) }],
        labels: new Set([`Label from scan ${scan}`]),
        memory,
      });
      if (plan.ask.length > 0) asked.push(scan);
      if (plan.pinned.length > 0) pins.push(scan);
      memory = plan.next;
    }
    return { asked, pins };
  }

  it("settles a flip-flopping cluster within three scans, pinning its last assignment once", () => {
    const { asked, pins } = scans(8);
    expect(asked).toEqual([1, 2, 3]);
    expect(asked).toHaveLength(PIN_AFTER);
    expect(pins).toEqual([4]);
  });

  it("un-pins on a real content change and asks again, because a pin must never hide new work", () => {
    const { asked } = scans(7, (scan) => (scan < 6 ? "h1" : "h2"));
    expect(asked).toEqual([1, 2, 3, 6, 7]);
  });

  it("resets the streak when the label survives a scan, so only CONSECUTIVE re-asks count", () => {
    let memory = new Map<string, AskMemory>();
    const asked: number[] = [];
    for (let scan = 1; scan <= 6; scan += 1) {
      const survives = scan === 3;
      const plan = planClusterAsks({
        clusters: [{ key: "ABC-1", hash: "h1", decision: assigned("Gift cards") }],
        labels: new Set(survives ? ["Gift cards"] : [`Other ${scan}`]),
        memory,
      });
      if (plan.ask.length > 0) asked.push(scan);
      memory = plan.next;
    }
    expect(asked).toEqual([1, 2, 4, 5, 6]);
  });
});
