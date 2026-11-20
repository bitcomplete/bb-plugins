import type { RevalidationOwnerApi } from "./revalidation-owner.js";
import type { EditRevalidationDraft } from "./revalidation-edit-contract.js";
export interface RevalidationApi {
  revalidationOverview(input: { solutionId?: string }): Promise<ReturnType<RevalidationOwnerApi["overview"]>>;
  revalidationPlan(input: { planId: string }): Promise<ReturnType<RevalidationOwnerApi["detail"]>>;
  editRevalidationDraft(input: EditRevalidationDraft): Promise<ReturnType<RevalidationOwnerApi["edit"]>>;
  freezeRevalidation(input: { planId: string; expectedVersion: number }): Promise<ReturnType<RevalidationOwnerApi["freeze"]>>;
  queueRevalidation(input: { planId: string; version: number; requestId: string }): Promise<ReturnType<RevalidationOwnerApi["queue"]>>;
  cancelRevalidation(input: { runId: string; reason: string }): Promise<ReturnType<RevalidationOwnerApi["cancel"]>>;
  startRevalidationChat(input: { planId: string; projectId: string }): Promise<{ threadId: string }>;
}
