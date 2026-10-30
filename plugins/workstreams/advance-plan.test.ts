import { describe, expect, it, vi } from "vitest";
import { advanceSnapshot, advanceSnapshotHash, clusterAdvance, advancePlanPrompt } from "./advance-plan.js";
import { inkwellInventory, inkwellInventoryPrs, INVENTORY_NOW } from "./inkwell-fixtures.js";
import type { DeckInput } from "./deck.js";
import type { JevClient } from "./enrich.js";

const input = (): DeckInput => ({ now: INVENTORY_NOW, rows: inkwellInventory().groups.flatMap((g) => g.rows.map((r) => ({ ...r, effort: g.effort,
  pr: inkwellInventoryPrs().find((p) => p.url === r.prUrl) ?? null, tickets: [], acted: null }))), efforts: [], merges: [], linear: new Map(), linearReadAt: new Map(),
  threads: new Map(), homes: [], classify: { groups: [], oneOffsId: null }, read: { checkedAt: new Date(INVENTORY_NOW).toISOString(), refreshing: false, limitedUntil: null }, seen: new Map() });

describe("advancement planning snapshot and Jev attention", () => {
  it("accounts for all unheld open PRs regardless of selection; excludes individual and effort holds", () => {
    const data = input(); const held = data.rows[0]!; held.hold = { reason: "Waiting", heldAt: INVENTORY_NOW };
    const effort = data.rows.find((r) => r.effort)!.effort!;
    data.efforts = [{ ...effort, key: effort.id, goal: "Goal", oneOff: false, archived: false, parentThreadId: null, tickets: [], pile: { effortId: effort.id, pile: "held", since: 1, reason: "Paused" } }];
    const snapshot = advanceSnapshot(data);
    expect(snapshot.prs.some((p) => p.url === held.prUrl)).toBe(false);
    expect(snapshot.prs.some((p) => p.effortId === effort.id)).toBe(false);
    expect(snapshot.prs.length + snapshot.excludedHeldCount).toBe(data.rows.length);
    expect(snapshot.missing.join(" ")).toContain("Full review bodies");
  });

  it("reuses semantic snapshot hashes across capture times, but changes on heads and worker state", () => {
    const data = input(), first = advanceSnapshot(data);
    expect(advanceSnapshotHash(first)).toBe(advanceSnapshotHash({ ...first, capturedAt: new Date(INVENTORY_NOW + 60000).toISOString() }));
    const changed = { ...first, prs: first.prs.map((p, i) => i ? p : { ...p, head: "b".repeat(40) }) };
    expect(advanceSnapshotHash(changed)).not.toBe(advanceSnapshotHash(first));
  });

  it("uses Jev choices, falls back on unknown or low-confidence choices, and indexes each PR exactly once", async () => {
    const snapshot = advanceSnapshot(input());
    const jev: JevClient = { ask: vi.fn(async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((k, i) => [k,
      { type: "choice" as const, choice: i === 0 ? "repair" : i === 1 ? "invented" : "review", confidence: i === 2 ? 0.1 : 0.9 }])), usage: { input_tokens: 1, output_tokens: 1 } })) };
    const result = await clusterAdvance(snapshot, jev);
    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(result.clusters.flatMap((c) => c.refs).sort()).toEqual(snapshot.prs.map((p) => p.ref).sort());
    expect(result.clusters.some((c) => c.source === "jev" || c.source === "mixed")).toBe(true);
    expect(result.clusters.some((c) => (c.id as string) === "invented")).toBe(false);
  });

  it("never lets Jev replace queued work, active workers, awaiting-user decisions, or stale facts with ready-to-finish", async () => {
    const snapshot = advanceSnapshot(input());
    snapshot.prs[0]!.stale = true;
    snapshot.prs[1]!.acted = { kind: "nudge", state: "queued", at: INVENTORY_NOW, batchId: "batch" };
    snapshot.prs[2]!.workers = [{ id: "thr-working", title: "Working", status: "Working", updatedAt: INVENTORY_NOW }];
    snapshot.prs[3]!.workers = [{ id: "thr-waiting", title: "Waiting", status: "Needs you", updatedAt: INVENTORY_NOW }];
    const result = await clusterAdvance(snapshot, { ask: async (_s, q) => ({ answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "choice", choice: "finish", confidence: 1 }])), usage: { input_tokens: 1, output_tokens: 1 } }) });
    const cluster = (ref: string) => result.clusters.find((c) => c.refs.includes(ref))!.id;
    expect(snapshot.prs.slice(0, 4).map((p) => cluster(p.ref))).toEqual(["verify", "moving", "moving", "decision"]);
  });

  it("degrades to transparent rule clusters when Jev fails, with no missing PRs", async () => {
    const snapshot = advanceSnapshot(input());
    const result = await clusterAdvance(snapshot, { ask: async () => { throw new Error("Synthetic outage"); } });
    expect(result.notice).toContain("could not finish");
    expect(result.clusters.flatMap((c) => c.refs)).toHaveLength(snapshot.prs.length);
  });

  it("keeps the planning prompt compact and contextual, excluding held work and requiring approval before execution", async () => {
    const snapshot = advanceSnapshot(input());
    const grouping = await clusterAdvance(snapshot);
    const prompt = advancePlanPrompt(snapshot, grouping.clusters, "/synthetic/advance.json", "digest", grouping.notice);
    expect(prompt).toContain("planning only"); expect(prompt).toContain("Do not consider held PRs");
    expect(prompt).toContain("all".toUpperCase()); expect(prompt).toContain("/synthetic/advance.json");
    expect(prompt).toContain("do not refetch unchanged facts"); expect(prompt).toContain("revalidate");
    expect(prompt).not.toContain(JSON.stringify(snapshot));
    for (const pr of snapshot.prs) expect(prompt).toContain(pr.ref);
  });
});
