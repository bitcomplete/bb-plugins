import Database from "better-sqlite3";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PROJECT_FILE, playbookPath } from "./config.js";
import { comment, crashingPod, issue, pull, warningEvent } from "./fixtures.js";
import { kubectlRefusal, type KubectlResult } from "./kubectl.js";
import { createStewardsPlugin, testHooks, type StewardsDeps } from "./server.js";
import { SOURCE_PLUGIN_IDS, type EntitySnapshot } from "./source-contract.js";
import { MIGRATIONS } from "./store.js";
import { GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, projectFileTemplate } from "./templates.js";

type Call = { pluginId: string; method: string; input: Record<string, unknown> };

// A world of fake neighbours: multi-repo serving `.bb`, linear and github
// serving snapshots, and bb's threads.
function world() {
  const files: Record<string, string | null> = {
    [PROJECT_FILE]: projectFileTemplate(["ENG"]),
    [playbookPath("linear-tickets")]: LINEAR_TICKETS,
    [playbookPath("github-prs")]: GITHUB_PRS,
    [playbookPath("github-reviews")]: GITHUB_REVIEWS,
  };
  const repos = [{ dir: "web", url: "https://github.com/acme/web.git" }];
  const entities = new Map<string, EntitySnapshot>();
  const rpcCalls: Call[] = [];
  const threads = new Map<string, { status: string; archivedAt: number | null; title?: string | null; parentThreadId?: string | null; sectionId?: string | null; hostId?: string }>();
  const writes: Array<{ path: string; hostId?: string }> = [];
  const sections: Array<{ id: string; name: string }> = [];
  /** Each thread's latest context window reading, as bb reports it. */
  const usage = new Map<string, number>();
  const metadata = new Map<string, Record<string, unknown>>();
  const spawns: Array<Record<string, unknown> & { id: string }> = [];
  const sends: Array<{ threadId: string; text: string }> = [];
  const userTurns: Array<{ threadId: string; text: string }> = [];
  let n = 0;

  const callRpc = async (args: { pluginId: string; method: string; input?: unknown; outputSchema: { parse(v: unknown): unknown } }) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    rpcCalls.push({ pluginId: args.pluginId, method: args.method, input });
    let out: unknown;
    if (args.method === "readProjectFiles") out = { projectSourcePath: "/p/.bb", head: "abc", files: (input.paths as string[]).map((path) => ({ path, content: files[path] ?? null })), error: null };
    else if (args.method === "repoSet") out = { repos, error: null };
    else if (args.method === "sourceSnapshot") out = { snapshot: entities.get(String(input.id)) ?? null };
    else if (args.method === "sourceSetInterest") out = { ok: true };
    else if (args.method === "sourceAdoptable") {
      const units = input.units as string[];
      out = {
        viewer: args.pluginId === SOURCE_PLUGIN_IDS.github ? "jane" : "Jane",
        entities: [...entities.values()]
          .filter((e) => SOURCE_PLUGIN_IDS[e.source] === args.pluginId && units.some((u) => u.toLowerCase() === e.unit.toLowerCase()))
          .map((e) => ({ id: e.id, key: e.key, unit: e.unit, kind: e.kind, state: e.state, labels: e.labels, author: e.author, draft: e.pull?.draft ?? false, createdAt: e.createdAt })),
        errors: [],
      };
    } else if (args.method === "sourceValidate") out = { viewer: "Jane", units: (input.units as string[]).map((unit) => ({ unit, found: true, labelFound: true, missingStates: [] })), mine: [{ unit: "ENG", name: "Engineering" }], error: null };
    else throw Object.assign(new Error(`unknown ${args.pluginId}.${args.method}`), { status: 404 });
    return args.outputSchema.parse(out);
  };

  const sdk = {
    plugins: { callRpc },
    projects: {
      list: async () => [{ id: "p1", name: "Acme" }],
      // A checkout on a machine that is off (the default source) and one on a machine that is on.
      get: async () => ({
        id: "p1",
        name: "Acme",
        sources: [
          { id: "src_off", projectId: "p1", type: "local_path", hostId: "host_off", path: "/p/.bb", isDefault: true },
          { id: "src_on", projectId: "p1", type: "local_path", hostId: "host_on", path: "/p/.bb", isDefault: false },
        ],
      }),
    },
    files: {
      mkdir: async () => ({}),
      write: async (args: { path: string; hostId?: string }) => {
        writes.push({ path: args.path, hostId: args.hostId });
        return { outcome: "written" };
      },
    },
    hosts: { list: async () => [{ id: "host_off", status: "disconnected" }, { id: "host_on", status: "connected" }] },
    threadSections: {
      list: async () => sections.map((s) => ({ ...s })),
      create: async ({ name }: { name: string }) => {
        const section = { id: `sec_${sections.length + 1}`, name };
        sections.push(section);
        return { ...section };
      },
      delete: async ({ id }: { id: string }) => {
        sections.splice(sections.findIndex((s) => s.id === id), 1);
        for (const t of threads.values()) if (t.sectionId === id) t.sectionId = null;
        return {};
      },
    },
    threads: {
      spawn: async (args: Record<string, unknown>) => {
        const id = `thr_${++n}`;
        threads.set(id, { status: "idle", archivedAt: null, title: (args.title as string | undefined) ?? null, sectionId: (args.sectionId as string | undefined) ?? null });
        metadata.set(id, { ...((args.pluginMetadata as Record<string, unknown> | undefined) ?? {}) });
        spawns.push({ ...args, id });
        return makeThreadResponse({ id });
      },
      send: async (args: { threadId: string; input: Array<{ text: string }> }) => {
        sends.push({ threadId: args.threadId, text: args.input.map((i) => i.text).join("") });
        return {};
      },
      get: async ({ threadId }: { threadId: string }) => {
        const t = threads.get(threadId);
        if (t === undefined) throw Object.assign(new Error("not found"), { status: 404 });
        return {
          ...makeThreadResponse({ id: threadId, title: t.title ?? null, status: t.status as never, archivedAt: t.archivedAt, environmentId: "env1", providerId: "claude-code", parentThreadId: t.parentThreadId ?? null, sectionId: t.sectionId ?? null }),
          ...(t.hostId === undefined ? {} : { environment: { hostId: t.hostId } }),
        };
      },
      list: async ({ sectionId, archived }: { sectionId?: string; archived?: boolean }) =>
        [...threads.entries()]
          .filter(([, t]) => (sectionId === undefined || t.sectionId === sectionId) && (archived !== false || t.archivedAt === null))
          .map(([id]) => makeThreadResponse({ id })),
      archive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = 1;
        return {};
      },
      unarchive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = null;
        return {};
      },
      stop: async () => ({}),
      update: async (args: { threadId: string; title?: string; parentThreadId?: string | null; sectionId?: string | null }) => {
        const t = threads.get(args.threadId);
        if (t !== undefined && args.sectionId !== undefined) t.sectionId = args.sectionId;
        if (t !== undefined && args.title !== undefined) t.title = args.title;
        if (t !== undefined && args.parentThreadId !== undefined) t.parentThreadId = args.parentThreadId;
        return {};
      },
      compact: async () => ({ ok: true }),
      updatePluginMetadata: async (args: { threadId: string; set?: Record<string, unknown> }) => {
        const next = { ...(metadata.get(args.threadId) ?? {}), ...(args.set ?? {}) };
        metadata.set(args.threadId, next);
        return next;
      },
      events: {
        list: async ({ threadId, types }: { threadId: string; types?: string[] }) =>
          types?.includes("thread/contextWindowUsage/updated")
            ? usage.has(threadId)
              ? [{ id: "u", seq: 1, threadId, createdAt: now, scope: "thread", type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: usage.get(threadId), modelContextWindow: 1_000_000, estimated: true } } }]
              : []
            : userTurns.filter((t) => t.threadId === threadId).map((t, i) => ({ id: `e${i}`, seq: i, threadId, createdAt: now, scope: "thread", type: "client/turn/start", data: { initiator: "user", request: { method: "turn/start", params: { input: [{ type: "text", text: t.text }] } } } })),
      },
    },
  };
  let now = Date.parse("2026-10-14T15:00:00Z");
  return { files, writes, repos, entities, rpcCalls, threads, sections, usage, metadata, spawns, sends, userTurns, sdk, now: () => now, advance: (ms: number) => (now += ms) };
}

async function setup(extra: Partial<StewardsDeps> = {}) {
  const w = world();
  const { bb, harness } = createFakePluginHost({ pluginId: "stewards", sdk: w.sdk as never, agentSkillIds: ["stewards"] });
  await createStewardsPlugin({ now: w.now, timing: { debounceMs: 1, nightlyStaggerMs: 0 }, ...extra })(bb);
  const hooks = testHooks.get("stewards")!;
  /** Let debounced work run to completion. */
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await hooks.settle();
    }
  };
  const ring = async (source: "linear" | "github", id: string) => {
    await harness.callRpc("stewardsRing", { source, id }, { experimental_caller: { kind: "plugin", pluginId: SOURCE_PLUGIN_IDS[source] } });
    await flush();
  };
  const tool = async (name: string, args: Record<string, unknown>, threadId: string) => {
    const r = (await harness.behavior.callAgentTool(name, args, { threadId, projectId: "p1" })) as string | { content: Array<{ text?: string }>; isError?: boolean };
    return typeof r === "string" ? { text: r, error: false } : { text: r.content.map((c) => c.text ?? "").join(""), error: r.isError === true };
  };
  const list = async () => ((await harness.callRpc("stewardsList", { projectId: "p1", all: true })) as { bindings: Array<{ key: string; kind: string; threadId: string | null; ended: boolean; escalations: number; summary: string | null }> }).bindings;
  const idle = async (threadId: string, lastAssistantText: string | null = null) => {
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText });
    await flush();
  };
  /** A thread a steward started with `bb thread spawn --parent-self`. */
  const created = async (id: string, parent: string, title = "Implement") => {
    w.threads.set(id, { status: "active", archivedAt: null });
    await harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id, parentThreadId: parent, lifecycleOwnerThreadId: parent, title, originPluginId: null }) });
    await flush();
  };
  return { ...w, bb, harness, hooks, flush, ring, tool, list, idle, created };
}

