// BB-418 (BB-291 C10): a source's contribution rides `sourceSnapshot`. No live
// source serves one yet, so the production path always falls back to the
// in-process contributors; this test serves one through the fake source and
// checks it reaches the binding's stored assessment, proving the read path
// adds no separate call.
import { describe, expect, it } from "vitest";
import { issue } from "./fixtures.js";
import { setup } from "./test-world.js";

describe("a served contribution rides sourceSnapshot (BB-418)", () => {
  it("composes the source's contribution into the binding's stored assessment", async () => {
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
    // The fake source serves a contribution beside its snapshot, on the same
    // `sourceSnapshot` call. Nothing in the core names figma or the stage.
    t.serveContribution("uuid-12", {
      source: "figma",
      gate: [{ source: "figma", subject: { kind: "artifact", id: "file-1" }, id: "design-approved", met: false, missing: "the design is not approved", lane: "user", escalated: false, product: false, inputs: "design-approved@1" }],
      waits: [],
      resources: [{ source: "figma", id: "artifact:file-1", active: true, subject: { kind: "artifact", id: "file-1" } }],
      holds: [],
      reasons: [],
    });
    await t.hooks.reconcilePass("p1");
    const row = t.hooks.store.assessment(b.id) as { gate: { met: boolean; missing: string | null; pulls: unknown[] }; resources: Array<{ id: string; active: boolean }> } | null;
    expect(row).not.toBeNull();
    // The served gate item folds into the composed gate, and its resource is
    // stored. The per-pull merge gate stays empty: a served item carries no
    // wrapped `assessed` gate, so it cannot set the core's merge gate.
    expect(row!.gate).toMatchObject({ met: false, missing: "the design is not approved" });
    expect(row!.gate.pulls).toEqual([]);
    expect(row!.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "artifact:file-1", active: true })]));
  });
});
