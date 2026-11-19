import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeUsageLedger, type NativeUsageBinding, type NativeUsageSdk } from "../src/native-usage.js";
import { Store, MIGRATIONS } from "../src/store.js";

const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(providerId="codex"){
  const db=new Database(":memory:");databases.push(db);MIGRATIONS.forEach(sql=>db.exec(sql));
  const store=new Store(db),ledger=new NativeUsageLedger(store);
  const binding:NativeUsageBinding={taskId:"task",threadId:"thread",providerId,requestedModel:"selected-model"};
  return {store,ledger,binding};
}
const tokens=(total=100)=>({totalTokens:total,inputTokens:total-10,cachedInputTokens:20,outputTokens:10,reasoningOutputTokens:4});
function usage(seq:number,total=100,session="session"){
  return {id:`event-${seq}`,threadId:"thread",seq,createdAt:1000+seq,scope:{kind:"turn",turnId:"turn"},type:"thread/tokenUsage/updated",
    data:{providerThreadId:session,tokenUsage:{total:tokens(total),last:tokens(total)},unrelatedPrivateText:"must not persist"}};
}
function cost(seq:number,value:{amount:number;currency:string}|undefined,session="session"){
  return {id:`event-${seq}`,threadId:"thread",seq,createdAt:1000+seq,scope:{kind:"thread"},type:"thread/contextWindowUsage/updated",
    data:{providerThreadId:session,contextWindowUsage:{usedTokens:42,modelContextWindow:1000,estimated:false,...(value?{cost:value}:{})}}};
}
function sdk(read:ReturnType<typeof vi.fn>):NativeUsageSdk {return {threads:{events:{list:read}}} as unknown as NativeUsageSdk;}

