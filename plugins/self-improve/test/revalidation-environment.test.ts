import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { revalidationObservationGaps, createRevalidationEnvironmentObserver, observedRevalidationEnvironmentDigest, validateObservedRevalidationEnvironment, type RevalidationEnvironmentSdk } from "../src/revalidation-environment.js";
import { revalidationEnvironmentSchema, type RevalidationEnvironment } from "../src/revalidation-contract.js";
import { stableJson } from "../src/domain/shared.js";
import { MIGRATIONS, Store } from "../src/store.js";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const environment: RevalidationEnvironment = { declaredNonsecret: true, dependencies: [{ kind: "plugin", name: "selected-plugin", version: "declared-only", setup: "Enable it" }, { kind: "skill", name: "selected-skill", version: "declared-only", setup: "Install it" }], configuration: [], untested: [], execution: { projectId: "project", environmentId: "environment", providerId: "fixture", model: "model", permissionMode: "accept-edits" } };
function fixture() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db); let now = 1000;
  const state = { environment: { id: "environment", projectId: "project", status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" }, path: "/unrecorded/workspace" },
    plugins: [{ id: "selected-plugin", version: "1.2.3", enabled: true, status: "running", source: "unrecorded-source" }, { id: "other-plugin", version: "9", enabled: false, status: "disabled", source: "other-source" }],
    files: ["scripts/check.ts", "SKILL.md"], content: "Fixture skill instructions", revision: "revision-1", version: "0.49.0" };
  const methods = { environments: { get: vi.fn(async () => state.environment) }, system: { version: vi.fn(async () => ({ currentVersion: state.version, upgradeCommand: "unrecorded-command" })) },
    plugins: { list: vi.fn(async () => ({ plugins: state.plugins })) }, skills: { list: vi.fn(async () => ({ skills: [{ id: "selected-skill", name: "Skill title", filePath: "/unrecorded/SKILL.md" }] })),
      listFiles: vi.fn(async () => ({ files: state.files, truncated: false })), getContent: vi.fn(async () => ({ content: state.content, revision: state.revision })) } };
  const options = { store, sdk: methods as unknown as RevalidationEnvironmentSdk, redact: (value: string) => value, now: () => now };
  return { store, state, methods, options, observer: createRevalidationEnvironmentObserver(options), advance: () => { now += 1000; } };
}
it("records selected supported facts only and makes declared versions distinct from observed ones", async () => {
  const f = fixture(), result = await f.observer.observe(environment);
  expect(result.environment).toEqual({ id: "environment", projectId: "project", status: "ready", hostLifecycle: "active", phase: "active" });
  expect(result.bbVersion).toBe("0.49.0"); expect(result.plugins).toHaveLength(1); expect(result.plugins[0]).toMatchObject({ id: "selected-plugin", version: "1.2.3", presence: "present", codeDigest: null });
  expect(result.skills[0]).toMatchObject({ id: "selected-skill", complete: true, files: [{ path: "SKILL.md", revision: "revision-1" }, { path: "scripts/check.ts", revision: "revision-1" }] });
  expect(result.skills[0]!.manifestDigest).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result)).not.toContain("unrecorded"); expect(JSON.stringify(result)).not.toContain("Fixture skill instructions");
  expect(f.methods.skills.getContent).toHaveBeenCalledWith(expect.objectContaining({ skillId: "selected-skill", path: "SKILL.md", projectId: "project", environmentId: "environment" }));
  expect(result.unknowns).toEqual(expect.arrayContaining(["provider-context-not-observed", "hidden-configuration-not-observed", "snapshot-is-not-an-atomic-lock", "plugin-code-not-observed"]));
  expect(result.declaredEnvironmentDigest).toBe(createHash("sha256").update(stableJson(revalidationEnvironmentSchema.parse(environment))).digest("hex"));
});
it("preserves immutable snapshots with capture times separate from stable content digest", async () => {
  const f = fixture(); const first = await f.observer.observe(environment); f.advance(); f.state.files.reverse(); f.state.plugins.reverse();
  const second = await f.observer.verify(environment, first.digest);
  expect(second.digest).toBe(first.digest); expect(second.capturedAtMs).not.toBe(first.capturedAtMs);
  expect(f.store.list("revalidation-observed-environments")).toEqual([first, second]);
  expect(createRevalidationEnvironmentObserver(f.options).resolve(environment)).toEqual(second);
  f.state.plugins.find(item => item.id === "other-plugin")!.version = "unselected-change";
  expect((await f.observer.observe(environment)).digest).toBe(first.digest);
});
it.each(["project", "status", "host", "phase"])("requires exact ready/active environment binding for %s", async field => {
  const f = fixture(); if (field === "project") f.state.environment.projectId = "other"; if (field === "status") f.state.environment.status = "provisioning";
  if (field === "host") f.state.environment.hostLifecycle = "removing"; if (field === "phase") f.state.environment.lifecycle.phase = "teardown";
  await expect(f.observer.observe(environment)).rejects.toThrow("not-ready-or-mismatched"); expect(f.methods.system.version).not.toHaveBeenCalled();
});
it("reports a failed read as an unavailable observation, never as a changed or unknown fact", async () => {
  const f = fixture(); f.methods.plugins.list.mockRejectedValue(new Error("unavailable"));
  await expect(f.observer.observe(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
  await expect(f.observer.check(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
  expect(f.store.list("revalidation-observed-environments")).toEqual([]);
});
it("fingerprints skill content the privacy filter would rewrite, since only its digest is stored", async () => {
  const f = fixture(); f.options.redact = (value: string) => value.replaceAll("https://", "[url]");
  const observer = createRevalidationEnvironmentObserver(f.options);
  f.state.content = "See https://example.test for details";
  const first = await observer.check(environment);
  expect(first.skills[0]).toMatchObject({ complete: true }); expect(revalidationObservationGaps(first)).toEqual([]);
  f.state.content = "See https://example.test/changed for details";
  expect((await observer.check(environment)).digest).not.toBe(first.digest);
});
it("retains missing facts as unknown instead of using declared versions or inventory presence", async () => {
  const f = fixture(); f.methods.system.version.mockResolvedValue({} as never); f.state.plugins = [];
  f.methods.skills.listFiles.mockResolvedValue({ files: ["SKILL.md"], truncated: true });
  const observed = await f.observer.observe({ ...environment, dependencies: [...environment.dependencies, { kind: "tool", name: "compiler", version: "declared-3", setup: "Install it" }] });
  expect(observed.bbVersion).toBeNull(); expect(observed.plugins[0]).toMatchObject({ presence: "missing", version: null, metadataDigest: null });
  expect(observed.skills[0]).toMatchObject({ presence: "present", complete: false, manifestDigest: null, files: [] });
  expect(observed.unobservedDependencies).toEqual([{ kind: "tool", name: "compiler", reason: "unsupported-observation-surface" }]); expect(f.methods.skills.getContent).not.toHaveBeenCalled();
});
it.each(["plugin", "content", "revision", "bb"])("detects supported %s fingerprint drift", async field => {
  const f = fixture(), first = await f.observer.observe(environment);
  if (field === "plugin") f.state.plugins[0]!.version = "2"; if (field === "content") f.state.content = "Changed instruction";
  if (field === "revision") f.state.revision = "revision-2"; if (field === "bb") f.state.version = "0.50";
  await expect(f.observer.verify(environment, first.digest)).rejects.toThrow("environment-drift");
  expect(f.store.list("revalidation-observed-environments")).toContainEqual(first);
});
it("requires server-prepared snapshots and rejects a modified persisted content digest", async () => {
  const f = fixture(); expect(() => f.observer.resolve(environment)).toThrow("not-observed");
  const snapshot = await f.observer.observe(environment); expect(() => validateObservedRevalidationEnvironment({ ...snapshot, bbVersion: "modified" })).toThrow("digest-mismatch");
});
it("does not let a delayed older observation replace a newer prepared snapshot", async () => {
  const f = fixture(); let release!: (value: { currentVersion: string; upgradeCommand: string }) => void;
  f.methods.system.version.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const old = f.observer.observe(environment); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.state.version = "new-version"; const latest = await f.observer.observe(environment); release({ currentVersion: "old-version", upgradeCommand: "unused" }); await old;
  expect(f.observer.resolve(environment)).toEqual(latest);
});
it("honors cancellation even when the SDK does not settle its read", async () => {
  const f = fixture(), abort = new AbortController(); f.methods.environments.get.mockImplementation(() => new Promise(() => {}));
  const pending = f.observer.observe(environment, abort.signal); abort.abort(); await expect(pending).rejects.toThrow("observation-aborted");
  expect(f.store.list("revalidation-observed-environments")).toEqual([]);
});

it("turns malformed optional inventories into unknown observations", async () => {
  const f = fixture(); f.methods.plugins.list.mockResolvedValue({ plugins: null } as never); f.methods.skills.list.mockResolvedValue({ skills: null } as never);
  const result = await f.observer.observe(environment);
  expect(result.plugins[0]).toMatchObject({ presence: "unknown", metadataDigest: null });
  expect(result.skills[0]).toMatchObject({ presence: "unknown", complete: false, manifestDigest: null });
  expect(f.methods.skills.getContent).not.toHaveBeenCalled();
});
it("validates persisted fingerprint content and prepared-head binding", async () => {
  const f = fixture(), result = await f.observer.observe(environment);
  const {digest: _digest, capturedAtMs, ...content} = result;
  const inconsistent = {...content,skills:content.skills.map(skill=>({...skill,presence:"missing" as const}))};
  expect(() => validateObservedRevalidationEnvironment({...inconsistent,capturedAtMs,digest:observedRevalidationEnvironmentDigest(inconsistent)})).toThrow("skill-observation-invalid");
  const head = f.store.get<{snapshotId:string;digest:string}>("revalidation-environment-observation-heads", result.declaredEnvironmentDigest)!;
  f.store.put("revalidation-environment-observation-heads",result.declaredEnvironmentDigest,{...head,digest:"0".repeat(64)});
  expect(() => f.observer.resolve(environment)).toThrow("observation-binding-mismatch");
});
it("compares without recording when used as a drift check",async()=>{
  const f=fixture(),recorded=await f.observer.observe(environment),before=f.store.list("revalidation-observed-environments");
  for(let i=0;i<5;i++)expect((await f.observer.check(environment)).digest).toBe(recorded.digest);
  expect(f.store.list("revalidation-observed-environments")).toEqual(before);expect(f.observer.resolve(environment).digest).toBe(recorded.digest);
});
it("treats a failed environment or BB version read as unavailable, and a host without a version API as a stable unknown", async () => {
  const f = fixture(); f.methods.environments.get.mockRejectedValueOnce(new Error("boom"));
  await expect(f.observer.check(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
  f.methods.system.version.mockRejectedValueOnce(new Error("offline"));
  await expect(f.observer.check(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
  const withVersion = await f.observer.check(environment);
  const noApi = createRevalidationEnvironmentObserver({ ...f.options, sdk: { ...f.methods, system: {} } as unknown as RevalidationEnvironmentSdk });
  const first = await noApi.check(environment), second = await noApi.check(environment);
  expect(first.bbVersion).toBeNull(); expect(first.unknowns).toContain("bb-version-not-observed"); expect(second.digest).toBe(first.digest);
  expect(withVersion.bbVersion).toBe("0.49.0");
});
it("records a BB version call the host does not support as a stable unknown", async () => {
  const f = fixture(); f.methods.system.version.mockRejectedValue(Object.assign(new Error("method not found"), { status: 404 }));
  const first = await f.observer.check(environment), second = await f.observer.check(environment);
  expect(first.bbVersion).toBeNull(); expect(first.unknowns).toContain("bb-version-not-observed"); expect(second.digest).toBe(first.digest);
});
it("retries a transient version failure even when its wording mentions not found", async () => {
  const f = fixture(); f.methods.system.version.mockRejectedValueOnce(Object.assign(new Error("machine not found"), { status: 503 }));
  await expect(f.observer.check(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
  f.methods.system.version.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
  await expect(f.observer.check(environment)).rejects.toThrow("revalidation-environment-observation-unavailable");
});
