// Grouping inputs: Linear detail joins a cluster's semantic hash only when known.
import { describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { clusterInputHash, mostUrgent, unitLifecycle, type Cluster, type ClusterLinear } from "./workstreams.js";

function pr(title: string): Pr {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checkConclusions: [],
    url: "https://github.com/inkwell/quill/pull/7",
    title,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "dev/x",
    latestReviewStates: [],
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    latestReviews: [],
  };
}

function cluster(ticket: string, repo: string, changedPaths: string[], title = `Work on ${ticket.toLowerCase()} alone`): Cluster {
  const raw: RawUnit = {
    path: `/c/${ticket}`,
    dirName: ticket,
    repo,
    branch: `dev/${ticket.toLowerCase()}`,
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: "2030-01-01T00:00:00Z",
    defaultBranch: "main",
    pr: pr(title),
    shipped: null,
    changedPaths,
  };
  return {
    ticket,
    lifecycle: mostUrgent([unitLifecycle(raw)]),
    staleness: "fresh",
    surfaces: [],
    risk: "none",
    units: [{ ...raw, ticket, lifecycle: unitLifecycle(raw), stack: null, staleness: "fresh", surfaces: [], risk: "none" }],
  };
}

const linear = (overrides: Partial<ClusterLinear> = {}): ClusterLinear => ({
  title: null,
  state: null,
  project: null,
  parentIdentifier: null,
  parentTitle: null,
  url: null,
  ...overrides,
});

describe("Linear in the semantic hash", () => {
  it("hashes a cluster with no Linear detail exactly as before, and a state change never re-asks", () => {
    const plain = cluster("ABC-1", "quill", []);
    expect(clusterInputHash({ ...plain, linear: null })).toBe(clusterInputHash(plain));
    const todo = { ...plain, linear: linear({ title: "Gift cards", state: "Todo" }) };
    const done = { ...plain, linear: linear({ title: "Gift cards", state: "Done" }) };
    expect(clusterInputHash(todo)).not.toBe(clusterInputHash(plain));
    expect(clusterInputHash(todo)).toBe(clusterInputHash(done));
  });
});
