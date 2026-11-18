// BB-361: the local ticket source's own behaviour, through the same
// source-contract shapes linear and github serve. A real in-memory SQLite
// database runs the shipped migrations, so the store side is exercised exactly
// as the plugin runs it.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createLocalSource, LOCAL_PARKED, localStateType } from "./local-source.js";
import { MIGRATIONS } from "./store.js";
import { signatureLine } from "./source-contract.js";

function source(prefix = "LOCAL") {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const rings: string[] = [];
  const changes: string[] = [];
  const s = createLocalSource({
    db,
    now: () => 1_700_000_000_000,
    ring: (key) => rings.push(key),
    changed: (projectId) => changes.push(projectId),
    prefixFor: () => prefix,
    ownerFor: () => "Dana",
  });
  return { s, rings, changes, db };
}

const signed = (body: string) => `${body}\n\n${signatureLine("thr_w1")}`;

describe("the local ticket source (BB-361)", () => {
  it("files LOCAL-1 with a signed description, parked in Backlog, and snapshots it", () => {
    const { s, rings } = source();
    const out = s.create({ unit: "p1", title: "Ship it", description: signed("Do the thing.") }, "Dana");
    expect(out).toMatchObject({ key: "LOCAL-1", id: "LOCAL-1" });
    expect(rings).toContain("LOCAL-1");
    const snap = s.snapshot("LOCAL-1")!;
    expect(snap).toMatchObject({ source: "local", kind: "issue", key: "LOCAL-1", state: "Backlog", unit: "p1", playbook: "local-tickets", viewer: "Dana" });
    expect(snap.assignees).toEqual(["Dana"]);
    expect(snap.description).toContain("Do the thing.");
    // A fresh ticket is parked: it is not adoptable until it moves to Ready.
    expect(s.adoptable(["p1"], 10)).toEqual([]);
  });

  it("refuses an unsigned description, so a bug cannot file one", () => {
    const { s } = source();
    expect(() => s.create({ unit: "p1", title: "x", description: "no signature" }, "Dana")).toThrow(/signature line/u);
  });

  it("stores the playbook a ticket names, defaulting to local-tickets", () => {
    const { s } = source();
    s.create({ unit: "p1", title: "Default", description: signed("d") }, "Dana");
    s.create({ unit: "p1", title: "Initiative", description: signed("d"), playbook: "initiative" }, "Dana");
    expect(s.get("LOCAL-1")!.playbook).toBe("local-tickets");
    expect(s.get("LOCAL-2")!.playbook).toBe("initiative");
    // `ticket` is the user-facing spelling of the default.
    s.create({ unit: "p1", title: "Ticket", description: signed("d"), playbook: "ticket" }, "Dana");
    expect(s.get("LOCAL-3")!.playbook).toBe("local-tickets");
  });

  it("adopts by state: Ready or later non-terminal, never Backlog or terminal", () => {
    const { s } = source();
    s.create({ unit: "p1", title: "A", description: signed("d") }, "Dana");
    s.update({ key: "LOCAL-1", state: "Ready" });
    expect(s.adoptable(["p1"], 10).map((e) => e.key)).toEqual(["LOCAL-1"]);
    s.update({ key: "LOCAL-1", state: "In Progress" });
    expect(s.adoptable(["p1"], 10).map((e) => e.key)).toEqual(["LOCAL-1"]);
    s.update({ key: "LOCAL-1", state: LOCAL_PARKED });
    expect(s.adoptable(["p1"], 10)).toEqual([]);
    s.update({ key: "LOCAL-1", state: "Done" });
    expect(s.adoptable(["p1"], 10)).toEqual([]);
    s.update({ key: "LOCAL-1", state: "Ready" });
    expect(s.adoptable(["p1"], 10).map((e) => e.key)).toEqual(["LOCAL-1"]);
  });

  it("refuses labels, priority and relations on update, and accepts state and parent", () => {
    const { s } = source();
    s.create({ unit: "p1", title: "A", description: signed("d") }, "Dana");
    s.create({ unit: "p1", title: "B", description: signed("d") }, "Dana");
    expect(() => s.update({ key: "LOCAL-1", addLabels: ["x"] })).toThrow(/labels/u);
    expect(() => s.update({ key: "LOCAL-1", priority: "high" })).toThrow(/priority/u);
    expect(() => s.update({ key: "LOCAL-1", relations: [{ type: "blocks", issue: "LOCAL-2" }] })).toThrow(/relations/u);
    expect(s.update({ key: "LOCAL-2", parent: "LOCAL-1" }).changed).toEqual(["parent LOCAL-1"]);
    expect(s.snapshot("LOCAL-2")!.parent).toEqual({ id: "LOCAL-1", key: "LOCAL-1" });
    expect(s.snapshot("LOCAL-1")!.children.map((c) => c.key)).toEqual(["LOCAL-2"]);
  });

  it("maps local states to a Linear-like stateType", () => {
    expect(localStateType("Backlog")).toBe("backlog");
    expect(localStateType("Ready")).toBe("unstarted");
    expect(localStateType("In Progress")).toBe("started");
    expect(localStateType("In Review")).toBe("started");
    expect(localStateType("Done")).toBe("completed");
    expect(localStateType("Canceled")).toBe("canceled");
  });

  it("comments: an agent comment carries the thread id, an owner page comment does not", () => {
    const { s } = source();
    s.create({ unit: "p1", title: "A", description: signed("d") }, "Dana");
    expect(() => s.comment("LOCAL-1", "unsigned")).toThrow(/signature line/u);
    s.comment("LOCAL-1", signed("**Spec:** from a worker"));
    s.ownerComment("LOCAL-1", "**Spec:** the owner's words", "Dana");
    const comments = s.comments("LOCAL-1");
    expect(comments.map((c) => c.threadId)).toEqual(["thr_w1", null]);
    const snap = s.snapshot("LOCAL-1")!;
    expect(snap.comments.map((c) => c.signedBy)).toEqual(["thr_w1", null]);
    expect(snap.comments.map((c) => c.author)).toEqual(["thr_w1", "Dana"]);
  });

  it("searches by title and description, scoped to the project", () => {
    const { s } = source();
    s.create({ unit: "p1", title: "Fix login", description: signed("Users cannot log in.") }, "Dana");
    s.create({ unit: "p2", title: "Other project", description: signed("Fix login too.") }, "Dana");
    expect(s.search(["p1"], "login", 20).map((i) => i.key)).toEqual(["LOCAL-1"]);
    expect(s.search(["p1"], "cannot", 20).map((i) => i.key)).toEqual(["LOCAL-1"]);
    expect(s.search(["p1", "p2"], "Fix", 20).map((i) => i.key)).toEqual(["LOCAL-1", "LOCAL-2"]);
  });

  it("uses the project's prefix for new keys, so a project can override LOCAL", () => {
    const { s } = source("TEAM");
    const out = s.create({ unit: "p1", title: "A", description: signed("d") }, "Dana");
    expect(out.key).toBe("TEAM-1");
  });
});
