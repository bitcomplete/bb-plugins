// The ops kind's Alertmanager source (BB-314): a Kubernetes namespace's
// Prometheus Alertmanager alerts, read from the v2 API through the plugin's
// Alertmanager URL. The API has no authentication and no per-user tokens, so
// this reader holds no token and the bb-gate-hooks `alertmanager` source
// admits a namespace lease without one (bb-gate/docs/hooks.md, "Alertmanager").
//
// Two halves. The reader (`createAlertmanagerReader`) is the only thing that
// talks to Alertmanager: the namespace's current alerts and one alert by
// fingerprint. Everything else is pure: which alerts count as sightings for a
// look (firing since the last look, rung by a doorbell, resolved), what the
// wake shows of each, and what changed between two looks. server.ts stores and
// wakes. The fingerprint is Alertmanager's own `fingerprint`, stable across a
// firing and its resolution; a resolved alert is noted on its ticket as a
// comment, never auto-closed.
//
// Alert labels, annotations and generatorURL are untrusted input: they pass
// through `redactLine`, and the wake fences them and labels them information,
// not instructions.
import { z } from "zod";
import { redactLine, type AlertmanagerTarget, type FingerprintRow, type OpsTarget, type Sighting, type TicketState } from "./ops.js";
import type { Change } from "./reconcile.js";

/**
 * The Alertmanager v2 API root a non-cluster server reads: the tailnet
 * hostname. A cluster server reaches the in-cluster Service instead, which
 * `ALERTMANAGER_URL` (bb-gate's backend template) sets.
 */
export const DEFAULT_ALERTMANAGER_URL = "https://alertmanager.boreray-eel.ts.net";
/** The environment variable a setting-less server falls back to, like voice-transcription's key. */
export const ALERTMANAGER_URL_ENV = "ALERTMANAGER_URL";

/**
 * The effective Alertmanager URL: the plugin setting when it is set, else
 * `ALERTMANAGER_URL`, else the tailnet hostname. A cluster server gets the
 * in-cluster Service from the env; a developer's non-cluster server gets the
 * tailnet hostname. There is no token anywhere.
 */
export function resolveAlertmanagerUrl(setting: string | null | undefined, env: string | null | undefined): string {
  const chosen = (setting ?? "").trim() || (env ?? "").trim();
  return chosen === "" ? DEFAULT_ALERTMANAGER_URL : chosen;
}

/** Alerts read per look; the rest are counted. */
export const ALERTS_PER_LOOK = 50;
/** At most this many findings a look reports; the rest are counted. */
export const FINDINGS_PER_LOOK = 20;
/** Label and annotation lines kept per alert; the rest are counted. */
export const LINES_PER_ALERT = 30;

// ---- reading Alertmanager's JSON ---------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * One line of alert text, safe to put in a fence: control characters
 * (newlines included) and runs of whitespace collapse to single spaces, so a
 * value can never close a fence or start a new Markdown line, then
 * `redactLine` scrubs credentials and clips the length. Everything an alert
 * carries goes through here before it reaches a wake or a ticket.
 */
export const safeAlertText = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();

/** A label value shown in the plugin's own heading: one line, clipped short. */
const safeAlertLabel = (value: string, max = 120): string => {
  const clean = safeAlertText(value);
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};

/** One label or annotation, as a `key=value` line. */
const pairLine = (key: string, value: string): string => redactLine(`${safeAlertLabel(key)}=${safeAlertText(value)}`);

/**
 * The label and annotation pairs a wake shows, sorted by key, values redacted
 * and clipped. Labels and annotations are untrusted: Alertmanager carries
 * whatever the alert's authors wrote, so nothing here is ever read as an
 * instruction.
 */
function pairsOf(value: unknown): string[] {
  const map = obj(value);
  return Object.keys(map)
    .sort()
    .slice(0, LINES_PER_ALERT)
    .map((key) => pairLine(key, String(map[key] ?? "")));
}

