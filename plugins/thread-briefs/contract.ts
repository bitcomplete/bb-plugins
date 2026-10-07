import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BRIEF_STAGES,
  STORED_BRIEF_STATUSES,
  type BriefStage,
  type StoredBriefStatus,
} from "./shared.js";

/**
 * Where the thread is in its arc. A semantic judgement the summarizer makes
 * from the transcript, which the user can override by hand. Built from the
 * plain list in `shared.ts` so the stages have one definition.
 */
export const briefStageSchema = z.enum(BRIEF_STAGES);
export type { BriefStage };

/**
 * Who the thread is waiting on. Derived mechanically rather than asked of the
 * model, so it stays correct between summaries.
 *
 * Three of the four come from the stored brief; `working` is live thread state
 * and is only ever applied on the client, so it never appears in a stored row
 * or in a row signal off the wire.
 */
export const briefStatusSchema = z.enum(["working", ...STORED_BRIEF_STATUSES]);
export type BriefStatus = z.infer<typeof briefStatusSchema>;

/**
 * The statuses a manual override may pick: the three a stored brief can hold.
 *
 * Built from the same list, so the sidebar's sections, the derivation and the
 * override cannot come to disagree about what a stored status is.
 */
export const storedBriefStatusSchema = z.enum(STORED_BRIEF_STATUSES);
export type { StoredBriefStatus };

export { BRIEF_STAGES, STORED_BRIEF_STATUSES };

/**
 * Who has to take `nextStep`. The one part of the status the model has to judge
 * rather than the code: "test it and tell me" and "keep going" are both concrete
 * next actions, and nothing in the prose distinguishes them.
 */
export const NEXT_STEP_ACTORS = ["me", "agent", "other"] as const;
export const nextStepActorSchema = z.enum(NEXT_STEP_ACTORS);
export type NextStepActor = z.infer<typeof nextStepActorSchema>;

/**
 * A thread title the summarizer proposed, after normalization.
 *
 * Short enough to survive a sidebar row: bb clamps its own generated titles to
 * 48 display columns, and a name that only reads in the popover is no use to
 * the surface this exists for.
 */
export const MAX_TITLE_LENGTH = 48;

/**
 * The fields the summarizer is asked to return, exactly as it returns them.
 *
 * The five prose fields are strings, where an empty string means "nothing to
 * say" — meaningful for `nextStep` (the work is done) and `blockedOn` (nothing
 * is blocking). The display skips empty fields.
 *
 * `nextStepActor` and `title` are the odd ones out: not prose, and optional.
 * Optional is load-bearing — see {@link storedBriefSchema}.
 */
export const briefFieldsSchema = z
  .object({
    goal: z.string(),
    currentState: z.string(),
    nextStep: z.string(),
    /**
     * A four-to-six-word name for the thread, when the model gave one we could
     * use. Absent means unknown, which is both a brief written before this
     * field existed and one the model answered with nothing usable; either way
     * the thread keeps whatever title it already has.
     */
    title: z.string().max(MAX_TITLE_LENGTH).optional(),
    /**
     * Who has to take `nextStep`, when the model offered a value we recognise.
     * Absent means unknown, which is both a brief written before this field
     * existed and one whose `nextStep` is empty; either way the status falls
     * back to the actor-free derivation.
     */
    nextStepActor: nextStepActorSchema.optional(),
    blockedOn: z.string(),
    constraints: z.string(),
  })
  .strict();
export type BriefFields = z.infer<typeof briefFieldsSchema>;

/**
 * How long each reorientation variant may run before it is clamped.
 *
 * The refresher is read standing at the composer, before typing — a paragraph
 * there is a thing to skip rather than a thing to read, and skipping it is the
 * one failure this feature cannot survive. The caps are therefore the sentence
 * budget expressed in characters: roughly two sentences for `short`, roughly
 * four for `full`. The prompt asks for the same lengths; these are what happens
 * when it is ignored.
 */
export const MAX_REFRESHER_LENGTH = { short: 280, full: 640 } as const;

/**
 * The two reorientation variants, as the summarizer returns them.
 *
 * Two rather than one because how much you have forgotten is not a property of
 * the thread — it is how long you have been away from it, which is only known
 * when the thread is opened. Generating both at summarize time and picking one
 * at open time is what keeps the choice late and the model call early.
 */