describe("a Linear ticket steward", () => {
  it("is adopted from a ring, beside the project steward rather than under it, with a self-contained wake", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");

    const [project, steward] = t.spawns;
    expect(project).toMatchObject({ title: "Acme project steward", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    // thread-briefs keeps its hands off: no renames, auto-archiving or grouping for any steward, and no row ring for the project steward.
    expect(project).toMatchObject({ pluginMetadata: { role: "project", threadBriefs: { rename: false, group: false, archive: false, ring: false } } });
    // On the project's machine, never core's "project-default" (the server's own, which may have no daemon).
    expect(project).toMatchObject({ environment: { type: "provider", environmentProviderId: "multi-repo-workspace", machine: { type: "existing", hostId: "host_on" } } });
    // Both in the project's own sidebar section, and nothing pinned.
    expect(t.sections).toEqual([{ id: "sec_1", name: "Acme" }]);
    expect(project).toMatchObject({ sectionId: "sec_1" });
    expect(steward).toMatchObject({ sectionId: "sec_1" });
    expect(project).not.toHaveProperty("pinned");
    expect(steward).toMatchObject({ title: "ENG-12: Fix login", environment: { type: "reuse", environmentId: "env1" }, model: "claude-sonnet-5-5", pluginMetadata: { role: "steward", threadBriefs: { rename: false, group: false, archive: false } } });
    // No parent: bb would wake a parent every time a steward finishes a turn.
    expect(steward).not.toHaveProperty("parentThreadId");
    const prompt = String(steward!.prompt);
    expect(prompt).toMatch(/# Steward wake: ENG-12 — Fix login/u);
    expect(prompt).toMatch(/You have just been bound/u);
    expect(prompt).toMatch(/Specify the ticket against the ready checklist/u);
    expect(prompt).toMatch(/\[ \] 2\. Acceptance criteria are testable/u);
    expect(prompt).toMatch(/given by the project steward/u);
    // The first wake is the spawn prompt, before the thread has an id.
    expect(prompt).toMatch(/Your thread id is in `\$BB_THREAD_ID`/u);
    expect(prompt).toContain(`bb thread spawn --project p1 --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --environment-provider multi-repo-workspace --machine host_on --provider claude-code --model claude-opus-5-5 --reasoning-level high --title "ENG-12: <task>" --prompt-file - <<'EOF'\n    <the whole task>\n    EOF`);
    expect(await t.list()).toMatchObject([{ key: "ENG-12", kind: "ticket", threadId: steward!.id, ended: false }]);

    const interest = t.rpcCalls.filter((c) => c.method === "sourceSetInterest");
    expect(interest.find((c) => c.pluginId === "linear")?.input).toEqual({ units: ["ENG"], entities: ["uuid-12"] });
    expect(interest.find((c) => c.pluginId === "github-watcher")?.input).toEqual({ units: ["acme/web"], entities: [] });
  });

  it("ignores unlabelled tickets, other teams, and rings from anyone but a source plugin", async () => {
    const t = await setup();
    t.entities.set("u1", issue({ id: "u1", key: "ENG-1", labels: [] }));
    t.entities.set("u2", issue({ id: "u2", key: "OPS-2", unit: "OPS" }));
    await t.ring("linear", "u1");
    await t.ring("linear", "u2");
    expect(t.spawns).toEqual([]);
    await expect(t.harness.callRpc("stewardsRing", { source: "linear", id: "u1" })).rejects.toThrow(/only the linear and github-watcher plugins/u);
    await expect(t.harness.callRpc("stewardsRing", { source: "linear", id: "u1" }, { experimental_caller: { kind: "plugin", pluginId: "github-watcher" } })).rejects.toThrow(/each for its own source/u);
  });

  it("wakes only for actionable changes, and gives two tools to stewards only", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);

    const tools = async (id: string) => (await t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id, title: null, parentThreadId: null, sourceThreadId: null } }))).tools.map((x) => x.name);
    expect(await tools(steward!)).toEqual(["steward_report", "steward_update"]);
    expect(await tools(project!)).toEqual(["steward_update"]);
    expect(await tools("thr_other")).toEqual([]);

    const report = await t.tool("steward_report", { phase: "Todo", summary: "Specifying.", nextAction: "Post acceptance criteria", actor: "steward", requeueAfter: "1d" }, steward!);
    expect(report.error).toBe(false);
    expect((await t.list())[0]!.summary).toBe("Specifying.");

    // Label churn and the steward's own comment: recorded, not woken.
    t.entities.set("uuid-12", issue({ labels: ["bb-managed", "auth"], comments: [comment({ id: "own", body: "**Spec:** AC", signedBy: steward!, createdAt: "2026-10-14T15:01:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends).toEqual([]);

    t.entities.set("uuid-12", issue({ labels: ["bb-managed", "auth"], comments: [comment({ createdAt: "2026-10-14T16:00:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]!.text).toMatch(/1 new comment from Sam/u);
    expect(t.sends[0]!.text).toMatch(/Can we also cover SSO\?/u);
  });

  it("passes the ready gate on the checklist reported by number, and refuses a paraphrase", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    const base = { phase: "Todo", summary: "Specified.", nextAction: "Move to In Progress", actor: "steward" };

    // What bithub's stewards sent: short names for long items. Refused, with the numbers to use, and nothing recorded.
    const paraphrased = await t.tool("steward_report", { ...base, ready: { checklist: [{ item: "Problem stated", met: true }, { item: 2, met: true }], substantial: false } }, steward);
    expect(paraphrased.error).toBe(true);
    expect(paraphrased.text).toMatch(/"Problem stated" is not a ready checklist item/u);
    expect(paraphrased.text).toMatch(/\n1\. Problem and desired outcome are stated\n2\. Acceptance criteria are testable/u);
    expect((await t.list())[0]!.summary).toBeNull();

    const partly = await t.tool("steward_report", { ...base, ready: { checklist: [1, 2, 3].map((item) => ({ item, met: true })), substantial: false } }, steward);
    expect(partly.text).toMatch(/Ready gate: not passed \(unmet: 4\)/u);
    const met = await t.tool("steward_report", { ...base, ready: { checklist: [1, 2, 3, "Out of scope is stated"].map((item) => ({ item, met: true, note: "in the spec" })), substantial: false } }, steward);
    expect(met).toMatchObject({ error: false, text: expect.stringMatching(/Ready gate: passed\./u) });

    // Moving to a build stage now is no conflict, and the wake says the gate passed.
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const wake = t.sends.at(-1)!.text;
    expect(wake).not.toMatch(/before the ready gate passed/u);
    expect(wake).toMatch(/- \[x\] 1\. Problem and desired outcome are stated — in the spec/u);
    expect(wake).toMatch(/- \[x\] 4\. Out of scope is stated/u);
    expect(wake).toMatch(/Gate: PASSED/u);
    expect(wake).toContain(`Your thread id is ${steward}.`);
  });

  // BB-7: flagged on every Todo → In Progress, approval seconds old, and on
  // every In Review → In Progress of a worker's normal loop.
  describe("moving into build before the ready gate passed", () => {
    const flagged = /before the ready gate passed/u;
    const base = { phase: "Todo", summary: "Specified.", nextAction: "Move to In Progress", actor: "steward" };
    const inProgress = (over: Parameters<typeof issue>[0] = {}) => issue({ state: "In Progress", stateType: "started", ...over });
    /** A bound ticket in Todo, with its project steward and steward. */
    const bound = async () => {
      const t = await setup();
      t.entities.set("uuid-12", issue());
      await t.ring("linear", "uuid-12");
      const [project, steward] = t.spawns.map((x) => x.id) as [string, string];
      const wakes = () => t.sends.filter((s) => s.threadId === steward).map((s) => s.text);
      /** Move the ticket, and return the wake it brought. */
      const move = async (entity: EntitySnapshot) => {
        const before = wakes().length;
        t.entities.set("uuid-12", entity);
        await t.ring("linear", "uuid-12");
        expect(wakes().length).toBeGreaterThan(before);
        return wakes().at(-1)!;
      };
      return { t, project, steward, move };
    };

    it("is raised entering build from spec with no approval", async () => {
      const { move } = await bound();
      expect(await move(inProgress())).toMatch(flagged);
    });

    it("is not raised with a current approval and no checklist report yet", async () => {
      const { t, project, move } = await bound();
      expect((await t.tool("steward_update", { binding: "ENG-12", approve: true }, project)).error).toBe(false);
      expect(await move(inProgress())).not.toMatch(flagged);
    });

    it("is raised when the approval is stale for the current spec", async () => {
      const { t, project, move } = await bound();
      await t.tool("steward_update", { binding: "ENG-12", approve: true }, project);
      expect(await move(inProgress({ description: "Users cannot log in. Also SSO." }))).toMatch(flagged);
    });

    it("is raised when the approval was voided", async () => {
      const { t, project, steward, move } = await bound();
      await t.tool("steward_update", { binding: "ENG-12", approve: true }, project);
      expect((await t.tool("steward_report", { ...base, voidApproval: true }, steward)).error).toBe(false);
      expect(await move(inProgress())).toMatch(flagged);
    });

    it("is raised when a reported checklist item is unmet, approval or not", async () => {
      const { t, steward, move } = await bound();
      const checklist = [1, 2, 3, 4].map((item) => ({ item, met: item !== 4 }));
      expect((await t.tool("steward_report", { ...base, ready: { checklist, substantial: false } }, steward)).error).toBe(false);
      expect(await move(inProgress())).toMatch(flagged);
    });

    it("is never raised moving back from review", async () => {
      const { move } = await bound();
      // No approval and nothing reported: a gate that is really unmet.
      expect(await move(issue({ state: "In Review", stateType: "started" }))).not.toMatch(flagged);
      expect(await move(inProgress())).not.toMatch(flagged);
    });
  });

  it("tells the steward its own thread id and that the linear tools sign for it", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    const config = await t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: steward, title: null, parentThreadId: null, sourceThreadId: null } }));
    expect(config.instructions).toContain(`your thread id is ${steward}`);
    expect(config.instructions).toContain(`_— from bb thread ${steward}_`);
    expect(config.instructions).toMatch(/add no signature to what you pass them/u);
  });

  it("says news that arrived while the steward was busy once", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", { phase: "Todo", summary: "Specifying.", nextAction: "Post a spec", actor: "steward" }, steward);

    t.threads.get(steward)!.status = "active";
    t.entities.set("uuid-12", issue({ comments: [comment({ createdAt: "2026-10-14T16:00:00Z" })] }));
    await t.ring("linear", "uuid-12");
    t.entities.set("uuid-12", issue({ comments: [comment({ createdAt: "2026-10-14T16:00:00Z" }), comment({ id: "c2", author: "Lee", createdAt: "2026-10-14T16:05:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends).toEqual([]);

    t.threads.get(steward)!.status = "idle";
    await t.idle(steward);
    expect(t.sends).toHaveLength(1);
    const changed = t.sends[0]!.text.split("## 5. What changed since your last turn")[1]!;
    expect(changed.match(/new comment/gu)).toHaveLength(1);
    expect(changed).toMatch(/- 2 new comments from Sam, Lee/u);
  });

  it("escalates to the project steward, which decides from guidance and forwards only big decisions", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);

    const raised = await t.tool("steward_report", { phase: "Todo", summary: "Spec drafted.", nextAction: "Decide on SSO", actor: "other", escalate: { kind: "decision", question: "Include SSO?", meanwhile: "Wait." } }, steward!);
    expect(raised.text).toMatch(/with the project steward/u);
    const wake = t.sends.find((s) => s.threadId === project)!.text;
    expect(wake).toMatch(/from ENG-12 \(decision\): Include SSO\?/u);
    expect(wake).toMatch(/A public API, data contract or schema change/u);
    const id = /(esc_[\w-]+) from ENG-12/u.exec(wake)![1]!;

    // A steward cannot decide its own escalation's route, nor set its own priority.
    expect((await t.tool("steward_update", { binding: "ENG-12", forward: id }, steward!)).error).toBe(true);
    expect((await t.tool("steward_update", { priority: "high" }, steward!)).error).toBe(true);

    const decided = await t.tool("steward_update", { binding: "ENG-12", guidance: "Yes, include SSO; it is in the auth design doc.", resolve: id, priority: "high" }, project!);
    expect(decided).toMatchObject({ error: false, text: expect.stringMatching(/resolved esc_/u) });
    await t.flush();
    const back = t.sends.filter((s) => s.threadId === steward).at(-1)!.text;
    expect(back).toMatch(/decided: Yes, include SSO/u);
    expect(back).toMatch(/Yes, include SSO; it is in the auth design doc\./u);
    expect(back).toMatch(/Priority: high/u);
  });

  it("has the project steward approve a substantial spec; the user only when they say so", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);

    expect((await t.tool("steward_update", { approve: true }, steward!)).error).toBe(true);
    expect((await t.tool("steward_update", { binding: "ENG-12", approve: true }, project!)).error).toBe(false);

    // The user can still approve in the steward's thread, in their own words.
    expect((await t.tool("steward_update", { approve: true, quote: "go ahead" }, steward!)).error).toBe(true);
    t.userTurns.push({ threadId: steward!, text: "Looks right — go ahead." });
    expect((await t.tool("steward_update", { approve: true, quote: "go ahead" }, steward!)).error).toBe(false);
  });

  // HUB-196: the steward posted a new spec, met the checklist, and only said in
  // its status that it waited on the project steward. Nobody heard.
  it("asks the project steward to approve a met, substantial spec without the steward escalating", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    const toProject = () => t.sends.filter((s) => s.threadId === project);
    const met = { checklist: [1, 2, 3, 4].map((item) => ({ item, met: true })), substantial: true, why: "two repos" };
    const base = { phase: "Todo", summary: "Spec posted.", nextAction: "Wait for approval", actor: "other", blockedOn: "project steward's approval of the new spec" };

    const reported = await t.tool("steward_report", { ...base, ready: met }, steward!);
    expect(reported.text).toMatch(/Approval of the spec is requested from the project steward \(esc_[\w-]+\); wait for it, and do not escalate for it\./u);
    expect(toProject()).toHaveLength(1);
    const wake = toProject()[0]!.text;
    expect(wake).toMatch(/approval requested for ENG-12/u);
    expect(wake).toMatch(/(esc_[\w-]+) from ENG-12 \(approval\): Approve ENG-12's spec \(Fix login\)\? .*substantial \(two repos\)/u);
    expect(wake).toMatch(/steward_update \{ binding, approve: true \}/u);
    const id = /(esc_[\w-]+) from ENG-12 \(approval\)/u.exec(wake)![1]!;

    // A second report asks nothing twice, and the steward's next wake says it is asked for.
    await t.tool("steward_report", { ...base, ready: met }, steward!);
    expect(toProject()).toHaveLength(1);
    expect((await t.list())[0]!.escalations).toBe(1);

    // Approving closes the request and wakes the steward with the gate passed.
    const approved = await t.tool("steward_update", { binding: "ENG-12", approve: true }, project!);
    expect(approved).toMatchObject({ error: false, text: "ENG-12: spec approved." });
    await t.flush();
    expect((await t.list())[0]!.escalations).toBe(0);
    expect(t.sends.filter((s) => s.threadId === steward).at(-1)!.text).toMatch(/Gate: PASSED/u);
    expect((await t.harness.behavior.runCli(["show", "ENG-12"])).stdout).toContain(`Escalation ${id} approval (resolved, project)`);
    expect((await t.harness.behavior.runCli(["show", "ENG-12", "--project", "p1"])).stdout).toContain(`Escalation ${id} approval (resolved, project)`);
    expect(await t.harness.behavior.runCli(["show", "ENG-12", "--project", "p2"])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/No binding for ENG-12 in project p2/u) });

    // A new spec voids nothing by itself, but the gate needs approval again, and the approver is asked again.
    t.entities.set("uuid-12", issue({ comments: [comment({ id: "s2", author: "Jane", body: "**Spec:** narrower scope", signedBy: steward!, createdAt: "2026-10-14T16:00:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends.filter((s) => s.threadId === steward).at(-1)!.text).toMatch(/the spec has changed since, so the gate needs it again/u);
    await t.tool("steward_report", { ...base, ready: met }, steward!);
    expect(toProject()).toHaveLength(2);
    expect(toProject()[1]!.text).toMatch(/the spec has changed since its last approval/u);

    // Declined: not asked again for the same spec; asked again once it changes.
    const second = /(esc_[\w-]+) from ENG-12 \(approval\)/u.exec(toProject()[1]!.text)![1]!;
    await t.tool("steward_update", { binding: "ENG-12", guidance: "Name the migration in the spec.", resolve: second }, project!);
    await t.flush();
    await t.tool("steward_report", { ...base, ready: met }, steward!);
    expect(toProject()).toHaveLength(2);
    t.entities.set("uuid-12", issue({ description: "Users cannot log in. Migration: none." }));
    await t.ring("linear", "uuid-12");
    await t.tool("steward_report", { ...base, ready: met }, steward!);
    expect(toProject()).toHaveLength(3);
  });

  it("wakes the project steward once when the steward escalates in the same report that asks for approval", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    const met = { checklist: [1, 2, 3, 4].map((item) => ({ item, met: true })), substantial: true };
    await t.tool("steward_report", { phase: "Todo", summary: "Spec posted.", nextAction: "Wait", actor: "other", ready: met, escalate: { kind: "decision", question: "Approve the spec?", meanwhile: "Wait." } }, steward!);
    const wakes = t.sends.filter((s) => s.threadId === project);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toMatch(/escalation and approval request from ENG-12/u);
    expect(wakes[0]!.text).toMatch(/If the steward also escalated asking for this approval, resolve that one too/u);
    // Approving names what is still open, so the duplicate is closed too.
    const approved = await t.tool("steward_update", { binding: "ENG-12", approve: true }, project!);
    expect(approved.text).toMatch(/spec approved; still open on it: esc_[\w-]+ \(decision, with project\): Approve the spec\?/u);
  });

  it("asks for a gate left waiting by a report from before, on the next look", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    // Record a met gate the way an older version left it: no request filed.
    const b = t.hooks.store.find("ENG-12")!;
    t.hooks.store.patch(b.id, { ready: { ...b.ready, checklist: ["Problem and desired outcome are stated", "Acceptance criteria are testable", "Affected repos are named", "Out of scope is stated"].map((item) => ({ item, met: true, note: null })), substantial: true }, awaitingReport: false });
    await t.ring("linear", "uuid-12");
    expect(t.sends.filter((s) => s.threadId === project).at(-1)?.text).toMatch(/approval requested for ENG-12/u);
    // Asking needs no turn of the steward's (its first wake was its spawn).
    expect(t.sends.filter((s) => s.threadId === steward)).toHaveLength(0);
  });

  it("asks the user, in the steward's thread, when the playbook says approval: me", async () => {
    const t = await setup();
    t.files[playbookPath("linear-tickets")] = LINEAR_TICKETS.replace("approval: project", "approval: me");
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    const reported = await t.tool("steward_report", { phase: "Todo", summary: "Spec posted.", nextAction: "Ask the user", actor: "me", ready: { checklist: [1, 2, 3, 4].map((item) => ({ item, met: true })), substantial: true } }, steward!);
    expect(reported.text).toMatch(/requested from the user \(esc_[\w-]+\): they approve in this thread/u);
    expect(t.sends.filter((s) => s.threadId === project)).toHaveLength(0);
    t.userTurns.push({ threadId: steward!, text: "Approved, go ahead." });
    expect((await t.tool("steward_update", { approve: true, quote: "go ahead" }, steward!)).error).toBe(false);
    expect((await t.list())[0]!.escalations).toBe(0);
  });

  // HUB-196's other half: the user answered a forwarded escalation by
  // rewriting the ticket, and only the steward heard.
  it("tells the project steward when the entity changes while the user has one of its escalations", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    const toProject = () => t.sends.filter((s) => s.threadId === project);
    await t.tool("steward_report", { phase: "Todo", summary: "Scope unclear.", nextAction: "Wait", actor: "other", escalate: { kind: "scope", question: "Include SSO?", meanwhile: "Wait." } }, steward!);
    const id = /(esc_[\w-]+) from ENG-12/u.exec(toProject()[0]!.text)![1]!;
    expect((await t.tool("steward_update", { binding: "ENG-12", forward: id, recommendation: "Leave SSO out." }, project!)).text).toMatch(/forwarded .* to the user/u);
    const before = toProject().length;

    // The steward's own signed edit is no answer.
    t.entities.set("uuid-12", issue({ description: `Users cannot log in.\n\n_— from bb thread ${steward}_` }));
    await t.ring("linear", "uuid-12");
    expect(toProject()).toHaveLength(before);

    // The user rewrites the description (keeping the signature line).
    t.entities.set("uuid-12", issue({ description: `Users cannot log in. SSO is out of scope.\n\n_— from bb thread ${steward}_` }));
    await t.ring("linear", "uuid-12");
    expect(toProject()).toHaveLength(before + 1);
    const wake = toProject().at(-1)!.text;
    expect(wake).toMatch(/ENG-12 changed while the user has its escalation/u);
    expect(wake).toMatch(/What changed on ENG-12 .*: Description edited\./u);
    expect(wake).toContain(`Escalation ${id} (scope) is with the user: Include SSO?`);
    expect(wake).toMatch(/## Escalations with the user[\s\S]*Your recommendation: Leave SSO out\./u);
    // The steward heard it too.
    expect(t.sends.filter((s) => s.threadId === steward).at(-1)!.text).toMatch(/- Description edited/u);

    // Resolved from the project steward's thread, it reaches the steward; later changes wake the project steward no more.
    await t.tool("steward_update", { binding: "ENG-12", guidance: "SSO is out of scope (the user said so on the ticket).", resolve: id }, project!);
    await t.flush();
    const after = toProject().length;
    t.entities.set("uuid-12", issue({ description: "Users cannot log in. SSO is out of scope. Retry once.", comments: [comment({ createdAt: "2026-10-14T16:00:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(toProject()).toHaveLength(after);
  });

  it("flags a status that waits on the project steward with no escalation", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", { phase: "Todo", summary: "Waiting.", nextAction: "Wait", actor: "other", blockedOn: "the project steward's call on scope" }, steward);
    expect((await t.harness.behavior.runCli(["list", "--project", "p1"])).stdout).toMatch(/waits on the project steward, with no open escalation/u);
  });

  it("recognizes workers the steward starts with bb thread spawn, and wakes when one finishes", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;

    await t.created("thr_w1", steward, "ENG-12: Implement");
    expect(t.sends).toEqual([]);
    await t.idle("thr_w1", "Opened acme/web#7.");
    const wake = t.sends.at(-1)!.text;
    expect(wake).toMatch(/Worker "ENG-12: Implement" finished its turn/u);
    expect(wake).toMatch(/Opened acme\/web#7\./u);
  });

  it("keeps a running worker's own pull request activity for the next turn instead of waking for it", async () => {
    const t = await setup();
    const linked = { linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] };
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", ...linked }));
    t.entities.set("acme/web#7", pull({ author: "jane" }, { headAuthor: "jane" }));
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.created("thr_w1", steward, "ENG-12: Implement");
    const sent = t.sends.length;

    // The worker's checks finish and it posts (as the viewer, unsigned) about its review round.
    t.entities.set("acme/web#7", pull({ author: "jane", comments: [comment({ id: "w1", author: "jane", body: "Round 2: suggestions taken.", createdAt: "2026-10-14T16:00:00Z" })] }, { headAuthor: "jane", checks: { state: "success", failing: [] } }));
    await t.ring("github", "acme/web#7");
    expect(t.sends).toHaveLength(sent);

    // A teammate's comment is news, and the wake carries what was kept.
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", ...linked, comments: [comment({ createdAt: "2026-10-14T16:30:00Z" })] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends).toHaveLength(sent + 1);
    const wake = t.sends.at(-1)!.text;
    const changed = wake.slice(wake.indexOf("## 5. What changed"));
    expect(changed).toMatch(/acme\/web#7: Checks finished: success/u);
    expect(changed).toMatch(/acme\/web#7: 1 new comment from jane/u);
    expect(changed).toMatch(/- 1 new comment from Sam/u);
    // Delivered once: the next turn starts from nothing kept.
    expect(t.hooks.store.open("p1")[0]!.pending).toEqual([]);
  });

  it("leases only the linked pull requests still open, and one not read yet", async () => {
    const t = await setup();
    const link = (n: number) => ({ key: `acme/web#${n}`, url: `https://github.com/acme/web/pull/${n}` });
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", linkedPulls: [link(7), link(8), link(9), link(10)] }));
    t.entities.set("acme/web#7", pull());
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", state: "closed" }));
    t.entities.set("acme/web#9", pull({ id: "acme/web#9", key: "acme/web#9", state: "merged" }, { merged: true }));
    // acme/web#10 has no snapshot: it cannot be read yet.
    await t.ring("linear", "uuid-12");
    const github = t.rpcCalls.filter((c) => c.method === "sourceSetInterest" && c.pluginId === "github-watcher").at(-1)?.input;
    expect(github).toEqual({ units: ["acme/web"], entities: ["acme/web#10", "acme/web#7"] });
  });

  it("stops leasing a linked pull request once it merges", async () => {
    const t = await setup();
    const linked = { linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] };
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", ...linked }));
    t.entities.set("acme/web#7", pull());
    await t.ring("linear", "uuid-12");
    const github = () => t.rpcCalls.filter((c) => c.method === "sourceSetInterest" && c.pluginId === "github-watcher");
    expect(github().at(-1)?.input).toEqual({ units: ["acme/web"], entities: ["acme/web#7"] });
    const sent = github().length;

    t.entities.set("acme/web#7", pull({ state: "merged" }, { merged: true }));
    await t.ring("github", "acme/web#7");
    expect(github()).toHaveLength(sent + 1);
    expect(github().at(-1)?.input).toEqual({ units: ["acme/web"], entities: [] });
  });

  it("counts a worker woken again (by a watch, a reviewer) as running", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.created("thr_w1", steward, "ENG-12: Implement");
    await t.idle("thr_w1", "Watching acme/web#7 for the review.");
    const binding = t.hooks.store.open("p1")[0]!.id;
    expect(t.hooks.store.workers(binding)[0]).toMatchObject({ status: "finished" });
    await t.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_w1" }) });
    await t.flush();
    expect(t.hooks.store.workers(binding)[0]).toMatchObject({ status: "running", result: "Watching acme/web#7 for the review." });
  });

  it("compacts a steward whose context has grown past the setting, once per reading", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    const compacted = () => t.harness.sdk.callsTo("threads.compact").map(([args]) => (args as { threadId: string }).threadId);

    t.usage.set(steward!, 90_000);
    await t.idle(steward!);
    expect(compacted()).toEqual([]);

    t.usage.set(steward!, 130_000);
    await t.idle(steward!);
    expect(compacted()).toEqual([steward]);
    // The same reading again (the provider has not reported since): not twice.
    await t.idle(steward!);
    expect(compacted()).toEqual([steward]);

    t.usage.set(project!, 200_000);
    await t.idle(project!);
    expect(compacted()).toEqual([steward, project]);
  });

  it("stops a looping steward's workers past the runaway guard", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    for (let i = 0; i < 7; i++) await t.created(`thr_w${i}`, steward);
    expect(t.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_w6" }]]);
    expect(t.sends.at(-1)!.text).toMatch(/Runaway guard/u);
  });

  it("archives its thread when it ends, and resumes the same thread when the label comes back", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;

    t.entities.set("uuid-12", issue({ labels: [] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends.at(-1)!.text).toMatch(/this binding is detached/u);
    await t.idle(steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.harness.sdk.callsTo("threads.archive").map(([args]) => args)).toEqual([{ threadId: steward }]);
    expect(t.threads.get(steward)!.archivedAt).not.toBeNull();

    // The next wake brings it back.
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
    expect((await t.list())[0]).toMatchObject({ ended: false, threadId: steward });
    expect(t.sends.at(-1)!.text).toMatch(/came back from a terminal or detached state/u);
    expect(t.spawns).toHaveLength(2);
  });
});

// HUB-195/196: two escalations seconds apart, and the second prompt listed
// the first as if new. HUB-183: a retried steward_update recorded its answer
// twice, and the escalation kept "The binding ended." instead.
describe("escalations delivered once, updates safe to retry", () => {
  /** Two tickets with their stewards, and a way for each to escalate. */
  async function two() {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", url: "https://linear.app/acme/issue/ENG-13", title: "Fix logout" }));
    await t.ring("linear", "uuid-12");
    await t.ring("linear", "uuid-13");
    const project = t.hooks.store.project("p1").threadId!;
    const escalate = async (key: string, question: string) => {
      await t.tool("steward_report", { phase: "Todo", summary: "Spec drafted.", nextAction: "Wait", actor: "other", escalate: { kind: "decision", question, meanwhile: "Wait." } }, t.hooks.store.find(key)!.threadId!);
      return t.hooks.store.openEscalations(t.hooks.store.find(key)!.id).at(-1)!.id;
    };
    const toProject = () => t.sends.filter((s) => s.threadId === project).map((s) => s.text);
    /** The escalation lines under one heading of a project steward prompt. */
    const under = (text: string, heading: string) => (text.split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "").split("\n").filter((l) => l.startsWith("- esc_"));
    return { ...t, project, escalate, toProject, under };
  }

  it("lists an escalation as new once, then as still open, and leaves out one resolved before the send", async () => {
    const t = await two();
    const first = await t.escalate("ENG-12", "Include SSO?");
    expect(t.toProject()).toHaveLength(1);
    expect(t.under(t.toProject()[0]!, "New escalations routed to you")).toEqual([expect.stringContaining(`${first} from ENG-12 (decision): Include SSO?`)]);
    expect(t.toProject()[0]).not.toContain("## Escalations still open with you");

    const second = await t.escalate("ENG-13", "Keep the old logout route?");
    expect(t.toProject()).toHaveLength(2);
    const wake = t.toProject()[1]!;
    expect(wake).toMatch(/# Project steward: escalation from ENG-13/u);
    expect(t.under(wake, "New escalations routed to you")).toEqual([expect.stringContaining(`${second} from ENG-13`)]);
    expect(t.under(wake, "Escalations still open with you")).toEqual([expect.stringContaining(`${first} from ENG-12`)]);
    expect(t.hooks.store.escalation(first)!.deliveredAt).not.toBeNull();

    // The first is decided while the third prompt is on its way (here, while
    // the project steward is brought back from the archive): the prompt leaves it out.
    t.threads.get(t.project)!.archivedAt = 1;
    t.harness.sdk.stub("threads.unarchive", async (args: { threadId: string }) => {
      t.hooks.store.resolve(first, "Yes, include SSO.");
      return t.sdk.threads.unarchive(args);
    });
    const third = await t.escalate("ENG-12", "Which SSO provider?");
    const last = t.toProject().at(-1)!;
    expect(t.under(last, "New escalations routed to you")).toEqual([expect.stringContaining(`${third} from ENG-12`)]);
    expect(t.under(last, "Escalations still open with you")).toEqual([expect.stringContaining(`${second} from ENG-13`)]);
    expect(last).not.toContain(first);
  });

  it("counts escalations open before delivery was recorded as delivered", () => {
    const db = new Database(":memory:");
    const added = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN delivered_at"));
    for (const m of MIGRATIONS.slice(0, added)) db.exec(m);
    const insert = db.prepare("INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, status, created_at) VALUES (?, 'b', 'decision', 'q', 'm', 'project', ?, 5)");
    insert.run("esc_open", "open");
    insert.run("esc_done", "resolved");
    for (const m of MIGRATIONS.slice(added)) db.exec(m);
    expect(db.prepare("SELECT id, delivered_at FROM escalations ORDER BY id").all()).toEqual([
      { id: "esc_done", delivered_at: null },
      { id: "esc_open", delivered_at: 5 },
    ]);
  });

  it("writes nothing when a forward, resolve or approve target is bad", async () => {
    const t = await two();
    const steward = t.hooks.store.find("ENG-12")!.threadId!;
    const bad = [
      [{ binding: "ENG-12", guidance: "Use SAML.", resolve: "esc_nope", priority: "high" }, t.project],
      [{ binding: "ENG-12", guidance: "Use SAML.", forward: "esc_nope", priority: "high" }, t.project],
      [{ guidance: "Use SAML.", approve: true }, steward],
    ] as const;
    for (const [args, thread] of bad) expect((await t.tool("steward_update", args, thread)).error).toBe(true);
    const b = t.hooks.store.find("ENG-12")!;
    expect(b.guidance).toEqual([]);
    expect(b.priority).toBeNull();
    expect(b.ready.approval).toBeNull();
  });

  it("saves guidance repeated within five minutes once, and again after", async () => {
    const t = await two();
    const update = () => t.tool("steward_update", { binding: "ENG-12", guidance: "Keep SSO out of this ticket." }, t.project);
    expect((await update()).text).toBe("ENG-12: guidance saved.");
    t.advance(60_000);
    expect(await update()).toEqual({ error: false, text: "ENG-12: guidance already saved." });
    expect(t.hooks.store.find("ENG-12")!.guidance).toHaveLength(1);
    t.advance(5 * 60_000);
    expect((await update()).text).toBe("ENG-12: guidance saved.");
    expect(t.hooks.store.find("ENG-12")!.guidance).toHaveLength(2);
    // The same text from someone else is theirs to say, not a retry.
    expect(t.hooks.store.addGuidance(t.hooks.store.find("ENG-12")!.id, "Keep SSO out of this ticket.", "thr_someone_else")).toBe(true);
    expect(t.hooks.store.find("ENG-12")!.guidance).toHaveLength(3);
  });

  it("accepts guidance resolving an approval request that approve: true already closed", async () => {
    const t = await two();
    const steward = t.hooks.store.find("ENG-12")!.threadId!;
    const met = { checklist: [1, 2, 3, 4].map((item) => ({ item, met: true })), substantial: true };
    await t.tool("steward_report", { phase: "Todo", summary: "Spec posted.", nextAction: "Wait for approval", actor: "other", ready: met }, steward);
    const id = /(esc_[\w-]+) from ENG-12 \(approval\)/u.exec(t.toProject().at(-1)!)![1]!;

    expect((await t.tool("steward_update", { binding: "ENG-12", approve: true }, t.project)).error).toBe(false);
    const answered = await t.tool("steward_update", { binding: "ENG-12", guidance: "Approved; keep the migration reversible.", resolve: id }, t.project);
    expect(answered).toMatchObject({ error: false, text: expect.stringMatching(/guidance saved; recorded the answer on esc_[\w-]+, which was already resolved \(Approved by the project steward\.\)/u) });
    expect(t.hooks.store.escalation(id)!.resolution).toBe("Approved by the project steward.\nApproved; keep the migration reversible.");
    // Answering an approval already granted is no decline.
    const b = t.hooks.store.find("ENG-12")!;
    expect(b.ready.approval).not.toBeNull();
    expect(b.ready.declinedSpecHash).toBeNull();
  });
});

describe("terminal states and follow-through", () => {
  /** A ticket in progress with its steward and one worker at work. */
  async function working() {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    await t.created("thr_w1", steward!, "ENG-12: Merge, watch the deploy, verify");
    const done = async () => {
      t.entities.set("uuid-12", issue({ state: "Done", stateType: "completed" }));
      await t.ring("linear", "uuid-12");
    };
    const report = (args: Record<string, unknown> = {}) => t.tool("steward_report", { phase: "Done", summary: "Merged.", nextAction: "Nothing", actor: "steward", ...args }, steward!);
    const stops = () => t.harness.sdk.callsTo("threads.stop").map(([args]) => (args as { threadId: string }).threadId);
    const archives = () => t.harness.sdk.callsTo("threads.archive").map(([args]) => (args as { threadId: string }).threadId);
    return { ...t, project: project!, steward: steward!, done, report, stops, archives };
  }

  it("leaves workers running through the wrap-up turn, and stops them when it ends without follow-through", async () => {
    const t = await working();
    await t.done();
    const wrapUp = t.sends.at(-1)!.text;
    expect(wrapUp).toMatch(/terminal state \(Done\)\. This is your wrap-up turn\. Running workers have not been stopped/u);
    expect(wrapUp).toMatch(/followThrough saying what remains/u);
    expect(wrapUp).toMatch(/ENG-12: Merge, watch the deploy, verify \(thread thr_w1\): running/u);
    expect(t.stops()).toEqual([]);

    expect((await t.report()).text).toMatch(/The binding ends when this turn does/u);
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.stops()).toEqual(["thr_w1"]);
    expect(t.archives()).toEqual([t.steward]);
  });

  it("keeps the binding open while the steward follows through, and ends it once the work is done", async () => {
    const t = await working();
    await t.done();
    const kept = await t.report({ followThrough: "thr_w1 is watching deploy 1206 and will verify production." });
    expect(kept).toMatchObject({ error: false, text: expect.stringMatching(/stays open to follow through until 2026-10-14T21:00:00Z/u) });
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: false });
    expect(t.stops()).toEqual([]);
    expect(t.archives()).toEqual([]);

    // A worker started for the remaining work is the steward's like any other.
    await t.created("thr_w2", t.steward, "ENG-12: Verify production");
    expect(t.hooks.store.workers(t.hooks.store.byThread(t.steward)!.id).map((w) => w.threadId)).toContain("thr_w2");

    await t.idle("thr_w1", "Deploy 1206 is live; verified in production.");
    const followUp = t.sends.at(-1)!;
    expect(followUp.threadId).toBe(t.steward);
    expect(followUp.text).toMatch(/you kept this binding open to follow through: "thr_w1 is watching deploy 1206/u);
    expect(followUp.text).toMatch(/runs out at 2026-10-14T21:00:00Z/u);
    expect(followUp.text).toMatch(/verified in production\./u);

    // Saying so again keeps it open; leaving it out ends it.
    await t.report({ followThrough: "thr_w2 is checking the logs." });
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: false });
    await t.report();
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.stops()).toEqual(["thr_w2"]);
    expect(t.archives()).toEqual([t.steward]);
  });

  it("ends a follow-through that runs out, stopping its workers and telling the project steward", async () => {
    const t = await working();
    await t.done();
    await t.report({ followThrough: "thr_w1 is watching the deploy." });
    await t.idle(t.steward);
    t.advance(6 * 3_600_000 + 60_000);
    await t.hooks.sweep();
    await t.flush();
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.stops()).toEqual(["thr_w1"]);
    const told = t.sends.filter((x) => x.threadId === t.project).at(-1)!.text;
    expect(told).toMatch(/follow-through ran out on ENG-12/u);
    expect(told).toMatch(/these workers were stopped: ENG-12: Merge, watch the deploy, verify/u);
  });

  it("an ending turn that does not report ends the binding, follow-through or not", async () => {
    const t = await working();
    await t.done();
    await t.report({ followThrough: "thr_w1 is watching the deploy." });
    await t.idle(t.steward);
    await t.idle("thr_w1", "Still deploying.");
    // Woken to follow through, and ended without a word.
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
  });

  it("takes an answer to an escalation the ending resolved, once, keeping what the ending said", async () => {
    const t = await working();
    await t.tool("steward_report", { phase: "In Progress", summary: "Building.", nextAction: "Wait", actor: "other", escalate: { kind: "decision", question: "Include SSO?", meanwhile: "Building the rest." } }, t.steward);
    const id = /(esc_[\w-]+) from ENG-12/u.exec(t.sends.filter((x) => x.threadId === t.project).at(-1)!.text)![1]!;
    await t.done();
    await t.report();
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.hooks.store.escalation(id)).toMatchObject({ status: "resolved", resolution: "The binding ended." });

    const answer = { binding: "ENG-12", guidance: "Yes, include SSO.", resolve: id };
    const first = await t.tool("steward_update", answer, t.project);
    expect(first).toMatchObject({ error: false, text: expect.stringMatching(/guidance saved; recorded the answer on esc_[\w-]+, which was already resolved \(The binding ended\.\)/u) });
    // A retry changes nothing and is no error.
    expect(await t.tool("steward_update", answer, t.project)).toMatchObject({ error: false, text: expect.stringMatching(/guidance already saved; esc_[\w-]+ already has this answer/u) });
    expect(t.hooks.store.escalation(id)!.resolution).toBe("The binding ended.\nYes, include SSO.");
    expect(t.hooks.store.find("ENG-12")!.guidance.map((g) => g.text)).toEqual(["Yes, include SSO."]);
  });

  it("takes an answer to a forwarded question the ending closed, on the question and its escalation alike", async () => {
    const t = await working();
    await t.tool("steward_report", { phase: "In Progress", summary: "Building.", nextAction: "Wait", actor: "other", escalate: { kind: "decision", question: "Include SSO?", meanwhile: "Building the rest." } }, t.steward);
    const id = /(esc_[\w-]+) from ENG-12/u.exec(t.sends.filter((x) => x.threadId === t.project).at(-1)!.text)![1]!;
    const qst = /(qst_[\w-]+)/u.exec((await t.tool("steward_update", { binding: "ENG-12", forward: id }, t.project)).text)![1]!;
    await t.done();
    await t.report();
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.hooks.store.question(qst)).toMatchObject({ status: "answered", answer: "The binding ended." });

    const answer = { resolve: qst, answer: "Yes, include SSO." };
    expect(await t.tool("steward_update", answer, t.project)).toMatchObject({ error: false, text: expect.stringMatching(/ENG-12: guidance saved; recorded the answer on esc_[\w-]+, which was already resolved/u) });
    expect(await t.tool("steward_update", answer, t.project)).toMatchObject({ error: false, text: expect.stringMatching(/ENG-12: guidance already saved; esc_[\w-]+ already has this answer/u) });
    expect(t.hooks.store.escalation(id)!.resolution).toBe("The binding ended.\nYes, include SSO.");
    expect(t.hooks.store.question(qst)).toMatchObject({ status: "answered", answer: "The binding ended.\nYes, include SSO." });
  });

  it("takes back the ending when the ticket is moved back before the binding ends", async () => {
    const t = await working();
    await t.done();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const back = t.sends.at(-1)!.text;
    expect(back).toMatch(/came back from a terminal or detached state/u);
    expect(back).toMatch(/reopened before the binding ended: now In Progress/u);
    await t.idle(t.steward);
    expect((await t.list())[0]).toMatchObject({ ended: false });
    expect(t.stops()).toEqual([]);
    expect(t.archives()).toEqual([]);
    // followThrough means nothing outside an ending.
    expect((await t.report({ phase: "In Progress", followThrough: "watch the deploy" })).error).toBe(true);
  });

  it("counts a worker woken again as running, so a detach stops it", async () => {
    const t = await working();
    await t.idle("thr_w1", "Waiting on the review verdict.");
    expect(t.sends.at(-1)!.text).toMatch(/\(thread thr_w1\): finished/u);
    // Its own watch wakes it.
    await t.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_w1" }) });
    await t.flush();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started", labels: [] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends.at(-1)!.text).toMatch(/this binding is detached/u);
    expect(t.stops()).toEqual(["thr_w1"]);
  });
});

describe("the project steward", () => {
  it("is renamed to its project and tagged for thread-briefs when it predates both", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns;
    // As a server that ran an earlier stewards left it: the old title, since
    // rewritten by a summarizer, and no word to thread-briefs on either thread.
    t.hooks.store.patchProject("p1", { title: null });
    t.threads.get(project!.id)!.title = "Project steward triaging steward reports";
    t.metadata.set(project!.id, { role: "project" });
    t.metadata.set(steward!.id, { role: "steward" });

    // A restart's first sweep: nothing tagged yet in this process.
    t.hooks.forgetTags();
    await t.hooks.sweep();
    expect(t.threads.get(project!.id)!.title).toBe("Acme project steward");
    expect(t.metadata.get(project!.id)).toEqual({ role: "project", threadBriefs: { rename: false, group: false, archive: false, ring: false } });
    expect(t.metadata.get(steward!.id)).toEqual({ role: "steward", threadBriefs: { rename: false, group: false, archive: false } });

    // A name given by hand afterwards sticks.
    t.threads.get(project!.id)!.title = "Acme overseer";
    await t.hooks.sweep();
    expect(t.threads.get(project!.id)!.title).toBe("Acme overseer");
  });
});

describe("stewards and the sidebar", () => {
  it("lets go of stewards an earlier version spawned as the project steward's children", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    t.threads.get(steward!)!.parentThreadId = project!;
    t.threads.set("thr_mine", { status: "idle", archivedAt: null, parentThreadId: steward! });

    t.hooks.forgetTags();
    await t.hooks.sweep();
    expect(t.threads.get(steward!)!.parentThreadId).toBeNull();
    expect(t.harness.sdk.callsTo("threads.update").map(([args]) => args)).toContainEqual({ threadId: steward, parentThreadId: null });
    // Only once per run.
    const updates = t.harness.sdk.callsTo("threads.update").length;
    await t.hooks.sweep();
    expect(t.harness.sdk.callsTo("threads.update")).toHaveLength(updates);
  });

  it("puts stewards that predate it in their project's section once, and leaves them where you move them", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Fix logout" }));
    await t.ring("linear", "uuid-12");
    await t.ring("linear", "uuid-13");
    const [project, steward, other] = t.spawns.map((x) => x.id);
    // As an earlier version left them: no section anywhere, one filed by hand.
    t.sections.splice(0);
    t.sections.push({ id: "sec_later", name: "Later" });
    t.hooks.store.patchProject("p1", { sectionId: null });
    t.hooks.db.prepare("DELETE FROM placed_threads").run();
    for (const id of [project!, steward!]) t.threads.get(id)!.sectionId = null;
    t.threads.get(other!)!.sectionId = "sec_later";

    t.hooks.forgetTags();
    await t.hooks.sweep();
    const acme = t.sections.find((s) => s.name === "Acme")!;
    expect(t.threads.get(project!)!.sectionId).toBe(acme.id);
    expect(t.threads.get(steward!)!.sectionId).toBe(acme.id);
    expect(t.threads.get(other!)!.sectionId).toBe("sec_later");

    // Dragged out, renamed: both stick.
    t.threads.get(steward!)!.sectionId = null;
    acme.name = "Acme stewards";
    t.hooks.forgetTags();
    await t.hooks.sweep();
    expect(t.threads.get(steward!)!.sectionId).toBeNull();
    expect(t.sections.map((s) => s.name)).toEqual(["Later", "Acme stewards"]);
  });

  it("does not bring back a section you deleted, and adopts one named after the project", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    t.sections.splice(0);
    t.entities.set("uuid-13", issue({ id: "uuid-13", key: "ENG-13", title: "Fix logout" }));
    await t.ring("linear", "uuid-13");
    expect(t.sections).toEqual([]);
    expect(t.spawns[2]).not.toHaveProperty("sectionId");

    t.sections.push({ id: "sec_mine", name: "Acme" });
    t.entities.set("uuid-14", issue({ id: "uuid-14", key: "ENG-14", title: "Fix signup" }));
    await t.ring("linear", "uuid-14");
    expect(t.spawns[3]).toMatchObject({ sectionId: "sec_mine" });
  });

  it("deletes the section of a project no longer stewarded once it is empty", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    t.files[PROJECT_FILE] = null;
    await t.hooks.sweep();
    // Its stewards are still there, unarchived.
    expect(t.sections).toHaveLength(1);
    for (const thread of t.threads.values()) thread.archivedAt = 1;
    await t.hooks.sweep();
    expect(t.sections).toEqual([]);
    expect(t.hooks.store.project("p1").sectionId).toBeNull();
  });

  it("cuts a long wake in its snapshot, never in what changed", async () => {
    const t = await setup();
    const long = Array.from({ length: 40 }, (_, i) => comment({ id: `c${i}`, body: `${"x".repeat(1400)} ${i}`, createdAt: `2026-10-02T00:${String(i).padStart(2, "0")}:00Z` }));
    t.entities.set("uuid-12", issue({ comments: long }));
    await t.ring("linear", "uuid-12");
    const wake = String(t.spawns[1]!.prompt);
    expect(wake.length).toBeLessThanOrEqual(30_000);
    expect(wake).toMatch(/more characters\)/u);
    expect(wake).toMatch(/## 5\. What changed since your last turn/u);
    expect(wake).toMatch(/End your turn with steward_report/u);
  });
});

