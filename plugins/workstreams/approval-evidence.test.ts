import { describe, expect, it } from "vitest";
import { evidenceText, handled, linkedText, NO_EVIDENCE, type ApprovalEvidence } from "./approval-evidence.js";
import { readApprovalHandling, type GhRunner } from "./ghactions.js";

const target = { host: "github.com", owner: "inkwell", name: "folio", number: 301, slug: "inkwell/folio" };
const APPROVED_AT = "a".repeat(40), LATER = "b".repeat(40), EARLIER = "c".repeat(40);
const approval = { id: "review-301", state: "APPROVED", body: "Ship it, but the spine label should wrap at 40 characters.", submittedAt: "2026-09-28T12:00:00Z",
  author: { login: "mira" }, commit: { oid: APPROVED_AT } };
/**
 * `older`: GitHub has PR comments before the last 100 it returned. `author`: the PR's author, null for a deleted account. `timeline`: the
 * issues and PRs that cross-reference this one.
 */
type Facts = { head?: string; reviews?: unknown[]; threads?: unknown[]; comments?: unknown[]; older?: boolean; author?: string | null; commits?: string[];
  timeline?: unknown[] };
/** A commit written before mira's approval and rebased after it, and Update branch's merge of the base after it. */
const REBASED = "e".repeat(40), MERGE = "f".repeat(40);
/** When each commit was written: three before mira's approval on the 28th, two after it. */
const AUTHORED: Record<string, string> = { [EARLIER]: "2026-09-20T00:00:00Z", [APPROVED_AT]: "2026-09-27T00:00:00Z", [REBASED]: "2026-09-27T06:00:00Z",
  [LATER]: "2026-09-29T00:00:00Z", [MERGE]: "2026-09-29T00:00:00Z" };

/** GitHub as the confirm reads it: the review-threads read with PR comments, then the commits read, both on `head`. */
function github(facts: Facts = {}): GhRunner {
  const head = facts.head ?? APPROVED_AT;
  return async (args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("commits(last:100)")) return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head,
      commits: { pageInfo: { hasPreviousPage: false }, nodes: (facts.commits ?? [EARLIER, APPROVED_AT]).map((oid) => ({ commit: { oid,
        authoredDate: AUTHORED[oid], parents: { totalCount: oid === MERGE ? 2 : 1 } } })) } } } } }) };
    return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, baseRefName: "main",
      author: facts.author === null ? null : { login: facts.author ?? "dana" }, timelineItems: { nodes: facts.timeline ?? [] },
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: facts.reviews ?? [approval] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: facts.threads ?? [] },
      comments: { pageInfo: { hasPreviousPage: facts.older ?? false }, nodes: facts.comments ?? [] },
      commits: { nodes: [{ commit: { oid: head, committedDate: "2026-09-21T00:00:00Z" } }] } } } } }) };
  };
}
const read = async (facts?: Facts) => {
  const result = await readApprovalHandling(github(facts), target);
  if (!result.ok) throw new Error(result.error);
  return result;
};
const thread = (resolved: boolean, replies: unknown[] = []) => ({ id: "thread-301", isResolved: resolved, comments: { pageInfo: { hasNextPage: false }, nodes: [
  { id: "comment-1", body: "Wrap here too.", createdAt: approval.submittedAt, updatedAt: approval.submittedAt, author: { login: "mira" }, pullRequestReview: { id: approval.id } },
  ...replies] } });

