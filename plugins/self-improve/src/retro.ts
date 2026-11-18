import { Store } from "./store.js";
import { DAY_MS, stableId, unique } from "./domain/shared.js";
import type { EvaluationWindow, Ledgers, Problem, SessionSelection, Solution, Verification } from "./domain/types.js";
import { selectSessions } from "./domain/selection.js";
import { observationWindow, verifyWindows } from "./domain/verification.js";
import { collectSources, type SourceCoverage, type SourceSdk, type TaskOutcomeSource } from "./sources.js";
import { mineBatch, readLedgers, type MiningCounts, type MiningInput } from "./stages/mining.js";

const WINDOW_MS = 7 * DAY_MS;
const HISTORY_MS = 90 * DAY_MS;
const POLICY = "retrospective-session-day-v1";
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const recordNamespaces = new Set(["problems", "solutions", "votes", "mining-cursors", "mining-selections", "observed-task-runs", "deterministic-observations", "session-observations"]);
// The SDK owns one database connection in one server process. Durable service
// claims handle restart recovery; this admission queue also serializes callers
// that invoke the trusted function concurrently outside that service loop.
const admissions = new WeakMap<Store["db"], Map<string, Promise<void>>>();

/** The ordinary miner only receives this closed namespace view, never the live store. */
class RetrospectiveStore extends Store {
  constructor(store: Store, private readonly analysisId: string) { super(store.db); }
  private ns(namespace: string): string {
    if (!recordNamespaces.has(namespace)) throw new Error("retrospective-namespace-not-allowed");
    return `retro:${this.analysisId}:${namespace}`;
  }
  override get<T>(ns: string, key: string): T | null { return super.get<T>(this.ns(ns), key); }
  override list<T>(ns: string): T[] { return super.list<T>(this.ns(ns)); }
  override entries<T>(ns: string): Array<{ key: string; value: T; version: number }> { return super.entries<T>(this.ns(ns)); }
  override version(ns: string, key: string): number { return super.version(this.ns(ns), key); }
  override put(ns: string, key: string, value: unknown, now?: number): void { super.put(this.ns(ns), key, value, now); }
  override insert(ns: string, key: string, value: unknown, now?: number): boolean { return super.insert(this.ns(ns), key, value, now); }
  override remove(ns: string, key: string): void { super.remove(this.ns(ns), key); }
  // Queue, accounting and owner edits belong to the caller, not the isolated miner.
  override edit(): never { throw new Error("retrospective-operation-not-allowed"); }
  override audit(): never { throw new Error("retrospective-operation-not-allowed"); }
  override enqueue(): never { throw new Error("retrospective-operation-not-allowed"); }
  override claim(): never { throw new Error("retrospective-operation-not-allowed"); }
  override complete(): never { throw new Error("retrospective-operation-not-allowed"); }
  override fail(): never { throw new Error("retrospective-operation-not-allowed"); }
  override recover(): never { throw new Error("retrospective-operation-not-allowed"); }
  override jobStatus(): never { throw new Error("retrospective-operation-not-allowed"); }
  override runs(): never { throw new Error("retrospective-operation-not-allowed"); }
  override pending(): never { throw new Error("retrospective-operation-not-allowed"); }
}