describe("BB-native usage observations",()=>{
  it.each(["codex","claude-code","another-bb-provider"])("keeps %s's reported semantics without adding cumulative updates or pricing them",provider=>{
    const {store,ledger,binding}=fixture(provider);
    ledger.ingest(binding,[usage(1),usage(2,150),cost(3,{amount:2.5,currency:"EUR"})]);
    ledger.ingest(binding,[usage(1),usage(2,150),cost(3,{amount:2.5,currency:"EUR"})]);
    const result=ledger.read(binding);
    expect(result.sessions).toEqual([{providerSessionId:"session",tokens:tokens(150),cost:{amount:2.5,currency:"EUR"},tokenSequence:2,costSequence:3,counterResetObserved:false}]);
    expect(result.historyCaughtUp).toBe(false);
    expect(store.list("native-usage-observations")).toHaveLength(3);
    expect(JSON.stringify(store.list("native-usage-observations"))).not.toContain("must not persist");
    expect(result.sessions[0]!.tokens!.outputTokens).toBe(10); // reasoning is not counted a second time
    expect(result.sessions[0]!.tokens).not.toHaveProperty("cacheReadInputTokens");
    expect(result).not.toHaveProperty("amountMicros");
    expect(result).not.toHaveProperty("invoice");
  });
  it("distinguishes missing and zero cost, and never carries one session's report into another",()=>{
    const {ledger,binding}=fixture();
    ledger.ingest(binding,[cost(0,{amount:0,currency:"USD"}),usage(1),usage(2,100,"new-session")]);
    expect(ledger.read(binding).sessions.map(s=>s.cost)).toEqual([{amount:0,currency:"USD"},null]);
    ledger.ingest(binding,[cost(3,undefined)]);
    expect(ledger.read(binding).sessions[0]!.cost).toBeNull();
    expect(ledger.read(binding).sessions[0]!.costSequence).toBe(3);
  });
  it("flags a cumulative counter reset, keeps original observations and does not invent a lifetime total",()=>{
    const {store,ledger,binding}=fixture();
    ledger.ingest(binding,[usage(1,500),usage(2,100),usage(3,200)]);
    const session=ledger.read(binding).sessions[0]!;
    expect(session.counterResetObserved).toBe(true);expect(session.tokens!.totalTokens).toBe(200);
    expect(store.list("native-usage-observations")).toHaveLength(3);
  });
  it("rejects conflicting replays, changed attribution and an invalid page atomically",()=>{
    const {store,ledger,binding}=fixture();ledger.ingest(binding,[usage(1)]);
    expect(()=>ledger.ingest(binding,[usage(1,101)])).toThrow("event-conflict");
    expect(()=>ledger.ingest({...binding,taskId:"other"},[])).toThrow("binding-conflict");
    expect(()=>ledger.read({...binding,providerId:"another"})).toThrow("binding-conflict");
    expect(()=>ledger.ingest(binding,[usage(2),{...usage(3),threadId:"other"}])).toThrow("wrong-thread");
    expect(()=>ledger.ingest(binding,[usage(0)])).toThrow("unseen-earlier-event");
    expect(()=>ledger.ingest(binding,[usage(3),usage(2)])).toThrow("page-order");
    expect(store.list("native-usage-observations")).toHaveLength(1);
    expect(ledger.read(binding).throughSequence).toBe(1);
  });
  it("resumes a bounded event read from its durable cursor after source interruption",async()=>{
    const {store,ledger,binding}=fixture();
    const first=Array.from({length:100},(_,i)=>usage(i,100+i));
    const list=vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("private upstream details"));
    const partial=await ledger.collect(sdk(list),binding);
    expect(partial.historyCaughtUp).toBe(false);expect(partial.retrievalIssue).toBe("native-usage-source-unavailable");
    expect(partial.throughSequence).toBe(99);
    expect(list.mock.calls[0]![0]).toMatchObject({limit:"100"});
    const reloaded=new NativeUsageLedger(store);
    list.mockResolvedValueOnce([cost(101,{amount:1,currency:"USD"})]);
    const complete=await reloaded.collect(sdk(list),binding);
    expect(list.mock.calls[2]![0]).toMatchObject({afterSeq:"99",types:["thread/tokenUsage/updated","thread/contextWindowUsage/updated"]});
    expect(complete.historyCaughtUp).toBe(true);expect(complete.retrievalIssue).toBeNull();
    expect(complete.sessions[0]!.tokens!.totalTokens).toBe(199);
    expect(store.list("native-usage-observations")).toHaveLength(101);
    expect(JSON.stringify(store.list("native-usage-reads"))).not.toContain("private upstream details");
  });
  it("keeps empty, limited and malformed retrieval distinct from completed accounting",async()=>{
    const {ledger,binding}=fixture();
    const empty=await ledger.collect(sdk(vi.fn().mockResolvedValue([])),binding);
    expect(empty.historyCaughtUp).toBe(true);expect(empty.sessions).toEqual([]);
    const limited=await ledger.collect(sdk(vi.fn().mockResolvedValue(Array.from({length:100},(_,i)=>usage(i)))),binding,{maxPages:1});
    expect(limited.historyCaughtUp).toBe(false);expect(limited.retrievalIssue).toBe("native-usage-page-limit");
    const invalid=await ledger.collect(sdk(vi.fn().mockResolvedValue([usage(99)])),binding);
    expect(invalid.historyCaughtUp).toBe(false);expect(invalid.retrievalIssue).toBe("native-usage-invalid-page");
    expect(invalid.throughSequence).toBe(99);
  });
  it("does not consume a response returned after cancellation",async()=>{
    const {ledger,binding}=fixture(),controller=new AbortController();
    const list=vi.fn(async()=>{controller.abort();return [usage(1)];});
    await expect(ledger.collect(sdk(list),binding,{signal:controller.signal})).rejects.toThrow();
    expect(ledger.read(binding).throughSequence).toBe(-1);
  });
  it("retains attribution when usage has never been available",async()=>{
    const {ledger,binding}=fixture();
    const result=await ledger.collect(sdk(vi.fn().mockRejectedValue(new Error("unavailable"))),binding);
    expect(result.sessions).toEqual([]);expect(result.historyCaughtUp).toBe(false);
    await expect(ledger.collect(sdk(vi.fn()),{...binding,taskId:"different"})).rejects.toThrow("binding-conflict");
  });
  it("does not let a delayed empty page certify a concurrent reader's unfinished history",async()=>{
    const {store,ledger,binding}=fixture();ledger.ingest(binding,[usage(199)]);
    let answer!:(rows:unknown[])=>void;
    const oldResponse=new Promise<unknown[]>(resolve=>{answer=resolve;});
    const oldRead=ledger.collect(sdk(vi.fn(()=>oldResponse)),binding);
    const otherReader=new NativeUsageLedger(store);
    const partial=await otherReader.collect(sdk(vi.fn().mockResolvedValue(Array.from({length:100},(_,i)=>usage(i+200,300+i)))),binding,{maxPages:1});
    expect(partial.retrievalIssue).toBe("native-usage-page-limit");expect(partial.throughSequence).toBe(299);
    answer([]);
    const stale=await oldRead;
    expect(stale.historyCaughtUp).toBe(false);expect(stale.retrievalIssue).toBe("native-usage-concurrent-update");
    expect(ledger.read(binding)).toMatchObject({throughSequence:299,historyCaughtUp:false,retrievalIssue:"native-usage-page-limit"});
  });
});
