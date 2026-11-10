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
 * When an alert is due: `asap` is due the moment the clock starts, otherwise
 * the clock plus the severity's SLA. The clock is the alert's own GitHub
 * `created_at` (`alertClockAt`), not when this server first saw it: a watch
 * binding recreated days later must not hand the ticket a fresh deadline
 * beside the one Linear already carries (SC-111 drifted three days that way).
 * A server that first sees an old alert inherits a deadline already spent,
 * which is the truth of the matter.
 */
export function deadlineAt(severity: DependabotSeverity, sla: Record<DependabotSeverity, number | "asap">, clockAt: number): number {
  const value = sla[severity];
  return value === "asap" ? clockAt : clockAt + value;
}

/**
 * When an alert's SLA clock started: its GitHub `created_at` when it parses,
 * else when this server first saw it (the fingerprint map's `first_seen_at`).
 */
export function alertClockAt(alert: Pick<DependabotAlert, "createdAt">, firstSeenAt: number): number {
  if (alert.createdAt === null) return firstSeenAt;
  const parsed = Date.parse(alert.createdAt);
  return Number.isNaN(parsed) ? firstSeenAt : parsed;
}

/** The first YYYY-MM-DD date in a note, as an instant at noon UTC (that date in every time zone from UTC-12 to UTC+11), or null. */
export function dateInText(text: string): number | null {
  const match = /(\d{4}-\d{2}-\d{2})/u.exec(text);
  if (match === null) return null;
  const ms = Date.parse(`${match[1]}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When a `Keep tracking` answer snoozes the decision until: the date the
 * answer's note gives, or one SLA window from now when it gives none. The
 * plugin owns this clock (it never reads Linear's due date), so it is
 * computed once, when the answer arrives, and recorded on the decision.
 */
export function snoozeUntil(note: string, severity: DependabotSeverity | null, sla: Record<DependabotSeverity, number | "asap">, now: number): number {
  return dateInText(note) ?? deadlineAt(severity ?? "medium", sla, now);
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

/**
 * The label a GitHub issue carries in place of Linear's priority field
 * (BB-235): `priority:<level>`. `ops.autoAdopt` names levels directly; a
 * Dependabot severity maps through `priorityFor`. The onboarding label step
 * (BB-236/BB-234) creates these labels; the watches only add the label of the
 * priority an issue is filed at, and `check` reports a filing repo that lacks
 * one.
 */
export const priorityLabel = (priority: string): string => `priority:${priority}`;
export const priorityLabelForSeverity = (severity: DependabotSeverity): string => priorityLabel(priorityFor(severity));

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
  /** The SLA deadline, from the severity and the alert's own created_at (`alertClockAt`). */
  dueAt: z.number(),
  /** The ticket's labels as Linear has them, so the wake can say whether it is adopted. */
  ticketLabels: z.array(z.string()).default([]),
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
  /** The alert's own created_at as GitHub reports it, the SLA clock; null when it did not parse. */
  alertCreatedAt: z.string().nullable().default(null),
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
  /**
   * Whether the repository's dependency graph parsed no manifests, so an
   * empty alert list means Dependabot cannot see anything rather than that
   * there is nothing to see (BB-289). Optional so a look stored before this
   * field parses; absent means false.
   */
  graphEmpty: z.boolean().optional(),
});
export type DepsLook = z.infer<typeof depsLookSchema>;

// ---- adoption decisions ------------------------------------------------------------
//
// A ticket filed for a severity `deps.autoAdopt` does not name is nobody's
// until the owner says so. The plugin keeps that question as durable state
// keyed by ticket (store.ts `deps_decisions`), shown as a `decide` need on
// whichever binding watches the repository now, so it survives the filing
// thread being deleted and the binding being recreated (SC-111 sat six days
// in Backlog because the one escalation that was meant to ask got lost).

/** The owner's choices on an unadopted ticket, the recommended one first. */
export const ADOPTION_CHOICES = { adopt: "Adopt", dismiss: "Dismiss as not used", keep: "Keep tracking" } as const;

/**
 * The choices offered on an adoption decision, the recommended one first. With
 * a fix available, adopting (a worker makes the upgrade) leads; with no
 * patched version for any alert, dismissing the alerts as unused leads, since
 * adopting could only produce a decision anyway. `Dismiss as not used` is
 * offered only when the playbook's `may` list declares `dismiss-alert`.
 */
export function adoptionChoices(hasFix: boolean, dismissAllowed: boolean): string[] {
  if (hasFix) return dismissAllowed ? [ADOPTION_CHOICES.adopt, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.dismiss] : [ADOPTION_CHOICES.adopt, ADOPTION_CHOICES.keep];
  return dismissAllowed ? [ADOPTION_CHOICES.dismiss, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.adopt] : [ADOPTION_CHOICES.keep, ADOPTION_CHOICES.adopt];
}

/** The one line a decision item asks. `overdueDays` rewords the item once the deadline has passed. */
export function adoptionQuestion(ticketKey: string, repo: string, alerts: ReadonlyArray<Pick<DependabotAlert, "severity" | "package" | "ecosystem" | "fixedVersion">>, dueDate: string | null, overdueDays: number | null = null): string {
  const severities = [...new Set(alerts.map((a) => a.severity))].sort((a, b) => DEPENDABOT_SEVERITIES.indexOf(a) - DEPENDABOT_SEVERITIES.indexOf(b));
  const packages = [...new Set(alerts.map((a) => a.package))];
  const ecosystems = [...new Set(alerts.map((a) => a.ecosystem))];
  const fixes = alerts.filter((a) => a.fixedVersion !== null).length;
  const fix = fixes === 0 ? "no fixed version" : fixes === alerts.length ? "fix available" : `fix for ${fixes} of ${alerts.length}`;
  const overdue = overdueDays === null ? "" : ` Overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}.`;
  return `Adopt ${ticketKey}? ${severities.join("/")} Dependabot alert${alerts.length === 1 ? "" : `s (${alerts.length})`} on ${repo}: ${packages.join(", ")} (${ecosystems.join(", ")}), ${fix}${dueDate === null ? "" : `, due ${dueDate}`}.${overdue}`;
}

/** What each choice means, for the item's `how` and the steward's wake. */
export function adoptionHow(dismissAllowed: boolean): string {
  const parts = [
    `${ADOPTION_CHOICES.adopt}: the ticket is labelled and moved to Todo, and a ticket steward builds the upgrade.`,
    `${ADOPTION_CHOICES.keep}: the ticket stays open and unadopted; the steward moves its due date out, and the plugin asks again when that date arrives.`,
  ];
  if (dismissAllowed) parts.push(`${ADOPTION_CHOICES.dismiss}: the ticket's alerts are dismissed on GitHub as "vulnerable code is not actually used" and the ticket is closed with the reason.`);
  return parts.join(" ");
}

/** Whether the decision's due date (the computed deadline, or a snooze) has passed in the project's time zone. */
export function overdue(dueAt: number, now: number, timeZone: string): boolean {
  return dueDate(now, timeZone) > dueDate(dueAt, timeZone);
}

/** How the one overdue reminder reads: the days past the due date, in the project's time zone. */
export function reminderText(ticketKey: string, due: string, now: number, timeZone: string): string {
  const today = dueDate(now, timeZone);
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
  return `${ticketKey} is ${days === 1 ? "a day" : `${days} days`} past its due date (${due}) and still unadopted.`;
}

/** The repo a fingerprint names: "owner/repo#4" → "owner/repo". */
export const repoOfFingerprint = (fingerprint: string): string | null => {
  const i = fingerprint.lastIndexOf("#");
  return i <= 0 ? null : fingerprint.slice(0, i);
};
