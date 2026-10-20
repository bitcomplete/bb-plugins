// The ops kind's Sentry source: a Sentry project read with the plugin's own
// Sentry token (a secret setting), turned into sightings an ops steward
// files tickets for. The issue id Sentry assigns is the fingerprint: it is
// what a doorbell from bb-gate-hooks carries, what the Sentry API is keyed
// on, and stable across events, so one issue is one ticket however often it
// fires.
//
// Two halves. The reader (`createSentryReader`) is the only thing that talks
// to Sentry: the project's unresolved issues, one issue by id, and the
// latest event of an issue (its stack trace). Everything else is pure:
// which issues count as sightings for a look, what the wake shows of each
// (with credentials redacted as the kubectl look's logs are), and what
// changed between two looks. server.ts stores and wakes.
import { z } from "zod";
import { redactLine, type OpsTarget, type SentryTarget } from "./ops.js";
import type { Change } from "./reconcile.js";

export const SENTRY_API_URL = "https://sentry.io";
/** The look's error when the plugin has no Sentry token to read with; the steward files the provide-secret need for it. */
export const NO_TOKEN = "no Sentry token is configured";
/** The setting the token lives in, named so the steward's provide-secret need says where it goes. */
export const TOKEN_SETTING = "sentryToken";
/** Where a Sentry user creates an auth token. */
export const TOKEN_PAGE = "https://sentry.io/settings/account/api/auth-tokens/";
/** The scopes the token needs: read the project (admission, the list) and its events (stack traces). */
export const TOKEN_SCOPES = ["project:read", "event:read"] as const;

/** Unresolved issues read per look, newest activity first. */
export const ISSUES_PER_LOOK = 50;
/** Stack traces are fetched for at most this many findings per look. */
export const EVENTS_PER_LOOK = 5;
/** At most this many findings a look reports; the rest are counted. */
export const FINDINGS_PER_LOOK = 20;
/** Frames kept per exception, innermost last. */
export const FRAMES_PER_EXCEPTION = 25;
/** Lines of stack trace kept in all. */
export const STACK_LINES = 80;
/** Unresolved issues listed for context beside the findings. */
export const RECENT_PER_LOOK = 10;

// ---- reading Sentry's JSON ---------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/u.test(v)) return Number(v);
  return null;
};

/** One issue as the Sentry API serializes it, reduced to what a look reads. Text fields are redacted. */
export type SentryIssue = {
  /** Sentry's issue id, a string of digits: the fingerprint and the doorbell id. */
  id: string;
  /** The human one, "WEB-12". */
  shortId: string;
  title: string;
  culprit: string | null;
  permalink: string | null;
  level: string | null;
  /** unresolved, resolved, ignored. */
  status: string;
  /** new, regressed, ongoing, escalating, archived_until_escalating, ... ; null on older servers. */
  substatus: string | null;
  /** Lifetime events, as Sentry counts them. */
  count: number;
  userCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** The project slug Sentry reports, which is what doorbells carry as the unit. */
  project: string | null;
};

export function issueOf(json: unknown): SentryIssue | null {
  const issue = obj(json);
  const id = str(issue.id) ?? (num(issue.id) === null ? null : String(num(issue.id)));
  if (id === null) return null;
  return {
    id,
    shortId: str(issue.shortId) ?? id,
    title: redactLine(str(issue.title) ?? "(untitled)"),
    culprit: str(issue.culprit) === null ? null : redactLine(str(issue.culprit)!),
    permalink: str(issue.permalink),
    level: str(issue.level),
    status: str(issue.status) ?? "unresolved",
    substatus: str(issue.substatus),
    count: num(issue.count) ?? 0,
    userCount: num(issue.userCount) ?? 0,
    firstSeen: str(issue.firstSeen),
    lastSeen: str(issue.lastSeen),
    project: str(obj(issue.project).slug),
  };
}

export const issuesOf = (json: unknown): SentryIssue[] => arr(json).map(issueOf).filter((i): i is SentryIssue => i !== null);

/** The latest event of an issue, as the wake shows it: when, what it said, and its stack trace. */
export type SentryEvent = { id: string | null; at: string | null; message: string | null; stack: string[] };