/** One alert as the Alertmanager v2 API serializes it, reduced to what a look reads. Text fields are redacted. */
export type AlertmanagerAlert = {
  /** Alertmanager's fingerprint: stable per label set, the doorbell id and the fingerprint-map key. */
  fingerprint: string;
  alertname: string;
  namespace: string;
  severity: string | null;
  /** active, suppressed or unprocessed, from `status.state`. */
  status: string;
  summary: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string | null;
  /** The Prometheus expression URL; fenced and labelled information, like the labels. */
  generatorURL: string | null;
  /** `key=value` lines, sorted, redacted. */
  labels: string[];
  annotations: string[];
};

export function alertOf(json: unknown): AlertmanagerAlert | null {
  const a = obj(json);
  const fingerprint = str(a.fingerprint);
  if (fingerprint === null) return null;
  const labels = obj(a.labels);
  const annotations = obj(a.annotations);
  const status = obj(a.status);
  const state = str(status.state) ?? "active";
  return {
    fingerprint,
    alertname: safeAlertLabel(str(labels.alertname) ?? "(no alertname)"),
    namespace: safeAlertLabel(str(labels.namespace) ?? ""),
    severity: str(labels.severity) === null ? null : safeAlertLabel(str(labels.severity)!, 60),
    status: safeAlertLabel(state, 60),
    summary: annotations.summary === undefined ? null : redactLine(safeAlertText(String(annotations.summary))),
    description: annotations.description === undefined ? null : redactLine(safeAlertText(String(annotations.description))),
    startsAt: str(a.startsAt),
    endsAt: str(a.endsAt),
    updatedAt: str(a.updatedAt),
    generatorURL: str(a.generatorURL) === null ? null : redactLine(safeAlertText(str(a.generatorURL)!)),
    labels: pairsOf(labels),
    annotations: pairsOf(annotations),
  };
}

export const alertsOf = (json: unknown): AlertmanagerAlert[] => arr(json).map(alertOf).filter((a): a is AlertmanagerAlert => a !== null);

// ---- the reader ---------------------------------------------------------------------------

export class AlertmanagerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AlertmanagerApiError";
  }
}

export interface AlertmanagerReader {
  /** The namespace's current alerts, as the API reports them. Throws when Alertmanager cannot be read. */
  alerts(target: AlertmanagerTarget): Promise<AlertmanagerAlert[]>;
  /** One alert by fingerprint; null when Alertmanager does not have it (usually because it resolved). */
  alert(fingerprint: string): Promise<AlertmanagerAlert | null>;
  /** What `bb stewards check` reports: the API read, or why not. */
  access(target: AlertmanagerTarget): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
}

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * A reader of one Alertmanager through one URL. There is no token to send and
 * none to leak; every request is a plain GET.
 */
