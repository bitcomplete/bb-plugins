import type { Actor } from "./store.js";
import type { Revalidation } from "./revalidation.js";
import { editRevalidationDraftSchema, type EditRevalidationDraft } from "./revalidation-edit-contract.js";

/** Owner and chat draft editing. Freezing, queueing, cancelling and results are deliberately absent. */
export function createRevalidationDraftEditor(plans: Revalidation["plans"]) {
  return (raw: EditRevalidationDraft, actor: Actor) => {
    const input = editRevalidationDraftSchema.parse(raw);
    return input.action === "create"
      ? plans.create({ requestId: input.requestId, definition: input.definition }, actor)
      : plans.revise({ planId: input.planId, expectedVersion: input.expectedVersion, definition: input.definition }, actor);
  };
}
