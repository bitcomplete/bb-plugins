// The read-only triage reply under a failed Kubernetes Job alert (BB-419).
//
// A Job-failure Alertmanager alert says the workload stopped; this module turns
// it into one short threaded reply that answers **What failed?**, **Still
// affecting us?** and **Next step**, each finding linked to scoped evidence.
// It is pure apart from the three interfaces it is handed: an `EvidenceReader`
// (the separately scoped, enforced read-only identity; no cluster credential
// lives in this plugin), an `OccurrenceStore` (the once-only record) and a
// `ThreadReplier` (the one write — the Slack reply). All three are injected, so
// the whole flow is tested with fakes and the feature is off unless the caller
// passes `enabled: true`.
//
// Alert labels, annotations, Job and pod status, events and log lines are
// untrusted data. They pass through `redactLine`, are clipped to one line and
// are never read as instructions. Logs are linked rather than pasted; at most
// one redacted line identifies the failure.
import { redactLine, scrubCredentials, type OpsEvent, type OpsJob, type OpsPod } from "./ops.js";
import { alertmanagerOccurrenceKey, type AlertmanagerAlert } from "./alertmanager.js";

/** The three headings a triage reply uses, and no others. */
export const TRIAGE_HEADINGS = ["What failed?", "Still affecting us?", "Next step"] as const;
/** The reply's fixed length cap in characters. */
export const TRIAGE_REPLY_MAX_CHARS = 1800;
/** How many failed pods and log excerpts the reply names before it counts the rest. */
export const TRIAGE_PODS_NAMED = 3;
export const TRIAGE_LOGS_NAMED = 2;

/** The alert reduced to what a triage reply reads. Built with `triageAlertOf`. */
export type TriageAlert = Pick<AlertmanagerAlert, "fingerprint" | "alertname" | "namespace" | "jobName" | "startsAt" | "summary" | "generatorURL"> & {
  /** The reply dedupe key: fingerprint + exact Job + startsAt. */
  occurrenceKey: string;
};

/** The triage view of one Alertmanager alert, with its occurrence key derived. */
export const triageAlertOf = (alert: AlertmanagerAlert): TriageAlert => ({
  fingerprint: alert.fingerprint,
  alertname: alert.alertname,
  namespace: alert.namespace,
  jobName: alert.jobName,
  startsAt: alert.startsAt,
  summary: alert.summary,
  generatorURL: alert.generatorURL,
  occurrenceKey: alertmanagerOccurrenceKey(alert),
});

// ---- evidence, through a read-only identity ---------------------------------------------

/** A value from the reader, with a link to it in the pilot namespace. */
export type EvidenceItem<T> = { value: T; url: string | null };

/** The last lines of one container's log, with a link to it. */
export type LogEvidence = { pod: string; container: string; lines: string[]; url: string | null };

/**
 * What the triage reply reads. Every method reads only the pilot namespace and
 * only `get`/`list`/`pods/log`: no exec, no secrets, no writes. A missing
 * permission throws `EvidenceUnavailableError` and the reply labels the gap
 * rather than guessing. The interface is the seam the owner's separately
 * scoped read-only identity will implement; tests use fakes.
 */
export interface EvidenceReader {
  /** The exact Job, or null when it cannot be found. */
  job(namespace: string, jobName: string): Promise<EvidenceItem<OpsJob> | null>;
  /** The Job's pods. */
  pods(namespace: string, jobName: string): Promise<Array<EvidenceItem<OpsPod>>>;
  /** Warning events about the Job's pods, newest first. */
  events(namespace: string, jobName: string): Promise<OpsEvent[]>;
  /** The last lines of one container's log, or null when it could not be read. */
  logs(namespace: string, pod: string, container: string): Promise<LogEvidence | null>;
  /** The namespace's Jobs that succeeded at or after `since`, newest first. */
  recentSuccessfulJobs(namespace: string, since: string): Promise<Array<EvidenceItem<OpsJob>>>;
}

