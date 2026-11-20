import { randomUUID } from "node:crypto";
import { rpcContract } from "../src/contract.js";
import { stableId } from "../src/domain/shared.js";
import type { Problem, Solution, Vote } from "../src/domain/types.js";
import type { ExecutionSettingsView } from "../src/native-execution.js";
import { addObjective, setObjectiveFocus } from "../src/objectives.js";
import { problemReport } from "../src/problem-report.js";
import { applyImprovement, setImprovementEnabled, listImprovements } from "../src/improvements.js";
import { dashboard } from "./dashboard.js";
import type { Context } from "./wiring.js";

/** Owner actions come from the BB app, CLI or the owner's agents; another plugin cannot invoke them on the owner's behalf. */
const ownerOnly = (context: { experimental_caller?: { kind: string } }) => {
  if (context.experimental_caller?.kind === "plugin") throw new Error("This Self improve action is available only to the owner");
};
/** Every dashboard RPC is an owner action or owner view; none is offered to other plugins. */
const ownerOnlyHandlers = <T extends Record<string, (input: never, context: never) => unknown>>(handlers: T): T =>
  Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (input: never, context: never) => {
    ownerOnly(context as { experimental_caller?: { kind: string } }); return handler(input, context);
  }])) as T;

export function executionView(ctx: Context): ExecutionSettingsView {
  const { config } = ctx;
  return {
    revision: stableId("configuration", ctx.values.config), projectId: config.projectId, environmentId: config.environmentId,
    selection: { providerId: config.providerId, model: config.model, reasoningLevel: config.reasoningLevel ?? "medium", ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}) },
    permissionMode: config.permissionMode,
  };
}

