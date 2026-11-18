/** Persisted domain records. Times are Unix milliseconds; calendar days are explicit YYYY-MM-DD values. */
export type VoteKind = "owner_correction" | "failed_task" | "blocked_task" | "failed_job" | "task_looped" | "tool_error" | "tool_retry";
export type Stage = "miner" | "problem-ranker" | "scout" | "inventor" | "solution-ranker" | "builder" | "verifier";
export type EvidencePointer =
  | { kind: "thread"; threadId: string; sessionId: string; turnIndex: number; eventId: string; taskId?: string }
  | { kind: "task"; taskId: string; runId: string }
  | { kind: "job"; jobId: string; runId: string };
export interface Cause { id: string; text: string; aliases?: string[] }
export interface Symptom { id: string; causeId: string; text: string; aliases?: string[] }
export interface Problem {
  id: string;
  aliases: string[];
  category: string;
  status: "open" | "monitoring" | "resolved";
  causes: Cause[];
  symptoms: Symptom[];
  solutionIds: string[];
  createdAtMs: number;
  parentId?: string;
}
export interface Vote {
  id: string;
  problemId: string;
  symptomId?: string;
  kind: VoteKind;
  evidence: EvidencePointer;
  occurredAtMs: number;
  day: string;
  /** Trusted runtime attribution must follow worker descendants and retries. */
  originPluginId: string | null;
}
export interface RankingConfig { version: string; weights: Record<VoteKind, number>; halfLifeDays: number; perSourceDayCap: number }
export interface RankedProblem { problemId: string; score: number; voteCount: number; sourceCount: number }
export interface ProblemRanking { version: string; asOfMs: number; ranked: RankedProblem[]; top: RankedProblem[]; wildcards: Array<{ id: string; kind: "discovery-slot" }> }
export interface SessionRecord { sessionId: string; threadId: string; taskId: string | null; day: string; firstEventAtMs: number; originPluginId: string | null }
export interface SessionSelection { key: string; sessionId: string; day: string; taskId: string | null }
export interface TaskRun { taskId: string; runId: string; day: string; occurredAtMs: number; outcome: "failed" | "blocked" | "succeeded" | "running"; originPluginId: string | null }
export interface PaperSource {
  id: string; version: string; url: string; publishedAtMs: number;
  credibility: { status: "passed" | "pending" | "rejected"; fieldWeightedCitationImpact: number | null; authorSignal: number | null; evidenceUrls: string[] };
}
export interface Prediction { symptomIds: string[]; change: string; kpi: { name: string; target: number; direction: "lower" | "higher" } }
export interface ModelIdentity { provider: string; model: string }
export interface Attempt {
  id: string; atMs: number; directionKey: string; prediction: Prediction;
  outcome: "proposed" | "rejected" | "failed" | "execution-error" | "built" | "adopted" | "removed";
  reason: string; evidenceIds: string[]; model: ModelIdentity;
}
export interface CandidateScores {
  fit: number | null; benefit: number | null; testability: number | null;
  feasibility: number | null; safety: number | null; effort: number | null;
}
export interface Solution {
  id: string; aliases: string[]; title: string;
  origin: "paper" | "inventor";
  sourcePaper: PaperSource | null;
  /** Evidence inventory; eligibility uses the selected independent derivation. */
  paperSources?: PaperSource[];
  sourceDerivation?: CandidateDerivation;
  provenance: Array<{ origin: "paper" | "inventor"; sourceId: string; model: ModelIdentity }>;
  problemIds: string[]; directionKey: string; mechanism: string; assumptions: string[]; testPlan: string;
  prediction: Prediction; scores: CandidateScores; scoreReasons: Record<keyof CandidateScores, string>;
  newEvidenceIds: string[]; createdAtMs: number;
  candidateState: "proposed" | "eligible" | "deferred" | "rejected" | "built";
  status: "active" | "fixing" | "proven" | "removed" | null;
  attempts: Attempt[];
  wiring: { location: string; activatedAtMs: number | null; executionCount: number; undo: string } | null;
  builtWith: ModelIdentity | null; validatedWith: ModelIdentity | null;
  revisitHistory: Array<{ atMs: number; from: ModelIdentity; to: ModelIdentity; decision: "retain" | "revise" | "replace" | "remove"; reason: string }>;
}
export interface CandidateDerivation {
  originalId: string; originalCreatedAtMs: number; origin: Solution["origin"]; sourcePaper: PaperSource | null; provenance: Solution["provenance"];
  mechanism: string; assumptions: string[]; testPlan: string; prediction: Prediction;
}
export interface SolutionMerge { canonicalId: string; canonicalBefore: Solution; absorbed: Solution; reason: "exact-direction-and-canonical-problems" }
export interface Ledgers { problems: Problem[]; solutions: Solution[]; votes: Vote[]; solutionMerges?: SolutionMerge[]; solutionMergeConflicts?: Array<{ solutionIds: string[]; reason: string }> }
export interface Eligibility { eligible: boolean; reasons: string[] }
export interface SolutionRubric { version: string; weights: Record<Exclude<keyof CandidateScores, "effort">, number>; effortPenalty: number; paperMinAgeDays: number }
export interface RankedSolution { solutionId: string; eligible: boolean; reasons: string[]; score: number | null; problemPriority: number; missingFactors: Array<keyof CandidateScores>; rank: number | null }
export interface EvaluationWindow { startMs: number; endMs: number; sessions: number; votes: number }
export interface VerificationPolicy { version: string; minSessions: number; materialChange: number; solvedMaximumRate: number; minimumWindowMs: number }
export interface Verification {
  verdict: "SOLVED" | "REDUCED" | "NO EFFECT" | "WORSE" | "PENDING";
  beforeRate: number | null; afterRate: number | null;
  beforeInterval: [number, number] | null; afterInterval: [number, number] | null;
  relativeChange: number | null; reasons: string[]; confounders: string[]; policyVersion: string;
}
export interface HeldOutProof {
  manifestCommit: string; manifestCommittedAtMs: number; patchCreatedAtMs: number;
  proposerVisibleTaskIds: string[]; heldOutTaskIds: string[]; proposerVisibleFamilyIds: string[]; heldOutFamilyIds: string[];
  isolationVerified: boolean; passed: boolean; proofRef: string;
}
export interface Experiment {
  id: string; preregisteredAtMs: number; startsAtMs: number; endsAtMs: number;
  sampleSize: number; metric: string; blindedOwnerRatings: boolean; seed: string;
}
