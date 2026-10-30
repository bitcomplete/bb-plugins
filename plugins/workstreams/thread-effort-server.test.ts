import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import { parsePrList } from "./gh.js";
import { createEffortPileStore } from "./effort-piles.js";
import { createEffortStore } from "./effort-store.js";
import { createRunStore } from "./runstore.js";
import plugin, { type Board } from "./server.js";
import { threadEffortAssignmentScope, threadEffortMoveScope, type ThreadEffortReady } from "./thread-effort.js";

const model = vi.hoisted(() => vi.fn());
vi.mock("@typesafe-ai/sdk", async (original) => {
  const actual = await original<typeof import("@typesafe-ai/sdk")>();
  return { ...actual, TypeSafeClient: class { systemOne = model; } };
});

const a = "https://github.com/inkwell/folio/pull/42";
const b = "https://github.com/inkwell/folio/pull/43";
const makePr = (number: number, ticket: string) => parsePrList(JSON.stringify([{ number, url: number === 42 ? a : b,
  state: "OPEN", title: `${ticket} Improve manuscript review`, headRefName: `${ticket.toLowerCase()}-review` }]))!.pr;
const units: RawUnit[] = [42, 43].map((number) => ({ path: `/p/folio-${number}`, dirName: `folio-${number}`, repo: "folio",
  githubRepo: "inkwell/folio", branch: number === 42 ? "abc-101-review" : "abc-202-review", dirty: false,
  ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr: makePr(number, number === 42 ? "ABC-101" : "ABC-202"),
  shipped: null, changedPaths: [], observed: { status: true, pr: true } }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); model.mockReset(); });

async function setup(options: { shared?: boolean; ticketless?: boolean; remoteDestination?: boolean; remoteUrlVariant?: boolean; environmentPath?: string | null } = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  let localEnabled = true;
  let inventoryFailed = false;
  let environmentPath = options.environmentPath ?? null;
  let archived = false;
  let metadataGate: Promise<void> | null = null;
  let metadataStarted: (() => void) | null = null;
  let failMetadataWrite = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "proj", name: "Folio", sources: [{ hostId: "host-inkwell", path: "/p" }] }] as never },
    threads: { list: async () => [] as never,
      get: async ({ threadId }: { threadId: string }) => threadId === "thread" ? {
        ...makeThreadResponse({ id: "thread", title: "Improve manuscript review", projectId: "proj", archivedAt: archived ? 100 : null }),
        environment: environmentPath === null ? null : { path: environmentPath },
      } as never : Promise.reject(new Error("missing thread")),
      getPluginMetadata: async ({ threadId }: { threadId: string }) => {
        if (metadataGate) { const gate = metadataGate; metadataGate = null; metadataStarted?.(); await gate; }
        return (metadata.get(threadId) ?? {}) as never;
      },
      updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
        if (failMetadataWrite) { failMetadataWrite = false; throw new Error("Synthetic metadata write failure"); }
        metadata.set(threadId, { ...metadata.get(threadId), ...set }); return metadata.get(threadId) as never;
      },
      events: { list: async () => [] }, interactions: { list: async () => [] as never } },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: localEnabled ? [
      options.shared ? { ...units[0]!, pr: { ...units[0]!.pr!, title: "ABC-101 ABC-202 Improve manuscript review" } } :
        options.ticketless ? { ...units[0]!, path: "/p/plain-checkout", dirName: "plain-checkout", branch: "topic", pr: { ...units[0]!.pr!, title: "Improve manuscript review", headRefName: "topic" } } : units[0]!,
      ...(options.remoteDestination ? [] : [units[1]!]),
    ] : [], warnings: [] };
    if (method === "authoredPrs") {
      if (inventoryFailed) throw new Error("Inventory unavailable");
      const remote = options.remoteDestination ? [44, 45].map((number) => ({ repo: "inkwell/atlas", pr: parsePrList(JSON.stringify([{
        number, url: `https://github.com/inkwell/atlas/pull/${number}${options.remoteUrlVariant && number === 44 ? "/?tab=files" : ""}`, state: "OPEN", title: `ABC-202 Improve atlas review ${number}`,
        headRefName: `abc-202-${number}` }]))!.pr })) : [];
      return { owners: ["inkwell"], entries: remote, discoveryComplete: true, complete: true,
        repositories: options.remoteDestination ? [{ repo: "inkwell/atlas", complete: true }] : [], warnings: [] };
    }
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanup.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const context = async () => await harness.callRpc("thread_effort_context", { threadId: "thread" }) as ThreadEffortReady;
  const board = async () => await harness.callRpc("board_get", null) as Board;
  const db = bb.storage.database();
  return { harness, metadata, context, board, store: createEffortStore(db), db, clearLocal: () => { localEnabled = false; },
    failNextMetadataWrite: () => { failMetadataWrite = true; },
    failInventory: (failed: boolean) => { inventoryFailed = failed; },
    setEnvironmentPath: (path: string | null) => { environmentPath = path; }, archive: () => { archived = true; },
    deferMetadata: () => {
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      metadataGate = new Promise<void>((resolve) => { release = resolve; });
      metadataStarted = started;
      return { entered, release };
    } };
}