export interface RetroWorkers {
  owns(threadId: string): boolean;
  analyze(session: Parameters<MiningInput["analyze"]>[0], events: Parameters<MiningInput["analyze"]>[1], problems: Problem[], options: {
    analysisScope: string; runId: string; solutionId: string; signal?: AbortSignal;
  }): ReturnType<MiningInput["analyze"]>;
}
export interface RetroOptions {
  store: Store; sdk: SourceSdk; workers: RetroWorkers;
  solutionId: string; goLiveMs: number; nowMs: number; runId: string;
  redact: (text: string) => string; scopeProjectIds?: string[];
  taskOutcomeSource?:TaskOutcomeSource;
  signal?: AbortSignal; concurrency?: number; maxEventsPerSession?: number; maxPages?: number;
}
export interface RetroCursor { sessionId: string; day: string; sequence: number; updatedAtMs: number }
interface SessionObservation {
  sessionId: string; day: string; taskId: string | null; projectId: string | null;
  providerId: string | null; model: string | null; identityComplete: boolean;
  windows: Array<"before" | "after">; observedThroughSequence: number;
}
export interface Retrospective {
  id: string; solutionId: string; solutionVersion: number; solutionSnapshot: Solution;
  goLiveMs: number; scopeProjectIds: string[]; policyVersion: typeof POLICY;
  createdAtMs: number; updatedAtMs: number; runIds: string[];
  status: "running" | "mined" | "pending" | "failed";
  before: EvaluationWindow; after: EvaluationWindow;
  coverage: SourceCoverage[]; coverageGaps: string[]; verification: Verification;
  counts: MiningCounts | null;
}
export interface RetrospectiveDetail extends Retrospective {
  ledgers: Ledgers; cursors: RetroCursor[]; selections: SessionSelection[];
}

export function listRetrospectives(store: Store, solutionId?: string): Retrospective[] {
  return store.list<Retrospective>("retro-analyses").filter(r => solutionId === undefined || r.solutionId === solutionId).sort((a,b) => b.createdAtMs-a.createdAtMs || a.id.localeCompare(b.id));
}
export function readRetrospective(store: Store, id: string): RetrospectiveDetail | null {
  const report = store.get<Retrospective>("retro-analyses", id);
  if (!report) return null;
  const scoped = new RetrospectiveStore(store, report.id);
  return {...report,ledgers:readLedgers(scoped),cursors:scoped.list("mining-cursors"),selections:scoped.list("mining-selections")};
}
function pending(before: EvaluationWindow, after: EvaluationWindow, gaps: string[]): Verification {
  const verification = verifyWindows(before,after,undefined,[
    "Retrospective observations are not randomized; other changes may share the window",
    "The denominator is selected session-days, capped at one session per task/day",
    "The go-live timestamp is owner-supplied; historical instruction exposure is not established",
  ]);
  return {...verification,verdict:"PENDING",beforeInterval:null,afterInterval:null,relativeChange:null,
    reasons:unique([...verification.reasons,...gaps]),policyVersion:POLICY};
}
function validate(input: RetroOptions): {projects:string[];maxEvents:number} {
  if (!safeId.test(input.solutionId) || !safeId.test(input.runId)) throw new Error("invalid-retrospective-identity");
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.goLiveMs) || input.goLiveMs < WINDOW_MS || input.goLiveMs > input.nowMs || input.goLiveMs+WINDOW_MS > 8_640_000_000_000_000) throw new Error("invalid-retrospective-time-window");
  const projects=unique(input.scopeProjectIds??[]).sort(), maxEvents=input.maxEventsPerSession??500;
  if(projects.length>1000 || projects.some(id=>!safeId.test(id))) throw new Error("invalid-retrospective-project-scope");
  if(!Number.isSafeInteger(maxEvents) || maxEvents<1 || maxEvents>500) throw new Error("invalid-retrospective-event-limit");
  for(const [value,limit] of [[input.concurrency??3,32],[input.maxPages??100,1000]]) if(!Number.isSafeInteger(value)||value<1||value>limit) throw new Error("invalid-retrospective-resource-limit");
  return {projects,maxEvents};
}

/** Mine history through the ordinary privacy, source and metered-worker paths.
 * A caller-provided activation time cannot attest historical execution, so the
 * descriptive result remains PENDING and never mutates live efficacy or ranking.
 */
export async function mineRetrospective(input: RetroOptions): Promise<Retrospective> {
  const {projects}=validate(input);
  const request={...input,scopeProjectIds:projects};
  const id=stableId("retro",[input.solutionId,input.goLiveMs,projects,POLICY]);
  const locks=admissions.get(input.store.db)??new Map<string,Promise<void>>();
  admissions.set(input.store.db,locks);
  const prior=locks.get(id)??Promise.resolve();
  let release!:()=>void;
  const turn=new Promise<void>(resolve=>{release=resolve;});
  locks.set(id,turn);
  try { await prior;return await mineRetrospectiveExclusive(request); }
  finally { release();if(locks.get(id)===turn) locks.delete(id); }
}

