import type { Actor, Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number; version: string }
export interface CostPolicy {
  currency: string; dailyMicros: number | null; monthlyMicros: number | null;
  maxDailyCalls: number; allowUnknown: boolean; prices: Record<string, Price>;
  scopeLimitsMicros?: Record<string, number>;
}
export interface Reservation { id: string; model: string; inputBound: number; outputBound: number; scope: string; runId?: string; solutionId?: string; accountId?: string; workerId?: string }
/** Invoked synchronously inside reserve's transaction, before a new reservation is written. */
export type AccountingAdmissionGuard = (input: { request: Reservation; atMs: number; currency: string; maxMicros: number; unknown: boolean }) => void;
export interface Usage { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }
export interface Settlement { id: string; model: string; usage: Usage; complete: boolean; status: string; durationMs?: number }
export interface CostEvent extends Reservation {
  at: number; endedAt: number; currency: string; price: Price | null; maxMicros: number;
  basis: "reported" | "estimated" | "unknown"; amountMicros: number | null; usage: Usage; complete?:boolean; status: string; durationMs?: number;
}
export interface ExternalCostInput {
  idempotencyKey: string; kind: "charge" | "credit"; basis: "reported" | "estimated" | "unknown";
  amountMicros: number | null; currency: string; source: string; reference: string; scope: string; occurredAtMs: number;
  runId?: string; solutionId?: string; attemptId?: string; appliesToId?: string; replacesId?: string;
}
export interface ExternalCostRecord extends ExternalCostInput { id: string; recordedAtMs: number; actor: { kind: "owner"; id: string } }
export interface ExternalCostEvent {
  id: string; at: number; endedAt: number; currency: string; basis: "reported" | "estimated" | "unknown"; amountMicros: number | null;
  scope: string; source: string; reference: string; status: "recorded"; runId?: string; solutionId?: string;
  reportedCreditsMicros: number; externalRecordId: string;
}
interface EffectiveExternal { record: ExternalCostRecord; root: ExternalCostRecord; amountMicros: number | null; creditsMicros: number }
interface BudgetEntry { at: number; currency: string; amountMicros: number; unknownUnbounded: boolean; scope: string; solutionId?: string }
const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
function bounded(value: string, name: string, limit = 200): void {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`invalid-${name}`);
}
function checkedTime(value: number): void { if (!valid(value) || value > 8_640_000_000_000_000) throw new Error("invalid-cost-time"); }
function sum(values: number[]): number { let total=0; for(const value of values) { if(!valid(value)||!valid(total+value))throw new Error("cost-total-overflow"); total+=value; } return total; }
function effectiveExternal(records: ExternalCostRecord[]): EffectiveExternal[] {
  const byId=new Map(records.map(r=>[r.id,r])), replaced=new Set(records.flatMap(r=>r.replacesId?[r.replacesId]:[]));
  return records.filter(r=>r.kind==="charge"&&!replaced.has(r.id)).map(record=>{
    const lineage=new Set<string>(); let root=record;
    for (;;) {
      if(lineage.has(root.id))throw new Error("external-cost-lineage-cycle");lineage.add(root.id);
      if(!root.replacesId)break;
      const previous=byId.get(root.replacesId);if(!previous||previous.kind!=="charge")throw new Error("external-cost-lineage-invalid");root=previous;
    }
    const creditsMicros=sum(records.filter(r=>r.kind==="credit"&&r.appliesToId&&lineage.has(r.appliesToId)).map(r=>r.amountMicros??0));
    if(creditsMicros>(record.amountMicros??0))throw new Error("external-credit-exceeds-charge");
    return {record,root,creditsMicros,amountMicros:record.amountMicros===null?null:record.amountMicros-creditsMicros};
  });
}
export class Accounting {
  constructor(readonly store: Store, readonly policy: () => CostPolicy, readonly admissionGuard?: AccountingAdmissionGuard) {}
  /** Called once after a process restart, before any new calls. Retain reserved headroom for unknown bills. */
  recoverInterrupted(now=Date.now()):number {
    const pending=this.store.list<CostEvent>("cost-reservations").filter(event=>event.status==="reserved");
    for(const event of pending)this.settle({id:event.id,model:event.model,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null},complete:false,status:"interrupted-by-restart"},now);
    return pending.length;
  }
  reserve(request: Reservation, now = Date.now()): void {
    checkedTime(now);
    const p = this.policy(); const price = p.prices[request.model];
    if (!valid(request.inputBound) || !valid(request.outputBound)) throw new Error("invalid-token-bound");
    if (!price && !p.allowUnknown) throw new Error("unpriced-model: configure prices or explicitly allow unknown costs");
    if (price && [price.input, price.output, price.cacheRead, price.cacheWrite].some(n => !Number.isFinite(n) || n < 0)) throw new Error("invalid-price");
    const maxMicros = price ? Math.ceil(request.inputBound * Math.max(price.input, price.cacheRead, price.cacheWrite) + request.outputBound * price.output) : 0;
    if (!valid(maxMicros)) throw new Error("cost-bound-overflow");
    this.store.transaction(() => {
      if (this.store.get("cost-reservations", request.id)) throw new Error("duplicate-attempt-id");
      this.admissionGuard?.({ request, atMs: now, currency: p.currency, maxMicros, unknown: !price });
      const day = new Date(now).toISOString().slice(0,10), month = day.slice(0,7);
      const entries = this.store.list<CostEvent>("cost-reservations");
      const today = entries.filter(e => new Date(e.at).toISOString().startsWith(day));
      if (today.length >= p.maxDailyCalls) throw new Error("daily-call-budget-exhausted");
      const external=effectiveExternal(this.store.list<ExternalCostRecord>("external-costs"));
      const linked=new Map(external.filter(e=>e.record.attemptId).map(e=>[e.record.attemptId!,e]));
      const budget: BudgetEntry[]=entries.map(e=>({at:e.at,currency:e.currency,scope:e.scope,solutionId:e.solutionId,amountMicros:linked.get(e.id)?.amountMicros??e.amountMicros??e.maxMicros,unknownUnbounded:!linked.has(e.id)&&e.amountMicros===null&&e.maxMicros===0&&e.price===null}));
      for(const e of external.filter(e=>!e.record.attemptId))budget.push({at:e.root.occurredAtMs,currency:e.record.currency,scope:e.record.scope,solutionId:e.record.solutionId,amountMicros:e.amountMicros??0,unknownUnbounded:e.amountMicros===null});
      const monthly=budget.filter(e=>new Date(e.at).toISOString().startsWith(month)), daily=monthly.filter(e=>new Date(e.at).toISOString().startsWith(day));
      if(!p.allowUnknown&&monthly.some(e=>e.currency===p.currency&&e.unknownUnbounded))throw new Error("unknown-external-cost: report or explicitly allow unknown costs");
      if((p.dailyMicros!==null||p.monthlyMicros!==null)&&monthly.some(e=>e.currency!==p.currency&&(e.amountMicros>0||e.unknownUnbounded)))throw new Error("budget-currency-mismatch: reconcile external charges in the configured budget currency without invented exchange rates");
      const total=(xs:BudgetEntry[])=>sum(xs.filter(e=>e.currency===p.currency).map(e=>e.amountMicros));
      if (p.dailyMicros !== null && sum([total(daily),maxMicros]) > p.dailyMicros) throw new Error("daily-cost-budget-exhausted");
      if (p.monthlyMicros !== null && sum([total(monthly),maxMicros]) > p.monthlyMicros) throw new Error("monthly-cost-budget-exhausted");
      for (const scope of [request.scope, request.solutionId && `solution:${request.solutionId}`].filter((v): v is string => !!v)) {
        const limit = p.scopeLimitsMicros?.[scope];
        if (limit !== undefined && sum([total(daily.filter(e => e.scope === scope || `solution:${e.solutionId}` === scope)),maxMicros]) > limit) throw new Error("scope-cost-budget-exhausted");
      }
      this.store.put("cost-reservations", request.id, { ...request, at: now, currency: p.currency, price: price ?? null, maxMicros, amountMicros: null, status: "reserved" });
    });
  }
  settle(result: Settlement, now = Date.now()): void {
    checkedTime(now);
    for(const field of ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"] as const)if(result.usage[field]!==null&&!valid(result.usage[field]))throw new Error("invalid-cost-usage");
    if(result.durationMs!==undefined&&!valid(result.durationMs))throw new Error("invalid-cost-duration");
    this.store.transaction(() => {
      const previous=this.store.get<CostEvent>("costs",result.id);
      if(previous){if(previous.model!==result.model||previous.status!==result.status||stableJson(previous.usage)!==stableJson(result.usage))throw new Error("cost-settlement-conflict");return;}
      const reserved = this.store.get<CostEvent>("cost-reservations", result.id);
      if (!reserved) throw new Error("missing-cost-reservation");
      if(result.model!==reserved.model)throw new Error("settlement-model-mismatch");
      const allKnown = result.complete && Object.values(result.usage).every(n => n !== null && valid(n));
      const price = reserved.price;
      const amountMicros = allKnown && price ? Math.ceil(result.usage.inputTokens! * price.input + result.usage.outputTokens! * price.output + result.usage.cacheReadTokens! * price.cacheRead + result.usage.cacheWriteTokens! * price.cacheWrite) : null;
      if (amountMicros !== null && !valid(amountMicros)) throw new Error("invalid-cost-usage");
      const event: CostEvent = { ...reserved, ...result, at: reserved.at, endedAt: now, basis: amountMicros === null ? "unknown" : "estimated", amountMicros };
      this.store.put("costs", result.id, event);
      this.store.put("cost-reservations", result.id, event);
    });
  }

  /** Owner-entered invoice attestations. Records remain immutable, including corrections and credits. */
  recordExternal(input: ExternalCostInput, actor: Actor, now=Date.now()): ExternalCostRecord {
    if(actor.kind!=="owner")throw new Error("external-cost-record-requires-owner");
    checkedTime(now);checkedTime(input.occurredAtMs);
    if(input.occurredAtMs>now)throw new Error("external-cost-is-in-the-future");
    for(const [name,value] of Object.entries({idempotencyKey:input.idempotencyKey,source:input.source,reference:input.reference,scope:input.scope}))bounded(value,name,500);
    bounded(actor.id,"owner-id");
    if(!/^[A-Z]{3}$/.test(input.currency))throw new Error("invalid-cost-currency");
    if(!["charge","credit"].includes(input.kind)||!["reported","estimated","unknown"].includes(input.basis))throw new Error("invalid-external-cost-kind-or-basis");
    if(input.basis==="unknown"?input.amountMicros!==null:!valid(input.amountMicros as number))throw new Error("invalid-external-cost-amount");
    for(const [name,value] of Object.entries({runId:input.runId,solutionId:input.solutionId,attemptId:input.attemptId,appliesToId:input.appliesToId,replacesId:input.replacesId}))if(value!==undefined)bounded(value,name);
    if(input.kind==="credit"&&(!input.appliesToId||input.replacesId||input.basis!=="reported"||!input.amountMicros))throw new Error("credit-needs-a-positive-reported-amount-and-prior-charge");
    if(input.kind==="charge"&&input.appliesToId)throw new Error("charge-cannot-apply-a-credit");
    const id=stableId("external-cost",input.idempotencyKey);
    return this.store.transaction(()=>{
      const records=this.store.list<ExternalCostRecord>("external-costs"),byId=new Map(records.map(r=>[r.id,r]));
      const supplied:ExternalCostInput={idempotencyKey:input.idempotencyKey,kind:input.kind,basis:input.basis,amountMicros:input.amountMicros,currency:input.currency,source:input.source,reference:input.reference,scope:input.scope,occurredAtMs:input.occurredAtMs,
        ...(input.runId?{runId:input.runId}:{}),...(input.solutionId?{solutionId:input.solutionId}:{}),...(input.attemptId?{attemptId:input.attemptId}:{}),...(input.appliesToId?{appliesToId:input.appliesToId}:{}),...(input.replacesId?{replacesId:input.replacesId}:{})};
      const prior=input.kind==="credit"?byId.get(input.appliesToId!):input.replacesId?byId.get(input.replacesId):undefined;
      if(input.kind==="credit"||input.replacesId){
        if(!prior||prior.kind!=="charge")throw new Error("external-cost-prior-charge-missing");
        if(prior.currency!==input.currency)throw new Error("external-cost-currency-mismatch");
        if(prior.scope!==input.scope)throw new Error("external-cost-scope-mismatch");
        for(const field of ["runId","solutionId","attemptId"] as const){if(input[field]!==undefined&&input[field]!==prior[field])throw new Error("external-cost-link-mismatch");if(prior[field])supplied[field]=prior[field];}
        if(input.replacesId&&input.occurredAtMs!==prior.occurredAtMs)throw new Error("correction-must-preserve-original-service-time");
      }
      if(supplied.attemptId){
        const attempt=this.store.get<CostEvent>("costs",supplied.attemptId);
        if(!attempt)throw new Error("external-cost-needs-a-settled-attempt");
        if(input.basis!=="reported")throw new Error("linked-attempt-needs-reported-charge");
        if(input.currency!==attempt.currency)throw new Error("external-cost-currency-mismatch");
        if(input.scope!==attempt.scope)throw new Error("external-cost-scope-mismatch");
        for(const field of ["runId","solutionId"] as const){if(supplied[field]!==undefined&&supplied[field]!==attempt[field])throw new Error("external-cost-link-mismatch");if(attempt[field])supplied[field]=attempt[field];}
      }
      const previous=byId.get(id);
      if(previous){const {id:_,recordedAtMs:__,actor:___,...definition}=previous;if(stableJson(definition)!==stableJson(supplied))throw new Error("external-cost-idempotency-conflict");return previous;}
      const effective=effectiveExternal(records);
      if(input.kind==="credit"){
        if(prior!.basis!=="reported"||prior!.amountMicros===null)throw new Error("credits-require-a-reported-prior-charge");
        const current=effective.find(e=>e.record.id===prior!.id);
        if(!current)throw new Error("credit-must-reference-the-latest-unreplaced-charge");
        if(input.amountMicros!>current.amountMicros!)throw new Error("credit-would-exceed-the-prior-charge");
      }else if(input.replacesId){
        const current=effective.find(e=>e.record.id===input.replacesId);
        if(!current)throw new Error("correction-must-reference-the-latest-unreplaced-charge");
        if(input.basis!=="reported")throw new Error("correction-must-be-a-reported-charge");
        if(input.amountMicros!<current.creditsMicros)throw new Error("corrected-charge-is-below-existing-credits");
      }else if(supplied.attemptId&&effective.some(e=>e.record.attemptId===supplied.attemptId))throw new Error("attempt-already-has-a-reported-charge-use-explicit-replacement");
      const record:ExternalCostRecord={...supplied,id,recordedAtMs:now,actor:{kind:"owner",id:actor.id}};
      if(!this.store.insert("external-costs",id,record,now))throw new Error("external-cost-idempotency-conflict");
      return record;
    });
  }
  forRun(id:string) { bounded(id,"run-id");return this.rollup(e=>e.runId===id); }
  forSolution(id:string) { bounded(id,"solution-id");return this.rollup(e=>e.solutionId===id); }
  /** Exact-ID union for a caller-resolved solution family. Retains every original attribution. */
  forSolutionIds(ids:readonly string[]) {
    if(!ids.length)throw new Error("empty-solution-history");
    for(const id of ids)bounded(id,"solution-id");
    const selected=new Set(ids);return this.rollup(e=>e.solutionId!==undefined&&selected.has(e.solutionId));
  }
  summary() { return this.rollup(()=>true); }
  private rollup(filter:(record:{runId?:string;solutionId?:string})=>boolean) {
    const externalRecords=this.store.list<ExternalCostRecord>("external-costs"),effective=effectiveExternal(externalRecords);
    const linked=new Map(effective.filter(e=>e.record.attemptId).map(e=>[e.record.attemptId!,e]));
    const modelEvents=this.store.list<CostEvent>("costs").filter(filter).map(e=>{
      const actual=linked.get(e.id);return actual?{...e,basis:"reported" as const,amountMicros:actual.amountMicros,externalRecordId:actual.record.id,reportedCreditsMicros:actual.creditsMicros}:{...e,reportedCreditsMicros:0};
    });
    const externalEvents:ExternalCostEvent[]=effective.filter(e=>!e.record.attemptId&&filter(e.record)).map(e=>({id:e.record.id,at:e.root.occurredAtMs,endedAt:e.record.recordedAtMs,currency:e.record.currency,basis:e.record.basis,amountMicros:e.amountMicros,scope:e.record.scope,source:e.record.source,reference:e.record.reference,status:"recorded",...(e.record.runId?{runId:e.record.runId}:{}),...(e.record.solutionId?{solutionId:e.record.solutionId}:{}),reportedCreditsMicros:e.creditsMicros,externalRecordId:e.record.id}));
    const events=[...modelEvents,...externalEvents].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
    const pending=this.store.list<CostEvent>("cost-reservations").filter(e=>e.status==="reserved"&&filter(e));
    const currencies = [...new Set([...events,...pending].map(e => e.currency))].sort();
    return {
      totals: currencies.map(currency => {
        const es = events.filter(e => e.currency === currency);
        return { currency, reportedMicros: sum(es.filter(e=>e.basis==="reported").map(e=>e.amountMicros??0)), estimatedMicros: sum(es.filter(e=>e.basis==="estimated").map(e=>e.amountMicros??0)),
          reportedCreditsMicros:sum(es.map(e=>e.reportedCreditsMicros)),unknownAttempts:modelEvents.filter(e=>e.currency===currency&&e.amountMicros===null).length,unknownExternalCosts:externalEvents.filter(e=>e.currency===currency&&e.amountMicros===null).length,
          attempts:modelEvents.filter(e=>e.currency===currency).length,externalRecords:externalEvents.filter(e=>e.currency===currency).length,reservedMicros:sum(pending.filter(e=>e.currency===currency).map(e=>e.maxMicros)) };
      }),
      events,
      pending,
      externalRecords:externalRecords.filter(filter),
      metrics:{modelAttempts:modelEvents.length,externalCharges:externalEvents.length,pendingAttempts:pending.length,
        knownInputTokens:sum(modelEvents.map(e=>e.usage.inputTokens??0)),knownOutputTokens:sum(modelEvents.map(e=>e.usage.outputTokens??0)),knownCacheReadTokens:sum(modelEvents.map(e=>e.usage.cacheReadTokens??0)),knownCacheWriteTokens:sum(modelEvents.map(e=>e.usage.cacheWriteTokens??0)),
        usageIncompleteAttempts:modelEvents.filter(e=>e.complete!==true||Object.values(e.usage).some(v=>v===null)).length,knownDurationMs:sum(modelEvents.map(e=>e.durationMs??0)),durationUnknownAttempts:modelEvents.filter(e=>e.durationMs===undefined).length},
      note: "Reported amounts are owner-recorded invoice attestations, net of recorded credits. Linked invoices replace token estimates. Unknown and pending costs are not free; currencies are never combined using an invented exchange rate.",
    };
  }
}
