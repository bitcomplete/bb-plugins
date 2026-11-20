// BB-374: a child's escalation routed to its parent cannot stall silently.
// Three behaviours: a report that claims to be waiting on the user while an
// escalation is routed to the binding is refused; a turn that ends with one
// still open is re-woken on a clock with a "What changed" line; and repeated
// unanswered re-wakes raise `stuck`, like missed reports.
import { describe, expect, it } from "vitest";
import { playbookPath } from "./config.js";
import { githubIssue, issue } from "./fixtures.js";
import { GITHUB_ISSUES } from "./templates.js";
import { setup } from "./test-world.js";
import type { EntitySnapshot } from "./source-contract.js";

const githubParent = (over: Partial<EntitySnapshot> = {}) => githubIssue({ id: "acme/web#1", key: "acme/web#1", url: "https://github.com/acme/web/issues/1", title: "Parent", parent: null, children: [], ...over });
const githubChild = (over: Partial<EntitySnapshot> = {}) => githubIssue({ parent: { id: "acme/web#1", key: "acme/web#1" }, children: [], ...over });

/** A report with the fields every call needs; `over` replaces what a test is about. */
const report = (over: Record<string, unknown> = {}) => ({ phase: "In Progress", summary: "Working.", nextAction: "Continue.", actor: "steward", ...over });

/** A parent binding with an open child escalation routed to it. */
async function parentWithRoutedChild() {
  const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
  t.files[playbookPath("github-issues")] = GITHUB_ISSUES;
  t.entities.set(
    "acme/web#1",
    githubParent({ children: [{ id: "acme/web#12", key: "acme/web#12", title: "Fix login", state: "status:todo", stateType: null, labels: ["bb-managed", "status:todo"] }] }),
  );
  await t.ring("github", "acme/web#1");
  const parent = t.hooks.store.find("acme/web#1", "p1")!;
  t.entities.set("acme/web#12", githubChild());
  await t.ring("github", "acme/web#12");
  const child = t.hooks.store.find("acme/web#12", "p1")!;
  await t.flush();
  await t.tool("steward_report", report({ nextAction: "Ask the parent", escalate: { kind: "decision", question: "Which way?", meanwhile: "Waiting." } }), child.threadId!);
  await t.flush();
  const escalation = t.hooks.store.openEscalations(child.id).find((x) => x.route === "parent")!;
  return { t, parent, child, escalation };
}

describe("BB-374: a routed escalation cannot be reported as waiting on the user", () => {
  it("refuses actor user and a person wait on a child's route-parent escalation, naming the escalation and both ways out", async () => {
    const { t, parent, escalation } = await parentWithRoutedChild();
    const userReport = await t.tool("steward_report", report({ actor: "user" }), parent.threadId!);
    expect(userReport.error, userReport.text).toBe(true);
    expect(userReport.text).toContain(escalation.id);
    expect(userReport.text).toContain("steward_update { binding, guidance, resolve }");
    expect(userReport.text).toContain("steward_update { binding, forward, recommendation }");
    // A `person` wait naming the child's escalation is refused on the input
    // kind, even though the ref does not resolve against the parent's own rows.
    const personWait = await t.tool("steward_report", report({ wait: { kind: "person", ref: escalation.id } }), parent.threadId!);
    expect(personWait.error, personWait.text).toBe(true);
    expect(personWait.text).toContain(escalation.id);
    // Any other actor is accepted, so a parent doing something else is not blocked.
    const ok = await t.tool("steward_report", report(), parent.threadId!);
    expect(ok.error, ok.text).toBe(false);
  });

  it("refuses actor user on a worker's route-steward escalation", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.hooks.store.find("ENG-12", "p1")!.threadId!;
    await t.created("thr_w1", steward, "ENG-12: Implement");
    const b = t.hooks.store.find("ENG-12", "p1")!;
    await t.harness.behavior.runCli(["escalate", "Which API version should I target?"], { threadId: "thr_w1", projectId: "p1" });
    await t.flush();
    const escalation = t.hooks.store.openEscalations(b.id).find((x) => x.route === "steward")!;
    const refused = await t.tool("steward_report", report({ actor: "user" }), steward);
    expect(refused.error, refused.text).toBe(true);
    expect(refused.text).toContain(escalation.id);
  });
});

describe("BB-374: a binding that ends a turn with a routed escalation open is re-woken", () => {
  it("schedules a re-wake and delivers the still-routed line under What changed", async () => {
    const { t, parent, escalation } = await parentWithRoutedChild();
    await t.tool("steward_report", report(), parent.threadId!);
    await t.idle(parent.threadId!);
    const scheduled = t.hooks.store.binding(parent.id)!;
    expect(scheduled.escalationRewakeId).toBe(escalation.id);
    expect(scheduled.escalationRewakeAt).not.toBeNull();
    expect(scheduled.requeueAt).not.toBeNull();
    // Nothing has fired yet: the re-wake waits for the clock.
    const before = t.sends.filter((s) => s.threadId === parent.threadId).length;
    t.advance(31 * 60_000);
    await t.hooks.requeueTick();
    await t.flush();
    const sends = t.sends.filter((s) => s.threadId === parent.threadId);
    expect(sends.length).toBeGreaterThan(before);
    const wake = sends.at(-1)!.text;
    expect(wake).toContain("still routed to you");
    expect(wake).toContain(escalation.id);
  });

  it("stops once the escalation is resolved, and once it is forwarded", async () => {
    const { t, parent, child, escalation } = await parentWithRoutedChild();
    await t.tool("steward_report", report(), parent.threadId!);
    await t.idle(parent.threadId!);
    expect(t.hooks.store.binding(parent.id)!.escalationRewakeId).toBe(escalation.id);
    const resolved = await t.tool("steward_update", { binding: child.entityKey, guidance: "Decided: use v2.", resolve: escalation.id }, parent.threadId!);
    expect(resolved.error, resolved.text).toBe(false);
    await t.idle(parent.threadId!);
    expect(t.hooks.store.binding(parent.id)).toMatchObject({ escalationRewakeId: null, escalationRewakeCount: 0 });

    // Forward: the same escalation leaves the parent's desk for the project steward.
    const second = await parentWithRoutedChild();
    await second.t.tool("steward_report", report(), second.parent.threadId!);
    await second.t.idle(second.parent.threadId!);
    expect(second.t.hooks.store.binding(second.parent.id)!.escalationRewakeId).toBe(second.escalation.id);
    const forwarded = await second.t.tool("steward_update", { binding: second.child.entityKey, forward: second.escalation.id, recommendation: "Ask the owner.", resolution: "text" }, second.parent.threadId!);
    expect(forwarded.error, forwarded.text).toBe(false);
    await second.t.idle(second.parent.threadId!);
    expect(second.t.hooks.store.binding(second.parent.id)).toMatchObject({ escalationRewakeId: null, escalationRewakeCount: 0 });
  });

  it("raises stuck after repeated unanswered re-wakes for the same escalation", async () => {
    const { t, parent, escalation } = await parentWithRoutedChild();
    for (let i = 0; i < 3; i++) {
      await t.tool("steward_report", report(), parent.threadId!);
      await t.idle(parent.threadId!);
      t.advance(31 * 60_000);
      await t.hooks.requeueTick();
      await t.flush();
    }
    const stuck = t.hooks.store.openEscalations(parent.id).filter((x) => x.kind === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.question).toContain(escalation.id);
  });
});
