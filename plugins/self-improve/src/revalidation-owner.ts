import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { Revalidation, RevalidationTarget, RevalidationRun } from "./revalidation.js";
import { revalidationTargetSchema } from "./revalidation-contract.js";
import type { createRevalidationDraftEditor } from "./revalidation-edit.js";
import { revalidationJobInput, type createRevalidationRunner } from "./revalidation-runner.js";
import type { ExecutionSelection } from "./native-execution.js";
import type { Solution } from "./domain/types.js";
import type { EditRevalidationDraft } from "./revalidation-edit-contract.js";

export interface RevalidationArtifactChoice { target: RevalidationTarget; title: string; content: string }
export interface RevalidationOwnerOptions {
  store: Store; domain: Revalidation; editDraft: ReturnType<typeof createRevalidationDraftEditor>;
  runner: Pick<ReturnType<typeof createRevalidationRunner>, "receipts">;
  selection: () => ExecutionSelection | null; redact: (value: string) => string; changed: () => void;
  /** Spending observed for a run, from the plugin's existing cost accounting. */
  costs: (runId: string) => unknown;
}
const owner = { kind: "owner" as const, id: "dashboard" };

/** The dashboard's revalidation actions. Every caller is the owner: server.ts refuses RPCs from other plugins. */
export function createRevalidationOwnerApi(options: RevalidationOwnerOptions) {
  const { store, domain } = options;
  const enqueue = (run: RevalidationRun) => store.enqueue("builder", `revalidation:${run.id}`, revalidationJobInput(run.id));
  return {
    /** Instruction artifacts that can be revalidated, and the plans already written. */
    overview(solutionId?: string) {
      const titles = new Map(store.list<Solution>("solutions").map(s => [s.id, s.title]));
      const artifacts: RevalidationArtifactChoice[] = [];
      for (const namespace of ["native-evaluation-artifacts", "built-artifacts", "validated-artifacts"] as const) {
        for (const entry of store.entries<{ solutionId: string; revision: string; kind: string; content: string }>(namespace)) {
          const a = entry.value;
          if (a.kind !== "instruction" || typeof a.content !== "string" || (solutionId && a.solutionId !== solutionId) || !titles.has(a.solutionId)) continue;
          if (options.redact(a.content) !== a.content) continue;
          const target = revalidationTargetSchema.safeParse({ solutionId: a.solutionId, namespace, artifactId: entry.key, revision: a.revision, artifactDigest: createHash("sha256").update(a.content).digest("hex") });
          if (target.success) artifacts.push({ target: target.data, title: titles.get(a.solutionId)!, content: a.content });
        }
      }
      return { artifacts, plans: domain.plans.list(solutionId), selection: options.selection() };
    },
    detail(planId: string) {
      const history = domain.plans.history(planId);
      return { ...domain.plans.get(planId), ...history,
        receipts: Object.fromEntries(history.runs.map(r => [r.id, options.runner.receipts(r.id)])),
        costs: Object.fromEntries(history.runs.map(r => [r.id, options.costs(r.id)])) };
    },
    edit(input: EditRevalidationDraft) { const result = options.editDraft(input, owner); options.changed(); return result; },
    /** Freezes with the currently configured worker settings; a run stops if those settings change. */
    freeze(input: { planId: string; expectedVersion: number }) {
      const selection = options.selection();
      if (!selection) throw new Error("Choose the worker provider, model, project and environment before freezing");
      const result = domain.plans.freeze(input, selection, owner); options.changed(); return result;
    },
    queue(input: { planId: string; version: number; requestId: string }) {
      const result = store.transaction(() => { const run = domain.plans.queue(input, owner); return { run, jobId: run.status === "queued" ? enqueue(run) : null }; });
      options.changed(); return result;
    },
    cancel(input: { runId: string; reason: string }) { const run = domain.plans.cancel(input, owner); options.changed(); return run; },
    /** At startup: re-create the builder job for any queued run whose job was lost. */
    repairQueuedJobs() { for (const run of store.list<RevalidationRun>("revalidation-runs")) if (run.status === "queued") enqueue(run); },
  };
}
export type RevalidationOwnerApi = ReturnType<typeof createRevalidationOwnerApi>;
