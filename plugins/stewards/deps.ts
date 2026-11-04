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

/** A Linear due date (YYYY-MM-DD) as an instant on that calendar day: noon UTC, which is that date in every time zone between UTC-12 and UTC+11. */
export function dueDateToMs(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
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
  /** The SLA deadline, from the severity and the alert's own created_at (`alertClockAt`). */
  dueAt: z.number(),
  /** The ticket's due date as Linear has it (YYYY-MM-DD), the source of truth once a ticket exists; null when none or unreadable. */
  ticketDueDate: z.string().nullable().default(null),
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
 * The choices offered on an adoption decision. With a fix available, adopting
 * (a worker makes the upgrade) leads; with no patched version for any alert,
 * "Recommend adopting" does not fit and dismissing the alerts as unused leads,
 * since adopting could only produce a decision anyway.
 */
export function adoptionChoices(hasFix: boolean): string[] {
  return hasFix ? [ADOPTION_CHOICES.adopt, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.dismiss] : [ADOPTION_CHOICES.dismiss, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.adopt];
}

/** The one line a decision item asks. */
export function adoptionQuestion(ticketKey: string, repo: string, alerts: ReadonlyArray<Pick<DependabotAlert, "severity" | "package" | "ecosystem" | "fixedVersion">>, dueDate: string | null): string {
  const severities = [...new Set(alerts.map((a) => a.severity))].sort((a, b) => DEPENDABOT_SEVERITIES.indexOf(a) - DEPENDABOT_SEVERITIES.indexOf(b));
  const packages = [...new Set(alerts.map((a) => a.package))];
  const ecosystems = [...new Set(alerts.map((a) => a.ecosystem))];
  const fixes = alerts.filter((a) => a.fixedVersion !== null).length;
  const fix = fixes === 0 ? "no fixed version" : fixes === alerts.length ? "fix available" : `fix for ${fixes} of ${alerts.length}`;
  return `Adopt ${ticketKey}? ${severities.join("/")} Dependabot alert${alerts.length === 1 ? "" : `s (${alerts.length})`} on ${repo}: ${packages.join(", ")} (${ecosystems.join(", ")}), ${fix}${dueDate === null ? "" : `, due ${dueDate}`}.`;
}

/** What each choice means, for the item's `how` and the steward's wake. */
export const ADOPTION_HOW =
  `${ADOPTION_CHOICES.adopt}: the ticket is labelled and moved to Todo, and a ticket steward builds the upgrade. ` +
  `${ADOPTION_CHOICES.dismiss}: the alerts are dismissed on GitHub as "vulnerable code is not actually used" and the ticket is closed with the reason. ` +
  `${ADOPTION_CHOICES.keep}: the ticket stays open and unadopted; say the new due date in the note, or it moves out by one SLA window.`;

/** The reminder stages an unanswered decision goes through, in order. */
export const REMINDER_STAGES = ["half", "eve", "overdue"] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

/**
 * The next reminder an unanswered decision is due, or null: `half` once half
 * the time from raising to the due date has passed, `eve` from the day before
 * the due date, `overdue` once the due date (in the project's time zone) has
 * gone by. A stage already sent is skipped; a later stage supersedes an
 * earlier one not yet sent, so a decision raised the day before its due date
 * gets one reminder, not three.
 */
export function reminderDue(raisedAt: number, dueAt: number, reminded: readonly string[], now: number, timeZone: string): ReminderStage | null {
  const today = dueDate(now, timeZone);
  const due = dueDate(dueAt, timeZone);
  let stage: ReminderStage | null = null;
  if (today > due) stage = "overdue";
  else if (dueDate(now + 86_400_000, timeZone) >= due) stage = "eve";
  else if (now >= raisedAt + (dueAt - raisedAt) / 2) stage = "half";
  if (stage === null) return null;
  // Everything up to and including the stage due now counts as sent once it is.
  const sent = new Set(reminded);
  return sent.has(stage) || REMINDER_STAGES.slice(REMINDER_STAGES.indexOf(stage) + 1).some((s) => sent.has(s)) ? null : stage;
}

/** How a reminder reads: the days to or past the due date, in the project's time zone. */
export function reminderText(stage: ReminderStage, ticketKey: string, due: string, now: number, timeZone: string): string {
  const today = dueDate(now, timeZone);
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
  if (stage === "overdue") return `${ticketKey} is ${days === 1 ? "a day" : `${days} days`} past its due date (${due}) and still unadopted.`;
  if (stage === "eve") return `${ticketKey} is due ${days === 0 ? "today" : "tomorrow"} (${due}) and still unadopted.`;
  return `${ticketKey} is halfway to its due date (${due}) and still unadopted.`;
}

/** The repo a fingerprint names: "owner/repo#4" → "owner/repo". */
export const repoOfFingerprint = (fingerprint: string): string | null => {
  const i = fingerprint.lastIndexOf("#");
  return i <= 0 ? null : fingerprint.slice(0, i);
};
