import { describe, expect, it, vi } from "vitest";
import { EvidenceUnavailableError, TRIAGE_HEADINGS, TRIAGE_REPLY_MAX_CHARS, composeTriageReply, gatherTriageEvidence, runTriage, scopedEvidenceLink, triageAlertOf, triageAttribution, type EvidenceReader, type LogEvidence, type OccurrenceStore, type ThreadReplier, type TriageAlert, type TriageEvidence } from "./triage.js";
import { alertOf, alertmanagerOccurrenceKey } from "./alertmanager.js";
import type { OpsEvent, OpsJob, OpsPod } from "./ops.js";

const now = Date.parse("2026-11-27T22:05:00Z");

const triageAlert = (over: Partial<TriageAlert> = {}): TriageAlert => ({
  fingerprint: "fp-1",
  alertname: "KubeJobFailed",
  namespace: "bithub",
  jobName: "bithub-deel-sync-28934567",
  startsAt: "2026-11-27T22:00:00Z",
  summary: "Job failed to complete",
  generatorURL: null,
  occurrenceKey: "fp-1#bithub-deel-sync-28934567@2026-11-27T22:00:00Z",
  ...over,
});

const failedJob = (over: Partial<OpsJob> = {}): OpsJob => ({
  name: "bithub-deel-sync-28934567",
  namespace: "bithub",
  outcome: "failed",
  reason: "BackoffLimitExceeded",
  message: "Job has reached the specified backoff limit",
  startedAt: "2026-11-27T21:55:00Z",
  finishedAt: "2026-11-27T22:00:00Z",
  succeeded: 0,
  failed: 3,
  ...over,
});

const failedPod = (over: Partial<OpsPod> = {}): OpsPod => ({
  name: "bithub-deel-sync-28934567-abc",
  workload: "bithub-deel-sync-28934567",
  phase: "Failed",
  reason: "BackoffLimitExceeded",
  message: null,
  ready: false,
  readySince: null,
  unschedulable: null,
  containers: [{ name: "sync", ready: false, restarts: 0, waiting: null, lastTerminated: { reason: "Error", exitCode: 1, finishedAt: "2026-11-27T22:00:00Z" } }],
  ...over,
});

const event = (over: Partial<OpsEvent> = {}): OpsEvent => ({ kind: "Pod", name: "bithub-deel-sync-28934567-abc", type: "Warning", reason: "FailedScheduling", message: "0/3 nodes are available", count: 1, at: "2026-11-27T21:56:00Z", ...over });

const reader = (over: Partial<EvidenceReader> = {}): EvidenceReader => ({
  job: async () => ({ value: failedJob(), url: "https://grafana.example/d/job?var-namespace=bithub" }),
  pods: async () => [{ value: failedPod(), url: "https://grafana.example/d/pods?var-namespace=bithub" }],
  events: async () => [],
  logs: async () => ({ pod: "bithub-deel-sync-28934567-abc", container: "sync", lines: ["error: upstream 503 token=sk_live_secret"], url: "https://grafana.example/d/logs?var-namespace=bithub" }),
  recentSuccessfulJobs: async () => [],
  ...over,
});

/** An occurrence store that records every write, in order. */
function memoryStore(initial: string[] = []) {
  const seen = new Set(initial);
  const writes: Array<{ key: string; at: number; postedTs: string | null }> = [];
  const store: OccurrenceStore = {
    has: async (key) => seen.has(key),
    record: async (key, at, postedTs) => {
      seen.add(key);
      writes.push({ key, at, postedTs });
    },
  };
  return { store, seen, writes };
}

const okReplier = (ts = "1795751111.152339") => {
  const calls: Array<{ channel: string; threadTs: string; text: string }> = [];
  const replier: ThreadReplier = { reply: async (input) => { calls.push(input); return { ts }; } };
  return { replier, calls };
};

describe("the occurrence key", () => {
  it("pairs the fingerprint with the exact Job and startsAt, so a re-fire is a new occurrence", () => {
    const a = alertOf({ fingerprint: "fp", labels: { alertname: "KubeJobFailed", namespace: "bithub", job_name: "sync-1" }, startsAt: "2026-11-27T22:00:00Z" })!;
    const b = alertOf({ fingerprint: "fp", labels: { alertname: "KubeJobFailed", namespace: "bithub", job_name: "sync-1" }, startsAt: "2026-11-27T23:00:00Z" })!;
    const c = alertOf({ fingerprint: "fp", labels: { alertname: "KubeJobFailed", namespace: "bithub", job_name: "sync-2" }, startsAt: "2026-11-27T22:00:00Z" })!;
    expect(alertmanagerOccurrenceKey(a)).not.toBe(alertmanagerOccurrenceKey(b));
    expect(alertmanagerOccurrenceKey(a)).not.toBe(alertmanagerOccurrenceKey(c));
    expect(a.jobName).toBe("sync-1");
    expect(triageAlertOf(a).occurrenceKey).toBe(alertmanagerOccurrenceKey(a));
  });
});

