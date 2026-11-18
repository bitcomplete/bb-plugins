import type { Store } from "./store.js";
import type { ExportDraft } from "./publication.js";
import type { PublicationObservation, PublicationTracker } from "./publication-state.js";
import { resolveSolutionHistory } from "./solution-history.js";

export interface PublicationSummary {
  id: string; solutionId: string; revision: string; draftId: string; repository: string; directory: string;
  submission: "preparing" | "submitted-for-review"; url: string | null;
  latest: PublicationObservation | null;
}
export interface PublicationApi {
  publications(input: { solutionId?: string }): Promise<{ publications: PublicationSummary[] }>;
  publicationHistory(input: { publicationId: string }): Promise<{ observations: PublicationObservation[] }>;
  reconcilePublication(input: { publicationId: string; releaseTag?: string }): Promise<PublicationObservation>;
}

/** Local ledger reads only. Remote state is checked solely by explicit reconcile requests. */
export function publicationView(store: Store, tracker: Pick<PublicationTracker, "latest">, solutionId?: string): { publications: PublicationSummary[] } {
  const family = solutionId === undefined ? null : new Set(resolveSolutionHistory(store, solutionId).solutionIds);
  return { publications: store.list<{id:string;draftId:string;repository:string;directory:string;url?:string;status:string}>("publications").flatMap(saved => {
    const draft = store.get<ExportDraft>("export-drafts", saved.draftId);
    if (!draft || family !== null && !family.has(draft.solutionId)) return [];
    return [{ id: saved.id, solutionId: draft.solutionId, revision: draft.revision, draftId: draft.id,
      repository: saved.repository, directory: saved.directory, submission: saved.url ? "submitted-for-review" as const : "preparing" as const,
      url: saved.url ?? null, latest: tracker.latest(saved.id) }];
  }) };
}
