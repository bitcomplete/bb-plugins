import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADVANCE_MIGRATIONS } from "./bulk-advance.js";
import { DECK_BATCH_MIGRATION } from "./deck-batch.js";
import { EFFORT_ASSIGNMENT_FROM_MIGRATION, EFFORT_ASSIGNMENT_MIGRATIONS, EFFORT_RULE_MIGRATION } from "./effort-assignments.js";
import { EFFORT_PILE_MIGRATION } from "./effort-piles.js";
import { EFFORT_NOTES_MIGRATION } from "./effort-notes.js";
import { EFFORT_ROSTER_MIGRATIONS, PR_FACTS_MIGRATION } from "./effort-roster-store.js";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";
import { EFFORT_ATTEMPT_MIGRATIONS, EFFORT_DECISION_MIGRATIONS, EFFORT_EXECUTION_MIGRATIONS, EFFORT_INSTRUCTION_MIGRATIONS, EFFORT_JOURNAL_MIGRATIONS } from "./effort-work-store.js";
import { APPROVAL_CONFIRMATION_AUDIT_MIGRATION, APPROVAL_FEEDBACK_MIGRATION } from "./approval-feedback.js";
import { INVENTORY_MIGRATIONS } from "./inventory-store.js";
import { PR_MERGES_MIGRATION, PR_OBSERVATION_CLOSED_MIGRATION, PR_OBSERVATION_ERROR_MIGRATION, PR_OBSERVATIONS_MIGRATION, PR_STATE_SINCE_MIGRATION }
  from "./inventory-store.js";
import { LINEAR_SEED_MIGRATION } from "./linear-seed.js";
import { LINEAR_DETAIL_MIGRATION } from "./linearsync.js";
import { PR_HOLD_MIGRATIONS } from "./pr-hold-store.js";
import { RUNS_MIGRATION } from "./runstore.js";
import { UNASSIGNED_PLACEMENT_MIGRATION } from "./unassigned-placement.js";
import { WORK_CONVERSATION_MIGRATIONS } from "./work-conversation.js";
import plugin from "./server.js";

