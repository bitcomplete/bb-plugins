import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createAssignmentStore, EFFORT_ASSIGNMENT_FROM_MIGRATION, EFFORT_ASSIGNMENT_MIGRATIONS } from "./effort-assignments.js";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;

function setup() {
  const db = new Database(":memory:");
  for (const statement of [...EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION, ...EFFORT_ASSIGNMENT_MIGRATIONS, EFFORT_ASSIGNMENT_FROM_MIGRATION]) db.prepare(statement).run();
  const efforts = createEffortStore(db);
  const assignments = createAssignmentStore(db, efforts, () => 5_000);
  const effort = (name: string, members: { tickets: string[]; prUrls: string[]; checkoutPaths?: string[] }) => efforts.establish({ sourceKey: `test:${name}`,
    name, goal: "", projectId: "project-inkwell", coordinatorState: "none", members });
  const pickup = effort("Store pickup", { tickets: ["ABC-330"], prUrls: [url("spine", 150)], checkoutPaths: ["/Users/reader/spine"] });
  const shelf = effort("Shelf order", { tickets: ["ABC-341"], prUrls: [] });
  const audit = () => db.prepare(`SELECT action_id AS actionId, at, source, effort_id AS effortId, kind, ref, rule_id AS ruleId, undone_at AS undoneAt
    FROM effort_assignments ORDER BY seq`).all();
  return { db, efforts, assignments, pickup, shelf, audit };
}

