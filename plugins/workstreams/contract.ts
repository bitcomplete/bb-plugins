// Shared runtime contract between server.ts (in the BB server) and host.ts
// (in the per-machine host worker). Both sides import this module, so the
// schemas below are the single definition of what a scan returns.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { advanceInspectionSchema, advanceWorkspaceInputSchema, advanceWorkspaceSchema } from "./advance-contract.js";

/**
 * GitHub's authoritative "can this merge right now" signal
 * (`mergeStateStatus` from `gh pr list`), as opposed to `mergeable`, which
 * only says whether the diff applies and is fetched but unused. CLEAN,
 * HAS_HOOKS and UNSTABLE all mean nothing blocks the merge button; BEHIND
 * means the branch needs updating; BLOCKED means branch protection is
 * unsatisfied; DIRTY means there is a conflict; UNKNOWN covers a value
 * GitHub has not reported yet, one it added later, or a unit scanned before
 * this field existed.
 */
export const MERGE_STATE_STATUSES = [
  "CLEAN",
  "BEHIND",
  "DIRTY",
  "BLOCKED",
  "UNSTABLE",
  "HAS_HOOKS",
  "UNKNOWN",
] as const;
export const mergeStateStatusSchema = z.enum(MERGE_STATE_STATUSES);
export type MergeStateStatus = z.infer<typeof mergeStateStatusSchema>;

/** The pull request facts the lifecycle rules in workstreams.ts consume. */
export const prSchema = z
  .object({
    number: z.number().int(),
    state: z.string().max(40),
    isDraft: z.boolean(),
    reviewDecision: z.string().max(40).nullable(),
    /** Every statusCheckRollup conclusion, uppercased and bounded. */
    checkConclusions: z.array(z.string().max(40)).max(100),
    url: z.string().max(500),
    title: z.string().max(300),
    mergeable: z.string().max(40).nullable(),
    /** The branch this PR merges into. Another PR's head means it is stacked. */
    baseRefName: z.string().max(300).nullable(),
    headRefName: z.string().max(300).nullable(),
    headRefOid: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
    baseRefOid: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
    /** Each reviewer's latest review, uppercased, from the existing PR list call. */
    latestReviewStates: z.array(z.string().max(40)).max(50),
    /** GitHub's PR open time. Optional so older persisted scans still load. */
    createdAt: z.string().max(40).nullable().optional(),
    /**
     * When the PR merged, from the same `gh pr list` call. It dates the Board's
     * Recently merged section. Defaulted so a unit cached before the field
     * existed still parses rather than vanishing until the next scan.
     */
    mergedAt: z.string().max(40).nullable().default(null),
    /**
     * The merge-conflict / branch-currency signal. Defaulted to UNKNOWN so a
     * unit cached before this field existed loads instead of failing to
     * parse — and UNKNOWN is never read as ready to merge.
     */
    mergeStateStatus: mergeStateStatusSchema.default("UNKNOWN"),
    /**
     * Reviewers (logins, or org/team slugs) whose review is still requested,
     * from the same `gh pr list` call. The nudge dialog lists them. Defaulted
     * so a unit cached before the field existed still parses.
     */
    reviewRequests: z.array(z.string().max(140)).max(20).default([]),
    /**
     * Each reviewer's latest review, with who left it, from the same
     * `latestReviews` field `latestReviewStates` reads. The Board row shows
     * one mark per reviewer. Defaulted so a unit cached before the field
     * existed still parses.
     */
    latestReviews: z
      .array(z.object({ login: z.string().max(140), state: z.string().max(40) }).strict())
      .max(50)
      .default([]),
    /** The latest approving review has body text; absent on older scans. */
    approvalHasBody: z.boolean().optional(),
    /** Its inline threads were addressed, or the author explicitly replied to its standalone note after a newer head. */
    approvalNoteFollowedUp: z.boolean().optional(),
    /** Changes requested remains GitHub's decision, but the author posted a verified PTAL after a newer head. */
    reviewFollowupPosted: z.boolean().optional(),
    /** Null until review threads are checked; zero means no unresolved threads. */
    unresolvedReviewThreads: z.number().int().min(0).max(100).nullable().default(null),
    /** Complete-page count of resolved review threads; null when unread or incomplete. */
    resolvedReviewThreads: z.number().int().min(0).max(100).nullable().default(null),
    /**
     * Ticket IDs the PR description states, extracted on the host from its
     * first 8 KB. The description itself is client content and is never kept,
     * sent or logged. Absent on a unit cached before the field existed.
     */
    ticketRefs: z
      .object({ urls: z.array(z.string().max(40)).max(10), mentions: z.array(z.string().max(40)).max(10) })
      .strict()
      .optional(),
  })
  .strict();
