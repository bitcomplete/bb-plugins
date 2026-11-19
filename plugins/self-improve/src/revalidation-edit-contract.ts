import { z } from "zod";
import { revalidationDefinitionSchema, revalidationIdSchema, revalidationCountSchema, revalidationWorkloadDefinitionSchema } from "./revalidation-contract.js";

const fields = {
  requestId: revalidationIdSchema,
  definition: revalidationDefinitionSchema.refine(value => value.workload === null, "Workload identity is assigned from the supplied test definition"),
  workload: revalidationWorkloadDefinitionSchema.nullable(),
};
/** On revise, omitting workload keeps the current tests; null detaches them explicitly. */
const reviseFields = { ...fields, workload: fields.workload.optional() };
/** A draft edit supplies planned inputs only. No execution results or client-owned manifest identity. */
export const editRevalidationDraftSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), ...fields }).strict(),
  z.object({ action: z.literal("revise"), planId: revalidationIdSchema, expectedVersion: revalidationCountSchema.positive(), ...reviseFields }).strict(),
]);
export type EditRevalidationDraft = z.infer<typeof editRevalidationDraftSchema>;
