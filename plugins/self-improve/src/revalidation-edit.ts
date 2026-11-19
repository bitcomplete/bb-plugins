import type { Actor, Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
import type { createRevalidation } from "./revalidation.js";
import type { createRevalidationWorkloads } from "./revalidation-workload.js";
import { revalidationIdSchema, type RevalidationWorkloadRef } from "./revalidation-contract.js";
import { editRevalidationDraftSchema, type EditRevalidationDraft } from "./revalidation-edit-contract.js";

/** Atomic owner/chat draft editing. Outcome-writing and execution capabilities are deliberately absent. */
export function createRevalidationDraftEditor(store: Store, plans: ReturnType<typeof createRevalidation>["plans"], workloads: ReturnType<typeof createRevalidationWorkloads>) {
  return (raw: EditRevalidationDraft, actor: Actor) => {
    if (!["owner", "chat"].includes(actor.kind)) throw new Error("revalidation-editor-required");
    revalidationIdSchema.parse(actor.id);
    const input = editRevalidationDraftSchema.parse(raw);
    const receiptKey = stableId("revalidation-edit", [actor.kind, actor.id, input.requestId]);
    const fingerprint = stableId("revalidation-edit-input", input);
    return store.transaction(() => {
      const previous = store.get<{fingerprint:string;planId:string;version:number;workload:RevalidationWorkloadRef|null}>("revalidation-edit-requests", receiptKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("revalidation-edit-request-conflict");
        return {plan: plans.get(previous.planId, previous.version).plan, workload: previous.workload ? workloads.get(previous.workload.id, previous.workload.version) : null};
      }
      const prior = input.action === "revise" ? plans.get(input.planId).plan : null;
      if (prior && prior.version !== (input.action === "revise" ? input.expectedVersion : 0)) throw new Error("revalidation-version-conflict");
      // Keep the complete edit atomic: rejection of a plan must not leave orphan workload revisions.
      const oldReference = prior?.definition.workload;
      const oldWorkload = oldReference && "id" in oldReference ? workloads.get(oldReference.id, oldReference.version) : null;
      const workload = input.workload === null ? null : oldWorkload && stableJson(oldWorkload.definition) === stableJson(input.workload) ? oldWorkload
        : oldWorkload ? workloads.revise({id:oldWorkload.id, expectedVersion:oldWorkload.version, definition:input.workload}, actor)
        : workloads.create({requestId:receiptKey, definition:input.workload}, actor);
      const reference = workload ? {id:workload.id,version:workload.version,manifestDigest:workload.manifestDigest,description:workload.definition.description} : null;
      const definition = {...input.definition, workload:reference};
      const plan = input.action === "create" ? plans.create({requestId:receiptKey,definition},actor)
        : plans.revise({planId:input.planId,expectedVersion:input.expectedVersion,definition},actor);
      store.put("revalidation-edit-requests",receiptKey,{fingerprint,planId:plan.id,version:plan.version,workload:reference});
      return {plan,workload};
    });
  };
}
