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
  assignees: [],
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
  pull: { draft: false, merged: false, base: "main", head: "retry", headSha: "aaaaaaa1", headAuthor: "sam", reviewDecision: null, requestedReviewers: [], reviews: [], checks: { state: "pending", failing: [] }, ...pullOver },
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