describe("classification assignments", () => {
  it("records one audit row per PR and ticket an action gives an effort", () => {
    const { efforts, assignments, pickup, audit } = setup();
    const result = assignments.assign({ effortId: pickup.id, source: "assign", prUrls: [url("spine", 151), url("spine", 152)], tickets: ["ABC-331"] });
    // `added` counts PRs, so a "2 moved" line matches the rows that moved.
    expect(result).toMatchObject({ added: 2, effort: { id: pickup.id } });
    expect(audit()).toEqual([
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "prUrl", ref: url("spine", 151), ruleId: null, undoneAt: null },
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "prUrl", ref: url("spine", 152), ruleId: null, undoneAt: null },
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "ticket", ref: "ABC-331", ruleId: null, undoneAt: null },
    ]);
    expect(efforts.owner("prUrl", url("spine", 152))?.id).toBe(pickup.id);
    expect(efforts.owner("ticket", "ABC-331")?.id).toBe(pickup.id);
  });

  // Classification only sorts unowned work: taking a PR or ticket another effort owns would be a silent move.
  it("assigns nothing when another effort owns any of the work", () => {
    const { efforts, assignments, pickup, shelf, audit } = setup();
    expect(() => assignments.assign({ effortId: shelf.id, source: "assign", prUrls: [url("folio", 314), url("spine", 150)] }))
      .toThrow("Another effort owns some of this work now");
    expect(() => assignments.assign({ effortId: shelf.id, source: "assign", prUrls: [url("folio", 314)], tickets: ["ABC-330"] }))
      .toThrow("Another effort owns some of this work now");
    expect(efforts.owner("prUrl", url("folio", 314))).toBeNull();
    expect(efforts.get(pickup.id)!.members.prUrls).toEqual([url("spine", 150)]);
    expect(audit()).toEqual([]);
  });

  it("undoes exactly what one action added, keeping the effort's earlier members and checkouts", () => {
    const { efforts, assignments, pickup, audit } = setup();
    const before = efforts.get(pickup.id)!.members;
    const { actionId } = assignments.assign({ effortId: pickup.id, source: "assign", prUrls: [url("spine", 151)], tickets: ["ABC-331"] });
    expect(assignments.undo(actionId)).toEqual({ effortId: pickup.id, source: "assign" });
    expect(efforts.get(pickup.id)!.members).toEqual(before);
    expect(efforts.owner("prUrl", url("spine", 151))).toBeNull();
    expect(efforts.owner("ticket", "ABC-331")).toBeNull();
    // The audit keeps the action, marked undone, and a second undo finds nothing to reverse.
    expect(audit()).toMatchObject([{ ref: url("spine", 151), undoneAt: 5_000 }, { ref: "ABC-331", undoneAt: 5_000 }]);
    expect(() => assignments.undo(actionId)).toThrow("Nothing to undo.");
  });

  // Undoing a new effort removes it, but never an effort that has since become real: members, a coordinator, or another merged into it.
  it("discards only an effort that holds and coordinated nothing", () => {
    const { efforts, pickup, shelf } = setup();
    const empty = () => efforts.establish({ sourceKey: `test:${Math.random()}`, name: "Footer refresh", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: [], prUrls: [] } });
    expect(efforts.discard(shelf.id)).toBe(false);
    const coordinated = efforts.save({ ...empty(), coordinatorThreadId: "thr-footer", coordinatorState: "ready" });
    expect(efforts.discard(coordinated.id)).toBe(false);
    const survivor = empty();
    efforts.merge(efforts.establish({ sourceKey: "test:merged", name: "Old footer", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: [], prUrls: [] } }).id, survivor.id);
    expect(efforts.discard(survivor.id)).toBe(false);
    const unused = empty();
    expect(efforts.discard(unused.id)).toBe(true);
    expect(efforts.getRecord(unused.id)).toBeNull();
    expect(efforts.get(pickup.id)).not.toBeNull();
  });

  // A move is what "Move to One-offs" does to a PR an effort owns: an explicit click, which Undo must reverse exactly, back to where it was.
  it("moves PRs out of the efforts that have them as one action, naming each one's effort, and Undo puts each back", () => {
    const { efforts, assignments, pickup, shelf, db } = setup();
    const oneOffs = efforts.establish({ sourceKey: "one-offs", name: "One-offs", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    efforts.transfer(shelf.key, { tickets: [], prUrls: [url("folio", 314)] });
    const moved = assignments.move({ effortId: oneOffs.id, source: "one-off", prUrls: [url("spine", 150), url("folio", 314)] });
    expect(moved).toMatchObject({ added: 2, effort: { id: oneOffs.id } });
    expect(db.prepare(`SELECT source, effort_id AS effortId, kind, ref, from_effort_id AS "from" FROM effort_assignments ORDER BY seq`).all()).toEqual([
      { source: "one-off", effortId: oneOffs.id, kind: "prUrl", ref: url("spine", 150), from: pickup.id },
      { source: "one-off", effortId: oneOffs.id, kind: "prUrl", ref: url("folio", 314), from: shelf.id }]);
    expect([efforts.owner("prUrl", url("spine", 150))?.id, efforts.owner("prUrl", url("folio", 314))?.id]).toEqual([oneOffs.id, oneOffs.id]);
    // Its tickets and checkouts stay: a one-off leaves its effort alone, and the effort's JSON record agrees with the index.
    expect(efforts.get(pickup.id)!.members).toEqual({ tickets: ["ABC-330"], prUrls: [], checkoutPaths: ["/Users/reader/spine"] });

    expect(assignments.undo(moved.actionId)).toEqual({ effortId: oneOffs.id, source: "one-off" });
    expect([efforts.owner("prUrl", url("spine", 150))?.id, efforts.owner("prUrl", url("folio", 314))?.id]).toEqual([pickup.id, shelf.id]);
    expect([efforts.get(pickup.id)!.members.prUrls, efforts.get(shelf.id)!.members.prUrls, efforts.get(oneOffs.id)!.members.prUrls])
      .toEqual([[url("spine", 150)], [url("folio", 314)], []]);
  });

  // A PR its ticket places has no row of its own: moving it gives it one in One-offs, and Undo drops that row, so the ticket places it again.
  it("leaves a PR its effort had only through a ticket to that ticket again on Undo", () => {
    const { efforts, assignments, pickup } = setup();
    const oneOffs = efforts.establish({ sourceKey: "one-offs", name: "One-offs", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    const moved = assignments.move({ effortId: oneOffs.id, source: "one-off", prUrls: [url("spine", 160)] });
    expect(efforts.owner("prUrl", url("spine", 160))?.id).toBe(oneOffs.id);
    assignments.undo(moved.actionId);
    expect(efforts.owner("prUrl", url("spine", 160))).toBeNull();
    expect(efforts.owner("ticket", "ABC-330")?.id).toBe(pickup.id);
    assignments.move({ effortId: oneOffs.id, source: "one-off", prUrls: [url("spine", 150)] });
    expect(() => assignments.move({ effortId: oneOffs.id, source: "one-off", prUrls: [url("spine", 150)] })).toThrow("These are in One-offs already.");
  });

  it("won't put a moved PR back into an effort archived since", () => {
    const { efforts, assignments, pickup } = setup();
    const oneOffs = efforts.establish({ sourceKey: "one-offs", name: "One-offs", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    const moved = assignments.move({ effortId: oneOffs.id, source: "one-off", prUrls: [url("spine", 150)] });
    efforts.setArchived(pickup.id, true);
    expect(() => assignments.undo(moved.actionId)).toThrow("The effort it came from is gone or archived, so Undo no longer applies.");
    expect(efforts.owner("prUrl", url("spine", 150))?.id).toBe(oneOffs.id);
  });

  it("refuses an undo once any of its work moved to another effort, and releases nothing", () => {
    const { efforts, assignments, pickup, shelf } = setup();
    const { actionId } = assignments.assign({ effortId: pickup.id, source: "one-off", prUrls: [url("spine", 151), url("spine", 152)] });
    efforts.transfer(shelf.key, { tickets: [], prUrls: [url("spine", 152)] });
    expect(() => assignments.undo(actionId)).toThrow("This work moved since, so Undo no longer applies.");
    expect(efforts.owner("prUrl", url("spine", 151))?.id).toBe(pickup.id);
    expect(efforts.owner("prUrl", url("spine", 152))?.id).toBe(shelf.id);
  });
});