export const refresherProseSchema = z
  .object({
    /** One or two sentences, for a thread only just past the idle threshold. */
    short: z.string(),
    /** Two or three, for a thread that has gone cold. */
    full: z.string(),
  })
  .strict();
export type RefresherProse = z.infer<typeof refresherProseSchema>;

/**
 * The stored prose plus the status reading it was written against.
 *
 * `writtenForStatus` is the guard that makes "respect the status override"
 * cheap. A status pinned by hand *after* this brief was written would leave
 * prose that says "carry on" on a thread the user has just called blocked, and
 * the refresher refuses to make a fresh sentence at open time. Recording the
 * reading it was written for lets the open-time check notice the disagreement
 * and show nothing; setting a pin also queues the re-summary that resolves it.
 */
export const storedRefresherSchema = refresherProseSchema
  .extend({ writtenForStatus: storedBriefStatusSchema })
  .strict();
export type StoredRefresher = z.infer<typeof storedRefresherSchema>;

/** What the summarizer returns: the five fields, the stage, the status, the refresher. */
export const summaryResultSchema = briefFieldsSchema
  .extend({
    stage: briefStageSchema,
    status: storedBriefStatusSchema,
    /**
     * Null when the model returned nothing usable for either variant. A brief
     * with no refresher is a brief that simply never shows one — the same
     * outcome as every brief written before this field existed.
     */
    refresher: refresherProseSchema.nullable(),
  })
  .strict();
export type SummaryResult = z.infer<typeof summaryResultSchema>;

/**
 * The persisted row, one per thread, under kv key `brief:<threadId>`.
 *
 * `stage` and `status` are deliberately absent: `stage` is
 * `stageOverride ?? modelStage` and `status` is `statusOverride ?? modelStatus`,
 * both resolved on read so a pin that has expired stops applying without a
 * write. The live `working` override is applied later still, per row on the
 * client.
 *
 * New fields must be optional and `version` must stay at 1. `readBrief` deletes
 * any row that fails this parse, and briefs are never backfilled, so a required
 * field would silently drop every brief written before it and leave dormant
 * threads with no glyph and nothing to regenerate from.
 */
