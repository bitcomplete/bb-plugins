// Which clusters to re-ask Jev about, and WHY — plus a damper for a cluster
// that keeps being re-asked only because the candidate it chose keeps
// disappearing. Pure: server.ts persists the memory and writes the log lines.
import type { ClusterDecision } from "./workstreams.js";

/**
 * Why a cluster is asked about:
 * - `new`: never asked (or its cache is gone).
 * - `semantic-hash-changed`: its content changed since it was last seen.
 * - `label-vanished`: its cached assignment's candidate no longer exists.
 * - `no-assignment`: it was asked but the answer carried no usable assignment.
 */
export type AskReason = "new" | "semantic-hash-changed" | "label-vanished" | "no-assignment";

/** What is remembered per cluster key between scans. */
export type AskMemory = { hash: string; streak: number; pinned: boolean };

/** Consecutive label-vanished re-asks after which a cluster keeps its last assignment. */
export const PIN_AFTER = 3;

export type AskPlan = {
  ask: { key: string; hash: string; reason: AskReason }[];
  next: Map<string, AskMemory>;
  /** Clusters pinned by THIS plan: log once. */
  pinned: string[];
  /** Asks whose only change is Linear detail arriving: the one-time regroup after a key is added. */
  linearArrivals: number;
};

/**
 * Plan one scan's asks.
 *
 * The damper: a cluster re-asked for `label-vanished` in PIN_AFTER consecutive
 * scans keeps its last assignment and is not asked again until its semantic
 * hash changes. Anything else — a real content change, a scan where its label
 * existed — resets the streak, so the pin can only ever hold a cluster whose
 * content is unchanged.
 */
export function planClusterAsks(input: {
  clusters: readonly {
    key: string;
    hash: string;
    baseHash?: string;
    decision: ClusterDecision | undefined;
    /** False for a bare clone or a finished ticketless PR: never asked, and its memory is left as it was. */
    grouped?: boolean;
  }[];
  labels: ReadonlySet<string>;
  memory: ReadonlyMap<string, AskMemory>;
}): AskPlan {
  const plan: AskPlan = { ask: [], next: new Map(), pinned: [], linearArrivals: 0 };
  for (const cluster of input.clusters) {
    if (cluster.grouped === false) continue;
    const prev = input.memory.get(cluster.key);
    const same = prev !== undefined && prev.hash === cluster.hash;
    const { decision } = cluster;
    if (decision === undefined) {
      const reason: AskReason = prev !== undefined && !same ? "semantic-hash-changed" : "new";
      if (reason === "semantic-hash-changed" && cluster.baseHash !== undefined && prev?.hash === cluster.baseHash) {
        plan.linearArrivals += 1;
      }
      plan.ask.push({ key: cluster.key, hash: cluster.hash, reason });
      plan.next.set(cluster.key, { hash: cluster.hash, streak: 0, pinned: false });
      continue;
    }
    if (decision.assignment === null) {
      plan.ask.push({ key: cluster.key, hash: cluster.hash, reason: "no-assignment" });
      plan.next.set(cluster.key, { hash: cluster.hash, streak: 0, pinned: false });
      continue;
    }
    if (input.labels.has(decision.assignment.label)) {
      plan.next.set(cluster.key, { hash: cluster.hash, streak: 0, pinned: false });
      continue;
    }
    const streak = same ? prev.streak : 0;
    if (same && prev.pinned) {
      plan.next.set(cluster.key, prev);
      continue;
    }
    if (streak >= PIN_AFTER) {
      plan.pinned.push(cluster.key);
      plan.next.set(cluster.key, { hash: cluster.hash, streak, pinned: true });
      continue;
    }
    plan.ask.push({ key: cluster.key, hash: cluster.hash, reason: "label-vanished" });
    plan.next.set(cluster.key, { hash: cluster.hash, streak: streak + 1, pinned: false });
  }
  return plan;
}