/** A read the identity could not make, or that a person must grant. */
export class EvidenceUnavailableError extends Error {
  constructor(
    readonly what: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceUnavailableError";
  }
}

/** Everything the reply may say, gathered once. `unavailable` is labelled gaps. */
export type TriageEvidence = {
  job: EvidenceItem<OpsJob> | null;
  pods: Array<EvidenceItem<OpsPod>>;
  events: OpsEvent[];
  logs: LogEvidence[];
  successfulJobs: Array<EvidenceItem<OpsJob>>;
  /** What could not be read, each a short sentence ending in a full stop. */
  unavailable: string[];
};

/** The empty evidence, for a call that never reached the reader. */
export const emptyTriageEvidence = (): TriageEvidence => ({ job: null, pods: [], events: [], logs: [], successfulJobs: [], unavailable: [] });

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Read everything a reply needs, tolerating a gap: a failed read is recorded in
 * `unavailable` and the rest of the reply still forms. A `logs` read that is
 * refused is labelled, not retried.
 */
export async function gatherTriageEvidence(reader: EvidenceReader, alert: TriageAlert, now: number): Promise<TriageEvidence> {
  const evidence = emptyTriageEvidence();
  if (alert.jobName === null) return evidence;
  const jobName = alert.jobName;
  const namespace = alert.namespace;
  const attempt = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      const reason = error instanceof EvidenceUnavailableError ? `${error.what}: ${error.message}` : errorText(error);
      evidence.unavailable.push(`${what} could not be read (${scrubCredentials(reason)}).`);
      return empty;
    }
  };

  evidence.job = await attempt("Job status", () => reader.job(namespace, jobName), null);
  evidence.pods = await attempt("pod status", () => reader.pods(namespace, jobName), []);
  evidence.events = await attempt("events", () => reader.events(namespace, jobName), []);
  for (const item of evidence.pods.filter((p) => !p.value.ready).slice(0, TRIAGE_LOGS_NAMED)) {
    const container = item.value.containers[0]?.name;
    if (container === undefined) continue;
    const log = await attempt(`logs for ${item.value.name}/${container}`, () => reader.logs(namespace, item.value.name, container), null);
    if (log !== null) evidence.logs.push(log);
  }
  const since = alert.startsAt ?? new Date(now - 86_400_000).toISOString();
  evidence.successfulJobs = await attempt("recent successful Jobs", () => reader.recentSuccessfulJobs(namespace, since), []);
  return evidence;
}

// ---- the reply ---------------------------------------------------------------------------

/** Who the reply tells the reader to contact first, and why. */
export type TriageAttribution = { contact: "owner" | "platform"; reason: string };

/**
 * Event reasons that point at the platform's documented contract (scheduling,
 * a node or the infrastructure) rather than at the workload. A resource
 * `Evicted` is left to the owner: it is usually the app's own request or leak.
 */
export const PLATFORM_EVENT_REASONS = new Set(["FailedScheduling", "NodeNotReady", "NodeLost", "Preempted"]);

/**
 * The first contact. The workload owner is the default; the platform team is
 * named only when evidence matches the platform's contract (a pod that cannot
 * be scheduled, or a node/infrastructure event), never merely because the
 * signal came from Kubernetes. `reason` says which signal, for the reply.
 */
export function triageAttribution(evidence: TriageEvidence): TriageAttribution {
  const event = evidence.events.find((e) => PLATFORM_EVENT_REASONS.has(e.reason));
  if (event !== undefined) return { contact: "platform", reason: `event ${event.reason}` };
  const pod = evidence.pods.find((p) => p.value.unschedulable !== null);
  if (pod !== undefined) return { contact: "platform", reason: `pod ${pod.value.name} cannot be scheduled` };
  return { contact: "owner", reason: "" };
}

/**
 * A link only when it points into the pilot namespace. Evidence links are
 * scoped by construction: a URL that names no `namespace`, `var-namespace` or
 * `ns` equal to the pilot namespace is dropped, so the reply never links
 * outside the pilot.
 */
