import { z } from "zod";
import type { NativeExecution } from "./native-tasks.js";

// These are BB's shared selections, not provider-specific settings. The host
// pickers and spawn contract resolve which selections the chosen provider allows.
export const reasoningLevelSchema = z.string().trim().min(1).max(200);
export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export const executionSelectionSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  reasoningLevel: reasoningLevelSchema.optional(),
  serviceTier: z.string().trim().min(1).max(200).optional(),
  permissionMode: permissionModeSchema,
  projectId: z.string().trim().min(1).max(200),
  environmentId: z.string().trim().min(1).max(200),
}).strict();
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;

/** Forward the owner's coherent BB selection without choosing a vendor or credentials. */
export function nativeExecution(selection: ExecutionSelection): NativeExecution {
  const value = executionSelectionSchema.parse(selection);
  return {
    projectId: value.projectId,
    environment: { type: "reuse", environmentId: value.environmentId },
    providerId: value.providerId,
    model: value.model,
    permissionMode: value.permissionMode,
    ...(value.reasoningLevel === undefined ? {} : { reasoningLevel: value.reasoningLevel }),
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
  };
}

/** Public execution preferences only; never provider credentials. */
export interface ExecutionSettingsView {
  revision: string; projectId: string; environmentId: string;
  selection: { providerId: string; model: string; reasoningLevel: z.infer<typeof reasoningLevelSchema>; serviceTier?: string };
  permissionMode: z.infer<typeof permissionModeSchema>;
}