it("requires an explicit known PR link, then moves its ticket and PR without spawning a coordinator", async () => {
  const { harness, metadata, context, board } = await setup();
  expect((await context()).sources).toEqual([]);
  expect(await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: "https://github.com/inkwell/folio/pull/99" })).toMatchObject({ ok: false });
  metadata.set("thread", { role: "worker", effortId: "historical", prUrl: b });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(metadata.get("thread")).toMatchObject({ role: "worker", effortId: "historical", prUrl: b, linkedPrUrl: a });
  expect(linked.sources.map((source) => source.id)).toEqual(["ticket:ABC-101", "ticket:ABC-202"]);
  const destination = linked.efforts.find((effort) => effort.key === linked.sources[1]!.effortKey)!;
  const input = { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey: destination.key,
    expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], destination.key) };
  expect(await harness.callRpc("thread_effort_move", { ...input, sourceIds: ["ticket:FORGED"] })).toMatchObject({ ok: false });
  expect(await harness.callRpc("thread_effort_move", input)).toMatchObject({ ok: true });
  const established = (await board()).efforts;
  expect(established).toHaveLength(1);
  expect(established[0]).toMatchObject({ name: destination.name, coordinatorState: "none", coordinatorThreadId: null,
    members: { tickets: ["ABC-101", "ABC-202"], prUrls: [a, b] } });
  expect(await harness.callRpc("thread_effort_move", input)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("rejects a missing thread before resolving or linking work", async () => {
  const { harness } = await setup();
  expect(await harness.callRpc("thread_effort_context", { threadId: "missing" })).toMatchObject({ ok: false });
  expect(await harness.callRpc("thread_effort_link_pr", { threadId: "missing", prUrl: a })).toMatchObject({ ok: false });
});

const createRequestId = "11111111-1111-4111-8111-111111111111";

it("creates an empty effort for the thread and returns the same effort on request retry", async () => {
  const env = await setup();
  env.clearLocal();
  await env.harness.runCli(["refresh"]);
  const preview = await env.context();
  expect(preview.efforts).toEqual([]);
  const input = { threadId: "thread", name: "  Manuscript review  ", requestId: createRequestId,
    expectedScope: threadEffortAssignmentScope(preview, null) };
  const created = await env.harness.callRpc("thread_effort_create", input) as ThreadEffortReady;
  expect(created).toMatchObject({ ok: true, threadEffort: { name: "Manuscript review" } });
  const effort = env.store.source(`thread-created:thread:${createRequestId}`)!;
  expect(effort).toMatchObject({ name: "Manuscript review", projectId: "proj", coordinatorState: "none",
    coordinatorThreadId: null, members: { tickets: [], prUrls: [] } });
  expect(env.metadata.get("thread")).toMatchObject({ workEffortId: effort.id });
  expect(await env.harness.callRpc("thread_effort_create", input)).toMatchObject({ ok: true,
    threadEffort: { key: effort.key } });
  expect(env.store.list().filter((item) => item.id === effort.id)).toHaveLength(1);
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("rejects invalid and duplicate effort names before writing an effort", async () => {
  const env = await setup();
  const preview = await env.context();
  const input = { threadId: "thread", requestId: createRequestId, expectedScope: threadEffortAssignmentScope(preview, null) };
  expect(await env.harness.callRpc("thread_effort_create", { ...input, name: " \t " })).toMatchObject({ ok: false,
    error: expect.stringContaining("1 and 120") });
  expect(await env.harness.callRpc("thread_effort_create", { ...input, name: "x".repeat(121) })).toMatchObject({ ok: false,
    error: expect.stringContaining("1 and 120") });
  const existing = preview.efforts[0]!;
  expect(await env.harness.callRpc("thread_effort_create", { ...input,
    name: `  ${existing.name.toUpperCase().replace(/ /gu, "   ")}  ` })).toMatchObject({ ok: false,
    error: expect.stringContaining("already exists") });
  expect(env.store.source(`thread-created:thread:${createRequestId}`)).toBeNull();
});

it("rejects stale creation and never reapplies an old request after a clear", async () => {
  const env = await setup();
  const preview = await env.context();
  const input = { threadId: "thread", name: "Manuscript review", requestId: createRequestId,
    expectedScope: threadEffortAssignmentScope(preview, null) };
  const oldDestination = preview.efforts[0]!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: oldDestination.key,
    expectedScope: threadEffortAssignmentScope(preview, oldDestination.key) });
  expect(await env.harness.callRpc("thread_effort_create", input)).toMatchObject({ ok: false,
    error: expect.stringContaining("changed") });
  const assigned = await env.context();
  const fresh = { ...input, expectedScope: threadEffortAssignmentScope(assigned, null) };
  const created = await env.harness.callRpc("thread_effort_create", fresh) as ThreadEffortReady;
  expect(created.threadEffort?.name).toBe("Manuscript review");
  expect(await env.harness.callRpc("thread_effort_create", { ...fresh, name: "Another name" })).toMatchObject({ ok: false,
    error: expect.stringContaining("different name") });
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: null,
    expectedScope: threadEffortAssignmentScope(created, null) });
  expect(await env.harness.callRpc("thread_effort_create", fresh)).toMatchObject({ ok: false,
    error: expect.stringContaining("Choose the existing effort") });
  expect((await env.context()).threadEffort).toBeNull();
  expect(env.store.list().filter((item) => item.name === "Manuscript review")).toHaveLength(1);
});

