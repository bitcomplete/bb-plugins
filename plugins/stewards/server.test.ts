import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PROJECT_FILE, playbookPath } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { createStewardsPlugin, testHooks } from "./server.js";
import { SOURCE_PLUGIN_IDS, type EntitySnapshot } from "./source-contract.js";
import { GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, projectFileTemplate } from "./templates.js";

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
  const threads = new Map<string, { status: string; archivedAt: number | null; title?: string | null; parentThreadId?: string | null }>();
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
    hosts: { list: async () => [{ id: "host_off", status: "disconnected" }, { id: "host_on", status: "connected" }] },
    threadSections: { list: async () => [], create: async () => ({ id: "sec1", name: "Managed" }) },
    threads: {
      spawn: async (args: Record<string, unknown>) => {
        const id = `thr_${++n}`;
        threads.set(id, { status: "idle", archivedAt: null, title: (args.title as string | undefined) ?? null });
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
        return makeThreadResponse({ id: threadId, title: t.title ?? null, status: t.status as never, archivedAt: t.archivedAt, environmentId: "env1", providerId: "claude-code", parentThreadId: t.parentThreadId ?? null });
      },
      archive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = 1;
        return {};
      },
      unarchive: async ({ threadId }: { threadId: string }) => {
        threads.get(threadId)!.archivedAt = null;
        return {};
      },
      stop: async () => ({}),
      update: async (args: { threadId: string; title?: string; parentThreadId?: string | null }) => {
        const t = threads.get(args.threadId);
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
  return { files, repos, entities, rpcCalls, threads, usage, metadata, spawns, sends, userTurns, sdk, now: () => now, advance: (ms: number) => (now += ms) };
}

async function setup() {
  const w = world();
  const { bb, harness } = createFakePluginHost({ pluginId: "stewards", sdk: w.sdk as never, agentSkillIds: ["stewards"] });
  await createStewardsPlugin({ now: w.now, timing: { debounceMs: 1, nightlyStaggerMs: 0 } })(bb);
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
    // thread-briefs keeps its hands off: no renames, auto-archiving or row ring for any steward, and no grouping for the project steward.
    expect(project).toMatchObject({ pluginMetadata: { role: "project", threadBriefs: { rename: false, group: false, archive: false } } });
    // On the project's machine, never core's "project-default" (the server's own, which may have no daemon).
    expect(project).toMatchObject({ environment: { type: "provider", environmentProviderId: "multi-repo-workspace", machine: { type: "existing", hostId: "host_on" } } });
    // No sidebar sections or pins: the sidebar is the user's.
    expect(project).not.toHaveProperty("pinned");
    expect(steward).not.toHaveProperty("sectionId");
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
    expect(t.metadata.get(project!.id)).toEqual({ role: "project", threadBriefs: { rename: false, group: false, archive: false } });
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
