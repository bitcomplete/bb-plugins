import type { Store } from "../store.js";
import type { EvidencePointer, Ledgers, Problem, SessionRecord, SessionSelection, TaskRun, Vote, VoteKind } from "../domain/types.js";
import { appendVotes, makeVote } from "../domain/votes.js";
import { mergeLedgers, resolveProblemId } from "../domain/problems.js";
import { deterministicTaskVotes, selectSessions } from "../domain/selection.js";
import { compareIds, finite, integer, stableId, stableJson, text, unique } from "../domain/shared.js";

export interface MiningEvent {
  id: string; sequence: number; atMs: number; turnIndex: number;
  kind: "context" | "owner_correction" | "tool_error" | "tool_retry";
  /** Already minimized by ingestion; still passes the privacy gate before model use. */
  excerpt: string;
}
export interface MiningSession extends SessionRecord { events: MiningEvent[] }
export interface MiningFailure {
  eventId: string; kind: "owner_correction" | "tool_error" | "tool_retry";
  symptom: string; rootCauseHypothesis: string; category: string; matchedProblemId: string | null;
}
export interface MiningAnalysis {
  failures: MiningFailure[];
  /** Trusted worker metadata, never model output: only this exact prefix was analyzed. */
  analyzedEvents?: Array<Pick<MiningEvent, "id" | "sequence">>;
}
export interface JobRun { jobId: string; runId: string; day: string; occurredAtMs: number; status: "failed" | "succeeded" | "running"; originPluginId: string | null }
export interface MiningCounts { sessionsAnalyzed: number; sessionsCapped: number; unknownTaskSessions: number; votesAdded: number; problemsAdded: number; eventsProcessed: number }
export interface MiningInput {
  store: Store; sessions: MiningSession[]; taskRuns?: TaskRun[]; jobRuns?: JobRun[];
  analyze: (session: MiningSession, delta: MiningEvent[], existingProblems: Problem[]) => Promise<MiningAnalysis>;
  /** Must reject or replace sensitive content; a model prompt is not a privacy boundary. */
  redact: (text: string) => string;
  nowMs: number; concurrency?: number;
}
interface MiningCursor { sessionId: string; day: string; sequence: number; updatedAtMs: number }

export function readLedgers(store: Store): Ledgers {
  return { problems: store.list("problems"), solutions: store.list("solutions"), votes: store.list("votes") };
}
/** Invoke inside the caller's transaction together with cursors and dependent state. */
export function writeLedgers(store: Store, ledgers: Ledgers, nowMs: number): void {
  // Archive complete absorbed drafts before removing their rows. IDs referenced by
  // costs, research snapshots and old navigation remain resolvable via aliases.
  for (const merge of ledgers.solutionMerges ?? []) {
    const id = stableId("solution-merge", [merge.canonicalId, merge.absorbed]);
    if (!store.get("solution-merges", id)) store.createAudited("solution-merges", id, { ...merge, atMs: nowMs }, { kind: "service", id: "candidate-deduplication" }, "Merge an exact candidate direction while preserving its complete discovery record");
  }
  const conflicts = ledgers.solutionMergeConflicts ?? [];
  if (stableJson(store.get("solution-merge-conflicts", "latest") ?? []) !== stableJson(conflicts)) store.put("solution-merge-conflicts", "latest", conflicts, nowMs);
  for (const namespace of ["problems", "solutions", "votes"] as const) {
    const existing = new Map(store.entries<{ id: string }>(namespace).map(entry => [entry.key, entry.value]));
    for (const value of ledgers[namespace]) {
      if (stableJson(existing.get(value.id)) !== stableJson(value)) store.put(namespace, value.id, value, nowMs);
      existing.delete(value.id);
    }
    for (const id of existing.keys()) store.remove(namespace, id);
  }
}
const cursorKey = (s: SessionRecord) => stableId("cursor", [s.sessionId, s.day]);
function clean(value: string, name: string, redact: MiningInput["redact"]): string {
  text(value, name); const result = redact(value); text(result, name); return result;
}
function validateAnalysis(result: MiningAnalysis, events: MiningEvent[], problems: Problem[], redact: MiningInput["redact"]): MiningAnalysis {
  if (result === null || typeof result !== "object" || !Array.isArray(result.failures) || result.failures.length > 64) throw new Error("invalid mining analysis");
  const prefix = result.analyzedEvents;
  if (prefix !== undefined && (!Array.isArray(prefix) || prefix.length === 0 || prefix.length > events.length || prefix.some((event, index) => !event || event.id !== events[index]!.id || event.sequence !== events[index]!.sequence))) throw new Error("mining analysis must cover an exact event prefix");
  const analyzedEvents = prefix === undefined ? events : events.slice(0, prefix.length);
  const byId = new Map(analyzedEvents.map(event => [event.id, event]));
  const failures = result.failures.map(failure => {
    if (!failure || typeof failure !== "object") throw new Error("invalid mining failure");
    const event = byId.get(failure.eventId);
    if (!event) throw new Error("mining failure references an unavailable event");
    if (!["owner_correction", "tool_error", "tool_retry"].includes(failure.kind) || failure.kind !== event.kind) throw new Error("mining vote kind does not match observed event kind");
    if (failure.matchedProblemId !== null && typeof failure.matchedProblemId !== "string") throw new Error("invalid matched problem ID");
    if (failure.matchedProblemId !== null && !problems.some(p => p.id === failure.matchedProblemId || p.aliases.includes(failure.matchedProblemId!))) throw new Error("matched problem is not in the supplied ledger");
    const matchedProblemId = failure.matchedProblemId === null ? null : resolveProblemId(problems, failure.matchedProblemId);
    return { eventId: event.id, kind: failure.kind, matchedProblemId,
      symptom: clean(failure.symptom, "symptom", redact), rootCauseHypothesis: clean(failure.rootCauseHypothesis, "root cause hypothesis", redact), category: clean(failure.category, "category", redact) };
  });
  return { failures, ...(prefix === undefined ? {} : { analyzedEvents: prefix.map(({ id, sequence }) => ({ id, sequence })) }) };
}

