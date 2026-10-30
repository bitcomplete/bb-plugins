import type { Comment, Metadata, Review, ReviewThread, Transport } from "./github.js";

export const at = (hour: number) => new Date(Date.UTC(2026, 9, 19, hour)).toISOString();
export const actor = (login: string) => ({ login, __typename: "User" });
export const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
export const metadata = (number = 1): Metadata => ({
  id: "PR_" + number, number, title: "Improve the editor " + number, url: "https://github.com/example/editor/pull/" + number,
  headRefOid: "a".repeat(40), headRefName: "fix-editor", updatedAt: at(12), isDraft: false,
  author: actor("me"), repository: { nameWithOwner: "example/editor" }, commits: { nodes: [{ commit: { committedDate: at(8) } }] },
});
export const review = (patch: Partial<Review> = {}): Review => ({ id: "R1", author: actor("reviewer"), state: "COMMENTED", body: "Please fix this", submittedAt: at(10), ...patch });
export const comment = (patch: Partial<Comment> = {}): Comment => ({ id: "C1", author: actor("reviewer"), body: "A question", createdAt: at(10), updatedAt: at(10), ...patch });
export const thread = (comments: Comment[], resolved = false): ReviewThread => ({ id: "T1", isResolved: resolved, comments: page(comments) });
export type Fixture = { pr: Metadata; reviews: Review[]; comments: Comment[]; threads: ReviewThread[] };
export const fixture = (number = 1): Fixture => ({ pr: metadata(number), reviews: [review()], comments: [], threads: [] });
export function transportFor(get: () => Fixture[]): Transport {
  return async (query, variables) => {
    if (query.includes("{ viewer {") && !variables.id) return { viewer: { login: "me" } };
    if (query.includes("search(")) { const prs = get(); return { search: { ...page(prs.map((f) => f.pr)), issueCount: prs.length } }; }
    const f = get().find((f) => f.pr.id === variables.id);
    if (!f) throw new Error("Unknown fixture node: " + variables.id);
    if (query.includes("viewer { login }") && variables.id) return { viewer: { login: "me" }, node: {
      ...f.pr, state: "OPEN", reviews: page(f.reviews), comments: page(f.comments),
      reviewThreads: page(f.threads), reviewRequests: page([]),
    } };
    if (query.includes("headRefOid")) return { node: { state: "OPEN", headRefOid: f.pr.headRefOid } };
    if (query.includes("reviewThreads(")) return { node: { reviewThreads: page(f.threads) } };
    if (query.includes("reviewRequests(")) return { node: { reviewRequests: page([]) } };
    if (query.includes("reviews(")) return { node: { reviews: page(f.reviews) } };
    if (query.includes("comments(")) return { node: { comments: page(f.comments) } };
    throw new Error("Unexpected query: " + query);
  };
}
