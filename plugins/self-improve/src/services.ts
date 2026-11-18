import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Stage } from "./domain/types.js";
import { Store, type Job } from "./store.js";
import { randomUUID } from "node:crypto";
import { NativeTaskError } from "./native-tasks.js";
import { AdapterError } from "./adapters/transport.js";

const nativeDiagnostics = new Set([
  "native-task-timeout", "native-task-aborted", "native-task-admission-denied", "native-task-spawn-uncertain",
  "native-task-execution-changed", "native-task-environment-changed", "native-task-privacy-changed",
  "native-task-extra-turn", "native-task-output-unmatched", "native-task-cleanup-pending",
]);
const adapterDiagnostics = new Set([
  "pool-exhausted", "provider-rejected", "interrupted", "invalid-model-json", "model-output-truncated",
  "model-mismatch", "unsupported-billing-feature", "invalid-request", "request-too-large", "invalid-account",
  "invalid-url", "unsafe-ledger-text", "ledger-reference-disallowed",
]);
const fixedDiagnostics = new Map([
  ["injected-service-fault", "injected-service-fault"],
  ["unpriced-model: configure prices or explicitly allow unknown costs", "unpriced-model"],
  ["daily-call-budget-exhausted", "daily-call-budget-exhausted"],
  ["unknown-external-cost: report or explicitly allow unknown costs", "unknown-external-cost"],
  ["budget-currency-mismatch: reconcile external charges in the configured budget currency without invented exchange rates", "budget-currency-mismatch"],
  ["daily-cost-budget-exhausted", "daily-cost-budget-exhausted"],
  ["monthly-cost-budget-exhausted", "monthly-cost-budget-exhausted"],
  ["scope-cost-budget-exhausted", "scope-cost-budget-exhausted"],
]);
/** Never persist exception messages from providers or AggregateError's concatenated message. */
function stageDiagnostic(error: unknown): string {
  const codes = new Set<string>(), queue: unknown[] = [error];
  for (let inspected = 0; queue.length && inspected < 16; inspected++) {
    const current = queue.shift();
    if (current instanceof NativeTaskError && nativeDiagnostics.has(current.code)) codes.add(current.code);
    else if (current instanceof AdapterError && adapterDiagnostics.has(current.code)) codes.add(current.code);
    else if (current instanceof AggregateError) queue.push(...current.errors.slice(0, 16 - inspected));
    else if (current instanceof Error) { const fixed = fixedDiagnostics.get(current.message); if (fixed) codes.add(fixed); }
    if (codes.size === 3) break;
  }
  return [...codes].join(",") || "stage-failed";
}
export const STAGES: Stage[] = ["miner", "problem-ranker", "scout", "inventor", "solution-ranker", "builder", "verifier"];
export const SCHEDULES: Record<Stage, string> = { miner: "*/15 * * * *", "problem-ranker": "0 2 * * *", scout: "15 2 * * *", inventor: "15 2 * * *", "solution-ranker": "0 3 * * *", builder: "15 3 * * *", verifier: "0 4 * * *" };
export interface StageContext { job: Job; signal: AbortSignal; boot: string }
export type StageHandler = (context: StageContext) => Promise<Record<string, number>>;
export class Deferred extends Error { constructor(readonly code: string) { super(code); } }
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
  });
}
export function dayKey(now = Date.now()) { return new Date(now).toISOString().slice(0,10); }
export class Services {
  readonly boot = randomUUID();
  private recovered = false;
  private faults = new Set<Stage>();
  constructor(readonly bb: BbPluginApi, readonly store: Store, readonly handlers: Record<Stage, StageHandler>, readonly enabled: () => Promise<boolean>, readonly changed: () => void) {}
  enqueue(stage: Stage, key?: string, input: Record<string, unknown> = {}): string {
    const now = Date.now();
    const runKey = key ?? (stage === "miner" ? `interval:${Math.floor(now/900000)}` : `day:${dayKey(now)}`);
    const id = this.store.enqueue(stage, runKey, input, now); this.changed(); return id;
  }
  injectFault(stage: Stage): void {
    const dir = this.bb.server.experimental_dataDir;
    if (!dir.includes("scratch") || new URL(this.bb.server.loopbackBaseUrl).port === "38886") throw new Error("fault-injection-requires-scratch");
    this.faults.add(stage);
  }
  register(): void {
    for (const stage of STAGES) {
      this.bb.background.schedule(stage, SCHEDULES[stage], async () => { if (await this.enabled()) this.enqueue(stage); });
      this.bb.background.service(stage, { start: async signal => {
        if (!this.recovered) { this.store.recover(this.boot); this.recovered = true; }
        while (!signal.aborted) {
          const job = this.store.claim(stage, this.boot);
          if (!job) { await wait(1000, signal); continue; }
          try {
            if (this.faults.delete(stage)) throw new Error("injected-service-fault");
            const counts = await this.handlers[stage]({ job, signal, boot: this.boot });
            if (signal.aborted) throw new Deferred("service-stopped");
            this.store.complete(job.id, this.boot, counts);
          } catch (error) {
            const deferred = error instanceof Deferred;
            // Raw provider messages can contain request bodies. Persist only a fixed code.
            const code = deferred ? error.code : stageDiagnostic(error);
            const retry = deferred || job.attempts < 3;
            this.store.fail(job.id, this.boot, code, Date.now(), retry ? Date.now() + Math.min(300000, 1000 * 2 ** job.attempts) : undefined);
            this.changed();
            if (!deferred) throw new Error(`${stage}: ${code}`); // BB restarts the service with backoff.
          }
          this.changed();
        }
      } });
    }
    this.bb.background.schedule("daily-reconciliation", "0 1 * * *", async () => { if (await this.enabled()) this.enqueue("miner", `reconcile:${dayKey()}`, { reconcile: true }); });
  }
}