it("keeps a recoverable empty effort when the metadata write fails", async () => {
  const env = await setup();
  const preview = await env.context();
  env.failNextMetadataWrite();
  const input = { threadId: "thread", name: "Manuscript review", requestId: createRequestId,
    expectedScope: threadEffortAssignmentScope(preview, null) };
  expect(await env.harness.callRpc("thread_effort_create", input)).toMatchObject({ ok: false,
    error: expect.stringContaining("Choose it from the picker") });
  expect(env.store.source(`thread-created:thread:${createRequestId}`)?.members).toEqual({ tickets: [], prUrls: [] });
  expect(await env.harness.callRpc("thread_effort_create", input)).toMatchObject({ ok: false,
    error: expect.stringContaining("Choose the existing effort") });
  expect((await env.context()).threadEffort).toBeNull();
});

it("inherits a confirmed checkout PR into a new effort without taking another effort's work", async () => {
  const env = await setup({ environmentPath: "/p/folio-42" });
  const preview = await env.context();
  const created = await env.harness.callRpc("thread_effort_create", { threadId: "thread", name: "Manuscript review",
    requestId: createRequestId, expectedScope: threadEffortAssignmentScope(preview, null) }) as ThreadEffortReady;
  const effort = env.store.source(created.threadEffort!.key)!;
  expect(env.store.owner("prUrl", a)?.id).toBe(effort.id);
  expect(env.store.owner("ticket", "ABC-101")?.id).toBe(effort.id);
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);

  const other = env.store.establish({ sourceKey: "other-owner", name: "Other manuscript work", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: ["ABC-202"], prUrls: [b] } });
  env.setEnvironmentPath("/p/folio-43");
  await env.harness.runCli(["refresh"]);
  expect(env.store.owner("prUrl", b)?.id).toBe(other.id);
  expect(env.store.owner("ticket", "ABC-202")?.id).toBe(other.id);
  expect(env.store.get(effort.id)?.members.prUrls).toEqual([a]);
});

it("calls Jev only for explicit suggestions and leaves manual creation available on missing key or failure", async () => {
  const env = await setup();
  const noKey = await env.harness.callRpc("thread_effort_suggest", { threadId: "thread" });
  expect(noKey).toMatchObject({ ok: true, suggestions: [], notice: expect.stringContaining("API key") });
  expect(model).not.toHaveBeenCalled();
  await env.harness.behavior.setSettings({ typesafeApiKey: "synthetic-test-value" });
  env.store.establish({ sourceKey: "existing-editorial", name: "Editorial review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  expect((await env.context()).efforts.length).toBeGreaterThan(0);
  await env.board();
  expect(model).not.toHaveBeenCalled();
  model.mockImplementation(async ({ questions }: { questions: Record<string, unknown> }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key) => [key, key === "name"
      ? { type: "choice", choice: "n0", confidence: 0.9 }
      : { type: "score", score: key === "e0" ? 4 : 0, confidence: 0.9 }])),
    usage: { input_tokens: 20, output_tokens: 5 },
  }));
  const beforeSuggestions = env.store.list();
  const beforeMetadata = env.metadata.get("thread");
  const result = await env.harness.callRpc("thread_effort_suggest", { threadId: "thread" });
  expect(result).toMatchObject({ ok: true, notice: null, suggestions: [{ key: expect.any(String), reason: expect.any(String) }] });
  expect(model).toHaveBeenCalledTimes(1);
  expect(env.store.list()).toEqual(beforeSuggestions);
  expect(env.metadata.get("thread")).toEqual(beforeMetadata);
  model.mockRejectedValueOnce(new Error("Synthetic Jev outage"));
  expect(await env.harness.callRpc("thread_effort_suggest", { threadId: "thread" })).toMatchObject({ ok: true,
    suggestions: [], notice: expect.stringContaining("Synthetic Jev outage") });
  const preview = await env.context();
  expect(await env.harness.callRpc("thread_effort_create", { threadId: "thread", name: "Manual manuscript review",
    requestId: createRequestId, expectedScope: threadEffortAssignmentScope(preview, null) })).toMatchObject({ ok: true,
    threadEffort: { name: "Manual manuscript review" } });
});

