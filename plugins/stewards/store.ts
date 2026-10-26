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
import { deploymentsSchema, type Deployments } from "./deploy.js";
import { opsLookSchema, type FingerprintRow, type OpsLook } from "./ops.js";
import { sentryLookSchema, type SentryLook } from "./sentry.js";

// Append-only: bb.storage.migrate records each statement's hash and refuses a
// changed one, so a schema change is a new statement at the end.
export const BASE_MIGRATIONS = [
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
  // Fixed choices on a decide item's escalation and on the question a forwarded one makes: short labels, JSON, so the page can offer a button each (BB-20).
  `ALTER TABLE escalations ADD COLUMN choices TEXT`,
  `ALTER TABLE questions ADD COLUMN choices TEXT`,
  // A Sentry project binding's last look: the issues new, regressed or rung
  // since the look before, classified against the fingerprint map.
  `ALTER TABLE bindings ADD COLUMN sentry_look TEXT`,
  // A general rule the project steward drew from an escalation or its own
  // judgement, waiting to be made permanent in `.bb`. `procedure` lessons are
  // self-merged by the project steward; `boundary` ones change its own
  // escalation boundary and go to the user. `note` is the last refusal or
  // explanation, shown in the nightly prompt.
  `CREATE TABLE IF NOT EXISTS lessons (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     binding_id TEXT,
     escalation_id TEXT,
     file TEXT NOT NULL,
     text TEXT NOT NULL,
     scope TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     branch TEXT,
     merge_sha TEXT,
     note TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     resolved_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS lessons_project ON lessons (project_id, status)`,
  // The requester thread the plugin spawned for an open provide-secret need
  // (BB-22). `bb stewards secret import` accepts only this thread, only while
  // the need is open, and only for the need's own `setting`.
  `CREATE TABLE IF NOT EXISTS secret_requesters (
     thread_id TEXT PRIMARY KEY,
     need_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

// ---- the one escalation chain (BB-30) -----------------------------------------------
//
// Every hop of the chain is one `escalations` row: a worker's, a steward's, the
// project steward's and the project steward's ask to the user. The envelope is
// the columns added here; the payload is `question`; the human-boundary fields
// are `resolution_kind`, `choices`, `url` and `data`. `questions` and the
// steward-filed `needs` kinds migrate into it below, and both old tables are
// renamed rather than dropped, so a rollback keeps every row.
export const CHAIN_MIGRATIONS = [
  // Envelope: where it came from, the chain it passed through, where it is now.
  `ALTER TABLE escalations ADD COLUMN project_id TEXT`,
  `ALTER TABLE escalations ADD COLUMN origin TEXT`,
  `ALTER TABLE escalations ADD COLUMN chain TEXT NOT NULL DEFAULT '[]'`,
  // Human boundary: how the page asks, and what it needs to ask.
  `ALTER TABLE escalations ADD COLUMN resolution_kind TEXT`,
  `ALTER TABLE escalations ADD COLUMN url TEXT`,
  `ALTER TABLE escalations ADD COLUMN data TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE escalations ADD COLUMN answered_by TEXT`,
  // The escalation this row forwards, when it is a question made from one.
  `ALTER TABLE escalations ADD COLUMN forwarded_from TEXT`,
  // 1 when this row is a question the project steward kept (or a forwarded
  // non-approval escalation), so the page's questions list stays its own.
  `ALTER TABLE escalations ADD COLUMN is_question INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE escalations ADD COLUMN context TEXT`,
  // The pull-request head a project-steward approval is bound to.
  `ALTER TABLE escalations ADD COLUMN head_sha TEXT`,
  // A project steward's approval of an owner-reviewed pull request, bound to
  // the head sha: a new push is a new sha and voids it. It lives only here,
  // never as a GitHub comment or review.
  `CREATE TABLE IF NOT EXISTS project_approvals (
     binding_id TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     entry TEXT,
     by_thread TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (binding_id, head_sha)
   )`,
  // Every question becomes an escalation with route `me`, keeping its id and
  // its answer. Questions that were forwarded keep their link, so the page
  // still shows the question rather than the raw escalation.
  `INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, choices, status, resolution, created_at, resolved_at, delivered_at, project_id, forwarded_from, resolution_kind, answered_by, is_question, context, origin)
   SELECT q.id, COALESCE(q.binding_id, ''), 'decision', q.question, 'wait', 'me', q.choices,
          CASE WHEN q.status = 'open' THEN 'open' ELSE 'resolved' END,
          q.answer, q.created_at, q.resolved_at, q.created_at, q.project_id, q.escalation_id,
          CASE WHEN q.choices IS NOT NULL AND json_array_length(q.choices) > 0 THEN 'choice' ELSE 'text' END,
          q.answered_by, 1, q.context,
          json_object('threadId', NULL, 'bindingId', q.binding_id, 'chain', json('[]'))
   FROM questions q`,
  // An escalation whose forwarded question was answered is resolved with that answer.
  `UPDATE escalations
   SET status = 'resolved',
       resolution = COALESCE(resolution, (SELECT q.answer FROM questions q WHERE q.escalation_id = escalations.id AND q.status = 'answered' ORDER BY q.resolved_at DESC LIMIT 1)),
       resolved_at = COALESCE(resolved_at, (SELECT q.resolved_at FROM questions q WHERE q.escalation_id = escalations.id AND q.status = 'answered' ORDER BY q.resolved_at DESC LIMIT 1))
   WHERE status = 'open' AND EXISTS (SELECT 1 FROM questions q WHERE q.escalation_id = escalations.id AND q.status = 'answered')`,
  `ALTER TABLE questions RENAME TO questions_legacy`,
  // The steward-filed needs (decide, configure, provide-secret) become
  // escalations with route `me`; the plugin-filed gate items stay in `needs`.
  `INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, choices, status, resolution, created_at, resolved_at, delivered_at, project_id, resolution_kind, url, data, is_question, origin)
   SELECT n.id, n.binding_id, 'decision', n.what, 'wait', 'me',
          CASE WHEN n.data IS NOT NULL THEN json_extract(n.data, '$.choices') END,
          CASE WHEN n.status = 'open' THEN 'open' ELSE 'resolved' END,
          n.resolution, n.created_at, n.resolved_at, n.created_at,
          (SELECT b.project_id FROM bindings b WHERE b.id = n.binding_id),
          CASE WHEN n.kind = 'provide-secret' THEN 'secret' WHEN n.kind = 'configure' THEN 'done'
        WHEN n.data IS NOT NULL AND json_array_length(json_extract(n.data, '$.choices')) > 0 THEN 'choice' ELSE 'text' END,
          n.url, n.data, 0,
          json_object('threadId', NULL, 'bindingId', n.binding_id, 'chain', json('[]'))
   FROM needs n
   WHERE n.kind IN ('decide','configure','provide-secret')`,
  // Rename the old table rather than drop it, then rebuild `needs` for the
  // plugin's gate items and copy those rows across.
  `ALTER TABLE needs RENAME TO needs_legacy`,
  `DROP INDEX IF EXISTS needs_binding`,
  `DROP INDEX IF EXISTS needs_open_key`,
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
  `INSERT INTO needs SELECT * FROM needs_legacy WHERE kind IN ('approve-spec','approve-pr','merge')`,
  // Answers go straight to the originator: a resolution records guidance on
  // the originating binding and a quiet note on each binding between, and
  // queues one delivery to the originating thread (a tell for a worker, a
  // wake for a steward). The server flushes it, so every resolve path takes
  // the one road.
  `CREATE TABLE IF NOT EXISTS pending_deliveries (
     id TEXT PRIMARY KEY,
     escalation_id TEXT NOT NULL,
     origin_thread_id TEXT,
     origin_binding_id TEXT,
     text TEXT NOT NULL,
     decided_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER
   )`,
];

// BB-35 step 2: citations and counts, no transitions. Additive and lossless:
// every existing lesson and escalation keeps its values and gets the new
// columns at their defaults, and nothing is dropped or renamed. A later step
// reads these counts to move tiers; this step only records them.
export const LESSON_COUNTER_MIGRATIONS = [
  `ALTER TABLE lessons ADD COLUMN hits INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lessons ADD COLUMN corrections INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lessons ADD COLUMN last_cited_at INTEGER`,
  `ALTER TABLE lessons ADD COLUMN cited_bindings TEXT NOT NULL DEFAULT '[]'`,
  // The lessons a resolve or a forwarding recommendation rested on, kept on the
  // escalation so a later reversal can be attributed to them.
  `ALTER TABLE escalations ADD COLUMN cited_lessons TEXT NOT NULL DEFAULT '[]'`,
  // 1 once a reversal has been counted, so one correction is one count however
  // often the comment or answer is observed.
  `ALTER TABLE escalations ADD COLUMN corrections_counted INTEGER NOT NULL DEFAULT 0`,
];

// BB-35 step 3: the lifecycle tier and the fields the transitions read. The
// old `status` column is kept and still tracks the file state (pending, merged,
// dropped); the migration maps it onto the tier once, guarded so a re-run does
// not clobber a tier a later transition set. Additive and lossless.
export const LESSON_TIER_MIGRATIONS = [
  `ALTER TABLE lessons ADD COLUMN tier TEXT NOT NULL DEFAULT 'candidate'`,
  `ALTER TABLE lessons ADD COLUMN tier_at INTEGER`,
  `ALTER TABLE lessons ADD COLUMN cluster_key TEXT`,
  `ALTER TABLE lessons ADD COLUMN superseded_by TEXT`,
  // pending => trial (with a branch), merged => promoted, dropped => retired.
  // `WHERE tier = 'candidate'` makes it idempotent: once mapped, a lesson's
  // tier is never remapped from `status`, so a promoted lesson whose status is
  // still 'pending' keeps its tier if the migration is applied again.
  `UPDATE lessons SET tier = CASE status WHEN 'pending' THEN 'trial' WHEN 'merged' THEN 'promoted' WHEN 'dropped' THEN 'retired' ELSE tier END WHERE tier = 'candidate'`,
  // The tier's start is the row's creation for an already-migrated lesson.
  `UPDATE lessons SET tier_at = created_at WHERE tier_at IS NULL`,
];

export const WORKER_CHECK_MIGRATIONS = [
  // 1 while a worker's model and reasoning level are still to be checked:
  // its first turn had not been dispatched when it was created, so the check
  // waits for it to go active, and must survive a server restart in between.
  `ALTER TABLE workers ADD COLUMN model_check_pending INTEGER NOT NULL DEFAULT 0`,
];

// BB-51: the pull-request head (and reviewer marker) a project-steward approval
// request was declined on, so the same head is not asked again. Additive and
// defaulted: existing rows keep asking as before.
export const DECLINED_PR_MIGRATIONS = [
  `ALTER TABLE bindings ADD COLUMN declined_pr_head_sha TEXT`,
  `ALTER TABLE bindings ADD COLUMN declined_pr_marker TEXT`,
];

// BB-53: the per-pull-request deployment state a binding keeps between a merge
// and the deployment that confirms it is live. Additive and defaulted: a
// binding with no deployment target keeps an empty map and behaves as before.
export const DEPLOYMENT_MIGRATIONS = [`ALTER TABLE bindings ADD COLUMN deployments TEXT NOT NULL DEFAULT '{}'`];

// BB-54: a ticket steward's "no more pull requests are coming" report, the
// objections of the last spec decline, and the silent hold-lift notes waiting
// for the project steward's next digest. All additive and defaulted: an old
// row reads as "not reported", no objections, no notes.
export const FINISHED_AND_DIGEST_MIGRATIONS = [
  `ALTER TABLE bindings ADD COLUMN no_more_pulls INTEGER`,
  `ALTER TABLE bindings ADD COLUMN declined_spec_objections TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE project_stewards ADD COLUMN pending_notes TEXT NOT NULL DEFAULT '[]'`,
];

// BB-35 step 4: the rationale box. `rationale_wanted` is the one-line why the
// page shows above the box, or null when it must not ask; `rationale_asked`
// records that the box (or the after-the-fact follow-up) was shown once;
// `rationale_given` records that the user actually supplied reasoning, which
// settles the cluster for good (an empty box leaves it open for a later
// repeat); `cluster_key` groups a repeat escalation with the earlier one the
// nightly pass clustered it against. Additive and defaulted: an escalation
// from before this step behaves as before.
export const RATIONALE_MIGRATIONS = [
  `ALTER TABLE escalations ADD COLUMN rationale_wanted TEXT`,
  `ALTER TABLE escalations ADD COLUMN rationale_asked INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE escalations ADD COLUMN rationale_given INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE escalations ADD COLUMN cluster_key TEXT`,
];

// BB-35 step 5: validation escalations. `validated_at` records the user's Keep
// on a mixed-evidence question, so it is never asked again; `validation_filed_at`
// records when the plugin filed a validation item, so the next pass can apply
// the silence default (a mixed-evidence question retires; a boundary Merge/Drop
// leaves the lesson in trial). Additive and defaulted: a lesson from before this
// step behaves as before.
export const VALIDATION_MIGRATIONS = [
  `ALTER TABLE lessons ADD COLUMN validated_at INTEGER`,
  `ALTER TABLE lessons ADD COLUMN validation_filed_at INTEGER`,
];

export const MIGRATIONS = [...BASE_MIGRATIONS, ...CHAIN_MIGRATIONS, ...LESSON_COUNTER_MIGRATIONS, ...WORKER_CHECK_MIGRATIONS, ...DECLINED_PR_MIGRATIONS, ...DEPLOYMENT_MIGRATIONS, ...FINISHED_AND_DIGEST_MIGRATIONS, ...LESSON_TIER_MIGRATIONS, ...RATIONALE_MIGRATIONS, ...VALIDATION_MIGRATIONS];

// ---- values kept as JSON ------------------------------------------------------------

export const guidanceEntrySchema = z.object({ at: z.number(), text: z.string(), by: z.string() });
export type GuidanceEntry = z.infer<typeof guidanceEntrySchema>;

export const escalationOriginSchema = z.object({
  threadId: z.string().nullable().default(null),
  bindingId: z.string().nullable().default(null),
  chain: z.array(z.object({ threadId: z.string(), bindingId: z.string().nullable().default(null), rewording: z.string().nullable().default(null) })).default([]),
});

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
  /** The pull-request head a project-steward approval request was declined on; not asked again until the head (or the reviewer marker) changes. */
  declinedPrHeadSha: string | null;
  /** The reviewer marker in force when that head was declined, so a new round asks again. */
  declinedPrMarker: string | null;
  /** True once the steward reported no more pull requests are coming; null until reported. Cleared by a new PR or a "more coming" report. */
  noMorePulls: boolean | null;
  /** The exact objections of the last spec decline, so the ticket steward's wake can list them as a checklist and a repeat forwards. */
  declinedSpecObjections: string[];
  /** An ops binding's last look; null for every other kind. */
  opsLook: OpsLook | null;
  /** A Dependabot alert binding's last look; null for every other kind. */
  depsLook: DepsLook | null;
  /** A Sentry project binding's last look; null for every other kind. */
  sentryLook: SentryLook | null;
  /** Per-pull-request deployment state, keyed by the pull request's key (BB-53). Empty with no deployment target. */
  deployments: Deployments;
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
    declinedPrHeadSha: str("declined_pr_head_sha"),
    declinedPrMarker: str("declined_pr_marker"),
    noMorePulls: r.no_more_pulls === null || r.no_more_pulls === undefined ? null : Number(r.no_more_pulls) === 1,
    declinedSpecObjections: json(z.array(z.string()), str("declined_spec_objections"), []),
    opsLook: json(opsLookSchema.nullable(), str("ops_look"), null),
    depsLook: json(depsLookSchema.nullable(), str("deps_look"), null),
    sentryLook: json(sentryLookSchema.nullable(), str("sentry_look"), null),
    deployments: json(deploymentsSchema, str("deployments"), {}),
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
  declinedPrHeadSha: "declined_pr_head_sha",
  declinedPrMarker: "declined_pr_marker",
  noMorePulls: "no_more_pulls",
  declinedSpecObjections: "declined_spec_objections",
  opsLook: "ops_look",
  depsLook: "deps_look",
  sentryLook: "sentry_look",
  deployments: "deployments",
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

export type EscalationRoute = "steward" | "parent" | "project" | "me";

/** How the page asks the user: what the human boundary looks like. */
export const RESOLUTION_KINDS = ["choice", "text", "approve-decline", "secret", "done"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

/** Where an escalation came from: the thread, its binding, and the hops it passed through. */
export type EscalationOrigin = {
  threadId: string | null;
  bindingId: string | null;
  /** Each hop a steward forwarded it through, with that hop's rewording kept. */
  chain: Array<{ threadId: string; bindingId: string | null; rewording: string | null }>;
};

export type Escalation = {
  id: string;
  bindingId: string;
  kind: EscalationKind;
  question: string;
  meanwhile: string;
  route: EscalationRoute;
  recommendation: string | null;
  /** Fixed choices the user picks from, when the escalation offers any. */
  choices: string[];
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
  /** When the project steward was first sent it as new. */
  deliveredAt: number | null;
  /** The project this escalation belongs to, when known. */
  projectId: string | null;
  /** The thread and binding it originated from, and the chain it passed through. */
  origin: EscalationOrigin;
  /** What the page's ask looks like, once it reaches the human boundary. */
  resolutionKind: ResolutionKind | null;
  /** The link the page shows, when there is one. */
  url: string | null;
  /** Kind-specific human-boundary fields: the secret's variable, purpose and destination, the matched decide entry. */
  data: Record<string, unknown>;
  /** The thread that answered it, or "user" from the page. */
  answeredBy: string | null;
  /** The escalation this row forwards, when it is a question made from one. */
  forwardedFrom: string | null;
  /** The pull-request head a project-steward approval would be bound to. */
  headSha: string | null;
  /** True when this row is a question the project steward kept, rather than a raw escalation. */
  isQuestion: boolean;
  /** The lesson ids the resolve or recommendation rested on (BB-35 step 2). */
  citedLessons: string[];
  /** True once a reversal has been counted against this escalation's citations. */
  correctionsCounted: boolean;
  /** Why the page shows a rationale box, or null when it must not (BB-35 step 4). */
  rationaleWanted: string | null;
  /** True once the rationale box or the after-the-fact follow-up has been shown, so a cluster is asked once. */
  rationaleAsked: boolean;
  /** True once the user supplied reasoning, which settles the cluster for good (an empty box does not). */
  rationaleGiven: boolean;
  /** The cluster a repeat escalation belongs to, or null (BB-35 step 4). */
  clusterKey: string | null;
};

/** A project steward's approval of an owner-reviewed pull request, bound to its head sha. */
export type ProjectApproval = {
  bindingId: string;
  headSha: string;
  /** The decide-list entry the project steward classified it under. */
  entry: string | null;
  byThread: string;
  createdAt: number;
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
  /** Fixed choices the user picks from, when the question offers any. */
  choices: string[];
  status: "open" | "answered";
  answer: string | null;
  /** The thread that recorded the answer, or "user" from the page. */
  answeredBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
  /** Why the page shows a rationale box, or null when it must not (BB-35 step 4). */
  rationaleWanted: string | null;
  /** True once the box (or a thread close) has shown the ask for this question. */
  rationaleAsked: boolean;
  /** True once the user supplied reasoning for this question (BB-35 step 4). */
  rationaleGiven: boolean;
};

/** The kinds of thing that can wait on the user, from the ticket's table. */
export const NEEDS_KINDS = ["approve-spec", "approve-pr", "merge", "decide", "provide-secret", "configure"] as const;
export type NeedKind = (typeof NEEDS_KINDS)[number];

/**
 * The steward-filed `needs` kinds that are escalations since BB-30: a
 * credential, a step outside the repos, or a decision is raised with
 * `steward_report { escalate }`, and `steward_report { needs }` refuses it.
 * One list feeds the standing rules and the refusal text, so they cannot
 * drift (BB-51).
 */
export const ESCALATED_NEED_KINDS = ["decide", "configure", "provide-secret"] as const;

/** The `needs` kinds a steward may still file directly: the plugin's gate items. */
export const STEWARD_NEED_KINDS = NEEDS_KINDS.filter((k): k is NeedKind => !(ESCALATED_NEED_KINDS as readonly NeedKind[]).includes(k));

/**
 * One "needs you" item: a structured thing the user must do, filed by the
 * plugin from a snapshot or by a steward through `steward_report`. `url` is the
 * link (the ticket, the pull request, the external page); with `kind` it is the
 * dedupe key. `data` carries kind-specific fields (the pull request sha, the
 * secret's variable name, purpose, `writeEnv` dotenv path or `setting`, and the
 * worker thread to open).
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

/** The fixed choices a need's `data` carries, whatever else it holds. */
export function needChoices(n: Pick<Need, "data">): string[] {
  const parsed = z.array(z.string()).safeParse(n.data.choices);
  return parsed.success ? parsed.data : [];
}

/**
 * A lesson: a general rule the project steward drew from an escalation or its
 * own judgement. `procedure` restates what it may already decide and it lands
 * itself at `.bb` HEAD; `boundary` would change its own escalation boundary
 * (credentials and reach, who may direct a server, irreversible production
 * steps) and only the user may merge it. Every lesson keeps the binding and
 * escalation it came from.
 */
export const LESSON_SCOPES = ["procedure", "boundary"] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];
/**
 * A lesson's scope, failing closed: anything the plugin cannot classify — a
 * missing value, an unknown string from an older or hand-edited row — is
 * `boundary`, the one only the user may widen. Never `procedure` by default.
 */
export const lessonScope = (value: unknown): LessonScope => (value === "procedure" ? "procedure" : "boundary");
export type LessonStatus = "pending" | "merged" | "dropped";
/** The mechanical lifecycle a lesson moves through (BB-35 step 3). */
export const LESSON_TIERS = ["candidate", "trial", "promoted", "retired"] as const;
export type LessonTier = (typeof LESSON_TIERS)[number];
/** A tier read from a row, failing closed to `candidate` for a missing or unknown value. */
export const lessonTier = (value: unknown): LessonTier => (LESSON_TIERS.includes(value as LessonTier) ? (value as LessonTier) : "candidate");
export type Lesson = {
  id: string;
  projectId: string;
  bindingId: string | null;
  escalationId: string | null;
  /** The `.bb` file the text belongs in, repo-relative. */
  file: string;
  /** The wording as it should read in the file. */
  text: string;
  scope: LessonScope;
  status: LessonStatus;
  /** The lifecycle tier (BB-35 step 3). `status` is kept for the file state. */
  tier: LessonTier;
  /** When the tier last changed, the start of the current trial or promotion. */
  tierAt: number | null;
  /** A clustering key for repeat escalations (BB-35); null until a later step fills it. */
  clusterKey: string | null;
  /** The lesson that supersedes this one, or null. */
  supersededBy: string | null;
  /** The `guidance-<thread>` branch carrying it, once published. */
  branch: string | null;
  /** The canonical `.bb` commit it landed at, once merged. */
  mergeSha: string | null;
  /** The last refusal or explanation from a merge attempt, for the nightly prompt. */
  note: string | null;
  /** How many distinct bindings have cited it (BB-35 step 2). */
  hits: number;
  /** How many times the user reversed a decision that cited it (BB-35 step 2). */
  corrections: number;
  /** When it was last cited, or null. */
  lastCitedAt: number | null;
  /** The bindings whose decisions cited it; one `hits` each, plus the project sentinel for a citation with no binding. */
  citedBindings: string[];
  /** When the user answered Keep on the mixed-evidence question, or null (BB-35 step 5). */
  validatedAt: number | null;
  /** When the plugin last filed a validation item for this lesson, or null (BB-35 step 5). */
  validationFiledAt: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
};

export type WorkerStatus = "running" | "finished" | "failed" | "stopped";
export type Worker = { threadId: string; bindingId: string; title: string; status: WorkerStatus; result: string | null; startedAt: number; endedAt: number | null; modelCheckPending: boolean };

/** The requester thread the plugin spawned for an open provide-secret need (BB-22). */
export type SecretRequester = { threadId: string; needId: string; createdAt: number };

/** One problem an ops steward has seen, and the ticket it is tracked under. */
export type Fingerprint = FingerprintRow & { projectId: string; bindingId: string; summary: string; lastSeenAt: number; seenCount: number; filedAt: number | null; severity: string | null; ecosystem: string | null };

/** What a steward reports doing about a fingerprint: filing a ticket, commenting on one, or reopening one. */
export type TicketAction = "filed" | "commented" | "reopened";

export type ProjectStewardRow = { projectId: string; threadId: string | null; digest: string | null; digestAt: number | null; nightlyDate: string | null; digestPending: boolean; title: string | null; sectionId: string | null; pendingNotes: string[] };

/** Guidance repeated within this window is a retry, not new guidance. */
export const GUIDANCE_DEDUPE_MS = 5 * 60_000;

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/**
 * What a store reports back to its owner when a project's "needs you" set
 * changes. The server wires it to the realtime channel; the store itself
 * knows nothing about bb.
 */
export interface StoreOptions {
  onNeedsYouChange?: (projectId: string) => void;
}

export function createStore(db: Database.Database, now: () => number, options: StoreOptions = {}) {
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
    "INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, recommendation, choices, created_at, project_id, origin, chain, resolution_kind, url, data, forwarded_from, is_question, context, head_sha) VALUES (@id, @binding_id, @kind, @question, @meanwhile, @route, @recommendation, @choices, @created_at, @project_id, @origin, @chain, @resolution_kind, @url, @data, @forwarded_from, @is_question, @context, @head_sha)",
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

  // Questions are escalations too: the project steward's `ask` is an escalation
  // it originates with route `me`. `is_question` keeps the page's questions
  // list its own among all the route-`me` escalations.
  const insertQuestion = db.prepare(
    "INSERT INTO escalations (id, project_id, binding_id, forwarded_from, question, context, choices, meanwhile, route, status, created_at, resolution_kind, url, data, is_question, kind, origin) VALUES (@id, @project_id, @binding_id, @forwarded_from, @question, @context, @choices, 'wait', 'me', 'open', @created_at, @resolution_kind, @url, @data, 1, 'decision', @origin)",
  );
  const getQuestion = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE id = ? AND is_question = 1");
  const openQuestions = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE project_id = ? AND is_question = 1 AND status = 'open' AND (resolution_kind IS NULL OR resolution_kind NOT IN ('secret','done')) ORDER BY created_at");
  const answeredSince = db.prepare<[string, number], Record<string, unknown>>("SELECT * FROM escalations WHERE project_id = ? AND is_question = 1 AND status = 'resolved' AND resolved_at >= ? AND (resolution_kind IS NULL OR resolution_kind NOT IN ('secret','done')) ORDER BY resolved_at");
  const escalationNeedsForBinding = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE binding_id = ? AND route = 'me' AND kind != 'approval' AND (is_question = 0 OR resolution_kind IN ('secret','done')) AND (is_question = 1 OR NOT EXISTS (SELECT 1 FROM escalations q WHERE q.forwarded_from = escalations.id AND q.is_question = 1)) ORDER BY created_at");
  // A route-`me` escalation a question or a need already covers is not listed
  // again as a need: the page shows the question or the item, never the raw row.
  const openEscalationNeeds = db.prepare<[string], Record<string, unknown>>(
    "SELECT * FROM escalations e WHERE e.binding_id = ? AND e.route = 'me' AND e.status = 'open' AND e.kind != 'approval' AND (e.is_question = 0 OR e.resolution_kind IN ('secret','done')) " +
      "AND NOT EXISTS (SELECT 1 FROM escalations q WHERE q.forwarded_from = e.id AND q.is_question = 1 AND q.status = 'open') " +
      "AND NOT EXISTS (SELECT 1 FROM needs n WHERE n.binding_id = e.binding_id AND n.status = 'open' AND json_extract(n.data, '$.escalationId') = e.id) ORDER BY e.created_at",
  );
  const openEscalationNeedsForProject = db.prepare<[string], Record<string, unknown>>(
    "SELECT e.* FROM escalations e JOIN bindings b ON b.id = e.binding_id WHERE b.project_id = ? AND e.route = 'me' AND e.status = 'open' AND e.kind != 'approval' AND (e.is_question = 0 OR e.resolution_kind IN ('secret','done')) " +
      "AND NOT EXISTS (SELECT 1 FROM escalations q WHERE q.forwarded_from = e.id AND q.is_question = 1 AND q.status = 'open') " +
      "AND NOT EXISTS (SELECT 1 FROM needs n WHERE n.binding_id = e.binding_id AND n.status = 'open' AND json_extract(n.data, '$.escalationId') = e.id) ORDER BY e.created_at",
  );
  // The raw escalations an open question covers (its `forwarded_from`), whatever
  // the question's resolution, so the page and wakes show the question/item once.
  const openQuestionCovered = db.prepare<[string], { forwarded_from: string }>("SELECT DISTINCT forwarded_from FROM escalations WHERE project_id = ? AND is_question = 1 AND status = 'open' AND forwarded_from IS NOT NULL");
  const answerQuestion = db.prepare("UPDATE escalations SET status = 'resolved', resolution = ?, answered_by = ?, resolved_at = ? WHERE id = ? AND is_question = 1 AND status = 'open'");
  const forwardedFromOf = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE id = (SELECT forwarded_from FROM escalations WHERE id = ?)");
  const answerForEscalation = db.prepare("UPDATE escalations SET status = 'resolved', resolution = ?, answered_by = ?, resolved_at = ? WHERE forwarded_from = ? AND is_question = 1 AND status = 'open'");
  const appendAnswerForEscalation = db.prepare("UPDATE escalations SET resolution = ? WHERE forwarded_from = ? AND is_question = 1 AND status = 'resolved'");

  const insertDelivery = db.prepare("INSERT INTO pending_deliveries (id, escalation_id, origin_thread_id, origin_binding_id, text, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const pendingDeliveriesStmt = db.prepare<[number], Record<string, unknown>>("SELECT * FROM pending_deliveries WHERE delivered_at IS NULL AND created_at <= ? ORDER BY created_at");
  const markDeliveryDoneStmt = db.prepare("UPDATE pending_deliveries SET delivered_at = ? WHERE id = ?");

  const insertProjectApproval = db.prepare(
    "INSERT INTO project_approvals (binding_id, head_sha, entry, by_thread, created_at) VALUES (@binding_id, @head_sha, @entry, @by_thread, @created_at) ON CONFLICT (binding_id, head_sha) DO UPDATE SET entry = @entry, by_thread = @by_thread, created_at = @created_at",
  );
  const getProjectApproval = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM project_approvals WHERE binding_id = ? AND head_sha = ?");
  const deleteProjectApproval = db.prepare("DELETE FROM project_approvals WHERE binding_id = ? AND head_sha = ?");

  const insertWorker = db.prepare("INSERT INTO workers (thread_id, binding_id, title, status, started_at) VALUES (?, ?, ?, 'running', ?)");
  const getWorker = db.prepare<[string], Record<string, unknown>>("SELECT * FROM workers WHERE thread_id = ?");
  const workersFor = db.prepare<[string], Record<string, unknown>>("SELECT * FROM workers WHERE binding_id = ? ORDER BY started_at");
  const spawnsSince = db.prepare<[string, number], { n: number }>("SELECT COUNT(*) AS n FROM workers WHERE binding_id = ? AND started_at >= ?");
  const setWorker = db.prepare("UPDATE workers SET status = ?, result = ?, ended_at = ? WHERE thread_id = ?");
  const setWorkerModelCheckPending = db.prepare("UPDATE workers SET model_check_pending = ? WHERE thread_id = ?");
  const insertSecretRequester = db.prepare("INSERT OR REPLACE INTO secret_requesters (thread_id, need_id, created_at) VALUES (?, ?, ?)");
  const getSecretRequester = db.prepare<[string], Record<string, unknown>>("SELECT * FROM secret_requesters WHERE thread_id = ?");
  const getSecretRequesterForNeed = db.prepare<[string], Record<string, unknown>>("SELECT * FROM secret_requesters WHERE need_id = ? ORDER BY created_at DESC LIMIT 1");
  const deleteSecretRequester = db.prepare("DELETE FROM secret_requesters WHERE thread_id = ?");

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
    choices: json(z.array(z.string()), r.choices === null || r.choices === undefined ? null : String(r.choices), []),
    status: String(r.status) as "open" | "resolved",
    resolution: r.resolution === null ? null : String(r.resolution),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
    deliveredAt: r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
    projectId: r.project_id === null || r.project_id === undefined ? null : String(r.project_id),
    origin: json(escalationOriginSchema, r.origin === null || r.origin === undefined ? null : String(r.origin), { threadId: null, bindingId: null, chain: [] }),
    resolutionKind: r.resolution_kind === null || r.resolution_kind === undefined ? null : (String(r.resolution_kind) as ResolutionKind),
    url: r.url === null || r.url === undefined ? null : String(r.url),
    data: json(z.record(z.string(), z.unknown()), r.data === null || r.data === undefined ? null : String(r.data), {}),
    answeredBy: r.answered_by === null || r.answered_by === undefined ? null : String(r.answered_by),
    forwardedFrom: r.forwarded_from === null || r.forwarded_from === undefined ? null : String(r.forwarded_from),
    headSha: r.head_sha === null || r.head_sha === undefined ? null : String(r.head_sha),
    isQuestion: Number(r.is_question ?? 0) === 1,
    citedLessons: json(z.array(z.string()), r.cited_lessons === null || r.cited_lessons === undefined ? null : String(r.cited_lessons), []),
    correctionsCounted: Number(r.corrections_counted ?? 0) === 1,
    rationaleWanted: r.rationale_wanted === null || r.rationale_wanted === undefined ? null : String(r.rationale_wanted),
    rationaleAsked: Number(r.rationale_asked ?? 0) === 1,
    rationaleGiven: Number(r.rationale_given ?? 0) === 1,
    clusterKey: r.cluster_key === null || r.cluster_key === undefined ? null : String(r.cluster_key),
  });
  const toQuestion = (r: Record<string, unknown>): Question => {
    const e = toEscalation(r);
    return {
      id: e.id,
      projectId: e.projectId ?? "",
      bindingId: e.bindingId === "" ? null : e.bindingId,
      escalationId: e.forwardedFrom,
      question: e.question,
      context: r.context === null || r.context === undefined ? null : String(r.context),
      choices: e.choices,
      status: e.status === "open" ? "open" : "answered",
      answer: e.resolution,
      answeredBy: e.answeredBy,
      createdAt: e.createdAt,
      resolvedAt: e.resolvedAt,
      rationaleWanted: e.rationaleWanted,
      rationaleAsked: e.rationaleAsked,
      rationaleGiven: e.rationaleGiven,
    };
  };
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

  const insertLesson = db.prepare(
    "INSERT INTO lessons (id, project_id, binding_id, escalation_id, file, text, scope, status, tier, tier_at, cluster_key, superseded_by, branch, created_at, updated_at) VALUES (@id, @project_id, @binding_id, @escalation_id, @file, @text, @scope, 'pending', @tier, @tier_at, @cluster_key, @superseded_by, @branch, @created_at, @updated_at)",
  );
  const getLesson = db.prepare<[string], Record<string, unknown>>("SELECT * FROM lessons WHERE id = ?");
  const lessonsFor = db.prepare<[string, number], Record<string, unknown>>("SELECT * FROM lessons WHERE project_id = ? AND (? = 1 OR status = 'pending') ORDER BY created_at");
  const setLessonBranchStmt = db.prepare("UPDATE lessons SET branch = ?, updated_at = ? WHERE id = ? AND status = 'pending'");
  const setLessonNoteStmt = db.prepare("UPDATE lessons SET note = ?, updated_at = ? WHERE id = ?");
  const resolveLessonStmt = db.prepare(
    "UPDATE lessons SET status = ?, merge_sha = COALESCE(?, merge_sha), branch = COALESCE(?, branch), note = ?, updated_at = ?, resolved_at = COALESCE(resolved_at, ?) WHERE id = ?",
  );
  const citeLessonStmt = db.prepare("UPDATE lessons SET hits = ?, last_cited_at = ?, cited_bindings = ?, updated_at = ? WHERE id = ?");
  const correctLessonStmt = db.prepare("UPDATE lessons SET corrections = corrections + 1, updated_at = ? WHERE id = ?");
  const setLessonTierStmt = db.prepare("UPDATE lessons SET tier = ?, tier_at = ?, updated_at = ? WHERE id = ?");
  const setLessonClusterStmt = db.prepare("UPDATE lessons SET cluster_key = ?, updated_at = ? WHERE id = ?");
  const setLessonSupersededStmt = db.prepare("UPDATE lessons SET superseded_by = ?, updated_at = ? WHERE id = ?");
  const lessonsByTierStmt = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM lessons WHERE project_id = ? AND tier = ? ORDER BY created_at");
  const setEscalationCitationsStmt = db.prepare("UPDATE escalations SET cited_lessons = ? WHERE id = ?");
  const markEscalationCorrectedStmt = db.prepare("UPDATE escalations SET corrections_counted = 1 WHERE id = ?");
  // BB-35 step 4: the rationale box. The why, the once-per-cluster flag, and
  // the cluster a repeat belongs to.
  const setEscalationRationaleStmt = db.prepare("UPDATE escalations SET rationale_wanted = ? WHERE id = ?");
  const markEscalationRationaleAskedStmt = db.prepare("UPDATE escalations SET rationale_asked = 1 WHERE id = ?");
  const markEscalationRationaleGivenStmt = db.prepare("UPDATE escalations SET rationale_given = 1, rationale_asked = 1 WHERE id = ?");
  const setEscalationClusterStmt = db.prepare("UPDATE escalations SET cluster_key = ? WHERE id = ?");
  const openUserEscalationsStmt = db.prepare<[string], Record<string, unknown>>("SELECT * FROM escalations WHERE project_id = ? AND route = 'me' AND status = 'open' ORDER BY created_at");
  const escalationsByClusterStmt = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM escalations WHERE project_id = ? AND cluster_key = ? ORDER BY created_at");
  const escalationsWithRationaleStmt = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM escalations WHERE project_id = ? AND rationale_wanted = ? AND rationale_asked = 0 ORDER BY created_at");
  // BB-35 step 5: validation escalations are `needs` of kind `decide` whose
  // `data.validation` names the rare condition they ask about. `validated_at`
  // records the user's Keep; `validation_filed_at` lets the next pass apply
  // the silence default.
  const setLessonValidatedStmt = db.prepare("UPDATE lessons SET validated_at = ?, updated_at = ? WHERE id = ?");
  const markLessonValidationFiledStmt = db.prepare("UPDATE lessons SET validation_filed_at = ?, updated_at = ? WHERE id = ?");
  const countValidationsSinceStmt = db.prepare<[string, number], { n: number }>("SELECT COUNT(*) AS n FROM needs n JOIN bindings b ON b.id = n.binding_id WHERE b.project_id = ? AND n.kind = 'decide' AND json_extract(n.data, '$.validation') IS NOT NULL AND n.created_at >= ?");
  const openLessonValidationNeedStmt = db.prepare<[string], Record<string, unknown>>("SELECT * FROM needs WHERE kind = 'decide' AND url = ? AND status = 'open' AND json_extract(data, '$.validation') IS NOT NULL LIMIT 1");

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

  /**
   * A steward-filed escalation (decide, configure, provide-secret) as the
   * `Need` shape the provide-secret machinery and the page still speak. The
   * rows live in `escalations`; this keeps `need(id)` and its callers working
   * across the migration.
   */
  const needFromEscalation = (x: Escalation): Need => ({
    id: x.id,
    bindingId: x.bindingId,
    kind: x.resolutionKind === "secret" ? "provide-secret" : x.resolutionKind === "done" ? "configure" : "decide",
    url: x.url ?? "",
    what: x.question,
    how: null,
    data: x.data,
    filedBy: "project",
    status: x.status === "open" ? "open" : "done",
    resolution: x.resolution,
    createdAt: x.createdAt,
    resolvedAt: x.resolvedAt,
  });

  const toWorker = (r: Record<string, unknown>): Worker => ({
    threadId: String(r.thread_id),
    bindingId: String(r.binding_id),
    title: String(r.title),
    status: String(r.status) as WorkerStatus,
    result: r.result === null ? null : String(r.result),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    modelCheckPending: Number(r.model_check_pending ?? 0) === 1,
  });
  const toSecretRequester = (r: Record<string, unknown>): SecretRequester => ({
    threadId: String(r.thread_id),
    needId: String(r.need_id),
    createdAt: Number(r.created_at),
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
    pendingNotes: json(z.array(z.string()), r.pending_notes === null || r.pending_notes === undefined ? null : String(r.pending_notes), []),
  });
  const toLesson = (r: Record<string, unknown>): Lesson => ({
    id: String(r.id),
    projectId: String(r.project_id),
    bindingId: r.binding_id === null || r.binding_id === undefined ? null : String(r.binding_id),
    escalationId: r.escalation_id === null || r.escalation_id === undefined ? null : String(r.escalation_id),
    file: String(r.file),
    text: String(r.text),
    scope: lessonScope(r.scope),
    status: String(r.status) as LessonStatus,
    tier: lessonTier(r.tier),
    tierAt: r.tier_at === null || r.tier_at === undefined ? null : Number(r.tier_at),
    clusterKey: r.cluster_key === null || r.cluster_key === undefined ? null : String(r.cluster_key),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : String(r.superseded_by),
    branch: r.branch === null || r.branch === undefined ? null : String(r.branch),
    mergeSha: r.merge_sha === null || r.merge_sha === undefined ? null : String(r.merge_sha),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    hits: Number(r.hits ?? 0),
    corrections: Number(r.corrections ?? 0),
    lastCitedAt: r.last_cited_at === null || r.last_cited_at === undefined ? null : Number(r.last_cited_at),
    citedBindings: json(z.array(z.string()), r.cited_bindings === null || r.cited_bindings === undefined ? null : String(r.cited_bindings), []),
    validatedAt: r.validated_at === null || r.validated_at === undefined ? null : Number(r.validated_at),
    validationFiledAt: r.validation_filed_at === null || r.validation_filed_at === undefined ? null : Number(r.validation_filed_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  });

  const onNeedsYouChange = options.onNeedsYouChange;

  /** The project a binding belongs to, for a mutation that only has the binding. */
  function projectIdForBinding(bindingId: string): string | null {
    const b = getBinding.get(bindingId);
    return b === undefined ? null : String(b.project_id);
  }

  // A "needs you" change is coalesced within one synchronous store operation,
  // so one question filed or answered publishes exactly one event even when
  // the operation nests (answer -> resolve) or closes a migrated need through
  // resolve. The flush runs when the outermost operation finishes.
  let notifyDepth = 0;
  const dirtyProjects = new Set<string>();

  function flushNeedsYou(): void {
    const projects = [...dirtyProjects];
    dirtyProjects.clear();
    if (onNeedsYouChange !== undefined) for (const projectId of projects) onNeedsYouChange(projectId);
  }

  /** Mark a project's "needs you" set changed; publishes now, or on the way out of a nested operation. */
  function needsYouChanged(projectId: string | null | undefined): void {
    if (onNeedsYouChange === undefined || projectId === null || projectId === undefined || projectId === "") return;
    dirtyProjects.add(projectId);
    if (notifyDepth === 0) flushNeedsYou();
  }

  /** Run `fn`, flushing at most one notification per project when it returns successfully. */
  function coalescing<T>(fn: () => T): T {
    notifyDepth += 1;
    try {
      const result = fn();
      notifyDepth -= 1;
      if (notifyDepth === 0) flushNeedsYou();
      return result;
    } catch (error) {
      // A failed operation did not change anything: drop its pending marks.
      notifyDepth -= 1;
      if (notifyDepth === 0) dirtyProjects.clear();
      throw error;
    }
  }

  /**
   * Resolve an open escalation. The question made from it closes with it, and
   * the escalation a question was forwarded from closes too, so a close on the
   * page (answer, Done, a finished requester, a secret import) resolves the
   * whole pair in one write and the originator hears the answer (BB-51). `by`
   * is who answered it. `deliver` is false for a mechanical close of an
   * escalation whose origin binding has ended: it is resolved, but no wake is
   * queued for a binding that is already gone (BB-60).
   */
  function resolve(id: string, resolution: string, by = "plugin", deliver = true): boolean {
    return coalescing(() => {
      const resolved = db.transaction(() => {
        const at = now();
        if (resolveEscalation.run(resolution, at, id).changes === 0) return false;
        answerForEscalation.run(resolution, by, at, id);
        const x = getEscalation.get(id);
        if (x !== undefined) recordResolutionDelivery(toEscalation(x), resolution, by, deliver);
        // Follow the link up: a question resolved on the page also resolves the
        // escalation the project steward forwarded it from.
        const parent = forwardedFromOf.get(id);
        if (parent !== undefined && String(parent.status) === "open") {
          resolveEscalation.run(resolution, at, String(parent.id));
          recordResolutionDelivery(toEscalation(parent), resolution, by, deliver);
          answerForEscalation.run(resolution, by, at, String(parent.id));
        }
        return true;
      })();
      if (resolved) {
        const x = getEscalation.get(id);
        needsYouChanged(x === undefined ? null : projectIdForBinding(String(x.binding_id)));
      }
      return resolved;
    });
  }

  /**
   * On any resolve, record the answer on the originating binding as guidance
   * (verbatim, with who decided as its author) and a quiet note on each binding
   * the escalation passed through, then queue one delivery to the originating
   * thread. The server flushes the queue; a worker gets a tell, a steward a
   * wake. This is the one road every resolve takes (BB-30). `deliver` is
   * false for a resolve that must not wake the origin (BB-60).
   */
  function recordResolutionDelivery(x: Escalation, resolution: string, by: string, deliver = true): void {
    const originBindingId = x.origin.bindingId ?? x.bindingId;
    // A mechanical closure (the plugin withdrawing or closing something) is
    // not a decision: it is noted, but it is not written as guidance a worker
    // would later read as standing instruction.
    const decided = by !== "plugin";
    if (decided && originBindingId !== "") {
      const raw = getBinding.get(originBindingId);
      if (raw !== undefined) {
        const b = rowToBinding(raw);
        const last = b.guidance.at(-1);
        if (last === undefined || last.text !== resolution || last.by !== by) patch(originBindingId, { guidance: [...b.guidance, { at: now(), text: resolution, by }].slice(-50) });
      }
    }
    for (const hop of x.origin.chain) {
      if (hop.bindingId === null || hop.bindingId === originBindingId) continue;
      const raw = getBinding.get(hop.bindingId);
      if (raw === undefined) continue;
      const b = rowToBinding(raw);
      patch(hop.bindingId, { pending: [...b.pending, { at: now(), text: `Escalation ${x.id} was answered by ${by}: ${resolution}`, quiet: true }].slice(-30) });
    }
    if (deliver && x.origin.threadId !== null && x.origin.threadId !== "") insertDelivery.run(newId("dlv"), x.id, x.origin.threadId, originBindingId === "" ? null : originBindingId, resolution, by, now());
  }

  function patch(id: string, fields: BindingPatch): Binding {
    const wasOpen = getBinding.get(id)?.ended_at === null;
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as Array<[keyof typeof COLUMNS, unknown]>;
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(", ");
      db.prepare(`UPDATE bindings SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => toColumn(v)), id);
    }
    const b = rowToBinding(getBinding.get(id)!);
    // Ending a binding takes its needs and with-user escalations off the board
    // and the sidebar; reopening one puts them back.
    if (fields.endedAt !== undefined && wasOpen !== (b.endedAt === null)) needsYouChanged(b.projectId);
    return b;
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
      coalescing(() =>
        db.transaction(() => {
          const b = rowToBinding(getBinding.get(bindingId)!);
          patch(bindingId, { ready: { ...b.ready, approval, voidedAt: null, declinedSpecHash: null }, declinedSpecObjections: [] });
          closeNeedKindStmt.run("Approved.", now(), bindingId, "approve-spec");
          for (const x of openEscalations.all(bindingId).map(toEscalation).filter((e) => e.kind === "approval" && e.resolutionKind !== "approve-decline")) resolve(x.id, resolution, by);
          needsYouChanged(projectIdForBinding(bindingId));
        })(),
      );
    },
    /** Remember the current spec as declined and close its approval request, in one transaction. */
    decline(bindingId: string, specHash: string, resolution: string, by: string): void {
      coalescing(() =>
        db.transaction(() => {
          const b = rowToBinding(getBinding.get(bindingId)!);
          patch(bindingId, { ready: { ...b.ready, declinedSpecHash: specHash } });
          closeNeedKindStmt.run("Declined.", now(), bindingId, "approve-spec");
          for (const x of openEscalations.all(bindingId).map(toEscalation).filter((e) => e.kind === "approval" && e.resolutionKind !== "approve-decline")) resolve(x.id, resolution, by);
          needsYouChanged(projectIdForBinding(bindingId));
        })(),
      );
    },

    // escalations
    escalate(fields: {
      bindingId: string;
      kind: EscalationKind;
      question: string;
      meanwhile: string;
      route: EscalationRoute;
      recommendation: string | null;
      choices?: string[];
      projectId?: string | null;
      origin?: EscalationOrigin;
      resolutionKind?: ResolutionKind | null;
      url?: string | null;
      data?: Record<string, unknown>;
      forwardedFrom?: string | null;
      headSha?: string | null;
    }): Escalation {
      const id = newId("esc");
      const origin: EscalationOrigin = fields.origin ?? { threadId: null, bindingId: fields.bindingId, chain: [] };
      insertEscalation.run({
        id,
        binding_id: fields.bindingId,
        kind: fields.kind,
        question: fields.question,
        meanwhile: fields.meanwhile,
        route: fields.route,
        recommendation: fields.recommendation,
        choices: JSON.stringify(fields.choices ?? []),
        created_at: now(),
        project_id: fields.projectId ?? null,
        origin: JSON.stringify(origin),
        chain: JSON.stringify(origin.chain),
        resolution_kind: fields.resolutionKind ?? null,
        url: fields.url ?? null,
        data: JSON.stringify(fields.data ?? {}),
        forwarded_from: fields.forwardedFrom ?? null,
        is_question: 0,
        context: null,
        head_sha: fields.headSha ?? null,
      });
      // A route-`me` escalation is a "needs you" item the moment it is filed.
      if (fields.route === "me") needsYouChanged(fields.projectId ?? projectIdForBinding(fields.bindingId));
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
      return coalescing(() =>
        db.transaction(() => {
          if (resolve(id, text, by)) return "resolved" as const;
          const x = getEscalation.get(id);
          const resolution = x === undefined || x.resolution === null ? "" : String(x.resolution);
          if (x === undefined || resolution === text || resolution.endsWith(`\n${text}`)) return "unchanged" as const;
          const appended = resolution === "" ? text : `${resolution}\n${text}`;
          appendResolution.run(appended, id);
          appendAnswerForEscalation.run(appended, id);
          return "appended" as const;
        })(),
      );
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
      const before = getEscalation.get(id);
      const changed = rerouteEscalation.run(route, recommendation, id).changes > 0;
      // A route-`me` escalation is a "needs you" item: forwarding one to the
      // user adds it, and moving one off the user removes it. A reroute to the
      // route it already had changes nothing on the board.
      if (changed && before !== undefined && String(before.route) !== route && (String(before.route) === "me" || route === "me")) needsYouChanged(projectIdForBinding(String(before.binding_id)));
      return changed;
    },
    /** Re-point a pull-request approval escalation at a new head sha (a push voids the old approval). */
    setEscalationHead(id: string, headSha: string | null): void {
      db.prepare("UPDATE escalations SET head_sha = ? WHERE id = ?").run(headSha, id);
    },
    /** Record a forwarding hop on the escalation's chain, keeping its rewording. */
    addHop(id: string, hop: { threadId: string; bindingId: string | null; rewording: string | null }): void {
      const x = getEscalation.get(id);
      if (x === undefined) return;
      const e = toEscalation(x);
      const chain = [...e.origin.chain, hop];
      db.prepare("UPDATE escalations SET chain = ?, origin = ? WHERE id = ?").run(JSON.stringify(chain), JSON.stringify({ ...e.origin, chain }), id);
    },
    /** Answers waiting to be delivered to their originating thread. */
    pendingDeliveries(limit = 100): Array<{ id: string; escalationId: string; originThreadId: string | null; originBindingId: string | null; text: string; decidedBy: string; createdAt: number }> {
      return pendingDeliveriesStmt.all(now()).slice(0, limit).map((r) => ({
        id: String(r.id),
        escalationId: String(r.escalation_id),
        originThreadId: r.origin_thread_id === null || r.origin_thread_id === undefined ? null : String(r.origin_thread_id),
        originBindingId: r.origin_binding_id === null || r.origin_binding_id === undefined ? null : String(r.origin_binding_id),
        text: String(r.text),
        decidedBy: String(r.decided_by),
        createdAt: Number(r.created_at),
      }));
    },
    markDeliveryDone(id: string): void {
      markDeliveryDoneStmt.run(now(), id);
    },
    lastResolved(bindingId: string, kind: EscalationKind): number | null {
      return lastResolvedOfKind.get(bindingId, kind)?.resolved_at ?? null;
    },

    // project-steward approvals of owner-reviewed pull requests (BB-30)
    /**
     * The project steward's approval of an owner-reviewed pull request, if it
     * recorded one for this binding's current head. A new push is a new sha,
     * so this is null again and the approval must be asked for afresh.
     */
    projectApproval(bindingId: string, headSha: string): ProjectApproval | null {
      const r = getProjectApproval.get(bindingId, headSha);
      return r === undefined
        ? null
        : { bindingId: String(r.binding_id), headSha: String(r.head_sha), entry: r.entry === null || r.entry === undefined ? null : String(r.entry), byThread: String(r.by_thread), createdAt: Number(r.created_at) };
    },
    /**
     * Record a project-steward approval, bound to the pull request's head sha.
     * The caller is responsible for checking that the approver is the project
     * steward's thread; this is the store half.
     */
    recordProjectApproval(fields: { bindingId: string; headSha: string; entry: string | null; byThread: string }): ProjectApproval {
      insertProjectApproval.run({ binding_id: fields.bindingId, head_sha: fields.headSha, entry: fields.entry, by_thread: fields.byThread, created_at: now() });
      const r = getProjectApproval.get(fields.bindingId, fields.headSha)!;
      return { bindingId: String(r.binding_id), headSha: String(r.head_sha), entry: r.entry === null || r.entry === undefined ? null : String(r.entry), byThread: String(r.by_thread), createdAt: Number(r.created_at) };
    },
    /** Drop a recorded approval (a new push voids it by sha; this is for an explicit retraction). */
    clearProjectApproval(bindingId: string, headSha: string): boolean {
      return deleteProjectApproval.run(bindingId, headSha).changes > 0;
    },

    // questions to the user
    ask(fields: { projectId: string; bindingId: string | null; escalationId: string | null; question: string; context: string | null; choices?: string[]; resolutionKind?: ResolutionKind; url?: string | null; data?: Record<string, unknown> }): Question {
      const id = newId("qst");
      insertQuestion.run({
        id,
        project_id: fields.projectId,
        binding_id: fields.bindingId ?? "",
        forwarded_from: fields.escalationId,
        question: fields.question,
        context: fields.context,
        choices: JSON.stringify(fields.choices ?? []),
        created_at: now(),
        resolution_kind: fields.resolutionKind ?? ((fields.choices ?? []).length > 0 ? "choice" : "text"),
        url: fields.url ?? null,
        data: JSON.stringify(fields.data ?? {}),
        origin: JSON.stringify({ threadId: null, bindingId: fields.bindingId, chain: [] }),
      });
      needsYouChanged(fields.projectId);
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
    /** The raw route-`me` escalations an open question covers, whatever its resolution. */
    openQuestionEscalationIds(projectId: string): string[] {
      return openQuestionCovered.all(projectId).map((r) => r.forwarded_from);
    },
    /**
     * Close an open question with its answer, and resolve the escalation it was
     * forwarded for, if any. `resolution` is what the escalation records when
     * the two differ, as a choice does: the question says "Chose: X" while the
     * escalation takes the choice as guidance.
     */
    answer(id: string, answer: string, by: string, resolution = answer): boolean {
      return coalescing(() =>
        db.transaction(() => {
          const at = now();
          if (answerQuestion.run(answer, by, at, id).changes === 0) return false;
          const q = toQuestion(getQuestion.get(id)!);
          if (q.escalationId !== null) resolve(q.escalationId, resolution, by);
          needsYouChanged(q.projectId);
          return true;
        })(),
      );
    },
    /**
     * Close an open question with its answer, leaving the escalation it was
     * forwarded for open. Used when the user's answer is ambiguous: the
     * project steward, not the plugin, decides what it means.
     */
    answerQuestionOnly(id: string, answer: string, by: string): boolean {
      return coalescing(() => {
        const changed = answerQuestion.run(answer, by, now(), id).changes > 0;
        if (changed) {
          const q = getQuestion.get(id);
          needsYouChanged(q === undefined || q.project_id === null || q.project_id === undefined ? null : String(q.project_id));
        }
        return changed;
      });
    },

    // needs: what waits on the user
    need(id: string): Need | null {
      const r = getNeed.get(id);
      if (r !== undefined) return toNeed(r);
      // A steward-filed need migrated to an escalation keeps the same id.
      const e = getEscalation.get(id);
      return e === undefined ? null : needFromEscalation(toEscalation(e));
    },
    needs(bindingId: string, includeDone = false): Need[] {
      const rows = needsFor.all(bindingId, includeDone ? 1 : 0).map(toNeed);
      const fromEscalations = (includeDone ? escalationNeedsForBinding.all(bindingId) : openEscalationNeeds.all(bindingId)).map((r) => needFromEscalation(toEscalation(r)));
      return [...rows, ...fromEscalations].sort((a, b) => a.createdAt - b.createdAt);
    },
    openNeeds(bindingId: string): Need[] {
      const rows = needsFor.all(bindingId, 0).map(toNeed);
      const fromEscalations = openEscalationNeeds.all(bindingId).map((r) => needFromEscalation(toEscalation(r)));
      return [...rows, ...fromEscalations].sort((a, b) => a.createdAt - b.createdAt);
    },
    openNeedsForProject(projectId: string): Need[] {
      const rows = openNeedsForProject.all(projectId).map(toNeed);
      const fromEscalations = openEscalationNeedsForProject.all(projectId).map((r) => needFromEscalation(toEscalation(r)));
      return [...rows, ...fromEscalations].sort((a, b) => a.createdAt - b.createdAt);
    },
    allNeedsForProject(projectId: string): Need[] {
      return allNeedsForProject.all(projectId).map(toNeed);
    },
    /**
     * File a need, deduplicated by (binding, kind, url) while open: a steward
     * that re-reports one updates the wording rather than adding a row.
     */
    fileNeed(fields: { bindingId: string; kind: NeedKind; url: string; what: string; how: string | null; data?: Record<string, unknown>; filedBy?: string }): Need {
      const projectId = projectIdForBinding(fields.bindingId);
      const existing = openNeedByKey.get(fields.bindingId, fields.kind, fields.url);
      if (existing !== undefined) {
        updateNeed.run(fields.what, fields.how, JSON.stringify(fields.data ?? {}), existing.id);
        needsYouChanged(projectId);
        return toNeed(getNeed.get(String(existing.id))!);
      }
      const id = newId("need");
      insertNeed.run({ id, binding_id: fields.bindingId, kind: fields.kind, url: fields.url, what: fields.what, how: fields.how, data: JSON.stringify(fields.data ?? {}), filed_by: fields.filedBy ?? "steward", created_at: now() });
      needsYouChanged(projectId);
      return toNeed(getNeed.get(id)!);
    },
    closeNeed(id: string, resolution: string, by = "plugin"): boolean {
      return coalescing(() => {
        const row = getNeed.get(id);
        if (closeNeedStmt.run(resolution, now(), id).changes > 0) {
          needsYouChanged(row === undefined ? null : projectIdForBinding(String(row.binding_id)));
          return true;
        }
        // A migrated provide-secret need is an escalation now.
        return resolve(id, resolution, by);
      });
    },
    closeNeeds(bindingId: string, kind: NeedKind, resolution: string): number {
      const changed = closeNeedKindStmt.run(resolution, now(), bindingId, kind).changes;
      if (changed > 0) needsYouChanged(projectIdForBinding(bindingId));
      return changed;
    },
    closeNeedByKey(bindingId: string, kind: NeedKind, url: string, resolution: string): number {
      const changed = closeNeedKeyStmt.run(resolution, now(), bindingId, kind, url).changes;
      if (changed > 0) needsYouChanged(projectIdForBinding(bindingId));
      return changed;
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
    /** Whether the worker's model is still to be checked when its first turn is dispatched. */
    setWorkerModelCheckPending(threadId: string, pending: boolean): void {
      setWorkerModelCheckPending.run(pending ? 1 : 0, threadId);
    },

    // provide-secret requester threads (BB-22)
    setSecretRequester(threadId: string, needId: string): void {
      insertSecretRequester.run(threadId, needId, now());
    },
    secretRequester(threadId: string): SecretRequester | null {
      const r = getSecretRequester.get(threadId);
      return r === undefined ? null : toSecretRequester(r);
    },
    secretRequesterForNeed(needId: string): SecretRequester | null {
      const r = getSecretRequesterForNeed.get(needId);
      return r === undefined ? null : toSecretRequester(r);
    },
    clearSecretRequester(threadId: string): void {
      deleteSecretRequester.run(threadId);
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

    // lessons: the project steward's general judgements, made permanent in `.bb`
    /**
     * Record a lesson, pending until its text is found at `.bb` HEAD or the
     * user drops it. `branch` is the guidance branch it will be published on,
     * computed from the project steward's thread when it has one.
     */
    addLesson(fields: { projectId: string; bindingId: string | null; escalationId: string | null; file: string; text: string; scope: LessonScope; branch: string | null; tier?: LessonTier; clusterKey?: string | null; supersedes?: string | null }): Lesson {
      const id = newId("lsn");
      const at = now();
      insertLesson.run({
        id,
        project_id: fields.projectId,
        binding_id: fields.bindingId,
        escalation_id: fields.escalationId,
        file: fields.file,
        text: fields.text,
        scope: fields.scope,
        tier: fields.tier ?? "trial",
        tier_at: at,
        cluster_key: fields.clusterKey ?? null,
        superseded_by: null,
        branch: fields.branch,
        created_at: at,
        updated_at: at,
      });
      if (fields.supersedes !== undefined && fields.supersedes !== null) setLessonSupersededStmt.run(id, at, fields.supersedes);
      return toLesson(getLesson.get(id)!);
    },
    lesson(id: string): Lesson | null {
      const r = getLesson.get(id);
      return r === undefined ? null : toLesson(r);
    },
    /** A project's lessons: the pending ones by default, every one with `includeResolved`. */
    lessons(projectId: string, includeResolved = false): Lesson[] {
      return lessonsFor.all(projectId, includeResolved ? 1 : 0).map(toLesson);
    },
    /** Every lesson of a project, whatever its file state: what the transitions read. */
    allLessons(projectId: string): Lesson[] {
      return db.prepare<[string], Record<string, unknown>>("SELECT * FROM lessons WHERE project_id = ? ORDER BY created_at").all(projectId).map(toLesson);
    },
    /** The lessons in one tier, oldest first. */
    lessonsByTier(projectId: string, tier: LessonTier): Lesson[] {
      return lessonsByTierStmt.all(projectId, tier).map(toLesson);
    },
    /** Move a lesson to a tier, stamping when the move happened. */
    setLessonTier(id: string, tier: LessonTier): void {
      const at = now();
      setLessonTierStmt.run(tier, at, at, id);
    },
    /** Record the cluster a repeat escalation belongs to (BB-35; filled by a later step). */
    setLessonCluster(id: string, clusterKey: string | null): void {
      setLessonClusterStmt.run(clusterKey, now(), id);
    },
    /** Name the lesson a newer one supersedes, so the next pass retires the older. */
    setLessonSupersededBy(id: string, supersededBy: string | null): void {
      setLessonSupersededStmt.run(supersededBy, now(), id);
    },
    /** Remember the guidance branch a lesson is published on. */
    setLessonBranch(id: string, branch: string): void {
      setLessonBranchStmt.run(branch, now(), id);
    },
    /** Record the last refusal or explanation from a merge attempt, for the prompt. */
    noteLesson(id: string, note: string | null): void {
      setLessonNoteStmt.run(note, now(), id);
    },
    /** Mark a lesson merged, keeping any sha and branch already recorded. A retired lesson stays retired: a merge observed after the fact never resurrects it. */
    markLessonMerged(id: string, sha: string | null, branch: string | null, note: string | null = null): void {
      const at = now();
      resolveLessonStmt.run("merged", sha, branch, note, at, at, id);
      const row = getLesson.get(id);
      if (row !== undefined && lessonTier(row.tier) !== "retired") setLessonTierStmt.run("promoted", at, at, id);
    },
    /** Mark a lesson dropped by the user or the project steward. */
    markLessonDropped(id: string, note: string | null = null): void {
      const at = now();
      resolveLessonStmt.run("dropped", null, null, note, at, at, id);
      setLessonTierStmt.run("retired", at, at, id);
    },
    /**
     * Record the lessons one decision cited (BB-35 step 2). A lesson's `hits`
     * counts distinct bindings: a second citation from the same binding
     * refreshes `lastCitedAt` but does not count again. A citation with no
     * binding — a project-steward decision about no one binding — counts once
     * per project. `unknown` names ids that are not lessons of this project;
     * they are never counted. Counts only: no tier and no transition.
     */
    recordCitations(projectId: string, lessonIds: string[], bindingId: string | null): { cited: Lesson[]; unknown: string[] } {
      const at = now();
      const key = bindingId ?? `project:${projectId}`;
      const cited: Lesson[] = [];
      const unknown: string[] = [];
      for (const id of [...new Set(lessonIds)]) {
        const r = getLesson.get(id);
        const lesson = r === undefined ? null : toLesson(r);
        if (lesson === null || lesson.projectId !== projectId) {
          unknown.push(id);
          continue;
        }
        const seen = lesson.citedBindings.includes(key);
        const citedBindings = seen ? lesson.citedBindings : [...lesson.citedBindings, key];
        const hits = seen ? lesson.hits : lesson.hits + 1;
        citeLessonStmt.run(hits, at, JSON.stringify(citedBindings), at, id);
        cited.push({ ...lesson, hits, lastCitedAt: at, citedBindings });
      }
      return { cited, unknown };
    },
    /** Count a reversal of a decision against each lesson it cited, once each (BB-35 step 2). */
    recordCorrections(lessonIds: string[]): void {
      const at = now();
      for (const id of new Set(lessonIds)) correctLessonStmt.run(at, id);
    },
    /** Keep the lessons an escalation's decision rested on, for a later correction. */
    setEscalationCitations(id: string, lessonIds: string[]): void {
      setEscalationCitationsStmt.run(JSON.stringify([...new Set(lessonIds)]), id);
    },
    /** Mark an escalation's citations counted, so one reversal is one correction. */
    markEscalationCorrected(id: string): void {
      markEscalationCorrectedStmt.run(id);
    },
    /** Set or clear the one-line why the page shows for a rationale box (BB-35 step 4). */
    setEscalationRationale(id: string, reason: string | null): void {
      setEscalationRationaleStmt.run(reason, id);
    },
    /** Record that the box (or the after-the-fact follow-up) has been shown, so one cluster is asked once. */
    markEscalationRationaleAsked(id: string): void {
      markEscalationRationaleAskedStmt.run(id);
    },
    /** Record that the user supplied reasoning, which settles the cluster for good. */
    markEscalationRationaleGiven(id: string): void {
      markEscalationRationaleGivenStmt.run(id);
    },
    /** Record the cluster a repeat escalation belongs to (BB-35 step 4). */
    setEscalationCluster(id: string, clusterKey: string | null): void {
      setEscalationClusterStmt.run(clusterKey, id);
    },
    /** Every open escalation routed to the user in a project, questions and raw rows alike. */
    openUserEscalations(projectId: string): Escalation[] {
      return openUserEscalationsStmt.all(projectId).map(toEscalation);
    },
    /** Every escalation in a project that carries a cluster key, oldest first. */
    escalationsByCluster(projectId: string, clusterKey: string): Escalation[] {
      return escalationsByClusterStmt.all(projectId, clusterKey).map(toEscalation);
    },
    /** Escalations whose rationale box has not been shown yet, by the reason it was set. */
    escalationsWithPendingRationale(projectId: string, reason: string): Escalation[] {
      return escalationsWithRationaleStmt.all(projectId, reason).map(toEscalation);
    },
    /** Record the user's Keep on a mixed-evidence question, so it is never asked again (BB-35 step 5). */
    markLessonValidated(id: string): void {
      setLessonValidatedStmt.run(now(), now(), id);
    },
    /** Record that a validation item was filed for a lesson, so the next pass can apply the silence default (BB-35 step 5). */
    markLessonValidationFiled(id: string, at = now()): void {
      markLessonValidationFiledStmt.run(at, at, id);
    },
    /** How many of one project's validation items were filed at or after `at` (BB-35 step 5's rolling weekly cap). */
    validationsFiledSince(projectId: string, at: number): number {
      return Number(countValidationsSinceStmt.get(projectId, at)?.n ?? 0);
    },
    /** The open validation item for a lesson, or null (BB-35 step 5). */
    openLessonValidationNeed(lessonId: string): Need | null {
      const r = openLessonValidationNeedStmt.get(lessonId);
      return r === undefined ? null : toNeed(r);
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
      const map: Record<string, string> = { threadId: "thread_id", digest: "digest", digestAt: "digest_at", nightlyDate: "nightly_date", digestPending: "digest_pending", title: "title", sectionId: "section_id", pendingNotes: "pending_notes" };
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length > 0) db.prepare(`UPDATE project_stewards SET ${entries.map(([k]) => `${map[k]} = ?`).join(", ")} WHERE project_id = ?`).run(...entries.map(([, v]) => toColumn(v)), projectId);
      return toProject(getProject.get(projectId)!);
    },
    projects(): ProjectStewardRow[] {
      return db.prepare<[], Record<string, unknown>>("SELECT * FROM project_stewards").all().map(toProject);
    },
    /** Queue a silent note for the project steward's next digest; it starts no turn. */
    noteProject(projectId: string, text: string): void {
      upsertProject.run(projectId);
      const row = toProject(getProject.get(projectId)!);
      db.prepare("UPDATE project_stewards SET pending_notes = ? WHERE project_id = ?").run(JSON.stringify([...row.pendingNotes, text]), projectId);
    },
    /** The queued digest notes, without clearing them: a failed digest send must not lose them. */
    peekProjectNotes(projectId: string): string[] {
      upsertProject.run(projectId);
      return toProject(getProject.get(projectId)!).pendingNotes;
    },
    /** Drop the queued digest notes once the digest that carried them was sent. */
    clearProjectNotes(projectId: string): void {
      upsertProject.run(projectId);
      db.prepare("UPDATE project_stewards SET pending_notes = ? WHERE project_id = ?").run("[]", projectId);
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
