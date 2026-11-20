import type { Problem, Solution, RankedSolution } from "../src/domain/types.js";
import type { DashboardData } from "../src/ui/types.js";
import { activityCostView, recentAgentRuns } from "../src/activity-view.js";
import { listObjectives } from "../src/objectives.js";
import { improvementScope, improvementsForTurn, improvementUsage, listImprovements } from "../src/improvements.js";
import { stageErrorHelp } from "../src/stage-errors.js";
import type { Context } from "./wiring.js";

const present = (values: unknown[]) => values.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 100);
const coverageGaps = (ctx: Context) => ctx.store.get<{coverage:Array<{complete:boolean;source:string;reason:string|null}>}>("source-coverage", "latest")?.coverage.filter(c => !c.complete) ?? [];

/** Things the owner must act on before agent work can run. */
export function issues(ctx: Context): string[] {
  const { config } = ctx;
  return present([
    ctx.configurationError, ctx.exportError, ctx.store.get<{issue:string}>("native-execution-health", "latest")?.issue,
    !config.providerId && "Choose a BB provider", !config.model && "Choose a model",
    !config.projectId && "Choose a worker project", !config.environmentId && "Choose a worker environment",
    !config.budgets.allowUnknown && "Agent work is paused because unknown native costs are not allowed in budgets",
  ]);
}

/** Plain-language context about what Self improve can see and claim; nothing here needs action. */
export function notes(ctx: Context): string[] {
  const gaps = coverageGaps(ctx), partialThreads = gaps.filter(g => g.source.startsWith("thread:")).length;
  const partialSources = gaps.filter(g => !g.source.startsWith("thread:")).length;
  return present([
    partialThreads && `${partialThreads} long ${partialThreads === 1 ? "thread was" : "threads were"} only partly read in the last search for problems.`,
    partialSources && "Task and schedule history from other plugins is only partly available, so some failures may be missed.",
    !ctx.config.taskOutcomeSource && "No task-outcome source is connected, so problems come from thread activity only.",
  ]);
}

/** Everything, with source-level detail, for the CLI doctor and status commands. */
export function diagnostics(ctx: Context): string[] {
  return present([...issues(ctx), ...notes(ctx), !ctx.values.evaluationSuite && "No development test cases are configured; builds cannot run experiments.",
    ...coverageGaps(ctx).map(c => `${c.source}: ${c.reason}`)]);
}

/** The latest runs with their usage and, for failed or waiting runs, what to check. Usage is read once for all of them. */
export function recentRuns(ctx: Context, limit = 50) {
  const usage = ctx.activity.report();
  return ctx.store.runs().slice(-limit).map(run => ({ ...run, costs: usage.forRun(run.id),
    ...(run.errors.length ? { whatToCheck: run.errors.map(stageErrorHelp) } : {}) }));
}

/** Everything the dashboard shows, from one read of the ledger and one read of usage and costs. */
export function dashboard(ctx: Context): DashboardData {
  const { store, config, values } = ctx;
  const usage = ctx.activity.report(), summary = usage.summary();
  const solutions = store.list<Solution>("solutions"), runs = store.runs();
  const { waiting } = improvementsForTurn(store);
  const lastSearch = runs.filter(r => r.stage === "miner" && r.endedAt).at(-1);
  return {
    problems: store.list<Problem>("problems"), solutions, votes: store.list("votes"),
    ranking: store.get<RankedSolution[]>("solution-ranking", "latest") ?? [], runs: runs.map(run => ({ ...run, costs: usage.forRun(run.id) })),
    versions: Object.fromEntries(["problems", "solutions"].flatMap(ns => store.entries(ns).map(e => [`${ns}:${e.key}`, e.version]))),
    setup: { worker: !!config.projectId && !!config.environmentId, model: !!config.providerId && !!config.model,
      mined: store.get("source-coverage", "latest") !== null, scheduled: values.enabled, testCases: !!values.evaluationSuite,
      minerQueued: store.db.prepare("SELECT 1 FROM jobs WHERE stage='miner' AND status IN ('queued','running') LIMIT 1").get() !== undefined,
      lastSearch: lastSearch ? { status: lastSearch.status === "succeeded" ? "succeeded" as const : "failed" as const, endedAtMs: lastSearch.endedAt!, sessions: lastSearch.counts.sessionsAnalyzed ?? 0,
        problems: lastSearch.counts.problemsAdded ?? 0, votes: lastSearch.counts.votesAdded ?? 0, error: lastSearch.errors[0] ?? null } : null },
    improvements: { autoApply: config.autoApply, scope: improvementScope(config.scopeProjectIds),
      applied: listImprovements(store).map(item => ({ solutionId: item.solutionId, revision: item.revision, content: item.content, source: item.source, enabled: item.enabled,
        appliedAtMs: item.appliedAtMs, updatedAtMs: item.updatedAtMs, waiting: waiting.some(w => w.solutionId === item.solutionId), usage: improvementUsage(store, item.solutionId) })),
      awaiting: [...new Set(store.list<{solutionId:string;status:string}>("build-decisions").filter(d => d.status === "passed-awaiting-apply").map(d => d.solutionId))]
        .filter(id => !store.get<{enabled:boolean}>("applied-improvements", id)) },
    health: { enabled: values.enabled, issues: issues(ctx), notes: notes(ctx), workerProjectId: config.projectId },
    costs: { ...summary.legacy, activity: activityCostView(summary), recentRuns: recentAgentRuns(summary),
      activityBySolution: Object.fromEntries(solutions.map(solution => [solution.id, activityCostView(usage.forSolutionHistory(solution.id))])),
      unmeteredAccessRequests: store.list<{cached?:boolean}>("access-costs").filter(c => !c.cached).length },
    objectives: listObjectives(store),
  };
}
