import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../../src/store.js";
import { mineBatch, readLedgers, type MiningSession, type MiningAnalysis } from "../../src/stages/mining.js";
import { NOW } from "../domain/fixtures.js";

const databases: Database.Database[] = [];
function store(): Store { const db = new Database(":memory:"); databases.push(db); for (const sql of MIGRATIONS) db.exec(sql); return new Store(db); }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function session(id = "session-one", seq = 1): MiningSession {
  return { sessionId: id, threadId: `thread-${id}`, taskId: "task-one", day: "2026-11-18", firstEventAtMs: NOW,
    originPluginId: null, events: [{ id: `event-${seq}`, sequence: seq, atMs: NOW + seq, turnIndex: 0, kind: "tool_error", excerpt: "credential-raw: the retry omitted the payload" }] };
}
const analysis = (eventId = "event-1"): MiningAnalysis => ({ failures: [{ eventId, kind: "tool_error", symptom: "The retry lacks its payload", rootCauseHypothesis: "Retry state drops request data", category: "reliability", matchedProblemId: null }] });
const redact = (s: string) => s.replaceAll("credential-raw", "[redacted]");
describe("incremental miner", () => {
  it("stores generalized findings and pointers, never source excerpts; replay makes no model call", async () => {
    const db = store(); let calls = 0;
    const analyze = async (s: MiningSession, events: MiningSession["events"]) => { calls++; expect(events[0]!.excerpt).not.toContain("credential-raw"); expect(JSON.stringify(s)).not.toContain("credential-raw"); return analysis(); };
    const first = await mineBatch({ store: db, sessions: [session()], analyze, redact, nowMs: NOW + 100 });
    expect(first.votesAdded).toBe(1);
    expect(readLedgers(db).problems).toHaveLength(1);
    expect(JSON.stringify(db.list("problems"))).not.toContain("credential-raw");
    expect(JSON.stringify(db.list("votes"))).not.toContain("excerpt");
    await mineBatch({ store: db, sessions: [session()], analyze, redact, nowMs: NOW + 200 });
    expect(calls).toBe(1);
    expect(readLedgers(db).votes).toHaveLength(1);
  });
  it("rejects invented event pointers and wrong vote kinds without advancing that cursor", async () => {
    const db = store();
    await expect(mineBatch({ store: db, sessions: [session()], analyze: async () => analysis("invented-event"), redact, nowMs: NOW + 100 })).rejects.toThrow(/event/i);
    expect(db.list("mining-cursors")).toEqual([]);
    const wrong = analysis(); wrong.failures[0]!.kind = "owner_correction";
    await expect(mineBatch({ store: db, sessions: [session()], analyze: async () => wrong, redact, nowMs: NOW + 100 })).rejects.toThrow(/kind/i);
    expect(readLedgers(db).votes).toEqual([]);
  });
  it("resumes only the persisted selected session and merges exact causes across batches", async () => {
    const db = store(), calls: string[] = [];
    const analyze = async (s: MiningSession, events: MiningSession["events"]) => { calls.push(s.sessionId); return analysis(events[0]!.id); };
    await mineBatch({ store: db, sessions: [session()], analyze, redact, nowMs: NOW + 100 });
    await mineBatch({ store: db, sessions: [session("another", 2), session("session-one", 2)], analyze, redact, nowMs: NOW + 200 });
    expect(calls).toEqual(["session-one", "session-one"]);
    expect(readLedgers(db).problems).toHaveLength(1);
    expect(readLedgers(db).votes).toHaveLength(2);
  });
  it("allows explicit matching to existing problems but rejects arbitrary IDs", async () => {
    const db = store();
    await mineBatch({ store: db, sessions: [session()], analyze: async () => analysis(), redact, nowMs: NOW + 100 });
    const p = readLedgers(db).problems[0]!;
    const matched = analysis("event-2"); matched.failures[0]!.matchedProblemId = p.id; matched.failures[0]!.rootCauseHypothesis = "A second hypothesis for the observed failure";
    await mineBatch({ store: db, sessions: [session("session-one", 2)], analyze: async () => matched, redact, nowMs: NOW + 200 });
    expect(readLedgers(db).problems[0]!.causes).toHaveLength(2);
    matched.failures[0]!.eventId = "event-3"; matched.failures[0]!.matchedProblemId = "nonexistent";
    await expect(mineBatch({ store: db, sessions: [session("session-one", 3)], analyze: async () => matched, redact, nowMs: NOW + 300 })).rejects.toThrow(/problem/i);
  });
  it("counts all task runs for the single loop vote while limiting model mining sessions", async () => {
    const db = store();
    const taskRuns = Array.from({ length: 6 }, (_, i) => ({ taskId: "task-one", runId: `run-${i}`, day: "2026-11-18", occurredAtMs: NOW + i, outcome: "succeeded" as const, originPluginId: null }));
    await mineBatch({ store: db, sessions: [], taskRuns, analyze: async () => ({ failures: [] }), redact, nowMs: NOW + 100 });
    await mineBatch({ store: db, sessions: [], taskRuns, analyze: async () => ({ failures: [] }), redact, nowMs: NOW + 200 });
    expect(readLedgers(db).votes.map(v => v.kind)).toEqual(["task_looped"]);
    expect(readLedgers(db).problems[0]!.causes[0]!.text).toMatch(/not established/);
  });
  it("never analyzes or votes on its own workers", async () => {
    const db = store(); let calls = 0;
    await mineBatch({ store: db, sessions: [{ ...session(), originPluginId: "self-improve" }], analyze: async () => { calls++; return analysis(); }, redact, nowMs: NOW + 100 });
    expect(calls).toBe(0); expect(readLedgers(db).votes).toEqual([]);
  });
  it("advances an explicit no-finding result but not a thrown model call", async () => {
    const db = store();
    await expect(mineBatch({ store: db, sessions: [session()], analyze: async () => { throw new Error("provider down"); }, redact, nowMs: NOW + 100 })).rejects.toThrow("provider down");
    expect(db.list("mining-cursors")).toEqual([]);
    await mineBatch({ store: db, sessions: [session()], analyze: async () => ({ failures: [] }), redact, nowMs: NOW + 200 });
    expect(db.list("mining-cursors")).toHaveLength(1);
  });
  it("limits parallel session agents and commits exact merges from concurrent results", async () => {
    const db = store(); let active = 0, maximum = 0;
    const sessions = Array.from({ length: 8 }, (_, i) => ({ ...session(`s-${i}`), taskId: `task-${i}` }));
    const analyze = async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return analysis(); };
    await mineBatch({ store: db, sessions, analyze, redact, nowMs: NOW + 100, concurrency: 3 });
    expect(maximum).toBe(3);
    expect(readLedgers(db).problems).toHaveLength(1);
    expect(readLedgers(db).votes).toHaveLength(8);
  });
  it("rolls back ledger writes when cursor persistence fails", async () => {
    const db = store(), put = db.put.bind(db);
    db.put = (...args) => { if (args[0] === "mining-cursors") throw new Error("cursor write failed"); return put(...args); };
    await expect(mineBatch({ store: db, sessions: [session()], analyze: async () => analysis(), redact, nowMs: NOW + 100 })).rejects.toThrow("cursor write failed");
    expect(readLedgers(db).votes).toEqual([]);
    expect(readLedgers(db).problems).toEqual([]);
    db.put = put;
    await mineBatch({ store: db, sessions: [session()], analyze: async () => analysis(), redact, nowMs: NOW + 200 });
    expect(readLedgers(db).votes).toHaveLength(1);
  });
  it("records scheduled-job errors once and excludes own failed jobs", async () => {
    const db = store();
    const jobRuns = [{ jobId: "scheduled", runId: "run-one", day: "2026-11-18", occurredAtMs: NOW, status: "failed" as const, originPluginId: null }, { jobId: "own", runId: "run-own", day: "2026-11-18", occurredAtMs: NOW, status: "failed" as const, originPluginId: "self-improve" }];
    for (let i = 0; i < 2; i++) await mineBatch({ store: db, sessions: [], jobRuns, analyze: async () => ({ failures: [] }), redact, nowMs: NOW + 100 });
    expect(readLedgers(db).votes.map(v => v.kind)).toEqual(["failed_job"]);
  });
  it("commits only a trusted analyzed prefix, preserving later events and recovered votes", async () => {
    const db = store(), original = session(), next = session("session-one", 2).events[0]!;
    const batch = { ...original, events: [...original.events, next] };
    const first = await mineBatch({ store: db, sessions: [batch], analyze: async () => ({ ...analysis(), analyzedEvents: [{ id: "event-1", sequence: 1 }] }), redact, nowMs: NOW + 100 });
    expect(first).toMatchObject({ eventsProcessed: 1, votesAdded: 1 });
    expect(db.list("mining-cursors")).toEqual([expect.objectContaining({ sequence: 1 })]);
    const second = await mineBatch({ store: db, sessions: [batch], analyze: async (_, events) => {
      expect(events.map(event => event.id)).toEqual(["event-2"]); return analysis("event-2");
    }, redact, nowMs: NOW + 200 });
    expect(second).toMatchObject({ eventsProcessed: 1, votesAdded: 1 });
    expect(db.list("mining-cursors")).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(readLedgers(db).votes).toHaveLength(2);
  });
  it.each([
    { prefix: [] },
    { prefix: [{ id: "event-2", sequence: 2 }] },
    { prefix: [{ id: "event-1", sequence: 2 }] },
    { prefix: [{ id: "event-1", sequence: 1 }, { id: "missing", sequence: 3 }] },
  ])("rejects an analyzed prefix that skips or changes event identities: $prefix", async ({ prefix }) => {
    const db = store(), batch = { ...session(), events: [...session().events, ...session("session-one", 2).events] };
    await expect(mineBatch({ store: db, sessions: [batch], analyze: async () => ({ failures: [], analyzedEvents: prefix }), redact, nowMs: NOW + 100 })).rejects.toThrow("exact event prefix");
    expect(db.list("mining-cursors")).toEqual([]); expect(readLedgers(db).votes).toEqual([]);
  });
  it("rejects findings outside the analyzed prefix without advancing the cursor", async () => {
    const db = store(), batch = { ...session(), events: [...session().events, ...session("session-one", 2).events] };
    await expect(mineBatch({ store: db, sessions: [batch], analyze: async () => ({ ...analysis("event-2"), analyzedEvents: [{ id: "event-1", sequence: 1 }] }), redact, nowMs: NOW + 100 })).rejects.toThrow("unavailable event");
    expect(db.list("mining-cursors")).toEqual([]); expect(readLedgers(db).votes).toEqual([]);
  });

});
