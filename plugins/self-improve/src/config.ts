import { z } from "zod";
import { DEFAULT_RANKING_CONFIG } from "./domain/votes.js";
import type { CostPolicy } from "./costs.js";
import { permissionModeSchema, reasoningLevelSchema } from "./native-execution.js";

const price = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), version: z.string().min(1) }).strict();
export const rankingSchema = z.object({
  version: z.string().min(1).max(100), halfLifeDays: z.number().positive().max(3650), perSourceDayCap: z.number().positive(),
  weights: z.object({ owner_correction: z.number().nonnegative(), failed_task: z.number().nonnegative(), blocked_task: z.number().nonnegative(), failed_job: z.number().nonnegative(), task_looped: z.number().nonnegative(), tool_error: z.number().nonnegative(), tool_retry: z.number().nonnegative() }).strict(),
}).strict();
export const policySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  dailyMicros: z.number().int().nonnegative().nullable().default(null),
  monthlyMicros: z.number().int().nonnegative().nullable().default(null),
  /** Optional cap on agent calls per UTC day; null (the default) means no cap. Spending is always tracked. */
  maxDailyCalls: z.number().int().min(1).max(100000).nullable().default(null),
  /** Agent work whose cost BB reports only afterwards. Allowed by default; set false to require configured prices. */
  allowUnknown: z.boolean().default(true),
  prices: z.record(z.string(), price).default({}),
  scopeLimitsMicros: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict();
export const configSchema = z.object({
  concurrency: z.number().int().min(1).max(20).default(3),
  providerId: z.string().trim().max(200).default(""),
  model: z.string().default(""),
  reasoningLevel: reasoningLevelSchema.optional(),
  serviceTier: z.string().trim().min(1).max(200).optional(),
  permissionMode: permissionModeSchema.default("accept-edits"),
  taskTimeoutMs: z.number().int().min(1000).max(900000).default(120000),
  projectId: z.string().default(""),
  environmentId: z.string().default(""),
  scopeProjectIds: z.array(z.string().min(1)).default([]),
  /** Apply improvements that pass their test runs without waiting for the owner. Each can still be disabled. */
  autoApply: z.boolean().default(true),
  taskOutcomeSource: z.object({pluginId:z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/).refine(id=>id!=="self-improve","Task history must come from a separate producer"),method:z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/)}).strict().optional(),
  budgets: policySchema.default(() => policySchema.parse({})),
  ranking: rankingSchema.default(() => structuredClone(DEFAULT_RANKING_CONFIG)),
  redactedNames: z.array(z.string().min(1)).default([]),
  maxThreadsPerRun: z.number().int().min(1).max(10000).default(1000),
  maxEventsPerSession: z.number().int().min(10).max(500).default(500),
  laya: z.object({ enabled: z.boolean().default(false), endpoint: z.string().url().optional(), minConfidence: z.number().min(.8).max(1).default(.8) }).strict().default(() => ({ enabled: false, minConfidence: .8 })),
  dair: z.object({ endpoint: z.string().url().default("https://academy.dair.ai/api/mcp"), searchTool: z.string().max(128).optional(), queryArgument: z.string().max(128).optional(), resultsPath: z.array(z.string().max(100)).max(20).optional(), weeklyTool:z.string().max(128).optional(), weeklyArguments:z.record(z.string(),z.unknown()).optional(), weeklyResultsPath:z.array(z.string().max(100)).max(20).optional() }).strict().default(() => ({ endpoint: "https://academy.dair.ai/api/mcp" })),
}).strict();
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = () => configSchema.parse({});
/** Settings saved by earlier versions may still carry these keys; they no longer configure anything and are dropped. */
const RETIRED_KEYS = ["publicationRepositories", "experimentalParentLinks", "experimentalMatchAudit"] as const;
/** Validates a configuration value, naming the first failing field (for example `budgets.currency`). */
export function checkConfig(value: unknown): Config {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value as Record<string, unknown> };
    for (const key of RETIRED_KEYS) delete (value as Record<string, unknown>)[key];
  }
  const result = configSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new Error(`Invalid configuration${issue.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue.message}`);
}
export function parseConfig(raw: string): Config {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid configuration: not valid JSON"); }
  return checkConfig(value);
}
export function parseCostPolicy(raw: unknown): CostPolicy { return policySchema.parse(raw); }
export const defaultWeights = DEFAULT_RANKING_CONFIG;
