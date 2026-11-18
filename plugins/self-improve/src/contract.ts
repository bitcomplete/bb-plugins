import { executionSelectionSchema, type ExecutionSettingsView } from "./native-execution.js";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { DashboardData, PerformancePoint, ExportArtifact } from "./ui/types.js";
const id = z.string().min(1).max(200);
export const rpcContract = defineRpcContract({
  getExecution: { input: z.object({}).strict(), output: z.custom<ExecutionSettingsView>() },
  setExecution: { input: z.object({expectedRevision:z.string().min(1).max(200),selection:executionSelectionSchema}).strict(), output: z.custom<ExecutionSettingsView>() },
  dashboard: { input: z.object({}).strict(), output: z.custom<DashboardData>() },
  retest: { input: z.object({ solutionId: id, expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict(), output: z.object({ jobId: id }) },
  startChat: { input: z.object({ kind: z.enum(["problem", "solution"]), id, projectId: id }).strict(), output: z.object({ threadId: id }) },
  createObjective: { input: z.object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), kind: z.enum(["problem", "goal"]), title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(4000), priority: z.enum(["normal", "focus"]), metric: z.object({ name: z.string().trim().min(1).max(100), unit: z.string().trim().min(1).max(100), target: z.number(), direction: z.enum(["lower", "higher"]) }).strict().optional() }).strict(), output: z.object({ id }) },
  performance: { input: z.object({ solutionId: id.optional() }).strict(), output: z.object({ points: z.custom<PerformancePoint[]>() }) },
  exportSolution: { input: z.object({ solutionId: id, format: z.enum(["skill", "plugin"]), expectedVersion: z.number().int().positive() }).strict(), output: z.custom<ExportArtifact>() },
  publishExport: {input:z.object({artifactId:id,repository:z.string().min(3).max(201),directory:z.string().min(1).max(200),bundleSha256:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.literal(true)}).strict(),output:z.object({url:z.string().url(),status:z.literal("submitted-for-review")})},
});