function ensureObservation(ledgers: Ledgers, failure: MiningFailure, evidence: EvidencePointer, kind: VoteKind, day: string, occurredAtMs: number, originPluginId: string | null): Ledgers {
  let id = failure.matchedProblemId === null ? stableId("problem", failure.rootCauseHypothesis) : resolveProblemId(ledgers.problems, failure.matchedProblemId);
  let problem = ledgers.problems.find(p => p.id === id || p.aliases.includes(id));
  if (problem) id = problem.id;
  if (!problem) {
    problem = { id, aliases: [], category: failure.category, status: "open", causes: [], symptoms: [], solutionIds: [], createdAtMs: occurredAtMs };
    ledgers.problems.push(problem);
  }
  let cause = problem.causes.find(c => c.text === failure.rootCauseHypothesis);
  if (!cause) { cause = { id: stableId("cause", [id, failure.rootCauseHypothesis]), text: failure.rootCauseHypothesis }; problem.causes.push(cause); }
  let symptom = problem.symptoms.find(s => s.causeId === cause.id && s.text === failure.symptom);
  if (!symptom) { symptom = { id: stableId("symptom", [cause.id, failure.symptom]), causeId: cause.id, text: failure.symptom }; problem.symptoms.push(symptom); }
  // New observed failures reopen a resolved problem, without erasing historical solution outcomes.
  problem.status = "open";
  ledgers.votes = appendVotes(ledgers.votes, [makeVote({ problemId: problem.id, symptomId: symptom.id, kind, evidence, day, occurredAtMs, originPluginId })]);
  return mergeLedgers(ledgers);
}

const deterministicDescriptions = {
  failed_task: { symptom: "A task ended in failure", cause: "A task failed; its underlying root cause is not established", category: "task-outcome" },
  blocked_task: { symptom: "A task ended blocked", cause: "A task was blocked; its underlying root cause is not established", category: "task-outcome" },
  task_looped: { symptom: "A task ran more than five times in one day", cause: "A task repeated; the reason for recurrence is not established", category: "task-recurrence" },
  failed_job: { symptom: "A scheduled job errored", cause: "A job errored; its underlying root cause is not established", category: "job-outcome" },
} as const;

function ingestDeterministic(input: MiningInput): { votesAdded: number; problemsAdded: number } {
  return input.store.transaction(() => {
    // Preserve all runs for counting, independently of the one-session model-mining cap.
    for (const run of input.taskRuns ?? []) {
      finite(run.occurredAtMs, "task run time");
      if (run.occurredAtMs > input.nowMs) throw new Error("task run is from the future");
      if (run.originPluginId === "self-improve") continue;
      const key = stableId("task-run", [run.taskId, run.runId]), old = input.store.get<TaskRun>("observed-task-runs", key);
      if (old && old.outcome !== "running" && stableJson(old) !== stableJson(run)) throw new Error("terminal task run changed; reconcile before mining");
      input.store.put("observed-task-runs", key, run, input.nowMs);
    }
    const runs = input.store.list<TaskRun>("observed-task-runs");
    const votes: Vote[] = deterministicTaskVotes(runs, {
      failed: stableId("problem", deterministicDescriptions.failed_task.cause),
      blocked: stableId("problem", deterministicDescriptions.blocked_task.cause),
      looped: stableId("problem", deterministicDescriptions.task_looped.cause),
    });
    for (const run of input.jobRuns ?? []) {
      finite(run.occurredAtMs, "job run time");
      if (run.occurredAtMs > input.nowMs) throw new Error("job run is from the future");
      if (run.status === "failed" && run.originPluginId !== "self-improve") votes.push(makeVote({ problemId: stableId("problem", deterministicDescriptions.failed_job.cause), kind: "failed_job", evidence: { kind: "job", jobId: run.jobId, runId: run.runId }, day: run.day, occurredAtMs: run.occurredAtMs, originPluginId: run.originPluginId }));
    }
    let ledgers = readLedgers(input.store);
    const beforeVotes = ledgers.votes.length, beforeProblems = ledgers.problems.length;
    for (const vote of votes) {
      const description = deterministicDescriptions[vote.kind as keyof typeof deterministicDescriptions];
      if (!description) throw new Error("unsupported deterministic vote kind");
      const dedup = stableId("observation", [vote.kind, vote.evidence.kind === "task" ? vote.evidence.taskId : vote.evidence.kind === "job" ? vote.evidence.jobId : "", vote.kind === "task_looped" ? vote.day : vote.evidence]);
      if (input.store.get("deterministic-observations", dedup)) continue;
      ledgers = ensureObservation(ledgers, { eventId: "deterministic", kind: "tool_error", symptom: description.symptom, rootCauseHypothesis: description.cause, category: description.category, matchedProblemId: null }, vote.evidence, vote.kind, vote.day, vote.occurredAtMs, vote.originPluginId);
      input.store.put("deterministic-observations", dedup, { evidence: vote.evidence, day: vote.day, kind: vote.kind }, input.nowMs);
    }
    writeLedgers(input.store, ledgers, input.nowMs);
    return { votesAdded: ledgers.votes.length - beforeVotes, problemsAdded: ledgers.problems.length - beforeProblems };
  });
}

