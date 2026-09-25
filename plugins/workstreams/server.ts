// bb-plugin-workstreams — backend entry.
//
// A board over the git checkouts under one or more scan roots. The
// host entry (host.ts) does the per-machine scanning; this module owns
// settings, caching, Linear enrichment, grouping, the RPC the board reads,
// and its write surfaces: `bb workstreams group` and the Board's confirm-first
// row actions (see actions.ts).
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  liveMergeSchema,
  rawUnitSchema,
  inventoryBoardSchema,
  type GroupLevel,
  type GroupNaming,
  type RawUnit,
  type Pr,
} from "./contract.js";
import { createEffortStore, EFFORT_MIGRATIONS, establishedEffortSchema, normalizeMembers, type EffortMembers } from "./effort-store.js";
import { createCoordinatorService, coordinateInputSchema, coordinateResultSchema, effortPlanSchema, type EffortPlan } from "./effort-coordinator.js";
import { planGroupingRepair, reviewGroupingRepair, repairRequestEstimate } from "./grouping-repair.js";
import { effortParent, activeCheckoutThread } from "./effort-routing.js";
import { inventoryEffort } from "./effort-membership.js";
import { createInventoryStore, EMPTY_INVENTORY, INVENTORY_MIGRATIONS } from "./inventory-store.js";
import type { InventoryResult } from "./inventory.js";
import {
  DEFAULT_SURFACE_RULES,
  LENSES,
  LIFECYCLES,
  RISKS,
  STALENESS,
  UNSORTED,
  buildBoard,
  outsideGrouping,
  parseTeamNames,
  rollOneOffs,
  buildEfforts,
  buildHierarchy,
  clusterInputHash,
  dominantSurface,
  clusterVocabulary,
  effortMemberHash,
  fallbackSummary,
  hashString,
  groupChildren,
  groupSeedItem,
  groupingRole,
  hierarchyDepth,
  memberHash,
  namingCandidates,
  parseSurfaceRules,
  placeClusters,
  relativeTime,
  type BoardGroup,
  type Cluster,
  type ClusterDecision,
  type ClusterLinear,
  type NamedGroup,
  type SeedContext,
  type SeedItem,
  type SummarizedCluster,
  type SurfaceRule,
} from "./workstreams.js";
import {
  ZERO_USAGE,
  assignToCandidates,
  migrateCandidateDecisions,
  candidatesFrom,
  clusterContext,
  decideWithJev,
  nameEfforts,
  nameGroups,
  namingContext,
  seedAssignables,
  type Assignable,
  type JevAnswer,
  type JevClient,
  type ModelUsage,
  type NamingClient,
} from "./enrich.js";
import {
  EVENT_READ,
  STRONG_TIERS,
  THREAD_TIERS,
  linkThread,
  strongLinkedClusters,
  threadWeights,
  pathsFromEvents,
  refreshWorkedPaths,
  threadCoverage,
  type LinkTarget,
  type ThreadFacts,
  type ThreadTier,
  type WorkedPaths,
  startedForOf,
  ticketsIn,
  withinPath,
} from "./threads.js";
import { startThread } from "./spawn.js";
import { AGENT_ACTIONS, MERGE_METHODS, mergeVerdict, shouldDeleteBranch, recommendThread, type DirectAction, type MergeMethod, type ThreadCandidate } from "./actions.js";
import { planAgent, runAgent, type AgentSdk } from "./agent.js";
import { sendRowMessage } from "./threadmessage.js";
import { archiveLinkedThread, restoreArchivedThread, archiveRecordSchema, ARCHIVE_HISTORY_LIMIT, type ArchiveStore } from "./threadarchive.js";
import { executeMerge, type WriteResult } from "./direct.js";
import { prTarget } from "./ghactions.js";
import { trackTransitions, toLifecycle, unitLifecycle, type Transition } from "./workstreams.js";
import { TypeSafeClient, choice, score } from "@typesafe-ai/sdk";
import { RUNS_MIGRATION, createRunStore } from "./runstore.js";
import { RUN_STATUSES, ROW_RUN_MS, directOutcome, type Run, type ThreadSignal } from "./runs.js";
import { createRescanQueue } from "./rescan.js";
import { createPrFreshness } from "./pr-freshness.js";
import { scanFailure } from "./scancancel.js";
import { parseLinearKeys, projectNameOf } from "./linear.js";
import { AGENT_FETCH_MAX, parseAgentAnswer, startLinearFetch } from "./linearagent.js";
import { PIN_AFTER, planClusterAsks, type AskMemory } from "./asks.js";
import { LINEAR_DETAIL_MIGRATION, createLinearSync } from "./linearsync.js";
import { TICKET_SOURCES, linkbacksDue, ticketFinder, type LinkbackCheck, type TicketFacts } from "./tickets.js";
import { ADVANCE_MIGRATIONS, createAdvanceService, advancePreviewSchema, advanceBatchSchema, advanceRepairPlanSchema, advanceRepairRunSchema, advanceRepairResultSchema, type AdvanceFacts, type AdvanceJob } from "./bulk-advance.js";
import { projectForPath } from "./spawn.js";
import { DISPATCH_MIGRATIONS, createDispatchStore, selectCandidate, gateStillOpen, type DispatchState } from "./dispatch.js";

const DEFAULT_TICKET_PATTERN = "([A-Za-z]{2,5})-(\\d{1,6})";
const SCAN_TIMEOUT_MS = 10 * 60 * 1_000;
const NAMING_TIMEOUT_MS = 5 * 60 * 1_000;
/** How long a dead host worker waits for the dispose that says a reload killed it. */
const RELOAD_GRACE_MS = 5_000;
const BOARD_CHANGED = "board-changed";
/** Several runs finishing together share one targeted rescan. */
const RESCAN_DELAY_MS = 3_000;
/** More paths than this in one batch: rescan everything instead. */
const TARGETED_MAX = 8;

const lifecycleSchema = z.enum(LIFECYCLES);
const stalenessSchema = z.enum(STALENESS);
const riskSchema = z.enum(RISKS);
const unitSchema = rawUnitSchema.extend({
  ticket: z.string().nullable(),
  ticketSource: z.enum(TICKET_SOURCES).nullable(),
  lifecycle: lifecycleSchema,
  stack: z
    .object({
      id: z.string(),
      position: z.number(),
      size: z.number(),
      blockedBelow: z.number().nullable(),
    })
    .nullable(),
  staleness: stalenessSchema,
  surfaces: z.array(z.string()),
  risk: riskSchema,
  /**
   * When a scan SAW this checkout enter its current lifecycle, or null when it
   * has been there since before tracking began. Never a proxy: the Board falls
   * back to the last commit itself, and labels it as such.
   */
  enteredAt: z.string().nullable(),
});
/** A BB thread linked to a cluster, and the rule that linked it. Read-only. */
const threadLinkSchema = z.object({
  id: z.string(),
  title: z.string(),
  tier: z.enum(THREAD_TIERS),
  /** Running a turn right now: an agent is working here. */
  active: z.boolean(),
});
const clusterSchema = z.object({
  ticket: z.string(),
  lifecycle: lifecycleSchema,
  summary: z.string(),
  units: z.array(unitSchema),
  staleness: stalenessSchema,
  surfaces: z.array(z.string()),
  risk: riskSchema,
  /** The cluster's ONE home on the Risk face; see `dominantSurface`. */
  dominant: z.object({ surface: z.string().nullable(), risk: riskSchema }),
  threads: z.array(threadLinkSchema),
  /** What Linear says about the ticket, for the row's hover. Null when nothing is known. */
  linear: z
    .object({ title: z.string().nullable(), state: z.string().nullable(), project: z.string().nullable(), url: z.string().nullable() })
    .nullable(),
});
/**
 * The hierarchy goes over the wire FLAT, with a parent key. A recursive schema
 * would have to describe a depth the collapse rules deliberately leave
 * undecided; a flat list describes any collapsed shape without caring which
 * level ended up at the root.
 */
const groupSchema = z.object({
  level: z.enum(["domain", "program", "effort"]),
  key: z.string(),
  parentKey: z.string().nullable(),
  name: z.string(),
  rollup: z.string(),
  lifecycle: lifecycleSchema,
  cohesion: z
    .object({ verdict: z.enum(["cohesive", "mixed"]), reason: z.string().nullable() })
    .nullable(),
  clusters: z.array(clusterSchema),
  repoCount: z.number(),
  merged: z.number(),
  total: z.number(),
  staleness: stalenessSchema,
  surfaces: z.array(z.string()),
  risk: riskSchema,
});
/** One agent or direct row action, and how it went. See runs.ts. */
const runSchema = z.object({
  id: z.number(),
  kind: z.enum(["agent", "direct"]),
  action: z.string(),
  path: z.string(),
  ticket: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  threadId: z.string().nullable(),
  mode: z.enum(["continue", "subthread", "new"]).nullable(),
  startedAt: z.number(),
  status: z.enum(RUN_STATUSES),
  finishedAt: z.number().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
});
/** Which model keys are in play. Reported so the board never lies about it. */
const modeSchema = z.enum(["basic", "jev", "jev+claude"]);
/** The last enrichment's model use, so model cost is visible on the board. */
const enrichmentSchema = z.object({
  mode: modeSchema,
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  at: z.string(),
});

const boardSchema = z.object({
  efforts: z.array(establishedEffortSchema).default([]),
  prInventory: inventoryBoardSchema.default(EMPTY_INVENTORY),
  groups: z.array(groupSchema),
  /** How many grouping levels survived the collapse: 1, 2 or 3. */
  depth: z.number(),
  /** Every surface the current rule table can produce, for the filter control. */
  surfaces: z.array(z.string()),
  mode: modeSchema,
  /**
   * The machine every checkout was scanned on. The Board needs it to name a
   * checkout as a host file target when opening it.
   */
  hostId: z.string().nullable(),
  lastScanAt: z.string().nullable(),
  scanning: z.boolean(),
  warnings: z.array(z.string()),
  /** How many threads the link rules reached, by strongest tier. Reported, never inflated. */
  threadCoverage: z.object({
    threads: z.number(),
    linked: z.number(),
    byTier: z.object({
      started: z.number(),
      environment: z.number(),
      ticket: z.number(),
      paths: z.number(),
    }),
    clustersWithThread: z.number(),
  }),
  /** For the How-this-works panel: how often the board refreshes, and what the last enrichment cost. */
  health: z.object({ refreshMinutes: z.number(), enrichment: enrichmentSchema.nullable() }),
  /** Open runs and the last day's, newest first: what the rows, the Agents strip and How this works report. */
  runs: z.array(runSchema),
  dispatch: z.object({
    mode: z.enum(["off", "shadow", "auto"]),
    effortKey: z.string().nullable(),
    candidate: z.object({ path: z.string(), prUrl: z.string(), action: z.enum(AGENT_ACTIONS), reason: z.string() }).nullable(),
    attempts: z.array(z.object({ id: z.number(), path: z.string(), prUrl: z.string(), action: z.string(),
      status: z.enum(["launching", "running", "verifying", "verified", "needs-you", "failed"]),
      detail: z.string(), threadId: z.string().nullable(), startedAt: z.number() })),
  }),
});

/** What the lens control remembers across a reload. */
const prefsSchema = z.object({
  lens: z.enum(LENSES),
  staleness: z.array(stalenessSchema),
  surfaces: z.array(z.string().max(40)).max(40),
  /** The canvas can colour by status OR by surface, never both at once. */
  colorBy: z.enum(["status", "surface"]),
  /** Which face of the Map is up. A default, so prefs saved before faces still parse. */
  face: z.enum(["theme", "risk"]).default("theme"),
  /** The Board's filter: list ticketless default-branch clones under Parked. */
  showClones: z.boolean().default(false),
  /** Shared display filter for open PRs approved on GitHub. */
  approvedOnly: z.boolean().default(false),
});

const pathInput = z.object({ path: z.string().max(1_000) }).strict();
const prUrlInput = z.object({ prUrl: z.string().max(500) }).strict();
const directInput = z.union([pathInput, prUrlInput]);
type DirectTarget = z.infer<typeof directInput>;
const writeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), detail: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const threadModeSchema = z.enum(["continue", "subthread", "new"]);