export const storedBriefSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string(),
    fields: briefFieldsSchema,
    /** The stage the summarizer judged from the transcript. */
    modelStage: briefStageSchema,
    /**
     * The status the summarizer judged from the transcript.
     *
     * Absent on a brief written before the summarizer was asked for a status.
     * Those keep the old reading, derived from `nextStep` and `blockedOn` (see
     * `legacyStatus`), until their thread is next summarized; they are not
     * backfilled, because re-summarizing every idle thread at once would put
     * every one that now reads done straight onto the archive clock.
     */
    modelStatus: storedBriefStatusSchema.optional(),
    /** A manual stage that wins over `modelStage` until real new activity. */
    stageOverride: briefStageSchema.nullable(),
    /**
     * The thread's activity cursor when the override was set. The override is
     * dropped once the thread's cursor moves past it, so "sticks until real
     * thread activity" needs no timer.
     */
    stageOverrideSeq: z.number().nullable(),
    /**
     * A manual status that wins over the derived status until real new activity.
     *
     * The escape hatch for the one thing the derivation cannot see: a `nextStep`
     * addressed to you and carried out *outside the thread* ("reload a client and
     * check the panel opens"). Doing it leaves no trace in the transcript, so no
     * summary can ever retire it, and re-summarizing only reads the same
     * unresolved instruction back. Without a manual say-so such a thread is
     * `waiting-on-me` forever.
     *
     * Optional, like every field added after version 1: `readBrief` deletes a row
     * that fails this parse and briefs are never backfilled, so a required field
     * would silently drop every brief written before it.
     */
    statusOverride: storedBriefStatusSchema.nullable().optional(),
    /**
     * The thread's activity cursor when the status override was set. Same
     * contract as {@link stageOverrideSeq}: the override is dropped once the
     * thread's cursor moves past it.
     */
    statusOverrideSeq: z.number().nullable().optional(),
    /**
     * Whether the thread's last assistant turn read as a question.
     *
     * No longer an input to `status`: an idle thread that is neither done nor
     * blocked is waiting on us whether or not it ended by asking something.
     * Kept because it is cheap to write and the obvious raw material for a
     * future "the agent asked *this*" line in the popover; nothing reads it
     * today.
     */
    endedWithQuestion: z.boolean(),
    /**
     * The thread title this plugin last wrote, or null if it has never written
     * one.
     *
     * The whole of the "do not clobber a name you chose" rule. bb records no
     * provenance for a title — there is no column saying whether it came from
     * bb's opening-prompt guess, from a rename, or from us — so remembering
     * what we wrote is the only way to tell our own title apart from yours.
     * Finding something else in `thread.title` means someone renamed the
     * thread, and renaming stops there: we leave this field alone, so the
     * mismatch persists and every later summary skips the rename too.
     */
    appliedTitle: z.string().nullable().optional(),
    /**
     * The re-entry reorientation, written by the same summarizer call that
     * wrote the fields above.
     *
     * Top-level rather than inside `fields` for two reasons. `fields` is fed
     * back into the next summary as the previous brief, and handing the model
     * its own last paragraph back invites it to keep the paragraph rather than
     * rewrite it from the thread. And `fields` is what the Brief panel renders,
     * where a second prose block restating the five fields would be noise.
     *
     * Optional and nullable, like every field added after version 1: a brief
     * written before this existed, or one whose model returned nothing usable,
     * is a brief that shows no refresher.
     */
    refresher: storedRefresherSchema.nullable().optional(),
    /**
     * When the archive sweep archived this thread by itself, or null/absent if
     * it never has.
     *
     * The whole of "do not re-archive something you pulled back out". The sweep
     * refuses to archive a thread whose brief carries this, so un-archiving one
     * by hand is final rather than an argument you have to win again every
     * hour.
     *
     * Deliberately *not* carried across a re-summary: `summarizeThread` builds
     * a fresh row, and a summary only happens when the thread has real new
     * activity. So the exemption lasts exactly as long as the thread stays
     * untouched — work in it again and it rejoins the normal cycle, which is
     * the same "sticks until real thread activity" contract the overrides above
     * get from their sequence anchors.
     */
    autoArchivedAt: z.number().nullable().optional(),
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
    /** The manual status, only while it is still in force. */
    statusOverride: storedBriefStatusSchema.nullable(),
    lastSummarizedAt: z.number(),
  })
  .strict();
export type ResolvedBrief = z.infer<typeof resolvedBriefSchema>;

/**
 * What the frontend sees for one thread.
 *
 * `summarizing` means work is genuinely pending — queued or in flight. `absent` means there is no brief and none is coming, which is the
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

/** Which of the two variants a given staleness asks for. */
export const refresherVariantSchema = z.enum(["short", "full"]);
export type RefresherVariant = z.infer<typeof refresherVariantSchema>;

/**
 * What the composer banner draws, or null for the overwhelming majority of
 * opens where reorienting is not needed.
 *
 * The whole decision is made on the server, in one call, because every input to
 * it is server-side: the stored prose, the effective status, the thread's
 * attention cursor and the dismissal record. The client renders the sentence it
 * is handed and decides nothing.
 */
export const refresherStateSchema = z
  .object({
    threadId: z.string(),
    /** The sentence or three to show. Never empty. */
    text: z.string().min(1),
    /** Which variant this is, so the client can label nothing and the tests can. */
    variant: refresherVariantSchema,
    /**
     * The thread's attention cursor this refresher is about.
     *
     * Handed to the client so that dismissing sends back the exact cursor it
     * was looking at rather than whatever the thread reads by then — a turn
     * that lands between the open and the dismiss must not be dismissed along
     * with it.
     */
    attentionAt: z.number(),
  })
  .strict();
export type RefresherState = z.infer<typeof refresherStateSchema>;

