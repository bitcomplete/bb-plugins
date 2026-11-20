import { z } from "zod";
import { revalidationDefinitionSchema, revalidationIdSchema, revalidationCountSchema } from "./revalidation-contract.js";

/** A draft edit carries the planned cases and criteria only: no results, scores or verdicts. */
export const editRevalidationDraftSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), requestId: revalidationIdSchema, definition: revalidationDefinitionSchema }).strict(),
  z.object({ action: z.literal("revise"), planId: revalidationIdSchema, expectedVersion: revalidationCountSchema.positive(), definition: revalidationDefinitionSchema }).strict(),
]);
export type EditRevalidationDraft = z.infer<typeof editRevalidationDraftSchema>;