export const rpcContract = defineRpcContract({
  board_get: { input: z.null(), output: boardSchema },
  effort_plan: { input: z.object({ groupKey: z.string().min(1).max(500) }).strict(), output: effortPlanSchema },
  effort_coordinate: { input: coordinateInputSchema, output: coordinateResultSchema },
  advance_preview: { input: z.object({ prUrls: z.array(z.string().max(500)).min(1).max(100) }).strict(), output: advancePreviewSchema },
  advance_start: { input: z.object({ token: z.string().uuid() }).strict(), output: advanceBatchSchema },
  advance_get: { input: z.null(), output: z.array(advanceBatchSchema) },
  advance_cancel: { input: z.object({ batchId: z.string().uuid() }).strict(), output: advanceBatchSchema },
  advance_recheck: { input: z.object({ batchId: z.string().uuid() }).strict(), output: advanceBatchSchema },
  advance_repair_plan: { input: z.object({ batchId: z.string().uuid(), jobId: z.string().uuid() }).strict(), output: advanceRepairPlanSchema },
  advance_repair_run: { input: advanceRepairRunSchema, output: advanceRepairResultSchema },
  inventory_refresh: { input: z.null(), output: z.object({ started: z.boolean() }) },
  dispatch_set: {
    input: z.object({ mode: z.enum(["off", "shadow", "auto"]), effortKey: z.string().nullable() }).strict(),
    output: boardSchema.shape.dispatch,
  },
  /** Read-only: re-read the PR live for the merge dialog. */
  action_merge_preview: {
    input: directInput,
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        live: liveMergeSchema,
        refusals: z.array(z.string()),
        warnings: z.array(z.string()),
        method: z.enum(MERGE_METHODS),
        deleteBranch: z.boolean(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Merge, pinned to the head sha the dialog showed. Re-checked server-side first. */
  action_merge: {
    input: z.union([
      pathInput.extend({ sha: z.string().regex(/^[0-9a-f]{40}$/u), acknowledgeUnresolved: z.boolean() }),
      prUrlInput.extend({ sha: z.string().regex(/^[0-9a-f]{40}$/u), acknowledgeUnresolved: z.boolean() }),
    ]),
    output: writeResult,
  },
  action_update_branch: { input: directInput, output: writeResult },
  /** Re-request the scan's pending reviewers and/or post a comment (sent to gh on stdin). */
  action_nudge: {
    input: z.union([
      pathInput.extend({ rerequest: z.boolean(), comment: z.string().max(4_000).nullable() }),
      prUrlInput.extend({ rerequest: z.boolean(), comment: z.string().max(4_000).nullable() }),
    ]),
    output: writeResult,
  },
  /** Read-only: the row's linked threads, live, and where the agent action should run. */
  agent_plan: {
    input: z.object({ path: z.string().max(1_000), action: z.enum(AGENT_ACTIONS) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        candidates: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            tier: z.enum(THREAD_TIERS),
            running: z.boolean(),
            contextUsed: z.number().nullable(),
            canSpawnChild: z.boolean(),
          }),
        ),
        recommendation: z.object({ mode: threadModeSchema, threadId: z.string().nullable(), reason: z.string() }),
        capabilities: z.object({ send: z.boolean(), subthread: z.boolean(), contextUsage: z.boolean() }),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Run an agent action in its own subthread or new thread. */
  agent_run: {
    input: z
      .object({
        path: z.string().max(1_000),
        action: z.enum(AGENT_ACTIONS),
        mode: threadModeSchema,
        threadId: z.string().max(200).nullable(),
        prompt: z.string().max(8_000),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), threadId: z.string(), ticket: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Read-only: how many tickets the manual Linear fallback would ask an agent about. */
  linear_fetch_plan: {
    input: z.null(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), tickets: z.number(), capped: z.number(), running: z.boolean(), keys: z.number() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Start the ONE fallback thread. Manual only; never scheduled. */
  linear_fetch_run: {
    input: z.null(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), threadId: z.string(), asked: z.number() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** Open runs only: the sidebar badge's cheap read. */
  runs_open: { input: z.null(), output: z.array(runSchema) },
  board_refresh: {
    input: z.null(),
    output: z.object({ started: z.boolean() }),
  },
  prefs_get: { input: z.null(), output: prefsSchema },
  prefs_set: { input: prefsSchema, output: prefsSchema },
  /**
   * Start a BB thread in one checkout. The client names the path; the unit and
   * its cluster are looked up from the server's own last scan.
   */
  thread_start: {
    input: z.object({ path: z.string().max(1_000), prompt: z.string().max(8_000) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), threadId: z.string(), ticket: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  thread_archive: { input: z.object({ threadId: z.string().max(200) }).strict(), output: writeResult },
  thread_restore: { input: z.object({ threadId: z.string().max(200) }).strict(), output: writeResult },
  thread_archived: { input: z.object({}).strict(), output: z.array(archiveRecordSchema) },
  /** Send one user-authored instruction to one thread currently linked to this PR row. */
  thread_message: {
    input: z.object({ path: z.string().max(1_000), prUrl: z.string().max(500), threadId: z.string().max(200), message: z.string().max(4_000) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), delivery: z.enum(["sent", "queued"]) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
});

export type Board = z.infer<typeof boardSchema>;
export type BoardMode = z.infer<typeof modeSchema>;
export type Prefs = z.infer<typeof prefsSchema>;
export type WireGroup = z.infer<typeof groupSchema>;
export type WireRun = z.infer<typeof runSchema>;

function mergeMethodOf(value: string): MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(value) ? (value as MergeMethod) : "squash";
}

const DEFAULT_PREFS: Prefs = {
  lens: "all",
  staleness: [],
  surfaces: [],
  colorBy: "status",
  face: "theme",
  showClones: false,
  approvedOnly: false,
};

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    scanRoots: {
      type: "string",
      label: "Scan roots",
      description:
        "Newline-separated absolute paths. Each root's immediate children (and the root itself) are checked for a .git entry. Leave empty to fall back to the paths of every BB project.",
      experimental_multiline: true,
      default: "",
    },
    ticketPattern: {
      type: "string",
      label: "Ticket pattern",
      description:
        "Regular expression with two capture groups (prefix, number), matched against the branch name first and then the directory name. The match is uppercased to form the cluster key.",
      default: DEFAULT_TICKET_PATTERN,
    },
    linearApiKeys: {
      type: "string",
      label: "Linear API keys",
      description:
        "Optional. One or more Linear personal API keys, separated by commas or spaces (one per workspace). Each ticket is looked up with the key whose workspace owns its team prefix; a prefix no key owns gets no Linear detail. Ticket titles, parents and projects then inform grouping and naming; a shared parent or project merges tickets that share any other signal. Keys stay on the server and are never logged.",
      secret: true,
    },
    linearApiKey: {
      type: "string",
      label: "Linear API key (single, older setting)",
      description:
        "Optional. Still read, and merged with Linear API keys above, so a key entered here keeps working. Prefer the list above for new keys.",
      secret: true,
    },
    refreshMinutes: {
      type: "number",
      label: "Refresh interval (minutes)",
      experimental_schema: z.number().int().min(1).max(240),
      default: 10,
    },
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe (Jev) API key",
      description:
        "Optional. When set, Jev selects each cluster's summary from its own pull request titles and groups clusters into efforts.",
      secret: true,
    },
    anthropicApiKey: {
      type: "string",
      label: "Anthropic API key",
      description:
        "Optional. When set alongside the TypeSafe key, Claude renames each effort with a written category name. Nothing else uses it.",
      secret: true,
    },
    surfaceRules: {
      type: "string",
      label: "Surface rules",
      description:
        "One line per surface: `name: glob, glob, ...`, matched against the paths a branch changes. Risk is derived from the surfaces present (auth, payments and migrations are high; docs and tests are low). A table that cannot be parsed is ignored in favour of the default, with a warning on the board.",
      experimental_multiline: true,
      default: DEFAULT_SURFACE_RULES,
    },
    mergeMethod: {
      type: "select",
      label: "Merge method",
      description: "How the Board's Merge action merges a pull request.",
      options: [...MERGE_METHODS],
      default: "squash",
    },
    deleteBranchOnMerge: {
      type: "boolean",
      label: "Delete branch on merge",
      description:
        "Delete the head branch after the Board merges a pull request. Always skipped when another open pull request is based on that branch.",
      default: true,
    },
    teamNames: {
      type: "string",
      label: "Team names",
      description:
        "Optional. Names for the containers one-off tickets are filed into, by ticket prefix: `ABC=Storefront, OPS=Operations`. Without one, the Linear team name is used when a Linear key can see the team, and otherwise the prefix itself.",
      default: "",
    },
    assignmentConfidenceThreshold: {
      type: "number",
      label: "Effort assignment confidence",
      description:
        "0-1. A cluster whose effort fit scores below this lands in Unsorted rather than being force-fitted into a confident-looking effort.",
      experimental_schema: z.number().min(0).max(1),
      default: 0.6,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS units (path TEXT PRIMARY KEY, unit TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS linear_tickets (ticket TEXT PRIMARY KEY, project TEXT, fetched_at INTEGER NOT NULL)`,
    // Keyed by the cluster's SEMANTIC hash, so a lifecycle or count change on
    // the next scan reuses the row instead of paying for it again.
    `CREATE TABLE IF NOT EXISTS cluster_decisions (hash TEXT PRIMARY KEY, summary TEXT, label TEXT, fit REAL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS effort_names (member_hash TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    // Append-only. The three statements below widen the effort-name cache into
    // a group-name cache for every level, WITHOUT dropping it: the effort
    // level's member hash is computed exactly as it was in v3, so every name
    // already paid for still hits on the first scan after this migration.
    `ALTER TABLE effort_names ADD COLUMN level TEXT NOT NULL DEFAULT 'effort'`,
    `ALTER TABLE effort_names ADD COLUMN cohesion TEXT`,
    `ALTER TABLE effort_names ADD COLUMN cohesion_reason TEXT`,
    // Which effort/program a child was assigned to, keyed on the child's own
    // member hash. Same contract as cluster_decisions, one rung up: a level
    // whose membership did not change costs nothing on a rescan.
    `CREATE TABLE IF NOT EXISTS group_assignments (level TEXT NOT NULL, member_hash TEXT NOT NULL, label TEXT NOT NULL, fit REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (level, member_hash))`,
    // The absolute paths a thread's recent events worked in, keyed on the
    // thread's `updatedAt` at read time: an unchanged thread is never re-read.
    `CREATE TABLE IF NOT EXISTS thread_paths (thread_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, paths TEXT NOT NULL)`,
    // When each checkout was SEEN to enter its current lifecycle. entered_at is
    // null until a change is observed: the first scan cannot know how long a
    // PR had already been red. See `trackTransitions`.
    `CREATE TABLE IF NOT EXISTS unit_transitions (path TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, entered_at INTEGER)`,
    // One row per agent or direct row action; bounded, pruned on write. See runstore.ts.
    RUNS_MIGRATION,
    // Full Linear detail per ticket, from a key or the agent fallback. Supersedes
    // linear_tickets (left in place: migrations are append-only).
    LINEAR_DETAIL_MIGRATION,
    // Per cluster key: the semantic hash last seen, and the label-vanished damper's streak. See asks.ts.
    `CREATE TABLE IF NOT EXISTS cluster_asks (ticket TEXT PRIMARY KEY, hash TEXT NOT NULL, streak INTEGER NOT NULL, pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // Per PR URL: the ticket its Linear linkback comment names (null: none), and
    // when it was read. `final` marks a PR that was merged or closed when read:
    // never read again. Comment text is never stored.
    `CREATE TABLE IF NOT EXISTS pr_linkbacks (url TEXT PRIMARY KEY, ticket TEXT, checked_at INTEGER NOT NULL, final INTEGER NOT NULL)`,
    ...DISPATCH_MIGRATIONS,
    ...INVENTORY_MIGRATIONS,
    ...EFFORT_MIGRATIONS,
    `CREATE TABLE IF NOT EXISTS grouping_repairs (ticket TEXT PRIMARY KEY, label TEXT NOT NULL, hash TEXT NOT NULL, evidence TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS grouping_legacy_labels (hash TEXT PRIMARY KEY, label TEXT NOT NULL)`,
    ...ADVANCE_MIGRATIONS,
  ]);
  const runs = createRunStore(db);
  const dispatch = createDispatchStore(db);
  const inventory = createInventoryStore(db);
  const effortStore = createEffortStore(db);
  dispatch.closeStranded();

  const host = bb.hosts.experimental_client({ contract: hostContract });

  // ---- persisted state -------------------------------------------------

  function readUnits(): RawUnit[] {
    const rows = db.prepare(`SELECT unit FROM units`).all() as { unit: string }[];
    return rows.flatMap((row) => {
      const parsed = rawUnitSchema.safeParse(JSON.parse(row.unit));
      return parsed.success ? [{ ...parsed.data, observed: parsed.data.observed ?? { status: false, pr: false } }] : [];
    });
  }

  function writeUnits(units: RawUnit[]): void {
    const insert = db.prepare(`INSERT INTO units (path, unit) VALUES (?, ?)`);
    db.transaction(() => {
      db.prepare(`DELETE FROM units`).run();
      for (const unit of units) insert.run(unit.path, JSON.stringify(unit));
    })();
  }

  function readTransitions(): Map<string, Transition> {
    const rows = db
      .prepare(`SELECT path, lifecycle, entered_at FROM unit_transitions`)
      .all() as { path: string; lifecycle: string; entered_at: number | null }[];
    return new Map(
      rows.map((row) => [row.path, { lifecycle: toLifecycle(row.lifecycle), enteredAt: row.entered_at }]),
    );
  }

  /** Advance the transition table by one scan's worth of units. */
  function recordTransitions(units: RawUnit[]): void {
    const next = trackTransitions(
      readTransitions(),
      units.map((unit) => ({ path: unit.path, lifecycle: unitLifecycle(unit) })),
      Date.now(),
    );
    const insert = db.prepare(`INSERT INTO unit_transitions (path, lifecycle, entered_at) VALUES (?, ?, ?)`);
    db.transaction(() => {
      db.prepare(`DELETE FROM unit_transitions`).run();
      for (const [path, value] of next) insert.run(path, value.lifecycle, value.enteredAt);
    })();
  }

  async function readOverrides(): Promise<Record<string, string>> {
    return (await bb.storage.kv.get<Record<string, string>>("overrides")) ?? {};
  }

  // ---- Linear enrichment ----------------------------------------------

  const linear = createLinearSync({
    db,
    fetch: (url, init) => fetch(url, init),
    log: bb.log,
  });
  settings.onChange((next, prev) => {
    if (next.linearApiKeys !== prev.linearApiKeys || next.linearApiKey !== prev.linearApiKey) linear.invalidate();
  });

  async function linearKeys(): Promise<string[]> {
    const { linearApiKeys, linearApiKey } = await settings.get();
    return parseLinearKeys(linearApiKeys, linearApiKey);
  }

  /** Ticket → what the board shows and seeds from. Empty when nothing is cached. */
  function clusterLinearOf(tickets: string[]): Record<string, ClusterLinear> {
    const out: Record<string, ClusterLinear> = {};
    for (const [ticket, detail] of linear.read(tickets)) {
      out[ticket] = {
        title: detail.title,
        state: detail.state?.name ?? null,
        project: detail.project?.name ?? null,
        parentIdentifier: detail.parent?.identifier ?? null,
        parentTitle: detail.parent?.title ?? null,
        url: detail.url,
      };
    }
    return out;
  }

  /** The v1 name source: project, else parent title. See `workstreamName`. */
  function cachedProjects(tickets: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [ticket, detail] of linear.read(tickets)) out[ticket] = projectNameOf(detail);
    return out;
  }

  // ---- scanning --------------------------------------------------------

  let scanning = false;
  /** Aborts every in-flight scan when a reload disposes the plugin. */
  const disposal = new AbortController();
  bb.onDispose(() => disposal.abort());

  let inventoryRefreshing = false;
  let inventoryTargeting = false;
  function inventoryOwners(): string[] {
    return [...new Set(readUnits().flatMap((unit) => {
      const repo = unit.githubRepo ?? (unit.pr === null ? null : prTarget(unit.pr.url)?.slug ?? null);
      return repo !== null && repo.split("/").length === 2 ? [repo.split("/")[0]!.toLowerCase()] : [];
    }))].sort();
  }
  async function refreshInventory(signal = disposal.signal): Promise<boolean> {
    if (inventoryRefreshing || inventoryTargeting || signal.aborted) return false;
    inventoryRefreshing = true;
    const owners = inventoryOwners();
    bb.realtime.publish(BOARD_CHANGED, { scanning });
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (hostId === null) throw new Error("No primary BB host is available to read authored PRs.");
      const result = await host.call("authoredPrs", { owners }, { hostId, signal, timeoutMs: SCAN_TIMEOUT_MS });
      inventory.apply(result);
      advance.invalidate(result.entries.map((entry) => entry.pr));
      return result.complete;
    } catch (error) {
      if (!signal.aborted) {
        const result: InventoryResult = { owners, entries: [], repositories: [], complete: false, discoveryComplete: false,
          warnings: [`Authored PR refresh failed: ${String(error).slice(0, 400)}`] };
        inventory.apply(result);
      }
      return false;
    } finally {
      inventoryRefreshing = false;
      if (!disposal.signal.aborted) bb.realtime.publish(BOARD_CHANGED, { scanning });
    }
  }

  /** Native BB events invalidate these URLs; GitHub remains the facts source. */
  async function refreshInventoryUrls(prUrls: string[]): Promise<boolean> {
    if (inventoryRefreshing || inventoryTargeting || disposal.signal.aborted) return false;
    const urls = [...new Set(prUrls)].filter((url) => inventory.get(url) !== undefined || readUnits().some((unit) => unit.pr?.url === url));
    if (urls.length === 0) return true;
    inventoryTargeting = true;
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (hostId === null) return true;
      for (let offset = 0; offset < urls.length; offset += 100) {
        const result = await host.call("inspectPrs", { prUrls: urls.slice(offset, offset + 100) }, { hostId, signal: disposal.signal, timeoutMs: SCAN_TIMEOUT_MS });
        inventory.inspect(result);
        advance.invalidate(result.entries.map((entry) => entry.pr));
        const fresh = new Map(result.entries.map((entry) => [entry.pr.url.toLowerCase(), entry.pr]));
        const closed = new Set(result.closed.map((url) => url.toLowerCase()));
        const insert = db.prepare(`INSERT OR REPLACE INTO units (path, unit) VALUES (?, ?)`);
        for (const unit of readUnits()) {
          if (unit.pr === null) continue;
          const url = unit.pr.url.toLowerCase();
          const pr = fresh.get(url);
          if (pr !== undefined) insert.run(unit.path, JSON.stringify({ ...unit, pr }));
          else if (closed.has(url)) {
            // Fetch the checkout too: it distinguishes merged/release-tagged from closed.
            rescans.add(unit.path);
          }
        }
      }
      recordTransitions(readUnits());
      return true;
    } catch (error) {
      if (!disposal.signal.aborted) {
        inventory.inspect({ entries: [], closed: [], failed: urls, warnings: [`PR refresh failed: ${String(error).slice(0, 400)}`] });
      }
      return true;
    } finally {
      inventoryTargeting = false;
      if (!disposal.signal.aborted) bb.realtime.publish(BOARD_CHANGED, { scanning });
    }
  }
  const inventoryRefreshes = createRescanQueue({ delayMs: RESCAN_DELAY_MS, rescan: refreshInventoryUrls,
    onError: (error) => bb.log.warn(`PR refresh queue: ${String(error).slice(0, 300)}`) });
  function scheduleInventoryUrls(urls: readonly string[]): void {
    for (const url of urls) inventoryRefreshes.add(url);
  }
  bb.onDispose(() => inventoryRefreshes.dispose());

  async function resolveRoots(configured: string): Promise<{
    roots: string[];
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const listed = configured
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const absolute = listed.filter((path) => {
      if (path.startsWith("/")) return true;
      warnings.push(`Ignoring scan root "${path}": roots must be absolute paths.`);
      return false;
    });
    if (absolute.length > 0) return { roots: absolute, warnings };
    const projects = await bb.sdk.projects.list();
    const roots = [
      ...new Set(
        projects.flatMap((project) =>
          project.sources.map((source) => source.path),
        ),
      ),
    ];
    if (roots.length === 0) {
      warnings.push(
        "No scan roots configured and no BB project paths found. Set the scanRoots setting.",
      );
    }
    return { roots: roots.slice(0, 50), warnings };
  }

  async function scan(caller?: AbortSignal): Promise<boolean> {
    if (scanning) return false;
    scanning = true;
    const signal = caller === undefined ? disposal.signal : AbortSignal.any([caller, disposal.signal]);
    bb.realtime.publish(BOARD_CHANGED, { scanning: true });
    try {
      const { scanRoots, ticketPattern } = await settings.get();
      const { roots, warnings } = await resolveRoots(scanRoots);
      if (roots.length === 0) {
        await bb.storage.kv.set("warnings", warnings);
        return false;
      }
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (hostId === null) {
        await bb.storage.kv.set("warnings", [
          ...warnings,
          "No primary BB host is available to scan from.",
        ]);
        return false;
      }
      const result = await host.call(
        "scan",
        { roots },
        { hostId, signal, timeoutMs: SCAN_TIMEOUT_MS },
      );
      writeUnits(result.units);
      recordTransitions(result.units);
      inventory.observe(result.units.flatMap((unit) => unit.pr === null ? [] : [unit.pr]));
      advance.invalidate(result.units.flatMap((unit) => unit.pr === null ? [] : [unit.pr]));
      await refreshInventory(signal);
      warnings.push(...result.warnings);

      // Tickets are resolved BEFORE Linear is synced, so a ticket found in a PR
      // title, description or linkback gets its detail in this same scan and the
      // regroup it causes is paid for once. Team keys are kept only from a
      // discovery every key answered: a flaky lookup must not flip tickets.
      const pattern = compilePattern(ticketPattern);
      const keys = await linearKeys();
      const teams = await linear.teams(keys, signal);
      if (teams.complete) {
        await bb.storage.kv.set("linearTeams", teams.keys);
        await bb.storage.kv.set("linearTeamNames", teams.names);
      }
      await readLinkbackComments(pattern, result.units, hostId, signal);
      // A Linear outage keeps the previous cache and is logged once; it never fails a scan.
      await linear.sync(keys, ticketsOf(await findTickets(pattern, result.units), result.units), signal);

      // The first scan after a load waits for the thread list: threads seed the grouping.
      if (!threadsSynced) await syncThreads();
      try {
        warnings.push(...(await enrich(signal)));
      } catch (error) {
        // A reload is not a grouping failure: let the outer catch log it as cancelled.
        if (disposal.signal.aborted) throw error;
        // Grouping is an enhancement over a board that already works. Losing it
        // must never lose the scan that produced the board.
        warnings.push(`Effort grouping failed: ${String(error).slice(0, 200)}`);
        bb.log.warn(`enrich failed: ${String(error)}`);
      }

      await bb.storage.kv.set("lastScanAt", new Date().toISOString());
      await bb.storage.kv.set("warnings", warnings.slice(0, 50));
      recoverDispatch();
      bb.log.info(`scanned ${result.units.length} units across ${roots.length} roots`);
      // After the scan, never inside it: a slow thread log must not hold the
      // board, and a failed one must not fail the scan.
      void syncThreads();
      queueMicrotask(() => void dispatchOne());
      return true;
    } catch (error) {
      // A reload killing the scan is a cancellation: no error, no warning.
      if ((await scanFailure(error, disposal.signal, RELOAD_GRACE_MS)) === "cancelled") {
        bb.log.info("scan cancelled by reload");
        return false;
      }
      await bb.storage.kv.set("warnings", [
        `Scan failed: ${String(error).slice(0, 400)}`,
      ]);
      bb.log.error(`scan failed: ${String(error)}`);
      return false;
    } finally {
      scanning = false;
      bb.realtime.publish(BOARD_CHANGED, { scanning: false });
    }
  }

  function compilePattern(source: string): RegExp {
    try {
      return new RegExp(source);
    } catch {
      bb.log.warn(`invalid ticketPattern "${source}"; using the default`);
      return new RegExp(DEFAULT_TICKET_PATTERN);
    }
  }

  /** Linear team keys from the last complete discovery; see `readLinkbackComments` and `ticketFinder`. */
  async function knownTeams(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>("linearTeams")) ?? [];
  }

  function readLinkbacks(): Map<string, string> {
    const rows = db.prepare(`SELECT url, ticket FROM pr_linkbacks WHERE ticket IS NOT NULL`).all() as { url: string; ticket: string }[];
    return new Map(rows.map((row) => [row.url, row.ticket]));
  }

  /** The ticket finder for this board: every source, with the prose allowlist built over all of it. */
  async function findTickets(pattern: RegExp, units: readonly TicketFacts[]) {
    return ticketFinder(pattern, units, { teams: await knownTeams(), linkbacks: readLinkbacks() });
  }

  function ticketsOf(find: (unit: TicketFacts) => { ticket: string } | null, units: readonly TicketFacts[]): string[] {
    return [...new Set(units.flatMap((unit) => { const ticket = find(unit)?.ticket; return ticket === undefined ? [] : [ticket]; }))];
  }

  /**
   * Read the Linear linkback comment of each PR that no cheaper source (branch,
   * title, description) gave a ticket. Cached per PR URL: an open PR is re-read
   * every few hours, a finished one once. Never fails a scan.
   */
  async function readLinkbackComments(pattern: RegExp, units: RawUnit[], hostId: string, signal: AbortSignal): Promise<void> {
    const find = await findTickets(pattern, units);
    const stateOf = new Map<string, string>();
    for (const unit of units) {
      if (unit.pr === null || unit.pr.url === "") continue;
      const source = find(unit)?.source;
      if (source === undefined || source === "directory") stateOf.set(unit.pr.url, unit.pr.state);
    }
    const rows = db.prepare(`SELECT url, checked_at, final FROM pr_linkbacks`).all() as { url: string; checked_at: number; final: number }[];
    const checked = new Map<string, LinkbackCheck>(rows.map((row) => [row.url, { checkedAt: row.checked_at, final: row.final !== 0 }]));
    const due = linkbacksDue([...stateOf.keys()].map((url) => ({ url })), checked, Date.now()).slice(0, 100);
    if (due.length === 0) return;
    try {
      const result = await host.call("linkbacks", { prUrls: due }, { hostId, signal, timeoutMs: SCAN_TIMEOUT_MS });
      const upsert = db.prepare(
        `INSERT INTO pr_linkbacks (url, ticket, checked_at, final) VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET ticket = excluded.ticket, checked_at = excluded.checked_at, final = excluded.final`,
      );
      const now = Date.now();
      db.transaction(() => {
        for (const entry of result.found) {
          const state = stateOf.get(entry.prUrl);
          upsert.run(entry.prUrl, entry.ticket, now, state === "MERGED" || state === "CLOSED" ? 1 : 0);
        }
      })();
      for (const warning of result.warnings) bb.log.warn(`linkback: ${warning}`);
      bb.log.info(`linkback: read ${result.found.length} of ${due.length} PR(s), ${result.found.filter((entry) => entry.ticket !== null).length} linked`);
    } catch (error) {
      if (signal.aborted) throw error;
      bb.log.warn(`linkback: comment read failed: ${String(error).slice(0, 200)}`);
    }
  }

  // ---- decisions: the only model-derived state, and its cache -----------

  function readDecision(hash: string): ClusterDecision | undefined {
    const row = db
      .prepare(`SELECT summary, label, fit FROM cluster_decisions WHERE hash = ?`)
      .get(hash) as { summary: string | null; label: string | null; fit: number | null } | undefined;
    if (row === undefined) return undefined;
    return {
      summary: row.summary,
      assignment:
        row.label === null || row.fit === null ? null : { label: row.label, fit: row.fit },
    };
  }

  function writeDecisions(decisions: Map<string, ClusterDecision>): void {
    const upsert = db.prepare(
      `INSERT INTO cluster_decisions (hash, summary, label, fit, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET summary = excluded.summary, label = excluded.label,
         fit = excluded.fit, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const [hash, decision] of decisions) {
        upsert.run(
          hash,
          decision.summary,
          decision.assignment?.label ?? null,
          decision.assignment?.fit ?? null,
          now,
        );
      }
    })();
  }

  function readGroupName(level: GroupLevel, hash: string): NamedGroup | undefined {
    const row = db
      .prepare(
        `SELECT name, cohesion, cohesion_reason FROM effort_names WHERE member_hash = ? AND level = ?`,
      )
      .get(hash, level) as
      | { name: string; cohesion: string | null; cohesion_reason: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      name: row.name,
      // A row written before the verdict existed has no cohesion. Rendering
      // nothing is correct; inventing "cohesive" would be a claim nobody made.
      cohesion:
        row.cohesion === "cohesive" || row.cohesion === "mixed"
          ? { verdict: row.cohesion, reason: row.cohesion_reason }
          : null,
    };
  }

  function writeGroupNames(level: GroupLevel, names: Map<string, NamedGroup>): void {
    const upsert = db.prepare(
      `INSERT INTO effort_names (member_hash, level, name, cohesion, cohesion_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_hash) DO UPDATE SET level = excluded.level, name = excluded.name,
         cohesion = excluded.cohesion, cohesion_reason = excluded.cohesion_reason,
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const [hash, named] of names) {
        upsert.run(hash, level, named.name, named.cohesion?.verdict ?? null, named.cohesion?.reason ?? null, now);
      }
    })();
  }

  function readGroupAssignment(
    level: GroupLevel,
    hash: string,
  ): { label: string; fit: number } | undefined {
    const row = db
      .prepare(`SELECT label, fit FROM group_assignments WHERE level = ? AND member_hash = ?`)
      .get(level, hash) as { label: string; fit: number } | undefined;
    return row;
  }

  function writeGroupAssignments(
    level: GroupLevel,
    assignments: Map<string, { label: string; fit: number }>,
  ): void {
    const upsert = db.prepare(
      `INSERT INTO group_assignments (level, member_hash, label, fit, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(level, member_hash) DO UPDATE SET label = excluded.label, fit = excluded.fit,
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const [hash, value] of assignments) upsert.run(level, hash, value.label, value.fit, now);
    })();
  }

  function modeOf(typesafeApiKey: unknown, anthropicApiKey: unknown): BoardMode {
    const jev = typeof typesafeApiKey === "string" && typesafeApiKey !== "";
    const claude = typeof anthropicApiKey === "string" && anthropicApiKey !== "";
    // Claude only renames efforts, and efforts only exist once Jev has grouped
    // clusters, so an Anthropic key on its own changes nothing.
    if (jev && claude) return "jev+claude";
    return jev ? "jev" : "basic";
  }

  /** Adapt the TypeSafe SDK to the narrow interface enrich.ts is written against. */
  function jevClient(apiKey: string, signal: AbortSignal): JevClient {
    const client = new TypeSafeClient({
      apiKey,
      logLevel: "off",
      timeout: 30_000,
      retry: { maxRetries: 1 },
    });
    return {
      async ask(state, questions) {
        const built = Object.fromEntries(
          Object.entries(questions).map(([name, question]) => [
            name,
            question.type === "choice"
              ? choice(question.instructions, question.criteria)
              : score(question.instructions, question.criteria),
          ]),
        );
        // The answer map is keyed by question name at runtime; the SDK's
        // per-question inference cannot follow a dynamically built map.
        const result = await client.systemOne({ state: state as never, questions: built }, { signal });
        return {
          answers: result.answers as unknown as Record<string, JevAnswer>,
          usage: result.usage,
        };
      },
    };
  }

  function namingClient(apiKey: string, hostId: string, signal: AbortSignal): NamingClient {
    return {
      name: (level: GroupLevel, groups: GroupNaming[]) =>
        host.call(
          "nameGroups",
          { apiKey, level, groups },
          { hostId, signal, timeoutMs: NAMING_TIMEOUT_MS },
        ),
    };
  }

  async function surfaceRules(): Promise<{ rules: SurfaceRule[]; warning: string | null }> {
    const { surfaceRules: table } = await settings.get();
    return parseSurfaceRules(typeof table === "string" ? table : DEFAULT_SURFACE_RULES);
  }

  /**
   * Everything a cluster needs to be placed on the board, resolved from cached
   * decisions alone. No model is called here: `board_get` must be cheap enough
   * to serve every realtime refresh.
   */
  async function readPlacement(): Promise<{
    labelled: { label: string; cluster: SummarizedCluster; fit: number }[];
    clusters: Cluster[];
    linearProjects: Record<string, string | null>;
    mode: BoardMode;
    rules: SurfaceRule[];
    warnings: string[];
    /** What `rollOneOffs` needs: overrides, and team names from the setting and from Linear. */
    roll: Parameters<typeof rollOneOffs>[1];
  }> {
    const { ticketPattern, typesafeApiKey, anthropicApiKey, assignmentConfidenceThreshold, teamNames: teamNamesText } =
      await settings.get();
    const units = readUnits();
    const pattern = compilePattern(ticketPattern);
    const overrides = await readOverrides();
    const warnings = new Set<string>();
    const { rules, warning } = await surfaceRules();
    if (warning !== null) warnings.add(warning);
    const teams = await knownTeams();
    const linkbacks = readLinkbacks();
    const tickets = ticketsOf(ticketFinder(pattern, units, { teams, linkbacks }), units);
    const linearProjects = cachedProjects(tickets);
    const workstreams = buildBoard(units, {
      pattern,
      teams,
      linkbacks,
      overrides,
      linearProjects,
      linear: clusterLinearOf(tickets),
      onWarning: (message) => warnings.add(message),
      surfaceRules: rules,
    });
    const mode = modeOf(typesafeApiKey, anthropicApiKey);
    const grouped = mode !== "basic";
    const teamNames = parseTeamNames(teamNamesText);
    if (teamNames.malformed > 0) {
      warnings.add(`Team names: ignored ${teamNames.malformed} entr${teamNames.malformed === 1 ? "y" : "ies"} that are not PREFIX=Name.`);
    }

    const inferred = placeClusters({
      workstreams,
      decisionFor: (cluster) => readDecision(clusterInputHash(cluster)),
      overrides,
      threshold: assignmentConfidenceThreshold,
      grouped,
    });
    const labelled = inferred.map((entry) => {
      const explicit = effortStore.owner("ticket", entry.cluster.ticket) ?? entry.cluster.units.flatMap((unit) => {
        const owner = unit.pr ? effortStore.owner("prUrl", unit.pr.url) : null;
        return owner ? [owner] : [];
      })[0];
      if (!explicit) {
        const repair = db.prepare(`SELECT label, hash FROM grouping_repairs WHERE ticket = ?`).get(entry.cluster.ticket) as { label: string; hash: string } | undefined;
        return repair?.hash === clusterInputHash(entry.cluster) && overrides[entry.cluster.ticket] === undefined
          ? { ...entry, label: repair.label, fit: 1 } : entry;
      }
      overrides[entry.cluster.ticket] = explicit.key;
      return { ...entry, label: explicit.key, fit: 1 };
    });
    return {
      labelled,
      clusters: workstreams.flatMap((workstream) => workstream.clusters),
      linearProjects,
      mode,
      rules,
      warnings: [...warnings],
      roll: {
        overrides,
        teamNames: teamNames.names,
        linearTeamNames: (await bb.storage.kv.get<Record<string, string>>("linearTeamNames")) ?? {},
        surfaceRules: rules,
      },
    };
  }

  /** The effort level with one-offs rolled into containers; with no model grouping, nothing rolls. */
  function boardEfforts(
    placement: Pick<Awaited<ReturnType<typeof readPlacement>>, "labelled" | "rules" | "roll">,
    grouped: boolean,
  ): { efforts: BoardGroup[]; containers: BoardGroup[] } {
    const efforts = effortsOf(placement.labelled, grouped, placement.rules);
    return grouped ? rollOneOffs(efforts, placement.roll) : { efforts, containers: [] };
  }

  /** The effort level, named from whatever the cache already holds. */
  function effortsOf(
    labelled: { label: string; cluster: SummarizedCluster; fit: number }[],
    grouped: boolean,
    rules: SurfaceRule[],
  ): BoardGroup[] {
    const members = new Map<string, SummarizedCluster[]>();
    for (const entry of labelled) {
      const bucket = members.get(entry.label);
      if (bucket === undefined) members.set(entry.label, [entry.cluster]);
      else bucket.push(entry.cluster);
    }
    const names: Record<string, NamedGroup> = {};
    for (const [label, clusters] of members) {
      const named = readGroupName("effort", effortMemberHash(clusters));
      if (named !== undefined) names[label] = named;
    }
    for (const effort of effortStore.list()) names[effort.key] = { name: effort.name, cohesion: null };
    const built = buildEfforts(labelled, names, grouped, rules).map((group) => {
      const established = effortStore.get(group.key);
      return established ? { ...group, name: established.name } : group;
    });
    for (const effort of effortStore.list()) if (!built.some((group) => group.key === effort.key)) built.push({
      key: effort.key, level: "effort", parentKey: null, name: effort.name, rollup: effort.goal, lifecycle: "merged",
      cohesion: null, clusters: [], repoCount: 0, merged: 0, total: 0, staleness: "fresh", surfaces: [], risk: "none",
    });
    return built;
  }

  /**
   * One rung of the hierarchy, read from cache: which parent each child was
   * assigned to, and what that parent is called.
   *
   * `undefined` means the level was never derived, and the caller then does not
   * build it at all. A cached assignment BELOW the confidence threshold is a
   * different thing entirely: the model did answer, it just was not sure, and
   * that child goes to Unsorted rather than being force-fitted.
   */
  function parentLevel(
    level: Exclude<GroupLevel, "effort">,
    children: { key: string; hash: string }[],
    threshold: number,
  ): { labelOf: Record<string, string>; names: Record<string, NamedGroup> } | undefined {
    const labelOf: Record<string, string> = {};
    const membersOf = new Map<string, string[]>();
    let seen = 0;
    for (const child of children) {
      if (outsideGrouping(child.key)) {
        labelOf[child.key] = child.key === UNSORTED || child.key.endsWith(`:${UNSORTED}`) ? UNSORTED : child.key;
        continue;
      }
      const assignment = readGroupAssignment(level, child.hash);
      if (assignment === undefined) {
        // Not yet asked about. Its own singleton parent, which the collapse
        // rules then delete — never a silent demotion to Unsorted.
        labelOf[child.key] = child.key;
        continue;
      }
      seen += 1;
      const label = assignment.fit >= threshold ? assignment.label : UNSORTED;
      labelOf[child.key] = label;
      const bucket = membersOf.get(label);
      if (bucket === undefined) membersOf.set(label, [child.hash]);
      else bucket.push(child.hash);
    }
    if (seen === 0) return undefined;
    const names: Record<string, NamedGroup> = {};
    for (const [label, hashes] of membersOf) {
      const named = readGroupName(level, memberHash(level, hashes));
      if (named !== undefined) names[label] = named;
    }
    return { labelOf, names };
  }

  /** The member hash a group caches its name and its assignment under. */
  function effortHash(effort: BoardGroup): string {
    return effortMemberHash(effort.clusters);
  }

  async function hierarchy(): Promise<{
    groups: BoardGroup[];
    mode: BoardMode;
    surfaces: string[];
    warnings: string[];
  }> {
    const { assignmentConfidenceThreshold } = await settings.get();
    const placement = await readPlacement();
    const { mode, rules, warnings } = placement;
    const grouped = mode !== "basic";
    const { efforts, containers } = boardEfforts(placement, grouped);

    const programs = grouped
      ? parentLevel(
          "program",
          efforts.map((effort) => ({ key: effort.key, hash: effortHash(effort) })),
          assignmentConfidenceThreshold,
        )
      : undefined;

    // A domain level is only meaningful over programs that exist.
    let domains: ReturnType<typeof parentLevel>;
    if (programs !== undefined) {
      const byLabel = new Map<string, string[]>();
      for (const effort of efforts) {
        const label = programs.labelOf[effort.key] ?? effort.key;
        const bucket = byLabel.get(label);
        if (bucket === undefined) byLabel.set(label, [effortHash(effort)]);
        else bucket.push(effortHash(effort));
      }
      domains = parentLevel(
        "domain",
        [...byLabel].map(([label, hashes]) => ({
          key: `program:${label}`,
          hash: memberHash("program", hashes),
        })),
        assignmentConfidenceThreshold,
      );
    }

    const groups = buildHierarchy({
      efforts,
      programOf:
        programs === undefined
          ? undefined
          : (effort) => programs.labelOf[effort.key] ?? effort.key,
      programNames: programs?.names,
      domainOf:
        domains === undefined ? undefined : (program) => domains.labelOf[program.key] ?? program.key,
      domainNames: domains?.names,
      grouped,
      surfaceRules: rules,
      containers,
    });

    return {
      groups,
      mode,
      surfaces: rules.map((rule) => rule.surface),
      warnings,
    };
  }

  /**
   * Thread id → cluster → strongest tier, over the clusters given. The started-
   * here record is read at link time: the spawn RPC can record it after
   * `thread.created` has already built this thread's facts.
   */
  function threadLinks(
    clusters: readonly { ticket: string; units: readonly { path: string; branch: string | null; defaultBranch: string | null }[] }[],
    pattern: RegExp,
  ): Map<string, Map<string, ThreadTier>> {
    const targets: LinkTarget[] = clusters.flatMap((cluster) =>
      cluster.units.map((unit) => ({
        cluster: cluster.ticket,
        path: unit.path,
        branch: unit.branch,
        defaultBranch: unit.defaultBranch,
      })),
    );
    const links = new Map<string, Map<string, ThreadTier>>();
    for (const thread of threadFacts.values()) {
      links.set(thread.id, linkThread({ ...thread, startedFor: startedFor.get(thread.id) ?? thread.startedFor }, targets, pattern));
    }
    return links;
  }

  async function board(): Promise<Board> {
    const { groups, mode, surfaces, warnings } = await hierarchy();
    const { rules } = await surfaceRules();
    const pattern = compilePattern((await settings.get()).ticketPattern);
    const links = threadLinks(groups.flatMap((group) => group.clusters), pattern);
    const threadsOf = new Map<string, z.infer<typeof threadLinkSchema>[]>();
    for (const [threadId, linked] of links) {
      const thread = threadFacts.get(threadId);
      if (thread === undefined) continue;
      for (const [cluster, tier] of linked) {
        const bucket = threadsOf.get(cluster) ?? [];
        bucket.push({
          id: thread.id,
          title: (thread.title ?? thread.titleFallback ?? thread.id).slice(0, 200),
          tier,
          active: thread.status === "active",
        });
        threadsOf.set(cluster, bucket);
      }
    }
    const tierRank = (tier: ThreadTier) => THREAD_TIERS.indexOf(tier);
    const transitions = readTransitions();
    const enteredAt = (path: string) => {
      const at = transitions.get(path)?.enteredAt ?? null;
      return at === null ? null : new Date(at).toISOString();
    };
    const wired = groups.map((group) => ({
      ...group,
      clusters: group.clusters.map((cluster) => ({
        ...cluster,
        units: cluster.units.map((unit) => ({ ...unit, enteredAt: enteredAt(unit.path) })),
        dominant: dominantSurface(
          cluster.units.flatMap((unit) => unit.changedPaths),
          rules,
        ),
        linear:
          cluster.linear === undefined || cluster.linear === null
            ? null
            : { title: cluster.linear.title, state: cluster.linear.state, project: cluster.linear.project, url: cluster.linear.url },
        // Strongest link first, then by id: a stable order, never a status one.
        threads: (threadsOf.get(cluster.ticket) ?? []).sort(
          (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.id.localeCompare(b.id),
        ),
      })),
    }));
    const dispatchPolicy = dispatch.policy();
    const dispatchAttempts = dispatch.attempts();
    const dispatchPaused = dispatchAttempts.some((attempt) =>
      attempt.status === "launching" || attempt.status === "running" || attempt.status === "verifying" || attempt.status === "needs-you");
    const dispatchChoice = dispatchPaused ? null : selectCandidate(wired, dispatchPolicy.effort_key, dispatchAttempts, runs.recent(Number.MAX_SAFE_INTEGER));
    const established = await Promise.all(effortStore.list().map(async (effort) => {
      if (!effort.coordinatorThreadId) return effort;
      try {
        const thread = await bb.sdk.threads.get({ threadId: effort.coordinatorThreadId });
        const state = thread.archivedAt === null && thread.deletedAt === null ? "ready" : "unavailable";
        return state === effort.coordinatorState ? effort : effortStore.save({ ...effort, coordinatorState: state });
      } catch { return { ...effort, coordinatorState: "unavailable" as const }; }
    }));
    const storedInventory = inventory.read();
    return {
      efforts: established,
      groups: wired,
      depth: hierarchyDepth(groups),
      surfaces,
      mode,
      hostId: (await bb.sdk.system.config()).primaryHostId,
      lastScanAt: (await bb.storage.kv.get<string>("lastScanAt")) ?? null,
      scanning,
      prInventory: { ...storedInventory, entries: storedInventory.entries.map((entry) => ({ ...entry,
        ...(inventoryEffort(entry.pr, wired, established, pattern) ?? {}),
      })), refreshing: inventoryRefreshing || inventoryTargeting },
      warnings: [
        ...((await bb.storage.kv.get<string[]>("warnings")) ?? []),
        ...warnings,
      ].slice(0, 50),
      threadCoverage: threadCoverage(threadFacts.size, links),
      health: {
        refreshMinutes: (await settings.get()).refreshMinutes,
        enrichment: enrichmentSchema.nullable().catch(null).parse((await bb.storage.kv.get<unknown>("lastEnrichment")) ?? null),
      },
      runs: runs.recent(Date.now() - ROW_RUN_MS),
      dispatch: {
        mode: dispatchPolicy.mode,
        effortKey: dispatchPolicy.effort_key,
        candidate: dispatchPolicy.mode === "off" ? null : dispatchChoice?.candidate ?? null,
        attempts: dispatchAttempts.slice(0, 50).map(({ fingerprint: _fingerprint, ...attempt }) => attempt),
      },
    };
  }

  // ---- BB threads: read, link, open. Only row actions write to them. -----

  /** Every visible, unarchived thread, with the paths its recent events worked in. */
  let threadFacts = new Map<string, ThreadFacts>();
  let threadEnvironments = new Map<string, string | null>();
  const prFreshness = createPrFreshness({
    subscribe: (environmentId, changed) => bb.sdk.subscribe({
      event: "environment:changed", environmentId,
      callback: (event) => { if (event.changes.includes("git-refs-changed")) changed(); },
    }),
    schedule: scheduleInventoryUrls,
    settleMs: 15_000,
  });
  // Rebuild local links once per burst; idle IDs additionally refresh their current PRs.
  const prFreshnessLinks = createRescanQueue({
    delayMs: 400,
    rescan: async (idleIds) => {
      const { clusters } = await readPlacement();
      const pattern = compilePattern((await settings.get()).ticketPattern);
      if (disposal.signal.aborted) return true;
      const links = threadLinks(clusters, pattern);
      const urlsByCluster = new Map(clusters.map((cluster) => [cluster.ticket,
        cluster.units.flatMap((unit) => unit.pr?.state === "OPEN" ? [unit.pr.url] : [])]));
      prFreshness.setLinks([...threadFacts.keys()].map((threadId) => ({
        threadId, environmentId: threadEnvironments.get(threadId) ?? null,
        urls: [...(links.get(threadId)?.keys() ?? [])].flatMap((ticket) => urlsByCluster.get(ticket) ?? []),
      })));
      for (const threadId of idleIds) if (threadId !== "") prFreshness.threadIdle(threadId);
      return true;
    },
    onError: (error) => bb.log.warn(`PR freshness links: ${String(error).slice(0, 300)}`),
  });
  bb.onDispose(() => { prFreshnessLinks.dispose(); prFreshness.dispose(); });

  function cachedPaths(threadId: string): WorkedPaths | undefined {
    const row = db
      .prepare(`SELECT updated_at, paths FROM thread_paths WHERE thread_id = ?`)
      .get(threadId) as { updated_at: number; paths: string } | undefined;
    if (row === undefined) return undefined;
    try {
      const paths: unknown = JSON.parse(row.paths);
      return {
        updatedAt: row.updated_at,
        paths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [],
      };
    } catch {
      return undefined;
    }
  }

  function writePaths(updates: Map<string, WorkedPaths>): void {
    const upsert = db.prepare(
      `INSERT INTO thread_paths (thread_id, updated_at, paths) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at, paths = excluded.paths`,
    );
    db.transaction(() => {
      for (const [id, value] of updates) upsert.run(id, value.updatedAt, JSON.stringify(value.paths));
    })();
  }

  /**
   * A bounded, newest-first read of one thread's `item/started` events: the
   * started form carries a command's cwd and a change's paths without the
   * command output the completed form drags along. Pages stop at the entry cap
   * or the byte budget, whichever comes first.
   */
  async function readWorkedPaths(threadId: string, signal: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    let beforeSeq: string | undefined;
    let bytes = 0;
    for (let page = 0; page < EVENT_READ.pages; page += 1) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["item/started"],
        order: "desc",
        limit: String(EVENT_READ.page),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        signal,
      });
      out.push(...pathsFromEvents(rows));
      bytes += JSON.stringify(rows).length;
      const last = rows[rows.length - 1];
      if (last === undefined || rows.length < EVENT_READ.page || bytes > EVENT_READ.bytes) break;
      beforeSeq = String(last.seq);
    }
    return out;
  }

  type ThreadRow = {
    id: string;
    title: string | null;
    titleFallback: string | null;
    status: string;
    updatedAt: number;
    visibility: string;
    archivedAt: number | null;
    deletedAt: number | null;
  };

  function factsOf(
    row: ThreadRow,
    environment: { branch: string | null; path: string | null },
    worked: WorkedPaths | undefined,
  ): ThreadFacts {
    return {
      id: row.id,
      title: row.title,
      titleFallback: row.titleFallback,
      status: row.status,
      environmentBranchName: environment.branch,
      environmentPath: environment.path,
      updatedAt: row.updatedAt,
      workedPaths: worked?.paths ?? [],
      startedFor: startedFor.get(row.id) ?? null,
    };
  }

  /**
   * Threads this plugin started, and the cluster each was started for, read
   * from this plugin's own thread metadata. Only threads attributed to this
   * plugin are ever read, so a relist costs one metadata read per thread the
   * Board started, not one per thread in BB.
   */
  const startedFor = new Map<string, string>();

  async function readStartedFor(row: { id: string; originPluginId: string | null }): Promise<void> {
    if (row.originPluginId !== bb.pluginId || startedFor.has(row.id)) return;
    try {
      const ticket = startedForOf(await bb.sdk.threads.getPluginMetadata({ threadId: row.id }));
      if (ticket !== null) startedFor.set(row.id, ticket);
    } catch (error) {
      bb.log.warn(`thread ${row.id}: metadata read failed: ${String(error).slice(0, 200)}`);
    }
  }

  /** The relist in flight, shared by every caller that asks for one meanwhile. */
  let threadSync: Promise<void> | null = null;
  /** True once a relist has succeeded: enrichment seeds from threads and must not run without them. */
  let threadsSynced = false;
  let threadSignal: ReturnType<typeof setTimeout> | null = null;

  /** Tell the board, coalescing a burst of thread events into one refetch. */
  function announceThreads(): void {
    if (threadSignal !== null) return;
    threadSignal = setTimeout(() => {
      threadSignal = null;
      bb.realtime.publish(BOARD_CHANGED, { scanning });
    }, 400);
  }
  bb.onDispose(() => {
    if (threadSignal !== null) clearTimeout(threadSignal);
  });

  /**
   * Relist every thread and bring its worked paths up to date. Runs after each
   * scan, never inside one: a slow thread read must not hold a board refresh,
   * and a failed one skips that thread only.
   */
  function syncThreads(): Promise<void> {
    threadSync ??= relistThreads().finally(() => {
      threadSync = null;
    });
    return threadSync;
  }

  async function relistThreads(): Promise<void> {
    try {
      const pageSize = 500;
      const maxPages = 21; // Twenty full pages, plus one to confirm there are no more.
      const rows = [] as Awaited<ReturnType<typeof bb.sdk.threads.list>>[number][];
      const seen = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        const batch = await bb.sdk.threads.list({ limit: pageSize, offset: page * pageSize });
        for (const row of batch) {
          if (!seen.has(row.id)) {
            rows.push(row);
            seen.add(row.id);
          }
        }
        if (page === maxPages - 1 && batch.length > 0) throw new Error(`Thread list exceeds ${pageSize * (maxPages - 1)} threads.`);
        if (batch.length < pageSize) break;
        if (rows.length < (page + 1) * pageSize) throw new Error("Thread list pagination repeated a page.");
      }
      for (const row of rows) await readStartedFor(row);
      const refreshed = await refreshWorkedPaths({
        threads: rows,
        cached: cachedPaths,
        read: readWorkedPaths,
      });
      writePaths(refreshed.updates);
      threadFacts = new Map(
        rows.map((row) => [
          row.id,
          factsOf(
            row,
            { branch: row.environmentBranchName, path: row.environmentPath },
            refreshed.updates.get(row.id) ?? cachedPaths(row.id),
          ),
        ]),
      );
      threadEnvironments = new Map(rows.map((row) => [row.id, row.environmentId]));
      prFreshnessLinks.add("");
      bb.log.info(
        `threads: ${rows.length} listed, ${refreshed.read} event logs read, ${refreshed.reused} unchanged, ${refreshed.failed} skipped`,
      );
      threadsSynced = true;
      reconcileRuns(rows);
      announceThreads();
    } catch (error) {
      bb.log.warn(`thread sync failed: ${String(error).slice(0, 300)}`);
    }
  }

  /**
   * One thread changed. Update it in place — no relist, no rescan — and re-read
   * its event log only when it has just finished a turn, which is when it can
   * have worked somewhere new.
   */
  async function onThreadChanged(
    row: ThreadRow & { environmentId: string | null; originPluginId: string | null },
    reread: boolean): Promise<void> {
    if (row.visibility !== "visible" || row.archivedAt !== null || row.deletedAt !== null) {
      threadEnvironments.delete(row.id);
      prFreshnessLinks.add("");
      if (threadFacts.delete(row.id)) announceThreads();
      return;
    }
    const known = threadFacts.get(row.id);
    const environmentChanged = threadEnvironments.get(row.id) !== row.environmentId;
    let environment = environmentChanged ? { branch: null, path: null } :
      { branch: known?.environmentBranchName ?? null, path: known?.environmentPath ?? null };
    if ((known === undefined || environmentChanged) && row.environmentId !== null) {
      try {
        const full = await bb.sdk.threads.get({ threadId: row.id, include: "environment" });
        const env = "environment" in full ? full.environment : null;
        environment = { branch: env?.branchName ?? null, path: env?.path ?? null };
      } catch (error) {
        bb.log.warn(`thread ${row.id}: environment lookup failed: ${String(error).slice(0, 200)}`);
      }
    }
    await readStartedFor(row);
    let worked = cachedPaths(row.id);
    if (reread) {
      const refreshed = await refreshWorkedPaths({
        threads: [row],
        cached: cachedPaths,
        read: readWorkedPaths,
      });
      writePaths(refreshed.updates);
      worked = refreshed.updates.get(row.id) ?? worked;
    }
    threadFacts.set(row.id, factsOf(row, environment, worked));
    threadEnvironments.set(row.id, row.environmentId);
    prFreshnessLinks.add("");
    announceThreads();
  }

  const onThreadError = (error: unknown) =>
    bb.log.warn(`thread event handling failed: ${String(error).slice(0, 300)}`);
  bb.events.on("thread.created", ({ thread }) => {
    onThreadChanged(thread, false).catch(onThreadError);
  });
  bb.events.on("thread.active", ({ thread }) => {
    signalRuns(thread.id, { kind: "active" });
    onThreadChanged(thread, false).catch(onThreadError);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    signalRuns(thread.id, { kind: "idle", text: lastAssistantText });
    void advance.signal(thread.id, "idle", lastAssistantText).catch(onThreadError);
    onThreadChanged(thread, true).then(() => prFreshnessLinks.add(thread.id)).catch(onThreadError);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    signalRuns(thread.id, { kind: "failed", text: null, error });
    void advance.signal(thread.id, "failed").catch(onThreadError);
    onThreadChanged(thread, true).catch(onThreadError);
  });
  bb.events.on("thread.unarchived", ({ thread }) => {
    onThreadChanged(thread, true).catch(onThreadError);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    void advance.signal(thread.id, "gone").catch(onThreadError);
    signalRuns(thread.id, { kind: "gone", reason: "Thread archived" });
    threadEnvironments.delete(thread.id);
    prFreshnessLinks.add("");
    if (threadFacts.delete(thread.id)) announceThreads();
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void advance.signal(thread.id, "gone").catch(onThreadError);
    signalRuns(thread.id, { kind: "gone", reason: "Thread deleted" });
    threadEnvironments.delete(thread.id);
    prFreshnessLinks.add("");
    if (threadFacts.delete(thread.id)) announceThreads();
  });
  // A pending interaction IS an event: the agent is waiting on the user.
  bb.events.on("interaction.pending", ({ thread }) => {
    signalRuns(thread.id, { kind: "pending" });
    void advance.signal(thread.id, "pending").catch(onThreadError);
  });
  // There is no "interaction answered" event, and the event DTO carries no
  // pending flag. The thread's event sequence does advance when the user
  // answers, so a waiting run re-reads that one thread's interactions then.
  // Core coalesces this to at most once a second per thread; no polling.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (thread.status !== "active" || !runs.openIn(thread.id).some((run) => run.status === "needs-you")) return;
    bb.sdk.threads.interactions.list({ threadId: thread.id }).then(
      (pending) => {
        if (pending.length === 0) signalRuns(thread.id, { kind: "settled" });
      },
      (error: unknown) => bb.log.warn(`thread ${thread.id}: interaction read failed: ${String(error).slice(0, 200)}`),
    );
  });

  // ---- run tracking: status from thread events, never a polling loop -------

  let targeting = false;

  /** Re-inspect just these checkouts and replace their rows; the rest of the board is untouched. */
  async function rescanPaths(paths: string[]): Promise<boolean> {
    if (scanning || targeting) return false;
    if (paths.length > TARGETED_MAX) {
      return scan();
    }
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (hostId === null) return false;
    targeting = true;
    try {
      const result = await host.call("inspectPaths", { paths }, { hostId, timeoutMs: SCAN_TIMEOUT_MS });
      const insert = db.prepare(`INSERT OR REPLACE INTO units (path, unit) VALUES (?, ?)`);
      const remove = db.prepare(`DELETE FROM units WHERE path = ?`);
      db.transaction(() => {
        // A path the host no longer sees as a checkout leaves the board, as a full scan would drop it.
        for (const path of paths) remove.run(path);
        for (const unit of result.units) insert.run(unit.path, JSON.stringify(unit));
      })();
      recordTransitions(readUnits());
      inventory.observe(result.units.flatMap((unit) => unit.pr === null ? [] : [unit.pr]));
      advance.invalidate(result.units.flatMap((unit) => unit.pr === null ? [] : [unit.pr]));
      prFreshnessLinks.add("");
      for (const warning of result.warnings) bb.log.warn(`rescan: ${warning}`);
      bb.log.info(`rescanned ${paths.length} checkout(s) after row actions finished`);
      return true;
    } catch (error) {
      bb.log.warn(`targeted rescan failed: ${String(error).slice(0, 300)}`);
      return false;
    } finally {
      targeting = false;
      bb.realtime.publish(BOARD_CHANGED, { scanning });
    }
  }

  const rescans = createRescanQueue({
    delayMs: RESCAN_DELAY_MS,
    rescan: rescanPaths,
    onError: (error) => bb.log.warn(`rescan queue: ${String(error).slice(0, 300)}`),
  });
  bb.onDispose(() => rescans.dispose());

  /** Runs changed: open views refetch, and a finished run rescans the row it touched. */
  function runsChanged(changed: readonly Run[]): void {
    if (changed.length === 0) return;
    for (const run of changed) {
      const finished = run.kind === "agent" ? run.status === "done" || run.status === "failed" : run.status === "succeeded";
      if (run.action === LINEAR_FETCH) {
        // Not a row: nothing to rescan. Its answer is read and stored instead.
        if (run.status === "done") void settleLinearFetch(run);
        else if (run.status === "failed") void forgetLinearFetch(run.id);
      } else if (run.threadId !== null && dispatch.byThread(run.threadId) !== undefined) {
        const attempt = dispatch.byThread(run.threadId)!;
        if (run.status === "done") {
          dispatch.update(attempt.id, "verifying", "Checking the PR with a fresh scan");
          void verifyDispatch(attempt.id, attempt.path, attempt.prUrl, attempt.action);
        } else if (run.status === "failed") dispatch.update(attempt.id, "failed", run.error ?? "Agent thread failed");
        else if (run.status === "needs-you") dispatch.update(attempt.id, "needs-you", "Agent needs your decision");
        else if (run.status === "running" && attempt.status === "needs-you") dispatch.update(attempt.id, "running", "Agent resumed");
      } else if (finished) rescans.add(run.path);
      bb.log.info(`run ${run.id} (${run.action}) ${run.status}${run.result === null ? "" : `: ${run.result}`}`);
    }
    announceThreads();
  }

  // ---- the manual Linear fallback: one agent thread, its answer parsed by code ----

  const LINEAR_FETCH = "linear-fetch";

  /** Tickets on the board that no key covers and that have no Linear detail yet. */
  async function fallbackTickets(): Promise<string[]> {
    const pattern = compilePattern((await settings.get()).ticketPattern);
    const units = readUnits();
    const unowned = await linear.unowned(await linearKeys(), ticketsOf(await findTickets(pattern, units), units), disposal.signal);
    const known = linear.read(unowned);
    return unowned.filter((ticket) => !known.has(ticket)).sort((a, b) => a.localeCompare(b));
  }

  async function pendingFetches(): Promise<Record<string, string[]>> {
    return (await bb.storage.kv.get<Record<string, string[]>>("linearFetches")) ?? {};
  }

  async function forgetLinearFetch(runId: number): Promise<string[] | undefined> {
    const pending = await pendingFetches();
    const asked = pending[String(runId)];
    if (asked === undefined) return undefined;
    delete pending[String(runId)];
    await bb.storage.kv.set("linearFetches", pending);
    return asked;
  }

  /** Read the finished thread's last json block, store what validates, and record the outcome. */
  async function settleLinearFetch(run: Run): Promise<void> {
    try {
      const asked = await forgetLinearFetch(run.id);
      if (asked === undefined || run.threadId === null) return;
      const text = (await bb.sdk.threads.output({ threadId: run.threadId })).output;
      const parsed = parseAgentAnswer(text, asked);
      if (parsed.ok) linear.store(parsed.details.map((detail) => ({ ticket: detail.identifier, detail })), "agent");
      const settled = runs.settle(
        run.id,
        parsed.ok,
        parsed.ok ? `Stored Linear detail for ${parsed.details.length} of ${asked.length} tickets` : parsed.reason,
      );
      bb.log.info(`linear fetch run ${run.id}: ${parsed.ok ? `stored ${parsed.details.length} of ${asked.length}` : "failed"}`);
      if (settled !== null) announceThreads();
    } catch (error) {
      bb.log.warn(`linear fetch run ${run.id}: settling failed: ${String(error).slice(0, 200)}`);
    }
  }

  /** Feed one thread signal to the runs in that thread. Cheap when there are none. */
  function signalRuns(threadId: string, signal: ThreadSignal): void {
    if (runs.openIn(threadId).length === 0) return;
    runs
      .signal(threadId, signal, async () => (await bb.sdk.threads.output({ threadId })).output)
      .then(runsChanged, (error: unknown) => bb.log.warn(`run update failed: ${String(error).slice(0, 300)}`));
  }

  /**
   * After each thread relist: catch up runs whose events were missed (a plugin
   * reload mid-run). A finish is only trusted for runs over two minutes old, so
   * a thread listed just before its first turn is not read as done.
   */
  function reconcileRuns(rows: readonly { id: string; status: string; hasPendingInteraction: boolean }[]): void {
    const open = new Set(runs.openThreadIds());
    const settledBefore = Date.now() - 2 * 60_000;
    for (const row of rows) {
      if (!open.has(row.id)) continue;
      if (row.hasPendingInteraction) signalRuns(row.id, { kind: "pending" });
      else if (row.status === "active") signalRuns(row.id, { kind: "settled" });
      else {
        if (row.status === "idle") closeStranded(row.id);
        if (runs.openIn(row.id).every((run) => run.startedAt < settledBefore)) {
          if (row.status === "idle") signalRuns(row.id, { kind: "idle", text: null });
          else if (row.status === "error") signalRuns(row.id, { kind: "failed", text: null, error: null });
        }
      }
    }
  }

  /** A continue run whose own turn was missed in a reload never arms: close it after 6h on an idle thread. */
  function closeStranded(threadId: string): void {
    const closed = runs.closeStranded(threadId);
    if (closed.length === 0) return;
    bb.log.info(`closed ${closed.length} stranded continue run(s) in thread ${threadId}`);
    runsChanged(closed);
  }

  // ---- enrichment: the only place model calls happen --------------------

  type LevelEntry = {
    member: Assignable & { hash: string };
    item: SeedItem;
    repos: string[];
    clusters: SummarizedCluster[];
    group: BoardGroup;
  };

  /** A level's members, shaped for seeding, assignment and naming. */
  function levelMembers(
    groups: BoardGroup[],
    hashOf: (group: BoardGroup) => string,
    childrenOf: (group: BoardGroup) => BoardGroup[],
    context: SeedContext,
  ): LevelEntry[] {
    return groups
      .filter((group) => !outsideGrouping(group.key))
      .map((group) => {
        const clusters = clustersUnder(group, childrenOf);
        const hash = hashOf(group);
        return {
          member: {
            key: hash,
            hash,
            name: group.name,
            description: clusters
              .map((cluster) => cluster.ticket)
              .join(", ")
              .slice(0, 300),
          },
          item: groupSeedItem(hash, clusters, context),
          repos: [...new Set(clusters.flatMap((cluster) => cluster.units.map((unit) => unit.repo ?? unit.dirName)))],
          clusters,
          group,
        };
      });
  }

  function clustersUnder(
    group: BoardGroup,
    childrenOf: (group: BoardGroup) => BoardGroup[],
  ): SummarizedCluster[] {
    const children = childrenOf(group);
    if (children.length === 0) return group.clusters;
    return children.flatMap((child) => clustersUnder(child, childrenOf));
  }

  /**
   * Log a group whose member set changed under an existing label: keys and
   * member-hash prefixes only, never a title (logs may be shared). The label is
   * itself a title, so it is logged as its hash.
   */
  async function logRenames(level: GroupLevel, hashes: ReadonlyMap<string, string>, renamed: ReadonlySet<string>): Promise<void> {
    const memo = (await bb.storage.kv.get<Record<string, Record<string, string>>>("memberHashes")) ?? {};
    const seen = { ...(memo[level] ?? {}) };
    for (const [label, hash] of hashes) {
      const labelKey = hashString(label);
      if (renamed.has(hash)) {
        const before = seen[labelKey];
        bb.log.info(`${level} renamed: label ${labelKey} members ${before === undefined ? "none" : before.slice(0, 8)} -> ${hash.slice(0, 8)}`);
      }
      seen[labelKey] = hash;
    }
    await bb.storage.kv.set("memberHashes", { ...memo, [level]: seen });
  }

  /**
   * Derive ONE level above the groups given, with the same machinery every
   * other level uses: deterministic seeding, a Jev choice scored against the
   * confidence threshold, and Claude naming only the groups whose member set
   * changed. Reports its own calls and tokens so per-level spend is visible.
   */
  async function deriveLevel(options: {
    level: Exclude<GroupLevel, "effort">;
    members: LevelEntry[];
    summaryOf: (group: BoardGroup) => string;
    contextOf: (cluster: Cluster) => string[];
    jev: JevClient;
    naming: NamingClient | null;
    threshold: number;
  }): Promise<{ warnings: string[]; usage: ModelUsage }> {
    const warnings: string[] = [];
    const usage: ModelUsage = { ...ZERO_USAGE };
    const { level, members } = options;
    // Two members cannot support a level above them that says anything.
    if (members.length < 3) return { warnings, usage };

    const candidates = seedAssignables(
      members.map((entry) => ({
        key: entry.member.hash,
        id: entry.group.key,
        name: entry.member.name,
        item: entry.item,
        description: entry.member.description,
      })),
    );
    const labels = new Set(candidates.map((candidate) => candidate.label));
    const pending = members.filter((entry) => {
      const cached = readGroupAssignment(level, entry.member.hash);
      // A cached assignment survives only while the label it chose still
      // exists; otherwise the member has nowhere to go and must be re-asked.
      const reason = cached === undefined ? "new" : labels.has(cached.label) ? null : "label-vanished";
      if (reason !== null) bb.log.info(`jev ${level} re-ask ${entry.member.hash.slice(0, 8)}: ${reason}`);
      return reason !== null;
    }).map((entry) => entry.member);

    const assigned = await assignToCandidates({
      pending,
      candidates,
      jev: options.jev,
      level,
    });
    writeGroupAssignments(level, assigned.assignments);
    warnings.push(...assigned.warnings);
    addUsage(usage, assigned.usage);
    bb.log.info(
      `jev ${level}: ${assigned.usage.calls} calls for ${pending.length} of ${members.length} members, ${assigned.usage.inputTokens} in / ${assigned.usage.outputTokens} out`,
    );

    if (options.naming === null) return { warnings, usage };

    // Group the members by the label they now sit under, and name only the
    // groups whose member set changed.
    const grouped = new Map<string, typeof members>();
    for (const entry of members) {
      const cached = readGroupAssignment(level, entry.member.hash);
      if (cached === undefined || cached.fit < options.threshold) continue;
      const bucket = grouped.get(cached.label);
      if (bucket === undefined) grouped.set(cached.label, [entry]);
      else bucket.push(entry);
    }
    const hashOf = (label: string) => memberHash(level, (grouped.get(label) ?? []).map((entry) => entry.member.hash));

    const named = await nameGroups({
      level,
      groups: new Map(
        [...grouped].map(([label, entries]) => [
          label,
          entries.map((entry) => ({
            ticket: entry.group.key,
            summary: options.summaryOf(entry.group),
            repos: entry.repos.slice(0, 50),
          })),
        ]),
      ),
      hashOf,
      cached: (hash) => readGroupName(level, hash),
      candidatesFor: (label) => {
        const entries = grouped.get(label) ?? [];
        return namingCandidates(
          entries.map((entry) => entry.group.name),
          entries.flatMap((entry) => [...entry.item.projects]),
        );
      },
      contextFor: (label) =>
        namingContext((grouped.get(label) ?? []).flatMap((entry) => entry.clusters.flatMap(options.contextOf))),
      naming: options.naming,
    });
    writeGroupNames(level, named.names);
    await logRenames(level, new Map([...grouped.keys()].map((label) => [label, hashOf(label)])), new Set(named.names.keys()));
    warnings.push(...named.warnings);
    addUsage(usage, named.usage);
    bb.log.info(
      `claude ${level}: ${named.usage.calls} calls for ${named.names.size} renamed, ${named.usage.inputTokens} in / ${named.usage.outputTokens} out`,
    );
    return { warnings, usage };
  }

  function addUsage(total: ModelUsage, part: ModelUsage): void {
    total.calls += part.calls;
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
  }

  function readAskMemory(): Map<string, AskMemory> {
    const rows = db.prepare(`SELECT ticket, hash, streak, pinned FROM cluster_asks`).all() as {
      ticket: string;
      hash: string;
      streak: number;
      pinned: number;
    }[];
    return new Map(rows.map((row) => [row.ticket, { hash: row.hash, streak: row.streak, pinned: row.pinned !== 0 }]));
  }

  function writeAskMemory(next: ReadonlyMap<string, AskMemory>): void {
    const upsert = db.prepare(
      `INSERT INTO cluster_asks (ticket, hash, streak, pinned, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ticket) DO UPDATE SET hash = excluded.hash, streak = excluded.streak, pinned = excluded.pinned, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const [ticket, memory] of next) upsert.run(ticket, memory.hash, memory.streak, memory.pinned ? 1 : 0, now);
    })();
  }

  /**
   * The only place model calls happen, and only for what actually changed.
   * A rescan whose clusters are semantically identical reaches none of the
   * `await`s below at ANY level, which is what makes an unchanged refresh free.
   */
  async function enrich(signal: AbortSignal): Promise<string[]> {
    const { typesafeApiKey, anthropicApiKey, assignmentConfidenceThreshold, ticketPattern } =
      await settings.get();
    const mode = modeOf(typesafeApiKey, anthropicApiKey);
    if (mode === "basic" || typeof typesafeApiKey !== "string") {
      // Logged even here, so "what did this scan cost" always has an answer.
      bb.log.info("enrich (basic): 0 model calls, 0 in / 0 out");
      return [];
    }
    // Threads are a seeding signal. Seeding without them after a reload, then
    // with them a scan later, would flip candidates and pay twice for nothing.
    if (!threadsSynced) {
      bb.log.info("enrich skipped: the thread list has not been read yet; grouping kept as is");
      return [];
    }

    const { clusters, linearProjects } = await readPlacement();
    const pattern = compilePattern(ticketPattern);
    const links = threadLinks(clusters, pattern);
    const context: SeedContext = { threads: threadWeights(links) };
    bb.log.info(`threads: ${strongLinkedClusters(links)} of ${clusters.length} clusters have a strong thread link`);
    const threadTitles = new Map<string, string[]>();
    for (const [threadId, perCluster] of links) {
      const thread = threadFacts.get(threadId);
      const title = thread?.title ?? thread?.titleFallback ?? null;
      if (title === null) continue;
      for (const [cluster, tier] of perCluster) {
        if (!STRONG_TIERS.has(tier)) continue;
        threadTitles.set(cluster, [...(threadTitles.get(cluster) ?? []), title]);
      }
    }
    const contextOf = (cluster: Cluster) => clusterContext(cluster, (threadTitles.get(cluster.ticket) ?? []).slice(0, 3));

    const candidates = candidatesFrom(clusters, context);
    writeDecisions(migrateCandidateDecisions(candidates, new Map(clusters.flatMap((cluster) => {
      const hash = clusterInputHash(cluster), decision = readDecision(hash);
      return decision ? [[hash, decision] as const] : [];
    }))));
    if (!(await bb.storage.kv.get<boolean>("stableCandidateMigration"))) {
      const labels = new Set(candidates.map((candidate) => candidate.label));
      let preserved = 0;
      for (const item of clusters) {
        const hash = clusterInputHash(item), decision = readDecision(hash);
        if (decision?.assignment && !labels.has(decision.assignment.label)) {
          db.prepare(`INSERT OR REPLACE INTO grouping_legacy_labels (hash, label) VALUES (?, ?)`).run(hash, decision.assignment.label);
          preserved++;
        }
      }
      await bb.storage.kv.set("stableCandidateMigration", true);
      bb.log.info(`stable candidate migration: preserved ${preserved} unmatched legacy assignments for bounded membership review`);
    }
    const preservedLabels = new Set((db.prepare(`SELECT hash, label FROM grouping_legacy_labels`).all() as { hash: string; label: string }[])
      .filter((row) => clusters.some((item) => clusterInputHash(item) === row.hash)).map((row) => row.label));
    const plan = planClusterAsks({
      clusters: clusters.map((cluster) => ({
        key: cluster.ticket,
        hash: clusterInputHash(cluster),
        baseHash: cluster.linear === undefined || cluster.linear === null ? undefined : clusterInputHash({ ...cluster, linear: undefined }),
        decision: readDecision(clusterInputHash(cluster)),
        grouped: groupingRole(cluster) === "grouped" && effortStore.owner("ticket", cluster.ticket) === null &&
          !cluster.units.some((unit) => unit.pr && effortStore.owner("prUrl", unit.pr.url)) &&
          (db.prepare(`SELECT hash FROM grouping_repairs WHERE ticket = ?`).get(cluster.ticket) as { hash: string } | undefined)?.hash !== clusterInputHash(cluster),
      })),
      labels: new Set([...candidates.map((candidate) => candidate.label), ...preservedLabels]),
      memory: readAskMemory(),
    });
    for (const ask of plan.ask) bb.log.info(`jev cluster re-ask ${ask.key} (${ask.hash}): ${ask.reason}`);
    for (const key of plan.pinned) {
      bb.log.info(`jev cluster ${key}: pinned to its last assignment after ${PIN_AFTER} label-vanished re-asks; re-asked again only when its content changes`);
    }
    if (plan.linearArrivals > 0) bb.log.info(`regrouping with Linear detail: ${plan.linearArrivals} clusters`);
    const asked = new Set(plan.ask.map((ask) => ask.key));
    const pending = clusters.filter((cluster) => asked.has(cluster.ticket));

    const warnings: string[] = [];
    const usage: ModelUsage = { ...ZERO_USAGE };
    const jev = jevClient(typesafeApiKey, signal);
    bb.log.info(`grouping normal asks planned: ${pending.length} clusters; preserved legacy groups remain eligible for bounded repair`);
    const cluster = await decideWithJev({ pending, candidates, jev });
    writeDecisions(cluster.decisions);
    // Remembered only once the answers are stored: a failed call must be re-asked, not counted as asked.
    writeAskMemory(plan.next);
    warnings.push(...cluster.warnings);
    addUsage(usage, cluster.usage);
    bb.log.info(
      `jev cluster: ${cluster.usage.calls} calls for ${pending.length} of ${clusters.length} clusters, ${cluster.usage.inputTokens} in / ${cluster.usage.outputTokens} out`,
    );

    // Membership review is separate from naming. Its evidence cache survives
    // repartitioning; an unchanged scan never pays to repeat the judgment.
    const repairPlacement = await readPlacement();
    const repairEfforts = effortsOf(repairPlacement.labelled, true, repairPlacement.rules);
    const manual = await readOverrides();
    const reviewed = new Map((db.prepare(`SELECT ticket, evidence FROM grouping_repairs`).all() as { ticket: string; evidence: string }[]).map((row) => [row.ticket, row.evidence]));
    const repairPlan = planGroupingRepair({
      groups: repairEfforts.flatMap((group) => {
        const locked = effortStore.get(group.key) !== null || group.clusters.some((member) => manual[member.ticket] !== undefined);
        return outsideGrouping(group.key) ? group.clusters.map((member) => ({ id: member.ticket, members: [member], mixed: false, locked }))
          : [{ id: group.key, members: group.clusters, mixed: group.cohesion?.verdict === "mixed", locked }];
      }), context, reviewed,
      pathThreads: [...links].map(([id, entries]) => ({ id, title: threadFacts.get(id)?.title ?? threadFacts.get(id)?.titleFallback ?? "",
        clusters: [...entries].some(([, tier]) => tier === "paths") ? [...entries.keys()] : [] })),
    });
    const estimate = repairRequestEstimate(repairPlan.jobs);
    bb.log.info(`grouping repair: ${JSON.stringify(estimate)}`);
    const repaired = await reviewGroupingRepair({ jobs: repairPlan.jobs, jev });
    warnings.push(...repairPlan.warnings, ...repaired.warnings);
    addUsage(usage, repaired.usage);
    const clusterByTicket = new Map(clusters.map((item) => [item.ticket, item]));
    const currentManual = await readOverrides();
    db.transaction(() => {
      for (const partition of repaired.partitions) for (const members of partition.members) {
        const label = `repair:${hashString([...members].sort().join("\n"))}`;
        for (const ticket of members) {
          const member = clusterByTicket.get(ticket);
          if (!member || effortStore.owner("ticket", ticket) || member.units.some((unit) => unit.pr && effortStore.owner("prUrl", unit.pr.url)) || currentManual[ticket] !== undefined) continue;
          db.prepare(`INSERT OR REPLACE INTO grouping_repairs (ticket, label, hash, evidence) VALUES (?, ?, ?, ?)`).run(ticket, label, clusterInputHash(member), partition.evidence[ticket]);
        }
      }
    })();

    const hostId =
      mode === "jev+claude" ? (await bb.sdk.system.config()).primaryHostId : null;
    if (mode === "jev+claude" && hostId === null) {
      warnings.push("No primary BB host is available to name groups from.");
    }
    const naming =
      mode === "jev+claude" && hostId !== null && typeof anthropicApiKey === "string"
        ? namingClient(anthropicApiKey, hostId, signal)
        : null;

    // ---- effort level ----
    const placement = await readPlacement();
    const summaries = new Map(
      placement.labelled.map((entry) => [entry.cluster.ticket, entry.cluster.summary]),
    );
    // One-offs are filed into containers by code: never named, never assigned a program.
    const rolled = boardEfforts(placement, true);
    const inContainer = new Set(rolled.containers.flatMap((group) => group.clusters.map((cluster) => cluster.ticket)));
    if (naming !== null) {
      const grouped = new Map<string, Cluster[]>();
      for (const entry of placement.labelled) {
        if (outsideGrouping(entry.label) || inContainer.has(entry.cluster.ticket) || effortStore.get(entry.label)) continue;
        if (entry.fit < assignmentConfidenceThreshold) continue;
        const bucket = grouped.get(entry.label);
        if (bucket === undefined) grouped.set(entry.label, [entry.cluster]);
        else bucket.push(entry.cluster);
      }
      const named = await nameEfforts({
        efforts: grouped,
        cachedName: (hash) => readGroupName("effort", hash),
        summaryOf: (value) => summaries.get(value.ticket) ?? fallbackSummary(value),
        linearProjectOf: (value) => linearProjects[value.ticket] ?? null,
        contextOf,
        naming,
      });
      writeGroupNames("effort", named.names);
      await logRenames(
        "effort",
        new Map([...grouped].map(([label, members]) => [label, effortMemberHash(members)])),
        new Set(named.names.keys()),
      );
      warnings.push(...named.warnings);
      addUsage(usage, named.usage);
      bb.log.info(
        `claude effort: ${named.usage.calls} calls for ${named.names.size} renamed, ${named.usage.inputTokens} in / ${named.usage.outputTokens} out`,
      );
    }

    // ---- program level, then domain level ----
    const program = await deriveLevel({
      level: "program",
      members: levelMembers(rolled.efforts, effortHash, () => [], context),
      summaryOf: (group) => group.name,
      contextOf,
      jev,
      naming,
      threshold: assignmentConfidenceThreshold,
    });
    warnings.push(...program.warnings);
    addUsage(usage, program.usage);

    // Programs are read back from the hierarchy the assignments just produced,
    // so the domain level sees exactly what the board will render.
    const built = await hierarchy();
    const byParent = groupChildren(built.groups);
    const childrenOf = (group: BoardGroup) => byParent.get(group.key) ?? [];
    const programGroups = built.groups.filter((group) => group.level === "program");
    if (programGroups.length > 0) {
      const domain = await deriveLevel({
        level: "domain",
        members: levelMembers(
          programGroups,
          (group) => memberHash("program", childrenOf(group).map(effortHash)),
          childrenOf,
          context,
        ),
        summaryOf: (group) => group.name,
        contextOf,
        jev,
        naming,
        threshold: assignmentConfidenceThreshold,
      });
      warnings.push(...domain.warnings);
      addUsage(usage, domain.usage);
    }

    bb.log.info(
      `enrich (${mode}): ${usage.calls} model calls, ${usage.inputTokens} in / ${usage.outputTokens} out`,
    );
    const record: z.infer<typeof enrichmentSchema> = { mode, ...usage, at: new Date().toISOString() };
    await bb.storage.kv.set("lastEnrichment", record);
    return warnings;
  }

  async function readPrefs(): Promise<Prefs> {
    // Treat persisted values as untrusted: they round-trip through storage and
    // a lens name from an older build must not break the board.
    const parsed = prefsSchema.safeParse(await bb.storage.kv.get<unknown>("prefs"));
    return parsed.success ? parsed.data : DEFAULT_PREFS;
  }

  // ---- row actions ----------------------------------------------------
  //
  // The client names a row by its checkout path and nothing else. The repo,
  // PR and reviewers come from the server's own last scan; the thread a
  // continue or subthread targets must be one this row is linked to.

  const HOST_ACTION_TIMEOUT_MS = 90_000;

  async function scannedUnit(path: string): Promise<{ raw: RawUnit; ticket: string } | undefined> {
    const pattern = compilePattern((await settings.get()).ticketPattern);
    const units = readUnits();
    const raw = units.find((unit) => unit.path === path);
    return raw === undefined ? undefined : { raw, ticket: (await findTickets(pattern, units))(raw)?.ticket ?? raw.dirName };
  }

  /** The row's open PR and the host to act from, or the reason there is none. */
  async function actionablePath(path: string): Promise<{ ok: true; raw: RawUnit; pr: Pr; prUrl: string; hostId: string } | { ok: false; error: string }> {
    const found = await scannedUnit(path);
    if (found === undefined) return { ok: false, error: "That checkout is not on the board any more. Rescan and try again." };
    const { raw } = found;
    if (raw.pr === null || raw.pr.state !== "OPEN") return { ok: false, error: raw.observed?.pr === false ? "Pull request status is unavailable. Rescan before acting." : "This row has no open pull request." };
    if (raw.rebasing) return { ok: false, error: "A rebase is in progress in this checkout. Finish it and rescan before a direct PR action." };
    if (prTarget(raw.pr.url) === null) return { ok: false, error: "The pull request URL from the last scan is not one gh can act on." };
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (hostId === null) return { ok: false, error: "No primary BB host is available to run gh from." };
    const local = await host.call("checkoutState", { path }, { hostId, timeoutMs: HOST_ACTION_TIMEOUT_MS });
    if (!local.ok) return { ok: false, error: `${local.error} Rescan before acting.` };
    if (local.rebasing) return { ok: false, error: "A rebase is in progress in this checkout. Finish it and rescan before a direct PR action." };
    if (local.branch === null || local.branch !== raw.branch) return { ok: false, error: "The checkout branch changed since the last scan. Rescan before acting." };
    return { ok: true, raw, pr: raw.pr, prUrl: raw.pr.url, hostId };
  }

  async function actionable(input: DirectTarget): Promise<{ ok: true; pr: Pr; prUrl: string; hostId: string } | { ok: false; error: string }> {
    if ("path" in input) return actionablePath(input.path);
    const linked = readUnits().filter((unit) => unit.pr?.url.toLowerCase() === input.prUrl.toLowerCase());
    if (linked.length > 0) {
      // A URL target must not bypass a rebase or branch-change guard in any checkout.
      let target: Awaited<ReturnType<typeof actionablePath>> | undefined;
      for (const unit of linked) {
        target = await actionablePath(unit.path);
        if (!target.ok) return target;
      }
      return target!;
    }
    const entry = inventory.get(input.prUrl);
    if (entry === undefined || entry.pr.state !== "OPEN" || prTarget(entry.pr.url) === null) {
      return { ok: false, error: "That open PR is no longer in the authored backlog. Refresh before acting." };
    }
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (hostId === null) return { ok: false, error: "No primary BB host is available to run gh from." };
    return { ok: true, pr: entry.pr, prUrl: entry.pr.url, hostId };
  }

  const liveOf = (hostId: string) => (prUrl: string) =>
    host.call("prLive", { prUrl }, { hostId, timeoutMs: HOST_ACTION_TIMEOUT_MS });
  const reviewersOf = (hostId: string) => (prUrl: string) =>
    host.call("prReviewers", { prUrl }, { hostId, timeoutMs: HOST_ACTION_TIMEOUT_MS });
  const writeOf = (hostId: string) => (request: Parameters<typeof host.call<"prWrite">>[1]) =>
    host.call("prWrite", request, { hostId, timeoutMs: HOST_ACTION_TIMEOUT_MS });

  const archiveStore: ArchiveStore = {
    get: async (id) => archiveRecordSchema.optional().parse(await bb.storage.kv.get(`threadArchive:${id}`)),
    set: (record) => bb.storage.kv.set(`threadArchive:${record.threadId}`, record),
    delete: (id) => bb.storage.kv.delete(`threadArchive:${id}`),
    list: async () => {
      const records = await Promise.all((await bb.storage.kv.list("threadArchive:")).map(async (key) =>
        archiveRecordSchema.safeParse(await bb.storage.kv.get(key))));
      return records.flatMap((record) => record.success ? [record.data] : []);
    },
  };

  /** The threads the Board links to this row's cluster, strongest first. */
  async function linkedThreads(path: string): Promise<{ id: string; title: string; tier: ThreadTier }[]> {
    for (const group of (await board()).groups) {
      for (const cluster of group.clusters) {
        if (cluster.units.some((unit) => unit.path === path)) {
          const unit = cluster.units.find((unit) => unit.path === path)!;
          const effort = (unit.pr ? effortStore.owner("prUrl", unit.pr.url) : null) ?? effortStore.owner("ticket", cluster.ticket);
          const parent = effort && unit.pr ? await effortParent(effortStore, effort, unit.pr.url, (id) => bb.sdk.threads.get({ threadId: id })) : null;
          return parent && !cluster.threads.some((thread) => thread.id === parent.thread.id)
            ? [{ id: parent.thread.id, title: parent.thread.title ?? effort!.name, tier: "started" as const }, ...cluster.threads]
            : cluster.threads;
        }
      }
    }
    return [];
  }

  async function effortPlan(groupKey: string): Promise<EffortPlan> {
    const current = await board();
    const established = effortStore.source(groupKey);
    const group = current.groups.find((entry) => entry.key === groupKey);
    if (!group && !established) return { ok: false, error: "That group is no longer on the board. Refresh and choose its current effort." };
    if (!established && (group!.level !== "effort" || outsideGrouping(group!.key))) return { ok: false, error: "Choose an outcome-based effort rather than a catch-all container." };
    const keys = new Set([groupKey]);
    for (let pass = 0; pass < 3; pass++) for (const entry of current.groups) if (entry.parentKey && keys.has(entry.parentKey)) keys.add(entry.key);
    const clusters = current.groups.filter((entry) => keys.has(entry.key)).flatMap((entry) => entry.clusters);
    const members: EffortMembers = established?.members ?? normalizeMembers({
      tickets: clusters.map((cluster) => cluster.ticket),
      prUrls: [...clusters.flatMap((cluster) => cluster.units.flatMap((unit) => unit.pr ? [unit.pr.url] : [])),
        ...current.prInventory.entries.filter((entry) => entry.effortKey && keys.has(entry.effortKey)).map((entry) => entry.pr.url)],
    });
    if (members.tickets.length === 0 && members.prUrls.length === 0) return { ok: false, error: "This group has no tracked work to coordinate." };
    const allProjects = await bb.sdk.projects.list();
    const paths = clusters.flatMap((cluster) => cluster.units.map((unit) => unit.path));
    const projects = allProjects.filter((project) => project.id === established?.projectId || project.sources.some((source) => paths.some((path) => withinPath(path, source.path))))
      .map((project) => ({ id: project.id, name: project.name }));
    const choices = (await bb.sdk.threads.list({ archived: false, limit: 100 })).filter((thread) =>
      thread.status === "idle" && thread.deletedAt === null && projects.some((project) => project.id === thread.projectId));
    const eligible = (await Promise.all(choices.slice(0, 50).map(async (thread) => {
      try { return await bb.sdk.threads.get({ threadId: thread.id }); } catch { return null; }
    }))).filter((thread): thread is NonNullable<typeof thread> => thread !== null && thread.canSpawnChild);
    let effort = established;
    if (effort?.coordinatorThreadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: effort.coordinatorThreadId });
        effort = effortStore.save({ ...effort, coordinatorState: thread.archivedAt === null && thread.deletedAt === null ? "ready" : "unavailable" });
      } catch { effort = effortStore.save({ ...effort, coordinatorState: "unavailable" }); }
    }
    return { ok: true, name: effort?.name ?? group!.name, goal: effort?.goal ?? "", members, projects,
      threads: eligible.map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback ?? thread.id, projectId: thread.projectId })), effort };
  }

  const coordinators = createCoordinatorService(effortStore, {
    get: (threadId) => bb.sdk.threads.get({ threadId }),
    rename: (threadId, title) => bb.sdk.threads.update({ threadId, title }),
    associate: (threadId, effortId) => bb.sdk.threads.updatePluginMetadata({ threadId, set: { effortId, role: "coordinator" } }),
    spawn: async (args) => {
      const projects = await bb.sdk.projects.list();
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      const project = projects.find((entry) => entry.id === args.projectId);
      const source = project?.sources.find((entry) => entry.hostId === hostId) ?? project?.sources[0];
      if (!source) throw new Error("The selected project has no available source for a separate coordinator worktree.");
      return bb.sdk.threads.spawn({ ...args, environment: { type: "provider", environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: source.hostId }, inputs: { branch: { kind: "default" } } } });
    },
    recover: async (effortId, projectId) => {
      const matches: string[] = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const rows = await bb.sdk.threads.list({ projectId, originPluginId: bb.pluginId, includeHidden: true, limit: 100, offset });
        for (const thread of rows) {
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
          if (metadata.effortId === effortId && metadata.role === "coordinator" && thread.archivedAt === null && thread.deletedAt === null) matches.push(thread.id);
        }
        if (rows.length < 100) break;
      }
      return matches;
    },
  });

  const manualPrWrites = new Set<string>();
  // SDK spawn/send can return before thread events reach the board cache.
  const pendingPrThreads = new Map<string, { id: string; startedAt: number }>();
  async function withPrWriter<T>(path: string, prUrl: string | undefined, action: () => Promise<T>): Promise<T | { ok: false; error: string }> {
    const key = prUrl?.toLowerCase();
    if (advance.reserved(key ?? "", path) || (key && manualPrWrites.has(key)) || launchingCheckouts.has(path)) return { ok: false, error: "A batch or another action owns this PR or checkout." };
    if (key) manualPrWrites.add(key);
    try {
      const result = await action();
      if (key && result !== null && typeof result === "object" && "threadId" in result && typeof result.threadId === "string") {
        pendingPrThreads.set(key, { id: result.threadId, startedAt: Date.now() });
      }
      return result;
    } finally { if (key) manualPrWrites.delete(key); }
  }
  async function advanceInspect(prUrl: string, repair = false): Promise<AdvanceFacts> {
    const units = readUnits();
    const tracked = units.find((unit) => unit.pr?.url.toLowerCase() === prUrl.toLowerCase())?.pr ?? inventory.get(prUrl)?.pr;
    if (!tracked) throw new Error("That PR is no longer tracked. Refresh the backlog.");
    const target = prTarget(prUrl);
    if (!target) throw new Error("Invalid tracked PR URL");
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("No primary host is available");
    const projects = await bb.sdk.projects.list();
    const candidates = units.filter((unit) => unit.githubRepo?.toLowerCase() === target.slug.toLowerCase())
      .sort((a, b) => Number(b.pr?.url === prUrl) - Number(a.pr?.url === prUrl) || a.path.localeCompare(b.path));
    const source = candidates.map((unit) => ({ unit, project: projectForPath(projects, unit.path) }))
      .find((entry) => entry.project?.hostId === hostId);
    const fallback: AdvanceFacts = { prUrl, repo: target.slug, number: tracked.number, title: tracked.title,
      headOid: "", baseOid: "", baseRefName: tracked.baseRefName ?? "", headRefName: tracked.headRefName ?? "",
      needsPreparation: false, needsFeedback: false, eligible: false, detail: "GitHub inspection failed", workspace: source ? "create" : "unavailable",
      projectId: source?.project?.projectId ?? null, hostId, sourcePath: source?.unit.path ?? null,
      path: units.find((unit) => unit.pr?.url.toLowerCase() === prUrl.toLowerCase())?.path ?? null, readiness: "needs-attention", blockedBy: null };
    try {
      const result = await host.call("advanceInspect", { prUrl }, { hostId, timeoutMs: 60_000, signal: disposal.signal });
      if (!result.ok) return { ...fallback, detail: result.error };
      const facts = result.facts;
      const needsFeedback = facts.unresolvedThreads > 0 || facts.approvalNotePending;
      const needsWriter = repair || facts.needsPreparation || needsFeedback;
      const eligible = facts.state === "OPEN" && (repair || facts.reviewDecision === "APPROVED") && !facts.isDraft && (!needsWriter || (!facts.isCrossRepository && !!source));
      const detail = facts.state !== "OPEN" || facts.isDraft ? facts.detail : facts.isCrossRepository && needsWriter ? "Fork PRs need manual preparation and review follow-up in this version" : needsWriter && !source ? "No matching scanned repository in a BB project; add it and rescan" : facts.detail;
      return { ...fallback, ...facts, needsFeedback, eligible, detail, blockedBy: facts.basePrNumber === null ? null : `${target.slug}#${facts.basePrNumber}` };
    } catch (error) { return { ...fallback, detail: `Inspection failed: ${String(error).slice(0, 300)}` }; }
  }
  async function advanceRepairLinks(facts: AdvanceFacts, previousThreadId?: string | null) {
    const links = new Map<string, { id: string; title: string; tier: ThreadTier }>();
    const offer = (id: string | null, title: string, tier: ThreadTier) => { if (id && !links.has(id)) links.set(id, { id, title, tier }); };
    const effort = effortStore.owner("prUrl", facts.prUrl);
    if (effort) for (const worker of effortStore.workers(effort.id, facts.prUrl)) offer(worker.threadId, "PR author or follow-up", "started");
    for (const run of runs.recent(0, 1_000)) if (run.prUrl?.toLowerCase() === facts.prUrl.toLowerCase()) offer(run.threadId, "Previous PR action", "started");
    if (facts.path) for (const link of await linkedThreads(facts.path)) offer(link.id, link.title, link.tier);
    for (const batch of advance.list()) for (const job of batch.jobs) if (job.prUrl.toLowerCase() === facts.prUrl.toLowerCase()) {
      offer(job.threadId, "Previous Advance worker", "started");
      for (const attempt of job.previousAttempts) offer(attempt.threadId, "Previous repair worker", "started");
    }
    offer(previousThreadId ?? null, "Previous Advance worker", "started");
    return [...links.values()];
  }
  async function advanceRepairCandidates(facts: AdvanceFacts, job: AdvanceJob) {
    const links = await advanceRepairLinks(facts, job.threadId);
    const selected = links.filter((link) => link.id !== job.threadId).slice(0, 7);
    const previous = links.find((link) => link.id === job.threadId);
    if (previous) selected.push(previous);
    const candidates = (await Promise.all(selected.map(async (link): Promise<ThreadCandidate | null> => {
      try {
        const thread = await bb.sdk.threads.get({ threadId: link.id });
        if (thread.archivedAt !== null || thread.deletedAt !== null || thread.projectId !== facts.projectId) return null;
        return { ...link, title: (thread.title ?? thread.titleFallback ?? link.title).slice(0, 200), updatedAt: thread.updatedAt,
          running: thread.status !== "idle" && thread.status !== "error", contextUsed: null, canSpawnChild: thread.canSpawnChild };
      } catch { return null; }
    }))).filter((candidate): candidate is ThreadCandidate => candidate !== null);
    return { candidates, recommendation: recommendThread(facts.needsFeedback ? "address-review" : "resolve-conflicts", candidates, { send: false, subthread: true, contextUsage: false }) };
  }
  const advance = createAdvanceService(db, {
    inspect: advanceInspect,
    repairCandidates: advanceRepairCandidates,
    repairSpawn: async (facts, workerPath, prompt, attemptId, mode, parentThreadId) => {
      if (!facts.projectId) throw new Error("No project is available for this PR repair");
      if (mode === "subthread" && parentThreadId === null) throw new Error("A repair subthread needs its validated parent.");
      if (mode === "new" && parentThreadId !== null) throw new Error("A new repair thread cannot specify a parent.");
      const thread = await bb.sdk.threads.spawn({ projectId: facts.projectId,
        title: `${facts.repo.split("/").at(-1)} #${facts.number}: repair ${facts.needsFeedback ? "review feedback" : facts.needsPreparation ? "branch preparation" : "validation"}`,
        prompt: parentThreadId ? `${prompt}\nAuthor context reference: @thread:${parentThreadId}. Consult its relevant PR decisions only if the live PR description, review discussion, and code do not establish the intended behavior.` : prompt,
        environment: { type: "host", hostId: facts.hostId, workspace: { type: "unmanaged", path: workerPath } },
        ...(mode === "subthread" ? { parentThreadId: parentThreadId! } : {}),
        pluginMetadata: { advanceJobId: attemptId, role: "advance-repair", prUrl: facts.prUrl } });
      return thread.id;
    },
    workspace: async (facts, batchId, jobId) => {
      if (!facts.sourcePath) throw new Error("No matching repository source is available");
      const result = await host.call("advanceWorkspace", { sourcePath: facts.sourcePath, prUrl: facts.prUrl,
        expectedHeadOid: facts.headOid, expectedBaseOid: facts.baseOid, batchId, jobId }, { hostId: facts.hostId, timeoutMs: SCAN_TIMEOUT_MS, signal: disposal.signal });
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    busyNow: (prUrl, path) => manualPrWrites.has(prUrl.toLowerCase()) || pendingPrThreads.has(prUrl.toLowerCase()) || (path !== null && launchingCheckouts.has(path)) || dispatch.activeFor(path ?? "", prUrl) ||
      runs.recent(Number.MAX_SAFE_INTEGER).some((run) => (run.prUrl === prUrl || (path !== null && run.path === path)) && ["running", "needs-you"].includes(run.status)),
    busy: async (prUrl, path, ownThreadId) => {
      const key = prUrl.toLowerCase();
      const pending = pendingPrThreads.get(key);
      if (pending && pending.id !== ownThreadId) {
        try {
          const thread = await bb.sdk.threads.get({ threadId: pending.id });
          if ((thread.status !== "idle" && thread.status !== "error") || Date.now() - pending.startedAt < 120_000) return true;
          pendingPrThreads.delete(key);
        } catch { return true; }
      }
      if (manualPrWrites.has(prUrl.toLowerCase()) || (path !== null && launchingCheckouts.has(path)) || dispatch.activeFor(path ?? "", prUrl) ||
        runs.recent(Number.MAX_SAFE_INTEGER).some((run) => (run.prUrl === prUrl || (path !== null && run.path === path)) && ["running", "needs-you"].includes(run.status))) return true;
      if (path === null) return false;
      const linked = await linkedThreads(path);
      const live = await Promise.all(linked.filter((thread) => thread.id !== ownThreadId).map(async (thread) => {
        try { const state = await bb.sdk.threads.get({ threadId: thread.id }); return state.status !== "idle" && state.status !== "error"; }
        catch { return true; }
      }));
      return live.some(Boolean);
    },
    spawn: async (facts, workerPath, prompt, jobId) => {
      if (!facts.projectId) throw new Error("No project is available for the repository worker");
      const thread = await bb.sdk.threads.spawn({ projectId: facts.projectId, title: "Rebasing...", prompt,
        environment: { type: "host", hostId: facts.hostId, workspace: { type: "unmanaged", path: workerPath } },
        pluginMetadata: { advanceJobId: jobId, role: "rebase-worker" } });
      return thread.id;
    },
    send: async (threadId, prompt) => { await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: prompt, mentions: [] }] }); },
    thread: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return { ...thread, output: thread.status === "idle" ? (await bb.sdk.threads.output({ threadId })).output ?? "" : "" };
    },
    recover: async (jobId, projectId) => {
      const matches: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const rows = await bb.sdk.threads.list({ projectId, originPluginId: bb.pluginId, includeHidden: true, limit: 100, offset });
        for (const thread of rows) {
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
          if (metadata.advanceJobId === jobId) matches.push(thread.id);
        }
        if (rows.length < 100) return matches;
      }
    },
    changed: () => { bb.realtime.publish(BOARD_CHANGED, { scanning }); },
    verified: (url, path) => { scheduleInventoryUrls([url]); if (path) rescans.add(path); },
  });
  const advanceTimer = setInterval(() => { void advance.tick().catch(onThreadError); }, 30_000);
  bb.onDispose(() => { clearInterval(advanceTimer); advance.dispose(); });
  queueMicrotask(() => { void advance.tick(true).catch(onThreadError); });

  const launchingCheckouts = new Set<string>();
  const agentSdk: AgentSdk = {
    projects: { list: () => bb.sdk.projects.list() },
    threads: {
      spawn: async (args) => {
        const path = args.environment.workspace.path;
        if (launchingCheckouts.has(path)) throw new Error("Another Workstreams action is launching in this checkout.");
        launchingCheckouts.add(path);
        try {
          const active = await activeCheckoutThread(path, args.environment.hostId, (offset) => bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 100, offset }));
          if (active) throw new Error(`Thread ${active} is already working in this checkout. Wait for it or stop it before starting another writer.`);
          const raw = readUnits().find((unit) => unit.path === path);
          const effort = (raw?.pr ? effortStore.owner("prUrl", raw.pr.url) : null) ?? effortStore.owner("ticket", args.pluginMetadata.ticket);
          const route = effort && raw?.pr ? await effortParent(effortStore, effort, raw.pr.url, (id) => bb.sdk.threads.get({ threadId: id })) : null;
          let parentThreadId = args.parentThreadId ?? route?.thread.id;
          if (parentThreadId) {
            const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
            if (!parent.canSpawnChild || parent.archivedAt !== null || parent.deletedAt !== null) throw new Error("The selected parent can no longer own a child thread. Reopen the action preview.");
          }
          const role = route !== null && route.thread.id === parentThreadId ? route.role : "pr";
          const metadata = effort && raw?.pr ? { ...args.pluginMetadata, effortId: effort.id, role, prUrl: raw.pr.url } : args.pluginMetadata;
          const { parentThreadId: _previous, ...request } = args;
          const prompt = effort ? `${request.prompt}\nEffort context (data): ${JSON.stringify({ name: effort.name, goal: effort.goal, coordinatorThreadId: effort.coordinatorThreadId })}. Keep this action scoped to the requested PR and report the outcome and remaining blockers.` : request.prompt;
          const thread = await bb.sdk.threads.spawn({ ...request, prompt, ...(parentThreadId ? { parentThreadId } : {}), pluginMetadata: metadata });
          if (effort && raw?.pr) effortStore.recordWorker(effort.id, thread.id, raw.pr.url, role);
          return thread;
        } finally { launchingCheckouts.delete(path); }
      },
      get: (args) => bb.sdk.threads.get(args),
      context: (args) => bb.sdk.threads.context(args),
    },
  };

  function recoverDispatch(): void {
    const units = readUnits();
    for (const attempt of dispatch.attempts()) {
      if (attempt.status !== "needs-you") continue;
      if (attempt.threadId !== null && runs.openIn(attempt.threadId).length > 0) continue;
      const unit = units.find((entry) => entry.path === attempt.path && entry.pr?.url === attempt.prUrl);
      if (unit?.observed?.status === true && unit.observed.pr === true && unit.pr !== null) {
        if (unit.pr.state === "MERGED") dispatch.update(attempt.id, "verified", "Fresh scan confirms GitHub reports this PR merged");
        else if (unit.pr.state === "OPEN" && !gateStillOpen(unit.pr, attempt.action)) {
          dispatch.update(attempt.id, "verified", "Fresh scan confirms the PR gate cleared");
        }
      }
    }
  }

  const verificationTimers = new Set<ReturnType<typeof setTimeout>>();
  bb.onDispose(() => {
    for (const timer of verificationTimers) clearTimeout(timer);
    verificationTimers.clear();
  });
  function retryVerification(id: number, path: string, prUrl: string, action: string, retries: number): void {
    if (disposal.signal.aborted || dispatch.status(id) !== "verifying") return;
    if (retries >= 10) {
      dispatch.finishVerification(id, "needs-you", "Fresh PR inspection stayed busy; refresh the board and inspect this attempt");
      bb.realtime.publish(BOARD_CHANGED, { scanning });
      return;
    }
    const timer = setTimeout(() => {
      verificationTimers.delete(timer);
      void verifyDispatch(id, path, prUrl, action, retries + 1);
    }, RESCAN_DELAY_MS);
    verificationTimers.add(timer);
  }
  async function verifyDispatch(id: number, path: string, prUrl: string, action: string, retries = 0): Promise<void> {
    if (disposal.signal.aborted || dispatch.status(id) !== "verifying") return;
    if (scanning || targeting) {
      retryVerification(id, path, prUrl, action, retries);
      return;
    }
    const scanned = await rescanPaths([path]);
    if (disposal.signal.aborted || dispatch.status(id) !== "verifying") return;
    if (!scanned && (scanning || targeting)) {
      retryVerification(id, path, prUrl, action, retries);
      return;
    }
    const unit = scanned ? readUnits().find((entry) => entry.path === path && entry.pr?.url === prUrl) : undefined;
    if (unit === undefined || unit.observed?.status !== true || unit.observed?.pr !== true || unit.pr === null) {
      dispatch.finishVerification(id, "needs-you", "Fresh PR inspection failed; check the agent thread and refresh the board");
    } else if (unit.pr.state === "MERGED") {
      dispatch.finishVerification(id, "verified", "Fresh scan confirms GitHub reports this PR merged");
    } else if (unit.pr.state !== "OPEN") {
      dispatch.finishVerification(id, "needs-you", "GitHub reports this PR closed without a merge");
    } else if (gateStillOpen(unit.pr, action)) {
      dispatch.finishVerification(id, "needs-you", "The PR gate remains after a fresh scan; inspect the agent's local proposal");
    } else {
      dispatch.finishVerification(id, "verified", "Fresh scan confirms the PR gate cleared");
    }
    bb.realtime.publish(BOARD_CHANGED, { scanning });
    void dispatchOne();
  }

  /** One durable reservation per launch; the prompt confines autonomous work to local repairs. */
  let dispatching = false;
  async function dispatchOne(preflightPass = 0): Promise<void> {
    if (dispatching || disposal.signal.aborted || scanning || targeting || dispatch.policy().mode !== "auto") return;
    dispatching = true;
    try {
      const current = await board();
      const choice = selectCandidate(current.groups, current.dispatch.effortKey, dispatch.attempts(), runs.recent(Number.MAX_SAFE_INTEGER));
      if (choice === null) return;
      // The board may have been built from an old scan. Inspect this checkout before committing to a launch.
      if (!(await rescanPaths([choice.candidate.path]))) return;
      if (dispatch.policy().mode !== "auto" || disposal.signal.aborted) return;
      const fresh = await board();
      const checked = selectCandidate(fresh.groups, fresh.dispatch.effortKey, dispatch.attempts(), runs.recent(Number.MAX_SAFE_INTEGER));
      if (checked === null) return;
      if (checked.candidate.path !== choice.candidate.path || checked.candidate.prUrl !== choice.candidate.prUrl ||
        checked.candidate.action !== choice.candidate.action) {
        if (preflightPass === 0) queueMicrotask(() => void dispatchOne(1));
        return;
      }
      if (advance.reserved(checked.candidate.prUrl, checked.candidate.path)) return;
      const id = dispatch.reserve(checked);
      if (id === null) return;
      bb.realtime.publish(BOARD_CHANGED, { scanning });
      const { candidate } = checked;
      const found = await scannedUnit(candidate.path);
      if (found === undefined || found.raw.pr?.url !== candidate.prUrl) {
        dispatch.update(id, "needs-you", "Checkout or PR changed before launch; refresh the board");
        return;
      }
      const linked = await linkedThreads(candidate.path);
      const plan = await planAgent(agentSdk, candidate.action, linked);
      if (dispatch.policy().mode !== "auto" || disposal.signal.aborted) {
        dispatch.update(id, "needs-you", "Automatic dispatch was switched off before launch");
        return;
      }
      if (plan.candidates.some((thread) => thread.running) ||
        runs.recent(Number.MAX_SAFE_INTEGER).some((run) =>
          (run.path === candidate.path || run.prUrl === candidate.prUrl) && (run.status === "running" || run.status === "needs-you"))) {
        dispatch.update(id, "needs-you", "A linked thread or row action became active before launch");
        return;
      }
      const recommendation = plan.recommendation;
      const mode = recommendation.mode === "subthread" ? "subthread" : "new";
      const prompt = `Work on ${candidate.prUrl} in checkout ${candidate.path}. ${candidate.reason}. Inspect the relevant failure or review feedback, make a focused local repair, and run relevant tests. Do not push, reply to GitHub, update the branch remotely, merge, or deploy. Before any remote write, pause for the user's approval; if an approval interaction is unavailable, stop with a local proposal and report what remains. Do not claim the PR gate cleared until a fresh remote scan confirms it.`;
      const runId = runs.begin({ ...(await runTarget(candidate.path)), action: candidate.action, mode, threadId: null });
      if (dispatch.policy().mode !== "auto" || disposal.signal.aborted) {
        runs.discard(runId);
        dispatch.update(id, "needs-you", "Automatic dispatch was switched off before launch");
        return;
      }
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent(agentSdk, {
          unit: { path: found.raw.path, ticket: found.ticket }, mode, threadId: recommendation.threadId,
          prompt, linked: linked.map((thread) => thread.id),
        });
      } catch (error) {
        runs.discard(runId);
        throw error;
      }
      if (!result.ok) {
        runs.discard(runId);
        dispatch.update(id, "failed", result.error);
      } else {
        runs.attach(runId, result.threadId);
        dispatch.update(id, "running", "Agent is inspecting and repairing locally", result.threadId);
        startedFor.set(result.threadId, result.ticket);
        announceThreads();
      }
    } catch (error) {
      const launching = dispatch.attempts().find((attempt) => attempt.status === "launching");
      if (launching !== undefined) dispatch.update(launching.id, "failed", `Launch failed: ${String(error).slice(0, 300)}`);
      bb.log.warn(`dispatch launch failed: ${String(error).slice(0, 300)}`);
    } finally {
      dispatching = false;
      bb.realtime.publish(BOARD_CHANGED, { scanning });
    }
  }

  /** Where a run points: the row's ticket and PR from the last scan. */
  async function runTarget(path: string) {
    const found = await scannedUnit(path);
    const pr = found?.raw.pr ?? null;
    return { path, ticket: found?.ticket ?? null, prUrl: pr?.url ?? null, prNumber: pr?.number ?? null };
  }

  /**
   * Run a direct action and record its outcome. A success rescans the row (see
   * `runsChanged`), so the Board shows where it went.
   */
  async function directRun(path: string, action: DirectAction, act: () => Promise<WriteResult>): Promise<WriteResult> {
    const startedAt = Date.now();
    const record = async (outcome: WriteResult) =>
      runsChanged([runs.recordDirect({ ...(await runTarget(path)), action, startedAt, ...directOutcome(action, outcome) })]);
    let result: WriteResult;
    try {
      result = await act();
    } catch (error) {
      await record({ ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await record(result);
    return result;
  }

  async function directActionRun(input: DirectTarget, action: DirectAction, act: () => Promise<WriteResult>): Promise<WriteResult> {
    const unit = "path" in input ? readUnits().find((entry) => entry.path === input.path) :
      readUnits().find((entry) => entry.pr?.url.toLowerCase() === input.prUrl.toLowerCase());
    const prUrl = "prUrl" in input ? input.prUrl : unit?.pr?.url;
    if (prUrl && (advance.reserved(prUrl, unit?.path ?? null) || manualPrWrites.has(prUrl.toLowerCase()))) return { ok: false, error: "A batch or another action owns this PR." };
    if (prUrl) manualPrWrites.add(prUrl.toLowerCase());
    try {
      // Remote-only actions report through their dialog and fresh PR state. Run
      // history remains checkout-based until it has a real nullable target type.
      return unit === undefined ? await act() : await directRun(unit.path, action, act);
    } finally {
      if (prUrl) manualPrWrites.delete(prUrl.toLowerCase());
      if (prUrl !== undefined) scheduleInventoryUrls([prUrl]);
    }
  }

  bb.rpc.register(rpcContract, {
    board_get: () => board(),
    advance_preview: ({ prUrls }) => advance.preview(prUrls),
    advance_start: ({ token }) => advance.start(token),
    advance_get: () => advance.list(),
    advance_cancel: ({ batchId }) => advance.cancel(batchId),
    advance_recheck: ({ batchId }) => advance.recheck(batchId),
    advance_repair_plan: ({ batchId, jobId }) => advance.repairPlan(batchId, jobId),
    advance_repair_run: (input) => advance.repairRun(input),
    effort_plan: ({ groupKey }) => effortPlan(groupKey),
    effort_coordinate: async (input) => {
      const result = await coordinators.coordinate(input, await effortPlan(input.groupKey));
      if (result.ok && dispatch.policy().effort_key === input.groupKey) dispatch.setPolicy(dispatch.policy().mode, result.effort.key);
      bb.realtime.publish(BOARD_CHANGED, { scanning });
      return result;
    },
    inventory_refresh: () => {
      if (inventoryRefreshing || inventoryTargeting) return { started: false };
      void refreshInventory();
      return { started: true };
    },
    dispatch_set: async ({ mode, effortKey }): Promise<DispatchState> => {
      const current = await board();
      if (mode === "auto" && effortKey === null) throw new Error("Choose an effort before enabling automatic dispatch.");
      if (effortKey !== null && !current.groups.some((group) => group.key === effortKey && !current.groups.some((child) => child.parentKey === group.key))) {
        throw new Error("That effort is no longer on the board. Refresh and choose an effort.");
      }
      dispatch.setPolicy(mode, effortKey);
      bb.realtime.publish(BOARD_CHANGED, { scanning });
      if (mode === "auto") queueMicrotask(() => void dispatchOne());
      return (await board()).dispatch;
    },
    // Nothing starts after the end of time, so this is exactly the open runs.
    runs_open: () => runs.recent(Number.MAX_SAFE_INTEGER),
    prefs_get: () => readPrefs(),
    prefs_set: async (next) => {
      await bb.storage.kv.set("prefs", next);
      return next;
    },
    thread_start: async ({ path, prompt }) => withPrWriter(path, readUnits().find((unit) => unit.path === path)?.pr?.url, async () => {
      // The unit and its cluster come from the last scan, never from the client.
      const pattern = compilePattern((await settings.get()).ticketPattern);
      const units = readUnits();
      const raw = units.find((unit) => unit.path === path);
      const unit =
        raw === undefined
          ? undefined
          : { path: raw.path, ticket: (await findTickets(pattern, units))(raw)?.ticket ?? raw.dirName };
      const result = await startThread(
        {
          projects: { list: () => bb.sdk.projects.list() },
          threads: { spawn: (args) => bb.sdk.threads.spawn(args) },
        },
        unit,
        prompt,
      );
      if (result.ok) {
        // Linked at once, not on the next relist: the metadata is the record.
        startedFor.set(result.threadId, result.ticket);
        bb.log.info(`started thread ${result.threadId} for ${result.ticket}`);
        announceThreads();
      }
      return result;
    }),
    thread_archive: async ({ threadId }) => {
      const clusters = (await board()).groups.flatMap((group) => group.clusters);
      const cluster = clusters.find((item) => item.threads.some((thread) => thread.id === threadId));
      const thread = cluster?.threads.find((item) => item.id === threadId);
      return archiveLinkedThread(bb.sdk.threads, archiveStore, {
        threadId, link: thread === undefined || cluster === undefined ? undefined : { title: thread.title, ticket: cluster.ticket },
      });
    },
    thread_restore: ({ threadId }) => restoreArchivedThread(bb.sdk.threads, archiveStore, threadId),
    thread_archived: async () => (await archiveStore.list()).sort((a, b) => b.archivedAt - a.archivedAt).slice(0, ARCHIVE_HISTORY_LIMIT),
    thread_message: async ({ path, prUrl, threadId, message }) => withPrWriter(path, readUnits().find((unit) => unit.path === path)?.pr?.url, async () => {
      const found = await scannedUnit(path);
      if (found === undefined) return { ok: false as const, error: "That checkout is no longer on the board. Refresh and try again." };
      const pr = found.raw.pr;
      if (pr === null || pr.state !== "OPEN") return { ok: false as const, error: "This row no longer has an open pull request." };
      if (pr.url !== prUrl) return { ok: false as const, error: "This checkout now points to a different pull request. Refresh the board before sending." };
      return sendRowMessage(
        {
          get: ({ threadId: id }) => bb.sdk.threads.get({ threadId: id }),
          send: async (args) => {
            const result = await bb.sdk.threads.send(args);
            pendingPrThreads.set(prUrl.toLowerCase(), { id: args.threadId, startedAt: Date.now() });
            return result;
          },
        },
        {
          threadId,
          message,
          links: await linkedThreads(path),
          pr: { repo: found.raw.repo ?? found.raw.dirName, number: pr.number, title: pr.title, url: pr.url, checkout: path },
        },
      );
    }),
    action_merge_preview: async (input) => {
      const target = await actionable(input);
      if (!target.ok) return target;
      const read = await liveOf(target.hostId)(target.prUrl);
      if (!read.ok) return read;
      const { mergeMethod, deleteBranchOnMerge } = await settings.get();
      const verdict = mergeVerdict(read.live);
      return {
        ok: true as const,
        live: read.live,
        ...verdict,
        method: mergeMethodOf(mergeMethod),
        deleteBranch: shouldDeleteBranch(deleteBranchOnMerge, read.live.stackedAbove),
      };
    },
    action_merge: (input) =>
      directActionRun(input, "merge", async () => {
        const target = await actionable(input);
        if (!target.ok) return target;
        const { mergeMethod, deleteBranchOnMerge } = await settings.get();
        return executeMerge(
          { live: liveOf(target.hostId), write: writeOf(target.hostId) },
          { prUrl: target.prUrl, sha: input.sha, acknowledgeUnresolved: input.acknowledgeUnresolved, method: mergeMethodOf(mergeMethod), deleteBranchSetting: deleteBranchOnMerge },
        );
      }),
    action_update_branch: (input) =>
      directActionRun(input, "update-branch", async () => {
        const target = await actionable(input);
        if (!target.ok) return target;
        const live = await reviewersOf(target.hostId)(target.prUrl);
        if (!live.ok) return live;
        return writeOf(target.hostId)({ kind: "update-branch", prUrl: target.prUrl });
      }),
    action_nudge: (input) =>
      directActionRun(input, "nudge", async () => {
        const { rerequest, comment } = input;
        const target = await actionable(input);
        if (!target.ok) return target;
        const live = await reviewersOf(target.hostId)(target.prUrl);
        if (!live.ok) return live;
        const scanned = target.pr.reviewRequests;
        if (rerequest && [...live.reviewers].sort().join("\n") !== [...scanned].sort().join("\n")) {
          return { ok: false as const, error: "Pending reviewers changed since the last scan. Rescan and confirm again." };
        }
        const reviewers = rerequest ? live.reviewers : [];
        if (rerequest && reviewers.length === 0) return { ok: false as const, error: "No reviewers are pending on this PR to re-request." };
        return writeOf(target.hostId)({ kind: "nudge", prUrl: target.prUrl, reviewers, comment });
      }),
    agent_plan: async ({ path, action }) => {
      if ((await scannedUnit(path)) === undefined) {
        return { ok: false as const, error: "That checkout is not on the board any more. Rescan and try again." };
      }
      const plan = await planAgent(agentSdk, action, await linkedThreads(path));
      const found = await scannedUnit(path);
      const effort = (found?.raw.pr ? effortStore.owner("prUrl", found.raw.pr.url) : null) ?? (found ? effortStore.owner("ticket", found.ticket) : null);
      const parent = effort && found?.raw.pr ? await effortParent(effortStore, effort, found.raw.pr.url, (id) => bb.sdk.threads.get({ threadId: id })) : null;
      if (parent) plan.recommendation = { mode: "subthread", threadId: parent.thread.id, reason: parent.role === "followup"
        ? `A bounded follow-up under this PR's worker will report its result there.`
        : `A PR worker under ${effort!.name} will report its result to the effort coordinator.` };
      return { ok: true as const, ...plan };
    },
    agent_run: async ({ path, action, mode, threadId, prompt }) => withPrWriter(path, readUnits().find((unit) => unit.path === path)?.pr?.url, async () => {
      if (mode === "continue") {
        return { ok: false as const, error: "Continue in an existing thread cannot track this action reliably. Choose a subthread or new thread." };
      }
      const found = await scannedUnit(path);
      if (advance.reserved(found?.raw.pr?.url ?? "", path) || dispatch.activeFor(path, found?.raw.pr?.url ?? null)) {
        return { ok: false as const, error: "Automatic dispatch is working on this PR or waiting for a decision." };
      }
      const linked = (await linkedThreads(path)).map((thread) => thread.id);
      if (advance.reserved(found?.raw.pr?.url ?? "", path) || dispatch.activeFor(path, found?.raw.pr?.url ?? null)) {
        return { ok: false as const, error: "Automatic dispatch is working on this PR or waiting for a decision." };
      }
      // Recorded before launch; bound to the dedicated thread when spawn returns.
      const runId = runs.begin({ ...(await runTarget(path)), action, mode, threadId: null });
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent(agentSdk, {
          unit: found === undefined ? undefined : { path: found.raw.path, ticket: found.ticket },
          mode,
          threadId,
          prompt,
          linked,
        });
      } catch (error) {
        runs.discard(runId);
        return { ok: false as const, error: String(error).slice(0, 400) };
      }
      if (!result.ok) runs.discard(runId);
      else runs.attach(runId, result.threadId);
      if (result.ok) {
        // A new or sub thread is linked at once through the metadata it was seeded with.
        startedFor.set(result.threadId, result.ticket);
        bb.log.info(`agent action (${mode}) in thread ${result.threadId} for ${result.ticket}`);
        announceThreads();
      }
      return result;
    }),
    linear_fetch_plan: async () => {
      const tickets = await fallbackTickets();
      const running = runs.recent(Number.MAX_SAFE_INTEGER).some((run) => run.action === LINEAR_FETCH);
      return { ok: true as const, tickets: tickets.length, capped: Math.min(tickets.length, AGENT_FETCH_MAX), running, keys: (await linearKeys()).length };
    },
    linear_fetch_run: async () => {
      if (runs.recent(Number.MAX_SAFE_INTEGER).some((run) => run.action === LINEAR_FETCH)) {
        return { ok: false as const, error: "A Linear fetch is already running." };
      }
      const { roots } = await resolveRoots((await settings.get()).scanRoots);
      const tickets = await fallbackTickets();
      const runId = runs.begin({ path: roots[0] ?? "", ticket: null, prUrl: null, prNumber: null, action: LINEAR_FETCH, mode: "new", threadId: null });
      let result: Awaited<ReturnType<typeof startLinearFetch>>;
      try {
        result = await startLinearFetch(
          {
            projects: { list: () => bb.sdk.projects.list() },
            threads: { spawn: (args) => bb.sdk.threads.spawn(args) },
          },
          roots,
          tickets,
        );
      } catch (error) {
        runs.discard(runId);
        throw error;
      }
      if (!result.ok) {
        runs.discard(runId);
        return result;
      }
      runs.attach(runId, result.threadId);
      await bb.storage.kv.set("linearFetches", { ...(await pendingFetches()), [String(runId)]: result.asked });
      bb.log.info(`linear fetch run ${runId}: thread ${result.threadId}, ${result.asked.length} tickets`);
      announceThreads();
      return { ok: true as const, threadId: result.threadId, asked: result.asked.length };
    },
    board_refresh: () => {
      // scan() flips `scanning` synchronously, so read it before calling.
      const idle = !scanning;
      // Fire and forget: the realtime signal tells the board when to refetch.
      void scan();
      return { started: idle };
    },
  });

  // ---- CLI -------------------------------------------------------------

  function summarize(current: Board): string {
    const byParent = groupChildren(current.groups);
    const coverage = current.threadCoverage;
    const failed = current.warnings.some((warning) =>
      warning.startsWith("Scan failed:") ||
      warning.startsWith("No scan roots configured") ||
      warning.startsWith("No primary BB host"),
    );
    const now = Date.now();
    const scanAt = current.lastScanAt;
    const age = scanAt === null ? null : now - Date.parse(scanAt);
    const stale = age !== null && Number.isFinite(age) && age > current.health.refreshMinutes * 60_000;
    const scan = scanAt === null
      ? failed ? "scan: no successful scan (latest attempt failed)" : "scan: never scanned"
      : `scan: ${scanAt} (${relativeTime(scanAt, now)})${stale ? "; stale" : ""}${failed ? "; latest attempt failed" : ""}`;
    const lines = [
      `${scan}${current.scanning ? "; scanning now" : ""}`,
      `mode: ${current.mode}  levels: ${current.depth}`,
      `threads: ${coverage.linked} of ${coverage.threads} linked (environment ${coverage.byTier.environment}, ticket ${coverage.byTier.ticket}, paths ${coverage.byTier.paths}); ${coverage.clustersWithThread} clusters have a thread`,
    ];
    if (current.warnings.length > 0) {
      lines.push(`warnings: ${current.warnings.length}${current.warnings.length > 3 ? " (showing 3)" : ""}`);
      for (const warning of current.warnings.slice(0, 3)) lines.push(`  - ${warning.replace(/\s+/gu, " ").trim().slice(0, 200)}`);
    }
    if (current.groups.length === 0) {
      lines.push(scanAt === null ? "No clusters yet. Run `bb workstreams refresh`." : "No checkouts found in the scanned roots.");
      return lines.join("\n");
    }

    const render = (group: WireGroup, indent: string): void => {
      const flag =
        group.cohesion?.verdict === "mixed"
          ? `  ~mixed${group.cohesion.reason === null ? "" : `: ${group.cohesion.reason}`}`
          : "";
      lines.push(
        `${indent}[${group.level}] ${group.name} (${group.total} checkouts, ${group.repoCount} repos, ${group.staleness}, risk ${group.risk})${flag}`,
        `${indent}  ${group.rollup}`,
      );
      for (const cluster of group.clusters) {
        const unknown = [
          cluster.units.some((unit) => unit.observed?.status === false) ? "git status unavailable" : null,
          cluster.units.some((unit) => unit.observed?.pr === false) ? "GitHub status unavailable" : null,
        ].filter((part): part is string => part !== null);
        lines.push(
          `${indent}  ${cluster.ticket}  ${cluster.lifecycle}  ${cluster.summary}${
            cluster.surfaces.length === 0 ? "" : `  [${cluster.surfaces.join(" ")}]`
          }${cluster.threads.length === 0 ? "" : `  threads:${cluster.threads.length}`}${unknown.length === 0 ? "" : `  [${unknown.join("; ")}]`}`,
        );
      }
      for (const child of byParent.get(group.key) ?? []) render(child, `${indent}  `);
    };

    for (const root of byParent.get(null) ?? []) render(root, "");
    return lines.join("\n");
  }

  const TICKET_KEY = /^[A-Za-z]{2,5}-\d{1,6}$/u;
  function normalizeTicket(raw: string): string {
    const ticket = raw.trim().toUpperCase();
    if (!TICKET_KEY.test(ticket)) {
      throw new PluginCliError(`"${raw}" is not a ticket key.`, {
        code: "invalid_ticket",
        hint: "Use a key like ABC-101. Run `bb workstreams list` to see the keys in use.",
      });
    }
    return ticket;
  }

  bb.cli.register(
    defineCli({
      name: "workstreams",
      summary: "Read the workstream board and name ticket clusters",
      commands: {
        list: cliCommand({
          summary: "List workstreams, their clusters, and each cluster's lifecycle",
          options: { json: { type: "boolean", description: "Emit the full board as JSON" } },
          async run({ options }) {
            const current = await board();
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(current)
                : summarize(current),
            };
          },
        }),
        refresh: cliCommand({
          summary: "Rescan every scan root now and wait for the result",
          async run(_input, ctx) {
            const started = await scan(ctx.signal);
            return started
              ? { exitCode: 0, stdout: summarize(await board()) }
              : {
                  exitCode: 1,
                  stderr:
                    "Scan did not complete. Check `bb workstreams list` warnings and `bb plugin logs workstreams`.",
                };
          },
        }),
        group: cliCommand({
          summary: "Name the workstream a ticket cluster belongs to",
          positionals: [
            { name: "ticket", description: "Ticket key, e.g. ABC-101", required: true },
            {
              name: "name",
              description: "Workstream name (remaining words are joined)",
              required: true,
              variadic: true,
            },
          ],
          async run({ positionals }) {
            const ticket = normalizeTicket(positionals.ticket);
            const name = positionals.name.join(" ").trim();
            if (name === "") {
              throw new PluginCliError("A workstream name is required.", {
                code: "missing_name",
                hint: 'Run `bb workstreams group ABC-101 "Gift card balances"`.',
              });
            }
            const overrides = { ...(await readOverrides()), [ticket]: name };
            await bb.storage.kv.set("overrides", overrides);
            bb.realtime.publish(BOARD_CHANGED, { scanning: false });
            return { exitCode: 0, stdout: `${ticket} → ${name}` };
          },
        }),
        ungroup: cliCommand({
          summary: "Drop a ticket's manual workstream name",
          positionals: [
            { name: "ticket", description: "Ticket key, e.g. ABC-101", required: true },
          ],
          async run({ positionals }) {
            const ticket = normalizeTicket(positionals.ticket);
            const overrides = await readOverrides();
            if (!(ticket in overrides)) {
              return { exitCode: 0, stdout: `${ticket} had no manual workstream.` };
            }
            delete overrides[ticket];
            await bb.storage.kv.set("overrides", overrides);
            bb.realtime.publish(BOARD_CHANGED, { scanning: false });
            return { exitCode: 0, stdout: `${ticket} ungrouped.` };
          },
        }),
      },
    }),
  );

  // ---- background refresh ---------------------------------------------

  bb.background.service("refresh", {
    async start(signal) {
      // Threads link against the last scan's units, so they need not wait for
      // this one; the link is recomputed on every board read regardless.
      void syncThreads();
      while (!signal.aborted) {
        await scan(signal);
        if (signal.aborted) return;
        const { refreshMinutes } = await settings.get();
        // A plain setTimeout would sleep through the stop window and leave the
        // plugin "degraded (service did not stop)" on reload.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, refreshMinutes * 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  bb.log.info("loaded");
}