/**
 * One card on the board page: the brief facts a card shows, and nothing else.
 *
 * A sibling of {@link rowSignalSchema} rather than an extension of it, because
 * the two surfaces want different amounts: the sidebar draws a glyph and would
 * pay for prose it never renders on every row of every window, and the board
 * needs `nextStep` on every card but reads `goal`, `currentState` and
 * `constraints` only for the one card you expand — which `getBrief` already
 * answers, per thread, on demand.
 *
 * `status` is the *stored* status. `working` is live thread state that never
 * reaches a stored row, so the board folds it in per card off the sidebar view
 * it already holds, exactly as the row glyphs do.
 *
 * `modelStage` is here and not on {@link resolvedBriefSchema} because only the
 * board needs it: dropping a card on the stage the summarizer already judged
 * clears the pin instead of setting one, and that comparison is impossible from
 * the effective stage alone.
 */
export const briefCardSchema = z
  .object({
    threadId: z.string(),
    stage: briefStageSchema,
    /** The summarizer's own judgement, whatever the effective stage is. */
    modelStage: briefStageSchema,
    status: storedBriefStatusSchema,
    stageOverride: briefStageSchema.nullable(),
    statusOverride: storedBriefStatusSchema.nullable(),
    nextStep: z.string(),
    nextStepActor: nextStepActorSchema.optional(),
    blockedOn: z.string(),
    lastSummarizedAt: z.number(),
  })
  .strict();
export type BriefCard = z.infer<typeof briefCardSchema>;

/** The per-row signal the sidebar draws: one glyph, no prose. */
export const rowSignalSchema = z
  .object({
    threadId: z.string(),
    status: briefStatusSchema,
    stage: briefStageSchema,
    /**
     * Short accessible label for the glyph, e.g. "Review — Waiting on you".
     * Stage first, because the glyph draws the stage and the label is the only
     * thing that names it.
     */
    label: z.string(),
  })
  .strict();
export type RowSignal = z.infer<typeof rowSignalSchema>;

export { BRIEFS_CHANGED_CHANNEL } from "./shared.js";

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
    output: z
      .object({
        signals: z.array(rowSignalSchema),
        /**
         * How long a done thread may sit untouched before its ring goes grey,
         * and how long before the sweep archives it. 0 means off.
         *
         * Sent with the signals rather than read from settings on the client,
         * because the sweep on the server decides with these same numbers: one
         * source, so the grey ring cannot promise an archiving the sweep is not
         * about to do. The client needs `archiveAfterMs` only to decide whether
         * the label may say so.
         */
        staleAfterMs: z.number(),
        archiveAfterMs: z.number(),
      })
      .strict(),
  },
  /**
   * One card per stored brief, for the board page.
   *
   * Same shape of call as `listRowSignals` and for the same reason: one kv scan,
   * no per-thread lookups, and the client joins the result to the sidebar's
   * live thread view for titles, projects, pins, `working` and staleness. The
   * thresholds ride along so the board's grey treatment and the sweep cannot
   * come to disagree.
   */
  listBriefCards: {
    input: z.null(),
    output: z
      .object({
        cards: z.array(briefCardSchema),
        staleAfterMs: z.number(),
        archiveAfterMs: z.number(),
      })
      .strict(),
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
  /**
   * Set or clear the manual status. Clearing returns to the derivation over the
   * brief's own fields.
   */
  setStatusOverride: {
    input: z
      .object({
        threadId: z.string().min(1),
        status: storedBriefStatusSchema.nullable(),
      })
      .strict(),
    output: briefStateSchema,
  },
  /** Queue a re-summary even if the thread has not moved since the last one. */
  refresh: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ queued: z.boolean() }).strict(),
  },
  /**
   * The reorientation to show on opening this thread, or null.
   *
   * Asked once when the composer banner mounts, and never re-asked while the
   * thread stays open: a refresher is for the moment you arrive, and one that
   * appeared while you were already reading would be an interruption rather
   * than an orientation.
   */
  getRefresher: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ refresher: refresherStateSchema.nullable() }).strict(),
  },
  /**
   * Record that the refresher for this attention cursor has served its purpose
   * — the user sent a message or dismissed it by hand.
   *
   * Keyed on the cursor rather than the thread, so the dismissal covers exactly
   * the activity it was shown for: new activity the user has not seen brings
   * the refresher back, and nothing else does.
   */
  dismissRefresher: {
    input: z
      .object({ threadId: z.string().min(1), attentionAt: z.number() })
      .strict(),
    output: z.object({ dismissed: z.boolean() }).strict(),
  },
});
