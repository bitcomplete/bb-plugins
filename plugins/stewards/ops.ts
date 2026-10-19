// The ops kind's mechanical tier, as pure functions: what a look at a watch
// target found, each problem's fingerprint, and how each compares with the
// fingerprint map (new, still failing under its ticket, or back after its
// ticket was resolved). kube.ts reads the cluster; server.ts stores and
// wakes; nothing here talks to anything.
//
// A fingerprint names one problem across looks and restarts: the target, the
// workload (a Deployment's pods share it whatever their generated names), the
// container, and an error signature built from the container's status, never
// from log text, which changes on every line.
import { z } from "zod";
import type { Change } from "./reconcile.js";

export type OpsTarget = { kind: "k8s-namespace"; name: string };

/** The binding's entity id and key for a target: "k8s-namespace/bb-gate-production". */
export const opsTargetKey = (t: OpsTarget): string => `${t.kind}/${t.name}`;

export function parseOpsTargetKey(key: string): OpsTarget | null {
  const m = /^(k8s-namespace)\/([a-z0-9][-a-z0-9]*)$/u.exec(key);
  return m === null ? null : { kind: m[1] as OpsTarget["kind"], name: m[2]! };
}

// ---- reading the Kubernetes API's JSON --------------------------------------------

export type OpsContainer = {
  name: string;
  ready: boolean;
  restarts: number;
  waiting: { reason: string; message: string | null } | null;
  lastTerminated: { reason: string | null; exitCode: number | null; finishedAt: string | null } | null;
};