// The deployed migration prefix must remain byte-for-byte and index-for-index
// stable. A previous plugin load records these statements before a reload.
const deployedMigrations = [
  `CREATE TABLE IF NOT EXISTS units (path TEXT PRIMARY KEY, unit TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS linear_tickets (ticket TEXT PRIMARY KEY, project TEXT, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cluster_decisions (hash TEXT PRIMARY KEY, summary TEXT, label TEXT, fit REAL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_names (member_hash TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `ALTER TABLE effort_names ADD COLUMN level TEXT NOT NULL DEFAULT 'effort'`,
  `ALTER TABLE effort_names ADD COLUMN cohesion TEXT`,
  `ALTER TABLE effort_names ADD COLUMN cohesion_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS group_assignments (level TEXT NOT NULL, member_hash TEXT NOT NULL, label TEXT NOT NULL, fit REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (level, member_hash))`,
  `CREATE TABLE IF NOT EXISTS thread_paths (thread_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, paths TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS unit_transitions (path TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, entered_at INTEGER)`,
  RUNS_MIGRATION,
  LINEAR_DETAIL_MIGRATION,
  `CREATE TABLE IF NOT EXISTS cluster_asks (ticket TEXT PRIMARY KEY, hash TEXT NOT NULL, streak INTEGER NOT NULL, pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pr_linkbacks (url TEXT PRIMARY KEY, ticket TEXT, checked_at INTEGER NOT NULL, final INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dispatch_policy (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, effort_key TEXT)`,
  `CREATE TABLE IF NOT EXISTS dispatch_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, unit_path TEXT NOT NULL, pr_url TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT NOT NULL, thread_id TEXT, started_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatch_active_pr ON dispatch_attempts (pr_url)
    WHERE status IN ('launching', 'running', 'verifying', 'needs-you')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dispatch_active_path ON dispatch_attempts (unit_path)
    WHERE status IN ('launching', 'running', 'verifying', 'needs-you')`,
  ...INVENTORY_MIGRATIONS,
  ...EFFORT_MIGRATIONS,
  `CREATE TABLE IF NOT EXISTS grouping_repairs (ticket TEXT PRIMARY KEY, label TEXT NOT NULL, hash TEXT NOT NULL, evidence TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS grouping_legacy_labels (hash TEXT PRIMARY KEY, label TEXT NOT NULL)`,
  ...ADVANCE_MIGRATIONS,
  ...PR_HOLD_MIGRATIONS,
  `CREATE TABLE IF NOT EXISTS thread_work_intent_ids (thread_id TEXT PRIMARY KEY)`,
];
const latestDeployedMigrations = [
  ...deployedMigrations,
  REPO_CONTROLLER_MIGRATION,
  `CREATE TABLE IF NOT EXISTS thread_pr_link_ids (thread_id TEXT PRIMARY KEY)`,
  APPROVAL_FEEDBACK_MIGRATION,
  UNASSIGNED_PLACEMENT_MIGRATION,
  PR_OBSERVATIONS_MIGRATION,
  ...WORK_CONVERSATION_MIGRATIONS,
];
// Everything the installed build has recorded. New statements append after
// index 34; an insertion or edit anywhere in this prefix fails the next reload.
const pinnedMigrations = [
  ...latestDeployedMigrations,
  `CREATE TABLE IF NOT EXISTS effort_admin_sync (source_id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, actions TEXT NOT NULL)`,
];
const statementHash = (statement: string) => createHash("sha256").update(statement).digest("hex");
const hostOptions = {
  pluginId: "workstreams",
  settings: { scanRoots: "/p" },
  sdk: {
    system: { config: async () => ({ primaryHostId: "host-synthetic" }) as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  },
};

describe("deployed Workstreams database upgrade", () => {
  it("appends effort admin storage after every previously deployed migration", async () => {
    expect(createHash("sha256").update(JSON.stringify(latestDeployedMigrations)).digest("hex"))
      .toBe("2ed0183b4fcf2441ea9b20eb932317905836ad3b54c1db921fbb8fc173a77f82");
    const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" },
      sdk: { system: { config: async () => ({ primaryHostId: "host-synthetic" }) as never },
        threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never,
          events: { list: async () => [] } } } });
    bb.storage.migrate(bb.storage.database(), latestDeployedMigrations);
    const upgraded = await harness.lifecycle.reload(plugin);
    expect(upgraded.bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("effort_admin_sync")).toEqual({ name: "effort_admin_sync" });
    await upgraded.harness.lifecycle.dispose();
  });
  it("reloads the old migration prefix and preserves existing data", async () => {
    expect(createHash("sha256").update(JSON.stringify(deployedMigrations)).digest("hex"))
      .toBe("b51b3353d856547221cd0acf493d59a5b5482bd2a6b42bed6663bc91b4fc0eb6");
    const { bb, harness } = createFakePluginHost({
      pluginId: "workstreams",
      settings: { scanRoots: "/p" },
      sdk: {
        system: { config: async () => ({ primaryHostId: "host-synthetic" }) as never },
        threads: {
          list: async () => [] as never,
          getPluginMetadata: async () => ({}) as never,
          events: { list: async () => [] },
        },
      },
    });
    bb.storage.migrate(bb.storage.database(), deployedMigrations);
    bb.storage.database().prepare("INSERT INTO grouping_repairs (ticket, label, hash, evidence) VALUES (?, ?, ?, ?)")
      .run("TEST-1", "Synthetic group", "hash-1", "{}");

    const upgraded = await harness.lifecycle.reload(plugin);
    const db = upgraded.bb.storage.database();
    expect(db.prepare("SELECT label FROM grouping_repairs WHERE ticket = ?").get("TEST-1"))
      .toEqual({ label: "Synthetic group" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("effort_repo_controllers"))
      .toEqual({ name: "effort_repo_controllers" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("thread_pr_link_ids"))
      .toEqual({ name: "thread_pr_link_ids" });
    await upgraded.harness.lifecycle.dispose();
  });
  it("pins all 35 deployed statements through effort admin sync", () => {
    expect(pinnedMigrations).toHaveLength(35);
    expect(statementHash(JSON.stringify(pinnedMigrations))).toBe("18aa85a49a1a58c9c28261030e7a54c3d21c5fe93eb73ec6daa5bdee23b11ffa");
  });
  it("records the pinned statements at their deployed indexes on a fresh load", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    const recorded = bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id < 35 ORDER BY id").all();
    expect(recorded).toEqual(pinnedMigrations.map((statement, id) => ({ id, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends roster numbering after the pinned prefix", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    const recorded = bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 35 AND 37 ORDER BY id").all();
    expect(recorded).toEqual(EFFORT_ROSTER_MIGRATIONS.map((statement, index) => ({ id: 35 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends PR facts after roster numbering", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 38").all())
      .toEqual([{ id: 38, hash: statementHash(PR_FACTS_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends execution mode and v2 targets after PR facts", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 39 AND 41 ORDER BY id").all())
      .toEqual(EFFORT_EXECUTION_MIGRATIONS.map((statement, index) => ({ id: 39 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends instructions, PR rows, and transitions after execution mode", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 42 AND 46 ORDER BY id").all())
      .toEqual(EFFORT_INSTRUCTION_MIGRATIONS.map((statement, index) => ({ id: 42 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends decisions after instructions", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 47 AND 48 ORDER BY id").all())
      .toEqual(EFFORT_DECISION_MIGRATIONS.map((statement, index) => ({ id: 47 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends attempts and their writer claims after decisions", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 49 AND 53 ORDER BY id").all())
      .toEqual(EFFORT_ATTEMPT_MIGRATIONS.map((statement, index) => ({ id: 49 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends the journal's head column after attempts", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 54 ORDER BY id").all())
      .toEqual(EFFORT_JOURNAL_MIGRATIONS.map((statement, index) => ({ id: 54 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends PR state dates after the journal's head column", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 55 ORDER BY id").all())
      .toEqual([{ id: 55, hash: statementHash(PR_STATE_SINCE_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends PR read failure reasons after PR state dates", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 56 ORDER BY id").all())
      .toEqual([{ id: 56, hash: statementHash(PR_OBSERVATION_ERROR_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends PR read closures after PR read failure reasons", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 57 ORDER BY id").all())
      .toEqual([{ id: 57, hash: statementHash(PR_OBSERVATION_CLOSED_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends effort piles after PR read closures, the last statement the live store applied", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 58 ORDER BY id").all())
      .toEqual([{ id: 58, hash: statementHash(EFFORT_PILE_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends the classification audit after effort piles", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id BETWEEN 59 AND 60 ORDER BY id").all())
      .toEqual(EFFORT_ASSIGNMENT_MIGRATIONS.map((statement, index) => ({ id: 59 + index, hash: statementHash(statement) })));
    await harness.lifecycle.dispose();
  });
  it("appends standing rules after the classification audit", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 61 ORDER BY id").all())
      .toEqual([{ id: 61, hash: statementHash(EFFORT_RULE_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends PR merge sightings after standing rules", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 62 ORDER BY id").all())
      .toEqual([{ id: 62, hash: statementHash(PR_MERGES_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends deck batches after PR merge sightings", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 63 ORDER BY id").all())
      .toEqual([{ id: 63, hash: statementHash(DECK_BATCH_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends Linear seed provenance after deck batches", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 64 ORDER BY id").all())
      .toEqual([{ id: 64, hash: statementHash(LINEAR_SEED_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends the confirmation audit after Linear seed provenance", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 65 ORDER BY id").all())
      .toEqual([{ id: 65, hash: statementHash(APPROVAL_CONFIRMATION_AUDIT_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends where a moved PR came from after the confirmation audit", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 66 ORDER BY id").all())
      .toEqual([{ id: 66, hash: statementHash(EFFORT_ASSIGNMENT_FROM_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  it("appends effort notes after where a moved PR came from", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 67 ORDER BY id").all())
      .toEqual([{ id: 67, hash: statementHash(EFFORT_NOTES_MIGRATION) }]);
    await harness.lifecycle.dispose();
  });
  // A new table only: the live build, rolled back to, never reads it and still reads every row it wrote.
  it("appends batch thread links after effort notes", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    await plugin(bb);
    expect(bb.storage.database().prepare("SELECT id, statement_hash AS hash FROM _bb_migrations WHERE id = 68 ORDER BY id").all())
      .toEqual([{ id: 68, hash: statementHash("CREATE TABLE IF NOT EXISTS pr_threads (pr_url TEXT NOT NULL, thread_id TEXT NOT NULL, batch_id TEXT, linked_at INTEGER NOT NULL, PRIMARY KEY (pr_url, thread_id))") }]);
    await harness.lifecycle.dispose();
  });
  it("appends planning request and cluster caches without changing the deployed prefix", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions); await plugin(bb);
    const db = bb.storage.database();
    expect(db.prepare("SELECT id FROM _bb_migrations WHERE id > 68 ORDER BY id").all()).toEqual([{ id: 69 }, { id: 70 }]);
    db.prepare("INSERT INTO advance_plan_requests (request_id, snapshot, created_at) VALUES (?, ?, ?)").run("request", "{}", 1);
    db.prepare("INSERT INTO advance_plan_clusters (hash, clusters, created_at) VALUES (?, ?, ?)").run("hash", "[]", 1);
    const next = await harness.lifecycle.reload(plugin);
    expect(next.bb.storage.database().prepare("SELECT snapshot FROM advance_plan_requests WHERE request_id = ?").get("request")).toEqual({ snapshot: "{}" });
    await next.harness.lifecycle.dispose();
  });
  it("reloads the pinned prefix without losing established efforts", async () => {
    const { bb, harness } = createFakePluginHost(hostOptions);
    bb.storage.migrate(bb.storage.database(), pinnedMigrations);
    const effort = createEffortStore(bb.storage.database()).establish({ sourceKey: "ticket:ABC-101", name: "Gift cards", goal: "Sell gift cards at checkout",
      projectId: "proj-inkwell", members: { tickets: ["ABC-101"], prUrls: ["https://github.com/inkwell/folio/pull/7"] } });

    const upgraded = await harness.lifecycle.reload(plugin);
    expect(createEffortStore(upgraded.bb.storage.database()).get(effort.id)).toEqual(effort);
    await upgraded.harness.lifecycle.dispose();
  });
});
