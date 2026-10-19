import { z } from "zod";
import { yourTurnSchema } from "./your-turn.js";

export const pullRequestSchema = z.object({
  id: z.string(), repo: z.string(), number: z.number().int().positive(), title: z.string(),
  url: z.string().url().startsWith("https://github.com/"), head: z.string(), branch: z.string(),
  draft: z.boolean(), updatedAt: z.string(), activity: z.string(), turn: yourTurnSchema.nullable(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const selectionSchema = pullRequestSchema.pick({ id: true, activity: true });
export type Selection = z.infer<typeof selectionSchema>;
export const dispatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("uncertain"), detail: z.string() }),
  z.object({ kind: z.literal("linked"), threadId: z.string() }),
]);
export const savedStateSchema = z.object({
  dismissedActivity: z.string().nullable(), dispatch: dispatchSchema,
  holdUntil: z.string().datetime().nullable().default(null),
});
export type SavedState = z.infer<typeof savedStateSchema>;
export const rowSchema = pullRequestSchema.extend({
  dismissed: z.boolean(), dispatch: dispatchSchema,
  holdUntil: z.string().datetime().nullable().default(null),
  threadStatus: z.string().nullable(),
});
export type Row = z.infer<typeof rowSchema>;
export const pollSchema = z.object({
  at: z.string(), login: z.string().nullable(), error: z.string().nullable(),
  lastSuccess: z.string().nullable(),
  retryAt: z.string().datetime().nullable().default(null),
});
export const viewSchema = z.object({ rows: z.array(rowSchema), poll: pollSchema.nullable(), project: z.string().nullable() });
export type View = z.infer<typeof viewSchema>;
