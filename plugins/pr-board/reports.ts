import { z } from "zod";

const keySchema = z.string().min(1).max(300);
const summarySchema = z.string().trim().min(1).max(300);
const updateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), key: keySchema, summary: summarySchema }).strict(),
  z.object({ kind: z.literal("result"), key: keySchema, outcome: z.enum(["prepared", "published", "drafted", "blocked", "stopped"]), summary: summarySchema, detail: z.string().max(4000) }).strict(),
]);
export const reportInputSchema = z.object({ updates: z.array(updateSchema).min(1).max(100) }).strict()
  .refine(({ updates }) => new Set(updates.map((update) => update.key)).size === updates.length, "Report keys must be distinct");
export type ReportInput = z.infer<typeof reportInputSchema>;
export const reportSchema = z.discriminatedUnion("kind", [
  updateSchema.options[0].omit({ key: true }).extend({ receivedAt: z.string() }),
  updateSchema.options[1].omit({ key: true }).extend({ receivedAt: z.string() }),
]);
export type Report = z.infer<typeof reportSchema>;

export class ReportRetryableError extends Error {
  constructor() { super("The coordinator assignment is not available yet. Retry this report after the start finishes."); }
}

/** Validate the whole batch before replacing any assigned key's latest report. */
export function recordReports<T extends { key: string; threadId: string | null; report?: Report | null }>(
  assignments: T[], threadId: string, input: ReportInput,
) {
  const owned = new Set(assignments.filter((item) => item.threadId === threadId).map((item) => item.key));
  if (!owned.size && !assignments.some((item) => item.threadId !== null && input.updates.some((update) => update.key === item.key))) {
    throw new ReportRetryableError();
  }
  if (input.updates.some((update) => !owned.has(update.key))) throw new Error("This key is not assigned to the reporting coordinator.");
  const receivedAt = new Date().toISOString();
  const reports = new Map(input.updates.map(({ key, ...value }) => [key, { ...value, receivedAt }]));
  return {
    assignments: assignments.map((item) => {
      const report = reports.get(item.key);
      return report ? { ...item, report } : item;
    }),
    result: { accepted: input.updates.map((update) => update.key), receivedAt },
  };
}