describe("pull requests", () => {
  it("gives a teammate's pull request a review steward, and not your own or a draft", async () => {
    const t = await setup();
    t.entities.set("acme/web#7", pull());
    t.entities.set("acme/web#8", pull({ id: "acme/web#8", key: "acme/web#8", author: "jane" }));
    t.entities.set("acme/web#9", pull({ id: "acme/web#9", key: "acme/web#9" }, { draft: true }));
    for (const id of ["acme/web#7", "acme/web#8", "acme/web#9"]) await t.ring("github", id);
    expect(await t.list()).toMatchObject([{ key: "acme/web#7", kind: "review" }]);
    expect(t.spawns[1]).toMatchObject({ title: "Review acme/web#7: Add login retry", model: "claude-haiku-5-5" });
  });

  it("adopts a labelled pull request as a pr binding", async () => {
    const t = await setup();
    t.entities.set("acme/web#7", pull({ labels: ["bb-managed"], author: "jane" }));
    await t.ring("github", "acme/web#7");
    expect(await t.list()).toMatchObject([{ key: "acme/web#7", kind: "pr" }]);
  });

  it("leaves out repos the project file excludes, and says so in check", async () => {
    const t = await setup();
    t.repos.push({ dir: "docs", url: "git@github.com:acme/docs.git" });
    t.files[PROJECT_FILE] = JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, github: { exclude: ["Acme/Docs"] } });
    t.entities.set("acme/docs#3", pull({ id: "acme/docs#3", key: "acme/docs#3", unit: "acme/docs" }));
    t.entities.set("acme/web#7", pull());
    await t.ring("github", "acme/docs#3");
    await t.ring("github", "acme/web#7");
    expect(await t.list()).toMatchObject([{ key: "acme/web#7", kind: "review" }]);
    expect(t.rpcCalls.filter((c) => c.method === "sourceSetInterest" && c.pluginId === "github-watcher").at(-1)?.input).toMatchObject({ units: ["acme/web"] });
    const check = await t.harness.behavior.runCli(["check", "--project", "p1"]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toMatch(/repos: acme\/web \(excluded: Acme\/Docs\)/u);
    const overview = (await t.harness.callRpc("stewardsOverview", null)) as { projects: Array<{ repos: string[]; excludedRepos: string[] }> };
    expect(overview.projects).toMatchObject([{ repos: ["acme/web"], excludedRepos: ["Acme/Docs"] }]);
  });

  it("reports an exclusion that names no repo in repos.json", async () => {
    const t = await setup();
    t.files[PROJECT_FILE] = JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, github: { exclude: ["acme/wbe"] } });
    const check = await t.harness.behavior.runCli(["check", "--project", "p1"]);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toMatch(/problem: github\.exclude names acme\/wbe, not in repos\.json/u);
    expect(check.stdout).toMatch(/repos: acme\/web/u);
  });
});

