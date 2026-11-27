// BB-418 (BB-291 C10): a source's contribution rides `sourceSnapshot`. No live
// source serves one yet, so the production path always falls back to the
// in-process contributors; this test serves one through the fake source and
// checks it reaches the binding's stored assessment, proving the read path adds
// no separate call. A source with no in-process contributor folds additively,
// beside the core items; a source with one is shadowed instead.
import { describe, expect, it } from "vitest";
import { issue } from "./fixtures.js";
import { setup } from "./test-world.js";

describe("a served contribution rides sourceSnapshot (BB-418)", () => {
  it("folds a new source's contribution into the stored assessment, beside the core items", async () => {
    const t = await setup();
    t.threads.set("thr_steward", { status: "idle", archivedAt: null });
    const b = t.hooks.store.create({
      projectId: "p1",
      source: "linear",
      entityId: "uuid-12",
      entityKey: "ENG-12",
      url: null,
      title: "ENG-12",
      kind: "ticket",
      playbook: "linear-tickets",
      playbookVersion: "v1",
      parentBindingId: null,
      phase: "In Progress",
      stage: "build",
    });
    t.hooks.store.patch(b.id, { threadId: "thr_steward" });
    t.entities.set("uuid-12", issue({ id: "uuid-12", key: "ENG-12", state: "In Progress", stateType: "started" }));
    // The fake linear source serves a `figma` contribution beside its snapshot,
    // on the same `sourceSnapshot` call. Nothing in the core names figma or the
    // stage; the source id is just a string.
    t.serveContribution("uuid-12", {
      source: "figma",
      gate: [{ source: "figma", subject: { kind: "artifact", id: "file-1" }, id: "design-approved", met: false, missing: "the design is not approved", lane: "user", escalated: false, product: false, inputs: "design-approved@1" }],
      waits: [{ source: "figma", kind: "person", ref: "need_design", live: true, fingerprint: null, budgetMs: null, since: null, overdueMs: null }],
      resources: [{ source: "figma", id: "artifact:file-1", active: true, subject: { kind: "artifact", id: "file-1" } }],
      holds: [{ source: "figma", id: "design-review", held: true, behind: [] }],
      reasons: [],
    });
    await t.hooks.reconcilePass("p1");
    const row = t.hooks.store.assessment(b.id) as {
      gate: { met: boolean; missing: string | null; pulls: unknown[] };
      resources: Array<{ id: string; source: string }>;
      holds: Array<{ id: string; source: string }>;
    } | null;
    expect(row).not.toBeNull();
    // The figma gate item folds into the composed gate; the per-pull merge gate
    // stays core-only, because the item carries no wrapped `assessed` gate.
    expect(row!.gate).toMatchObject({ met: false, missing: "the design is not approved" });
    expect(row!.gate.pulls).toEqual([]);
    // The core's resources and the `ready-gate` hold are still composed, beside
    // the figma resource and hold.
    expect(row!.resources.map((r) => r.id)).toContain("workers");
    expect(row!.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "artifact:file-1", source: "figma" })]));
    expect(row!.holds).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ready-gate", source: "linear" }), expect.objectContaining({ id: "design-review", source: "figma" })]));
    // A source with no in-process contributor has nothing to shadow, and its
    // new items are not mistaken for a divergence in the in-process surfaces.
    expect(t.hooks.store.divergences({ bindingId: b.id, surface: "compose.served" })).toEqual([]);
    expect(t.hooks.store.divergences({ bindingId: b.id, surface: "compose.resources" })).toEqual([]);
    expect(t.hooks.store.divergences({ bindingId: b.id, surface: "compose.holds" })).toEqual([]);
    // The served list is persisted on the observation the look writes, so the
    // report path derives the same assessment with no re-read.
    const stored = t.hooks.store.binding(b.id);
    expect(stored?.lastSnapshot?.served).toHaveLength(1);
    expect(stored?.lastSnapshot?.served?.[0]?.source).toBe("figma");
  });
});
