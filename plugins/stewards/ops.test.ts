import { describe, expect, it } from "vitest";
import { crashingPod, healthyPod, warningEvent } from "./fixtures.js";
import { classify, eventsOf, findingsOf, hasFingerprintLine, logTail, lookChanges, opsTargetKey, parseOpsTargetKey, podsOf, workloadOf, type OpsLook, type Sighting } from "./ops.js";

const target = { kind: "k8s-namespace", name: "bb-gate-production" } as const;
const now = Date.parse("2026-10-14T15:00:00Z");
const at = { now, since: now - 3_600_000 };
const look = (list: unknown[], events: unknown[] = []) => findingsOf(target, podsOf({ items: list }), eventsOf({ items: events }), at);

describe("targets", () => {
  it("round-trip through their binding key", () => {
    expect(opsTargetKey(target)).toBe("k8s-namespace/bb-gate-production");
    expect(parseOpsTargetKey("k8s-namespace/bb-gate-production")).toEqual(target);
    expect(parseOpsTargetKey("acme/web#3")).toBeNull();
    // A Sentry project is keyed by organization and project slug.
    const sentry = { kind: "sentry-project", org: "acme", project: "web-api" } as const;
    expect(opsTargetKey(sentry)).toBe("sentry-project/acme/web-api");
    expect(parseOpsTargetKey("sentry-project/acme/web-api")).toEqual(sentry);
    expect(parseOpsTargetKey("sentry-project/acme")).toBeNull();
    expect(parseOpsTargetKey("sentry-project/Acme/web")).toBeNull();
  });
});