describe("evidence links are scoped to the pilot namespace", () => {
  it("accepts a URL naming the namespace and drops one that does not", () => {
    expect(scopedEvidenceLink("https://grafana.example/d/job?var-namespace=bithub", "bithub")).toBe("https://grafana.example/d/job?var-namespace=bithub");
    expect(scopedEvidenceLink("https://grafana.example/d/job?namespace=bithub", "bithub")).toBe("https://grafana.example/d/job?namespace=bithub");
    expect(scopedEvidenceLink("https://grafana.example/d/job/bithub/logs", "bithub")).toBe("https://grafana.example/d/job/bithub/logs");
    expect(scopedEvidenceLink("https://grafana.example/d/other?var-namespace=web", "bithub")).toBeNull();
    expect(scopedEvidenceLink("not a url", "bithub")).toBeNull();
    expect(scopedEvidenceLink(null, "bithub")).toBeNull();
  });
});

describe("attribution", () => {
  it("keeps the owner first, and names the platform only on a contract signal", () => {
    expect(triageAttribution({ job: null, pods: [], events: [], logs: [], successfulJobs: [], unavailable: [] }).contact).toBe("owner");
    expect(triageAttribution({ job: null, pods: [], events: [event()], logs: [], successfulJobs: [], unavailable: [] })).toMatchObject({ contact: "platform", reason: "event FailedScheduling" });
    const unschedulable = failedPod({ unschedulable: { message: "0/3 nodes are available", since: "2026-11-27T21:56:00Z" } });
    expect(triageAttribution({ job: null, pods: [{ value: unschedulable, url: null }], events: [], logs: [], successfulJobs: [], unavailable: [] }).contact).toBe("platform");
  });
});

describe("composing the reply", () => {
  it("uses only the three headings, a fixed cap, and links scoped evidence", () => {
    const text = composeTriageReply({ alert: triageAlert(), evidence: { job: { value: failedJob(), url: "https://grafana.example/d/job?var-namespace=bithub" }, pods: [{ value: failedPod(), url: "https://grafana.example/d/pods?var-namespace=bithub" }], events: [], logs: [{ pod: "p", container: "sync", lines: ["boom"], url: "https://grafana.example/d/logs?var-namespace=bithub" }], successfulJobs: [], unavailable: [] }, owner: "dylan" });
    for (const heading of TRIAGE_HEADINGS) expect(text).toContain(`**${heading}**`);
    expect(text.match(/\*\*/gu)!.length).toBe(TRIAGE_HEADINGS.length * 2);
    expect(text).toContain("[Job status](https://grafana.example/d/job?var-namespace=bithub)");
    expect(text).not.toContain("var-namespace=web");
    expect(text.length).toBeLessThanOrEqual(TRIAGE_REPLY_MAX_CHARS);
  });

  it("redacts credentials and labels alert/log text as data, not instructions", () => {
    const text = composeTriageReply({ alert: triageAlert({ summary: "token=sk_live_abc leaked" }), evidence: { job: null, pods: [], events: [], logs: [], successfulJobs: [], unavailable: [] }, owner: "dylan" });
    expect(text).toContain("token=[redacted]");
    expect(text).not.toContain("sk_live_abc");
    expect(text).toContain("not instructions");
  });

  it("labels a later successful Job as not proof of data catch-up and unknown impact", () => {
    const later = failedJob({ name: "bithub-deel-sync-28934568", outcome: "succeeded", reason: null, message: null, finishedAt: "2026-11-27T22:04:00Z", succeeded: 1, failed: 0 });
    const text = composeTriageReply({ alert: triageAlert(), evidence: { job: { value: failedJob(), url: null }, pods: [], events: [], logs: [], successfulJobs: [{ value: later, url: null }], unavailable: [] }, owner: "dylan" });
    expect(text).toContain("not proof of data catch-up");
    expect(text).toContain("impact is unknown");
    expect(text).toContain("does not close any follow-up work");
  });

  it("names the platform team only for a contract signal and still keeps follow-up work open", () => {
    const later = failedJob({ name: "bithub-deel-sync-28934568", outcome: "succeeded", reason: null, message: null, finishedAt: "2026-11-27T22:04:00Z", succeeded: 1, failed: 0 });
    const text = composeTriageReply({ alert: triageAlert(), evidence: { job: { value: failedJob(), url: null }, pods: [], events: [event()], logs: [], successfulJobs: [{ value: later, url: null }], unavailable: [] }, owner: "dylan", platformTeam: "Platform" });
    expect(text).toContain("platform team (Platform) is the first contact");
    expect(text).toContain("does not close any follow-up work");
    const ownerText = composeTriageReply({ alert: triageAlert(), evidence: { job: { value: failedJob(), url: null }, pods: [], events: [], logs: [], successfulJobs: [], unavailable: [] }, owner: "dylan", platformTeam: "Platform" });
    expect(ownerText).toContain("Start with the workload owner (dylan)");
    expect(ownerText).not.toContain("is the first contact");
  });
});

