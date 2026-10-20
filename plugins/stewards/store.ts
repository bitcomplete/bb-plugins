// The durable side of stewards: bindings, their status records and action
// logs, escalations, workers, and one row per project steward. SQLite through
// the plugin's database, migrated append-only like linear's and github's.
//
// The binding row is the truth a steward is woken from. Its transcript is
// not: a wake carries everything the steward needs, read from here and from a
// fresh snapshot, so compaction loses nothing that matters.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { entitySnapshotSchema, type Source } from "./source-contract.js";
import type { BindingKind, EscalationKind, Stage } from "./config.js";
import { depsLookSchema, type DepsLook } from "./deps.js";
import { opsLookSchema, type FingerprintRow, type OpsLook } from "./ops.js";

// Append-only: bb.storage.migrate records each statement's hash and refuses a
// changed one, so a schema change is a new statement at the end.
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS bindings (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     source TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     entity_key TEXT NOT NULL,
     url TEXT,
     title TEXT,
     kind TEXT NOT NULL,
     playbook TEXT NOT NULL,
     playbook_version TEXT NOT NULL,
     thread_id TEXT,
     parent_binding_id TEXT,
     phase TEXT,
     stage TEXT,
     guidance TEXT NOT NULL DEFAULT '[]',
     ready TEXT NOT NULL DEFAULT '{}',
     priority TEXT,
     hold TEXT,
     model_steward TEXT,
     model_worker TEXT,
     status TEXT,
     status_at INTEGER,
     advanced_at INTEGER,
     requeue_at INTEGER,
     last_snapshot TEXT,
     last_judgment_at INTEGER,
     comment_cursor TEXT NOT NULL DEFAULT '',
     pending TEXT NOT NULL DEFAULT '[]',
     awaiting_report INTEGER NOT NULL DEFAULT 0,
     woke_at INTEGER,
     missed_reports INTEGER NOT NULL DEFAULT 0,
     ending TEXT,
     ending_at INTEGER,
     manual_detach INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     ended_at INTEGER,
     end_reason TEXT,
     UNIQUE (project_id, source, entity_id)
   )`,
  `CREATE INDEX IF NOT EXISTS bindings_thread ON bindings (thread_id)`,
  `CREATE INDEX IF NOT EXISTS bindings_entity ON bindings (source, entity_id)`,
  `CREATE TABLE IF NOT EXISTS escalations (
     id TEXT PRIMARY KEY,
     binding_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     question TEXT NOT NULL,
     meanwhile TEXT NOT NULL,
     route TEXT NOT NULL,
     recommendation TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     resolution TEXT,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS escalations_binding ON escalations (binding_id, status)`,
  `CREATE TABLE IF NOT EXISTS workers (
     thread_id TEXT PRIMARY KEY,
     binding_id TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     result TEXT,
     started_at INTEGER NOT NULL,
     ended_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS workers_binding ON workers (binding_id)`,
  `CREATE TABLE IF NOT EXISTS project_stewards (
     project_id TEXT PRIMARY KEY,
     thread_id TEXT,
     digest TEXT,
     digest_at INTEGER,
     nightly_date TEXT,
     digest_pending INTEGER NOT NULL DEFAULT 0
   )`,
  // The title this plugin last put on the project steward, so a rename by hand sticks.
  `ALTER TABLE project_stewards ADD COLUMN title TEXT`,
  // A terminal binding its steward kept open to finish what the entity's state does not cover.
  `ALTER TABLE bindings ADD COLUMN follow_through TEXT`,
  `ALTER TABLE bindings ADD COLUMN follow_through_until INTEGER`,
  // A wake turn reported that it waits on someone else: archive the steward when it goes idle.
  `ALTER TABLE bindings ADD COLUMN archive_when_idle INTEGER NOT NULL DEFAULT 0`,
  // The sidebar section the project's stewards are put in. Kept after the section is deleted by hand, so it stays deleted.
  `ALTER TABLE project_stewards ADD COLUMN section_id TEXT`,
  // Threads already put in their project's section once; where they sit after that is the user's.
  `CREATE TABLE IF NOT EXISTS placed_threads (
     thread_id TEXT PRIMARY KEY,
     placed_at INTEGER NOT NULL
   )`,
  // Questions put to the user: asked by the project steward (steward_update ask) or an escalation it forwarded.
  `CREATE TABLE IF NOT EXISTS questions (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     binding_id TEXT,
     escalation_id TEXT,
     question TEXT NOT NULL,
     context TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     answer TEXT,
     answered_by TEXT,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   )`,
  // When an escalation was first put to the project steward as new; later prompts list it as still open.
  `ALTER TABLE escalations ADD COLUMN delivered_at INTEGER`,
  // Escalations open before delivery was recorded were all delivered already.
  `UPDATE escalations SET delivered_at = created_at WHERE status = 'open' AND delivered_at IS NULL`,
  // "Needs you" items: one structured thing the user (or the page's buttons) must
  // do for a binding. Deduplicated per (binding, kind, url) while open.
  `CREATE TABLE IF NOT EXISTS needs (
     id TEXT PRIMARY KEY,
     binding_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     url TEXT NOT NULL DEFAULT '',
     what TEXT NOT NULL,
     how TEXT,
     data TEXT NOT NULL DEFAULT '{}',
     filed_by TEXT NOT NULL DEFAULT 'steward',
     status TEXT NOT NULL DEFAULT 'open',
     resolution TEXT,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS needs_binding ON needs (binding_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS needs_open_key ON needs (binding_id, kind, url) WHERE status = 'open'`,
  // An ops binding's last look at its target: what it found, classified against the fingerprint map.
  `ALTER TABLE bindings ADD COLUMN ops_look TEXT`,
  // The fingerprint map: one problem an ops steward has seen, and the Linear ticket it was filed or commented on under.
  `CREATE TABLE IF NOT EXISTS ops_fingerprints (
     project_id TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     binding_id TEXT NOT NULL,
     summary TEXT NOT NULL,
     ticket_key TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     seen_count INTEGER NOT NULL DEFAULT 1,
     filed_at INTEGER,
     last_commented_at INTEGER,
     PRIMARY KEY (project_id, fingerprint)
   )`,
  // A Dependabot alert binding's last look at its repository: the open alerts,
  // classified against the fingerprint map.
  `ALTER TABLE bindings ADD COLUMN deps_look TEXT`,
  // A dependency fingerprint's severity and ecosystem, so a new medium or low
  // alert can be batched against the open ticket for its repo and ecosystem.
  `ALTER TABLE ops_fingerprints ADD COLUMN severity TEXT`,
  `ALTER TABLE ops_fingerprints ADD COLUMN ecosystem TEXT`,
  // Scheduling: the paths a binding's work changes (steward_report touches), the open
  // bindings a hold waits behind (steward_update hold + behind), and the conflicts
  // the project steward was last asked to schedule it against.
  `ALTER TABLE bindings ADD COLUMN touches TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE bindings ADD COLUMN hold_behind TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE bindings ADD COLUMN schedule_asked TEXT NOT NULL DEFAULT '[]'`,
  // A ticket whose gate has passed and that nothing holds or schedules: about to start, so it counts as in flight before Linear says so.
  `ALTER TABLE bindings ADD COLUMN cleared_to_start INTEGER NOT NULL DEFAULT 0`,
];

// ---- values kept as JSON ------------------------------------------------------------

export const guidanceEntrySchema = z.object({ at: z.number(), text: z.string(), by: z.string() });
export type GuidanceEntry = z.infer<typeof guidanceEntrySchema>;

export const readyStateSchema = z.object({
  checklist: z.array(z.object({ item: z.string(), met: z.boolean(), note: z.string().nullable().default(null) })).default([]),
  substantial: z.boolean().nullable().default(null),
  why: z.string().nullable().default(null),
  approval: z.object({ at: z.number(), specHash: z.string(), by: z.string() }).nullable().default(null),
  /** Set when an approval was voided, so the steward knows to ask again. */
  voidedAt: z.number().nullable().default(null),
  /** The spec an approval request was declined for: not asked again until the spec changes. */
  declinedSpecHash: z.string().nullable().default(null),
});
export type ReadyState = z.infer<typeof readyStateSchema>;

export const ACTORS = ["me", "steward", "other"] as const;

export const statusRecordSchema = z.object({
  phase: z.string(),
  summary: z.string(),
  nextAction: z.string(),
  actor: z.enum(ACTORS),
  blockedOn: z.string().nullable(),
  requeueAfterMs: z.number().nullable(),
  conditions: z.array(z.string()),
  resources: z.object({ workers: z.array(z.string()), pullRequests: z.array(z.string()), children: z.array(z.string()) }),
  at: z.number(),
});
export type StatusRecord = z.infer<typeof statusRecordSchema>;

/**
 * What the mechanical tier last observed: the entity, and for a ticket the
 * pull requests linked to it. Compared with the next observation to decide
 * whether a judgment turn is due.
 */
export const observedSchema = z.object({ entity: entitySnapshotSchema, pulls: z.array(entitySnapshotSchema).default([]) });
export type Observed = z.infer<typeof observedSchema>;

/** Why a binding is due a judgment turn, queued until the next wake. */
/** A reason for the next judgment turn. A quiet one is news for that turn but does not make it due. */
export const noteSchema = z.object({ at: z.number(), text: z.string(), quiet: z.boolean().optional() });
export type Note = z.infer<typeof noteSchema>;


function json<T>(schema: z.ZodType<T>, raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

// ---- bindings --------------------------------------------------------------------------

/** Where a binding's entity lives: a source plugin's, or "ops" for a watch target, which the plugin reads itself. */
export type BindingSource = Source | "ops";

export type Binding = {
  id: string;
  projectId: string;
  source: BindingSource;
  entityId: string;
  entityKey: string;
  url: string | null;
  title: string | null;
  kind: BindingKind;
  playbook: string;
  playbookVersion: string;
  threadId: string | null;
  parentBindingId: string | null;
  phase: string | null;
  stage: Stage | null;
  guidance: GuidanceEntry[];
  ready: ReadyState;
  priority: string | null;
  hold: string | null;
  /** The repo-relative paths this binding's work changes, as reported; what scheduling compares. */
  touches: string[];
  /** Entity keys of the bindings this hold waits behind: the hold lifts itself when every one has merged its pull requests or ended. */
  holdBehind: string[];
  /** Entity keys the project steward was last asked to schedule this binding against; asked again only for a new one. */
  scheduleAsked: string[];
  /** The gate has passed and nothing holds or schedules it: it is starting, whatever Linear still says, so others schedule against it. */
  clearedToStart: boolean;
  modelSteward: string | null;
  modelWorker: string | null;
  status: StatusRecord | null;
  statusAt: number | null;
  /** When the status record last moved: a new phase, summary or next action. */
  advancedAt: number | null;
  requeueAt: number | null;
  lastSnapshot: Observed | null;
  lastJudgmentAt: number | null;
  /** The newest comment time the steward has been shown. */
  commentCursor: string;
  pending: Note[];
  awaitingReport: boolean;
  wokeAt: number | null;
  missedReports: number;
  /** The wake turn under way reported actor "other": archive the thread when it goes idle. */
  archiveWhenIdle: boolean;
  /** A wrap-up or stop turn is under way: "terminal" or "detach". */
  ending: string | null;
  endingAt: number | null;
  /** What the steward said remains after a terminal state; set, the ending waits for it. */
  followThrough: string | null;
  /** When follow-through runs out, whatever the steward says: set when it is first declared. */
  followThroughUntil: number | null;
  manualDetach: boolean;
  /** An ops binding's last look; null for every other kind. */
  opsLook: OpsLook | null;
  /** A Dependabot alert binding's last look; null for every other kind. */
  depsLook: DepsLook | null;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
};

type BindingRow = Record<string, unknown> & { id: string };

const readyDefault = (): ReadyState => readyStateSchema.parse({});

function rowToBinding(r: BindingRow): Binding {
  const str = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  const num = (k: string) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  return {
    id: r.id,
    projectId: String(r.project_id),
    source: String(r.source) as BindingSource,
    entityId: String(r.entity_id),
    entityKey: String(r.entity_key),
    url: str("url"),
    title: str("title"),
    kind: String(r.kind) as BindingKind,
    playbook: String(r.playbook),
    playbookVersion: String(r.playbook_version),
    threadId: str("thread_id"),
    parentBindingId: str("parent_binding_id"),
    phase: str("phase"),
    stage: str("stage") as Stage | null,
    guidance: json(z.array(guidanceEntrySchema), str("guidance"), []),
    ready: json(readyStateSchema, str("ready"), readyDefault()),
    priority: str("priority"),
    hold: str("hold"),
    touches: json(z.array(z.string()), str("touches"), []),
    holdBehind: json(z.array(z.string()), str("hold_behind"), []),
    scheduleAsked: json(z.array(z.string()), str("schedule_asked"), []),
    clearedToStart: Number(r.cleared_to_start ?? 0) === 1,
    modelSteward: str("model_steward"),
    modelWorker: str("model_worker"),
    status: json(statusRecordSchema.nullable(), str("status"), null),
    statusAt: num("status_at"),
    advancedAt: num("advanced_at"),
    requeueAt: num("requeue_at"),
    lastSnapshot: json(observedSchema.nullable(), str("last_snapshot"), null),
    lastJudgmentAt: num("last_judgment_at"),
    commentCursor: String(r.comment_cursor ?? ""),
    pending: json(z.array(noteSchema), str("pending"), []),
    awaitingReport: Number(r.awaiting_report) === 1,
    wokeAt: num("woke_at"),
    missedReports: Number(r.missed_reports ?? 0),
    archiveWhenIdle: Number(r.archive_when_idle ?? 0) === 1,
    ending: str("ending"),
    endingAt: num("ending_at"),
    followThrough: str("follow_through"),
    followThroughUntil: num("follow_through_until"),
    manualDetach: Number(r.manual_detach) === 1,
    opsLook: json(opsLookSchema.nullable(), str("ops_look"), null),
    depsLook: json(depsLookSchema.nullable(), str("deps_look"), null),
    createdAt: Number(r.created_at),
    endedAt: num("ended_at"),
    endReason: str("end_reason"),
  };
}

/** Field names a caller may patch, and their column. */
const COLUMNS = {
  entityKey: "entity_key",
  url: "url",
  title: "title",
  playbook: "playbook",
  playbookVersion: "playbook_version",
  threadId: "thread_id",
  parentBindingId: "parent_binding_id",
  phase: "phase",
  stage: "stage",
  guidance: "guidance",
  ready: "ready",
  priority: "priority",
  hold: "hold",
  touches: "touches",
  holdBehind: "hold_behind",
  scheduleAsked: "schedule_asked",
  clearedToStart: "cleared_to_start",
  modelSteward: "model_steward",
  modelWorker: "model_worker",
  status: "status",
  statusAt: "status_at",
  advancedAt: "advanced_at",
  requeueAt: "requeue_at",
  lastSnapshot: "last_snapshot",
  lastJudgmentAt: "last_judgment_at",
  commentCursor: "comment_cursor",
  pending: "pending",
  awaitingReport: "awaiting_report",
  wokeAt: "woke_at",
  missedReports: "missed_reports",
  archiveWhenIdle: "archive_when_idle",
  ending: "ending",
  endingAt: "ending_at",
  followThrough: "follow_through",
  followThroughUntil: "follow_through_until",
  manualDetach: "manual_detach",
  opsLook: "ops_look",
  depsLook: "deps_look",
  endedAt: "ended_at",
  endReason: "end_reason",
} as const satisfies Partial<Record<keyof Binding, string>>;

export type BindingPatch = Partial<Pick<Binding, keyof typeof COLUMNS>>;

function toColumn(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export type NewBinding = Pick<Binding, "projectId" | "source" | "entityId" | "entityKey" | "url" | "title" | "kind" | "playbook" | "playbookVersion" | "parentBindingId" | "phase" | "stage">;

// ---- escalations, actions, workers --------------------------------------------------------

export type EscalationRoute = "parent" | "project" | "me";

export type Escalation = {
  id: string;
  bindingId: string;
  kind: EscalationKind;
  question: string;
  meanwhile: string;
  route: EscalationRoute;
  recommendation: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
  /** When the project steward was first sent it as new. */
  deliveredAt: number | null;
};

/**
 * A question put to the user, kept until it is answered so the project
 * steward lists it from here, not from its transcript. One made by forwarding
 * an escalation closes with that escalation, and closing it resolves the
 * escalation: the two records never disagree.
 */
export type Question = {
  id: string;
  projectId: string;
  bindingId: string | null;
  escalationId: string | null;
  question: string;
  context: string | null;
  status: "open" | "answered";
  answer: string | null;
  /** The thread that recorded the answer, or "user" from the page. */
  answeredBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

/** The kinds of thing that can wait on the user, from the ticket's table. */
export const NEEDS_KINDS = ["approve-spec", "approve-pr", "merge", "decide", "provide-secret", "configure"] as const;
export type NeedKind = (typeof NEEDS_KINDS)[number];

/**
 * One "needs you" item: a structured thing the user must do, filed by the
 * plugin from a snapshot or by a steward through `steward_report`. `url` is the
 * link (the ticket, the pull request, the external page); with `kind` it is the
 * dedupe key. `data` carries kind-specific fields (the pull request sha, the
 * secret's variable name, the worker thread to open).
 */
export type Need = {
  id: string;
  bindingId: string;
  kind: NeedKind;
  url: string;
  what: string;
  how: string | null;
  data: Record<string, unknown>;
  /** Who filed it: "plugin", "steward", "project" or "user". */
  filedBy: string;
  status: "open" | "done";
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

export type WorkerStatus = "running" | "finished" | "failed" | "stopped";
export type Worker = { threadId: string; bindingId: string; title: string; status: WorkerStatus; result: string | null; startedAt: number; endedAt: number | null };

/** One problem an ops steward has seen, and the ticket it is tracked under. */
export type Fingerprint = FingerprintRow & { projectId: string; bindingId: string; summary: string; lastSeenAt: number; seenCount: number; filedAt: number | null; severity: string | null; ecosystem: string | null };

/** What a steward reports doing about a fingerprint: filing a ticket, commenting on one, or reopening one. */
export type TicketAction = "filed" | "commented" | "reopened";

export type ProjectStewardRow = { projectId: string; threadId: string | null; digest: string | null; digestAt: number | null; nightlyDate: string | null; digestPending: boolean; title: string | null; sectionId: string | null };

/** Guidance repeated within this window is a retry, not new guidance. */
export const GUIDANCE_DEDUPE_MS = 5 * 60_000;

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export function createStore(db: Database.Database, now: () => number) {
  const getBinding = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE id = ?");
  const byEntity = db.prepare<[string, string], BindingRow>("SELECT * FROM bindings WHERE source = ? AND entity_id = ? COLLATE NOCASE ORDER BY created_at LIMIT 1");
  const byKey = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE entity_key = ? COLLATE NOCASE ORDER BY ended_at IS NOT NULL, created_at DESC");
  const byThread = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1");
  const openForProject = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE project_id = ? AND ended_at IS NULL ORDER BY created_at");
  const allForProject = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE project_id = ? ORDER BY created_at");
  const allOpen = db.prepare<[], BindingRow>("SELECT * FROM bindings WHERE ended_at IS NULL ORDER BY created_at");
  const all = db.prepare<[], BindingRow>("SELECT * FROM bindings ORDER BY created_at");
  const children = db.prepare<[string], BindingRow>("SELECT * FROM bindings WHERE parent_binding_id = ? AND ended_at IS NULL ORDER BY created_at");
  const isPlaced = db.prepare<[string], { thread_id: string }>("SELECT thread_id FROM placed_threads WHERE thread_id = ?");
  const markPlaced = db.prepare<[string, number]>("INSERT OR IGNORE INTO placed_threads (thread_id, placed_at) VALUES (?, ?)");
  const dueRequeue = db.prepare<[number], BindingRow>("SELECT * FROM bindings WHERE ended_at IS NULL AND requeue_at IS NOT NULL AND requeue_at <= ? ORDER BY requeue_at");
  const insertBinding = db.prepare(
    `INSERT INTO bindings (id, project_id, source, entity_id, entity_key, url, title, kind, playbook, playbook_version, parent_binding_id, phase, stage, created_at)
     VALUES (@id, @project_id, @source, @entity_id, @entity_key, @url, @title, @kind, @playbook, @playbook_version, @parent_binding_id, @phase, @stage, @created_at)`,
  );

  const insertEscalation = db.prepare(
    "INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, recommendation, created_at) VALUES (@id, @binding_id, @kind, @question, @meanwhile, @route, @recommendation, @created_at)",
  );
  const getEscalation = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE id = ?");
  const openEscalations = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE binding_id = ? AND status = 'open' ORDER BY created_at");
  const escalationsFor = db.prepare<[string, number], Record<string, unknown>>("SELECT * FROM escalations WHERE binding_id = ? ORDER BY created_at DESC LIMIT ?");
  const resolveEscalation = db.prepare("UPDATE escalations SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'");
  const appendResolution = db.prepare("UPDATE escalations SET resolution = ? WHERE id = ? AND status = 'resolved'");
  const rerouteEscalation = db.prepare("UPDATE escalations SET route = ?, recommendation = ?, delivered_at = NULL WHERE id = ? AND status = 'open'");
  const markDelivered = db.prepare("UPDATE escalations SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
  const clearDelivered = db.prepare("UPDATE escalations SET delivered_at = NULL WHERE id = ? AND delivered_at = ?");
  const lastResolvedOfKind = db.prepare<[string, string], { resolved_at: number }>("SELECT resolved_at FROM escalations WHERE binding_id = ? AND kind = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1");

  const insertQuestion = db.prepare(
    "INSERT INTO questions (id, project_id, binding_id, escalation_id, question, context, created_at) VALUES (@id, @project_id, @binding_id, @escalation_id, @question, @context, @created_at)",
  );
  const getQuestion = db.prepare<[string], Record<string, unknown>>("SELECT * FROM questions WHERE id = ?");
  const openQuestions = db.prepare<[string], Record<string, unknown>>("SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY created_at");
  const answeredSince = db.prepare<[string, number], Record<string, unknown>>("SELECT * FROM questions WHERE project_id = ? AND status = 'answered' AND resolved_at >= ? ORDER BY resolved_at");
  const answerQuestion = db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'");
  const answerForEscalation = db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, resolved_at = ? WHERE escalation_id = ? AND status = 'open'");
  const appendAnswerForEscalation = db.prepare("UPDATE questions SET answer = ? WHERE escalation_id = ? AND status = 'answered'");

  const insertWorker = db.prepare("INSERT INTO workers (thread_id, binding_id, title, status, started_at) VALUES (?, ?, ?, 'running', ?)");
  const getWorker = db.prepare<[string], Record<string, unknown>>("SELECT * FROM workers WHERE thread_id = ?");
  const workersFor = db.prepare<[string], Record<string, unknown>>("SELECT * FROM workers WHERE binding_id = ? ORDER BY started_at");
  const spawnsSince = db.prepare<[string, number], { n: number }>("SELECT COUNT(*) AS n FROM workers WHERE binding_id = ? AND started_at >= ?");
  const setWorker = db.prepare("UPDATE workers SET status = ?, result = ?, ended_at = ? WHERE thread_id = ?");

  const getFingerprint = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM ops_fingerprints WHERE project_id = ? AND fingerprint = ?");
  const fingerprintsFor = db.prepare<[string], Record<string, unknown>>("SELECT * FROM ops_fingerprints WHERE binding_id = ? ORDER BY first_seen_at");
  const sight = db.prepare(
    `INSERT INTO ops_fingerprints (project_id, fingerprint, binding_id, summary, severity, ecosystem, first_seen_at, last_seen_at) VALUES (@project_id, @fingerprint, @binding_id, @summary, @severity, @ecosystem, @at, @at)
     ON CONFLICT (project_id, fingerprint) DO UPDATE SET binding_id = @binding_id, summary = @summary, last_seen_at = @at, seen_count = seen_count + 1,
       severity = COALESCE(@severity, severity), ecosystem = COALESCE(@ecosystem, ecosystem)`,
  );
  const setTicket = db.prepare("UPDATE ops_fingerprints SET ticket_key = ?, filed_at = ?, last_commented_at = ? WHERE project_id = ? AND fingerprint = ?");
  const setCommented = db.prepare("UPDATE ops_fingerprints SET ticket_key = ?, last_commented_at = ? WHERE project_id = ? AND fingerprint = ?");

  const getProject = db.prepare<[string], Record<string, unknown>>("SELECT * FROM project_stewards WHERE project_id = ?");
  const byProjectThread = db.prepare<[string], Record<string, unknown>>("SELECT * FROM project_stewards WHERE thread_id = ?");
  const upsertProject = db.prepare("INSERT INTO project_stewards (project_id) VALUES (?) ON CONFLICT (project_id) DO NOTHING");

  const toEscalation = (r: Record<string, unknown>): Escalation => ({
    id: String(r.id),
    bindingId: String(r.binding_id),
    kind: String(r.kind) as EscalationKind,
    question: String(r.question),
    meanwhile: String(r.meanwhile),
    route: String(r.route) as EscalationRoute,
    recommendation: r.recommendation === null ? null : String(r.recommendation),
    status: String(r.status) as "open" | "resolved",
    resolution: r.resolution === null ? null : String(r.resolution),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
    deliveredAt: r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
  });
  const toQuestion = (r: Record<string, unknown>): Question => ({
    id: String(r.id),
    projectId: String(r.project_id),
    bindingId: r.binding_id === null ? null : String(r.binding_id),
    escalationId: r.escalation_id === null ? null : String(r.escalation_id),
    question: String(r.question),
    context: r.context === null ? null : String(r.context),
    status: String(r.status) as "open" | "answered",
    answer: r.answer === null ? null : String(r.answer),
    answeredBy: r.answered_by === null ? null : String(r.answered_by),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
  });
  const insertNeed = db.prepare(
    "INSERT INTO needs (id, binding_id, kind, url, what, how, data, filed_by, created_at) VALUES (@id, @binding_id, @kind, @url, @what, @how, @data, @filed_by, @created_at)",
  );
  const getNeed = db.prepare<[string], Record<string, unknown>>("SELECT * FROM needs WHERE id = ?");
  const openNeedByKey = db.prepare<[string, string, string], Record<string, unknown>>("SELECT * FROM needs WHERE binding_id = ? AND kind = ? AND url = ? AND status = 'open' LIMIT 1");
  const needsFor = db.prepare<[string, number], Record<string, unknown>>("SELECT * FROM needs WHERE binding_id = ? AND (? = 1 OR status = 'open') ORDER BY created_at");
  const openNeedsForProject = db.prepare<[string], Record<string, unknown>>("SELECT n.* FROM needs n JOIN bindings b ON b.id = n.binding_id WHERE b.project_id = ? AND n.status = 'open' ORDER BY n.created_at");
  const allNeedsForProject = db.prepare<[string], Record<string, unknown>>("SELECT n.* FROM needs n JOIN bindings b ON b.id = n.binding_id WHERE b.project_id = ? ORDER BY n.created_at");
  const updateNeed = db.prepare("UPDATE needs SET what = ?, how = ?, data = ? WHERE id = ?");
  const closeNeedStmt = db.prepare("UPDATE needs SET status = 'done', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'");
  const closeNeedKindStmt = db.prepare("UPDATE needs SET status = 'done', resolution = ?, resolved_at = ? WHERE binding_id = ? AND kind = ? AND status = 'open'");
  const closeNeedKeyStmt = db.prepare("UPDATE needs SET status = 'done', resolution = ?, resolved_at = ? WHERE binding_id = ? AND kind = ? AND url = ? AND status = 'open'");

  const toNeed = (r: Record<string, unknown>): Need => ({
    id: String(r.id),
    bindingId: String(r.binding_id),
    kind: String(r.kind) as NeedKind,
    url: String(r.url ?? ""),
    what: String(r.what),
    how: r.how === null || r.how === undefined ? null : String(r.how),
    data: json(z.record(z.string(), z.unknown()), r.data === null || r.data === undefined ? null : String(r.data), {}),
    filedBy: String(r.filed_by ?? "steward"),
    status: String(r.status) as "open" | "done",
    resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  });

  const toWorker = (r: Record<string, unknown>): Worker => ({
    threadId: String(r.thread_id),
    bindingId: String(r.binding_id),
    title: String(r.title),
    status: String(r.status) as WorkerStatus,
    result: r.result === null ? null : String(r.result),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
  });
  const toFingerprint = (r: Record<string, unknown>): Fingerprint => ({
    projectId: String(r.project_id),
    fingerprint: String(r.fingerprint),
    bindingId: String(r.binding_id),
    summary: String(r.summary),
    ticketKey: r.ticket_key === null ? null : String(r.ticket_key),
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
    seenCount: Number(r.seen_count),
    filedAt: r.filed_at === null ? null : Number(r.filed_at),
    lastCommentedAt: r.last_commented_at === null ? null : Number(r.last_commented_at),
    severity: r.severity === null || r.severity === undefined ? null : String(r.severity),
    ecosystem: r.ecosystem === null || r.ecosystem === undefined ? null : String(r.ecosystem),
  });
  const toProject = (r: Record<string, unknown>): ProjectStewardRow => ({
    projectId: String(r.project_id),
    threadId: r.thread_id === null ? null : String(r.thread_id),
    digest: r.digest === null ? null : String(r.digest),
    digestAt: r.digest_at === null ? null : Number(r.digest_at),
    nightlyDate: r.nightly_date === null ? null : String(r.nightly_date),
    digestPending: Number(r.digest_pending) === 1,
    title: r.title === null || r.title === undefined ? null : String(r.title),
    sectionId: r.section_id === null || r.section_id === undefined ? null : String(r.section_id),
  });

  /** Resolve an open escalation, and close the question forwarding it made, if any. `by` is who answered it. */
  function resolve(id: string, resolution: string, by = "plugin"): boolean {
    return db.transaction(() => {
      const at = now();
      if (resolveEscalation.run(resolution, at, id).changes === 0) return false;
      answerForEscalation.run(resolution, by, at, id);
      return true;
    })();
  }

  function patch(id: string, fields: BindingPatch): Binding {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as Array<[keyof typeof COLUMNS, unknown]>;
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(", ");
      db.prepare(`UPDATE bindings SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => toColumn(v)), id);
    }
    return rowToBinding(getBinding.get(id)!);
  }

  return {
    binding(id: string): Binding | null {
      const r = getBinding.get(id);
      return r === undefined ? null : rowToBinding(r);
    },
    byEntity(source: BindingSource, entityId: string): Binding | null {
      const r = byEntity.get(source, entityId);
      return r === undefined ? null : rowToBinding(r);
    },
    /** By key (ENG-12, owner/repo#3) or binding id: open bindings first, then the newest. */
    /** A binding by id or entity key; with a project, only that project's. */
    find(keyOrId: string, projectId?: string): Binding | null {
      const inProject = (r: BindingRow) => projectId === undefined || r.project_id === projectId;
      const direct = getBinding.get(keyOrId);
      if (direct !== undefined && inProject(direct)) return rowToBinding(direct);
      const r = byKey.all(keyOrId).find(inProject);
      return r === undefined ? null : rowToBinding(r);
    },
    byThread(threadId: string): Binding | null {
      const r = byThread.get(threadId);
      return r === undefined ? null : rowToBinding(r);
    },
    open(projectId?: string): Binding[] {
      return (projectId === undefined ? allOpen.all() : openForProject.all(projectId)).map(rowToBinding);
    },
    all(projectId?: string): Binding[] {
      return (projectId === undefined ? all.all() : allForProject.all(projectId)).map(rowToBinding);
    },
    children(bindingId: string): Binding[] {
      return children.all(bindingId).map(rowToBinding);
    },
    dueRequeue(): Binding[] {
      return dueRequeue.all(now()).map(rowToBinding);
    },
    create(fields: NewBinding): Binding {
      const id = newId("bnd");
      insertBinding.run({
        id,
        project_id: fields.projectId,
        source: fields.source,
        entity_id: fields.entityId,
        entity_key: fields.entityKey,
        url: fields.url,
        title: fields.title,
        kind: fields.kind,
        playbook: fields.playbook,
        playbook_version: fields.playbookVersion,
        parent_binding_id: fields.parentBindingId,
        phase: fields.phase,
        stage: fields.stage,
        created_at: now(),
      });
      return rowToBinding(getBinding.get(id)!);
    },
    patch,
    /** Queue a reason for the next judgment turn; a quiet one waits for a turn something else makes due. */
    note(id: string, text: string, quiet = false): Binding {
      const b = rowToBinding(getBinding.get(id)!);
      const pending = [...b.pending, quiet ? { at: now(), text, quiet } : { at: now(), text }];
      // Past thirty, the oldest quiet note goes first, then the oldest of any.
      while (pending.length > 30) {
        const i = pending.findIndex((n) => n.quiet === true);
        pending.splice(i === -1 ? 0 : i, 1);
      }
      return patch(id, { pending });
    },
    /** Save guidance; false when it repeats the binding's last guidance by the same author within five minutes (a retry), which saves nothing. */
    addGuidance(id: string, text: string, by: string): boolean {
      const b = rowToBinding(getBinding.get(id)!);
      const last = b.guidance.at(-1);
      if (last !== undefined && last.text === text && last.by === by && now() - last.at < GUIDANCE_DEDUPE_MS) return false;
      patch(id, { guidance: [...b.guidance, { at: now(), text, by }].slice(-50) });
      return true;
    },
    /**
     * Record an approval on the gate and resolve the binding's open approval
     * escalations, in one transaction: answering an approval request approves
     * the current spec and closes the request together.
     */
    approve(bindingId: string, approval: NonNullable<ReadyState["approval"]>, resolution: string, by: string): void {
      db.transaction(() => {
        const b = rowToBinding(getBinding.get(bindingId)!);
        patch(bindingId, { ready: { ...b.ready, approval, voidedAt: null, declinedSpecHash: null } });
        closeNeedKindStmt.run("Approved.", now(), bindingId, "approve-spec");
        for (const x of openEscalations.all(bindingId).map(toEscalation).filter((e) => e.kind === "approval")) resolve(x.id, resolution, by);
      })();
    },
    /** Remember the current spec as declined and close its approval request, in one transaction. */
    decline(bindingId: string, specHash: string, resolution: string, by: string): void {
      db.transaction(() => {
        const b = rowToBinding(getBinding.get(bindingId)!);
        patch(bindingId, { ready: { ...b.ready, declinedSpecHash: specHash } });
        closeNeedKindStmt.run("Declined.", now(), bindingId, "approve-spec");
        for (const x of openEscalations.all(bindingId).map(toEscalation).filter((e) => e.kind === "approval")) resolve(x.id, resolution, by);
      })();
    },

    // escalations
    escalate(fields: { bindingId: string; kind: EscalationKind; question: string; meanwhile: string; route: EscalationRoute; recommendation: string | null }): Escalation {
      const id = newId("esc");
      insertEscalation.run({ id, binding_id: fields.bindingId, kind: fields.kind, question: fields.question, meanwhile: fields.meanwhile, route: fields.route, recommendation: fields.recommendation, created_at: now() });
      return toEscalation(getEscalation.get(id)!);
    },
    escalation(id: string): Escalation | null {
      const r = getEscalation.get(id);
      return r === undefined ? null : toEscalation(r);
    },
    openEscalations(bindingId: string): Escalation[] {
      return openEscalations.all(bindingId).map(toEscalation);
    },
    escalations(bindingId: string, limit = 20): Escalation[] {
      return escalationsFor.all(bindingId, limit).map(toEscalation);
    },
    resolve,
    /**
     * Record an answer: resolve the escalation if it is open; if it is
     * already resolved (the binding ended, a retry), append the answer to
     * what it says, and to the question forwarding it made, unless it
     * already says it.
     */
    answerEscalation(id: string, text: string, by: string): "resolved" | "appended" | "unchanged" {
      return db.transaction(() => {
        if (resolve(id, text, by)) return "resolved" as const;
        const x = getEscalation.get(id);
        const resolution = x === undefined || x.resolution === null ? "" : String(x.resolution);
        if (x === undefined || resolution === text || resolution.endsWith(`\n${text}`)) return "unchanged" as const;
        const appended = resolution === "" ? text : `${resolution}\n${text}`;
        appendResolution.run(appended, id);
        appendAnswerForEscalation.run(appended, id);
        return "appended" as const;
      })();
    },
    /** Mark escalations delivered to the project steward; returns the time, to undo with undeliver if the send fails. */
    markDelivered(ids: string[]): number {
      const at = now();
      for (const id of ids) markDelivered.run(at, id);
      return at;
    },
    undeliver(ids: string[], at: number): void {
      for (const id of ids) clearDelivered.run(id, at);
    },
    reroute(id: string, route: EscalationRoute, recommendation: string | null): boolean {
      return rerouteEscalation.run(route, recommendation, id).changes > 0;
    },
    lastResolved(bindingId: string, kind: EscalationKind): number | null {
      return lastResolvedOfKind.get(bindingId, kind)?.resolved_at ?? null;
    },

    // questions to the user
    ask(fields: { projectId: string; bindingId: string | null; escalationId: string | null; question: string; context: string | null }): Question {
      const id = newId("qst");
      insertQuestion.run({ id, project_id: fields.projectId, binding_id: fields.bindingId, escalation_id: fields.escalationId, question: fields.question, context: fields.context, created_at: now() });
      return toQuestion(getQuestion.get(id)!);
    },
    question(id: string): Question | null {
      const r = getQuestion.get(id);
      return r === undefined ? null : toQuestion(r);
    },
    openQuestions(projectId: string): Question[] {
      return openQuestions.all(projectId).map(toQuestion);
    },
    answeredSince(projectId: string, since: number): Question[] {
      return answeredSince.all(projectId, since).map(toQuestion);
    },
    /** Close an open question with its answer, and resolve the escalation it was forwarded for, if any. */
    answer(id: string, answer: string, by: string): boolean {
      return db.transaction(() => {
        const at = now();
        if (answerQuestion.run(answer, by, at, id).changes === 0) return false;
        const q = toQuestion(getQuestion.get(id)!);
        if (q.escalationId !== null) resolveEscalation.run(answer, at, q.escalationId);
        return true;
      })();
    },
    /**
     * Close an open question with its answer, leaving the escalation it was
     * forwarded for open. Used when the user's answer is ambiguous: the
     * project steward, not the plugin, decides what it means.
     */
    answerQuestionOnly(id: string, answer: string, by: string): boolean {
      return answerQuestion.run(answer, by, now(), id).changes > 0;
    },

    // needs: what waits on the user
    need(id: string): Need | null {
      const r = getNeed.get(id);
      return r === undefined ? null : toNeed(r);
    },
    needs(bindingId: string, includeDone = false): Need[] {
      return needsFor.all(bindingId, includeDone ? 1 : 0).map(toNeed);
    },
    openNeeds(bindingId: string): Need[] {
      return needsFor.all(bindingId, 0).map(toNeed);
    },
    openNeedsForProject(projectId: string): Need[] {
      return openNeedsForProject.all(projectId).map(toNeed);
    },
    allNeedsForProject(projectId: string): Need[] {
      return allNeedsForProject.all(projectId).map(toNeed);
    },
    /**
     * File a need, deduplicated by (binding, kind, url) while open: a steward
     * that re-reports one updates the wording rather than adding a row.
     */
    fileNeed(fields: { bindingId: string; kind: NeedKind; url: string; what: string; how: string | null; data?: Record<string, unknown>; filedBy?: string }): Need {
      const existing = openNeedByKey.get(fields.bindingId, fields.kind, fields.url);
      if (existing !== undefined) {
        updateNeed.run(fields.what, fields.how, JSON.stringify(fields.data ?? {}), existing.id);
        return toNeed(getNeed.get(String(existing.id))!);
      }
      const id = newId("need");
      insertNeed.run({ id, binding_id: fields.bindingId, kind: fields.kind, url: fields.url, what: fields.what, how: fields.how, data: JSON.stringify(fields.data ?? {}), filed_by: fields.filedBy ?? "steward", created_at: now() });
      return toNeed(getNeed.get(id)!);
    },
    closeNeed(id: string, resolution: string): boolean {
      return closeNeedStmt.run(resolution, now(), id).changes > 0;
    },
    closeNeeds(bindingId: string, kind: NeedKind, resolution: string): number {
      return closeNeedKindStmt.run(resolution, now(), bindingId, kind).changes;
    },
    closeNeedByKey(bindingId: string, kind: NeedKind, url: string, resolution: string): number {
      return closeNeedKeyStmt.run(resolution, now(), bindingId, kind, url).changes;
    },

    // workers
    addWorker(threadId: string, bindingId: string, title: string): void {
      insertWorker.run(threadId, bindingId, title, now());
    },
    worker(threadId: string): Worker | null {
      const r = getWorker.get(threadId);
      return r === undefined ? null : toWorker(r);
    },
    workers(bindingId: string): Worker[] {
      return workersFor.all(bindingId).map(toWorker);
    },
    spawnsSince(bindingId: string, since: number): number {
      return spawnsSince.get(bindingId, since)!.n;
    },
    setWorker(threadId: string, status: WorkerStatus, result: string | null): void {
      setWorker.run(status, result, status === "running" ? null : now(), threadId);
    },

    // the fingerprint map
    fingerprint(projectId: string, fingerprint: string): Fingerprint | null {
      const r = getFingerprint.get(projectId, fingerprint);
      return r === undefined ? null : toFingerprint(r);
    },
    fingerprints(bindingId: string): Fingerprint[] {
      return fingerprintsFor.all(bindingId).map(toFingerprint);
    },
    /** Record that a look saw these problems: new ones enter the map with no ticket, known ones count another sighting. */
    sight(projectId: string, bindingId: string, seen: Array<{ fingerprint: string; summary: string; severity?: string | null; ecosystem?: string | null }>): Map<string, Fingerprint> {
      return db.transaction(() => {
        const at = now();
        const out = new Map<string, Fingerprint>();
        for (const s of seen) {
          sight.run({ project_id: projectId, fingerprint: s.fingerprint, binding_id: bindingId, summary: s.summary, severity: s.severity ?? null, ecosystem: s.ecosystem ?? null, at });
          out.set(s.fingerprint, toFingerprint(getFingerprint.get(projectId, s.fingerprint)!));
        }
        return out;
      })();
    },
    /**
     * Record what a steward did about a problem. Filing or reopening points
     * the fingerprint at that ticket, so its next sighting is a comment there
     * and nothing new; a comment counts as the latest word on it. False when
     * the map has no such fingerprint.
     */
    recordTicket(projectId: string, fingerprint: string, ticketKey: string, did: TicketAction): boolean {
      const at = now();
      const key = ticketKey.toUpperCase();
      const changed = did === "commented" ? setCommented.run(key, at, projectId, fingerprint) : setTicket.run(key, at, at, projectId, fingerprint);
      return changed.changes > 0;
    },

    // project stewards
    project(projectId: string): ProjectStewardRow {
      upsertProject.run(projectId);
      return toProject(getProject.get(projectId)!);
    },
    projectByThread(threadId: string): ProjectStewardRow | null {
      const r = byProjectThread.get(threadId);
      return r === undefined ? null : toProject(r);
    },
    patchProject(projectId: string, fields: Partial<Omit<ProjectStewardRow, "projectId">>): ProjectStewardRow {
      upsertProject.run(projectId);
      const map: Record<string, string> = { threadId: "thread_id", digest: "digest", digestAt: "digest_at", nightlyDate: "nightly_date", digestPending: "digest_pending", title: "title", sectionId: "section_id" };
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length > 0) db.prepare(`UPDATE project_stewards SET ${entries.map(([k]) => `${map[k]} = ?`).join(", ")} WHERE project_id = ?`).run(...entries.map(([, v]) => toColumn(v)), projectId);
      return toProject(getProject.get(projectId)!);
    },
    projects(): ProjectStewardRow[] {
      return db.prepare<[], Record<string, unknown>>("SELECT * FROM project_stewards").all().map(toProject);
    },

    // threads put in their project's section
    placed(threadId: string): boolean {
      return isPlaced.get(threadId) !== undefined;
    },
    markPlaced(threadId: string): void {
      markPlaced.run(threadId, now());
    },
  };
}

export type Store = ReturnType<typeof createStore>;
