// The dependency watch's mechanical tier, as pure functions: a Dependabot
// alert's deadline from the project's per-severity SLA, the Linear priority
// its severity maps to, whether a new medium or low alert joins an open
// batched ticket or tightens its due date, and what changed between two looks
// at a repository's alerts. server.ts fetches and stores; nothing here talks
// to anything.
//
// The rules come from the ticket (BB-12): critical and high get their own
// ticket at once; medium and low coalesce into one open ticket per repo per
// ecosystem. `asap` is due now and escalates at once. A new alert joins the
// open ticket for its repo and ecosystem when that ticket's due date is
// inside the new alert's deadline; otherwise the due date tightens to the new
// deadline. A recurrence is a comment on the ticket, never a second ticket.
import { z } from "zod";
import { DEPENDABOT_SEVERITIES, type DependabotAlert, type DependabotSeverity } from "./source-contract.js";

/** The default SLA: `asap` or a duration, per severity. */
export const DEFAULT_SLA: Record<DependabotSeverity, number | "asap"> = {
  critical: "asap",
  high: 86_400_000,
  medium: 7 * 86_400_000,
  low: 30 * 86_400_000,
};

/** The default batch window a medium or low alert may wait for company. */
export const DEFAULT_BATCH: Record<"medium" | "low", number> = { medium: 7 * 86_400_000, low: 30 * 86_400_000 };

/** Severity maps one to one onto Linear priority. */
export const PRIORITY_BY_SEVERITY: Record<DependabotSeverity, string> = { critical: "urgent", high: "high", medium: "medium", low: "low" };

/** Whether a severity coalesces rather than getting a ticket of its own. */
export const isBatchable = (severity: DependabotSeverity): boolean => severity === "medium" || severity === "low";

/** The entity id doorbells carry and the fingerprint map keys on: "owner/repo#<alert number>". */
export const alertFingerprint = (alert: Pick<DependabotAlert, "repo" | "number">): string => `${alert.repo}#${alert.number}`;

/**
 * When an alert is due: `asap` is due the moment it is first seen, otherwise
 * first seen plus the severity's SLA. The clock is `firstSeenAt`, not the
 * alert's GitHub `created_at`: a server that missed a doorbell must not
 * inherit a deadline already spent, and an alert re-seen after a restart
 * keeps the deadline it first got from the fingerprint map.
 */
export function deadlineAt(severity: DependabotSeverity, sla: Record<DependabotSeverity, number | "asap">, firstSeenAt: number): number {
  const value = sla[severity];
  return value === "asap" ? firstSeenAt : firstSeenAt + value;
}

/** An open ticket a batched alert may join: one per repo per ecosystem. */
export type DepsTicket = { ticketKey: string; repo: string; ecosystem: string; dueAt: number };

export type BatchPlan =
  | { kind: "new" }
  | { kind: "join"; ticketKey: string }
  | { kind: "tighten"; ticketKey: string; dueAt: number };

/**
 * What a new alert does with the open tickets for its repo and ecosystem.
 * Critical and high never batch. A medium or low alert joins the open ticket
 * whose due date is inside (at or before) the new alert's deadline, since
 * that ticket is already at least as urgent; otherwise the ticket's due date
 * tightens to the new, earlier deadline. No open ticket means a new one.
 * `open` should hold only batchable tickets; anything else is ignored.
 */
export function batchAlert(alert: Pick<DependabotAlert, "repo" | "ecosystem" | "severity">, deadline: number, open: readonly DepsTicket[]): BatchPlan {
  if (!isBatchable(alert.severity)) return { kind: "new" };
  const candidates = open
    .filter((t) => t.repo.toLowerCase() === alert.repo.toLowerCase() && t.ecosystem.toLowerCase() === alert.ecosystem.toLowerCase())
    .sort((a, b) => a.dueAt - b.dueAt);
  const ticket = candidates[0];
  if (ticket === undefined) return { kind: "new" };
  return ticket.dueAt <= deadline ? { kind: "join", ticketKey: ticket.ticketKey } : { kind: "tighten", ticketKey: ticket.ticketKey, dueAt: deadline };
}

/** "urgent" for critical, "high" for high, and so on. */
export const priorityFor = (severity: DependabotSeverity): string => PRIORITY_BY_SEVERITY[severity];

