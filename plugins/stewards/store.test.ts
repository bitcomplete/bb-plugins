import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, createStore } from "./store.js";

function store() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  let now = 1_000;
  const s = createStore(db, () => now);
  const binding = s.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "Fix login", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
  return { s, binding, advance: (ms: number) => (now += ms) };
}

describe("questions to the user", () => {
  it("are kept from ask to answer, and an answered one is never open again", () => {
    const { s, binding, advance } = store();
    const q = s.ask({ projectId: "p1", bindingId: binding.id, escalationId: null, question: "File an a11y ticket?", context: "Seen in review." });
    expect(q).toMatchObject({ id: expect.stringMatching(/^qst_/u), projectId: "p1", bindingId: binding.id, status: "open", answer: null, createdAt: 1_000 });
    const unbound = s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Freeze on Friday?", context: null });
    expect(s.openQuestions("p1").map((x) => x.id)).toEqual([q.id, unbound.id]);
    expect(s.openQuestions("p2")).toEqual([]);

    advance(500);
    expect(s.answer(q.id, "Yes, file it.", "thr_project")).toBe(true);
    expect(s.answer(q.id, "Again", "thr_project")).toBe(false);
    expect(s.question(q.id)).toMatchObject({ status: "answered", answer: "Yes, file it.", answeredBy: "thr_project", resolvedAt: 1_500 });
    expect(s.openQuestions("p1").map((x) => x.id)).toEqual([unbound.id]);
    expect(s.answeredSince("p1", 1_200).map((x) => x.id)).toEqual([q.id]);
    expect(s.answeredSince("p1", 1_600)).toEqual([]);
  });

  it("made by forwarding an escalation, closes with it either way round", () => {
    const { s, binding } = store();
    const ask = () => {
      const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "me", recommendation: null });
      return { x, q: s.ask({ projectId: "p1", bindingId: binding.id, escalationId: x.id, question: x.question, context: null }) };
    };

    // Resolving the escalation, from anywhere (here the binding ending), closes the question.
    const first = ask();
    expect(s.resolve(first.x.id, "The binding ended.")).toBe(true);
    expect(s.question(first.q.id)).toMatchObject({ status: "answered", answer: "The binding ended.", answeredBy: "plugin" });

    // Closing the question resolves the escalation.
    const second = ask();
    expect(s.answer(second.q.id, "No SSO.", "user")).toBe(true);
    expect(s.escalation(second.x.id)).toMatchObject({ status: "resolved", resolution: "No SSO." });
    expect(s.resolve(second.x.id, "late")).toBe(false);
    expect(s.openQuestions("p1")).toEqual([]);
  });
});

describe("the fingerprint map", () => {
  const ops = (s: ReturnType<typeof store>["s"], projectId = "p1") =>
    s.create({ projectId, source: "ops", entityId: "k8s-namespace/prod", entityKey: "k8s-namespace/prod", url: null, title: "Ops watch: prod", kind: "ops", playbook: "ops-watch", playbookVersion: "v1", parentBindingId: null, phase: "watching", stage: null });
  const fp = "k8s-namespace/prod/web/app#CrashLoopBackOff:Error:1";

  it("enters a problem on first sight with no ticket, and counts each sighting after", () => {
    const { s, advance } = store();
    const b = ops(s);
    const first = s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes" }]);
    expect(first.get(fp)).toMatchObject({ fingerprint: fp, bindingId: b.id, ticketKey: null, firstSeenAt: 1_000, lastSeenAt: 1_000, seenCount: 1, filedAt: null, lastCommentedAt: null });
    advance(60_000);
    const again = s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes, 9 restarts" }]);
    expect(again.get(fp)).toMatchObject({ ticketKey: null, firstSeenAt: 1_000, lastSeenAt: 61_000, seenCount: 2, summary: "web crashes, 9 restarts" });
    expect(s.fingerprints(b.id).map((f) => f.fingerprint)).toEqual([fp]);
  });

  it("points a problem at the ticket filed for it, and a comment moves only the last word", () => {
    const { s, advance } = store();
    const b = ops(s);
    s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes" }]);
    expect(s.recordTicket("p1", "k8s-namespace/prod/other#x", "OPS-1", "filed")).toBe(false);
    advance(1_000);
    expect(s.recordTicket("p1", fp, "ops-7", "filed")).toBe(true);
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-7", filedAt: 2_000, lastCommentedAt: 2_000 });
    advance(1_000);
    s.recordTicket("p1", fp, "OPS-7", "commented");
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-7", filedAt: 2_000, lastCommentedAt: 3_000 });
    // Back after OPS-7 was closed, filed anew: the next sighting is OPS-9's.
    advance(1_000);
    s.recordTicket("p1", fp, "OPS-9", "filed");
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-9", filedAt: 4_000 });
    // Another project's map is its own.
    expect(s.fingerprint("p2", fp)).toBeNull();
  });

  it("keeps an ops binding's last look", () => {
    const { s } = store();
    const b = ops(s);
    expect(b).toMatchObject({ source: "ops", kind: "ops", opsLook: null, lastSnapshot: null });
    const look = { at: 5, target: "k8s-namespace/prod", error: "403: forbidden", pods: 0, healthy: 0, deployments: [], warnings: [], logs: "unneeded" as const, notes: [], findings: [] };
    expect(s.patch(b.id, { opsLook: look }).opsLook).toEqual(look);
  });
});

describe("needs you items", () => {
  it("are deduplicated by (binding, kind, url) while open, and close once", () => {
    const { s, binding, advance } = store();
    const first = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret", how: "Settings → API", filedBy: "steward" });
    expect(first).toMatchObject({ id: expect.stringMatching(/^need_/u), kind: "configure", status: "open", filedBy: "steward", createdAt: 1_000 });
    // The same key updates the wording rather than adding a row.
    advance(10);
    const again = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret (new wording)", how: null, filedBy: "steward" });
    expect(again.id).toBe(first.id);
    expect(s.openNeeds(binding.id)).toHaveLength(1);
    expect(s.openNeeds(binding.id)[0]!.what).toBe("Add the client secret (new wording)");
    // A different url is a different item.
    s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/agent", what: "Install the agent", how: null, filedBy: "steward" });
    expect(s.openNeeds(binding.id)).toHaveLength(2);
    // Closing it lets the same key be filed again as a new row.
    expect(s.closeNeed(first.id, "done")).toBe(true);
    expect(s.closeNeed(first.id, "again")).toBe(false);
    expect(s.needs(binding.id, true).filter((n) => n.kind === "configure")).toHaveLength(2);
    const refiled = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret again", how: null, filedBy: "steward" });
    expect(refiled.id).not.toBe(first.id);
    expect(s.needs(binding.id, true)).toHaveLength(3);
  });
});