/**
 * An event's stack trace as lines: each exception value as a header, then
 * its frames innermost last, in-app frames marked with `*` and shown with
 * their source line when the event carries it. A message event with no
 * exception gives its message. Everything is redacted and clipped: it goes
 * into a Linear ticket.
 */
export function stackTraceOf(event: unknown): string[] {
  const e = obj(event);
  const lines: string[] = [];
  for (const entry of arr(e.entries).map(obj)) {
    if (entry.type !== "exception") continue;
    for (const value of arr(obj(entry.data).values).map(obj)) {
      const type = str(value.type) ?? "Error";
      const message = str(value.value);
      lines.push(redactLine(message === null ? type : `${type}: ${message}`));
      const frames = arr(obj(value.stacktrace).frames).map(obj).slice(-FRAMES_PER_EXCEPTION);
      for (const f of frames) {
        const where = str(f.filename) ?? str(f.module) ?? str(f.absPath) ?? "?";
        const line = num(f.lineNo);
        const inApp = f.inApp === true;
        lines.push(redactLine(`  ${inApp ? "*" : " "} ${where}${line === null ? "" : `:${line}`} in ${str(f.function) ?? "?"}`));
        if (inApp) {
          const context = arr(f.context).map(arr).find((c) => num(c[0]) === line);
          const source = context === undefined ? null : str(context[1]);
          if (source !== null && source.trim() !== "") lines.push(redactLine(`      ${source.trim()}`));
        }
      }
    }
  }
  if (lines.length === 0) {
    const message = arr(e.entries).map(obj).find((entry) => entry.type === "message");
    const formatted = message === undefined ? null : (str(obj(message.data).formatted) ?? str(obj(message.data).message));
    if (formatted !== null) lines.push(redactLine(formatted));
  }
  return lines.slice(0, STACK_LINES);
}

export function eventOf(json: unknown): SentryEvent {
  const e = obj(json);
  const message = str(e.message) ?? str(e.title);
  return { id: str(e.eventID) ?? str(e.id), at: str(e.dateCreated), message: message === null ? null : redactLine(message), stack: stackTraceOf(json) };
}

// ---- the reader ---------------------------------------------------------------------------

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SentryApiError";
  }
}

export interface SentryReader {
  /** The project's unresolved issues, most recent activity first. Throws when the project cannot be read. */
  issues(target: SentryTarget): Promise<SentryIssue[]>;
  /** One issue by id; null when Sentry does not have it (or will not show it). */
  issue(id: string): Promise<SentryIssue | null>;
  /** The latest event of an issue; null when there is none to read. */
  latestEvent(id: string): Promise<SentryEvent | null>;
  /** What `bb stewards check` reports: the project read with the token, or why not. */
  access(target: SentryTarget): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
}

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * A reader of one server's Sentry, through one token. The token goes into
 * one request header and nowhere else: not a log line, not an error.
 */