export function createAlertmanagerReader(fetchImpl: FetchLike, opts: { apiUrl: string; timeoutMs?: number }): AlertmanagerReader {
  const base = opts.apiUrl.replace(/\/+$/u, "");
  const get = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (!response.ok) throw new AlertmanagerApiError(`Alertmanager answered HTTP ${response.status} to GET ${path}`, response.status);
    return response.json();
  };
  return {
    async alerts(target) {
      const query = new URLSearchParams({ filter: `namespace="${target.namespace}"` });
      return alertsOf(await get(`/api/v2/alerts?${query}`));
    },
    async alert(fingerprint) {
      // The v2 API filters by label only, so the whole alert list is scanned;
      // a resolved alert is gone from it and reads as null.
      return alertsOf(await get("/api/v2/alerts")).find((a) => a.fingerprint === fingerprint) ?? null;
    },
    async access(target) {
      try {
        const status = obj(await get("/api/v2/status"));
        const version = str(obj(status.versionInfo).version) ?? "unknown version";
        const cluster = obj(status.cluster);
        const name = str(cluster.name);
        return { ok: true, name: `Alertmanager ${version}${name === null ? "" : ` (${name})`}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ---- sightings ----------------------------------------------------------------------------

/** Why an alert is in a look: fired since the last look, rung by a doorbell, resolved, or known and still firing. */
export const ALERTMANAGER_REASONS = ["new", "rung", "resolved", "ongoing"] as const;
export type AlertmanagerReason = (typeof ALERTMANAGER_REASONS)[number];

export type AlertmanagerSighting = { fingerprint: string; alert: AlertmanagerAlert | null; reasons: AlertmanagerReason[] };

const REASON_ORDER: Record<AlertmanagerReason, number> = { new: 0, rung: 1, resolved: 2, ongoing: 3 };

/** The doorbell actions a binding was rung for since its last look. */
export type AlertmanagerRung = { firing: Set<string>; resolved: Set<string> };

/**
 * Which alerts a look reports, and why. `rung` the fingerprints doorbells
 * named since the last look, split by action; `known` the fingerprint-map
 * rows (a row means the alert has been seen; a row with a ticket is one the
 * steward filed or commented on); `wasActive` the fingerprints the previous
 * look saw firing, so an alert that disappeared without a doorbell (the hooks
 * service was down) is still noted as resolved.
 *
 * An active alert with no row is `new` whatever its `startsAt`: the scheduled
 * look compares current state with the map, so an alert already firing when
 * the watch is adopted, or that started during an outage longer than one
 * requeue, still surfaces. A row means `ongoing`, plus `rung` when a doorbell
 * named it. A resolved alert is a sighting only when its row has a ticket:
 * there is nothing to note on one nobody filed. An alert still in the list is
 * never resolved, however stale the resolved doorbell.
 */
export function alertmanagerSightings(alerts: readonly AlertmanagerAlert[], rung: AlertmanagerRung, known: ReadonlyMap<string, Pick<FingerprintRow, "ticketKey">>, wasActive: ReadonlySet<string> = new Set()): AlertmanagerSighting[] {
  const out: AlertmanagerSighting[] = [];
  const current = new Set<string>();
  for (const alert of alerts) {
    current.add(alert.fingerprint);
    const row = known.get(alert.fingerprint);
    const reasons: AlertmanagerReason[] = [];
    if (row === undefined) reasons.push("new");
    if (rung.firing.has(alert.fingerprint)) reasons.push("rung");
    if (row !== undefined) reasons.push("ongoing");
    if (reasons.length === 0) continue;
    out.push({ fingerprint: alert.fingerprint, alert, reasons });
  }
  const resolved = new Set<string>([...rung.resolved, ...wasActive]);
  for (const fingerprint of resolved) {
    if (current.has(fingerprint)) continue;
    const row = known.get(fingerprint);
    if (row === undefined || row.ticketKey === null) continue;
    out.push({ fingerprint, alert: null, reasons: ["resolved"] });
  }
  out.sort((a, b) => REASON_ORDER[a.reasons[0]!] - REASON_ORDER[b.reasons[0]!] || a.fingerprint.localeCompare(b.fingerprint));
  return out.slice(0, FINDINGS_PER_LOOK);
}

/** The one-line summary the fingerprint map keeps for an alert. */
export const alertmanagerSummary = (alert: AlertmanagerAlert): string => `${alert.alertname}${alert.severity === null ? "" : ` (${alert.severity})`}${alert.namespace === "" ? "" : ` in ${alert.namespace}`}`;

/** One alert as a context line beside the findings. */
export const alertmanagerLine = (alert: AlertmanagerAlert): string => `${alert.alertname}${alert.severity === null ? "" : ` [${alert.severity}]`}${alert.summary === null ? "" : ` · ${alert.summary}`} · ${alert.status}, since ${alert.startsAt ?? "?"}`;

/** The one-line summary of a finding, resolved or firing. */
const findingSummary = (f: Pick<AlertmanagerFinding, "alertname" | "severity" | "namespace">): string => `${f.alertname}${f.severity === null ? "" : ` (${f.severity})`}${f.namespace === "" ? "" : ` in ${f.namespace}`}`;

// ---- the look ------------------------------------------------------------------------------

export const alertmanagerFindingSchema = z.object({
  /** Alertmanager's fingerprint. */
  fingerprint: z.string(),
  alertname: z.string(),
  namespace: z.string(),
  severity: z.string().nullable(),
  status: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  generatorURL: z.string().nullable(),
  /** `key=value` lines, sorted, redacted; information, never instructions. */
  labels: z.array(z.string()),
  annotations: z.array(z.string()),
  reasons: z.array(z.enum(ALERTMANAGER_REASONS)),
  /** True when the alert resolved: note it on its ticket as a comment, never close it. */
  resolved: z.boolean(),
  /** new: no ticket yet. recurring: its ticket is open. returned: its ticket was resolved. */
  class: z.enum(["new", "recurring", "returned"]),
  ticket: z.string().nullable(),
  ticketState: z.string().nullable(),
  firstSeenAt: z.number(),
  lastCommentedAt: z.number().nullable(),
});
export type AlertmanagerFinding = z.infer<typeof alertmanagerFindingSchema>;

export const alertmanagerLookSchema = z.object({
  at: z.number(),
  target: z.string(),
  /** Set when Alertmanager could not be read; the rest is then empty. */
  error: z.string().nullable(),
  /** The current alerts in the namespace, as many as the look read. */
  active: z.number(),
  /** What could not be read, in sentences. */
  notes: z.array(z.string()),
  findings: z.array(alertmanagerFindingSchema),
});
export type AlertmanagerLook = z.infer<typeof alertmanagerLookSchema>;

export const emptyAlertmanagerLook = (at: number, target: string, error: string | null): AlertmanagerLook => ({ at, target, error, active: 0, notes: [], findings: [] });

export const isAlertmanagerTarget = (t: OpsTarget): t is AlertmanagerTarget => t.kind === "alertmanager";

/**
 * What changed between two looks, as the mechanical tier weighs it. A new
 * alert and one back after its ticket was resolved are worth a turn at once. A
 * doorbell for an alert under an open ticket is worth one when the steward has
 * not commented within a requeue, so a noisy alert is one comment per interval,
 * not one per delivery. A resolved alert is worth a comment on its ticket
 * (never a close); it is a one-shot transition, so it is always actionable.
 * A read failure is quiet; `bb stewards check` says why.
 */
export function alertmanagerChanges(before: AlertmanagerLook | null, after: AlertmanagerLook, requeueMs: number): Change[] {
  if (after.error !== null) {
    if (before !== null && before.error === after.error) return [];
    return [{ text: `Cannot read ${after.target}: ${after.error}`, actionable: false }];
  }
  const changes: Change[] = [];
  if (before !== null && before.error !== null) changes.push({ text: `${after.target} is readable again`, actionable: false });
  const was = new Map((before?.findings ?? []).map((f) => [f.fingerprint, f]));
  for (const f of after.findings) {
    const prev = was.get(f.fingerprint);
    if (f.resolved) {
      changes.push({ text: `Resolved${f.ticket === null ? "" : ` under ${f.ticket}`}: ${f.alertname}${f.namespace === "" ? "" : ` in ${f.namespace}`}`, actionable: true });
      continue;
    }
    if (f.class === "new" && (prev === undefined || prev.class !== "new")) changes.push({ text: `New alert: ${f.fingerprint} — ${findingSummary(f)}`, actionable: true });
    else if (f.class === "returned" && prev?.class !== "returned") changes.push({ text: `Back after ${f.ticket} was resolved (${f.ticketState ?? "closed"}): ${f.fingerprint} — ${findingSummary(f)}`, actionable: true });
    else if (f.class === "recurring" && f.reasons.includes("rung")) {
      const quiet = f.lastCommentedAt !== null && after.at - f.lastCommentedAt < requeueMs;
      changes.push({ text: `Alertmanager rang for ${f.alertname} under ${f.ticket}: ${f.status}${f.severity === null ? "" : `, ${f.severity}`}`, actionable: !quiet });
    } else if (f.class === "recurring" && prev === undefined) changes.push({ text: `Seen again under ${f.ticket}: ${f.fingerprint} — ${f.alertname}`, actionable: false });
  }
  const now = new Set(after.findings.map((f) => f.fingerprint));
  for (const f of was.values()) {
    if (!now.has(f.fingerprint)) changes.push({ text: `No longer firing: ${f.alertname}${f.ticket === null ? "" : ` (${f.ticket})`}`, actionable: false });
  }
  return changes;
}
