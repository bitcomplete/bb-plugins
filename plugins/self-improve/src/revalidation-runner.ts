import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
import { REVALIDATION_NAMESPACES as NS, type Revalidation, type FrozenRevalidationPlan, type RevalidationReceipt, type RevalidationResult, type CriterionAssessment } from "./revalidation.js";
import { nativeExecution, type ExecutionSelection } from "./native-execution.js";
import type { NativeTaskRunner } from "./native-tasks.js";
import { completeText, unfenceJson } from "./native-model.js";
import type { StageContext } from "./services.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const jobInputSchema = z.object({ kind: z.literal("revalidation"), revalidationRunId: z.string().min(1).max(200), solutionId: z.string().max(250).optional() }).strict();
const answerSchema = z.object({ output: z.string().max(8000) }).strict();
export const REVALIDATION_TASK_INSTRUCTIONS = "Perform the supplied test task. Return only JSON {\"output\": string} with your exact answer.";
const treatmentInstructions = (artifact: string) => `${REVALIDATION_TASK_INSTRUCTIONS}\n\nAdditional instruction:\n${artifact}`;
const MAX_NATIVE_INSTRUCTIONS = 32768;

/**
 * Builder job input for a revalidation run. The solutionId is deliberately unknown: an older plugin version that does
 * not recognise kind:"revalidation" treats the job as a retest of a missing solution and fails without a paid build.
 */
export const revalidationJobInput = (runId: string) => ({ kind: "revalidation" as const, revalidationRunId: runId, solutionId: `revalidation-run:${runId}` });

/** Reads `{"output": string}`, allowing one surrounding code fence. Anything else is unreadable. */
export function readAnswer(text: string): string | null {
  try { return answerSchema.parse(JSON.parse(unfenceJson(text))).output; } catch { return null; }
}

/** Server-side scoring over every case. Unreadable answers count as failures on either arm. */
export function scoreRevalidation(frozen: FrozenRevalidationPlan, receipts: RevalidationReceipt[]): Omit<RevalidationResult, "runId" | "planDigest" | "completedAtMs"> {
  const cases = frozen.definition.cases, arm = (caseId: string, which: "baseline" | "treatment") => receipts.find(r => r.caseId === caseId && r.arm === which)!;
  const passed = { baseline: cases.filter(c => arm(c.id, "baseline").passed).length, treatment: cases.filter(c => arm(c.id, "treatment").passed).length };
  const unreadable = { baseline: receipts.filter(r => r.arm === "baseline" && !r.readable).length, treatment: receipts.filter(r => r.arm === "treatment" && !r.readable).length };
  const regressions = cases.filter(c => arm(c.id, "baseline").passed && !arm(c.id, "treatment").passed).length;
  const criteria: CriterionAssessment[] = frozen.definition.criteria.map(c => {
    const value = c.measure === "regressions" ? regressions : c.statistic === "treatment" ? passed.treatment / cases.length : (passed.treatment - passed.baseline) / cases.length;
    return { criterionId: c.id, value, status: (c.operator === "at-least" ? value >= c.value : value <= c.value) ? "threshold-met" : "threshold-not-met" };
  });
  const verdict = frozen.definition.criteria.every((c, i) => !c.required || criteria[i]!.status === "threshold-met") ? "supported" : "contradicted";
  return { verdict, cases: cases.length, passed, regressions, unreadable, criteria };
}

class Stop extends Error { constructor(readonly status: "blocked" | "failed", readonly code: string) { super(code); } }
const errorCode = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : null;
  return code && /^[a-z0-9][a-z0-9-]{0,79}$/.test(code) ? code : "unexpected-error";
};

export interface RevalidationRunnerOptions {
  store: Store; revalidation: Revalidation; runner: Pick<NativeTaskRunner, "execute">;
  /** The plugin is enabled and configured, and unknown native costs are allowed. */
  allowed: () => boolean;
  /** The currently configured worker settings, or null when incomplete. */
  selection: () => ExecutionSelection | null;
  privacyGeneration: () => string; taskTimeoutMs: () => number; now?: () => number;
}

