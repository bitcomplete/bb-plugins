// Test fixtures shared by the stewards tests. Not loaded by the plugin.
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";

export const issue = (over: Partial<EntitySnapshot> = {}): EntitySnapshot => ({
  source: "linear",
  kind: "issue",
  id: "uuid-12",
  key: "ENG-12",
  url: "https://linear.app/acme/issue/ENG-12",
  title: "Fix login",
  state: "Todo",
  stateType: "unstarted",
  unit: "ENG",
  labels: ["bb-managed"],
  author: "Jane",
  // Assigned to the default viewer: a ticket is adopted only where this
  // server's Linear login is an assignee (BB-115). Tests for an unassigned or
  // reassigned ticket override this.
  assignees: ["Jane"],
  priority: null,
  estimate: null,
  description: "Users cannot log in.",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  comments: [],
  parent: null,
  children: [],
  linkedPulls: [],
  pull: null,
  viewer: "Jane",
  ...over,
});

export const pull = (over: Partial<EntitySnapshot> = {}, pullOver: Partial<NonNullable<EntitySnapshot["pull"]>> = {}): EntitySnapshot => ({
  ...issue(),
  source: "github",
  kind: "pull",
  id: "acme/web#7",
  key: "acme/web#7",
  url: "https://github.com/acme/web/pull/7",
  title: "Add login retry",
  state: "open",
  stateType: null,
  unit: "acme/web",
  labels: [],
  author: "sam",
  description: "Retries login.",
  viewer: "jane",
  // The viewer is a requested reviewer by default: a review binding is made
  // only where this server's GitHub login is requested (BB-115). Tests for a
  // pull request that should not be reviewed override this.
  pull: { draft: false, merged: false, base: "main", head: "retry", headSha: "aaaaaaa1", headAuthor: "sam", reviewDecision: null, requestedReviewers: ["jane"], reviews: [], checks: { state: "pending", failing: [] }, ...pullOver },
  ...over,
});

export const comment = (over: Partial<SnapshotComment> = {}): SnapshotComment => ({
  id: "c1",
  author: "Sam",
  did: "commented",
  body: "Can we also cover SSO?",
  createdAt: "2026-10-02T00:00:00Z",
  url: null,
  signedBy: null,
  ...over,
});

/** A Deployment's pod as the Kubernetes API lists it, its one container in a crash loop. */
export const crashingPod = (name = "bb-gate-router-6d4f9c7b8-x2k4q", over: { restarts?: number; exitCode?: number; finishedAt?: string } = {}) => ({
  metadata: {
    name,
    labels: { app: "bb-gate-router", "pod-template-hash": "6d4f9c7b8" },
    ownerReferences: [{ kind: "ReplicaSet", name: "bb-gate-router-6d4f9c7b8", controller: true }],
  },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "False", lastTransitionTime: "2026-10-14T14:00:00Z" }],
    containerStatuses: [
      {
        name: "router",
        ready: false,
        restartCount: over.restarts ?? 7,
        state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
        lastState: { terminated: { reason: "Error", exitCode: over.exitCode ?? 1, finishedAt: over.finishedAt ?? "2026-10-14T14:55:00Z" } },
      },
    ],
  },
});

export const healthyPod = (name = "bb-gate-hooks-7f8d9-abcde") => ({
  metadata: { name, labels: { "pod-template-hash": "7f8d9" }, ownerReferences: [{ kind: "ReplicaSet", name: "bb-gate-hooks-7f8d9", controller: true }] },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "True", lastTransitionTime: "2026-10-14T10:00:00Z" }],
    containerStatuses: [{ name: "hooks", ready: true, restartCount: 0, state: { running: { startedAt: "2026-10-14T10:00:00Z" } }, lastState: {} }],
  },
});

export const warningEvent = (pod: string, reason = "BackOff", message = "Back-off restarting failed container router") => ({
  involvedObject: { kind: "Pod", name: pod },
  type: "Warning",
  reason,
  message,
  count: 12,
  lastTimestamp: "2026-10-14T14:58:00Z",
});