describe("approval handling evidence", () => {
  // The live case that read as ready: an approval whose note is only in its review body, no inline thread, and nothing after it.
  it("finds no evidence for a note in the approval's body with no thread, no reply, and no commit after it", async () => {
    const result = await read({ comments: [{ body: "Opened.", createdAt: "2026-09-27T09:00:00Z", author: { login: "dana" } },
      { body: "Looks good", createdAt: "2026-09-29T09:00:00Z", author: { login: "mira" } }] });
    expect(result.sources).toEqual([{ id: "review-301", kind: "review", author: "mira", at: approval.submittedAt, body: approval.body, truncated: false, resolved: null }]);
    expect(result.evidence).toEqual({ since: approval.submittedAt, commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true });
    expect(handled(result.evidence)).toBe(false);
    expect(evidenceText(result.evidence)).toBe(NO_EVIDENCE);
  });

  it("counts commits pushed after the approval's head, and a head that left history as new commits", async () => {
    const pushed = await read({ head: LATER, commits: [EARLIER, APPROVED_AT, LATER] });
    expect([pushed.evidence.commits, handled(pushed.evidence), evidenceText(pushed.evidence)]).toEqual([1, true, "1 commit since this approval"]);
    const rewritten = await read({ head: LATER, commits: [EARLIER, LATER] });
    expect(rewritten.evidence.commits).toBe(1);
    // One before the approval's head in history came first, whatever its date says.
    expect((await read({ commits: [LATER, APPROVED_AT] })).evidence.commits).toBe(0);
  });

  // Update branch merges the base in, and a rebase or force push commits old work again: neither answers a note.
  it("never counts Update branch's merge commit, or a commit rebased after the approval but written before it", async () => {
    const merged = await read({ head: MERGE, commits: [EARLIER, APPROVED_AT, MERGE] });
    expect([merged.evidence.commits, handled(merged.evidence)]).toEqual([0, false]);
    const rebased = await read({ head: REBASED, commits: [EARLIER, REBASED] });
    expect([rebased.evidence.commits, handled(rebased.evidence)]).toEqual([0, false]);
  });

  // An approval left on an older head, after a newer commit was already pushed, has nothing after it to show: that commit came first.
  it("never counts a commit made before the approval, even one after the head the approval named", async () => {
    const stale = await read({ reviews: [{ ...approval, commit: { oid: EARLIER } }], commits: [EARLIER, APPROVED_AT] });
    expect([stale.evidence.commits, handled(stale.evidence)]).toEqual([0, false]);
    const gone = await read({ reviews: [{ ...approval, commit: { oid: "d".repeat(40) } }], commits: [EARLIER, APPROVED_AT] });
    expect([gone.evidence.commits, handled(gone.evidence)]).toEqual([0, false]);
  });

  it("counts the author's PR comment or review reply after the approval, and nobody else's", async () => {
    const commented = await read({ comments: [{ body: "Wrapped it.", createdAt: "2026-09-29T09:00:00Z", author: { login: "dana" } }] });
    expect([commented.evidence.replies, handled(commented.evidence)]).toEqual([1, true]);
    const reviewed = await read({ reviews: [approval, { id: "review-302", state: "COMMENTED", body: "Done in the label component.", submittedAt: "2026-09-29T10:00:00Z",
      author: { login: "dana" }, commit: { oid: APPROVED_AT } }] });
    expect([reviewed.evidence.replies, evidenceText(reviewed.evidence)]).toEqual([1, "1 reply since this approval"]);
    const others = await read({ comments: [{ body: "+1", createdAt: "2026-09-29T09:00:00Z", author: { login: "otto" } }] });
    expect(handled(others.evidence)).toBe(false);
  });

  it("counts the approval's inline threads resolved, and a reply in one, but not a thread left open", async () => {
    const resolved = await read({ threads: [thread(true)] });
    expect(resolved.sources.map((source) => [source.kind, source.id, source.resolved])).toEqual([["review", "review-301", null], ["thread", "thread-301", true]]);
    expect([resolved.evidence.threads, handled(resolved.evidence), evidenceText(resolved.evidence)])
      .toEqual([{ total: 1, resolved: 1 }, true, "1 of 1 thread resolved since this approval"]);
    const open = await read({ threads: [thread(false)] });
    expect(handled(open.evidence)).toBe(false);
    const answered = await read({ threads: [thread(false, [{ id: "comment-2", body: "Wrapped.", createdAt: "2026-09-29T09:00:00Z",
      updatedAt: "2026-09-29T09:00:00Z", author: { login: "dana" }, pullRequestReview: null }])] });
    expect([answered.evidence.replies, handled(answered.evidence)]).toEqual([1, true]);
  });

  // A resolution has no date: an older approval's thread, resolved before the newest note or after, shows nothing about that note.
  it("counts only the threads the newest note opened, and says how many are resolved when only some are", async () => {
    const earlier = { id: "review-300", state: "APPROVED", body: "", submittedAt: "2026-09-27T12:00:00Z", author: { login: "kai" }, commit: { oid: APPROVED_AT } };
    const older = { ...thread(true), id: "thread-300", comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "comment-0", body: "Rename the spine helper.",
      createdAt: earlier.submittedAt, updatedAt: earlier.submittedAt, author: { login: "kai" }, pullRequestReview: { id: earlier.id } }] } };
    const bodyOnly = await read({ reviews: [earlier, approval], threads: [older] });
    expect(bodyOnly.sources.map((source) => [source.id, source.resolved])).toEqual([["thread-300", true], ["review-301", null]]);
    expect([bodyOnly.evidence.threads, handled(bodyOnly.evidence), evidenceText(bodyOnly.evidence)]).toEqual([{ total: 0, resolved: 0 }, false, NO_EVIDENCE]);
    const some = await read({ threads: [thread(true), { ...thread(false), id: "thread-302" }] });
    expect([some.evidence.threads, handled(some.evidence), evidenceText(some.evidence)])
      .toEqual([{ total: 2, resolved: 1 }, false, "1 of 2 threads resolved; no commits or replies since this approval"]);
  });

  /**
   * The live case that dropped off Your turn: a conditional approval, then, hours later, the rest of its stack, whose bodies mention this
   * PR. The confirm names them, since one may be the separate PR the condition asked for, but none is a reply: with nothing else since,
   * the confirm still finds no evidence.
   */
  it("lists the PRs and issues the author linked this one from since the approval, and never counts them as handling", async () => {
    const conditional = { ...approval, body: "Approving, on the understanding that spine wrapping comes in a separate PR." };
    const mention = (at: string, source: Record<string, unknown>, actor = "dana", isCrossRepository = false) => ({ createdAt: at, isCrossRepository,
      actor: { __typename: "User", login: actor }, source });
    const pr = (repo: string, number: number, baseRefName = "main") => ({ __typename: "PullRequest", number, baseRefName, repository: { nameWithOwner: repo } });
    const stack = await read({ reviews: [conditional], timeline: [
      // An issue linked before the approval says nothing about it.
      mention("2026-09-28T09:00:00Z", { __typename: "Issue", number: 40, repository: { nameWithOwner: "inkwell/folio" } }),
      mention("2026-09-28T18:00:00Z", pr("inkwell/folio", 302)),
      mention("2026-09-28T19:00:00Z", pr("inkwell/catalog", 97), "dana", true),
      // Edited again, the same PR mentions it twice; a teammate's PR, and a PR stacked on this one's branch, aren't follow-ups.
      mention("2026-09-28T20:00:00Z", pr("inkwell/folio", 302)),
      mention("2026-09-28T21:00:00Z", pr("inkwell/folio", 303), "otto"),
      mention("2026-09-28T22:00:00Z", pr("inkwell/folio", 304, "dana/spine-wrap")),
    ] });
    expect(stack.evidence).toEqual({ since: approval.submittedAt, commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true,
      linked: [{ repo: "inkwell/folio", number: 302 }, { repo: "inkwell/catalog", number: 97 }] });
    expect([handled(stack.evidence), evidenceText(stack.evidence), linkedText(stack.evidence)])
      .toEqual([false, NO_EVIDENCE, "Linked: folio #302, catalog #97 mention this PR"]);
    // With none since the approval, it names none.
    expect(linkedText((await read({ reviews: [conditional] })).evidence)).toBeNull();
  });

  it("calls the read cut short when GitHub's last 100 PR comments all follow the note, or the PR's author is unknown", async () => {
    const later = [{ body: "Wrapped it.", createdAt: "2026-09-29T09:00:00Z", author: { login: "otto" } }];
    expect((await read({ comments: later, older: true })).evidence.complete).toBe(false);
    // One comment older than the note means none newer was left out.
    expect((await read({ comments: [{ body: "Opened.", createdAt: "2026-09-27T09:00:00Z", author: { login: "otto" } }, ...later], older: true })).evidence.complete)
      .toBe(true);
    const ghost = await read({ author: null, comments: [{ body: "Wrapped it.", createdAt: "2026-09-29T09:00:00Z", author: null }] });
    expect([ghost.evidence.replies, ghost.evidence.complete, handled(ghost.evidence)]).toEqual([0, false, false]);
  });

  it("never calls a cut-short read evidence, and refuses one whose head moved between its reads", async () => {
    const cut: ApprovalEvidence = { since: approval.submittedAt, commits: 2, replies: 0, threads: { total: 0, resolved: 0 }, complete: false };
    expect([handled(cut), evidenceText(cut)]).toEqual([false, "GitHub's answer was cut short, so there's no evidence to show"]);
    const moved: GhRunner = async (args) => {
      const result = await github()(args);
      return (args.find((arg) => arg.startsWith("query=")) ?? "").includes("commits(last:100)")
        ? { ok: true, stdout: result.ok ? result.stdout.replace(APPROVED_AT, LATER) : "" } : result;
    };
    expect(await readApprovalHandling(moved, target)).toEqual({ ok: false, error: "The PR's head changed while it was read. Try again." });
  });
});
