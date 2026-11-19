import type { RevalidationApi } from "../revalidation-api.js";
import type { PublicationApi } from "../publication-view.js";
import type { ActivityCostView, AgentRunUsage } from "../activity-view.js";
import type { Problem, RankedSolution, Solution, Verification, Vote } from "../domain/types.js";

export interface RetestRecord {
  jobId: string; solutionId: string; status: "queued" | "running" | "passed" | "failed" | "rejected" | "needs-review" | "inconclusive" | "interrupted";
  atMs: number; reason: string;
  evidenceKind?: "exploratory-development-replay"; observationVerdict?: string; adoptionGate?: "blocked";
}
export interface DashboardData {
  problems: Problem[];
  /** Preserve the selected solution's optional portability declaration; absence means unknown. */
  solutions: Solution[];
  ranking: RankedSolution[];
  runs: Array<{ id: string; stage: string; status: string; startedAt: number; endedAt: number | null; counts: Record<string, number>; errors: string[] }>;
  versions: Record<string, number>;
  activation?: Record<string, { status: "revalidation-required"; reason: string }>;
  health: { enabled: boolean; issues: string[]; workerProjectId?: string; publicationRepositories?: string[] };
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
  retests?: RetestRecord[];
  verifications?: Record<string, Verification>;
  objectives?: Array<{ id: string; problemId: string; kind: "problem" | "goal"; title: string; description: string; metric: { name: string; unit: string; target: number; direction: "lower" | "higher" } | null; focus: { priority: number } | null }>;
}
export interface Selection { kind: "problem" | "solution"; id: string }
export interface PerformancePoint {
  id: string; solutionId: string; atMs: number; phase: "baseline" | "after";
  votes: number; sessions: number; rate: number | null; confounders: string[];
  activityCosts?: ActivityCostView;
  costs: Array<{ currency: string; reportedMicros: number; estimatedMicros: number; unknownAttempts: number }>;
}
export interface ObjectiveInput {
  requestId: string; kind: "problem" | "goal"; title: string; description: string; priority: "normal" | "focus";
  metric?: { name: string; unit: string; target: number; direction: "lower" | "higher" };
}
export interface ExportArtifact { artifactId: string; files: Array<{ path: string; content: string }>; status: "draft"; bundleSha256: string }
export interface DashboardApi extends Partial<PublicationApi>, Partial<RevalidationApi> {
  dashboard(input: Record<string, never>): Promise<DashboardData>;
  retest(input: { solutionId: string; expectedVersion: number; reason: string }): Promise<{ jobId: string }>;
  startChat(input: { kind: Selection["kind"]; id: string; projectId: string }): Promise<{ threadId: string }>;
  createObjective(input: ObjectiveInput): Promise<{ id: string }>;
  performance(input: { solutionId?: string }): Promise<{ points: PerformancePoint[] }>;
  exportSolution(input: { solutionId: string; format: "skill" | "plugin"; expectedVersion: number }): Promise<ExportArtifact>;
  publishExport(input: { artifactId: string; repository: string; directory: string; bundleSha256: string; reviewed: true }): Promise<{ url: string; status: "submitted-for-review" }>;
}
