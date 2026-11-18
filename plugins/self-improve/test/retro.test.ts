import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { mineRetrospective, readRetrospective, listRetrospectives, type RetroOptions, type RetroWorkers } from "../src/retro.js";
import type { SourceSdk } from "../src/sources.js";
import { stableId } from "../src/domain/shared.js";
import { DAY, NOW, problem, solution, vote } from "./domain/fixtures.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const goLiveMs = NOW - 8 * DAY;
function store() {
  const db = new Database(":memory:"); databases.push(db); for (const sql of MIGRATIONS) db.exec(sql);
  const store = new Store(db);
  store.put("problems", "p-a", { ...problem(), status: "resolved" });
  store.put("solutions", "s-a", { ...solution(), status: "proven" });
  store.put("votes", "v-one", vote());
  store.put("ranking", "latest", { untouched: true });
  store.put("mining-cursors", stableId("cursor", ["before", day(goLiveMs - DAY)]), { sequence: 999 });
  store.put("performance", "latest", { untouched: true });
  return store;
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
interface Event { id: string; type: string; seq: number; createdAt: number; scope: {kind: string; turnId: string}; threadId: string; data: unknown }
function events(id: string, at: number): Event[] {
  const row = (type: string, data: unknown, seq: number): Event => ({ id: `${id}-${seq}`, type, data, seq, createdAt: at + seq, scope: { kind: "turn", turnId: `${id}-turn` }, threadId: id });
  return [row("turn/started", {}, 1), row("client/turn/requested", { requestId: `${id}-request`, initiator: "user", execution: { model: "historic-model" }, input: [] }, 2), row("turn/input/accepted", {clientRequestId: `${id}-request`}, 3), row("item/completed", {item: {type: "toolCall", status: "failed", error: "SECRET: retry failed", arguments: {credential: "RAW-CREDENTIAL"}}}, 4)];
}
function sdk(rows: Record<string, Event[]>): SourceSdk {
  return {
    threads: {
      list: vi.fn(async ({archived, offset}: any) => !archived && !offset ? Object.keys(rows).map(id => ({id,projectId:"project-a",providerId:"historic-provider",originPluginId:null,parentThreadId:null})) : []),
      get: async () => { throw Error("unknown"); },
      events: {list: vi.fn(async (args: any) => {
        const selected = (rows[args.threadId] ?? []).filter(e => (!args.types || args.types.includes(e.type)) && e.seq > Number(args.afterSeq ?? 0) && e.seq < Number(args.beforeSeq ?? Infinity));
        return (args.order === "desc" ? [...selected].reverse() : selected).slice(0, Number(args.limit ?? 100));
      })},
    },
    projects: {list: async () => [{id:"project-a"}]},
    plugins: {callRpc: async (args: any) => {
      if (args.method === "listTasks") return {tasks: Object.keys(rows).map(id => ({id: `task-${id}`})),nextCursor:null};
      if (args.method === "listTaskThreads") { const id = args.input.taskId.slice(5); return {taskThreads:[{taskId:args.input.taskId,threadId:id,liveStatus:"idle",attachedAt:new Date(NOW).toISOString()}]}; }
      if (args.method === "automations_list") return [];
      throw Error("unsupported");
    }},
  } as unknown as SourceSdk;
}
function options(db = store(), rows = {before: events("before",goLiveMs - DAY), after: events("after",goLiveMs + DAY)}): RetroOptions {
  return {store:db,sdk:sdk(rows),solutionId:"s-a",goLiveMs,nowMs:NOW,runId:"retro-run-a",scopeProjectIds:["project-a"],redact:s=>s.replaceAll("SECRET","[redacted]"),
    workers: {owns:()=>false,analyze:vi.fn<RetroWorkers["analyze"]>(async (_session, delta, problems) => ({failures:delta.filter(e=>e.kind==="tool_error").map(e => ({eventId:e.id,kind:"tool_error" as const,symptom:problems[0].symptoms[0].text,rootCauseHypothesis:problems[0].causes[0].text,category:"reliability",matchedProblemId:problems[0].id}))}))},
  };
}
function liveSnapshot(db: Store) {
  return db.db.prepare("SELECT * FROM records WHERE namespace NOT LIKE 'retro:%' AND namespace <> 'retro-analyses' ORDER BY namespace,key").all();
}

describe("retrospective mining", () => {
  it("mines exact windows into separate ledgers, preserving live state and evidence pointers", async () => {
    const input = options(), live = liveSnapshot(input.store);
    const result = await mineRetrospective(input);
    expect(liveSnapshot(input.store)).toEqual(live);
    expect(result.before).toMatchObject({startMs:goLiveMs-7*DAY,endMs:goLiveMs,sessions:1,votes:1});
    expect(result.after).toMatchObject({startMs:goLiveMs,endMs:goLiveMs+7*DAY,sessions:1,votes:1});
    expect(result.verification).toMatchObject({verdict:"PENDING",beforeInterval:null,afterInterval:null,relativeChange:null});
    expect(result.coverageGaps).toContain("historical-instruction-exposure-unverified");
    const detail = readRetrospective(input.store, result.id)!;
    expect(detail.ledgers.votes).toHaveLength(2);
    expect(detail.ledgers.votes).toEqual(expect.arrayContaining([expect.objectContaining({problemId:"p-a",evidence:{kind:"thread",sessionId:"before",threadId:"before",turnIndex:0,eventId:"before-4",taskId:"task-before"}})]));
    expect(detail.ledgers.problems[0].status).toBe("open");
    expect(detail.cursors).toHaveLength(2); expect(detail.selections).toHaveLength(2);
    expect(JSON.stringify(detail)).not.toMatch(/SECRET|RAW-CREDENTIAL|excerpt/);
    expect(input.workers.analyze).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),expect.objectContaining({analysisScope:result.id,runId:"retro-run-a",solutionId:"s-a"}));
    expect(listRetrospectives(input.store,"s-a").map(r=>r.id)).toEqual([result.id]);
  });

  it("replays committed cursors without new model work or losing window denominators", async () => {
    const input = options(); const first = await mineRetrospective(input);
    const second = await mineRetrospective({...input,runId:"retro-run-b",nowMs:NOW+1000});
    expect(second.id).toBe(first.id); expect(input.workers.analyze).toHaveBeenCalledTimes(2);
    expect(second.before).toEqual(first.before); expect(second.after).toEqual(first.after);
    expect(readRetrospective(input.store,first.id)!.ledgers.votes).toHaveLength(2);
  });

  it("persists successful checkpoints across failure and resumes only unfinished sessions", async () => {
    const input = options(); const original = input.workers.analyze; let failed = false;
    input.workers.analyze = vi.fn<RetroWorkers["analyze"]>(async (...args) => { if (args[0].sessionId === "after" && !failed) {failed=true;throw Error("SECRET provider detail");} return original(...args); });
    await expect(mineRetrospective({...input,concurrency:1})).rejects.toThrow("retrospective-mining-failed");
    const failedResult = listRetrospectives(input.store)[0];
    expect(failedResult.status).toBe("failed"); expect(JSON.stringify(failedResult)).not.toContain("SECRET");
    expect(readRetrospective(input.store,failedResult.id)!.cursors).toHaveLength(1);
    const resumed = await mineRetrospective({...input,runId:"retry"});
    expect(input.workers.analyze).toHaveBeenCalledTimes(3);
    expect(resumed.before.sessions).toBe(1); expect(resumed.after.sessions).toBe(1);
    expect(readRetrospective(input.store,resumed.id)!.ledgers.votes).toHaveLength(2);
  });

  it("blocks history older than the source limit without fetching or inferring exposure", async () => {
    const input = options(); const result = await mineRetrospective({...input,goLiveMs:NOW-100*DAY});
    expect(input.sdk.threads.list).not.toHaveBeenCalled(); expect(input.workers.analyze).not.toHaveBeenCalled();
    expect(result.before.sessions).toBe(0); expect(result.after.sessions).toBe(0);
    expect(result.coverageGaps).toContain("requested-window-exceeds-90-day-history-limit");
    expect(result.verification).toMatchObject({verdict:"PENDING",beforeRate:null,afterRate:null});
  });

  it("does not double count the boundary or include events at the after-window end", async () => {
    const input = options(store(), {before:events("before",goLiveMs-4),after:events("after",goLiveMs+7*DAY-4)});
    const result=await mineRetrospective(input), detail=readRetrospective(input.store,result.id)!;
    expect(detail.ledgers.votes).toHaveLength(1);expect(detail.ledgers.votes[0].occurredAtMs).toBe(goLiveMs);
    expect(result.before.sessions).toBe(0); expect(result.after.votes).toBe(1);
  });

  it("keeps immature windows and incomplete model provenance pending", async () => {
    const input=options(); const rows={before:events("before",NOW-2*DAY),after:events("after",NOW-1000)};
    rows.before[1].data={requestId:"before-request",initiator:"user",input:[]};
    const result=await mineRetrospective({...input,sdk:sdk(rows),goLiveMs:NOW-DAY});
    expect(result.coverageGaps).toContain("after-window-not-mature");
    expect(result.coverageGaps).toContain("historical-session-identity-or-model-incomplete");
    expect(result.verification.verdict).toBe("PENDING");
  });

  it("rejects invalid requests before any source or worker work", async () => {
    const input=options();
    for(const changes of [{solutionId:"missing"},{goLiveMs:Infinity},{goLiveMs:NOW+1},{maxEventsPerSession:0}]) await expect(mineRetrospective({...input,...changes})).rejects.toThrow();
    expect(input.sdk.threads.list).not.toHaveBeenCalled(); expect(input.workers.analyze).not.toHaveBeenCalled();
    expect(listRetrospectives(input.store)).toEqual([]);
  });

  it("does not count a truncated session until its remaining events have been mined", async () => {
    const rows={before:events("before",goLiveMs-DAY),after:events("after",goLiveMs+DAY)};
    rows.before.push({...rows.before[3],id:"before-5",seq:5,createdAt:goLiveMs-DAY+5});
    const input=options(store(),rows), first=await mineRetrospective({...input,maxEventsPerSession:1});
    expect(first.before.sessions).toBe(0); expect(first.after.sessions).toBe(1);
    expect(first.coverageGaps).toContain("selected-sessions-not-fully-mined");
    const second=await mineRetrospective({...input,maxEventsPerSession:1,runId:"next-chunk"});
    expect(second.before.sessions).toBe(1);expect(second.before.votes).toBe(2);
    expect(second.coverageGaps).not.toContain("selected-sessions-not-fully-mined");
  });

  it("keeps historical definitions fixed when the live solution changes between retries", async () => {
    const input=options();const first=await mineRetrospective(input);
    input.store.put("solutions","s-a",{...solution(),prediction:{...solution().prediction,symptomIds:[]}});
    input.store.put("problems","p-a",{...problem(),symptoms:[]});
    const second=await mineRetrospective(input);
    expect(second.id).toBe(first.id);expect(second.solutionVersion).toBe(first.solutionVersion);
    expect(second.before.votes).toBe(1);expect(second.solutionSnapshot.prediction.symptomIds).toEqual(["symptom-p-a"]);
  });

  it("does not send other projects' source context to retrospective workers", async () => {
    const input=options(), listing=input.sdk.threads.list;
    input.sdk.threads.list=vi.fn(async args=>(await listing(args)).map(t=>({...t,projectId:t.id==="after"?"another-project":"project-a"})));
    const result=await mineRetrospective(input);
    expect(input.workers.analyze).toHaveBeenCalledTimes(1);
    expect(result.before.sessions).toBe(1); expect(result.after.sessions).toBe(0);
    expect(readRetrospective(input.store,result.id)!.ledgers.votes).toHaveLength(1);
  });

  it("serializes simultaneous requests and retains every run without duplicate paid analysis", async () => {
    const input=options(),original=input.workers.analyze;
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    input.workers.analyze=vi.fn<RetroWorkers["analyze"]>(async(...args)=>{await gate;return original(...args);});
    const first=mineRetrospective({...input,concurrency:1}),second=mineRetrospective({...input,concurrency:1,runId:"concurrent-run"});
    try { await vi.waitFor(()=>expect(input.workers.analyze).toHaveBeenCalledTimes(1)); }
    finally {release();await Promise.allSettled([first,second]);}
    const reports=await Promise.all([first,second]);
    expect(reports[0].id).toBe(reports[1].id);expect(input.workers.analyze).toHaveBeenCalledTimes(2);
    expect(listRetrospectives(input.store)[0].runIds).toEqual(["concurrent-run","retro-run-a"]);
  });

  it("releases admission after a failed call so a queued retry can finish its checkpoint",async()=>{
    const input=options(),original=input.workers.analyze;let failOnce=true;
    input.workers.analyze=vi.fn<RetroWorkers["analyze"]>(async(...args)=>{if(failOnce){failOnce=false;throw Error("provider failed");}return original(...args);});
    const results=await Promise.allSettled([mineRetrospective(input),mineRetrospective({...input,runId:"queued-retry"})]);
    expect(results[0].status).toBe("rejected");expect(results[1].status).toBe("fulfilled");
    expect(input.workers.analyze).toHaveBeenCalledTimes(3);
    const report=listRetrospectives(input.store)[0];expect(report.status).not.toBe("failed");expect(report.runIds).toEqual(["queued-retry","retro-run-a"]);
    expect(readRetrospective(input.store,report.id)!.ledgers.votes).toHaveLength(2);
  });
});
