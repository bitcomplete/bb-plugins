import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const orgSchema = z.enum(["parsleyhealth", "bitcomplete", "ira-cscc"]);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const inputSchema = z.object({ org: orgSchema, week: dateSchema, refresh: z.boolean().default(false) }).strict();
export const cachedInputSchema = z.object({ org: orgSchema, week: dateSchema }).strict();
export const metricSchema = z.enum(["opened", "merged", "reviewed", "closed"]);
export const eventSchema = z.object({
  id: z.string().max(300), metric: metricSchema, login: z.string().max(100),
  repo: z.string().max(200), number: z.number().int().positive(), title: z.string().max(300),
  url: z.string().url().max(500), at: z.string().datetime(),
  // Retain existing cached metadata and record the first review within the selected week.
  createdAt: z.string().datetime().optional(), authorLogin: z.string().max(100).optional(),
  firstReviewedAt: z.string().datetime().optional(),
}).strict();
export type Event = z.infer<typeof eventSchema>;
export const inProgressSchema = z.object({
  login: z.string().max(100), repo: z.string().max(200), number: z.number().int().positive(),
  title: z.string().max(300), url: z.string().url().max(500), createdAt: z.string().datetime(),
  isDraft: z.boolean(),
}).strict();
export type InProgress = z.infer<typeof inProgressSchema>;
export const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), org: orgSchema, week: dateSchema, fetchedAt: z.string().datetime(), events: z.array(eventSchema).max(20000), inProgress: z.array(inProgressSchema).max(20000) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);
export type Result = z.infer<typeof resultSchema>;
export const snapshotResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), org: orgSchema, week: dateSchema, fetchedAt: z.string().datetime(), inProgress: z.array(inProgressSchema).max(20000) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(800) }).strict(),
]);
export type SnapshotResult = z.infer<typeof snapshotResultSchema>;
export const hostContract = defineRpcContract({
  activity: { input: inputSchema, output: resultSchema },
  in_progress: { input: inputSchema, output: snapshotResultSchema },
});
export const rpcContract = defineRpcContract({
  activity_get: { input: inputSchema, output: resultSchema },
  activity_cached: { input: cachedInputSchema, output: resultSchema.nullable() },
  in_progress_get: { input: inputSchema, output: snapshotResultSchema },
  in_progress_cached: { input: cachedInputSchema, output: snapshotResultSchema.nullable() },
});