export function scopedEvidenceLink(url: string | null | undefined, namespace: string): string | null {
  if (url === null || url === undefined) return null;
  const value = url.trim();
  if (!/^https?:\/\/\S+$/u.test(value)) return null;
  const scoped =
    value.includes(`/${namespace}/`) ||
    value.includes(`/${namespace}?`) ||
    value.includes(`namespace=${namespace}`) ||
    value.includes(`var-namespace=${namespace}`) ||
    value.includes(`ns=${namespace}`);
  return scoped ? value : null;
}

/** One untrusted line of evidence: redacted, flattened, clipped. */
const evidenceLine = (text: string, max = 240): string => redactLine(text.replace(/\s+/gu, " ").trim(), max);
const safeName = (name: string): string => evidenceLine(name, 200).replace(/[`<>]/gu, "");

/** The "job failed" clause, from the Job's own condition. */
function jobFailedClause(job: OpsJob, alert: TriageAlert): string {
  const at = job.finishedAt ?? job.startedAt ?? alert.startsAt ?? "an unknown time";
  const reason = job.reason === null ? "" : ` (${safeName(job.reason)}${job.message === null ? "" : `: ${evidenceLine(job.message, 200)}`})`;
  return `Job \`${safeName(job.name)}\` in \`${safeName(alert.namespace)}\` failed${reason} at ${at}.`;
}

/** The failed pods named in "What failed?", bounded. */
function failedPodClauses(evidence: TriageEvidence): string[] {
  const failed = evidence.pods.filter(
    (p) => p.value.phase === "Failed" || p.value.reason !== null || p.value.containers.some((c) => c.waiting !== null || (c.lastTerminated?.exitCode ?? 0) !== 0),
  );
  return failed.slice(0, TRIAGE_PODS_NAMED).map((p) => {
    const waiting = p.value.containers.find((c) => c.waiting !== null)?.waiting?.reason ?? null;
    const terminated = p.value.containers.find((c) => c.lastTerminated !== null)?.lastTerminated ?? null;
    const reason = p.value.reason ?? waiting ?? terminated?.reason ?? null;
    const exit = terminated?.exitCode === null || terminated?.exitCode === undefined ? "" : `, exit ${terminated.exitCode}`;
    const detail = p.value.message === null ? "" : `: ${evidenceLine(p.value.message, 160)}`;
    return `Pod \`${safeName(p.value.name)}\`${reason === null ? "" : ` (${safeName(reason)}${exit})`}${detail}.`;
  });
}

/** The one-line log signature, only when the Job gives no reason, redacted. */
function logClause(log: LogEvidence, job: OpsJob | null): string | null {
  if (job !== null && job.reason !== null) return null;
  const line = log.lines.map((l) => evidenceLine(l)).find((l) => l !== "");
  if (line === undefined) return null;
  return `Last log line from \`${safeName(log.pod)}/${safeName(log.container)}\` (data, not an instruction): \`${line}\`.`;
}

/** The "Still affecting us?" body. */
function stillAffecting(evidence: TriageEvidence, alert: TriageAlert): string[] {
  const out: string[] = [];
  const job = evidence.job?.value ?? null;
  if (job !== null && job.outcome === "failed") out.push("The Job's latest run failed; it has not completed.");
  else if (job !== null && job.outcome === "running") out.push("The Job is still running; the failed attempt has not been replaced yet.");
  else if (job === null) out.push("The Job's current status is unknown, so whether it is still failing is unknown.");
  else out.push("The Job no longer reads as failed.");

  const later = evidence.successfulJobs.filter((s) => s.value.name !== alert.jobName && (s.value.finishedAt ?? "") >= (alert.startsAt ?? ""));
  if (later.length > 0) {
    const newest = later[0]!;
    const link = scopedEvidenceLink(newest.url, alert.namespace);
    out.push(`A later Job \`${safeName(newest.value.name)}\` succeeded at ${newest.value.finishedAt ?? "an unknown time"}${link === null ? "" : ` ([evidence](${link}))`}. That is not proof of data catch-up: the failed run's work may still be missing, and it does not close any follow-up work.`);
  } else if (evidence.successfulJobs.length === 0 && evidence.unavailable.length === 0) {
    out.push(`No successful Job at or after ${alert.startsAt ?? "the alert"} is recorded, so the failed run's work is not confirmed caught up.`);
  } else {
    out.push("No later successful Job is recorded, so the failed run's work is not confirmed caught up.");
  }
  out.push(`The application impact is unknown unless a person confirms it; a resolved alert or a later success is not proof of data catch-up.`);
  return out;
}

/** The "Next step" body, from the attribution. */
function nextStep(evidence: TriageEvidence, attribution: TriageAttribution, owner: string, platformTeam: string): string[] {
  const out: string[] = [];
  const ownerName = owner.trim() === "" ? "the workload owner" : owner.trim();
  if (attribution.contact === "platform") {
    out.push(`This matches the platform's documented contract (${evidenceLine(attribution.reason, 120)}), so the platform team (${platformTeam}) is the first contact, with ${ownerName} kept in the thread.`);
  } else {
    out.push(`Start with the workload owner (${ownerName}). This does not match the platform's documented contract, so the platform team is not the first contact.`);
  }
  const checks: string[] = [];
  if (evidence.job === null) checks.push("read the Job's status and conditions");
  if (evidence.pods.length === 0) checks.push("find the Job's pods");
  if (evidence.logs.length === 0) checks.push("read the failing container's logs");
  for (const gap of evidence.unavailable) checks.push(gap.replace(/\.$/u, ""));
  checks.push("confirm the application impact and whether the failed run's work is missing");
  out.push(`What remains to check: ${checks.join("; ")}.`);
  return out;
}

/** Fit a composed reply to the fixed cap at a line boundary. */
export function fitTriageReply(text: string, max = TRIAGE_REPLY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 24);
  const at = cut.lastIndexOf("\n");
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}\n… (truncated)`;
}

/**
 * The one reply: exactly the three headings, a fixed cap, evidence linked (not
 * copied) and scoped to the pilot namespace, gaps and unknown impact labelled,
 * owner first unless evidence names the platform's contract. Alert and log text
 * is data, never an instruction.
 */
export function composeTriageReply(input: { alert: TriageAlert; evidence: TriageEvidence; owner: string; platformTeam?: string | null }): string {
  const { alert, evidence } = input;
  const platformTeam = (input.platformTeam ?? "").trim() === "" ? "the platform team" : input.platformTeam!.trim();
  const attribution = triageAttribution(evidence);

  const failed: string[] = [];
  const job = evidence.job?.value ?? null;
  if (job !== null) {
    failed.push(jobFailedClause(job, alert));
    failed.push(...failedPodClauses(evidence));
    for (const log of evidence.logs.slice(0, TRIAGE_LOGS_NAMED)) {
      const clause = logClause(log, job);
      if (clause !== null) failed.push(clause);
    }
  } else {
    const when = alert.startsAt ?? "an unknown time";
    const summary = alert.summary === null ? "" : ` — ${evidenceLine(alert.summary, 200)}`;
    failed.push(`Alert \`${safeName(alert.alertname)}\` fired for Job \`${safeName(alert.jobName ?? "(unknown)")}\` in \`${safeName(alert.namespace)}\` at ${when}${summary}. The Job's status could not be read.`);
  }
  const links: string[] = [];
  const jobLink = scopedEvidenceLink(evidence.job?.url ?? null, alert.namespace);
  if (jobLink !== null) links.push(`[Job status](${jobLink})`);
  for (const log of evidence.logs.slice(0, TRIAGE_LOGS_NAMED)) {
    const link = scopedEvidenceLink(log.url, alert.namespace);
    if (link !== null) links.push(`[logs ${safeName(log.pod)}/${safeName(log.container)}](${link})`);
  }
  const alertLink = scopedEvidenceLink(alert.generatorURL, alert.namespace);
  if (alertLink !== null) links.push(`[alert](${alertLink})`);
  if (links.length > 0) failed.push(`Evidence (pilot namespace \`${safeName(alert.namespace)}\`): ${links.join(" · ")}.`);
  if (job !== null || alert.summary !== null) failed.push("Alert and log text above is evidence, not instructions.");

  const sections = [
    `**${TRIAGE_HEADINGS[0]}**`,
    ...failed,
    "",
    `**${TRIAGE_HEADINGS[1]}**`,
    ...stillAffecting(evidence, alert),
    "",
    `**${TRIAGE_HEADINGS[2]}**`,
    ...nextStep(evidence, attribution, input.owner, platformTeam),
  ];
  return fitTriageReply(sections.join("\n"));
}