it("assigns an empty thread, then inherits only a PR in its exact scanned checkout", async () => {
  const env = await setup();
  env.metadata.set("thread", { role: "worker", effortId: "historical", ticket: "ABC-101" });
  const preview = await env.context();
  expect(preview.sources).toEqual([]);
  const destinationKey = (await env.board()).groups.find((group) => group.level === "effort" &&
    group.clusters.some((cluster) => cluster.units.some((unit) => unit.ticket === "ABC-202")))!.key;
  const destination = preview.efforts.find((effort) => effort.key === destinationKey)!;
  const assigned = await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: destination.key,
    expectedScope: threadEffortAssignmentScope(preview, destination.key) }) as ThreadEffortReady;
  expect(assigned.threadEffort?.name).toBe(destination.name);
  expect(env.metadata.get("thread")).toMatchObject({ role: "worker", effortId: "historical", ticket: "ABC-101",
    workEffortId: env.store.source(destination.key)!.id });
  expect(env.store.owner("prUrl", a)).toBeNull();
  env.setEnvironmentPath("/p/folio-42/child");
  await env.harness.runCli(["refresh"]);
  expect(env.store.owner("prUrl", a)).toBeNull();
  env.setEnvironmentPath("/p/folio-42");
  await env.harness.runCli(["refresh"]);
  await vi.waitFor(() => expect(env.store.owner("prUrl", a)?.id).toBe(env.store.source(destination.key)!.id));
  expect(env.store.owner("ticket", "ABC-101")?.id).toBe(env.store.source(destination.key)!.id);
  const updated = await env.context();
  expect(await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: null,
    expectedScope: threadEffortAssignmentScope(updated, null) })).toMatchObject({ ok: true, threadEffort: null });
  expect(env.store.owner("prUrl", a)?.id).toBe(env.store.source(destination.key)!.id);
  expect(env.metadata.get("thread")).toMatchObject({ role: "worker", effortId: "historical", workEffortId: null });
  expect(env.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it("inherits multiple recorded PRs, including completed action runs", async () => {
  const env = await setup();
  const runs = createRunStore(env.db);
  for (const [url, ticket, path, number] of [[a, "ABC-101", "/p/folio-42", 42], [b, "ABC-202", "/p/folio-43", 43]] as const) {
    const id = runs.begin({ action: "review", path, ticket, prUrl: url, prNumber: number, mode: "continue", threadId: "thread" });
    runs.settle(id, true, "Done");
  }
  const preview = await env.context();
  const destinationKey = (await env.board()).groups.find((group) => group.level === "effort" &&
    group.clusters.some((cluster) => cluster.units.some((unit) => unit.ticket === "ABC-101")))!.key;
  const destination = preview.efforts.find((effort) => effort.key === destinationKey)!;
  expect(await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: destination.key,
    expectedScope: threadEffortAssignmentScope(preview, destination.key) })).toMatchObject({ ok: true });
  const effort = env.store.source(destination.key)!;
  expect(env.store.owner("prUrl", a)?.id).toBe(effort.id);
  expect(env.store.owner("prUrl", b)?.id).toBe(effort.id);
  expect(env.store.owner("ticket", "ABC-202")?.id).toBe(effort.id);
  await env.harness.runCli(["refresh"]);
  expect(env.store.get(effort.id)?.members.prUrls).toEqual([a, b]);
});

it("preserves an explicit owner and reports the blocked linked PR", async () => {
  const env = await setup();
  const preview = await env.context();
  const target = preview.efforts.find((effort) => effort.key === (env.store.owner("ticket", "ABC-202")?.key ??
    preview.efforts.find((effort) => effort.scope.includes("ABC-202"))?.key))!;
  expect(await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: target.key,
    expectedScope: threadEffortAssignmentScope(preview, target.key) })).toMatchObject({ ok: true });
  const other = env.store.establish({ sourceKey: "other", name: "Other effort", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [a] } });
  env.setEnvironmentPath("/p/folio-42");
  await env.harness.runCli(["refresh"]);
  await vi.waitFor(async () => expect((await env.context()).inheritanceNotice).toContain("another effort"));
  expect(env.store.owner("ticket", "ABC-101")?.id).toBe(other.id);
  expect(env.store.owner("prUrl", a)?.id).toBe(other.id);
});

it("does not claim after an archive event races a metadata read", async () => {
  const env = await setup();
  const preview = await env.context();
  const target = preview.efforts.find((effort) => effort.scope.includes("ABC-202"))!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: target.key,
    expectedScope: threadEffortAssignmentScope(preview, target.key) });
  env.setEnvironmentPath("/p/folio-42");
  const gate = env.deferMetadata();
  await env.harness.runCli(["refresh"]);
  await gate.entered;
  env.archive();
  await env.harness.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thread", archivedAt: 100 }) });
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.store.owner("prUrl", a)).toBeNull();
});

it("does not claim a PR from a checkout snapshot replaced during metadata lookup", async () => {
  const env = await setup();
  const preview = await env.context();
  const target = preview.efforts.find((effort) => effort.scope.includes("ABC-202"))!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: target.key,
    expectedScope: threadEffortAssignmentScope(preview, target.key) });
  env.setEnvironmentPath("/p/folio-42");
  const gate = env.deferMetadata();
  await env.harness.runCli(["refresh"]);
  await gate.entered;
  env.clearLocal();
  await env.harness.runCli(["refresh"]);
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.store.owner("prUrl", a)).toBeNull();
});

it("does not claim work after the thread intent is cleared during a metadata read", async () => {
  const env = await setup();
  const preview = await env.context();
  const target = preview.efforts.find((effort) => effort.scope.includes("ABC-202"))!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: target.key,
    expectedScope: threadEffortAssignmentScope(preview, target.key) });
  env.setEnvironmentPath("/p/folio-42");
  const gate = env.deferMetadata();
  await env.harness.runCli(["refresh"]);
  await gate.entered;
  const assigned = await env.context();
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: null,
    expectedScope: threadEffortAssignmentScope(assigned, null) });
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.store.owner("prUrl", a)).toBeNull();
});

