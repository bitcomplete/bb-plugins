// Agent actions and the server's merge re-check, against fakes: nothing here
// reaches a live BB or GitHub. Inkwell fixtures only.
import { describe, expect, it } from "vitest";
import { planAgent, runAgent, type AgentSdk } from "./agent.js";
import { executeMerge, type LiveRead, type MergeDeps } from "./direct.js";
import type { LiveMergeFacts } from "./actions.js";
import type { PrWrite } from "./contract.js";

type Row = { status: string; updatedAt: number; canSpawnChild?: boolean; used?: number | null };

function fakeSdk(threads: Record<string, Row>, options: { send?: boolean; context?: boolean } = {}) {
  const spawned: unknown[] = [];
  const sent: unknown[] = [];
  const sdk: AgentSdk = {
    projects: { list: async () => [{ id: "prj_folio", sources: [{ hostId: "host_a", path: "/p" }] }] },
    threads: {
      spawn: async (args) => {
        spawned.push(args);
        return { id: "thr_new" };
      },
      get: async ({ threadId }) => {
        const row = threads[threadId];
        if (row === undefined) throw new Error("not found");
        return { id: threadId, title: `Folio work ${threadId}`, titleFallback: null, status: row.status, updatedAt: row.updatedAt, canSpawnChild: row.canSpawnChild ?? true };
      },
      ...(options.context === false
        ? {}
        : {
            context: async ({ threadId }: { threadId: string }) => {
              const used = threads[threadId]?.used ?? null;
              return { usage: used === null ? null : { usedTokens: used * 200_000, modelContextWindow: 200_000 } };
            },
          }),
      ...(options.send === false
        ? {}
        : {
            send: async (args: unknown) => {
              sent.push(args);
              return {};
            },
          }),
    },
  };
  return { sdk, spawned, sent };
}

const UNIT = { path: "/p/folio-abc-101", ticket: "ABC-101" };

describe("planAgent", () => {
  it("reads each linked thread live and recommends continuing in the idle author thread", async () => {
    const { sdk } = fakeSdk({ thr_a: { status: "idle", updatedAt: 5, used: 0.3 } });
    const plan = await planAgent(sdk, "address-review", [{ id: "thr_a", title: "stale title", tier: "started" }]);
    expect(plan.capabilities).toEqual({ send: true, subthread: true, contextUsage: true });
    expect(plan.candidates[0]).toMatchObject({ id: "thr_a", title: "Folio work thr_a", running: false, contextUsed: 0.3 });
    expect(plan.recommendation).toMatchObject({ mode: "continue", threadId: "thr_a" });
  });

  it("uses live context usage to prefer a subthread over a nearly full author thread", async () => {
    const { sdk } = fakeSdk({ thr_a: { status: "idle", updatedAt: 5, used: 0.9 } });
    const plan = await planAgent(sdk, "address-comments", [{ id: "thr_a", title: "t", tier: "environment" }]);
    expect(plan.recommendation.mode).toBe("subthread");
  });

  it("degrades to a subthread when the SDK cannot message a thread, and skips threads it cannot read", async () => {
    const { sdk } = fakeSdk({ thr_a: { status: "idle", updatedAt: 5 } }, { send: false, context: false });
    const plan = await planAgent(sdk, "address-review", [
      { id: "thr_gone", title: "t", tier: "started" },
      { id: "thr_a", title: "t", tier: "started" },
    ]);
    expect(plan.capabilities).toEqual({ send: false, subthread: true, contextUsage: false });
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["thr_a"]);
    expect(plan.recommendation).toMatchObject({ mode: "subthread", threadId: "thr_a" });
  });

  it("routes a CI repair to a subthread of a weak-only link", async () => {
    const { sdk } = fakeSdk({ thr_a: { status: "active", updatedAt: 5 } });
    const plan = await planAgent(sdk, "investigate-ci", [{ id: "thr_a", title: "t", tier: "paths" }]);
    expect(plan.recommendation).toMatchObject({ mode: "subthread", threadId: "thr_a" });
  });
});

