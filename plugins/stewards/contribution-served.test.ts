// BB-418 (BB-291 C10): a source's contribution rides `sourceSnapshot`. No live
// source serves one yet, so the production path always falls back to the
// in-process contributors; this test serves one through the fake source and
// checks it reaches the `compose.served` shadow without changing the
// authoritative assessment, proving the read path adds no separate call.
import { describe, expect, it } from "vitest";
import { issue } from "./fixtures.js";
import { setup } from "./test-world.js";

describe("a served contribution rides sourceSnapshot (BB-418)", () => {
  it("reaches the compose.served shadow without changing the authoritative assessment", async () => {
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
    // The fake linear source serves a contribution beside its snapshot, on the
    // same `sourceSnapshot` call. It names a step and a made-up gate item, and
    // differs from the in-process linear contribution, so the shadow logs it.
    t.serveContribution("uuid-12", {
      source: "linear",
      gate: [{ source: "linear", subject: { kind: "step", id: "spec" }, id: "spec-approved", met: false, missing: "the spec is not approved", lane: "user", escalated: false, product: false, inputs: "spec-approved@1" }],
      waits: [],
      resources: [{ source: "linear", id: "served:artifact", active: true, subject: { kind: "step", id: "spec" } }],
      holds: [],
      reasons: [],
    });
    await t.hooks.reconcilePass("p1");
    // The served contribution is folded by the same `compose()` and compared
    // against the in-process linear contribution; the difference is logged.
    const rows = t.hooks.store.divergences({ bindingId: b.id, surface: "compose.served" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputs.source).toBe("linear");
    // The authoritative assessment is unchanged: the served gate item did not
    // set the composed gate or the stored rows.
    const row = t.hooks.store.assessment(b.id) as { gate: { met: boolean; missing: string | null; pulls: unknown[] }; resources: Array<{ id: string }> } | null;
    expect(row).not.toBeNull();
    // The binding has no own pull, so the in-process gate is met; the served
    // unmet gate item did not reach the authoritative answer.
    expect(row!.gate.pulls).toEqual([]);
    expect(row!.gate.met).toBe(true);
    // The core's in-process resources are present; the served resource is not.
    expect(row!.resources.map((r) => r.id)).toContain("workers");
    expect(row!.resources.map((r) => r.id)).not.toContain("served:artifact");
  });
});
