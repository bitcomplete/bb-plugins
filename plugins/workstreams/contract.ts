// Shared runtime contract between server.ts (in the BB server) and host.ts
// (in the per-machine host worker). Both sides import this module, so the
// schemas below are the single definition of what a scan returns.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
    /**
     * The state of each reviewer's LATEST review, uppercased. The one extra
     * field `approved-with-comments` needs, taken from the `gh pr list` call
     * that was already being made rather than from a second round trip per PR.
     */
    latestReviewStates: z.array(z.string().max(40)).max(50),
    /**
     * When the PR merged, from the same `gh pr list` call. It dates the Board's
     * Recently shipped section. Defaulted so a unit cached before the field
     * existed still parses rather than vanishing until the next scan.
     */
    mergedAt: z.string().max(40).nullable().default(null),
    /**
     * The merge-conflict / branch-currency signal. Defaulted to UNKNOWN so a
     * unit cached before this field existed loads instead of failing to
     * parse — and UNKNOWN is never read as ready to merge.
     */
    mergeStateStatus: mergeStateStatusSchema.default("UNKNOWN"),
  })
  .strict();
export type Pr = z.infer<typeof prSchema>;

/** One git checkout as the host observed it. */
export const rawUnitSchema = z
  .object({
    path: z.string().max(1_000),
    dirName: z.string().max(300),
    repo: z.string().max(200).nullable(),
    branch: z.string().max(300).nullable(),
    dirty: z.boolean(),
    ahead: z.number().int().nullable(),
    behind: z.number().int().nullable(),
    lastCommitAt: z.string().max(40).nullable(),
    /** The repo's default branch. A PR based on it is a stack root. */
    defaultBranch: z.string().max(300).nullable(),
    pr: prSchema.nullable(),
    /**
     * True when the merge commit is contained in a release tag, false when it
     * is not, and null when the question could not be answered — no tags, no
     * merge commit, or a git failure. Null must never be read as shipped.
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
  })
  .strict();
export type GroupNaming = z.infer<typeof groupNamingSchema>;
/** v3's name for the effort-level payload. */
export type EffortNaming = GroupNaming;

export const groupLevelSchema = z.enum(["domain", "program", "effort"]);
export type GroupLevel = z.infer<typeof groupLevelSchema>;

/** Claude's coarse verdict on a grouping it was asked to name. */
export const cohesionSchema = z.enum(["cohesive", "mixed"]);

export const hostContract = defineRpcContract({
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