/** Incremental mining. Model work is outside the transaction; only validated results advance cursors. */
export async function mineBatch(input: MiningInput): Promise<MiningCounts> {
  finite(input.nowMs, "mining time");
  const concurrency = input.concurrency ?? 3; integer(concurrency, "mining concurrency", 1);
  if (concurrency > 32) throw new Error("mining concurrency exceeds 32");
  const deterministic = ingestDeterministic(input);
  const selection = input.store.transaction(() => {
    const result = selectSessions(input.sessions.map(({ events: _, ...session }) => session), input.store.list<SessionSelection>("mining-selections"));
    for (const record of result.selections) input.store.put("mining-selections", record.key, record, input.nowMs);
    return result;
  });
  const counts: MiningCounts = { sessionsAnalyzed: 0, sessionsCapped: selection.skippedSessionIds.length, unknownTaskSessions: selection.unknownTaskSessionIds.length, votesAdded: deterministic.votesAdded, problemsAdded: deterministic.problemsAdded, eventsProcessed: 0 };
  const sessions = selection.selected.map(s => input.sessions.find(original => original.sessionId === s.sessionId && original.day === s.day)!);
  let next = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
    while (next < sessions.length) {
      const session = sessions[next++]!;
      try {
        const cursor = input.store.get<MiningCursor>("mining-cursors", cursorKey(session));
        const identities = new Set<string>(), sequences = new Set<number>();
        for (const event of session.events) {
          text(event.id, "event ID"); integer(event.sequence, "event sequence"); integer(event.turnIndex, "turn index"); finite(event.atMs, "event time");
          if (event.atMs > input.nowMs) throw new Error("event is from the future");
          if (identities.has(event.id) || sequences.has(event.sequence)) throw new Error("duplicate mining event identity/sequence");
          identities.add(event.id); sequences.add(event.sequence);
        }
        const events = session.events.filter(event => event.sequence > (cursor?.sequence ?? -1)).sort((a, b) => a.sequence - b.sequence).map(event => ({ ...event, excerpt: clean(event.excerpt, "event excerpt", input.redact) }));
        if (!events.length) continue;
        const safeSession: MiningSession = { ...session, events };
        const existingProblems = readLedgers(input.store).problems;
        const analyzed = validateAnalysis(await input.analyze(safeSession, events, structuredClone(existingProblems)), events, existingProblems, input.redact);
        counts.sessionsAnalyzed++;
        input.store.transaction(() => {
          const current = input.store.get<MiningCursor>("mining-cursors", cursorKey(session)), committedSeq = current?.sequence ?? -1;
          const covered = analyzed.analyzedEvents === undefined ? events : events.slice(0, analyzed.analyzedEvents.length);
          const fresh = covered.filter(event => event.sequence > committedSeq);
          if (!fresh.length) return;
          let ledgers = readLedgers(input.store);
          const beforeVotes = ledgers.votes.length, beforeProblems = ledgers.problems.length;
          const freshIds = new Set(fresh.map(e => e.id));
          for (const failure of analyzed.failures) {
            if (!freshIds.has(failure.eventId)) continue;
            const event = fresh.find(e => e.id === failure.eventId)!;
            const evidence: EvidencePointer = { kind: "thread", threadId: session.threadId, sessionId: session.sessionId, turnIndex: event.turnIndex, eventId: event.id, ...(session.taskId === null ? {} : { taskId: session.taskId }) };
            ledgers = ensureObservation(ledgers, failure, evidence, failure.kind, session.day, event.atMs, session.originPluginId);
          }
          writeLedgers(input.store, ledgers, input.nowMs);
          input.store.put("mining-cursors", cursorKey(session), { sessionId: session.sessionId, day: session.day, sequence: fresh[fresh.length - 1]!.sequence, updatedAtMs: input.nowMs } satisfies MiningCursor, input.nowMs);
          counts.votesAdded += ledgers.votes.length - beforeVotes; counts.problemsAdded += ledgers.problems.length - beforeProblems; counts.eventsProcessed += fresh.length;
        });
      } catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : "mining session failed").join("; "));
  return counts;
}