async function mineRetrospectiveExclusive(input: RetroOptions): Promise<Retrospective> {
  const {projects,maxEvents}=validate(input);input.signal?.throwIfAborted();
  const solution=input.store.get<Solution>("solutions",input.solutionId);
  if(!solution) throw new Error("retrospective-solution-not-found");
  const id=stableId("retro",[input.solutionId,input.goLiveMs,projects,POLICY]);
  const scoped=new RetrospectiveStore(input.store,id);
  let report=input.store.get<Retrospective>("retro-analyses",id);
  if(!report){
    const before={startMs:input.goLiveMs-WINDOW_MS,endMs:input.goLiveMs,sessions:0,votes:0};
    const after={startMs:input.goLiveMs,endMs:input.goLiveMs+WINDOW_MS,sessions:0,votes:0};
    const coverageGaps=["retrospective-not-yet-mined","historical-instruction-exposure-unverified"];
    report={id,solutionId:solution.id,solutionVersion:input.store.version("solutions",solution.id),solutionSnapshot:structuredClone(solution),goLiveMs:input.goLiveMs,scopeProjectIds:projects,policyVersion:POLICY,
      createdAtMs:input.nowMs,updatedAtMs:input.nowMs,runIds:[],status:"pending",before,after,coverage:[],coverageGaps,verification:pending(before,after,coverageGaps),counts:null};
    const initial=report;
    input.store.transaction(()=>{
      // Seed definitions, never live observations, selections, rankings or exposure.
      for(const problem of input.store.list<Problem>("problems").filter(p=>solution.problemIds.includes(p.id)||p.aliases.some(a=>solution.problemIds.includes(a)))) scoped.put("problems",problem.id,{...problem,solutionIds:problem.solutionIds.filter(s=>s===solution.id)},input.nowMs);
      scoped.put("solutions",solution.id,structuredClone(solution),input.nowMs);
      input.store.put("retro-analyses",id,initial,input.nowMs);
    });
  }
  report={...report,updatedAtMs:input.nowMs,runIds:unique([...report.runIds,input.runId]),status:"running",counts:null};
  const gaps=["historical-instruction-exposure-unverified"];
  if(!projects.length) gaps.push("historical-project-scope-unverified");
  if(input.nowMs<report.after.endMs) gaps.push("after-window-not-mature");
  if(report.before.startMs<input.nowMs-HISTORY_MS){
    gaps.push("requested-window-exceeds-90-day-history-limit");
    report={...report,status:"pending",coverageGaps:gaps,verification:pending(report.before,report.after,gaps)};
    input.store.put("retro-analyses",id,report,input.nowMs);return report;
  }
  input.store.put("retro-analyses",id,report,input.nowMs);
  let failed=false;
  try {
    // collectSources has an inclusive upper bound; the retrospective windows are half-open.
    const throughMs=Math.min(input.nowMs,report.after.endMs-1);
    const sources=await collectSources(input.sdk,{now:throughMs,lookbackMs:throughMs-report.before.startMs,taskOutcomeRpc:input.taskOutcomeSource,
      maxPages:input.maxPages,signal:input.signal,redact:input.redact,isOwnedThread:id=>input.workers.owns(id),
      readCursor:key=>scoped.get<RetroCursor>("mining-cursors",key)});
    report.coverage=sources.coverage;
    const metadata=new Map(sources.sessionMetadata.map(m=>[`${m.sessionId}:${m.day}`,m]));
    const sessions=sources.sessions.filter(s=>!projects.length||projects.includes(metadata.get(`${s.sessionId}:${s.day}`)?.projectId??""));
    if(projects.length&&sources.sessionMetadata.some(m=>!m.projectId)) gaps.push("some-source-project-identities-unavailable");
    const selection=selectSessions(sessions,scoped.list<SessionSelection>("mining-selections"));
    for(const session of selection.selected){
      const key=`${session.sessionId}:${session.day}`,previous=scoped.get<SessionObservation>("session-observations",key);
      const current=sessions.find(s=>s.sessionId===session.sessionId&&s.day===session.day)!,meta=metadata.get(key);
      const sameIdentity=!previous || previous.taskId===session.taskId&&previous.projectId===meta?.projectId&&previous.providerId===meta?.providerId&&previous.model===meta?.model;
      const windows:SessionObservation["windows"]=[...new Set([...(previous?.windows??[]),...current.events.map(e=>e.atMs<input.goLiveMs?"before" as const:"after" as const)])];
      scoped.put("session-observations",key,{sessionId:session.sessionId,day:session.day,taskId:session.taskId,projectId:meta?.projectId??null,providerId:meta?.providerId??null,model:meta?.model??null,
        identityComplete:!!meta?.complete&&sameIdentity&&(previous?.identityComplete??true),windows,
        observedThroughSequence:Math.max(previous?.observedThroughSequence??-1,...current.events.map(e=>e.sequence))} satisfies SessionObservation,input.nowMs);
    }
    const taskIds=new Set(sessions.map(s=>s.taskId).filter((id):id is string=>id!==null));
    report.counts=await mineBatch({store:scoped,sessions:sessions.map(s=>({...s,events:s.events.slice(0,maxEvents)})),
      taskRuns:sources.taskRuns.filter(t=>!projects.length||taskIds.has(t.taskId)),jobRuns:projects.length?[]:sources.jobRuns,
      nowMs:input.nowMs,concurrency:input.concurrency,redact:input.redact,
      analyze:(session,events,problems)=>input.workers.analyze(session,events,problems,{analysisScope:id,runId:input.runId,solutionId:input.solutionId,signal:input.signal})});
    if(projects.length&&sources.jobRuns.length) gaps.push("historical-job-project-scope-unavailable");
  } catch { failed=true;gaps.push("retrospective-mining-incomplete"); }
  const observations=scoped.list<SessionObservation>("session-observations");
  const complete=observations.filter(s=>(scoped.get<RetroCursor>("mining-cursors",stableId("cursor",[s.sessionId,s.day]))?.sequence??-1)>=s.observedThroughSequence);
  if(complete.length<observations.length) gaps.push("selected-sessions-not-fully-mined");
  if(observations.some(s=>!s.identityComplete||!s.taskId||!s.projectId||!s.providerId||!s.model)) gaps.push("historical-session-identity-or-model-incomplete");
  for(const source of report.coverage.filter(c=>!c.complete)) gaps.push(`${source.source}:${source.reason??"incomplete"}`);
  if(!["active-threads","archived-threads","task-identity"].every(source=>report.coverage.some(c=>c.source===source&&c.complete))) gaps.push("required-source-coverage-absent");
  const ledgers=readLedgers(scoped),snapshot=ledgers.solutions.find(s=>s.id===report.solutionId)??report.solutionSnapshot;
  // Thread votes alone share this denominator; task/job votes stay in the retro ledger.
  const votes=ledgers.votes.map(v=>v.evidence.kind==="thread"?{...v,evidence:{...v.evidence,sessionId:`${v.evidence.sessionId}:${v.day}`}}:v);
  for(const side of ["before","after"] as const){
    const window=report[side];
    const sessions=complete.filter(s=>s.windows.includes(side)).map(s=>({sessionId:`${s.sessionId}:${s.day}`,atMs:window.startMs,originPluginId:null}));
    report[side]=observationWindow(window.startMs,window.endMs,sessions,votes,snapshot.problemIds,snapshot.prediction.symptomIds);
  }
  const models=new Set(complete.map(s=>`${s.providerId}:${s.model}`));
  if(models.size>1) gaps.push("historical-provider-or-model-switch");
  report.coverageGaps=unique(gaps);report.verification=pending(report.before,report.after,report.coverageGaps);
  report.status=failed?"failed":report.coverageGaps.some(g=>g!=="historical-instruction-exposure-unverified")?"pending":"mined";
  input.store.put("retro-analyses",id,report,input.nowMs);
  if(failed){input.signal?.throwIfAborted();throw new Error("retrospective-mining-failed");}
  return report;
}
