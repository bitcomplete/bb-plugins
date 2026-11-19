import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Accounting, type CostPolicy } from "../src/costs.js";
import { NativeAccounting } from "../src/native-accounting.js";
import type { NativeTaskIdentity, NativeTaskSettlement } from "../src/native-tasks.js";
import type { NativeUsageSdk } from "../src/native-usage.js";
import { MIGRATIONS, Store } from "../src/store.js";

const NOW=Date.parse("2026-11-18T10:00:00Z");
const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();vi.useRealTimers();});
const identity=(taskId="task",providerId="codex"):NativeTaskIdentity=>({taskId,stage:"inventor",providerId,model:"selected-model",runId:"run",solutionId:"solution",startedAtMs:NOW});
const settled=(task=identity(),extra:Partial<NativeTaskSettlement>={}):NativeTaskSettlement=>({...task,threadId:`thread-${task.taskId}`,status:"completed",endedAtMs:NOW+1000,error:null,dispatched:true,cleanupPending:false,...extra});
function cost(threadId:string,seq:number,amount:number|undefined,currency="USD",session="session") {
  return {id:`${threadId}-${seq}`,threadId,seq,createdAt:NOW+seq,scope:{kind:"thread"},type:"thread/contextWindowUsage/updated",
    data:{providerThreadId:session,contextWindowUsage:{usedTokens:42,modelContextWindow:1000,estimated:false,...(amount===undefined?{}:{cost:{amount,currency}})}}};
}
function fixture(extra:Partial<CostPolicy>={},concurrency=3){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const policy:CostPolicy={currency:"USD",dailyMicros:null,monthlyMicros:null,maxDailyCalls:100,allowUnknown:true,prices:{},...extra};
  let now=NOW;
  const rows=new Map<string,ReturnType<typeof cost>[]>();
  const list=vi.fn(async(input:{threadId:string;afterSeq?:string})=>(rows.get(input.threadId)??[]).filter(r=>r.seq>Number(input.afterSeq??-1)));
  const sdk={threads:{events:{list}}} as unknown as NativeUsageSdk;
  const legacy=new Accounting(store,()=>policy);
  const options={store,sdk,policy:()=>policy,maxConcurrent:()=>concurrency,now:()=>now,legacy};
  return {store,policy,legacy,rows,list,sdk,options,accounting:new NativeAccounting(options),clock:(value:number)=>{now=value;}};
}