it("holds background inheritance while a thread effort change reads its context", async () => {
  const env = await setup();
  const first = await env.context();
  const oldDestination = first.efforts.find((effort) => effort.scope.includes("ABC-202"))!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: oldDestination.key,
    expectedScope: threadEffortAssignmentScope(first, oldDestination.key) });
  const newDestination = env.store.establish({ sourceKey: "future", name: "Future effort", goal: "", projectId: "",
    coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  const preview = await env.context();
  env.setEnvironmentPath("/p/folio-42");
  const gate = env.deferMetadata();
  const changing = env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: newDestination.key,
    expectedScope: threadEffortAssignmentScope(preview, newDestination.key) });
  await gate.entered;
  await env.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thread", status: "idle" }), lastAssistantText: "Done" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.store.owner("prUrl", a)).toBeNull();
  gate.release();
  expect(await changing).toMatchObject({ ok: true, threadEffort: { key: newDestination.key } });
  expect(env.store.owner("prUrl", a)?.id).toBe(newDestination.id);
});

it("waits for fresh PR evidence before inheriting an inventory-only link", async () => {
  const env = await setup({ remoteDestination: true });
  const remote = "https://github.com/inkwell/atlas/pull/44";
  env.metadata.set("thread", { linkedPrUrl: remote });
  env.failInventory(true);
  await env.harness.runCli(["refresh"]);
  const preview = await env.context();
  const target = preview.efforts.find((effort) => effort.scope.includes("ABC-101"))!;
  await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: target.key,
    expectedScope: threadEffortAssignmentScope(preview, target.key) });
  expect(env.store.owner("prUrl", remote)).toBeNull();
  env.failInventory(false);
  await env.harness.runCli(["refresh"]);
  await vi.waitFor(() => expect(env.store.owner("prUrl", remote)?.id).toBe(env.store.source(target.key)!.id));
});

it("resolves a prior Workstreams run's PR without reading thread transcripts", async () => {
  const { context, db } = await setup();
  const runs = createRunStore(db);
  const id = runs.begin({ action: "review", path: "/p/folio-42", ticket: "ABC-101", prUrl: a, prNumber: 42,
    mode: "continue", threadId: "thread" });
  runs.settle(id, true, "Review complete");
  expect(runs.openIn("thread")).toEqual([]);
  expect((await context()).sources.map((source) => source.id)).toContain("ticket:ABC-101");
});

it("links a copied PR URL to its known ticket and checkout path", async () => {
  const { harness } = await setup();
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a.toUpperCase() + "/?tab=files" }) as ThreadEffortReady;
  expect(linked.sources).toMatchObject([{ id: "ticket:ABC-101", prUrls: [a], checkoutPaths: ["/p/folio-42"] }]);
});

it("offers a shared PR's other ticket and refuses to move only one side", async () => {
  const { harness } = await setup({ shared: true });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(linked.sources.map((source) => source.id)).toEqual(["ticket:ABC-101", "ticket:ABC-202"]);
  const target = linked.efforts.find((effort) => effort.key === linked.sources[1]!.effortKey)!;
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: target.key, expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], target.key) }))
    .toMatchObject({ ok: false, error: expect.stringContaining("both tickets") });
});

it("names what else a move of a linked PR takes, beyond the PR and its tickets, so the popover can list it first", async () => {
  const env = await setup({ shared: true });
  env.store.establish({ sourceKey: "atlas", name: "Atlas launch", goal: "", projectId: "proj", coordinatorState: "none",
    members: { tickets: ["ABC-202"], prUrls: [b], checkoutPaths: ["/p/folio-43"] } });
  const manuscripts = env.store.establish({ sourceKey: "manuscripts", name: "Manuscripts", goal: "", projectId: "proj", coordinatorState: "none",
    members: { tickets: [], prUrls: [] } });
  env.metadata.set("thread", { linkedPrUrl: a, workEffortId: manuscripts.id });
  const { picker } = await env.harness.callRpc("thread_effort_context", { threadId: "thread", seen: {} }) as ThreadEffortReady;
  // #42 names ABC-101 and ABC-202, so its move takes ABC-202's other PR and the checkout Atlas launch has.
  expect(picker!.linked.map((pr) => [pr.ref, pr.effortName, pr.sourceIds, pr.also]))
    .toEqual([["folio #42", "Atlas launch", ["ticket:ABC-101", "ticket:ABC-202"], ["folio #43", "1 checkout"]]]);
});

it("keeps a ticketless checkout as a standalone PR source", async () => {
  const { harness, board } = await setup({ ticketless: true });
  const linked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(linked.sources).toMatchObject([{ id: `pr:${a}`, kind: "pr", ticket: null, prUrls: [a] }]);
  const destination = linked.efforts.find((effort) => effort.name.includes("ABC-202"))!;
  expect(destination).toBeDefined();
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: [`pr:${a}`], destinationKey: destination.key,
    expectedScope: threadEffortMoveScope(linked, [`pr:${a}`], destination.key) })).toMatchObject({ ok: true });
  expect((await board()).efforts[0]?.members).toEqual({ tickets: ["ABC-202"], prUrls: [a, b] });
});

