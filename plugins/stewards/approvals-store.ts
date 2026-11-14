// The durable half of a project steward's decision on an owner-reviewed pull
// request: the `project_approvals` table, its append-only migrations, and the
// accessors. The lane gate (gate.ts) reads a record to match the `bb-approval`
// marker the plugin posted to the GitHub comment it recorded, so a hand-typed
// lookalike never counts. Kept apart from the rest of the store so the gate's
// own files can be named as the code that must not widen itself (BB-153).
import type Database from "better-sqlite3";

// Append-only: bb.storage.migrate records each statement's hash and refuses a
// changed one, so a schema change is a new statement at the end. These
// statements keep their exact order and text from store.ts; the table is
// created in the middle of the escalation-chain group and the marker columns
// are added with the BB-77 group.
//
// A project steward's approval of an owner-reviewed pull request, bound to the
// head sha: a new push is a new sha and voids it. It lives only here, never as
// a GitHub comment or review.
export const APPROVALS_CHAIN_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS project_approvals (
     binding_id TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     entry TEXT,
     by_thread TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (binding_id, head_sha)
   )`,
];

// BB-77: the project-steward approval marker. The approval record gains the
// GitHub comment id of the `bb-approval` marker the plugin posted (the lane
// gate honours a marker only when its id is recorded, so a hand-typed lookalike
// never counts) and the verdict it carried (approved or declined). Additive and
// defaulted: a record made before this step reads as an approval with no marker
// id, which the gate ignores.
export const APPROVAL_MARKER_MIGRATIONS = [
  `ALTER TABLE project_approvals ADD COLUMN comment_id TEXT`,
  `ALTER TABLE project_approvals ADD COLUMN verdict TEXT NOT NULL DEFAULT 'approved'`,
];

// BB-327: every login seen in a pull request's requested-reviewers list, for
// the binding and URL. GitHub drops a reviewer from the live list once they
// submit a review, and the snapshot carries no request history, so the gate
// remembers the logins it has seen and counts a delegate's later APPROVED
// review against this set as well as the live list. A new table, so a store
// from before this step reads back exactly as before.
export const PULL_REQUESTER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pull_requesters (
     binding_id TEXT NOT NULL,
     url TEXT NOT NULL,
     login TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (binding_id, url, login)
   )`,
];

