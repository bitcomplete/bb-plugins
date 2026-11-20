import type { RevalidationApi } from "../revalidation-api.js";
import type { ActivityCostView, AgentRunUsage } from "../activity-view.js";
import type { Problem, RankedSolution, Solution, Vote } from "../domain/types.js";

export interface DashboardData {
  problems: Problem[];
  /** Preserve the selected solution's optional portability declaration; absence means unknown. */
  solutions: Solution[];
  ranking: RankedSolution[];
  runs: Array<{ id: string; stage: string; status: string; startedAt: number; endedAt: number | null; counts: Record<string, number>; errors: string[] }>;
  versions: Record<string, number>;
  /** Improvements added to agent turns, and passing fixes waiting to be applied. */
  improvements?: { autoApply: boolean; scope: "listed-projects" | "all-except-worker";
    applied: Array<{ solutionId: string; revision: string; content: string; source: "automatic" | "owner"; enabled: boolean; appliedAtMs: number; updatedAtMs: number; waiting: boolean; usage: { turns: number; lastAtMs: number | null } }>;
    awaiting: string[] };
  /** First-run checklist state. */
  setup?: { worker: boolean; model: boolean; mined: boolean; scheduled: boolean; testCases: boolean; minerQueued: boolean;
    /** How the most recent search for problems ended. */
    lastSearch?: { status: "succeeded" | "failed"; endedAtMs: number; sessions: number; problems: number; votes: number; error: string | null } | null };
  health: { enabled: boolean; issues: string[]; notes?: string[]; workerProjectId?: string };
  costs: {
    totals: Array<{ currency: string; reportedMicros: number; estimatedMicros: number; unknownAttempts: number; unknownExternalCosts?: number; attempts: number }>;
    events?: Array<{ solutionId?: string; currency: string; amountMicros: number | null; basis: string; status: string }>;
    pending?: unknown[];
    unmeteredAccessRequests?: number;
    activity?: ActivityCostView;
    activityBySolution?: Record<string, ActivityCostView>;
    recentRuns?: AgentRunUsage[];
  };
  votes?: Vote[];
  objectives?: Array<{ id: string; problemId: string; kind: "problem" | "goal"; title: string; description: string; metric: { name: string; unit: string; target: number; direction: "lower" | "higher" } | null; focus: { priority: number } | null }>;
}
export interface Selection { kind: "problem" | "solution"; id: string }
export interface ObjectiveInput {
  requestId: string; kind: "problem" | "goal"; title: string; description: string; priority: "normal" | "focus";
  metric?: { name: string; unit: string; target: number; direction: "lower" | "higher" };
}
export interface DashboardApi extends Partial<RevalidationApi> {
  dashboard(input: Record<string, never>): Promise<DashboardData>;
  findProblems?(input: Record<string, never>): Promise<{ jobId: string }>;
  problemReport?(input: { problemId: string }): Promise<{ title: string; body: string; issueUrl: string | null }>;
  applyImprovement?(input: { solutionId: string }): Promise<unknown>;
  setImprovementEnabled?(input: { solutionId: string; enabled: boolean }): Promise<unknown>;
  setAutoApply?(input: { autoApply: boolean }): Promise<{ autoApply: boolean }>;
  startChat(input: { kind: Selection["kind"]; id: string; projectId: string }): Promise<{ threadId: string }>;
  createObjective(input: ObjectiveInput): Promise<{ id: string }>;
}
