import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PROJECT_FILE, playbookPath } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { createStewardsPlugin, testHooks } from "./server.js";
import type { EntitySnapshot } from "./source-contract.js";
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
  const entities = new Map<string, EntitySnapshot>();
  const rpcCalls: Call[] = [];
  const threads = new Map<string, { status: string; archivedAt: number | null }>();
  const spawns: Array<Record<string, unknown> & { id: string }> = [];
  const sends: Array<{ threadId: string; text: string }> = [];
  const userTurns: Array<{ threadId: string; text: string }> = [];
  let n = 0;

  const callRpc = async (args: { pluginId: string; method: string; input?: unknown; outputSchema: { parse(v: unknown): unknown } }) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    rpcCalls.push({ pluginId: args.pluginId, method: args.method, input });
    let out: unknown;
    if (args.method === "readProjectFiles") out = { projectSourcePath: "/p/.bb", head: "abc", files: (input.paths as string[]).map((path) => ({ path, content: files[path] ?? null })), error: null };
    else if (args.method === "repoSet") out = { repos: [{ dir: "web", url: "https://github.com/acme/web.git" }], error: null };
    else if (args.method === "sourceSnapshot") out = { snapshot: entities.get(String(input.id)) ?? null };
    else if (args.method === "sourceSetInterest") out = { ok: true };
    else if (args.method === "sourceAdoptable") {
      const units = input.units as string[];
      out = {
        viewer: args.pluginId === "github" ? "jane" : "Jane",
        entities: [...entities.values()]
          .filter((e) => e.source === args.pluginId && units.some((u) => u.toLowerCase() === e.unit.toLowerCase()))
          .map((e) => ({ id: e.id, key: e.key, unit: e.unit, kind: e.kind, state: e.state, labels: e.labels, author: e.author, draft: e.pull?.draft ?? false, createdAt: e.createdAt })),
        errors: [],
      };
    } else if (args.method === "sourceValidate") out = { viewer: "Jane", units: (input.units as string[]).map((unit) => ({ unit, found: true, labelFound: true, missingStates: [] })), mine: [{ unit: "ENG", name: "Engineering" }], error: null };
    else throw Object.assign(new Error(`unknown ${args.pluginId}.${args.method}`), { status: 404 });
    return args.outputSchema.parse(out);
  };

  const sdk = {
    plugins: { callRpc },
    projects: { list: async () => [{ id: "p1", name: "Acme" }] },
    threadSections: { list: async () => [], create: async () => ({ id: "sec1", name: "Managed" }) },
    threads: {
      spawn: async (args: Record<string, unknown>) => {
        const id = `thr_${++n}`;
        threads.set(id, { status: "idle", archivedAt: null });
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
        return makeThreadResponse({ id: threadId, status: t.status as never, archivedAt: t.archivedAt, environmentId: "env1", providerId: "claude-code" });
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
      update: async () => ({}),
      events: {
        list: async ({ threadId }: { threadId: string }) =>
          userTurns.filter((t) => t.threadId === threadId).map((t, i) => ({ id: `e${i}`, seq: i, threadId, createdAt: now, scope: "thread", type: "client/turn/start", data: { initiator: "user", request: { method: "turn/start", params: { input: [{ type: "text", text: t.text }] } } } })),
      },
    },
  };
  let now = Date.parse("2026-10-14T15:00:00Z");
  return { files, entities, rpcCalls, threads, spawns, sends, userTurns, sdk, now: () => now, advance: (ms: number) => (now += ms) };
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
    await harness.callRpc("stewardsRing", { source, id }, { experimental_caller: { kind: "plugin", pluginId: source } });
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
  it("is adopted from a ring, under the project steward, with a self-contained wake", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");

    const [project, steward] = t.spawns;
    expect(project).toMatchObject({ title: "Project steward", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    // No sidebar sections or pins: the sidebar is the user's.
    expect(project).not.toHaveProperty("pinned");
    expect(steward).not.toHaveProperty("sectionId");
    expect(steward).toMatchObject({ title: "ENG-12: Fix login", parentThreadId: project!.id, environment: { type: "reuse", environmentId: "env1" }, model: "claude-sonnet-5-5", pluginMetadata: { role: "steward" } });
    const prompt = String(steward!.prompt);
    expect(prompt).toMatch(/# Steward wake: ENG-12 — Fix login/u);
    expect(prompt).toMatch(/You have just been bound/u);
    expect(prompt).toMatch(/Specify the ticket against the ready checklist/u);
    expect(prompt).toMatch(/\[ \] Acceptance criteria are testable/u);
    expect(prompt).toMatch(/given by the project steward/u);
    expect(prompt).toMatch(/bb thread spawn --parent-self --lifecycle-owner-thread "\$BB_THREAD_ID" --visibility hidden --provider claude-code --model claude-opus-5-5 --reasoning-level high/u);
    expect(await t.list()).toMatchObject([{ key: "ENG-12", kind: "ticket", threadId: steward!.id, ended: false }]);

    const interest = t.rpcCalls.filter((c) => c.method === "sourceSetInterest");
    expect(interest.find((c) => c.pluginId === "linear")?.input).toEqual({ units: ["ENG"], entities: ["uuid-12"] });
    expect(interest.find((c) => c.pluginId === "github")?.input).toEqual({ units: ["acme/web"], entities: [] });
  });

  it("ignores unlabelled tickets, other teams, and rings from anyone but a source plugin", async () => {
    const t = await setup();
    t.entities.set("u1", issue({ id: "u1", key: "ENG-1", labels: [] }));
    t.entities.set("u2", issue({ id: "u2", key: "OPS-2", unit: "OPS" }));
    await t.ring("linear", "u1");
    await t.ring("linear", "u2");
    expect(t.spawns).toEqual([]);
    await expect(t.harness.callRpc("stewardsRing", { source: "linear", id: "u1" })).rejects.toThrow(/only the linear and github plugins/u);
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

  it("stops a looping steward's workers past the runaway guard", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;
    for (let i = 0; i < 7; i++) await t.created(`thr_w${i}`, steward);
    expect(t.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_w6" }]]);
    expect(t.sends.at(-1)!.text).toMatch(/Runaway guard/u);
  });

  it("ends without archiving anything, and resumes the same thread when the label comes back", async () => {
    const t = await setup();
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    const steward = t.spawns[1]!.id;

    t.entities.set("uuid-12", issue({ labels: [] }));
    await t.ring("linear", "uuid-12");
    expect(t.sends.at(-1)!.text).toMatch(/this binding is detached/u);
    await t.idle(steward);
    expect((await t.list())[0]).toMatchObject({ ended: true });
    expect(t.harness.sdk.callsTo("threads.archive")).toEqual([]);

    // thread-briefs archived it meanwhile; the next wake brings it back.
    t.threads.get(steward)!.archivedAt = 1;
    t.entities.set("uuid-12", issue());
    await t.ring("linear", "uuid-12");
    expect(t.threads.get(steward)!.archivedAt).toBeNull();
    expect((await t.list())[0]).toMatchObject({ ended: false, threadId: steward });
    expect(t.sends.at(-1)!.text).toMatch(/came back from a terminal or detached state/u);
    expect(t.spawns).toHaveLength(2);
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