// BB-327: the (delegate, head) pairs the plugin has re-requested review from
// after a changes-requested review, so a repeated look does not re-request and
// the status can say the delegate was re-solicited for the current head. A new
// table, so a store from before this step reads back exactly as before.
export const REVIEWER_REQUEST_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS reviewer_requests (
     binding_id TEXT NOT NULL,
     url TEXT NOT NULL,
     login TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (binding_id, url, login, head_sha)
   )`,
];

/**
 * A project steward's approval (or decline) of an owner-reviewed pull request,
 * bound to its head sha. `commentId` is the GitHub comment id of the
 * `bb-approval` marker the plugin posted for it; the lane gate honours a marker
 * only when its comment id is recorded here, so a hand-typed lookalike never
 * counts.
 */
export type ProjectApproval = {
  bindingId: string;
  headSha: string;
  /** The decide-list entry the project steward classified it under. */
  entry: string | null;
  byThread: string;
  /** The GitHub comment id of the marker the plugin posted, or null for a record made before markers. */
  commentId: string | null;
  /** The marker's verdict. */
  verdict: "approved" | "declined";
  createdAt: number;
};

/**
 * The `project_approvals` accessors, prepared against one database and clock.
 * `createStore` spreads the result into its own surface, so callers keep using
 * `store.projectApproval`, `store.recordProjectApproval` and the rest.
 */
export function createApprovalsStore(db: Database.Database, now: () => number) {
  const insertProjectApproval = db.prepare(
    "INSERT INTO project_approvals (binding_id, head_sha, entry, by_thread, comment_id, verdict, created_at) VALUES (@binding_id, @head_sha, @entry, @by_thread, @comment_id, @verdict, @created_at) ON CONFLICT (binding_id, head_sha) DO UPDATE SET entry = @entry, by_thread = @by_thread, comment_id = @comment_id, verdict = @verdict, created_at = @created_at",
  );
  const getProjectApproval = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM project_approvals WHERE binding_id = ? AND head_sha = ?");
  const projectApprovalsFor = db.prepare<[string], Record<string, unknown>>("SELECT * FROM project_approvals WHERE binding_id = ? ORDER BY created_at");
  const deleteProjectApproval = db.prepare("DELETE FROM project_approvals WHERE binding_id = ? AND head_sha = ?");
  // Prepared on first use: the migration tests open stores on partial schemas
  // from before this group, and `pull_requesters` is the newest table.
  const lazy = <P extends unknown[], R>(sql: string): (() => Database.Statement<P, R>) => {
    let prepared: Database.Statement<P, R> | null = null;
    return () => (prepared ??= db.prepare<P, R>(sql));
  };
  const insertPullRequester = lazy<[string, string, string, number], unknown>("INSERT OR IGNORE INTO pull_requesters (binding_id, url, login, created_at) VALUES (?, ?, ?, ?)");
  const pullRequestersFor = lazy<[string, string], Record<string, unknown>>("SELECT login FROM pull_requesters WHERE binding_id = ? AND url = ? ORDER BY created_at, login");
  const deletePullRequester = lazy<[string, string, string], unknown>("DELETE FROM pull_requesters WHERE binding_id = ? AND url = ? AND login = ?");
  const insertReviewerRequest = lazy<[string, string, string, string, number], unknown>("INSERT OR IGNORE INTO reviewer_requests (binding_id, url, login, head_sha, created_at) VALUES (?, ?, ?, ?, ?)");
  const reviewerRequestsFor = lazy<[string, string, string], Record<string, unknown>>("SELECT login FROM reviewer_requests WHERE binding_id = ? AND url = ? AND head_sha = ? ORDER BY created_at, login");

  const toProjectApproval = (r: Record<string, unknown>): ProjectApproval => ({
    bindingId: String(r.binding_id),
    headSha: String(r.head_sha),
    entry: r.entry === null || r.entry === undefined ? null : String(r.entry),
    byThread: String(r.by_thread),
    commentId: r.comment_id === null || r.comment_id === undefined ? null : String(r.comment_id),
    verdict: String(r.verdict ?? "approved") === "declined" ? "declined" : "approved",
    createdAt: Number(r.created_at),
  });

  return {
    // project-steward approvals of owner-reviewed pull requests (BB-30)
    /**
     * The project steward's approval of an owner-reviewed pull request, if it
     * recorded one for this binding's current head. A new push is a new sha,
     * so this is null again and the approval must be asked for afresh.
     */
    projectApproval(bindingId: string, headSha: string): ProjectApproval | null {
      const r = getProjectApproval.get(bindingId, headSha);
      return r === undefined ? null : toProjectApproval(r);
    },
    /** Every approval or decline the plugin recorded for a binding, oldest first; the gate matches a marker to one by comment id. */
    projectApprovals(bindingId: string): ProjectApproval[] {
      return projectApprovalsFor.all(bindingId).map(toProjectApproval);
    },
    /**
     * Record a project-steward approval or decline, bound to the pull
     * request's head sha and to the marker comment the plugin posted. The
     * caller is responsible for checking that the approver is the project
     * steward's thread; this is the store half.
     */
    recordProjectApproval(fields: { bindingId: string; headSha: string; entry: string | null; byThread: string; commentId?: string | null; verdict?: "approved" | "declined" }): ProjectApproval {
      insertProjectApproval.run({ binding_id: fields.bindingId, head_sha: fields.headSha, entry: fields.entry, by_thread: fields.byThread, comment_id: fields.commentId ?? null, verdict: fields.verdict ?? "approved", created_at: now() });
      return toProjectApproval(getProjectApproval.get(fields.bindingId, fields.headSha)!);
    },
    /** Drop a recorded approval (a new push voids it by sha; this is for an explicit retraction). */
    clearProjectApproval(bindingId: string, headSha: string): boolean {
      return deleteProjectApproval.run(bindingId, headSha).changes > 0;
    },
    // requested reviewers remembered for the delegate rule (BB-327)
    /**
     * Remember every login seen in a pull request's requested-reviewers list,
     * for the binding and URL (BB-327). GitHub drops a reviewer from the live
     * list once they submit, so the gate reads this set to count a delegate's
     * later APPROVED review.
     */
    rememberPullRequesters(bindingId: string, url: string, logins: readonly string[]): void {
      const at = now();
      for (const raw of logins) {
        const login = raw.trim().toLowerCase();
        if (login === "") continue;
        insertPullRequester().run(bindingId, url, login, at);
      }
    },
    /** The logins remembered as requested reviewers for a binding and URL (BB-327). */
    pullRequesters(bindingId: string, url: string): string[] {
      return pullRequestersFor().all(bindingId, url).map((r) => String(r.login));
    },
    /** Forget a remembered requester the owner removed while they had no review, ending that delegation (BB-327). */
    forgetPullRequester(bindingId: string, url: string, login: string): void {
      deletePullRequester().run(bindingId, url, login.trim().toLowerCase());
    },
    /** Record that a delegate was re-requested for a head, so a repeated look does not re-request (BB-327). */
    recordReviewerRequest(bindingId: string, url: string, login: string, headSha: string): void {
      insertReviewerRequest().run(bindingId, url, login.trim().toLowerCase(), headSha, now());
    },
    /** The delegates already re-requested for a binding, URL and head (BB-327). */
    reviewerRequests(bindingId: string, url: string, headSha: string): string[] {
      return reviewerRequestsFor().all(bindingId, url, headSha).map((r) => String(r.login));
    },
  };
}