describe("a look's findings", () => {
  it("names a crash loop by workload, container and exit, the same whatever the pod is called", () => {
    const [first] = look([crashingPod()], [warningEvent("bb-gate-router-6d4f9c7b8-x2k4q")]);
    expect(first).toMatchObject({
      fingerprint: "k8s-namespace/bb-gate-production/bb-gate-router/router#CrashLoopBackOff:Error:1",
      workload: "bb-gate-router",
      pods: ["bb-gate-router-6d4f9c7b8-x2k4q"],
      container: "router",
      restarts: 7,
      previous: true,
      summary: expect.stringMatching(/router is in CrashLoopBackOff \(last run: Error, exit 1\), 7 restarts/u),
    });
    expect(first!.events).toEqual(["2026-10-14T14:58:00Z Pod/bb-gate-router-6d4f9c7b8-x2k4q BackOff ×12: Back-off restarting failed container router"]);
    // A rollout's new pod, or a second replica, is the same problem.
    const replicas = look([crashingPod("bb-gate-router-6d4f9c7b8-aaaaa"), crashingPod("bb-gate-router-6d4f9c7b8-bbbbb", { restarts: 9 })]);
    expect(replicas).toHaveLength(1);
    expect(replicas[0]).toMatchObject({ fingerprint: first!.fingerprint, pods: ["bb-gate-router-6d4f9c7b8-aaaaa", "bb-gate-router-6d4f9c7b8-bbbbb"], restarts: 9 });
    // A different exit is a different problem.
    expect(look([crashingPod(undefined, { exitCode: 137 })])[0]!.fingerprint).toMatch(/CrashLoopBackOff:Error:137$/u);
  });

  it("finds nothing in healthy pods, and a restart only once, at the look after it", () => {
    expect(look([healthyPod()])).toEqual([]);
    const restarted = healthyPod();
    restarted.status.containerStatuses[0]!.lastState = { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-14T14:30:00Z" } } as never;
    expect(look([restarted])).toMatchObject([{ signature: "Restarted:OOMKilled:137", workload: "bb-gate-hooks" }]);
    // Before the last look: already seen.
    expect(findingsOf(target, podsOf({ items: [restarted] }), [], { now, since: Date.parse("2026-10-14T14:45:00Z") })).toEqual([]);
  });

  it("finds failed, unschedulable and long-unready pods, and lets a fresh rollout settle", () => {
    const failed = { metadata: { name: "job-x" }, status: { phase: "Failed", reason: "Evicted", message: "low on memory" } };
    const pending = (since: string) => ({ metadata: { name: "web-0", ownerReferences: [{ kind: "StatefulSet", name: "web", controller: true }] }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available", lastTransitionTime: since }] } });
    const unready = (since: string) => ({ ...healthyPod("api-5c-zzzzz"), status: { ...healthyPod().status, conditions: [{ type: "Ready", status: "False", lastTransitionTime: since }] } });
    expect(look([failed]).map((f) => f.signature)).toEqual(["Failed:Evicted"]);
    expect(look([pending("2026-10-14T14:00:00Z")])).toMatchObject([{ signature: "Unschedulable", workload: "web", container: null }]);
    expect(look([unready("2026-10-14T14:00:00Z")]).map((f) => f.signature)).toEqual(["NotReady"]);
    expect(look([pending("2026-10-14T14:58:00Z"), unready("2026-10-14T14:58:00Z")])).toEqual([]);
  });

  it("works out a pod's workload from its owner", () => {
    expect(workloadOf(crashingPod())).toBe("bb-gate-router");
    expect(workloadOf({ metadata: { name: "lonely" } })).toBe("lonely");
    expect(workloadOf({ metadata: { name: "x-1", ownerReferences: [{ kind: "DaemonSet", name: "x", controller: true }] } })).toBe("x");
  });
});

describe("log tails", () => {
  it("keep the last lines, clipped, with credentials redacted", () => {
    const text = ["boot", "Authorization: Bearer eyJhbGciOi.secret", "token=abc123 next", "", `${"x".repeat(500)}`, "panic: boom"].join("\n");
    const tail = logTail(text, 4);
    expect(tail).toHaveLength(4);
    expect(tail[0]).toBe("Authorization: Bearer [redacted]");
    expect(tail[1]).toBe("token=[redacted] next");
    expect(tail[2]!.length).toBe(401);
    expect(tail.at(-1)).toBe("panic: boom");
  });
});

describe("the fingerprint map", () => {
  const sighting = look([crashingPod()])[0]!;
  const row = (ticketKey: string | null) => new Map([[sighting.fingerprint, { fingerprint: sighting.fingerprint, ticketKey, firstSeenAt: 1_000, lastCommentedAt: ticketKey === null ? null : 2_000 }]]);

  it("classifies a problem as new, recurring under its open ticket, or returned after its ticket was resolved", () => {
    expect(classify([sighting], new Map(), new Map(), now)[0]).toMatchObject({ class: "new", ticket: null, firstSeenAt: now });
    expect(classify([sighting], row(null), new Map(), now)[0]).toMatchObject({ class: "new", firstSeenAt: 1_000 });
    expect(classify([sighting], row("OPS-5"), new Map([["OPS-5", { state: "In Progress", stateType: "started" }]]), now)[0]).toMatchObject({ class: "recurring", ticket: "OPS-5", ticketState: "In Progress", lastCommentedAt: 2_000 });
    expect(classify([sighting], row("OPS-5"), new Map([["OPS-5", { state: "Done", stateType: "completed" }]]), now)[0]).toMatchObject({ class: "returned", ticketState: "Done" });
    expect(classify([sighting], row("OPS-5"), new Map([["OPS-5", { state: "Canceled", stateType: "canceled" }]]), now)[0]!.class).toBe("returned");
    // A ticket that cannot be read is taken as open: a comment does less harm than a duplicate.
    expect(classify([sighting], row("OPS-5"), new Map([["OPS-5", null]]), now)[0]).toMatchObject({ class: "recurring", ticketState: null });
  });

  it("dates a returned ticket's close and whether it is inside the two-week window", () => {
    const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
    const returned = (closedAt: string | null) => classify([sighting], row("OPS-5"), new Map([["OPS-5", { state: "Done", stateType: "completed", closedAt }]]), now)[0]!;
    expect(returned(days(13))).toMatchObject({ class: "returned", closedAt: days(13), window: "within" });
    expect(returned(days(15))).toMatchObject({ class: "returned", closedAt: days(15), window: "outside" });
    // A resolved ticket the source gave no date for is returned with an unknown window.
    expect(returned(null)).toMatchObject({ class: "returned", closedAt: null, window: null });
    // An open ticket is never dated.
    expect(classify([sighting], row("OPS-5"), new Map([["OPS-5", { state: "In Progress", stateType: "started", closedAt: days(2) }]]), now)[0]).toMatchObject({ class: "recurring", closedAt: null, window: null });
  });

  it("carries the assignee the steward files under, or unassigned when the login cannot be read", () => {
    expect(classify([sighting], new Map(), new Map(), now, "Jane")[0]).toMatchObject({ assignee: "Jane" });
    expect(classify([sighting], new Map(), new Map(), now, null)[0]).toMatchObject({ assignee: "unassigned" });
    expect(classify([sighting], new Map(), new Map(), now)[0]).toMatchObject({ assignee: "unassigned", dedupUnavailable: false });
  });

  it("matches a fingerprint only on its exact line, never a title or a fuzzy match", () => {
    expect(hasFingerprintLine(`seen again\nFingerprint: \`${sighting.fingerprint}\`\nmore`, sighting.fingerprint)).toBe(true);
    expect(hasFingerprintLine(`Fingerprint: ${sighting.fingerprint}`, sighting.fingerprint)).toBe(false);
    expect(hasFingerprintLine(`The fingerprint is Fingerprint: \`${sighting.fingerprint}\`.`, sighting.fingerprint)).toBe(false);
    expect(hasFingerprintLine(`Fingerprint: \`${sighting.fingerprint}\` elsewhere`, sighting.fingerprint)).toBe(false);
    expect(hasFingerprintLine(null, sighting.fingerprint)).toBe(false);
  });

  it("makes a new or returned problem worth a turn at once, and a recurring one only at the requeue", () => {
    const base: Omit<OpsLook, "findings"> = { at: now, target: "k8s-namespace/bb-gate-production", error: null, pods: 2, healthy: 1, deployments: [], warnings: [], logs: "read", notes: [] };
    const lookWith = (findings: ReturnType<typeof classify>): OpsLook => ({ ...base, findings });
    const as = (s: Sighting, rows: ReturnType<typeof row>, state: "started" | "completed" | null = null) => classify([s], rows, new Map([["OPS-5", state === null ? null : { state, stateType: state }]]), now);
    const fresh = lookWith(as(sighting, new Map()));
    expect(lookChanges(null, fresh)).toEqual([{ text: expect.stringMatching(/^New problem: k8s-namespace\/bb-gate-production\/bb-gate-router\/router#/u), actionable: true }]);
    // Still unfiled at the next look: not news again.
    expect(lookChanges(fresh, fresh)).toEqual([]);
    const filed = lookWith(as(sighting, row("OPS-5"), "started"));
    expect(lookChanges(fresh, filed)).toEqual([]);
    expect(lookChanges(filed, filed)).toEqual([]);
    const back = lookWith(as(sighting, row("OPS-5"), "completed"));
    expect(lookChanges(filed, back)).toEqual([{ text: expect.stringMatching(/^Back after OPS-5 was resolved \(completed\)/u), actionable: true }]);
    expect(lookChanges(filed, lookWith([]))).toEqual([{ text: expect.stringMatching(/^No longer seen: .* \(OPS-5\)$/u), actionable: false }]);
    // An unreadable target is said once, and its recovery is quiet.
    const broken: OpsLook = { ...lookWith([]), error: "403: forbidden" };
    expect(lookChanges(filed, broken)).toEqual([{ text: "Cannot read k8s-namespace/bb-gate-production: 403: forbidden", actionable: false }]);
    expect(lookChanges(broken, broken)).toEqual([]);
    expect(lookChanges(broken, lookWith([]))).toEqual([{ text: "k8s-namespace/bb-gate-production is readable again", actionable: false }]);
  });
});
