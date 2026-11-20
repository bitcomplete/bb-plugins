import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Stage } from "./domain/types.js";

/** Append only. Each statement has a committed hash in migrations.snapshot.json. */
export const MIGRATIONS = [
  `CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(namespace,key))`,
  `CREATE TABLE jobs (id TEXT PRIMARY KEY, stage TEXT NOT NULL, job_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, lease TEXT, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(stage,job_key))`,
  `CREATE INDEX due_jobs ON jobs(stage,status,available_at)`,
  `CREATE TABLE runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, lease TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, counts TEXT NOT NULL DEFAULT '{}', errors TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, before_value TEXT, after_value TEXT NOT NULL)`,
  `CREATE TABLE accounting (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE reservations (id TEXT PRIMARY KEY, at INTEGER NOT NULL, scope TEXT NOT NULL, currency TEXT NOT NULL, amount_micros INTEGER NOT NULL, status TEXT NOT NULL)`,
];
export interface Job { id: string; runId?: string; stage: Stage; key: string; input: Record<string, unknown>; attempts: number; createdAt: number }
export interface Run { id: string; jobId: string; stage: Stage; status: string; startedAt: number; endedAt: number | null; counts: Record<string, number>; errors: string[] }
export interface Actor { kind: "owner" | "chat" | "service"; id: string }
type Row = Record<string, unknown>;
const json = (value: unknown) => { const text = JSON.stringify(value); if (text === undefined || text.length > 4_000_000) throw new Error("record-size-invalid"); return text; };
export const stableId = (prefix: string, key: string) => `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

export class Store {
  constructor(readonly db: Database.Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  get<T>(namespace: string, key: string): T | null {
    const row = this.db.prepare("SELECT value FROM records WHERE namespace=? AND key=?").get(namespace, key) as Row | undefined;
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  list<T>(namespace: string): T[] {
    return (this.db.prepare("SELECT value FROM records WHERE namespace=? ORDER BY key").all(namespace) as Row[]).map(r => JSON.parse(String(r.value)) as T);
  }
  entries<T>(namespace: string): Array<{ key: string; value: T; version: number }> {
    return (this.db.prepare("SELECT key,value,version FROM records WHERE namespace=? ORDER BY key").all(namespace) as Row[]).map(r => ({ key: String(r.key), value: JSON.parse(String(r.value)) as T, version: Number(r.version) }));
  }
  version(namespace: string, key: string): number {
    return Number((this.db.prepare("SELECT version FROM records WHERE namespace=? AND key=?").get(namespace, key) as Row | undefined)?.version ?? 0);
  }
  put(namespace: string, key: string, value: unknown, now = Date.now()): void {
    this.db.prepare("INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,version=records.version+1,updated_at=excluded.updated_at").run(namespace, key, json(value), now);
  }
  remove(namespace: string, key: string): void { this.db.prepare("DELETE FROM records WHERE namespace=? AND key=?").run(namespace, key); }
  insert(namespace: string, key: string, value: unknown, now = Date.now()): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?)").run(namespace, key, json(value), now).changes === 1;
  }
  edit(namespace: string, key: string, expectedVersion: number, value: unknown, actor: Actor, reason: string): void {
    this.transaction(() => {
      if (!expectedVersion || this.version(namespace, key) !== expectedVersion) throw new Error("Record changed; reload before editing");
      const before = this.get(namespace, key);
      this.put(namespace, key, value);
      this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), Date.now(), namespace, key, json(actor), reason, json(before), json(value));
    });
  }
  createAudited(namespace: string, key: string, value: unknown, actor: Actor, reason: string): void {
    this.transaction(() => {
      if (!this.insert(namespace,key,value)) throw new Error("Record already exists");
      this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(),Date.now(),namespace,key,json(actor),reason,"null",json(value));
    });
  }
  audit(): Row[] { return this.db.prepare("SELECT * FROM audit ORDER BY at,id").all() as Row[]; }
  enqueue(stage: Stage, key: string, input: Record<string, unknown>, now = Date.now()): string {
    const id = stableId("job", `${stage}:${key}`);
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,stage,job_key,input,status,available_at,created_at) VALUES(?,?,?,?, 'queued',?,?)").run(id, stage, key, json(input), now, now);
    return id;
  }
  claim(stage: Stage, lease: string, now = Date.now()): Job | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE stage=? AND status='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1").get(stage, now) as Row | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET status='running',lease=?,attempts=attempts+1 WHERE id=? AND status='queued'").run(lease, row.id);
      const runId=randomUUID();
      this.db.prepare("INSERT INTO runs(id,job_id,stage,lease,status,started_at) VALUES(?,?,?,?,'running',?)").run(runId, row.id, stage, lease, now);
      return { id: String(row.id), runId, stage, key: String(row.job_key), input: JSON.parse(String(row.input)), attempts: Number(row.attempts) + 1, createdAt: Number(row.created_at) };
    });
  }
  private finish(id: string, lease: string, status: "succeeded" | "failed", counts: Record<string, number>, errors: string[], now: number, retryAt?: number): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET status=?,lease=NULL,available_at=? WHERE id=? AND lease=? AND status='running'").run(retryAt === undefined ? status : "queued", retryAt ?? now, id, lease);
      if (changed.changes !== 1) throw new Error("stale-job-lease");
      this.db.prepare("UPDATE runs SET status=?,ended_at=?,counts=?,errors=? WHERE job_id=? AND lease=? AND status='running'").run(status, now, json(counts), json(errors), id, lease);
    });
  }
  complete(id: string, lease: string, counts: Record<string, number>, now = Date.now()): void { this.finish(id, lease, "succeeded", counts, [], now); }
  fail(id: string, lease: string, code: string, now = Date.now(), retryAt?: number): void { this.finish(id, lease, "failed", {}, [code], now, retryAt); }
  recover(boot: string, now = Date.now()): number {
    return this.transaction(() => {
      this.db.prepare("UPDATE runs SET status='interrupted',ended_at=?,errors='[\"server-restarted\"]' WHERE status='running' AND lease<>?").run(now, boot);
      return this.db.prepare("UPDATE jobs SET status='queued',lease=NULL,available_at=? WHERE status='running' AND lease<>?").run(now, boot).changes;
    });
  }
  jobStatus(id: string): string | null { return (this.db.prepare("SELECT status FROM jobs WHERE id=?").get(id) as { status: string } | undefined)?.status ?? null; }
  runs(): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at,rowid").all() as Row[]).map(r => ({ id: String(r.id), jobId: String(r.job_id), stage: r.stage as Stage, status: String(r.status), startedAt: Number(r.started_at), endedAt: r.ended_at === null ? null : Number(r.ended_at), counts: JSON.parse(String(r.counts)), errors: JSON.parse(String(r.errors)) }));
  }
  pending(): Row[] { return this.db.prepare("SELECT id,stage,job_key,status,attempts,available_at FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as Row[]; }
}