describe("stewards waiting on others", () => {
  const waiting = { phase: "open", summary: "Reviewed.", nextAction: "Sam addresses the review", actor: "other", blockedOn: "sam" };

  it("archives a review steward after a wake turn that ends waiting, and brings it back on the next", async () => {
    const t = await setup();
    t.entities.set("acme/web#7", pull());
    await t.ring("github", "acme/web#7");
    const steward = t.spawns[1]!.id;

    const report = await t.tool("steward_report", waiting, steward);
    expect(report.text).toMatch(/Your thread is archived when the turn ends/u);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).not.toBeNull();
    expect((await t.list())[0]).toMatchObject({ ended: false, threadId: steward });

    // Sam pushes: the same thread comes back for the round, then goes again.
    t.entities.set("acme/web#7", pull({}, { headSha: "bbbbbbb2" }));
    await t.ring("github", "acme/web#7");
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
    expect(t.sends.at(-1)!.text).toMatch(/Pushed bbbbbbb/u);
    await t.tool("steward_report", waiting, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).not.toBeNull();
    expect(t.spawns).toHaveLength(2);
  });

  it("archives a ticket steward waiting on reviews of its pull requests", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Review", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", { ...waiting, phase: "In Review", blockedOn: "reviewers on acme/web#7" }, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).not.toBeNull();
  });

  it("leaves a steward in the sidebar when the user is next, a worker runs, or an escalation is open", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue({ state: "In Progress", stateType: "started" }));
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;

    await t.tool("steward_report", { ...waiting, actor: "me" }, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();

    // One worker finishes and wakes it while another still runs.
    await t.created("thr_w1", steward);
    await t.created("thr_w2", steward);
    await t.idle("thr_w1", "Done.");
    expect(t.sends.at(-1)!.text).toMatch(/finished its turn/u);
    await t.tool("steward_report", { phase: "In Progress", summary: "Implementing.", nextAction: "Wait for the second worker", actor: "other" }, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
  });

  it("leaves a steward with an open escalation in the sidebar", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", { phase: "Todo", summary: "Spec drafted.", nextAction: "Decide on SSO", actor: "other", escalate: { kind: "decision", question: "Include SSO?", meanwhile: "Wait." } }, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
  });

  it("does not archive a turn the user started", async () => {
    const t = await setup();
    t.entities.set("acme/web#7", pull());
    await t.ring("github", "acme/web#7");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", waiting, steward);
    await t.idle(steward);
    // The user brings it back to talk to it; its report then is theirs to read.
    t.threads.get(steward)!.archivedAt = null;
    await t.tool("steward_report", waiting, steward);
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
  });

  it("archives after compaction rather than during it", async () => {
    const t = await setup();
    t.entities.set("acme/web#7", pull());
    await t.ring("github", "acme/web#7");
    const steward = t.spawns[1]!.id;
    await t.tool("steward_report", waiting, steward);
    t.usage.set(steward, 500_000);
    await t.idle(steward);
    expect(t.harness.sdk.callsTo("threads.compact")).toHaveLength(1);
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
    // Compaction ends in another idle.
    await t.idle(steward);
    expect(t.threads.get(steward)!.archivedAt).not.toBeNull();
  });
});

