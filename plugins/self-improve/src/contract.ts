import { executionSelectionSchema, type ExecutionSettingsView } from "./native-execution.js";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AppliedImprovement } from "./improvements.js";
import type { DashboardData } from "./ui/types.js";
import { freezeRevalidationSchema, queueRevalidationSchema, cancelRevalidationSchema } from "./revalidation-contract.js";
import { editRevalidationDraftSchema } from "./revalidation-edit-contract.js";
import type { RevalidationOwnerApi } from "./revalidation-owner.js";
const id = z.string().min(1).max(200);
export const rpcContract = defineRpcContract({
  revalidationOverview: { input: z.object({solutionId:id.optional()}).strict(), output:z.custom<ReturnType<RevalidationOwnerApi["overview"]>>() },
  revalidationPlan: { input:z.object({planId:id}).strict(), output:z.custom<ReturnType<RevalidationOwnerApi["detail"]>>() },
  editRevalidationDraft: { input:editRevalidationDraftSchema, output:z.custom<ReturnType<RevalidationOwnerApi["edit"]>>() },
  freezeRevalidation: { input:freezeRevalidationSchema, output:z.custom<ReturnType<RevalidationOwnerApi["freeze"]>>() },
  queueRevalidation: { input:queueRevalidationSchema, output:z.custom<ReturnType<RevalidationOwnerApi["queue"]>>() },
  cancelRevalidation: { input:cancelRevalidationSchema, output:z.custom<ReturnType<RevalidationOwnerApi["cancel"]>>() },
  startRevalidationChat: { input:z.object({planId:id,projectId:id}).strict(), output:z.object({threadId:id}) },
  getExecution: { input: z.object({}).strict(), output: z.custom<ExecutionSettingsView>() },
  workerOptions: { input: z.object({}).strict(), output: z.custom<{ projects: Array<{ id: string; name: string }>; environments: Array<{ id: string; projectId: string; label: string }> }>() },
  findProblems: { input: z.object({}).strict(), output: z.object({ jobId: z.string() }) },
  problemReport: { input: z.object({ problemId: id }).strict(), output: z.custom<{ title: string; body: string; issueUrl: string | null }>() },
  applyImprovement: { input: z.object({ solutionId: id }).strict(), output: z.custom<AppliedImprovement>() },
  setImprovementEnabled: { input: z.object({ solutionId: id, enabled: z.boolean() }).strict(), output: z.custom<AppliedImprovement>() },
  setAutoApply: { input: z.object({ autoApply: z.boolean() }).strict(), output: z.object({ autoApply: z.boolean() }) },
  setExecution: { input: z.object({expectedRevision:z.string().min(1).max(200),selection:executionSelectionSchema}).strict(), output: z.custom<ExecutionSettingsView>() },
  dashboard: { input: z.object({}).strict(), output: z.custom<DashboardData>() },
  startChat: { input: z.object({ kind: z.enum(["problem", "solution"]), id, projectId: id }).strict(), output: z.object({ threadId: id }) },
  createObjective: { input: z.object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), kind: z.enum(["problem", "goal"]), title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(4000), priority: z.enum(["normal", "focus"]), metric: z.object({ name: z.string().trim().min(1).max(100), unit: z.string().trim().min(1).max(100), target: z.number(), direction: z.enum(["lower", "higher"]) }).strict().optional() }).strict(), output: z.object({ id }) },
});