export type Pr = z.infer<typeof prSchema>;

/** One git checkout as the host observed it. */
export const rawUnitSchema = z
  .object({
    path: z.string().max(1_000),
    dirName: z.string().max(300),
    repo: z.string().max(200).nullable(),
    /** Exact owner/repo from a github.com origin, used to scope authored PR discovery. */
    githubRepo: z.string().max(200).nullable().optional(),
    branch: z.string().max(300).nullable(),
    /** Git reports a detached HEAD while replaying commits; the original branch remains associated for display. */
    rebasing: z.boolean().optional(),
    dirty: z.boolean(),
    /** Explicit scan observations. Missing on older persisted rows, which the server treats as unknown. */
    observed: z.object({ status: z.boolean(), pr: z.boolean() }).strict().optional(),
    ahead: z.number().int().nullable(),
    behind: z.number().int().nullable(),
    lastCommitAt: z.string().max(40).nullable(),
    /** The repo's default branch. A PR based on it is a stack root. */
    defaultBranch: z.string().max(300).nullable(),
    pr: prSchema.nullable(),
    /**
     * True when the merge commit is contained in a release tag, false when it
     * is not, and null when the question could not be answered — no tags, no
     * merge commit, or a git failure. Null must never be read as release tagged.
     */
    shipped: z.boolean().nullable(),
    /**
     * Repo-relative paths this branch changes against its merge base, for
     * surface classification. Bounded twice over: this cap, and the host's own
     * cap on what it collects, because a host RPC result is limited to 8 MiB
     * and one enormous refactor must not cost the whole scan.
     */
    changedPaths: z.array(z.string().max(300)).max(500),
  })
  .strict();
export type RawUnit = z.infer<typeof rawUnitSchema>;

export const inventoryEntrySchema = z.object({ repo: z.string().max(200), pr: prSchema }).strict();
export const inventoryResultSchema = z.object({
  owners: z.array(z.string().max(39)).max(50),
  entries: z.array(inventoryEntrySchema).max(1_000),
  discoveryComplete: z.boolean(),
  repositories: z.array(z.object({ repo: z.string().max(200), complete: z.boolean() }).strict()).max(1_000),
  complete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
}).strict();
export const inventoryInspectionSchema = z.object({
  entries: z.array(inventoryEntrySchema).max(100),
  closed: z.array(z.string().max(500)).max(100),
  failed: z.array(z.string().max(500)).max(100),
  warnings: z.array(z.string().max(500)).max(50),
}).strict();
export const inventoryBoardSchema = z.object({
  owners: z.array(z.string()),
  entries: z.array(inventoryEntrySchema.extend({ stale: z.boolean(), effortKey: z.string().optional(), effortName: z.string().optional() })),
  complete: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  refreshing: z.boolean(),
  warnings: z.array(z.string()),
});

/** One group as the naming call sees it: label, and what is inside it. */
export const groupNamingSchema = z
  .object({
    label: z.string().max(200),
    members: z
      .array(
        z
          .object({
            /** Ticket key at the effort level, child group key above it. */
            ticket: z.string().max(200),
            summary: z.string().max(300),
            repos: z.array(z.string().max(200)).max(50),
          })
          .strict(),
      )
      .max(30),
    /**
     * Phrases the name may be drawn from, Linear project names among them. One
     * candidate, never an automatic winner.
     */
    candidates: z.array(z.string().max(300)).max(12),
    /**
     * Context, never a name: members' Linear ticket titles, parents and
     * projects, and the titles of their strongly linked threads. Absent when
     * none is known.
     */
    context: z.array(z.string().max(300)).max(20).optional(),
  })
  .strict();
export type GroupNaming = z.infer<typeof groupNamingSchema>;
/** v3's name for the effort-level payload. */
export type EffortNaming = GroupNaming;

export const groupLevelSchema = z.enum(["domain", "program", "effort"]);
export type GroupLevel = z.infer<typeof groupLevelSchema>;

/** Claude's coarse verdict on a grouping it was asked to name. */
export const cohesionSchema = z.enum(["cohesive", "mixed"]);

const writeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), detail: z.string().max(500) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);

/** What the merge dialog re-reads live. Mirrors `LiveMergeFacts` in actions.ts. */
export const liveMergeSchema = z
  .object({
    state: z.string().max(40),
    isDraft: z.boolean(),
    reviewDecision: z.string().max(40).nullable(),
    mergeStateStatus: mergeStateStatusSchema,
    headRefOid: z.string().max(64).nullable(),
    stackedAbove: z.array(z.number().int()).max(50),
    unresolvedThreads: z.number().int(),
    unresolvedAtLeast: z.boolean(),
    approvalNotes: z.array(z.object({
      author: z.string().max(140),
      body: z.string().max(1_200),
      submittedAt: z.string().max(40),
      truncated: z.boolean(),
    }).strict()).max(3),
    approvalNotesMore: z.number().int().min(0),
    approvalNotesComplete: z.boolean(),
  })
  .strict();