describe("passes", () => {
  it("adopts at most perPass per sweep, oldest first", async () => {
    const t = await setup();
    t.files[PROJECT_FILE] = JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, adoption: { perPass: 2 }, reviews: { enabled: false } });
    for (const [i, day] of [3, 1, 2].entries()) t.entities.set(`u${i}`, issue({ id: `u${i}`, key: `ENG-${i}`, createdAt: `2026-10-0${day}T00:00:00Z` }));
    await t.hooks.sweep();
    await t.flush();
    expect((await t.list()).map((b) => b.key).sort()).toEqual(["ENG-1", "ENG-2"]);
  });

  it("gives every binding a nightly turn, then keeps the project steward's reply as the digest", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns;
    await t.hooks.nightlyPass("p1", "manual");
    await t.flush();
    expect(t.sends.find((s) => s.threadId === steward!.id)?.text).toMatch(/nightly reconcile pass/u);
    expect(t.sends.find((s) => s.threadId === project!.id)?.text).toMatch(/reply with the morning digest/u);
    await t.idle(project!.id, "All quiet.");
    expect((await t.harness.behavior.runCli(["digest", "--project", "p1"])).stdout).toMatch(/All quiet\./u);
  });

  it("keeps running a playbook under its last good version when an edit breaks it", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    t.files[playbookPath("linear-tickets")] = "broken";
    const check = await t.harness.behavior.runCli(["check", "--project", "p1"]);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toMatch(/linear-tickets\.md has no YAML front matter/u);
    expect(check.stdout).toMatch(/keep running under the last good linear-tickets/u);
    expect(check.stdout).toMatch(/ticket: linear-tickets@/u);
  });
});

