import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { Accounting, type CostPolicy, type ExternalCostInput } from "../src/costs.js";
const dbs: Database.Database[] = [];
const now = Date.UTC(2026, 10, 18);
const policy: CostPolicy = { currency: "USD", dailyMicros: 100, monthlyMicros: 1000, maxDailyCalls: 10, allowUnknown: false, prices: { m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, version: "2026-11" } } };
function make() { const db = new Database(":memory:"); dbs.push(db); for (const sql of MIGRATIONS) db.exec(sql); return new Accounting(new Store(db), () => policy); }
afterEach(() => { dbs.splice(0).forEach(d => d.close()); });
it("reserves concurrency headroom before sending requests", () => {
  const a = make(); a.reserve({ id: "a", model: "m", inputBound: 10, outputBound: 30, scope: "miner" }, now);
  expect(() => a.reserve({ id: "b", model: "m", inputBound: 10, outputBound: 30, scope: "miner" }, now)).toThrow(/budget/);
});
it("settles once and counts retries as distinct attempts", () => {
  const a = make(); a.reserve({ id: "a", model: "m", inputBound: 1, outputBound: 2, scope: "miner" }, now);
  a.settle({ id: "a", model: "m", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, complete: true, status: "success" }, now+1);
  a.settle({ id: "a", model: "m", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, complete: true, status: "success" }, now+2);
  expect(a.summary().totals[0]).toMatchObject({ currency: "USD", estimatedMicros: 5, attempts: 1 });
});
it("records partial-stream charges as unknown, retaining budget headroom", () => {
  const a = make(); a.reserve({ id: "a", model: "m", inputBound: 10, outputBound: 30, scope: "miner" }, now);
  a.settle({ id: "a", model: "m", usage: { inputTokens: 2, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, complete: false, status: "interrupted" }, now+1);
  expect(a.summary().totals[0]).toMatchObject({ unknownAttempts: 1, estimatedMicros: 0 });
  expect(() => a.reserve({ id: "b", model: "m", inputBound: 10, outputBound: 30, scope: "miner" }, now+2)).toThrow(/budget/);
});
it("does not silently treat unpriced models as free", () => {
  expect(() => make().reserve({ id: "a", model: "other", inputBound: 1, outputBound: 1, scope: "inventor" }, now)).toThrow(/unpriced/);
});
it("counts numeric partial streaming usage as incomplete until a verified terminal response",()=>{
  const a=make();a.reserve({id:"partial",model:"m",inputBound:10,outputBound:30,scope:"chat"},now);
  a.settle({id:"partial",model:"m",usage:{inputTokens:2,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},complete:false,status:"interrupted"},now+1);
  expect(a.summary().metrics.usageIncompleteAttempts).toBe(1);expect(a.summary().totals[0]?.unknownAttempts).toBe(1);
});
const owner = { kind: "owner" as const, id: "local-owner" };
const invoice = (overrides: Partial<ExternalCostInput> = {}): ExternalCostInput => ({ idempotencyKey: "invoice-one", kind: "charge", basis: "reported", amountMicros: 40, currency: "USD", source: "provider invoice", reference: "invoice-2026-11-one", scope: "miner", occurredAtMs: now, ...overrides });
function settled(a: Accounting, id = "a") {
  a.reserve({ id, model: "m", inputBound: 10, outputBound: 20, scope: "miner", runId: "run-one", solutionId: "solution-one" },now);
  a.settle({ id, model: "m", usage: { inputTokens: 5, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, complete: true, status: "success" },now+1);
}
it("reconciles a reported model invoice without double-counting its token estimate", () => {
  const a = make(); settled(a);
  a.recordExternal(invoice({ attemptId: "a", amountMicros: 30 }),owner,now+2);
  expect(a.summary().totals[0]).toMatchObject({ reportedMicros: 30, estimatedMicros: 0, attempts: 1 });
  expect(a.summary().events).toHaveLength(1);
  expect(a.store.get("costs","a")).toMatchObject({ basis: "estimated", amountMicros: 25 });
  expect(a.forRun("run-one").totals[0]).toMatchObject({ reportedMicros: 30 });
  expect(a.forSolution("solution-one").totals[0]).toMatchObject({ reportedMicros: 30 });
});
it("records infrastructure invoices even above budget, then blocks new spending", () => {
  const a=make(); a.recordExternal(invoice({ amountMicros: 110, scope: "infrastructure" }),owner,now);
  expect(a.summary().totals[0]).toMatchObject({ reportedMicros: 110, attempts: 0 });
  expect(()=>a.reserve({id:"a",model:"m",inputBound:1,outputBound:1,scope:"miner"},now)).toThrow(/budget/);
});
it("requires owner provenance and immutable idempotency", () => {
  const a=make();
  expect(()=>a.recordExternal(invoice(),{kind:"service",id:"worker"},now)).toThrow(/owner/);
  const first=a.recordExternal(invoice(),owner,now);
  expect(a.recordExternal(invoice(),owner,now+1)).toEqual(first);
  expect(()=>a.recordExternal(invoice({amountMicros:41}),owner,now+1)).toThrow(/conflict/);
  expect(a.summary().externalRecords).toHaveLength(1);
});
it("rejects wrong-currency or mismatched-scope links and a second invoice for one attempt", () => {
  const a=make(); settled(a);
  expect(()=>a.recordExternal(invoice({attemptId:"a",currency:"EUR"}),owner,now+2)).toThrow(/currency/);
  expect(()=>a.recordExternal(invoice({attemptId:"a",scope:"builder"}),owner,now+2)).toThrow(/scope/);
  expect(()=>a.recordExternal(invoice({attemptId:"missing"}),owner,now+2)).toThrow(/settled|attempt/);
  a.recordExternal(invoice({attemptId:"a"}),owner,now+2);
  expect(()=>a.recordExternal(invoice({attemptId:"a",idempotencyKey:"double"}),owner,now+3)).toThrow(/already|replacement/);
});
it("bounds credits against real recorded charges and applies them to the original budget period", () => {
  const a=make();
  const charge=a.recordExternal(invoice({occurredAtMs:now-86400000,amountMicros:80}),owner,now);
  const credit=invoice({idempotencyKey:"credit-one",kind:"credit",amountMicros:60,appliesToId:charge.id});
  a.recordExternal(credit,owner,now+1);
  expect(()=>a.recordExternal({...credit,idempotencyKey:"over-credit",amountMicros:21},owner,now+1)).toThrow(/exceed/);
  expect(()=>a.recordExternal({...credit,idempotencyKey:"wrong-currency",currency:"EUR"},owner,now+1)).toThrow(/currency/);
  expect(a.summary().totals[0]).toMatchObject({reportedMicros:20});
  a.reserve({id:"today",model:"m",inputBound:10,outputBound:30,scope:"miner"},now+1);
  expect(()=>a.reserve({id:"more-today",model:"m",inputBound:10,outputBound:30,scope:"miner"},now+1)).toThrow(/budget/);
});
it("preserves immutable correction history and carries credits through a reported correction", () => {
  const a=make(); const charge=a.recordExternal(invoice({amountMicros:60}),owner,now);
  a.recordExternal(invoice({idempotencyKey:"credit",kind:"credit",amountMicros:20,appliesToId:charge.id}),owner,now+1);
  const replacement=a.recordExternal(invoice({idempotencyKey:"corrected",amountMicros:50,replacesId:charge.id,reference:"corrected-invoice"}),owner,now+2);
  expect(a.summary().totals[0]).toMatchObject({reportedMicros:30});
  expect(a.summary().externalRecords).toHaveLength(3);
  expect(()=>a.recordExternal(invoice({idempotencyKey:"stale-correction",amountMicros:70,replacesId:charge.id}),owner,now+3)).toThrow(/latest|replaced/);
  expect(()=>a.recordExternal(invoice({idempotencyKey:"below-credit",amountMicros:10,replacesId:replacement.id}),owner,now+3)).toThrow(/credit/);
});
it("does not treat an unknown infrastructure charge as a known zero", () => {
  const a=make(); const unknown=a.recordExternal(invoice({basis:"unknown",amountMicros:null}),owner,now);
  expect(a.summary().totals[0]).toMatchObject({unknownExternalCosts:1,reportedMicros:0,estimatedMicros:0});
  expect(()=>a.reserve({id:"a",model:"m",inputBound:1,outputBound:1,scope:"miner"},now)).toThrow(/unknown/);
  a.recordExternal(invoice({idempotencyKey:"known-invoice",replacesId:unknown.id,amountMicros:20}),owner,now+1);
  expect(a.summary().totals[0]).toMatchObject({unknownExternalCosts:0,reportedMicros:20});
  a.reserve({id:"a",model:"m",inputBound:1,outputBound:1,scope:"miner"},now+2);
});
it("cannot credit estimates, unknown charges, or missing charges", () => {
  const a=make(); const estimate=a.recordExternal(invoice({basis:"estimated",amountMicros:30}),owner,now);
  expect(()=>a.recordExternal(invoice({kind:"credit",appliesToId:estimate.id,idempotencyKey:"credit"}),owner,now+1)).toThrow(/reported/);
  expect(()=>a.recordExternal(invoice({kind:"credit",appliesToId:"missing",idempotencyKey:"credit"}),owner,now+1)).toThrow(/charge/);
  expect(()=>a.recordExternal(invoice({amountMicros:-1}),owner,now)).toThrow(/amount/);
});
it("accounts for external charges when reserving concurrent headroom and scoped limits", () => {
  const a=make(); a.recordExternal(invoice({amountMicros:30}),owner,now);
  a.reserve({id:"a",model:"m",inputBound:10,outputBound:20,scope:"miner"},now);
  expect(()=>a.reserve({id:"b",model:"m",inputBound:10,outputBound:20,scope:"miner"},now)).toThrow(/budget/);
  const scoped=new Accounting(a.store,()=>({...policy,dailyMicros:1000,monthlyMicros:10000,scopeLimitsMicros:{builder:40}}));
  scoped.recordExternal(invoice({idempotencyKey:"builder-cost",amountMicros:30,scope:"builder"}),owner,now);
  expect(()=>scoped.reserve({id:"builder-attempt",model:"m",inputBound:1,outputBound:5,scope:"builder"},now)).toThrow(/scope-cost-budget/);
});
it("rejects unsafe settlement values while keeping the original reservation", () => {
  const a=make(); a.reserve({id:"a",model:"m",inputBound:1,outputBound:1,scope:"miner"},now);
  const result={id:"a",model:"m",usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0},complete:true,status:"success"};
  expect(()=>a.settle({...result,model:"other"},now+1)).toThrow(/model/);
  expect(()=>a.settle({...result,usage:{...result.usage,inputTokens:-1}},now+1)).toThrow(/usage/);
  expect(a.summary().pending).toHaveLength(1);
});
it("keeps unknown usage distinguishable from measured zero after an invoice arrives", () => {
  const a=make();a.reserve({id:"a",model:"m",inputBound:1,outputBound:1,scope:"miner"},now);
  a.settle({id:"a",model:"m",usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null},complete:false,status:"interrupted"},now+1);
  a.recordExternal(invoice({attemptId:"a",amountMicros:2}),owner,now+2);
  expect(a.summary().totals[0]).toMatchObject({reportedMicros:2,unknownAttempts:0});
  expect(a.summary().metrics).toMatchObject({knownInputTokens:0,usageIncompleteAttempts:1});
});