describe("the once-only flow", () => {
  it("is off unless enabled, and touches nothing when off", async () => {
    const read = vi.fn(reader().job);
    const { store, seen } = memoryStore();
    const has = vi.spyOn(store, "has");
    const { replier, calls } = okReplier();
    const outcome = await runTriage({ enabled: false, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader({ job: read }), store, replier, now });
    expect(outcome).toEqual({ kind: "disabled" });
    expect(read).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(seen.size).toBe(0);
  });

  it("never posts for a resolved alert", async () => {
    const { store } = memoryStore();
    const { replier, calls } = okReplier();
    const outcome = await runTriage({ enabled: true, alert: triageAlert(), resolved: true, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader(), store, replier, now });
    expect(outcome.kind).toBe("resolved");
    expect(calls).toHaveLength(0);
  });

  it("writes the occurrence record before posting, and posts at most once per occurrence", async () => {
    const { store, seen, writes } = memoryStore();
    const order: string[] = [];
    const replier: ThreadReplier = {
      reply: async () => {
        // The record must already be durable when the post happens.
        expect(seen.has("fp-1#bithub-deel-sync-28934567@2026-11-27T22:00:00Z")).toBe(true);
        order.push("post");
        return { ts: "1795751111.152339" };
      },
    };
    const first = await runTriage({ enabled: true, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader(), store, replier, now });
    expect(first.kind).toBe("posted");
    expect(writes.map((w) => w.postedTs)).toEqual([null, "1795751111.152339"]);
    // A duplicate delivery sees the record and posts nothing.
    const second = await runTriage({ enabled: true, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader(), store, replier, now });
    expect(second).toMatchObject({ kind: "duplicate" });
    expect(order).toEqual(["post"]);
    expect(writes).toHaveLength(2);
  });

  it("leaves the record in place when the post fails, so a retry does not post twice", async () => {
    const { store, seen } = memoryStore();
    const replier: ThreadReplier = { reply: async () => { throw new Error("slack unavailable token=xoxb-secret"); } };
    const first = await runTriage({ enabled: true, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader(), store, replier, now });
    expect(first).toMatchObject({ kind: "post-failed" });
    expect(seen.has("fp-1#bithub-deel-sync-28934567@2026-11-27T22:00:00Z")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("xoxb-secret");
    const second = await runTriage({ enabled: true, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader(), store, replier, now });
    expect(second).toMatchObject({ kind: "duplicate" });
  });

  it("labels missing logs or permissions and still posts the rest", async () => {
    const { store } = memoryStore();
    const { replier, calls } = okReplier();
    const logs = vi.fn(async () => {
      throw new EvidenceUnavailableError("pods/log", "forbidden");
    });
    const outcome = await runTriage({ enabled: true, alert: triageAlert(), resolved: false, channel: "C1", threadTs: "t1", owner: "dylan", reader: reader({ logs }), store, replier, now });
    expect(outcome.kind).toBe("posted");
    expect(calls[0]!.text).toContain("could not be read (pods/log: forbidden)");
    expect(calls[0]!.text).toContain("What remains to check");
  });
});

describe("gathering evidence", () => {
  it("tolerates a whole-reader failure and records it as a labelled gap", async () => {
    const evidence = await gatherTriageEvidence(
      reader({
        job: async () => {
          throw new EvidenceUnavailableError("Job status", "no read-only identity");
        },
        pods: async () => {
          throw new EvidenceUnavailableError("pod status", "forbidden");
        },
        events: async () => {
          throw new EvidenceUnavailableError("events", "forbidden");
        },
        logs: async () => {
          throw new EvidenceUnavailableError("pods/log", "forbidden");
        },
        recentSuccessfulJobs: async () => {
          throw new EvidenceUnavailableError("recent successful Jobs", "forbidden");
        },
      }),
      triageAlert(),
      now,
    );
    expect(evidence.job).toBeNull();
    expect(evidence.pods).toEqual([]);
    expect(evidence.unavailable.length).toBeGreaterThanOrEqual(4);
    expect(evidence.unavailable.every((g) => g.endsWith(")."))).toBe(true);
  });

  it("reads the logs of a not-ready pod and carries their link", async () => {
    const log: LogEvidence = { pod: "p", container: "sync", lines: ["boom"], url: "https://grafana.example/d/logs?var-namespace=bithub" };
    const evidence = await gatherTriageEvidence(reader({ logs: async () => log }), triageAlert(), now);
    expect(evidence.logs).toEqual([log]);
  });
});