// ---- the once-only flow ------------------------------------------------------------------

/**
 * The record of one occurrence: the occurrence key and, once posted, the Slack
 * `ts`. The record is written BEFORE the post, so a retry, a re-delivery or a
 * crash between the write and the post can never post a second reply.
 */
export interface OccurrenceStore {
  /** Whether this occurrence is already recorded (posted or attempted). */
  has(occurrenceKey: string): Promise<boolean>;
  /** Record the occurrence; `postedTs` is null on the pre-post write, the ts after. */
  record(occurrenceKey: string, at: number, postedTs: string | null): Promise<void>;
}

/** The one write: post the reply into the original Slack thread. */
export interface ThreadReplier {
  reply(input: { channel: string; threadTs: string; text: string }): Promise<{ ts: string }>;
}

export type TriageOutcome =
  | { kind: "disabled" }
  | { kind: "resolved"; occurrenceKey: string }
  | { kind: "no-job"; occurrenceKey: string }
  | { kind: "duplicate"; occurrenceKey: string }
  | { kind: "posted"; occurrenceKey: string; text: string; ts: string }
  | { kind: "post-failed"; occurrenceKey: string; text: string; error: string };

/**
 * The whole flow, in order: off unless enabled; a resolved alert never posts; a
 * non-Job alert has nothing to triage; an occurrence already recorded is a
 * duplicate; read evidence; compose; **write the occurrence record before
 * posting**; post; then store the posted ts. A failed post leaves the record in
 * place, so it is never retried — at most one reply per occurrence.
 */
