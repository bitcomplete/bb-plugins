import type { RevalidationOwnerApi } from "./revalidation-owner.js";
import type { EditRevalidationDraft } from "./revalidation-edit-contract.js";
import type { RevalidationRun } from "./revalidation-contract.js";
export interface RevalidationApi {
  revalidationOverview(input:{solutionId?:string}):Promise<ReturnType<RevalidationOwnerApi["overview"]>>;
  revalidationPlan(input:{planId:string}):Promise<ReturnType<RevalidationOwnerApi["detail"]>>;
  editRevalidationDraft(input:EditRevalidationDraft):Promise<ReturnType<RevalidationOwnerApi["edit"]>>;
  freezeRevalidation(input:{planId:string;expectedVersion:number}):ReturnType<RevalidationOwnerApi["freeze"]>;
  queueRevalidation(input:{planId:string;version:number;requestId:string}):Promise<ReturnType<RevalidationOwnerApi["queue"]>>;
  cancelRevalidation(input:{runId:string;expectedVersion:number;reason:string}):Promise<RevalidationRun>;
  startRevalidationChat(input:{planId:string;projectId:string}):Promise<{threadId:string}>;
}