describe("bb stewards init", () => {
  it("writes on the thread's own machine", async () => {
    const t = await setup();
    t.threads.set("thr_me", { status: "active", archivedAt: null, hostId: "host_me" });
    const out = await t.harness.behavior.runCli(["init", "--teams", "eng"], { threadId: "thr_me", projectId: "p1", cwd: "/w" });
    expect(out.exitCode).toBe(0);
    expect(t.writes).toContainEqual({ path: `/w/.bb/${PROJECT_FILE}`, hostId: "host_me" });
    expect(t.writes).toContainEqual({ path: `/w/.bb/${playbookPath("ops-watch")}`, hostId: "host_me" });
    expect(t.writes.every((w) => w.hostId === "host_me")).toBe(true);
  });

  it("writes on the project's machine when the thread names none, never on the server's own", async () => {
    const t = await setup();
    t.threads.set("thr_me", { status: "active", archivedAt: null });
    await t.harness.behavior.runCli(["init", "--teams", "ENG"], { threadId: "thr_me", projectId: "p1", cwd: "/w" });
    expect(t.writes.length).toBe(5);
    expect(t.writes.every((w) => w.hostId === "host_on")).toBe(true);
  });
});

describe("questions to the user", () => {
  type Board = {
    projects: Array<{ projectId: string; name: string }>;
    board: {
      stages: string[];
      digest: { text: string; at: number } | null;
      questions: Array<{ id: string; question: string; key: string | null; escalationId: string | null }>;
      withUser: Array<{ id: string; kind: string }>;
      stewards: Array<{ key: string; stage: string | null; summary: string | null; nextAction: string | null; actor: string | null; workers: Array<{ threadId: string; title: string }> }>;
      stuck: Array<{ key: string; why: string }>;
      ended: Array<{ key: string; endReason: string | null }>;
    } | null;
  };
  const client = { experimental_caller: { kind: "client" } } as const;

  async function adopted() {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id) as [string, string];
    const board = async () => ((await t.harness.callRpc("stewardsBoard", { projectId: "p1" })) as Board).board!;
    const qid = (text: string) => /(qst_[\w-]+)/u.exec(text)![1]!;
    return { ...t, project, steward, board, qid };
  }

  it("are recorded by the project steward with ask, bound or not, and closed with resolve and the answer", async () => {
    const t = await adopted();
    const unbound = await t.tool("steward_update", { ask: { question: "Should I file an a11y ticket?", context: "Two contrast failures in review." } }, t.project);
    expect(unbound).toMatchObject({ error: false, text: expect.stringMatching(/question qst_\S+ recorded: ask the user in your reply/u) });
    const bound = await t.tool("steward_update", { binding: "ENG-12", ask: { question: "Keep the old login page?" } }, t.project);
    expect(bound.text).toMatch(/recorded about ENG-12/u);
    expect((await t.board()).questions).toMatchObject([
      { id: t.qid(unbound.text), question: "Should I file an a11y ticket?", key: null },
      { id: t.qid(bound.text), key: "ENG-12" },
    ]);

    // Only the project steward keeps questions; a steward escalates.
    expect((await t.tool("steward_update", { ask: { question: "Mine?" } }, t.steward)).error).toBe(true);
    // Nothing else is done without a binding.
    expect((await t.tool("steward_update", { priority: "high" }, t.project)).text).toMatch(/Name the binding/u);
    expect((await t.tool("steward_update", { resolve: t.qid(unbound.text) }, t.project)).text).toMatch(/Give the user's answer/u);

    const closed = await t.tool("steward_update", { resolve: t.qid(unbound.text), answer: "Yes, file it in BB." }, t.project);
    expect(closed).toMatchObject({ error: false, text: `closed ${t.qid(unbound.text)}.` });
    // A retry of the same close is no error and changes nothing.
    expect(await t.tool("steward_update", { resolve: t.qid(unbound.text), answer: "Yes, file it in BB." }, t.project)).toMatchObject({ error: false, text: `${t.qid(unbound.text)} already closed with this answer.` });
    expect((await t.tool("steward_update", { resolve: t.qid(unbound.text), answer: "Again." }, t.project)).text).toMatch(/already closed/u);
    // Guidance on a question about the whole project has no binding to land on: the question closes all the same.
    const project = await t.tool("steward_update", { ask: { question: "Adopt the new lint rules?" } }, t.project);
    expect(await t.tool("steward_update", { resolve: t.qid(project.text), answer: "Yes.", guidance: "Lint rules apply to new code." }, t.project)).toMatchObject({
      error: false,
      text: `closed ${t.qid(project.text)} (guidance not saved: it is kept per binding, so name one with binding to give it).`,
    });
    // Guidance with a bound question's answer lands on its binding.
    expect((await t.tool("steward_update", { resolve: t.qid(bound.text), guidance: "Remove the old login page." }, t.project)).text).toMatch(/ENG-12: closed qst_\S+; guidance saved/u);
    expect((await t.board()).questions).toEqual([]);

    // The next wake lists what is still open, and only that.
    const third = await t.tool("steward_update", { ask: { question: "Freeze on Friday?" } }, t.project);
    await t.tool("steward_report", { phase: "Todo", summary: "Scope unclear.", nextAction: "Wait", actor: "other", escalate: { kind: "scope", question: "Include SSO?", meanwhile: "Wait." } }, t.steward);
    const wake = t.sends.filter((s) => s.threadId === t.project).at(-1)!.text;
    expect(wake).toContain(`- ${t.qid(third.text)} (asked 2026-10-14): Freeze on Friday?`);
    expect(wake).not.toContain("a11y");
  });

  it("is made when the project steward forwards an escalation, and closes when it is resolved", async () => {
    const t = await adopted();
    await t.tool("steward_report", { phase: "Todo", summary: "Scope unclear.", nextAction: "Wait", actor: "other", escalate: { kind: "scope", question: "Include SSO?", meanwhile: "Wait." } }, t.steward);
    const esc = /(esc_[\w-]+) from ENG-12/u.exec(t.sends.filter((s) => s.threadId === t.project).at(-1)!.text)![1]!;
    const forwarded = await t.tool("steward_update", { binding: "ENG-12", forward: esc, recommendation: "Leave SSO out." }, t.project);
    expect(forwarded.text).toMatch(/forwarded esc_\S+ to the user as question qst_/u);
    const [q] = (await t.board()).questions;
    expect(q).toMatchObject({ id: t.qid(forwarded.text), question: "Include SSO?", key: "ENG-12", escalationId: esc });
    // Listed once on the page, as its question.
    expect((await t.board()).withUser).toEqual([]);

    await t.tool("steward_update", { binding: "ENG-12", guidance: "SSO is out of scope.", resolve: esc }, t.project);
    expect((await t.board()).questions).toEqual([]);
  });

  it("closing a forwarded question with resolve decides its escalation and tells the steward", async () => {
    const t = await adopted();
    await t.tool("steward_report", { phase: "Todo", summary: "Scope unclear.", nextAction: "Wait", actor: "other", escalate: { kind: "scope", question: "Include SSO?", meanwhile: "Wait." } }, t.steward);
    const esc = /(esc_[\w-]+) from ENG-12/u.exec(t.sends.filter((s) => s.threadId === t.project).at(-1)!.text)![1]!;
    const qst = t.qid((await t.tool("steward_update", { binding: "ENG-12", forward: esc }, t.project)).text);
    const closed = await t.tool("steward_update", { resolve: qst, answer: "No SSO for now." }, t.project);
    expect(closed).toMatchObject({ error: false, text: expect.stringMatching(new RegExp(`ENG-12: guidance saved; resolved ${esc}`, "u")) });
    await t.flush();
    expect(t.sends.filter((s) => s.threadId === t.steward).at(-1)!.text).toMatch(/decided: No SSO for now\./u);
    const list = (await t.harness.behavior.runCli(["show", "ENG-12", "--project", "p1"])).stdout;
    expect(list).toMatch(/\(resolved, me\): Include SSO\? → No SSO for now\./u);

    // A retry is no error, records nothing twice, and does not tell the steward again.
    const told = t.sends.filter((s) => s.threadId === t.steward).length;
    expect(await t.tool("steward_update", { resolve: qst, answer: "No SSO for now." }, t.project)).toMatchObject({ error: false, text: `ENG-12: guidance already saved; ${esc} already has this answer.` });
    await t.flush();
    expect(t.sends.filter((s) => s.threadId === t.steward)).toHaveLength(told);
    expect(t.hooks.store.question(qst)).toMatchObject({ status: "answered", answer: "No SSO for now." });
    expect(t.hooks.store.escalation(esc)!.resolution).toBe("No SSO for now.");
    expect(t.hooks.store.find("ENG-12")!.guidance.map((g) => g.text)).toEqual(["No SSO for now."]);
  });

  it("is closed by the user from the page, which resolves a forwarded escalation and tells its steward", async () => {
    const t = await adopted();
    await t.tool("steward_report", { phase: "Todo", summary: "Scope unclear.", nextAction: "Wait", actor: "other", escalate: { kind: "scope", question: "Include SSO?", meanwhile: "Wait." } }, t.steward);
    const esc = /(esc_[\w-]+) from ENG-12/u.exec(t.sends.filter((s) => s.threadId === t.project).at(-1)!.text)![1]!;
    const qst = t.qid((await t.tool("steward_update", { binding: "ENG-12", forward: esc }, t.project)).text);

    await expect(t.harness.callRpc("stewardsAnswerQuestion", { questionId: qst, answer: "x" }, { experimental_caller: { kind: "plugin", pluginId: "linear" } })).rejects.toThrow(/by the user/u);
    expect(await t.harness.callRpc("stewardsAnswerQuestion", { questionId: qst, answer: "Leave SSO out." }, client)).toMatchObject({ ok: true, message: expect.stringMatching(/ENG-12's steward has been told/u) });
    expect(await t.harness.callRpc("stewardsAnswerQuestion", { questionId: qst, answer: null }, client)).toMatchObject({ ok: false });
    await t.flush();
    expect(t.sends.filter((s) => s.threadId === t.steward).at(-1)!.text).toMatch(/decided by the user: Leave SSO out\./u);
    expect((await t.list())[0]!.escalations).toBe(0);

    // A plain question closes without an answer too.
    const plain = t.qid((await t.tool("steward_update", { ask: { question: "Freeze on Friday?" } }, t.project)).text);
    expect(await t.harness.callRpc("stewardsAnswerQuestion", { questionId: plain, answer: null }, client)).toMatchObject({ ok: true, message: "Closed." });
    expect((await t.board()).questions).toEqual([]);
  });

  it("the page shows a project's board: waiting on you, in flight by stage with workers, stuck or held, ended, and the digest", async () => {
    const t = await adopted();
    await t.tool("steward_update", { ask: { question: "Should I file an a11y ticket?" } }, t.project);
    await t.tool("steward_report", { phase: "Todo", summary: "Spec drafted.", nextAction: "Ask the reviewer", actor: "steward" }, t.steward);
    await t.created("thr_w1", t.steward, "Implement retry");
    await t.tool("steward_update", { binding: "ENG-12", hold: "billing freeze" }, t.project);
    await t.hooks.nightlyPass("p1", "manual");
    await t.flush();
    await t.idle(t.project, "Morning: ENG-12 is held.");

    const result = (await t.harness.callRpc("stewardsBoard", { projectId: null })) as Board;
    expect(result.projects).toEqual([{ projectId: "p1", name: "Acme" }]);
    const b = result.board!;
    expect(b.questions).toMatchObject([{ question: "Should I file an a11y ticket?" }]);
    expect(b.stages).toEqual(["spec", "build", "review"]);
    expect(b.stewards).toMatchObject([{ key: "ENG-12", stage: "spec", summary: "Spec drafted.", nextAction: "Ask the reviewer", actor: "steward", workers: [{ threadId: "thr_w1", title: "Implement retry" }] }]);
    expect(b.stuck).toEqual([expect.objectContaining({ key: "ENG-12", why: "On hold: billing freeze" })]);
    expect(b.digest).toMatchObject({ text: "Morning: ENG-12 is held." });
    expect(((await t.harness.callRpc("stewardsBoard", { projectId: "nope" })) as Board).board).toBeNull();
  });

  it("the nightly wake carries the previous digest and the record since it", async () => {
    const t = await adopted();
    await t.hooks.nightlyPass("p1", "first");
    await t.flush();
    await t.idle(t.project, "PR #429 still waits for approval.");
    t.advance(60_000);
    await t.tool("steward_report", { phase: "Todo", summary: "PR #429 merged.", nextAction: "Verify the deploy", actor: "steward" }, t.steward);
    await t.tool("steward_update", { ask: { question: "Should I file an a11y ticket?" } }, t.project);
    t.advance(60_000);
    await t.hooks.nightlyPass("p1", "second");
    await t.flush();
    const wake = t.sends.filter((s) => s.threadId === t.project).at(-1)!.text;
    expect(wake).toMatch(/### Your previous digest \(2026-10-14T15:00:00Z\)\n\n> PR #429 still waits for approval\./u);
    expect(wake).toMatch(/### What moved\n\n- ENG-12 \(ticket, Todo\), moved 2026-10-14T15:01:00Z: PR #429 merged\. Next: Verify the deploy \(steward\)/u);
    expect(wake).toMatch(/### Waiting on the user\n\n- Question qst_\S+ \(since 2026-10-14\): Should I file an a11y ticket\?/u);
  });
});

describe("the settings page", () => {
  type Overview = { paused: boolean; projects: Array<{ name: string; configured: boolean; repos: string[]; playbooks: Array<{ kind: string; version: string | null }>; problems: string[]; projectStewardThreadId: string | null; stewards: Array<{ key: string; summary: string | null; actor: string | null; escalations: Array<{ route: string; question: string }> }> }> };

  it("shows each stewarded project's configuration and its open stewards with their status", async () => {
    const t = await setup();
    const empty = (await t.harness.callRpc("stewardsOverview", null)) as Overview;
    expect(empty.projects).toMatchObject([{ name: "Acme", configured: true, repos: ["acme/web"], problems: [], projectStewardThreadId: null, stewards: [] }]);
    expect(empty.projects[0]!.playbooks.map((p) => p.kind)).toEqual(["ticket", "pr", "review"]);

    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const [project, steward] = t.spawns.map((x) => x.id);
    await t.tool("steward_report", { phase: "Todo", summary: "Spec drafted.", nextAction: "Decide on SSO", actor: "other", escalate: { kind: "decision", question: "Include SSO?", meanwhile: "Wait." } }, steward!);

    const overview = (await t.harness.callRpc("stewardsOverview", null)) as Overview;
    expect(overview.paused).toBe(false);
    expect(overview.projects[0]).toMatchObject({ projectStewardThreadId: project, stewards: [{ key: "ENG-12", summary: "Spec drafted.", actor: "other", escalations: [{ route: "project", question: "Include SSO?" }] }] });
  });

  it("reports a broken playbook as a problem and the check runs from the page", async () => {
    const t = await setup();
    t.files[playbookPath("github-prs")] = "broken";
    const overview = (await t.harness.callRpc("stewardsOverview", null)) as Overview;
    expect(overview.projects[0]!.problems.join("\n")).toMatch(/github-prs\.md has no YAML front matter/u);
    expect(overview.projects[0]!.playbooks.find((p) => p.kind === "pr")!.version).toBeNull();
    const check = (await t.harness.callRpc("stewardsCheck", { projectId: "p1" })) as { ok: boolean; lines: string[] };
    expect(check.ok).toBe(false);
  });
});

describe("ops stewards", () => {
  const TARGET = "k8s-namespace/bb-gate-production";
  const FP = `${TARGET}/bb-gate-router/router#CrashLoopBackOff:Error:1`;

  /** A fake kubectl on the project's machine, serving one namespace, recording every call. */
  function cluster() {
    const state = { pods: [] as unknown[], events: [] as unknown[], unreachable: false, logs: true, deployments: true, writes: false };
    const calls: Array<{ args: string[]; hostId: string | null }> = [];
    const kubectl = async (args: string[], where: { hostId: string | null }): Promise<KubectlResult> => {
      calls.push({ args, hostId: where.hostId });
      const ok = (stdout: string): KubectlResult => ({ exitCode: 0, stdout, stderr: "" });
      const fail = (stderr: string, exitCode = 1): KubectlResult => ({ exitCode, stdout: "", stderr });
      if (state.unreachable) return fail("Unable to connect to the server: dial tcp: lookup bc-prod.example.ts.net: no such host");
      const a = args.filter((x) => !x.startsWith("--request-timeout") && !x.startsWith("--context"));
      const names = (items: unknown[]) => items.map((i, n) => `${a[1]}/${(i as { metadata?: { name: string } }).metadata?.name ?? n}`).join("\n");
      if (a[0] === "get") {
        const items = a[1] === "pods" ? state.pods : a[1] === "events" ? state.events : [{ metadata: { name: "bb-gate-router" }, spec: { replicas: 1 }, status: { readyReplicas: 0 } }];
        if (a[1] === "deployments" && !state.deployments) return fail('Error from server (Forbidden): deployments.apps is forbidden: User "jane@acme.com" cannot list resource "deployments"');
        return ok(a.includes("json") ? JSON.stringify({ items }) : names(items));
      }
      if (a[0] === "logs") return state.logs ? ok("starting router\npanic: listen tcp :8080: address already in use\n") : fail('Error from server (Forbidden): pods "x" is forbidden: User cannot get resource "pods/log"');
      if (a[0] === "auth") return a[3] === "pods/log" ? (state.logs ? ok("yes\n") : { exitCode: 1, stdout: "no\n", stderr: "" }) : state.writes ? ok("yes\n") : { exitCode: 1, stdout: "no\n", stderr: "" };
      return fail(`unexpected kubectl ${args.join(" ")}`);
    };
    return { state, calls, kubectl };
  }

  const opsProject = (targets: string[] = ["bb-gate-production"], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: targets.map((name) => ({ kind: "k8s-namespace", name })), ...extra } });

  async function watched(over: { unreachable?: boolean } = {}) {
    const c = cluster();
    const t = await setup({ kubectl: c.kubectl });
    t.files[PROJECT_FILE] = opsProject();
    t.files[playbookPath("ops-watch")] = OPS_WATCH;
    c.state.pods = [crashingPod()];
    c.state.events = [warningEvent("bb-gate-router-6d4f9c7b8-x2k4q")];
    if (over.unreachable === true) c.state.unreachable = true;
    await t.hooks.sweep();
    await t.flush();
    const steward = () => t.spawns.find((x) => String(x.title).startsWith("Ops watch"));
    const wakes = () => {
      const id = steward()?.id;
      return id === undefined ? [] : [String(steward()!.prompt), ...t.sends.filter((x) => x.threadId === id).map((x) => x.text)];
    };
    return { t, c, steward, wakes };
  }

  it("watches a configured target, files one ticket for a crash loop, and comments on it while it keeps crashing", async () => {
    const { t, c, steward, wakes } = await watched();
    const [project] = t.spawns;
    const ops = steward()!;
    // A binding of its own, reporting to the project steward, in the list and on the page.
    expect(await t.list()).toMatchObject([{ key: TARGET, kind: "ops", threadId: ops.id, ended: false }]);
    expect(ops).toMatchObject({ title: "Ops watch: bb-gate-production", sectionId: "sec_1", environment: { type: "reuse", environmentId: "env1" }, model: "claude-sonnet-5-5" });
    const board = (await t.harness.callRpc("stewardsBoard", { projectId: "p1" })) as { board: { stewards: Array<{ key: string; kind: string; stage: string | null }> } };
    expect(board.board.stewards).toEqual([expect.objectContaining({ key: TARGET, kind: "ops", stage: "watch" })]);

    const first = wakes()[0]!;
    expect(first).toMatch(/^# Ops watch: k8s-namespace\/bb-gate-production/u);
    expect(first).toMatch(/You have just been made the ops steward/u);
    expect(first).toContain(`#### ${FP}`);
    expect(first).toMatch(/### New: no ticket yet/u);
    expect(first).toMatch(/File one ticket per problem/u);
    expect(first).not.toMatch(/### Recurring/u);
    expect(first).toMatch(/BackOff ×12: Back-off restarting failed container router/u);
    // The crashed run's last log lines, read with kubectl as the developer.
    expect(first).toMatch(/Last log lines of the run that ended:\n\n```\nstarting router\npanic: listen tcp :8080: address already in use\n```/u);
    // Every kubectl call ran on the project's machine, and only get, logs and auth can-i.
    expect(c.calls.length).toBeGreaterThan(0);
    expect(c.calls.every((x) => x.hostId === "host_on" && kubectlRefusal(x.args) === null)).toBe(true);
    expect(c.calls.map((x) => x.args.slice(0, 2).join(" "))).toEqual(expect.arrayContaining(["get pods", "get events", "get deployments", "logs bb-gate-router-6d4f9c7b8-x2k4q"]));
    expect(c.calls.find((x) => x.args[0] === "logs")!.args).toEqual(["logs", "bb-gate-router-6d4f9c7b8-x2k4q", "-n", "bb-gate-production", "-c", "router", "--tail=60", "--previous", "--request-timeout=20s"]);
    expect(first).toMatch(/File tickets in the Linear team ENG/u);
    expect(first).toMatch(/Allowed actions: kubectl get, kubectl describe, kubectl logs, kubectl auth can-i, file-ticket, comment, escalate\./u);

    // A fingerprint it has not seen is refused, and nothing is recorded.
    const base = { phase: "watching", summary: "router crash-looping; filed ENG-50", nextAction: "Watch", actor: "steward" };
    const wrong = await t.tool("steward_report", { ...base, opsTickets: [{ fingerprint: "made-up", ticket: "ENG-50", did: "filed" }] }, ops.id);
    expect(wrong).toMatchObject({ error: true, text: expect.stringMatching(/"made-up" is not a fingerprint/u) });
    expect(wrong.text).toContain(FP);
    expect(t.hooks.store.fingerprint("p1", FP)).toMatchObject({ ticketKey: null });

    // It files, and escalates once to the project steward, which hears how to adopt.
    const report = await t.tool(
      "steward_report",
      { ...base, opsTickets: [{ fingerprint: FP, ticket: "ENG-50", did: "filed" }], escalate: { kind: "decision", question: "Filed ENG-50 (high): bb-gate-router crash-loops on start. Recommend adopting.", meanwhile: "Keep watching." } },
      ops.id,
    );
    expect(report).toMatchObject({ error: false, text: expect.stringMatching(/Recorded ENG-50 \(filed\) against its fingerprint/u) });
    expect(t.hooks.store.fingerprint("p1", FP)).toMatchObject({ ticketKey: "ENG-50" });
    const told = t.sends.filter((x) => x.threadId === project!.id).at(-1)!.text;
    expect(told).toMatch(/New escalations routed to you/u);
    expect(told).toMatch(/from k8s-namespace\/bb-gate-production \(decision\): Filed ENG-50/u);
    expect(told).toMatch(/An escalation from an ops steward .* add the label `bb-managed` and move it to Todo/u);

    // Another look before the requeue, still crashing: nothing new, nobody woken.
    t.entities.set("ENG-50", issue({ id: "ENG-50", key: "ENG-50", title: "bb-gate-router crash-loops", labels: [], state: "Triage", stateType: "triage" }));
    const before = wakes().length;
    await t.hooks.sweep();
    await t.flush();
    expect(wakes()).toHaveLength(before);

    // At the requeue, the same problem is a comment on ENG-50: recurring, and no new ticket.
    t.advance(61 * 60_000);
    await t.hooks.sweep();
    await t.flush();
    const again = wakes().at(-1)!;
    expect(wakes()).toHaveLength(before + 1);
    expect(again).toMatch(/### Recurring: its ticket is open/u);
    expect(again).toMatch(/ticket ENG-50 \(Triage\)/u);
    expect(again).toMatch(/Comment on that ticket/u);
    expect(again).toMatch(/File nothing new/u);
    expect(again).not.toMatch(/### New/u);
    expect(again).toMatch(/Requeue time came, with problems still failing/u);
    expect((await t.tool("steward_report", { ...base, opsTickets: [{ fingerprint: FP, ticket: "ENG-50", did: "commented" }] }, ops.id)).error).toBe(false);
    expect(t.hooks.store.fingerprints(t.hooks.store.find(TARGET)!.id)).toMatchObject([{ fingerprint: FP, ticketKey: "ENG-50", lastCommentedAt: t.now() }]);

    // The project steward adopts it the usual way (label and Todo); the team lease brings a ticket steward.
    t.entities.set("ENG-50", issue({ id: "ENG-50", key: "ENG-50", title: "bb-gate-router crash-loops", labels: ["bb-managed"], state: "Todo" }));
    await t.ring("linear", "ENG-50");
    expect(await t.list()).toEqual(expect.arrayContaining([expect.objectContaining({ key: "ENG-50", kind: "ticket" })]));

    // Done, and the router crashes again: back at once, for the playbook to reopen or file anew.
    t.entities.set("ENG-50", issue({ id: "ENG-50", key: "ENG-50", labels: ["bb-managed"], state: "Done", stateType: "completed" }));
    await t.hooks.sweep();
    await t.flush();
    const back = wakes().at(-1)!;
    expect(back).toMatch(/### Returned: its ticket was resolved/u);
    expect(back).toMatch(/Back after ENG-50 was resolved \(Done\)/u);
    expect(back).toMatch(/escalate\s+a decision recommending it be reopened/u);
  });

  it("takes a short turn at every requeue when all is healthy, and none between", async () => {
    const { t, c, steward, wakes } = await watched();
    c.state.pods = [];
    c.state.events = [];
    const ops = steward()!;
    expect((await t.tool("steward_report", { phase: "watching", summary: "Filed ENG-50.", nextAction: "Watch", actor: "other" }, ops.id)).error).toBe(false);
    await t.idle(ops.id);
    const before = wakes().length;

    // A sweep's look before the requeue: healthy, nothing new, nobody woken.
    t.advance(30 * 60_000);
    await t.hooks.sweep();
    await t.flush();
    expect(wakes()).toHaveLength(before);

    // The requeue is a turn all the same, saying so, and its report archives the thread until the next.
    t.advance(31 * 60_000);
    await t.hooks.sweep();
    await t.flush();
    expect(wakes()).toHaveLength(before + 1);
    const healthy = wakes().at(-1)!;
    expect(healthy).toMatch(/All healthy: nothing is failing\./u);
    expect(healthy).toMatch(/Requeue time came: a scheduled look/u);
    expect(healthy).not.toMatch(/#### /u);
    const report = await t.tool("steward_report", { phase: "watching", summary: "All healthy.", nextAction: "Look again", actor: "other" }, ops.id);
    expect(report.text).toMatch(/Your thread is archived when the turn ends/u);
  });

  it("makes a binding that waits while kubectl cannot read its target, and wakes once it can", async () => {
    const { t, c, steward } = await watched({ unreachable: true });
    expect(await t.list()).toMatchObject([{ key: TARGET, kind: "ops", threadId: null }]);
    expect(steward()).toBeUndefined();
    const listed = await t.harness.behavior.runCli(["list"], { projectId: "p1" });
    expect(listed.stdout).toMatch(/cannot read the target: Unable to connect to the server: dial tcp: lookup bc-prod\.example\.ts\.net: no such host/u);

    c.state.unreachable = false;
    await t.hooks.sweep();
    await t.flush();
    expect(steward()).toBeDefined();
    expect(String(steward()!.prompt)).toMatch(/You have just been made the ops steward/u);
  });

  it("ends with its target's removal from the project file, and resumes the same thread when it is back", async () => {
    const { t, steward, wakes } = await watched();
    const id = steward()!.id;
    t.files[PROJECT_FILE] = opsProject([]);
    await t.hooks.sweep();
    await t.flush();
    expect(await t.list()).toMatchObject([{ key: TARGET, ended: true }]);
    expect(t.threads.get(id)!.archivedAt).not.toBeNull();

    t.files[PROJECT_FILE] = opsProject();
    await t.hooks.sweep();
    await t.flush();
    expect(await t.list()).toMatchObject([{ key: TARGET, ended: false, threadId: id }]);
    expect(t.threads.get(id)!.archivedAt).toBeNull();
    expect(wakes().at(-1)).toMatch(/configured again and its binding has resumed/u);
    expect(t.spawns.filter((x) => String(x.title).startsWith("Ops watch"))).toHaveLength(1);
  });

  it("is checked: a target kubectl cannot reach is a problem; writes the developer holds are only said", async () => {
    const { t, c } = await watched();
    const check = () => t.harness.behavior.runCli(["check"], { projectId: "p1" });
    c.state.unreachable = true;
    const none = await check();
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toMatch(/ops: tickets filed in ENG/u);
    expect(none.stdout).toMatch(/ops: kubectl runs on host_on, in its current context/u);
    expect(none.stdout).toMatch(/problem: ops: cannot read the target k8s-namespace\/bb-gate-production: Unable to connect to the server/u);
    expect(none.stdout).toMatch(/^ops: ops-watch@/mu);

    c.state.unreachable = false;
    c.state.logs = false;
    c.state.deployments = false;
    const readable = await check();
    expect(readable.stdout).not.toMatch(/problem:/u);
    expect(readable.exitCode).toBe(0);
    expect(readable.stdout).toMatch(/ops: k8s-namespace\/bb-gate-production is readable \(get pods, get events\); logs not readable, so diagnosis is from status and events/u);
    expect(readable.stdout).toMatch(/cannot get deployments \(Error from server \(Forbidden\): deployments\.apps is forbidden.*\); looks go without it/u);

    // kubectl acts as the developer, whose rights are broad: said, not a problem.
    c.state.writes = true;
    const writable = await check();
    expect(writable.exitCode).toBe(0);
    expect(writable.stdout).toMatch(/this identity may also delete pods, create pods\/exec, patch deployments; the plugin and the playbook keep to get, describe, logs, auth can-i/u);
    expect(c.calls.every((x) => kubectlRefusal(x.args) === null)).toBe(true);

    // A project file whose ops section is wrong is a problem too.
    t.files[PROJECT_FILE] = opsProject(["bb-gate-production"], { team: "SALES" });
    expect((await check()).stdout).toMatch(/problem: stewards\/project\.json: ops\.team: SALES is not one of linear\.teams/u);
    // A context, when named, is passed on every call.
    t.files[PROJECT_FILE] = opsProject(["bb-gate-production"], { context: "bc-prod" });
    expect((await check()).stdout).toMatch(/kubectl runs on host_on, in context bc-prod/u);
    expect(c.calls.at(-1)!.args.at(-1)).toBe("--context=bc-prod");
  });

  it("runs kubectl through its host entry on the project's machine by default", async () => {
    const t = await setup();
    t.files[PROJECT_FILE] = opsProject();
    t.files[playbookPath("ops-watch")] = OPS_WATCH;
    await t.hooks.sweep();
    await t.flush();
    const calls = t.harness.experimental_hostRpcCalls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({ method: "opsKubectl", hostId: "host_on", input: { args: ["get", "pods", "-n", "bb-gate-production", "-o", "json", "--request-timeout=20s"] } });
    expect(calls.every((x) => kubectlRefusal((x.input as { args: string[] }).args) === null)).toBe(true);
  });

  it("gives an ops steward its own instructions, and refuses opsTickets from any other steward", async () => {
    const { t, steward } = await watched();
    const config = await t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: steward()!.id, title: null, parentThreadId: null, sourceThreadId: null } }));
    expect(config.instructions).toMatch(/You are the ops steward watching "k8s-namespace\/bb-gate-production"/u);
    expect(config.instructions).toMatch(/never change production and start no workers/u);

    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const ticketSteward = t.spawns.find((x) => x.title === "ENG-12: Fix login")!.id;
    const r = await t.tool("steward_report", { phase: "Todo", summary: "x", nextAction: "y", actor: "steward", opsTickets: [{ fingerprint: FP, ticket: "ENG-50", did: "filed" }] }, ticketSteward);
    expect(r).toMatchObject({ error: true, text: expect.stringMatching(/opsTickets is for an ops steward's report/u) });
  });
});