/**
 * A direct GitHub write. The PR is named by its URL from the server's own
 * scan; the host re-derives owner, repo and number from it and builds every
 * command as an argv array.
 */
export const prWriteSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("merge"),
      prUrl: z.string().max(500),
      method: z.enum(["squash", "merge", "rebase"]),
      sha: z.string().regex(/^[0-9a-f]{40}$/u),
      deleteBranch: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("update-branch"), prUrl: z.string().max(500) }).strict(),
  z
    .object({
      kind: z.literal("nudge"),
      prUrl: z.string().max(500),
      reviewers: z.array(z.string().max(140)).max(20),
      comment: z.string().max(4_000).nullable(),
    })
    .strict(),
]);
export type PrWrite = z.infer<typeof prWriteSchema>;

export const hostContract = defineRpcContract({
  advanceInspect: {
    input: z.object({ prUrl: z.string().max(500) }).strict(),
    output: advanceInspectionSchema,
  },
  advanceWorkspace: { input: advanceWorkspaceInputSchema, output: advanceWorkspaceSchema },
  authoredPrs: {
    input: z.object({ owners: z.array(z.string().max(39)).max(50) }).strict(),
    output: inventoryResultSchema,
  },
  inspectPrs: {
    input: z.object({ prUrls: z.array(z.string().max(500)).max(100) }).strict(),
    output: inventoryInspectionSchema,
  },
  /** Cheap live local guard before a direct PR write; never trusts the last scan's branch state. */
  checkoutState: {
    input: z.object({ path: z.string().max(1_000) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), branch: z.string().max(300).nullable(), rebasing: z.boolean() }).strict(),
      z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
    ]),
  },
  /** Recheck the PR and its pending reviewers immediately before a nudge. */
  prReviewers: {
    input: z.object({ prUrl: z.string().max(500) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), reviewers: z.array(z.string().max(140)).max(20) }).strict(),
      z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
    ]),
  },
  /** Read-only: the facts the merge dialog shows, fetched live. */
  prLive: {
    input: z.object({ prUrl: z.string().max(500) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), live: liveMergeSchema }).strict(),
      z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
    ]),
  },
  /** The only GitHub writes. Each runs only after the user confirmed its dialog. */
  prWrite: { input: prWriteSchema, output: writeResultSchema },
  scan: {
    input: z.object({ roots: z.array(z.string().max(1_000)).max(50) }).strict(),
    output: z
      .object({
        units: z.array(rawUnitSchema).max(2_000),
        warnings: z.array(z.string().max(500)).max(50),
      })
      .strict(),
  },
  /**
   * Re-inspect named checkouts only: a finished row action rescans the row it
   * touched, not every root. A path that is no longer a checkout is left out.
   */
  inspectPaths: {
    input: z.object({ paths: z.array(z.string().max(1_000)).max(20) }).strict(),
    output: z
      .object({
        units: z.array(rawUnitSchema).max(20),
        warnings: z.array(z.string().max(500)).max(50),
      })
      .strict(),
  },
  /**
   * Read the Linear linkback comment on each named PR, for PRs no cheaper
   * source found a ticket for. Only the ticket ID comes back, never comment
   * text. A PR whose read failed is left out, so it is tried again later.
   */
  linkbacks: {
    input: z.object({ prUrls: z.array(z.string().max(500)).max(100) }).strict(),
    output: z
      .object({
        found: z.array(z.object({ prUrl: z.string().max(500), ticket: z.string().max(40).nullable() }).strict()).max(100),
        warnings: z.array(z.string().max(500)).max(10),
      })
      .strict(),
  },
  /**
   * Rename efforts with Claude. It lives on the host because the host artifact
   * bundles its pure-JS dependencies, and `@anthropic-ai/sdk` is one.
   */
  nameGroups: {
    input: z
      .object({
        apiKey: z.string().max(500),
        /** Decides the word budget and how the prompt frames the level. */
        level: groupLevelSchema,
        groups: z.array(groupNamingSchema).max(80),
      })
      .strict(),
    output: z
      .object({
        names: z
          .array(
            z
              .object({
                label: z.string(),
                name: z.string(),
                /**
                 * Returned in the SAME call as the name: no extra round trip,
                 * no extra spend, and it goes stale exactly when the name does.
                 */
                cohesion: cohesionSchema,
                reason: z.string().max(300).nullable(),
              })
              .strict(),
          )
          .max(80),
        warnings: z.array(z.string().max(500)).max(10),
        calls: z.number().int(),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
      })
      .strict(),
  },
});