export type OpsPod = {
  name: string;
  workload: string;
  phase: string;
  reason: string | null;
  message: string | null;
  ready: boolean;
  /** When the Ready condition last changed. */
  readySince: string | null;
  /** The scheduler's message while the pod cannot be placed, and since when. */
  unschedulable: { message: string; since: string | null } | null;
  containers: OpsContainer[];
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The workload a pod belongs to: a Deployment's ReplicaSet without its
 * template hash, or the StatefulSet, DaemonSet or Job that owns it. A pod
 * nothing owns is its own workload.
 */
export function workloadOf(pod: Json): string {
  const meta = obj(pod.metadata);
  const name = str(meta.name) ?? "?";
  const owner = arr(meta.ownerReferences).find((o) => o.controller === true) ?? arr(meta.ownerReferences)[0];
  if (owner === undefined) return name;
  const ownerName = str(owner.name) ?? name;
  if (owner.kind !== "ReplicaSet") return ownerName;
  const hash = str(obj(meta.labels)["pod-template-hash"]);
  if (hash !== null && ownerName.endsWith(`-${hash}`)) return ownerName.slice(0, -hash.length - 1);
  return ownerName.replace(/-[a-z0-9]{6,10}$/u, "");
}

function containerOf(status: Json, prefix = ""): OpsContainer {
  const state = obj(status.state);
  const waiting = obj(state.waiting);
  const last = obj(obj(status.lastState).terminated);
  return {
    name: `${prefix}${str(status.name) ?? "?"}`,
    ready: status.ready === true,
    restarts: num(status.restartCount) ?? 0,
    waiting: str(waiting.reason) === null ? null : { reason: str(waiting.reason)!, message: str(waiting.message) },
    lastTerminated: Object.keys(last).length === 0 ? null : { reason: str(last.reason), exitCode: num(last.exitCode), finishedAt: str(last.finishedAt) },
  };
}

/** A pod list from the API, as the parts a look reads. */
export function podsOf(list: unknown): OpsPod[] {
  return arr(obj(list).items).map((pod) => {
    const meta = obj(pod.metadata);
    const status = obj(pod.status);
    const conditions = arr(status.conditions);
    const ready = conditions.find((c) => c.type === "Ready");
    const scheduled = conditions.find((c) => c.type === "PodScheduled");
    return {
      name: str(meta.name) ?? "?",
      workload: workloadOf(pod),
      phase: str(status.phase) ?? "Unknown",
      reason: str(status.reason),
      message: str(status.message),
      ready: ready?.status === "True",
      readySince: str(ready?.lastTransitionTime),
      unschedulable: scheduled?.status === "False" && scheduled.reason === "Unschedulable" ? { message: str(scheduled.message) ?? "unschedulable", since: str(scheduled.lastTransitionTime) } : null,
      containers: [...arr(status.initContainerStatuses).map((c) => containerOf(c, "init:")), ...arr(status.containerStatuses).map((c) => containerOf(c))],
    };
  });
}

export type OpsEvent = { kind: string; name: string; type: string; reason: string; message: string; count: number; at: string | null };

export function eventsOf(list: unknown): OpsEvent[] {
  return arr(obj(list).items).map((e) => {
    const involved = obj(e.involvedObject);
    const series = obj(e.series);
    return {
      kind: str(involved.kind) ?? "?",
      name: str(involved.name) ?? "?",
      type: str(e.type) ?? "Normal",
      reason: str(e.reason) ?? "?",
      message: str(e.message) ?? str(e.note) ?? "",
      count: num(e.count) ?? num(series.count) ?? 1,
      at: str(e.lastTimestamp) ?? str(series.lastObservedTime) ?? str(e.eventTime) ?? str(obj(e.metadata).creationTimestamp),
    };
  });
}

export type OpsDeployment = { name: string; ready: number; desired: number };

export function deploymentsOf(list: unknown): OpsDeployment[] {
  return arr(obj(list).items).map((d) => ({ name: str(obj(d.metadata).name) ?? "?", ready: num(obj(d.status).readyReplicas) ?? 0, desired: num(obj(d.spec).replicas) ?? 1 }));
}

// ---- findings ------------------------------------------------------------------------

/** Waiting reasons that mean a container cannot run, not that it is starting. */
const BAD_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError"]);
/** A pod not ready, or not placed, for this long is a problem rather than a rollout. */
export const SETTLE_MS = 10 * 60_000;
const EVENTS_PER_FINDING = 5;
const WARNINGS_MAX = 10;

/** One problem seen in one look, before it is compared with the fingerprint map. */
export type Sighting = {
  fingerprint: string;
  workload: string;
  /** Every pod showing it; the first is the one its logs were read from. */
  pods: string[];
  container: string | null;
  signature: string;
  summary: string;
  restarts: number;
  /** Warning events about its pods, newest first, as lines. */
  events: string[];
  /** The container's last log lines, redacted; null when they were not read. */
  logs: string[] | null;
  /** Whether its logs are of the container's previous run (the one that crashed). */
  previous: boolean;
};

export const fingerprintOf = (target: OpsTarget, workload: string, container: string | null, signature: string): string =>
  `${opsTargetKey(target)}/${workload}/${container ?? "pod"}#${signature}`;

const olderThan = (at: string | null, ms: number, now: number) => at !== null && now - Date.parse(at) >= ms;
const exit = (t: OpsContainer["lastTerminated"]) => (t === null ? "" : `${t.reason ?? "terminated"}, exit ${t.exitCode ?? "?"}`);

export const eventLine = (e: OpsEvent): string => `${e.at ?? "?"} ${e.kind}/${e.name} ${e.reason}${e.count > 1 ? ` ×${e.count}` : ""}: ${e.message.replace(/\s+/gu, " ").trim()}`;

/**
 * What is wrong in a target, one sighting per fingerprint. `since` is the
 * last look: a container that restarted after it, and is running again, is
 * still a sighting, once.
 */
export function findingsOf(target: OpsTarget, pods: OpsPod[], events: OpsEvent[], at: { now: number; since: number }): Sighting[] {
  const found = new Map<string, Sighting>();
  const add = (pod: OpsPod, container: OpsContainer | null, signature: string, summary: string) => {
    const fingerprint = fingerprintOf(target, pod.workload, container?.name ?? null, signature);
    const seen = found.get(fingerprint);
    if (seen !== undefined) {
      seen.pods.push(pod.name);
      seen.restarts = Math.max(seen.restarts, container?.restarts ?? 0);
      return;
    }
    found.set(fingerprint, { fingerprint, workload: pod.workload, pods: [pod.name], container: container?.name ?? null, signature, summary, restarts: container?.restarts ?? 0, events: [], logs: null, previous: container?.lastTerminated != null });
  };
  for (const pod of pods) {
    if (pod.phase === "Succeeded") continue;
    if (pod.phase === "Failed") {
      add(pod, null, `Failed:${pod.reason ?? "Unknown"}`, `Pod ${pod.name} failed${pod.reason === null ? "" : ` (${pod.reason})`}${pod.message === null ? "" : `: ${pod.message}`}`);
      continue;
    }
    let containerProblem = false;
    for (const c of pod.containers) {
      const last = c.lastTerminated;
      if (c.waiting !== null && BAD_WAITING.has(c.waiting.reason)) {
        containerProblem = true;
        const signature = c.waiting.reason === "CrashLoopBackOff" ? `CrashLoopBackOff:${last?.reason ?? "?"}:${last?.exitCode ?? "?"}` : c.waiting.reason;
        add(pod, c, signature, `Container ${c.name} is in ${c.waiting.reason}${last === null ? "" : ` (last run: ${exit(last)})`}, ${c.restarts} restart${c.restarts === 1 ? "" : "s"}${c.waiting.message === null ? "" : `: ${c.waiting.message}`}`);
      } else if (last !== null && last.finishedAt !== null && Date.parse(last.finishedAt) >= at.since && (last.exitCode !== 0 || last.reason === "OOMKilled")) {
        containerProblem = true;
        add(pod, c, `Restarted:${last.reason ?? "?"}:${last.exitCode ?? "?"}`, `Container ${c.name} restarted at ${last.finishedAt} (${exit(last)}), ${c.restarts} restart${c.restarts === 1 ? "" : "s"} in all`);
      }
    }
    if (pod.phase === "Pending" && pod.unschedulable !== null && olderThan(pod.unschedulable.since, SETTLE_MS, at.now)) {
      add(pod, null, "Unschedulable", `Pod ${pod.name} cannot be scheduled: ${pod.unschedulable.message}`);
    } else if (pod.phase === "Running" && !pod.ready && !containerProblem && olderThan(pod.readySince, SETTLE_MS, at.now)) {
      add(pod, null, "NotReady", `Pod ${pod.name} has been running but not ready since ${pod.readySince}`);
    }
  }
  const warnings = events.filter((e) => e.type === "Warning").sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  for (const s of found.values()) {
    s.events = warnings.filter((e) => e.kind === "Pod" && s.pods.includes(e.name)).slice(0, EVENTS_PER_FINDING).map(eventLine);
  }
  return [...found.values()];
}

/** Recent warning events about anything the findings do not already cover, for context. */
export function otherWarnings(events: OpsEvent[], sightings: Sighting[], since: number): string[] {
  const covered = new Set(sightings.flatMap((s) => s.pods));
  return events
    .filter((e) => e.type === "Warning" && !(e.kind === "Pod" && covered.has(e.name)) && e.at !== null && Date.parse(e.at) >= since)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, WARNINGS_MAX)
    .map(eventLine);
}

