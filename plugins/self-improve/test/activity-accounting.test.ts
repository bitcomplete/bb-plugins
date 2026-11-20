import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityAccounting, type ActivityChatConversation, type ChatActivityAdmission } from "../src/activity-accounting.js";
import { Accounting, type CostPolicy } from "../src/costs.js";
import { NativeAccounting } from "../src/native-accounting.js";
import type { NativeTaskIdentity } from "../src/native-tasks.js";
import { NativeUsageLedger, type NativeUsageSdk, type NativeUsageObservation } from "../src/native-usage.js";
import { MIGRATIONS, Store } from "../src/store.js";

const NOW=Date.parse("2026-11-18T10:00:00Z"), DAY=86400000;
const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const task=(taskId="task",extra:Partial<NativeTaskIdentity>={}):NativeTaskIdentity=>({taskId,stage:"inventor",providerId:"codex",model:"selected-model",runId:"run",solutionId:"solution",startedAtMs:NOW,...extra});
const admission=(chatId="chat"):ChatActivityAdmission=>({chatId,threadId:`thread-${chatId}`,providerId:"codex",model:"selected-model",solutionId:"solution",initial:true});
function report(threadId:string,seq:number,amount:number|undefined,currency="USD",session="session",at=NOW+seq) {
  return {id:`${threadId}-${seq}`,threadId,seq,createdAt:at,scope:{kind:"thread"},type:"thread/contextWindowUsage/updated",
    data:{providerThreadId:session,contextWindowUsage:{...(amount===undefined?{}:{cost:{amount,currency}})}}};
}
function fixture(extra:Partial<CostPolicy>={}){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));const store=new Store(db);
  const policy:CostPolicy={currency:"USD",dailyMicros:null,monthlyMicros:null,maxDailyCalls:100,allowUnknown:true,prices:{laya:{input:1,output:1,cacheRead:1,cacheWrite:1,version:"fixture"}},...extra};
  let now=NOW; const chats:ActivityChatConversation[]=[], rows=new Map<string,ReturnType<typeof report>[]>();
  const sdk={threads:{events:{list:async(input:{threadId:string;afterSeq?:string})=>(rows.get(input.threadId)??[]).filter(row=>row.seq>Number(input.afterSeq??-1))}}} as unknown as NativeUsageSdk;
  let activity:ActivityAccounting;
  const legacy=new Accounting(store,()=>policy,input=>activity.legacyGuard(input));
  const native=new NativeAccounting({store,sdk,maxConcurrent:()=>100,now:()=>now,admissionGuard:(identity,at)=>activity.nativeGuard(identity,at)});
  const options={store,policy:()=>policy,legacy:()=>legacy,native:()=>native,chats:()=>chats,now:()=>now};
  activity=new ActivityAccounting(options);
  const addChat=(chatId="chat",reports:ReturnType<typeof report>[]=[],extra:Partial<ActivityChatConversation>={})=>{
    const bound={taskId:chatId,threadId:`thread-${chatId}`,providerId:extra.providerId??"codex",requestedModel:"selected-model"};
    const usage=new NativeUsageLedger(store);usage.ingest(bound,reports);
    const value:ActivityChatConversation={chatId,threadId:bound.threadId,providerId:bound.providerId,model:bound.requestedModel,createdAtMs:now,solutionId:"solution",requests:[],turns:[],countsCaughtUp:true,countsIssue:null,usage:usage.read(bound),
      costObservations:store.list<NativeUsageObservation>("native-usage-observations").filter(row=>row.threadId===bound.threadId&&row.kind==="cost").map(row=>({...row,cost:row.cost??null})),...extra};
    const old=chats.findIndex(chat=>chat.chatId===chatId);if(old<0)chats.push(value);else chats[old]=value;return value;
  };
  const addNative=async(identity=task(),reports:ReturnType<typeof report>[]=[] )=>{
    rows.set(`thread-${identity.taskId}`,reports);await native.beforeStart(identity);
    await native.onSettled({...identity,threadId:`thread-${identity.taskId}`,status:"completed",endedAtMs:now+1000,error:null,dispatched:true,cleanupPending:false});
  };
  const detector=(id="detector",amount=1)=>legacy.reserve({id,model:"laya",scope:"reactive",inputBound:amount,outputBound:0,runId:"run",solutionId:"solution"},now);
  return {store,policy,chats,rows,sdk,legacy,native,activity,options,addChat,addNative,detector,clock:(value:number)=>{now=value;}};
}