describe("runAgent", () => {
  const base = { unit: UNIT, prompt: "Address the review on folio #47.", linked: ["thr_a"] };

  it("continues by queueing a message into the chosen thread, never steering it", async () => {
    const { sdk, sent, spawned } = fakeSdk({});
    expect(await runAgent(sdk, { ...base, mode: "continue", threadId: "thr_a" })).toEqual({ ok: true, threadId: "thr_a", ticket: "ABC-101" });
    expect(sent).toEqual([{ threadId: "thr_a", mode: "queue-if-active", input: [{ type: "text", text: base.prompt, mentions: [] }] }]);
    expect(spawned).toEqual([]);
  });

  it("spawns a subthread in the checkout with the parent set and the ticket linked", async () => {
    const { sdk, spawned } = fakeSdk({});
    expect((await runAgent(sdk, { ...base, mode: "subthread", threadId: "thr_a" })).ok).toBe(true);
    expect(spawned).toEqual([
      {
        projectId: "prj_folio",
        environment: { type: "host", hostId: "host_a", workspace: { type: "unmanaged", path: "/p/folio-abc-101" } },
        prompt: base.prompt,
        pluginMetadata: { ticket: "ABC-101" },
        parentThreadId: "thr_a",
      },
    ]);
  });

  it("starts a new thread with no parent, linked by the ticket", async () => {
    const { sdk, spawned } = fakeSdk({});
    expect((await runAgent(sdk, { ...base, mode: "new", threadId: null })).ok).toBe(true);
    expect(spawned[0]).toMatchObject({ pluginMetadata: { ticket: "ABC-101" } });
    expect(spawned[0]).not.toHaveProperty("parentThreadId");
  });

  it("refuses a thread the server did not offer for this row, without writing anything", async () => {
    const { sdk, sent, spawned } = fakeSdk({});
    for (const mode of ["continue", "subthread"] as const) {
      expect((await runAgent(sdk, { ...base, mode, threadId: "thr_elsewhere" })).ok).toBe(false);
    }
    expect([...sent, ...spawned]).toEqual([]);
  });
});

function liveFacts(overrides: Partial<LiveMergeFacts> = {}): LiveMergeFacts {
  return {
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    headRefOid: "b".repeat(40),
    stackedAbove: [],
    unresolvedThreads: 0,
    unresolvedAtLeast: false,
    ...overrides,
  };
}

function mergeDeps(live: LiveRead) {
  const writes: PrWrite[] = [];
  const deps: MergeDeps = {
    live: async () => live,
    write: async (request) => {
      writes.push(request);
      return { ok: true, detail: "merged" };
    },
  };
  return { deps, writes };
}

const MERGE = { prUrl: "https://github.com/inkwell/folio/pull/47", sha: "b".repeat(40), acknowledgeUnresolved: false, method: "squash" as const, deleteBranchSetting: true };

describe("executeMerge", () => {
  it("merges with the confirmed sha and deletes the branch when nothing is stacked on it", async () => {
    const { deps, writes } = mergeDeps({ ok: true, live: liveFacts() });
    expect((await executeMerge(deps, MERGE)).ok).toBe(true);
    expect(writes).toEqual([{ kind: "merge", prUrl: MERGE.prUrl, method: "squash", sha: MERGE.sha, deleteBranch: true }]);
  });

  it("never deletes a branch another open PR is based on, nor when the setting is off", async () => {
    const stacked = mergeDeps({ ok: true, live: liveFacts({ stackedAbove: [58] }) });
    await executeMerge(stacked.deps, MERGE);
    expect(stacked.writes[0]).toMatchObject({ deleteBranch: false });
    const off = mergeDeps({ ok: true, live: liveFacts() });
    await executeMerge(off.deps, { ...MERGE, deleteBranchSetting: false });
    expect(off.writes[0]).toMatchObject({ deleteBranch: false });
  });

  it("re-checks the verdict itself and writes nothing when GitHub now says no", async () => {
    for (const overrides of [{ isDraft: true }, { reviewDecision: null }, { mergeStateStatus: "BLOCKED" as const }]) {
      const { deps, writes } = mergeDeps({ ok: true, live: liveFacts(overrides) });
      expect((await executeMerge(deps, MERGE)).ok).toBe(false);
      expect(writes).toEqual([]);
    }
  });

  it("refuses when the head moved since the dialog opened", async () => {
    const { deps, writes } = mergeDeps({ ok: true, live: liveFacts({ headRefOid: "c".repeat(40) }) });
    const result = await executeMerge(deps, MERGE);
    expect(result.ok ? "" : result.error).toContain("new commits were pushed");
    expect(writes).toEqual([]);
  });

  it("requires the explicit 'merge anyway' acknowledgement when review threads are unresolved", async () => {
    const unresolved = liveFacts({ unresolvedThreads: 3 });
    const refused = mergeDeps({ ok: true, live: unresolved });
    expect((await executeMerge(refused.deps, MERGE)).ok).toBe(false);
    expect(refused.writes).toEqual([]);
    const acknowledged = mergeDeps({ ok: true, live: unresolved });
    expect((await executeMerge(acknowledged.deps, { ...MERGE, acknowledgeUnresolved: true })).ok).toBe(true);
  });
});