export function registerRpc(ctx: Context): void {
  const { bb, store, chats, revalidationOwner, changed } = ctx;
  bb.rpc.register(rpcContract, ownerOnlyHandlers({
    revalidationOverview: input => revalidationOwner.overview(input.solutionId),
    revalidationPlan: input => revalidationOwner.detail(input.planId),
    editRevalidationDraft: input => revalidationOwner.edit(input),
    freezeRevalidation: input => revalidationOwner.freeze(input),
    queueRevalidation: input => revalidationOwner.queue(input),
    cancelRevalidation: input => revalidationOwner.cancel(input),
    startRevalidationChat: async (input, context) => {
      if (input.projectId !== ctx.config.projectId) throw new Error("Open Self improve in its configured worker project");
      const plan = ctx.revalidation.plans.get(input.planId).plan;
      return chats.chat({ signal: context.experimental_signal, selection: { kind: "solution", id: plan.definition.target.solutionId }, solutionId: plan.definition.target.solutionId,
        context: `Help clarify revalidation plan ${plan.id}. Read it with self_improve_revalidation_read. Help the owner formulate measurable criteria and counterexamples. Edit only a new draft version; the owner freezes and runs it. Do not invent test results.` });
    },
    getExecution: () => executionView(ctx),
    workerOptions: async () => {
      // Projects and their ready environments, for choosing where agent work runs.
      const [projects, environments] = await Promise.all([bb.sdk.projects.list({ includePersonal: true }), bb.sdk.environments.list({ limit: 500 })]);
      const text = (value: unknown) => typeof value === "string" ? value : "";
      return {
        projects: (projects as Array<Record<string, unknown>>).map(p => ({ id: text(p.id), name: text(p.name) || text(p.id) })).filter(p => p.id),
        environments: (environments as Array<Record<string, unknown>>).filter(e => text(e.status) === "ready" && text(e.projectId))
          .map(e => ({ id: text(e.id), projectId: text(e.projectId), label: [text(e.name), text(e.kind) || text(e.workspaceKind), text(e.path)].filter(Boolean).join(" · ") || text(e.id) })),
      };
    },
    problemReport: async input => {
      // A report for a problem whose cause is outside what Self improve changes; the owner decides where it goes.
      const problem = store.list<Problem>("problems").find(p => p.id === input.problemId || p.aliases.includes(input.problemId));
      if (!problem) throw new Error("Problem not found");
      let sourceUrl: string | null = null;
      if (problem.location?.kind === "plugin" && problem.location.name) {
        const plugins = await bb.sdk.plugins.list().catch(() => null) as unknown;
        const rows = Array.isArray(plugins) ? plugins : (plugins as { plugins?: unknown[] } | null)?.plugins ?? [];
        const match = (rows as Array<Record<string, unknown>>).find(p => p.id === problem.location!.name || p.name === problem.location!.name);
        const resolved = match?.resolvedSource as { kind?: string; url?: unknown } | undefined;
        sourceUrl = resolved?.kind === "git" && typeof resolved.url === "string" ? resolved.url : null;
      }
      return problemReport({ problem, votes: store.list<Vote>("votes"), solutions: store.list<Solution>("solutions"), applied: listImprovements(store), sourceUrl });
    },
    applyImprovement: input => {
      // Owner applies a fix whose test passed (used when automatic applying is off, or to re-apply a newer revision).
      const decision = store.list<{solutionId:string;attemptId:string;status:string;artifactId:string|null}>("build-decisions").filter(d => d.solutionId === input.solutionId && d.artifactId && (d.status === "passed-awaiting-apply" || d.status === "applied")).at(-1);
      if (!decision?.artifactId) throw new Error("This solution has no passing test result to apply");
      const result = applyImprovement(store, { solutionId: input.solutionId, artifactId: decision.artifactId, attemptId: decision.attemptId, source: "owner" }, { kind: "owner", id: "dashboard" });
      changed(); return result;
    },
    setImprovementEnabled: input => { const result = setImprovementEnabled(store, input.solutionId, input.enabled, { kind: "owner", id: "dashboard" }); changed(); return result; },
    setAutoApply: async input => {
      const next = await ctx.updateConfig({ autoApply: input.autoApply }); changed();
      return { autoApply: next.autoApply };
    },
    findProblems: () => {
      const { config } = ctx;
      if (!config.projectId || !config.environmentId || !config.providerId || !config.model) throw new Error("Choose where agent work runs under Execution first");
      const jobId = ctx.services.enqueue("miner", `manual:${randomUUID()}`); changed(); return { jobId };
    },
    setExecution: async input => {
      await ctx.updateConfig(async (existing, raw) => {
        if (stableId("configuration", raw) !== input.expectedRevision) throw new Error("Configuration changed; reload execution settings before saving");
        // The worker project and environment are chosen here too; the environment must belong to the project and be ready.
        if (input.selection.projectId !== existing.projectId || input.selection.environmentId !== existing.environmentId) {
          const environment = await bb.sdk.environments.get({ environmentId: input.selection.environmentId }).catch(() => null) as { projectId?: string; status?: string } | null;
          if (!environment || environment.projectId !== input.selection.projectId) throw new Error("Choose an environment that belongs to the selected project");
        }
        return { ...existing, reasoningLevel: undefined, serviceTier: undefined, ...input.selection };
      });
      ctx.refreshExecution();
      return executionView(ctx);
    },
    dashboard: () => dashboard(ctx),
    startChat: async (input, context) => {
      if (input.projectId !== ctx.config.projectId) throw new Error("Open Self improve in its configured worker project");
      const namespace = input.kind === "problem" ? "problems" : "solutions";
      if (!store.get(namespace, input.id)) throw new Error("Ledger record no longer exists");
      return chats.chat({ signal: context.experimental_signal, selection: { kind: input.kind, id: input.id }, context: `Explore this ${input.kind}: ${input.id}. Use self_improve_read before edits.`, ...(input.kind === "solution" ? { solutionId: input.id } : {}) });
    },
    createObjective: input => {
      const result = store.transaction(() => {
        const fingerprint = stableId("objective-request", input);
        const previous = store.get<{fingerprint:string;problemId:string}>("objective-requests", input.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error("Objective request changed; submit the edited draft as a new request");
          return { id: previous.problemId };
        }
        const objective = addObjective(store, input, { kind: "owner", id: "dashboard" }, ctx.clean);
        if (input.priority === "focus") setObjectiveFocus(store, objective.id, 5, { kind: "owner", id: "dashboard" });
        // Commit the intent and focus together. A retry must not reset later focus edits.
        store.put("objective-requests", input.requestId, { fingerprint, problemId: objective.problemId });
        return { id: objective.problemId };
      });
      changed(); return result;
    },
  }));
}