/** Runs queued revalidation plans on the builder service. See docs/revalidation.md. */
export function createRevalidationRunner(options: RevalidationRunnerOptions) {
  const { store, revalidation } = options, now = () => options.now?.() ?? Date.now();
  const active = new Map<string, Promise<Record<string, number>>>();

  /** Checked before every call: the run is still running, the plugin may spend, and the worker settings match what was frozen. */
  function mayContinue(runId: string, frozen: FrozenRevalidationPlan, deadlineAtMs: number) {
    if (revalidation.executor.run(runId).status !== "running") throw new Stop("blocked", "revalidation-run-not-running");
    if (!options.allowed()) throw new Stop("blocked", "revalidation-execution-disabled");
    const current = options.selection();
    if (!current || stableJson(current) !== stableJson(frozen.testedOn)) throw new Stop("blocked", "revalidation-worker-settings-changed");
    if (now() >= deadlineAtMs) throw new Stop("blocked", "revalidation-time-limit");
  }

  async function execute(ctx: StageContext, runId: string): Promise<Record<string, number>> {
    const queued = revalidation.executor.run(runId);
    // A replayed job for a run that already started never makes new calls; one left running by a lost handler is interrupted.
    if (queued.status === "running") { revalidation.executor.stop(runId, "blocked", "interrupted-needs-new-run"); return { revalidation: 1, interrupted: 1 }; }
    const started = revalidation.executor.start(runId);
    if (!started) return { revalidation: 1, skipped: 1 };
    let where = "";
    try {
      const frozen = revalidation.executor.frozen(started), deadlineAtMs = started.startedAtMs! + frozen.definition.limits.maxDurationMs;
      if (treatmentInstructions(frozen.artifact.content).length > MAX_NATIVE_INSTRUCTIONS) throw new Stop("blocked", "revalidation-instruction-too-large");
      const receipts: RevalidationReceipt[] = [];
      for (const [index, c] of frozen.definition.cases.entries()) {
        for (const arm of (index % 2 ? ["treatment", "baseline"] : ["baseline", "treatment"]) as Array<"baseline" | "treatment">) {
          where = ` (case ${c.id}, ${arm})`;
          mayContinue(runId, frozen, deadlineAtMs);
          if (ctx.signal.aborted) throw new Stop("blocked", "interrupted-needs-new-run");
          // Stable per run, case and arm: the native runner never dispatches the same task twice.
          const taskId = stableId("revalidation-task", [runId, c.id, arm]);
          const response = await completeText(options.runner, {
            id: taskId, stage: "builder", runId, solutionId: frozen.definition.target.solutionId,
            instructions: arm === "treatment" ? treatmentInstructions(frozen.artifact.content) : REVALIDATION_TASK_INSTRUCTIONS,
            // Only the case input; the expected answer never leaves the server.
            input: JSON.stringify({ input: c.input }),
            execution: nativeExecution(frozen.testedOn), privacyGeneration: options.privacyGeneration(),
            timeoutMs: Math.max(1, Math.min(900_000, options.taskTimeoutMs(), deadlineAtMs - now())), maxReplyCharacters: 64_000,
          }, ctx.signal);
          const answer = readAnswer(response.text);
          const receipt: RevalidationReceipt = { runId, caseId: c.id, arm, taskId, threadId: response.threadId,
            answerDigest: sha(answer ?? response.text), readable: answer !== null, passed: answer !== null && answer === c.expected };
          store.put(NS.receipts, `${runId}:${c.id}:${arm}`, receipt);
          receipts.push(receipt);
        }
      }
      where = "";
      mayContinue(runId, frozen, Number.POSITIVE_INFINITY);
      const result = revalidation.executor.complete(runId, scoreRevalidation(frozen, receipts));
      return { revalidation: 1, completed: 1, cases: result.cases };
    } catch (error) {
      const stop = error instanceof Stop ? error : ctx.signal.aborted ? new Stop("blocked", "interrupted-needs-new-run") : new Stop("failed", `revalidation-native-call-failed: ${errorCode(error)}`);
      revalidation.executor.stop(runId, stop.status, stop.code === "interrupted-needs-new-run" ? stop.code : stop.code + where);
      return { revalidation: 1, stopped: 1 };
    }
  }

  return {
    /** Builder job handler. Concurrent deliveries of the same job share one execution. */
    handle(ctx: StageContext): Promise<Record<string, number>> {
      const { revalidationRunId: runId } = jobInputSchema.parse(ctx.job.input);
      const existing = active.get(runId); if (existing) return existing;
      const operation = execute(ctx, runId).finally(() => active.delete(runId));
      active.set(runId, operation); return operation;
    },
    /** At startup: a run left running by a previous process can't be resumed and ends without a verdict. */
    recover(): number {
      let interrupted = 0;
      for (const r of store.list<{ id: string; status: string }>(NS.runs)) {
        if (r.status !== "running" || active.has(r.id)) continue;
        try { revalidation.executor.stop(r.id, "blocked", "interrupted-needs-new-run"); interrupted++; } catch { /* retried on the next start */ }
      }
      return interrupted;
    },
    receipts(runId: string) { return store.list<RevalidationReceipt>(NS.receipts).filter(r => r.runId === runId); },
  };
}