// ---- logs ------------------------------------------------------------------------------

export const LOG_LINES = 30;
const LOG_LINE_CHARS = 400;
const SECRET = /((?:authorization|token|secret|password|passwd|api[_-]?key|cookie|set-cookie)["']?\s*[:=]\s*["']?(?:bearer\s+)?|bearer\s+)([^\s"',;]+)/giu;

/**
 * The last lines of a log, clipped and with obvious credentials replaced.
 * They go into a Linear ticket, so a token printed by a crashing process
 * should not.
 */
export function logTail(text: string, lines = LOG_LINES): string[] {
  return text
    .split(/\r?\n/u)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .map((l) => l.replace(SECRET, "$1[redacted]"))
    .map((l) => (l.length <= LOG_LINE_CHARS ? l : `${l.slice(0, LOG_LINE_CHARS)}…`));
}

// ---- the look, compared with the fingerprint map ----------------------------------------

export const FINDING_CLASSES = ["new", "recurring", "returned"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export const opsFindingSchema = z.object({
  fingerprint: z.string(),
  workload: z.string(),
  pods: z.array(z.string()),
  container: z.string().nullable(),
  signature: z.string(),
  summary: z.string(),
  restarts: z.number(),
  events: z.array(z.string()),
  logs: z.array(z.string()).nullable(),
  previous: z.boolean().default(false),
  /** new: no ticket yet. recurring: its ticket is open. returned: its ticket was resolved and it is back. */
  class: z.enum(FINDING_CLASSES),
  ticket: z.string().nullable(),
  /** The ticket's state, when it could be read. */
  ticketState: z.string().nullable(),
  firstSeenAt: z.number(),
  lastCommentedAt: z.number().nullable(),
});
export type OpsFinding = z.infer<typeof opsFindingSchema>;

/** Whether logs were read: some were, the server may not read them (no pods/log grant), or none were needed. */
export const LOG_ACCESS = ["read", "not granted", "unneeded"] as const;

export const opsLookSchema = z.object({
  at: z.number(),
  target: z.string(),
  /** Set when the target could not be read; the rest is then empty. */
  error: z.string().nullable(),
  pods: z.number(),
  healthy: z.number(),
  deployments: z.array(z.object({ name: z.string(), ready: z.number(), desired: z.number() })),
  /** Warning events no finding covers. */
  warnings: z.array(z.string()),
  logs: z.enum(LOG_ACCESS),
  /** What the reader could not see, in sentences: events or deployments not readable. */
  notes: z.array(z.string()),
  findings: z.array(opsFindingSchema),
});
export type OpsLook = z.infer<typeof opsLookSchema>;

/** What a reader returns for one target, before the fingerprint map. */
export type RawLook = Omit<OpsLook, "at" | "target" | "error" | "findings"> & { sightings: Sighting[] };

/** A fingerprint map row, as classification needs it. */
export type FingerprintRow = { fingerprint: string; ticketKey: string | null; firstSeenAt: number; lastCommentedAt: number | null };

/** A ticket's state as the linear plugin reports it; null when it could not be read. */
export type TicketState = { state: string; stateType: string | null } | null;

const resolvedTicket = (t: TicketState) => t !== null && (t.stateType === "completed" || t.stateType === "canceled");

/**
 * Each sighting against the fingerprint map: new when it has no ticket,
 * recurring while its ticket is open (or cannot be read: a comment on a
 * ticket that turns out closed does less harm than a duplicate), returned
 * once its ticket was resolved.
 */
export function classify(sightings: Sighting[], rows: ReadonlyMap<string, FingerprintRow>, tickets: ReadonlyMap<string, TicketState>, now: number): OpsFinding[] {
  return sightings.map((s) => {
    const row = rows.get(s.fingerprint);
    const ticket = row?.ticketKey ?? null;
    const state = ticket === null ? null : (tickets.get(ticket) ?? null);
    const cls: FindingClass = ticket === null ? "new" : resolvedTicket(state) ? "returned" : "recurring";
    return { ...s, class: cls, ticket, ticketState: state?.state ?? null, firstSeenAt: row?.firstSeenAt ?? now, lastCommentedAt: row?.lastCommentedAt ?? null };
  });
}

/**
 * What changed between two looks, as the mechanical tier weighs it. A
 * problem new to this look, or back after its ticket was resolved, is worth
 * a turn at once. One still failing under its open ticket waits for the
 * requeue, so a crash loop is a comment per interval rather than per look.
 */
export function lookChanges(before: OpsLook | null, after: OpsLook): Change[] {
  if (after.error !== null) return before === null || before.error === null ? [{ text: `Cannot read ${after.target}: ${after.error}`, actionable: false }] : [];
  const changes: Change[] = [];
  if (before !== null && before.error !== null) changes.push({ text: `${after.target} is readable again`, actionable: false });
  const was = new Map((before?.findings ?? []).map((f) => [f.fingerprint, f]));
  for (const f of after.findings) {
    const prev = was.get(f.fingerprint);
    if (f.class === "new" && (prev === undefined || prev.class !== "new")) changes.push({ text: `New problem: ${f.fingerprint} — ${f.summary}`, actionable: true });
    else if (f.class === "returned" && prev?.class !== "returned") changes.push({ text: `Back after ${f.ticket} was resolved (${f.ticketState ?? "closed"}): ${f.fingerprint}`, actionable: true });
    else if (f.class === "recurring" && prev === undefined) changes.push({ text: `Seen again under ${f.ticket}: ${f.fingerprint}`, actionable: false });
  }
  const now = new Set(after.findings.map((f) => f.fingerprint));
  for (const f of was.values()) {
    if (!now.has(f.fingerprint)) changes.push({ text: `No longer seen: ${f.fingerprint}${f.ticket === null ? "" : ` (${f.ticket})`}`, actionable: false });
  }
  return changes;
}
