import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Where the thread is in its arc. A semantic judgement the summarizer makes
 * from the transcript, which the user can override by hand.
 */
export const briefStageSchema = z.enum([
  "discovery",
  "planning",
  "implementation",
  "review",
]);
export type BriefStage = z.infer<typeof briefStageSchema>;

/**
 * Who the thread is waiting on. Derived mechanically rather than asked of the
 * model, so it stays correct between summaries.
 */
export const briefStatusSchema = z.enum([
  "working",
  "waiting-on-me",
  "waiting-on-other",
  "done",
]);
export type BriefStatus = z.infer<typeof briefStatusSchema>;

export const BRIEF_STAGES: readonly BriefStage[] = briefStageSchema.options;

/**
 * The five prose fields, exactly as the summarizer is asked to return them.
 * Every field is a string; an empty string means "nothing to say", which is
 * meaningful for `nextStep` (the work is done) and `blockedOn` (nothing is
 * blocking). The display skips empty fields.
 */
export const briefFieldsSchema = z
  .object({
    goal: z.string(),
    currentState: z.string(),
    nextStep: z.string(),
    blockedOn: z.string(),
    constraints: z.string(),
  })
  .strict();
export type BriefFields = z.infer<typeof briefFieldsSchema>;

/** What the summarizer returns: the five fields plus its stage judgement. */
export const summaryResultSchema = briefFieldsSchema
  .extend({ stage: briefStageSchema })
  .strict();
export type SummaryResult = z.infer<typeof summaryResultSchema>;

/**
 * The persisted row, one per thread, under kv key `brief:<threadId>`.
 *
 * `stage` and `status` are deliberately absent: `stage` is
 * `stageOverride ?? modelStage` and `status` is derived from `nextStep`,
 * `blockedOn` and live thread facts, both resolved on read so neither goes
 * stale between summaries.
 */
export const storedBriefSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string(),
    fields: briefFieldsSchema,
    /** The stage the summarizer judged from the transcript. */
    modelStage: briefStageSchema,
    /** A manual stage that wins over `modelStage` until real new activity. */
    stageOverride: briefStageSchema.nullable(),
    /**
     * The thread's activity cursor when the override was set. The override is
     * dropped once the thread's cursor moves past it, so "sticks until real
     * thread activity" needs no timer.
     */
    stageOverrideSeq: z.number().nullable(),
    /**
     * Whether the thread's last assistant turn read as a question. Combined
     * with a live pending-interaction check to tell waiting-on-me from working.
     */
    endedWithQuestion: z.boolean(),
    lastSummarizedAt: z.number(),
    /** The thread's `conversationOutline().maxSeq` at summarize time. */
    lastActivitySeen: z.number(),
  })
  .strict();
export type StoredBrief = z.infer<typeof storedBriefSchema>;

/** A brief resolved for display: stored prose plus the derived facts. */
export const resolvedBriefSchema = briefFieldsSchema
  .extend({
    threadId: z.string(),
    stage: briefStageSchema,
    status: briefStatusSchema,
    stageOverride: briefStageSchema.nullable(),
    lastSummarizedAt: z.number(),
  })
  .strict();
export type ResolvedBrief = z.infer<typeof resolvedBriefSchema>;

/**
 * What the frontend sees for one thread.
 *
 * `summarizing` means work is genuinely pending — debounced, queued, or in
 * flight. `absent` means there is no brief and none is coming, which is the
 * normal state for a thread that was already dormant when the plugin arrived:
 * briefs are not backfilled, so the UI offers to make one on demand rather
 * than claiming a summary is on its way.
 */
export const briefStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), brief: resolvedBriefSchema }).strict(),
  z.object({ state: z.literal("summarizing") }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("unconfigured"), message: z.string() }).strict(),
  z.object({ state: z.literal("error"), message: z.string() }).strict(),
]);
export type BriefState = z.infer<typeof briefStateSchema>;

/** The per-row signal the sidebar draws: one glyph, no prose. */
export const rowSignalSchema = z
  .object({
    threadId: z.string(),
    status: briefStatusSchema,
    stage: briefStageSchema,
    /** Short accessible label for the glyph, e.g. "Waiting on you". */
    label: z.string(),
  })
  .strict();
export type RowSignal = z.infer<typeof rowSignalSchema>;

/** Realtime channel the server pokes when any brief changes. */
export const BRIEFS_CHANGED_CHANNEL = "briefs-changed";

export const rpcContract = defineRpcContract({
  /** The brief for one thread, for the thread-header popover. */
  getBrief: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: briefStateSchema,
  },
  /**
   * One signal per stored brief. The client decides which ones actually draw a
   * glyph, because the last input to that decision — whether the thread has a
   * pending interaction — is data the sidebar already holds.
   */
  listRowSignals: {
    input: z.null(),
    output: z.object({ signals: z.array(rowSignalSchema) }).strict(),
  },
  /** Set or clear the manual stage. Clearing returns to the model's judgement. */
  setStageOverride: {
    input: z
      .object({
        threadId: z.string().min(1),
        stage: briefStageSchema.nullable(),
      })
      .strict(),
    output: briefStateSchema,
  },
  /** Queue an immediate re-summary, bypassing the quiet-period debounce. */
  refresh: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ queued: z.boolean() }).strict(),
  },
});