it("shows a remote-only ticket's inferred effort before any explicit ownership", async () => {
  const { harness } = await setup({ remoteDestination: true });
  const preview = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: "https://github.com/inkwell/atlas/pull/44" }) as ThreadEffortReady;
  expect(preview.sources).toMatchObject([{ id: "ticket:ABC-202", effortKey: "ticket:ABC-202", explicit: false }]);
  expect(preview.sources[0]?.effortName).toBeTruthy();
});

it("assigns a copied remote PR URL to its inferred ticket cohort on the board", async () => {
  const { board } = await setup({ remoteDestination: true, remoteUrlVariant: true });
  const current = await board();
  expect(current.prInventory.entries.filter((entry) => entry.repo === "inkwell/atlas")).toMatchObject([
    { effortKey: "ticket:ABC-202" }, { effortKey: "ticket:ABC-202" },
  ]);
  expect(current.groups.find((group) => group.key === "ticket:ABC-202")).toMatchObject({ total: 2, lifecycle: "awaiting-review" });
});

it("pins an unowned PR when its ticket already belongs to the destination", async () => {
  const { harness, context, store } = await setup();
  const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: ticketOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: ticketOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], ticketOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("prUrl", a)?.id).toBe(ticketOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

it("moves an explicitly owned checkout path with its thread-selected PR cohort", async () => {
  const { harness, context, store } = await setup();
  const previous = store.establish({ sourceKey: "path-owner", name: "Draft review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [], checkoutPaths: ["/p/folio-42"] } });
  const destination = store.establish({ sourceKey: "target", name: "Editorial review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]?.scope).toContain(previous.key);
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: destination.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], destination.key) }))
    .toMatchObject({ ok: true });
  expect(store.owner("checkoutPath", "/p/folio-42")?.id).toBe(destination.id);
  expect(store.owner("prUrl", a)?.id).toBe(destination.id);
  expect(store.get(previous.id)?.members.checkoutPaths).toBeUndefined();
});

it("does not inherit a PR into another effort when its checkout path has an explicit owner", async () => {
  const { harness, context, store } = await setup({ environmentPath: "/p/folio-42" });
  const owner = store.establish({ sourceKey: "path-owner", name: "Draft review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [], checkoutPaths: ["/p/folio-42"] } });
  const other = store.establish({ sourceKey: "other", name: "Other review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  const preview = await context();
  expect(await harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: other.key,
    expectedScope: threadEffortAssignmentScope(preview, other.key) })).toMatchObject({ ok: true });
  expect(store.owner("checkoutPath", "/p/folio-42")?.id).toBe(owner.id);
  expect(store.owner("prUrl", a)).toBeNull();
  expect(store.owner("ticket", "ABC-101")).toBeNull();
});

it("keeps existing path membership when thread intent claims an unrelated PR", async () => {
  const { harness, context, store } = await setup({ environmentPath: "/p/folio-42" });
  const destination = store.establish({ sourceKey: "path-owner", name: "Editorial review", goal: "", projectId: "proj",
    coordinatorState: "none", members: { tickets: [], prUrls: [], checkoutPaths: ["/p/folio-43"] } });
  const preview = await context();
  expect(await harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: destination.key,
    expectedScope: threadEffortAssignmentScope(preview, destination.key) })).toMatchObject({ ok: true });
  expect(store.get(destination.id)?.members.checkoutPaths).toEqual(["/p/folio-43"]);
  expect(store.owner("prUrl", a)?.id).toBe(destination.id);
});

it("reconciles a ticket owner and a different PR owner into the selected effort", async () => {
  const { harness, context, store } = await setup();
  const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: ["ABC-101"], prUrls: [] } });
  store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: [], prUrls: [a] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: ticketOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: ticketOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], ticketOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("prUrl", a)?.id).toBe(ticketOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

it("pins an unowned ticket beside its already owned PR", async () => {
  const { harness, context, store } = await setup();
  const prOwner = store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
    members: { tickets: [], prUrls: [a] } });
  await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
  const preview = await context();
  expect(preview.sources[0]).toMatchObject({ effortKey: prOwner.key, explicit: false });
  expect(await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"],
    destinationKey: prOwner.key, expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], prOwner.key) })).toMatchObject({ ok: true });
  expect(store.owner("ticket", "ABC-101")?.id).toBe(prOwner.id);
  expect((await context()).sources[0]?.explicit).toBe(true);
});