/** One alert as a Markdown bullet for a ticket body or a comment. */
export function alertLine(alert: Pick<DependabotAlert, "package" | "ecosystem" | "severity" | "ghsaId" | "fixedVersion" | "manifestPath" | "url">): string {
  const where = [alert.ecosystem, alert.manifestPath].filter((v): v is string => v !== null && v !== "").join(" / ");
  const fixed = alert.fixedVersion === null ? "no fixed version yet" : `fixed in ${alert.fixedVersion}`;
  const ghsa = alert.ghsaId === null ? "" : ` ${alert.ghsaId}`;
  return `- **${alert.severity}**${ghsa} \`${alert.package}\`${where === "" ? "" : ` (${where})`} — ${fixed}${alert.url === null ? "" : ` — ${alert.url}`}`;
}

/** A due date as Linear wants it: an ISO date, in the project's time zone. */
export function dueDate(deadline: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(deadline));
}

/** Whether an alert is still open. GitHub's fixed, dismissed and auto_dismissed states are not. */
export const isOpen = (state: string): boolean => state === "open";

/** The part of an alert a look compares; the rest is evidence for the ticket. */
export type AlertSighting = { fingerprint: string; summary: string; severity: DependabotSeverity; ecosystem: string };

export function sightingOf(alert: DependabotAlert): AlertSighting {
  return {
    fingerprint: alertFingerprint(alert),
    summary: `${alert.severity} ${alert.package}${alert.ghsaId === null ? "" : ` (${alert.ghsaId})`}`,
    severity: alert.severity,
    ecosystem: alert.ecosystem,
  };
}

// ---- the look ------------------------------------------------------------------

/**
 * One alert in a dependency look, classified against the fingerprint map and
 * with the batch plan for its repo and ecosystem. `class` mirrors the ops
 * findings: new (no ticket), recurring (its ticket is open), returned (its
 * ticket was resolved).
 */
export const depsFindingSchema = z.object({
  fingerprint: z.string(),
  alertNumber: z.number().int(),
  severity: z.enum(DEPENDABOT_SEVERITIES),
  package: z.string(),
  ecosystem: z.string(),
  manifestPath: z.string().nullable(),
  ghsaId: z.string().nullable(),
  fixedVersion: z.string().nullable(),
  summary: z.string(),
  state: z.string(),
  url: z.string().nullable(),
  /** The SLA deadline, from the severity and when the alert was first seen. */
  dueAt: z.number(),
  /** The Linear priority the severity maps to. */
  priority: z.string(),
  class: z.enum(["new", "recurring", "returned"]),
  ticket: z.string().nullable(),
  ticketState: z.string().nullable(),
  /** When the ticket was resolved, when the source reports it; null otherwise. */
  closedAt: z.string().nullable(),
  /** Whether the ticket was resolved inside the two-week window; null when it was not resolved or has no date. */
  window: z.enum(["within", "outside"]).nullable(),
  /** The login the steward files under, or "unassigned" when it cannot be read. */
  assignee: z.string(),
  /** Set on a new finding when the dedup search could not run or was partial. */
  dedupUnavailable: z.boolean().default(false),
  firstSeenAt: z.number(),
  lastCommentedAt: z.number().nullable(),
  /** For a medium or low alert, what to do with the open ticket for its repo and ecosystem. */
  batch: z.union([
    z.object({ kind: z.literal("new") }),
    z.object({ kind: z.literal("join"), ticketKey: z.string() }),
    z.object({ kind: z.literal("tighten"), ticketKey: z.string(), dueAt: z.number() }),
  ]),
});
export type DepsFinding = z.infer<typeof depsFindingSchema>;

/** A dependency watch's last look at one repository. */
export const depsLookSchema = z.object({
  at: z.number(),
  target: z.string(),
  /** Set when the repository could not be read; `alerts` is then empty. */
  error: z.string().nullable(),
  viewer: z.string().nullable(),
  alerts: z.array(depsFindingSchema),
});
export type DepsLook = z.infer<typeof depsLookSchema>;

/** The repo a fingerprint names: "owner/repo#4" → "owner/repo". */
export const repoOfFingerprint = (fingerprint: string): string | null => {
  const i = fingerprint.lastIndexOf("#");
  return i <= 0 ? null : fingerprint.slice(0, i);
};
