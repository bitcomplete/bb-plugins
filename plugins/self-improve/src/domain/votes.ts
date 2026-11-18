import type { EvidencePointer, Problem, ProblemRanking, RankingConfig, Vote, VoteKind } from "./types.js";
import { DAY_MS, compareIds, day, finite, integer, stableId, stableJson, text } from "./shared.js";
import { resolveProblemId } from "./problems.js";

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  version: "weighted-votes-v1", halfLifeDays: 21, perSourceDayCap: 3,
  weights: { owner_correction: 3, failed_task: 1.5, blocked_task: 1, failed_job: 1, task_looped: 1.5, tool_error: 0.5, tool_retry: 0.25 },
};
const kinds = Object.keys(DEFAULT_RANKING_CONFIG.weights) as VoteKind[];

export function evidenceKey(pointer: EvidencePointer): string {
  if (pointer.kind === "thread") {
    text(pointer.threadId, "thread ID"); text(pointer.sessionId, "session ID"); text(pointer.eventId, "event ID"); integer(pointer.turnIndex, "turn index");
    return stableJson(["thread", pointer.threadId, pointer.sessionId, pointer.turnIndex, pointer.eventId]);
  }
  if (pointer.kind === "task") { text(pointer.taskId, "task ID"); text(pointer.runId, "task run ID"); return stableJson(["task", pointer.taskId, pointer.runId]); }
  if (pointer.kind === "job") { text(pointer.jobId, "job ID"); text(pointer.runId, "job run ID"); return stableJson(["job", pointer.jobId, pointer.runId]); }
  throw new Error("unsupported evidence pointer");
}
export function voteIdentity(v: Omit<Vote, "id">): string {
  return stableJson([v.problemId, v.kind, v.symptomId ?? null, evidenceKey(v.evidence)]);
}
export function makeVote(v: Omit<Vote, "id">): Vote {
  text(v.problemId, "problem ID"); day(v.day); finite(v.occurredAtMs, "vote timestamp");
  if (!kinds.includes(v.kind)) throw new Error("unknown vote kind");
  evidenceKey(v.evidence);
  return { ...structuredClone(v), id: stableId("vote", voteIdentity(v)) };
}
export function appendVotes(existing: Vote[], additions: Vote[]): Vote[] {
  const ids = new Map<string, Vote>(), sources = new Map<string, Vote>();
  for (const v of [...existing, ...additions]) {
    makeVote(v); text(v.id, "vote ID");
    const previous = ids.get(v.id);
    if (previous && stableJson(previous) !== stableJson(v)) throw new Error(`conflicting vote ID ${v.id}`);
    ids.set(v.id, v);
    const key = voteIdentity(v), sameSource = sources.get(key);
    if (sameSource) {
      const { id: _a, ...a } = sameSource, { id: _b, ...b } = v;
      if (stableJson(a) !== stableJson(b)) throw new Error("conflicting observation for one vote source");
      if (compareIds(v.id, sameSource.id) < 0) sources.set(key, v);
    } else sources.set(key, v);
  }
  return [...sources.values()].map(v => structuredClone(v)).sort((a, b) => compareIds(a.id, b.id));
}
export function decayWeight(weight: number, occurredAtMs: number, asOfMs: number, halfLifeDays: number): number {
  finite(weight, "vote weight"); finite(occurredAtMs, "vote timestamp"); finite(asOfMs, "ranking time"); finite(halfLifeDays, "half life", Number.MIN_VALUE);
  if (occurredAtMs > asOfMs) throw new Error("vote is from the future");
  return weight * 2 ** (-(asOfMs - occurredAtMs) / DAY_MS / halfLifeDays);
}
export function sourceKey(e: EvidencePointer): string {
  if (e.kind === "task" || (e.kind === "thread" && e.taskId)) return `task:${e.taskId}`;
  return e.kind === "job" ? `job:${e.jobId}` : `session:${e.sessionId}`;
}
export function rankProblems(problems: Problem[], votes: Vote[], asOfMs: number, config: RankingConfig = DEFAULT_RANKING_CONFIG): ProblemRanking {
  finite(asOfMs, "ranking time"); finite(config.perSourceDayCap, "source cap", Number.MIN_VALUE); finite(config.halfLifeDays, "half life", Number.MIN_VALUE); text(config.version, "ranking version");
  for (const kind of kinds) finite(config.weights[kind], `weight ${kind}`);
  const buckets = new Map<string, { problemId: string; amount: number }>();
  const counts = new Map<string, number>(), sources = new Map<string, Set<string>>();
  for (const vote of appendVotes([], votes)) {
    if (vote.originPluginId === "self-improve") continue;
    const id = resolveProblemId(problems, vote.problemId), source = sourceKey(vote.evidence);
    const key = stableJson([id, source, vote.day]), amount = decayWeight(config.weights[vote.kind], vote.occurredAtMs, asOfMs, config.halfLifeDays);
    const bucket = buckets.get(key) ?? { problemId: id, amount: 0 }; bucket.amount += amount; buckets.set(key, bucket);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const set = sources.get(id) ?? new Set<string>(); set.add(source); sources.set(id, set);
  }
  const scores = new Map<string, number>();
  for (const bucket of buckets.values()) scores.set(bucket.problemId, (scores.get(bucket.problemId) ?? 0) + Math.min(config.perSourceDayCap, bucket.amount));
  const ranked = [...scores.entries()].map(([problemId, score]) => ({ problemId, score, voteCount: counts.get(problemId)!, sourceCount: sources.get(problemId)!.size })).sort((a, b) => b.score - a.score || compareIds(a.problemId, b.problemId));
  return { version: config.version, asOfMs, ranked, top: ranked.slice(0, 7), wildcards: [1, 2, 3].map(n => ({ id: `wildcard-${n}`, kind: "discovery-slot" })) };
}