describe("Undo for a thread's effort change", () => {
  const establish = (env: Awaited<ReturnType<typeof setup>>, sourceKey: string, name: string, members: { tickets: string[]; prUrls: string[]; checkoutPaths?: string[] } =
    { tickets: [], prUrls: [] }) => env.store.establish({ sourceKey, name, goal: "", projectId: "proj", coordinatorState: "none", members });
  const pick = async (env: Awaited<ReturnType<typeof setup>>, destinationKey: string | null) => {
    const context = await env.context();
    return await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey,
      expectedScope: threadEffortAssignmentScope(context, destinationKey) }) as ThreadEffortReady;
  };
  const undo = (env: Awaited<ReturnType<typeof setup>>, undoId: string | undefined) => env.harness.callRpc("thread_effort_undo", { threadId: "thread", undoId: undoId! });

  it("puts the thread's effort back and lets go the work the pick brought in", async () => {
    const env = await setup({ environmentPath: "/p/folio-42" });
    const editorial = establish(env, "editorial", "Editorial review");
    const picked = await pick(env, editorial.key);
    expect([env.store.owner("prUrl", a)?.id, env.store.owner("ticket", "ABC-101")?.id]).toEqual([editorial.id, editorial.id]);
    expect(await undo(env, picked.undoId)).toMatchObject({ ok: true, threadEffort: null });
    expect(env.metadata.get("thread")).toMatchObject({ workEffortId: null });
    expect([env.store.owner("prUrl", a), env.store.owner("ticket", "ABC-101")]).toEqual([null, null]);
    // The thread has no effort again, so the next pass brings nothing back in, and the Undo is spent.
    await env.harness.runCli(["refresh"]);
    expect(env.store.owner("prUrl", a)).toBeNull();
    expect(await undo(env, picked.undoId)).toEqual({ ok: false, error: "Undo no longer applies." });
  });

  it("takes back Remove from effort without moving any work", async () => {
    const env = await setup({ environmentPath: "/p/folio-42" });
    const editorial = establish(env, "editorial", "Editorial review");
    await pick(env, editorial.key);
    const removed = await pick(env, null);
    expect(removed.threadEffort).toBeNull();
    expect(env.store.owner("prUrl", a)?.id).toBe(editorial.id);
    expect(await undo(env, removed.undoId)).toMatchObject({ ok: true, threadEffort: { key: editorial.key } });
    expect(env.store.owner("prUrl", a)?.id).toBe(editorial.id);
  });

  it("removes an effort the thread created, once the work it brought in is let go", async () => {
    const env = await setup({ environmentPath: "/p/folio-42" });
    const preview = await env.context();
    const created = await env.harness.callRpc("thread_effort_create", { threadId: "thread", name: "Manuscript review", requestId: createRequestId,
      expectedScope: threadEffortAssignmentScope(preview, null) }) as ThreadEffortReady;
    const effort = env.store.source(created.threadEffort!.key)!;
    expect(env.store.owner("prUrl", a)?.id).toBe(effort.id);
    expect(await undo(env, created.undoId)).toMatchObject({ ok: true, threadEffort: null });
    expect(env.store.get(effort.id)).toBeNull();
    expect(env.store.owner("prUrl", a)).toBeNull();
  });

  it("refuses, changing nothing, once the work moved or a later change replaced the Undo, and never lets go work another effort took", async () => {
    const env = await setup({ environmentPath: "/p/folio-42" });
    const editorial = establish(env, "editorial", "Editorial review"), other = establish(env, "other", "Other review");
    const first = await pick(env, editorial.key);
    env.store.transfer(other.key, { tickets: ["ABC-101"], prUrls: [a] });
    expect(await undo(env, first.undoId)).toEqual({ ok: false, error: "This work moved since, so Undo no longer applies." });
    expect(env.metadata.get("thread")?.workEffortId).toBe(editorial.id);
    expect(env.store.owner("prUrl", a)?.id).toBe(other.id);
    const second = await pick(env, other.key);
    expect(await undo(env, first.undoId)).toEqual({ ok: false, error: "Undo no longer applies." });
    // The second pick brought nothing in, since Other review already had #42: its Undo only puts the thread back.
    expect(await undo(env, second.undoId)).toMatchObject({ ok: true, threadEffort: { key: editorial.key } });
    expect(env.store.owner("prUrl", a)?.id).toBe(other.id);
  });

  it("refuses once the thread's effort changed some other way", async () => {
    const env = await setup();
    const editorial = establish(env, "editorial", "Editorial review");
    const picked = await pick(env, editorial.key);
    env.metadata.set("thread", { ...env.metadata.get("thread"), workEffortId: null });
    expect(await undo(env, picked.undoId)).toEqual({ ok: false, error: "This thread's effort changed since, so Undo no longer applies." });
  });

  it("puts each piece of a move back with the effort it came from", async () => {
    const { harness, context, store } = await setup();
    const ticketOwner = store.establish({ sourceKey: "ticket-owner", name: "Editorial", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: ["ABC-101"], prUrls: [] } });
    const prOwner = store.establish({ sourceKey: "pr-owner", name: "Review", goal: "", projectId: "", coordinatorState: "none",
      members: { tickets: [], prUrls: [a], checkoutPaths: ["/p/folio-42"] } });
    const destination = store.establish({ sourceKey: "target", name: "Manuscripts", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
    const preview = await context();
    const moved = await harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey: destination.key,
      expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], destination.key) }) as ThreadEffortReady;
    expect([store.owner("ticket", "ABC-101")?.id, store.owner("prUrl", a)?.id, store.owner("checkoutPath", "/p/folio-42")?.id])
      .toEqual([destination.id, destination.id, destination.id]);
    expect(await harness.callRpc("thread_effort_undo", { threadId: "thread", undoId: moved.undoId! })).toMatchObject({ ok: true });
    expect([store.owner("ticket", "ABC-101")?.id, store.owner("prUrl", a)?.id, store.owner("checkoutPath", "/p/folio-42")?.id])
      .toEqual([ticketOwner.id, prOwner.id, prOwner.id]);
    expect(store.get(destination.id)?.members).toMatchObject({ tickets: [], prUrls: [] });
  });

  const moveHere = async (env: Awaited<ReturnType<typeof setup>>, destinationKey: string) => {
    await env.harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
    const preview = await env.context();
    return await env.harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey,
      expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], destinationKey) }) as ThreadEffortReady;
  };

  it("refuses a move's Undo once another effort took the moved work, and leaves it there", async () => {
    const env = await setup();
    establish(env, "review", "Review", { tickets: ["ABC-101"], prUrls: [a] });
    const manuscripts = establish(env, "manuscripts", "Manuscripts"), other = establish(env, "other", "Other review");
    const moved = await moveHere(env, manuscripts.key);
    env.store.transfer(other.key, { tickets: ["ABC-101"], prUrls: [a] });
    expect(await undo(env, moved.undoId)).toEqual({ ok: false, error: "This work moved since, so Undo no longer applies." });
    expect([env.store.owner("ticket", "ABC-101")?.id, env.store.owner("prUrl", a)?.id]).toEqual([other.id, other.id]);
  });

  it("refuses a move's Undo once the effort the work came from is archived", async () => {
    const env = await setup();
    const review = establish(env, "review", "Review", { tickets: ["ABC-101"], prUrls: [a] }), manuscripts = establish(env, "manuscripts", "Manuscripts");
    const moved = await moveHere(env, manuscripts.key);
    env.store.setArchived(review.id, true);
    expect(await undo(env, moved.undoId)).toEqual({ ok: false, error: "An effort this work came from changed, so Undo no longer applies." });
    expect(env.store.owner("prUrl", a)?.id).toBe(manuscripts.id);
  });

  it("keeps a forward change's guard: nothing goes back into a done effort", async () => {
    const env = await setup();
    const review = establish(env, "review", "Review", { tickets: ["ABC-101"], prUrls: [a] }), manuscripts = establish(env, "manuscripts", "Manuscripts");
    const moved = await moveHere(env, manuscripts.key);
    createEffortPileStore(env.db).move(review, "complete");
    expect(await undo(env, moved.undoId)).toEqual({ ok: false, error: "An effort this goes back to is done, so Undo no longer applies." });
    expect(env.store.owner("prUrl", a)?.id).toBe(manuscripts.id);
    // Undoing Remove would put the thread back in the effort it left, which is done now.
    const picked = await pick(env, manuscripts.key);
    expect(picked.threadEffort?.key).toBe(manuscripts.key);
    const removed = await pick(env, null);
    createEffortPileStore(env.db).move(manuscripts, "complete");
    expect(await undo(env, removed.undoId)).toEqual({ ok: false, error: "An effort this goes back to is done, so Undo no longer applies." });
    expect(env.metadata.get("thread")?.workEffortId).toBeNull();
  });

  it("tells an open deck at once when a pick or a move changes what its cards hold", async () => {
    const env = await setup({ environmentPath: "/p/folio-42" });
    const editorial = establish(env, "editorial", "Editorial review"), manuscripts = establish(env, "manuscripts", "Manuscripts");
    const heard = () => env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "deck-changed").length;
    let before = heard();
    await pick(env, editorial.key);
    expect(heard()).toBeGreaterThan(before);
    const preview = await env.context();
    before = heard();
    await env.harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey: manuscripts.key,
      expectedScope: threadEffortMoveScope(preview, ["ticket:ABC-101"], manuscripts.key) });
    expect(env.store.owner("prUrl", a)?.id).toBe(manuscripts.id);
    expect(heard()).toBeGreaterThan(before);
  });

  it("puts the thread's previous linked PR back", async () => {
    const { harness, metadata } = await setup();
    await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a });
    const relinked = await harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: b }) as ThreadEffortReady;
    expect(relinked.linkedPrUrl).toBe(b);
    expect(await harness.callRpc("thread_effort_undo", { threadId: "thread", undoId: relinked.undoId! })).toMatchObject({ ok: true, linkedPrUrl: a });
    expect(metadata.get("thread")?.linkedPrUrl).toBe(a);
  });
});

it("refuses to put a thread or its linked work in a done effort", async () => {
  const env = await setup();
  const done = env.store.establish({ sourceKey: "done", name: "Store hours", goal: "", projectId: "proj", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
  createEffortPileStore(env.db).move(done, "complete");
  const preview = await env.context();
  expect(await env.harness.callRpc("thread_effort_set", { threadId: "thread", destinationKey: done.key,
    expectedScope: threadEffortAssignmentScope(preview, done.key) })).toEqual({ ok: false, error: "Reopen this effort first." });
  const linked = await env.harness.callRpc("thread_effort_link_pr", { threadId: "thread", prUrl: a }) as ThreadEffortReady;
  expect(await env.harness.callRpc("thread_effort_move", { threadId: "thread", sourceIds: ["ticket:ABC-101"], destinationKey: done.key,
    expectedScope: threadEffortMoveScope(linked, ["ticket:ABC-101"], done.key) })).toEqual({ ok: false, error: "Reopen this effort first." });
  expect(env.metadata.get("thread")?.workEffortId).toBeUndefined();
  expect(env.store.owner("prUrl", a)).toBeNull();
});
