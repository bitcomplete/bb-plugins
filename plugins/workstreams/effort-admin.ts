import { createHash } from "node:crypto";
import { z } from "zod";
import { establishedEffortSchema, type EstablishedEffort } from "./effort-store.js";

const failure = z.object({ ok: z.literal(false), error: z.string() });
export const effortAdminListSchema = z.object({ efforts: z.array(establishedEffortSchema), scopes: z.record(z.string(), z.string()) });
export const effortAdminResultSchema = z.discriminatedUnion("ok", [failure,
  z.object({ ok: z.literal(true), effort: establishedEffortSchema, notice: z.string().nullable().optional() }),
]);
export const effortAdminThreadSchema = z.object({ id: z.string(), title: z.string(), role: z.string(), status: z.string() });
export const effortAdminPreviewSchema = z.object({
  scope: z.string(), source: establishedEffortSchema, destination: establishedEffortSchema,
  members: z.object({ tickets: z.number(), prUrls: z.number(), checkoutPaths: z.number() }),
  threads: z.array(effortAdminThreadSchema), conflicts: z.array(z.string()), blockers: z.array(z.string()), pendingThreadSync: z.number(),
});
export const effortAdminPreviewResultSchema = z.discriminatedUnion("ok", [failure,
  z.object({ ok: z.literal(true), preview: effortAdminPreviewSchema }),
]);
export const effortAdminMergeResultSchema = z.discriminatedUnion("ok", [failure,
  z.object({ ok: z.literal(true), effort: establishedEffortSchema, pendingThreadSync: z.number(), notice: z.string().nullable() }),
]);

/** Include lifecycle, ownership, bindings, and thread identities in the preview guard. */
export function effortAdminScope(source: EstablishedEffort, destination: EstablishedEffort,
  sourceControllers: readonly unknown[], destinationControllers: readonly unknown[], threadIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([source, destination, sourceControllers, destinationControllers, [...threadIds].sort()])).digest("hex");
}

export function effortAdminRevision(effort: EstablishedEffort): string {
  return createHash("sha256").update(JSON.stringify(effort)).digest("hex");
}

export const effortAdminSyncActionSchema = z.object({
  threadId: z.string(), workEffortId: z.string().optional(), expectedWorkEffortId: z.string().nullable().optional(),
  effortId: z.string().optional(), expectedEffortId: z.string().nullable().optional(),
  parentThreadId: z.string().nullable().optional(), expectedParentThreadId: z.string().nullable().optional(),
  title: z.string().optional(), expectedTitle: z.string().optional(),
});
export type EffortAdminSyncAction = z.infer<typeof effortAdminSyncActionSchema>;