describe("BB-native task admission and cost observations",()=>{
  it("requires explicit unknown-cost admission even if a legacy API price exists",async()=>{
    const {accounting,policy,store}=fixture({allowUnknown:false,prices:{"selected-model":{input:1,output:1,cacheRead:1,cacheWrite:1,version:"api"}}});
    await expect(accounting.beforeStart(identity())).rejects.toThrow("native-cost-unknown-not-authorized");
    expect(store.list("native-accounting-tasks")).toEqual([]);
    policy.allowUnknown=true;await accounting.beforeStart(identity());
    expect(accounting.summary()).toMatchObject({nativeAdmissions:1,nativeOccupyingSlots:1,nativeUnknownBillingTasks:1,totals:[]});
    expect(store.list("cost-reservations")).toEqual([]); // no fabricated HTTP reservation or token price
  });
  it("reserves synchronously, is idempotent across reloads, and refuses changed attribution",async()=>{
    const {accounting,options}=fixture({maxDailyCalls:1});
    await accounting.hooks().beforeStart!(identity());
    const reloaded=new NativeAccounting(options);await reloaded.beforeStart(identity());
    expect(reloaded.summary().nativeAdmissions).toBe(1);
    await expect(reloaded.beforeStart({...identity(),model:"different"})).rejects.toThrow("identity-conflict");
    await expect(reloaded.beforeStart(identity("second"))).rejects.toThrow("daily-call-budget-exhausted");
  });
  it("applies no daily cap unless one is configured",async()=>{
    const {accounting}=fixture({maxDailyCalls:null},1000);
    for(let i=0;i<150;i++)await accounting.beforeStart(identity(`task-${i}`));
    expect(accounting.summary().nativeAdmissions).toBe(150);
  });
  it("retains a slot for unresolved dispatch and failed cleanup until runner reconciliation settles it",async()=>{
    const {accounting}=fixture({},1);await accounting.beforeStart(identity());
    await accounting.onSettled(settled(identity(),{status:"uncertain",threadId:null,cleanupPending:false}));
    await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("native-concurrency-exhausted");
    await accounting.onSettled(settled(identity(),{status:"failed",cleanupPending:true}));
    await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("native-concurrency-exhausted");
    await accounting.onSettled(settled(identity(),{status:"failed",cleanupPending:false}));
    await accounting.beforeStart(identity("next"));
    expect(accounting.summary()).toMatchObject({nativeAdmissions:2,nativeOccupyingSlots:1});
  });
  it("records cancelled and failed work with missing usage as unknown rather than zero",async()=>{
    const {accounting,list,store}=fixture();list.mockRejectedValue(new Error("private upstream diagnostic"));
    await accounting.beforeStart(identity());await accounting.onSettled(settled(identity(),{status:"cancelled",error:"private upstream diagnostic"}));
    const summary=accounting.summary();
    expect(summary.totals).toEqual([]);expect(summary.nativeUnknownBillingTasks).toBe(1);
    expect(summary.tasks[0]).toMatchObject({durationMs:1000,billingCompleteness:"unknown",collectionIssue:"native-usage-source-unavailable"});
    expect(summary.tasks[0]!.unknownReasons).toContain("cost-not-reported");
    expect(JSON.stringify(store.list("native-accounting-tasks"))).not.toContain("private upstream diagnostic");
  });
  it.each(["codex","claude-code"])("keeps %s cumulative session reports without summing updates or implying invoices",async provider=>{
    const {accounting,rows}=fixture();const task=identity("task",provider);
    rows.set("thread-task",[cost("thread-task",0,1),cost("thread-task",1,2)]);
    await accounting.beforeStart(task);await accounting.onSettled(settled(task));await accounting.onSettled(settled(task));
    const summary=accounting.summary();expect(summary.nativeAdmissions).toBe(1);
    expect(summary.totals).toEqual([{currency:"USD",legacyReportedMicros:0,legacyEstimatedMicros:0,legacyReservedMicros:0,nativeLatestReportedSessionMicros:2_000_000,nativeObservedFloorMicros:2_000_000}]);
    expect(summary.nativeUnknownBillingTasks).toBe(1);expect(summary.tasks[0]!.usage!.historyCaughtUp).toBe(true);
    expect(summary.tasks[0]!.unknownReasons).toContain("final-billing-coverage-unavailable");
  });
  it("keeps missing/declining later reports explicit without dropping the observed admission floor",async()=>{
    const {accounting,rows,policy}=fixture({dailyMicros:2_000_000});
    rows.set("thread-task",[cost("thread-task",0,2)]);await accounting.beforeStart(identity());await accounting.onSettled(settled());
    rows.get("thread-task")!.push(cost("thread-task",1,.5),cost("thread-task",2,undefined));await accounting.reconcileUsage();
    const summary=accounting.summary();expect(summary.tasks[0]!.sessions[0]).toMatchObject({latestReportedMicros:null,observedFloorMicros:2_000_000});
    expect(summary.tasks[0]!.unknownReasons).toContain("session-cost-counter-decreased");
    expect(summary.tasks[0]!.unknownReasons).toContain("session-cost-not-reported");
    await expect(accounting.beforeStart(identity("second"))).rejects.toThrow("daily-cost-budget-exhausted");
    policy.dailyMicros=null;await accounting.beforeStart(identity("second"));
  });
  it("adds late usage after restart without new admissions and keeps zero distinct from missing",async()=>{
    const {accounting,rows,options}=fixture();await accounting.beforeStart(identity());await accounting.onSettled(settled());
    expect(accounting.summary().tasks[0]!.sessions).toEqual([]);
    rows.set("thread-task",[cost("thread-task",5,0)]);const reloaded=new NativeAccounting(options);await reloaded.reconcileUsage();
    expect(reloaded.summary().tasks[0]!.sessions[0]).toMatchObject({latestReportedMicros:0,observedFloorMicros:0});
    expect(reloaded.summary().tasks[0]!.unknownReasons).not.toContain("session-cost-not-reported");
    expect(reloaded.summary().nativeAdmissions).toBe(1);
  });
  it("counts legacy admissions and preserves unknown legacy reserved headroom",async()=>{
    const {accounting,legacy,policy}=fixture({dailyMicros:10,maxDailyCalls:2,prices:{old:{input:1,output:1,cacheRead:1,cacheWrite:1,version:"historical"}}});
    legacy.reserve({id:"legacy",model:"old",scope:"inventor",inputBound:5,outputBound:5},NOW);
    legacy.settle({id:"legacy",model:"old",status:"failed",complete:false,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}},NOW+1);
    await expect(accounting.beforeStart(identity())).rejects.toThrow("daily-cost-budget-exhausted");
    policy.dailyMicros=null;await accounting.beforeStart(identity());await accounting.onSettled(settled());
    await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("daily-call-budget-exhausted");
    expect(accounting.summary().legacy.events).toHaveLength(1);
  });
  it("respects daily/monthly and solution thresholds without inventing a reservation maximum",async()=>{
    const {accounting,rows,policy,clock}=fixture({scopeLimitsMicros:{"solution:solution":1_000_000}});
    rows.set("thread-task",[cost("thread-task",0,1)]);await accounting.beforeStart(identity());await accounting.onSettled(settled());
    await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("scope-cost-budget-exhausted");
    clock(NOW+24*3600_000);await accounting.beforeStart({...identity("next"),startedAtMs:NOW+24*3600_000});
    policy.monthlyMicros=1_000_000;
    await expect(accounting.beforeStart({...identity("third"),startedAtMs:NOW+24*3600_000})).rejects.toThrow("monthly-cost-budget-exhausted");
  });
  it("does not mix currencies, including when only a scope threshold is configured",async()=>{
    const {accounting,rows,policy}=fixture();rows.set("thread-task",[cost("thread-task",0,1,"EUR")]);
    await accounting.beforeStart(identity());await accounting.onSettled(settled());
    expect(accounting.summary().totals[0]!.currency).toBe("EUR");
    policy.scopeLimitsMicros={inventor:10_000_000};
    await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("budget-currency-mismatch");
  });
  it("does not downgrade recovered terminal accounting when an older uncertain callback arrives",async()=>{
    const {accounting}=fixture();await accounting.beforeStart(identity());
    await accounting.onSettled(settled(identity(),{status:"uncertain",threadId:null}));
    await accounting.onSettled(settled());await accounting.onSettled(settled(identity(),{status:"uncertain",threadId:null,cleanupPending:true}));
    expect(accounting.summary().tasks[0]).toMatchObject({occupyingSlot:false,settlement:{status:"completed",threadId:"thread-task",cleanupPending:false}});
    await expect(accounting.onSettled(settled(identity(),{threadId:"other"}))).rejects.toThrow("thread-conflict");
  });
  it("distinguishes admission rejection and admitted non-dispatch failure",async()=>{
    const {accounting}=fixture();const rejected=settled(identity(),{status:"failed",threadId:null,dispatched:false});
    await accounting.onSettled(rejected);expect(accounting.summary().nativeAdmissions).toBe(0);
    await accounting.beforeStart(identity());await accounting.onSettled(rejected);
    expect(accounting.summary()).toMatchObject({nativeAdmissions:1,nativeOccupyingSlots:0,nativeUnknownBillingTasks:0});
    expect(accounting.summary().tasks[0]!.billingCompleteness).toBe("not-dispatched");
    await expect(accounting.onSettled(settled(identity("unregistered")))).rejects.toThrow("admission-missing");
  });
  it("bounds usage reconciliation even if the SDK ignores cancellation",async()=>{
    vi.useFakeTimers();const {accounting,list,options}=fixture();list.mockImplementation(()=>new Promise(()=>{}));
    await accounting.beforeStart(identity());const pending=accounting.onSettled(settled());
    await vi.advanceTimersByTimeAsync(4001);await pending;
    const reloaded=new NativeAccounting(options);
    expect(reloaded.summary().tasks[0]).toMatchObject({collectionIssue:"native-usage-collection-interrupted",billingCompleteness:"unknown"});
  });
  it("does not double-count a session shared across tasks and blocks ambiguous scoped budgets",async()=>{
    const {accounting,rows,policy}=fixture();
    for(const taskId of ["a","b"]){const task=identity(taskId);rows.set(`thread-${taskId}`,[cost(`thread-${taskId}`,0,2)]);await accounting.beforeStart(task);await accounting.onSettled(settled(task));}
    const summary=accounting.summary();expect(summary.totals[0]!.nativeLatestReportedSessionMicros).toBeNull();expect(summary.totals[0]!.nativeObservedFloorMicros).toBe(2_000_000);
    expect(summary.tasks.every(t=>t.unknownReasons.includes("provider-session-shared-between-tasks"))).toBe(true);
    policy.dailyMicros=10_000_000;await expect(accounting.beforeStart(identity("next"))).rejects.toThrow("native-cost-attribution-ambiguous");
  });
  it("does not recollect or churn rows when terminal settlements replay after reload",async()=>{
    const {accounting,rows,list,store,options}=fixture();
    rows.set("thread-task",[cost("thread-task",0,1)]);await accounting.beforeStart(identity());await accounting.onSettled(settled());
    const version=store.version("native-accounting-tasks","task"),collectionVersion=store.version("native-accounting-collections","task");list.mockClear();
    const reloaded=new NativeAccounting(options);
    await Promise.all([reloaded.onSettled(settled()),accounting.onSettled(settled())]);
    expect(list).not.toHaveBeenCalled();expect(store.version("native-accounting-tasks","task")).toBe(version);
    expect(store.version("native-accounting-collections","task")).toBe(collectionVersion);
    expect(reloaded.summary().totals[0]!.nativeLatestReportedSessionMicros).toBe(1000000);
  });
  it("leaves failed collections for the bounded periodic retry instead of settlement replay",async()=>{
    const {accounting,rows,list,store}=fixture();list.mockRejectedValueOnce(new Error("source unavailable"));
    await accounting.beforeStart(identity());await accounting.onSettled(settled());
    const before=store.get("native-accounting-tasks","task"),version=store.version("native-accounting-tasks","task");
    expect(accounting.summary().tasks[0]!.collectionIssue).toBe("native-usage-source-unavailable");
    rows.set("thread-task",[cost("thread-task",0,2)]);list.mockClear();await accounting.onSettled(settled());
    expect(list).not.toHaveBeenCalled();expect(store.get("native-accounting-tasks","task")).toEqual(before);expect(store.version("native-accounting-tasks","task")).toBe(version);
    expect(await accounting.reconcileUsage({maxTasks:1})).toMatchObject({checked:1,pending:0});
    expect(list).toHaveBeenCalledTimes(1);expect(accounting.summary().tasks[0]!.collectionIssue).toBeNull();
    expect(accounting.summary().totals[0]!.nativeLatestReportedSessionMicros).toBe(2000000);
  });
  it("still records and collects recovered thread and cleanup transitions exactly once",async()=>{
    const {accounting,list,store}=fixture();await accounting.beforeStart(identity());
    const unknown=settled(identity(),{status:"uncertain",threadId:null});await accounting.onSettled(unknown);
    expect(list).not.toHaveBeenCalled();expect(accounting.summary().tasks[0]!.occupyingSlot).toBe(true);
    const recovered=settled(identity(),{status:"failed",cleanupPending:true});await accounting.onSettled(recovered);
    expect(list).toHaveBeenCalledTimes(1);const recoveredVersion=store.version("native-accounting-tasks","task");
    await accounting.onSettled(recovered);expect(list).toHaveBeenCalledTimes(1);expect(store.version("native-accounting-tasks","task")).toBe(recoveredVersion);
    const cleaned={...recovered,cleanupPending:false};await accounting.onSettled(cleaned);
    expect(list).toHaveBeenCalledTimes(2);expect(accounting.summary().tasks[0]).toMatchObject({occupyingSlot:false,settlement:{status:"failed",threadId:"thread-task",cleanupPending:false}});
    const cleanedVersion=store.version("native-accounting-tasks","task");
    await accounting.onSettled(cleaned);await accounting.onSettled(unknown);
    expect(list).toHaveBeenCalledTimes(2);expect(store.version("native-accounting-tasks","task")).toBe(cleanedVersion);
  });
  it("rotates bounded reconciliation across tasks instead of starving later reports",async()=>{
    const {accounting,rows,list}=fixture();
    for(const taskId of ["a","b","c"]){await accounting.beforeStart(identity(taskId));await accounting.onSettled(settled(identity(taskId)));rows.set(`thread-${taskId}`,[cost(`thread-${taskId}`,1,1,"USD",`session-${taskId}`)]);}
    list.mockClear();for(let i=0;i<3;i++)await accounting.reconcileUsage({maxTasks:1});
    expect(list.mock.calls.map(([input])=>input.threadId)).toEqual(["thread-a","thread-b","thread-c"]);
    expect(accounting.summary().totals[0]!.nativeLatestReportedSessionMicros).toBe(3_000_000);
  });
});