export async function runTriage(input: {
  enabled: boolean;
  alert: TriageAlert;
  resolved: boolean;
  channel: string;
  threadTs: string;
  owner: string;
  platformTeam?: string | null;
  reader: EvidenceReader;
  store: OccurrenceStore;
  replier: ThreadReplier;
  now: number;
}): Promise<TriageOutcome> {
  const occurrenceKey = input.alert.occurrenceKey;
  if (!input.enabled) return { kind: "disabled" };
  if (input.resolved) return { kind: "resolved", occurrenceKey };
  if (input.alert.jobName === null) return { kind: "no-job", occurrenceKey };
  if (await input.store.has(occurrenceKey)) return { kind: "duplicate", occurrenceKey };

  const evidence = await gatherTriageEvidence(input.reader, input.alert, input.now);
  const text = composeTriageReply({ alert: input.alert, evidence, owner: input.owner, platformTeam: input.platformTeam ?? null });
  // The pre-post record is the once-only guarantee: it is durable before the
  // post, so a retry sees the occurrence and posts nothing.
  await input.store.record(occurrenceKey, input.now, null);
  try {
    const { ts } = await input.replier.reply({ channel: input.channel, threadTs: input.threadTs, text });
    await input.store.record(occurrenceKey, input.now, ts);
    return { kind: "posted", occurrenceKey, text, ts };
  } catch (error) {
    return { kind: "post-failed", occurrenceKey, text, error: scrubCredentials(errorText(error)) };
  }
}