describe("Shared native and manual activity accounting",()=>{
  it("requires unknown-cost authorization for chat even when token prices exist",()=>{
    const f=fixture({allowUnknown:false,prices:{"selected-model":{input:1,output:1,cacheRead:1,cacheWrite:1,version:"not-a-subscription-invoice"}}});
    expect(()=>f.activity.admitChat(admission())).toThrow("activity-cost-unknown-not-authorized");
    expect(f.store.list("activity-chat-admissions")).toEqual([]);
    expect(f.activity.summary().totals).toEqual([]);
  });
  it("counts a conversation initial admission once across hook rechecks and reloads",()=>{
    const f=fixture({maxDailyCalls:2});f.activity.admitChat(admission());
    for(let i=0;i<3;i++)new ActivityAccounting(f.options).admitChat(admission());
    for(let i=0;i<3;i++)f.activity.admitChat({...admission(),initial:false});
    expect(f.activity.summary().calls).toMatchObject({initialChatAdmissions:1,observedChatRequests:0,totalAdmissionsAndObservedRequests:1});
    f.addChat("chat",[],{requests:[{requestId:"r1",atMs:NOW},{requestId:"r1",atMs:NOW},{requestId:"r2",atMs:NOW+2}],turns:[{turnId:"t1",atMs:NOW+1},{turnId:"t1",atMs:NOW+1,completed:true}]});
    expect(f.activity.summary()).toMatchObject({calls:{totalAdmissionsAndObservedRequests:2,observedChatRequests:2,observedChatRootTurns:1},chats:[{completedRootTurns:1}]});
    expect(()=>f.activity.admitChat({...admission(),initial:false})).toThrow("daily-call-budget-exhausted");
    expect(f.activity.summary().calls.totalAdmissionsAndObservedRequests).toBe(2);
  });
  it("does not count an already observed initial request twice",()=>{
    const f=fixture({maxDailyCalls:1});f.addChat("chat",[],{requests:[{requestId:"r1",atMs:NOW}]});
    f.activity.admitChat(admission());expect(f.activity.summary().calls.totalAdmissionsAndObservedRequests).toBe(1);
    expect(()=>f.activity.admitChat({...admission(),threadId:"another"})).toThrow("identity-conflict");
  });
  it("shares call admission limits across native tasks, detector and manual chat",async()=>{
    const f=fixture({maxDailyCalls:3});await f.addNative();f.detector();f.activity.admitChat(admission());
    await expect(f.native.beforeStart(task("next"))).rejects.toThrow("daily-call-budget-exhausted");
    expect(()=>f.detector("next-detector")).toThrow("daily-call-budget-exhausted");
    expect(()=>f.activity.admitChat(admission("next-chat"))).toThrow("daily-call-budget-exhausted");
    expect(f.store.list("native-accounting-tasks")).toHaveLength(1);expect(f.store.list("cost-reservations")).toHaveLength(1);
    expect(f.activity.summary().calls.totalAdmissionsAndObservedRequests).toBe(3);
  });
  it("native reported floors stop subsequent detector and chat admission",async()=>{
    const f=fixture({dailyMicros:1000000});await f.addNative(task(),[report("thread-task",0,1)]);
    expect(()=>f.detector()).toThrow("daily-cost-budget-exhausted");
    expect(()=>f.activity.admitChat(admission())).toThrow("daily-cost-budget-exhausted");
    expect(f.store.list("cost-reservations")).toEqual([]);expect(f.store.list("activity-chat-admissions")).toEqual([]);
  });
  it("chat reported floors stop subsequent native and detector admission",async()=>{
    const f=fixture({dailyMicros:1000000});f.addChat("chat",[report("thread-chat",0,1)]);
    await expect(f.native.beforeStart(task())).rejects.toThrow("daily-cost-budget-exhausted");
    expect(()=>f.detector()).toThrow("daily-cost-budget-exhausted");
    expect(f.store.list("native-accounting-tasks")).toEqual([]);expect(f.store.list("cost-reservations")).toEqual([]);
  });
  it("preserves net owner invoice labels and combines their admission threshold with native and chat floors",async()=>{
    const f=fixture();const owner={kind:"owner" as const,id:"owner"};
    const invoice={idempotencyKey:"invoice",kind:"charge" as const,basis:"reported" as const,amountMicros:1500000,currency:"USD",source:"owner invoice",reference:"invoice-1",scope:"research",occurredAtMs:NOW,runId:"run",solutionId:"solution"};
    const charge=f.legacy.recordExternal(invoice,owner,NOW);
    f.legacy.recordExternal({...invoice,idempotencyKey:"credit",kind:"credit",amountMicros:500000,appliesToId:charge.id},owner,NOW);
    await f.addNative(task(),[report("thread-task",0,2,"USD","native-session")]);
    f.addChat("chat",[report("thread-chat",0,1,"USD","chat-session"),report("thread-chat",1,3,"USD","chat-session")]);
    const summary=f.activity.summary();expect(summary.legacy.totals[0]).toMatchObject({reportedMicros:1000000,reportedCreditsMicros:500000,estimatedMicros:0});
    expect(summary.totals[0]).toMatchObject({manualChatLatestReportedSessionMicros:3000000,sharedNativeAndChatObservedFloorMicros:5000000});
    f.policy.dailyMicros=6000000;
    await expect(f.native.beforeStart(task("next"))).rejects.toThrow("daily-cost-budget-exhausted");
    expect(()=>f.detector()).toThrow("daily-cost-budget-exhausted");
    expect(()=>f.activity.admitChat(admission("new-chat"))).toThrow("daily-cost-budget-exhausted");
  });
  it("keeps declining and missing chat reports unknown without losing the observed floor",async()=>{
    const f=fixture();f.addChat("chat",[report("thread-chat",0,2),report("thread-chat",1,.5),report("thread-chat",2,undefined)]);
    const summary=f.activity.summary();expect(summary.totals[0]).toMatchObject({manualChatLatestReportedSessionMicros:null,manualChatObservedFloorMicros:2000000});
    expect(summary.chats[0]!.unknownReasons).toEqual(expect.arrayContaining(["session-cost-not-reported","session-cost-counter-decreased","final-billing-coverage-unavailable"]));
    f.policy.dailyMicros=2000000;await expect(f.native.beforeStart(task())).rejects.toThrow("daily-cost-budget-exhausted");
  });
  it("keeps reported zero distinct from an absent amount",()=>{
    const f=fixture();f.addChat("zero",[report("thread-zero",0,0,"USD","zero-session")]);f.addChat("missing");
    expect(f.activity.summary().totals[0]!.manualChatLatestReportedSessionMicros).toBe(0);
    expect(f.activity.summary().chats.find(c=>c.chatId==="missing")!.unknownReasons).toContain("cost-not-reported");
    expect(f.activity.summary().chats.every(c=>c.billingCompleteness==="unknown")).toBe(true);
  });
  it("deduplicates shared native/chat sessions and refuses ambiguous monetary attribution",async()=>{
    const f=fixture();await f.addNative(task(),[report("thread-task",0,2)]);f.addChat("chat",[report("thread-chat",0,3)]);
    const summary=f.activity.summary();expect(summary.totals[0]).toMatchObject({manualChatLatestReportedSessionMicros:null,sharedNativeAndChatObservedFloorMicros:3000000});
    expect(summary.chats[0]!.unknownReasons).toContain("provider-session-shared-between-activities");
    f.policy.scopeLimitsMicros={"solution:solution":10000000};
    await expect(f.native.beforeStart(task("next"))).rejects.toThrow("activity-cost-attribution-ambiguous");
    expect(()=>f.detector()).toThrow("activity-cost-attribution-ambiguous");
    expect(()=>f.activity.admitChat(admission())).toThrow("activity-cost-attribution-ambiguous");
  });
  it("keeps distinct providers and currencies separate even when session names match",async()=>{
    const f=fixture();await f.addNative(task(),[report("thread-task",0,2,"EUR")]);
    f.addChat("chat",[report("thread-chat",0,3)],{providerId:"claude-code"});
    expect(f.activity.summary().totals).toMatchObject([{currency:"EUR",sharedNativeAndChatObservedFloorMicros:2000000},{currency:"USD",manualChatLatestReportedSessionMicros:3000000,sharedNativeAndChatObservedFloorMicros:3000000}]);
    f.policy.scopeLimitsMicros={chat:10000000};expect(()=>f.activity.admitChat({...admission(),providerId:"claude-code"})).toThrow("budget-currency-mismatch");
  });
  it("allocates chat cumulative floor increases to observation dates across UTC boundaries",async()=>{
    const f=fixture({dailyMicros:1000000});
    f.addChat("chat",[report("thread-chat",0,.75,"USD","session",NOW-DAY),report("thread-chat",1,1.25,"USD","session",NOW)]);
    await f.native.beforeStart(task());
    f.addChat("chat",[report("thread-chat",2,1.75,"USD","session",NOW+1)]);
    await expect(f.native.beforeStart(task("next"))).rejects.toThrow("daily-cost-budget-exhausted");
    f.policy.dailyMicros=null;f.policy.monthlyMicros=1750000;f.clock(NOW+DAY);
    await expect(f.native.beforeStart(task("tomorrow"))).rejects.toThrow("monthly-cost-budget-exhausted");
  });
  it("uses chat solution costs in a shared solution threshold",async()=>{
    const f=fixture({scopeLimitsMicros:{"solution:solution":1000000}});f.addChat("chat",[report("thread-chat",0,1)]);
    await expect(f.native.beforeStart(task())).rejects.toThrow("scope-cost-budget-exhausted");
    await f.native.beforeStart(task("unrelated",{solutionId:"other"}));
  });
  it("retains exact run/solution attribution rather than mixing unrelated chat and native records",async()=>{
    const f=fixture();await f.addNative(task(),[report("thread-task",0,2,"USD","native")]);
    f.addChat("chat",[report("thread-chat",0,1,"USD","chat")],{runId:"run"});
    f.addChat("other",[report("thread-other",0,10,"USD","other")],{solutionId:"other",runId:"other-run"});
    expect(f.activity.forSolution("solution").totals[0]!.sharedNativeAndChatObservedFloorMicros).toBe(3000000);
    expect(f.activity.forRun("run").chats.map(c=>c.chatId)).toEqual(["chat"]);
    expect(f.activity.forRun("other-run").native.tasks).toEqual([]);
  });
  it("deduplicates repeated observations and rejects conflicting event identities",()=>{
    const f=fixture();const chat=f.addChat("chat",[report("thread-chat",0,1)]);chat.costObservations=[...chat.costObservations,...chat.costObservations];
    expect(f.activity.summary().totals[0]!.manualChatObservedFloorMicros).toBe(1000000);
    chat.costObservations=[...chat.costObservations,{...chat.costObservations[0]!,cost:{amount:9,currency:"USD"}}];
    expect(()=>f.activity.summary()).toThrow("activity-chat-event-conflict");
  });
  it("qualifies cross-activity native attribution even in a native-only filtered view",async()=>{
    const f=fixture();await f.addNative(task(),[report("thread-task",0,2)]);
    f.addChat("chat",[report("thread-chat",0,3)],{solutionId:"other",runId:"other-run"});
    for(const view of [f.activity.summary(),f.activity.forRun("run"),f.activity.forSolution("solution")]){
      expect(view.native.totals[0]!.nativeLatestReportedSessionMicros).toBeNull();
      expect(view.native.tasks[0]!.unknownReasons).toContain("provider-session-shared-between-activities");
    }
    expect(f.activity.forSolution("solution").chats).toEqual([]);
    expect(f.activity.forSolution("other").totals[0]!.manualChatLatestReportedSessionMicros).toBeNull();
    expect(f.activity.summary().totals[0]!.sharedNativeAndChatObservedFloorMicros).toBe(3000000);
  });
  it("correlates current chat requests with shared sessions even without a cost amount",async()=>{
    const previousMonth=Date.parse("2026-10-31T10:00:00Z");
    for(const shared of [true,false]){
      const f=fixture();f.clock(previousMonth);
      await f.addNative(task("old",{startedAtMs:previousMonth}),[report("thread-old",0,1,"USD","session",previousMonth)]);
      f.clock(NOW);f.activity.admitChat(admission());
      f.addChat("chat",[report("thread-chat",0,undefined,"USD",shared?"session":"unrelated")],{requests:[{requestId:"request",atMs:NOW}]});
      f.policy.monthlyMicros=10000000;
      if(shared)await expect(f.native.beforeStart(task())).rejects.toThrow("activity-cost-attribution-ambiguous");
      else await f.native.beforeStart(task());
    }
  });
  it("preserves priced reservation bounds through the shared admission guard",()=>{
    const f=fixture({allowUnknown:false,dailyMicros:10});f.detector("first",3);f.detector("second",3);
    f.legacy.settle({id:"first",model:"laya",status:"interrupted",complete:false,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}},NOW+1);
    f.detector("third",3);
    expect(f.activity.summary().legacy).toMatchObject({metrics:{pendingAttempts:2,usageIncompleteAttempts:1},totals:[{unknownAttempts:1,reservedMicros:6}]});
    expect(()=>f.detector("fourth",2)).toThrow("daily-cost-budget-exhausted");
  });
  it("still refuses an existing genuinely unbounded detector amount without unknown authorization",()=>{
    const f=fixture();f.legacy.reserve({id:"unpriced",model:"unpriced",scope:"reactive",inputBound:1,outputBound:0},NOW);
    f.policy.allowUnknown=false;expect(()=>f.detector()).toThrow("activity-cost-unknown-not-authorized");
  });
  it("rejects reuse of another conversation's usage receipt",()=>{
    const f=fixture();const chat=f.addChat();chat.usage={...chat.usage,threadId:"other"};
    expect(()=>f.activity.summary()).toThrow("activity-chat-usage-binding-conflict");
  });
  it("does not treat priced detector work as permission to ignore existing unknown native billing",async()=>{
    const f=fixture();await f.addNative();f.policy.allowUnknown=false;
    expect(()=>f.detector()).toThrow("activity-cost-unknown-not-authorized");expect(f.store.list("cost-reservations")).toEqual([]);
  });
});