export function createSentryReader(fetchImpl: FetchLike, opts: { apiUrl: string; token: () => Promise<string | null>; timeoutMs?: number }): SentryReader {
  const base = opts.apiUrl.replace(/\/+$/u, "");
  const get = async (path: string): Promise<unknown> => {
    const token = (await opts.token())?.trim() ?? "";
    if (token === "") throw new SentryApiError(NO_TOKEN, 0);
    const response = await fetchImpl(`${base}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (response.status === 401) throw new SentryApiError("Sentry refused the token (401): it is wrong, revoked or lacks a scope", 401);
    if (!response.ok) throw new SentryApiError(`Sentry answered HTTP ${response.status} to GET ${path}`, response.status);
    return response.json();
  };
  const notFound = (error: unknown) => error instanceof SentryApiError && (error.status === 404 || error.status === 403);
  const projectPath = (t: SentryTarget) => `/api/0/projects/${encodeURIComponent(t.org)}/${encodeURIComponent(t.project)}/`;
  return {
    async issues(target) {
      const query = new URLSearchParams({ query: "is:unresolved", sort: "date", limit: String(ISSUES_PER_LOOK), statsPeriod: "" });
      return issuesOf(await get(`${projectPath(target)}issues/?${query}`));
    },
    async issue(id) {
      try {
        return issueOf(await get(`/api/0/issues/${encodeURIComponent(id)}/`));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async latestEvent(id) {
      try {
        return eventOf(await get(`/api/0/issues/${encodeURIComponent(id)}/events/latest/`));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async access(target) {
      try {
        const project = obj(await get(projectPath(target)));
        return { ok: true, name: str(project.name) ?? str(project.slug) ?? target.project };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ---- sightings ----------------------------------------------------------------------------

/** Why an issue is in a look: first seen since the last look, regressed or escalating in Sentry, rung by a doorbell, or known and still firing. */
export const SENTRY_REASONS = ["new", "regressed", "rung", "ongoing"] as const;
export type SentryReason = (typeof SENTRY_REASONS)[number];

export type SentrySighting = { fingerprint: string; issue: SentryIssue; reasons: SentryReason[] };

const REGRESSED = new Set(["regressed", "escalating"]);
const REASON_ORDER: Record<SentryReason, number> = { regressed: 0, new: 1, rung: 2, ongoing: 3 };

/**
 * Which issues a look reports, and why. `since` is the last look; `rung`
 * the issue ids doorbells named since it; `known` the fingerprints already
 * in the map (a known issue still firing is a sighting, so its ticket gets
 * the comment the playbook asks for). An issue Sentry has resolved is not a
 * sighting even when rung: its disappearance is what the look says of it.
 */
export function sentrySightings(issues: readonly SentryIssue[], at: { since: number }, rung: ReadonlySet<string>, known: ReadonlySet<string>): SentrySighting[] {
  const out: SentrySighting[] = [];
  const seenAfter = (iso: string | null) => iso !== null && Date.parse(iso) >= at.since;
  for (const issue of issues) {
    if (issue.status !== "unresolved") continue;
    const reasons: SentryReason[] = [];
    if (issue.substatus !== null && REGRESSED.has(issue.substatus) && seenAfter(issue.lastSeen)) reasons.push("regressed");
    if (seenAfter(issue.firstSeen)) reasons.push("new");
    if (rung.has(issue.id)) reasons.push("rung");
    if (known.has(issue.id) && seenAfter(issue.lastSeen) && !reasons.includes("new")) reasons.push("ongoing");
    if (reasons.length === 0) continue;
    out.push({ fingerprint: issue.id, issue, reasons });
  }
  out.sort((a, b) => REASON_ORDER[a.reasons[0]!] - REASON_ORDER[b.reasons[0]!] || (b.issue.lastSeen ?? "").localeCompare(a.issue.lastSeen ?? ""));
  return out.slice(0, FINDINGS_PER_LOOK);
}

/**
 * Whether an issue belongs to this organization, as far as its permalink
 * says: `https://<org>.sentry.io/issues/<id>/` on sentry.io, and
 * `/organizations/<org>/issues/<id>/` on a self-hosted server. The issue
 * JSON names its project by slug only, and a slug is unique only within an
 * organization, so a rung issue read by id is checked here before it joins
 * a look; an issue with no permalink is taken as the target's.
 */
export function issueInOrg(issue: Pick<SentryIssue, "permalink">, org: string): boolean {
  if (issue.permalink === null) return true;
  try {
    const url = new URL(issue.permalink);
    return url.hostname.toLowerCase().startsWith(`${org}.`) || url.pathname.toLowerCase().includes(`/organizations/${org}/`);
  } catch {
    return true;
  }
}

/** The one-line summary the fingerprint map keeps for an issue. */
export const sentrySummary = (issue: SentryIssue): string => `${issue.shortId}: ${issue.title}${issue.culprit === null ? "" : ` (${issue.culprit})`}`;

/** One unresolved issue as a context line beside the findings. */
export const recentLine = (issue: SentryIssue): string => `${issue.shortId} · ${issue.title}${issue.culprit === null ? "" : ` · ${issue.culprit}`} · ${issue.count} event${issue.count === 1 ? "" : "s"}, last ${issue.lastSeen ?? "?"}`;

// ---- the look ------------------------------------------------------------------------------

export const sentryFindingSchema = z.object({
  /** The Sentry issue id. */
  fingerprint: z.string(),
  shortId: z.string(),
  title: z.string(),
  culprit: z.string().nullable(),
  permalink: z.string().nullable(),
  level: z.string().nullable(),
  substatus: z.string().nullable(),
  count: z.number(),
  userCount: z.number(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  reasons: z.array(z.enum(SENTRY_REASONS)),
  /** The latest event, when it was read; null when it was not (the cap, or Sentry had none). */
  event: z.object({ id: z.string().nullable(), at: z.string().nullable(), message: z.string().nullable(), stack: z.array(z.string()) }).nullable(),
  /** new: no ticket yet. recurring: its ticket is open. returned: its ticket was resolved and it is back. */
  class: z.enum(["new", "recurring", "returned"]),
  ticket: z.string().nullable(),
  ticketState: z.string().nullable(),
  firstSeenAt: z.number(),
  lastCommentedAt: z.number().nullable(),
});
export type SentryFinding = z.infer<typeof sentryFindingSchema>;

export const sentryLookSchema = z.object({
  at: z.number(),
  target: z.string(),
  /** Set when the project could not be read; the rest is then empty. NO_TOKEN when there is no token to read with. */
  error: z.string().nullable(),
  /** Unresolved issues in the project, as many as the look read. */
  unresolved: z.number(),
  /** The most recently active unresolved issues the findings do not cover, as lines. */
  recent: z.array(z.string()),
  /** What could not be read, in sentences: an event, a rung issue. */
  notes: z.array(z.string()),
  findings: z.array(sentryFindingSchema),
});
export type SentryLook = z.infer<typeof sentryLookSchema>;

export const emptySentryLook = (at: number, target: string, error: string | null): SentryLook => ({ at, target, error, unresolved: 0, recent: [], notes: [], findings: [] });

export const isSentryTarget = (t: OpsTarget): t is SentryTarget => t.kind === "sentry-project";

const line = (f: SentryFinding) => `${f.shortId} ${f.title}${f.permalink === null ? "" : ` (${f.permalink})`}`;

/**
 * What changed between two looks, as the mechanical tier weighs it. A new
 * issue, one back after its ticket was resolved, and one Sentry says has
 * regressed are worth a turn at once. A doorbell for an issue under an open
 * ticket is worth one when the steward has not commented within a requeue,
 * so a noisy issue is one comment per interval, not one per event. A look
 * that cannot read Sentry for want of a token is worth a turn once, so the
 * steward can file the need for it; any other read failure is quiet, and
 * `bb stewards check` says why.
 */
export function sentryChanges(before: SentryLook | null, after: SentryLook, requeueMs: number): Change[] {
  if (after.error !== null) {
    if (before !== null && before.error === after.error) return [];
    return [{ text: `Cannot read ${after.target}: ${after.error}`, actionable: after.error === NO_TOKEN }];
  }
  const changes: Change[] = [];
  if (before !== null && before.error !== null) changes.push({ text: `${after.target} is readable again`, actionable: false });
  const was = new Map((before?.findings ?? []).map((f) => [f.fingerprint, f]));
  for (const f of after.findings) {
    const prev = was.get(f.fingerprint);
    if (f.class === "new" && (prev === undefined || prev.class !== "new")) changes.push({ text: `New Sentry issue: ${line(f)}`, actionable: true });
    else if (f.class === "returned" && prev?.class !== "returned") changes.push({ text: `Back after ${f.ticket} was resolved (${f.ticketState ?? "closed"}): ${line(f)}`, actionable: true });
    else if (f.class === "recurring" && f.reasons.includes("regressed") && !(prev?.reasons.includes("regressed") ?? false)) changes.push({ text: `Regressed in Sentry under ${f.ticket}: ${line(f)}`, actionable: true });
    else if (f.class === "recurring" && f.reasons.includes("rung")) {
      const quiet = f.lastCommentedAt !== null && after.at - f.lastCommentedAt < requeueMs;
      changes.push({ text: `Sentry rang for ${f.shortId} under ${f.ticket}: ${f.count} event${f.count === 1 ? "" : "s"}, last ${f.lastSeen ?? "?"}`, actionable: !quiet });
    } else if (f.class === "recurring" && prev === undefined) changes.push({ text: `Seen again under ${f.ticket}: ${line(f)}`, actionable: false });
  }
  const now = new Set(after.findings.map((f) => f.fingerprint));
  for (const f of was.values()) {
    if (!now.has(f.fingerprint)) changes.push({ text: `No longer seen: ${f.shortId}${f.ticket === null ? "" : ` (${f.ticket})`}`, actionable: false });
  }
  return changes;
}
