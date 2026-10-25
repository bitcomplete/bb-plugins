// Deployment watching: the per-pull-request state a binding keeps between a
// merge and the deployment that confirms it is live (BB-53). Pure: the store
// holds the state, and server.ts feeds in the snapshots and the deployment
// doorbells. Nothing here decides whether a deployment carries a merge; that
// is the steward's, from the playbook's rule, and it reports the verdict.
import { z } from "zod";
import type { DeploymentTarget } from "./config.js";
import type { Deployment, EntitySnapshot } from "./source-contract.js";
import type { Observed } from "./store.js";

/**
 * A pull request's deployment state, as `bb stewards show` prints it:
 * `merged` is merged and awaiting a deployment, `deploying` is a matching
 * deployment seen but not yet confirmed to carry the merge, `deployed` is
 * confirmed live, and `failed` is a failure/error deployment or a timeout.
 */
export const DEPLOY_STATES = ["merged", "deploying", "deployed", "failed"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

export const deploymentWatchSchema = z.object({
  /** The pull request's key, e.g. "acme/web#12"; the map's key as well. */
  key: z.string(),
  state: z.enum(DEPLOY_STATES),
  /** The merged commit the deployment must carry. */
  mergeSha: z.string().nullable().default(null),
  /** The playbook's target, recorded with the watch so a later playbook edit does not move it. */
  repo: z.string(),
  environment: z.string(),
  deploymentId: z.number().int().nullable().default(null),
  ref: z.string().nullable().default(null),
  sha: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** When the state last changed. */
  at: z.number(),
  /** No matching deployment by then wakes the steward; null once there is one. */
  deadlineAt: z.number().nullable().default(null),
  /** Why, in words: a failure state, or a steward's "does not carry this merge yet". */
  note: z.string().nullable().default(null),
});
export type DeploymentWatch = z.infer<typeof deploymentWatchSchema>;

export const deploymentsSchema = z.record(z.string(), deploymentWatchSchema);
export type Deployments = Record<string, DeploymentWatch>;

/** The merged pull requests a binding should watch: its own entity when it is a pull request, and a ticket's linked ones. */
export function mergedPulls(observed: Observed): EntitySnapshot[] {
  return [observed.entity, ...observed.pulls].filter((e) => e.pull !== null && (e.pull.merged || e.state.toLowerCase() === "merged"));
}

/**
 * Add a `merged` watch for every merged pull request the binding does not
 * already watch. The target's timeout is the deadline; a watch that already
 * exists is left alone, so a re-read does not reset it.
 */
export function recordMerged(deployments: Deployments, observed: Observed, target: DeploymentTarget, now: number): Deployments {
  const pulls = mergedPulls(observed);
  if (pulls.length === 0) return deployments;
  const next = { ...deployments };
  let changed = false;
  for (const p of pulls) {
    if (next[p.key] !== undefined) continue;
    next[p.key] = {
      key: p.key,
      state: "merged",
      mergeSha: p.pull?.headSha ?? null,
      repo: target.repo,
      environment: target.environment,
      deploymentId: null,
      ref: null,
      sha: null,
      url: null,
      at: now,
      deadlineAt: now + target.timeout,
      note: null,
    };
    changed = true;
  }
  return changed ? next : deployments;
}

/** Whether a deployment doorbell's repo/environment is the one this target names. */
export const matchesTarget = (target: Pick<DeploymentTarget, "repo" | "environment">, repo: string, environment: string): boolean =>
  target.repo.toLowerCase() === repo.toLowerCase() && target.environment.toLowerCase() === environment.toLowerCase();

/**
 * Apply a deployment doorbell to a binding's watches: every watch for the
 * target that is not settled moves to `deploying` with the deployment's facts
 * (or `failed` on a failure/error state). Returns the keys that moved.
 */
export function applyDeployment(deployments: Deployments, target: Pick<DeploymentTarget, "repo" | "environment" | "timeout">, deployment: Deployment, now: number): { deployments: Deployments; changed: string[] } {
  const next = { ...deployments };
  const changed: string[] = [];
  const failed = deployment.state === "failure" || deployment.state === "error";
  for (const watch of Object.values(next)) {
    if (watch.state === "deployed" || watch.state === "failed") continue;
    if (!matchesTarget(target, watch.repo, watch.environment)) continue;
    // The doorbell's own environment has to be the target's too; the caller
    // matched the repo already, and a doorbell for another environment is not
    // this target's.
    if (deployment.environment.toLowerCase() !== watch.environment.toLowerCase()) continue;
    next[watch.key] = {
      ...watch,
      state: failed ? "failed" : "deploying",
      deploymentId: deployment.id,
      ref: deployment.ref === "" ? null : deployment.ref,
      sha: deployment.sha === "" ? null : deployment.sha,
      url: deployment.url,
      at: now,
      // A deployment that never reaches a final status still wakes the
      // steward within the playbook's time; a failure is settled.
      deadlineAt: failed ? null : now + target.timeout,
      note: failed ? `Deployment ${deployment.id} reported ${deployment.state}` : watch.note,
    };
    changed.push(watch.key);
  }
  return { deployments: next, changed };
}

/** The watches still awaiting a deployment whose deadline has passed. */
export const timeoutsDue = (deployments: Deployments, now: number): string[] =>
  Object.values(deployments)
    .filter((w) => (w.state === "merged" || w.state === "deploying") && w.deadlineAt !== null && now >= w.deadlineAt)
    .map((w) => w.key);

/** Mark timed-out watches failed, so the steward is woken once and the state does not flap. */
export function timeOut(deployments: Deployments, keys: readonly string[], now: number): Deployments {
  const next = { ...deployments };
  for (const key of keys) {
    const watch = next[key];
    if (watch === undefined) continue;
    next[key] = { ...watch, state: "failed", at: now, deadlineAt: null, note: watch.note ?? "No matching deployment within the playbook's timeout" };
  }
  return next;
}

/** What a steward reports about a deployment: whether it carries the merge, or that it failed. */
export const deploymentReportSchema = z.object({
  state: z.enum(["deployed", "failed", "not-yet"]),
  /** The pull request key, when the binding watches more than one. */
  key: z.string().trim().min(1).max(300).optional(),
  /** The deployment id, when the steward is answering a specific doorbell. */
  deploymentId: z.number().int().nonnegative().optional(),
  note: z.string().trim().max(2000).optional(),
});
export type DeploymentReport = z.infer<typeof deploymentReportSchema>;

/** The watch a report names: by key, by deployment id, or the only unsettled one. */
export function pickWatch(deployments: Deployments, report: DeploymentReport): DeploymentWatch | null {
  const all = Object.values(deployments);
  if (report.key !== undefined) return all.find((w) => w.key.toLowerCase() === report.key!.toLowerCase()) ?? null;
  if (report.deploymentId !== undefined) return all.find((w) => w.deploymentId === report.deploymentId) ?? null;
  const unsettled = all.filter((w) => w.state === "merged" || w.state === "deploying");
  return unsettled.length === 1 ? unsettled[0]! : null;
}

/**
 * Apply a steward's verdict. `deployed` settles the watch; `failed` marks it
 * failed; `not-yet` puts it back to `merged` with the note, so a later
 * deployment for the same target can still carry it.
 */
export function reportDeployment(deployments: Deployments, report: DeploymentReport, now: number, timeoutMs: number): { deployments: Deployments; changed: DeploymentWatch | null } {
  const watch = pickWatch(deployments, report);
  if (watch === null) return { deployments, changed: null };
  const next = { ...deployments };
  const note = report.note ?? null;
  if (report.state === "deployed") next[watch.key] = { ...watch, state: "deployed", at: now, deadlineAt: null, note };
  else if (report.state === "failed") next[watch.key] = { ...watch, state: "failed", at: now, deadlineAt: null, note: note ?? watch.note };
  // A deployment that does not carry the merge is not settled: it keeps a
  // fresh deadline, so another deployment, or the timeout, still wakes the
  // steward within the playbook's time.
  else next[watch.key] = { ...watch, state: "merged", at: now, deadlineAt: now + timeoutMs, note: note ?? "The deployment does not carry this merge yet" };
  return { deployments: next, changed: next[watch.key]! };
}

/** Whether every watched pull request is deployed and there is at least one. */
export const allDeployed = (deployments: Deployments): boolean => {
  const all = Object.values(deployments);
  return all.length > 0 && all.every((w) => w.state === "deployed");
};

/** Whether any watch is still unsettled: merged, deploying, or failed (a failure needs a person too). */
export const anyPending = (deployments: Deployments): boolean => Object.values(deployments).some((w) => w.state !== "deployed");

/** The watches still awaiting a first deployment, for the wake's "awaiting" line. */
export const awaitingDeployment = (deployments: Deployments): DeploymentWatch[] => Object.values(deployments).filter((w) => w.state === "merged" || w.state === "deploying");

/** One line per watch, as `bb stewards show` prints them. */
export function deploymentLines(deployments: Deployments): string[] {
  return Object.values(deployments)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((w) => {
      const where = `→ ${w.repo} ${w.environment}`;
      const facts = [
        w.deploymentId === null ? null : `deployment ${w.deploymentId}`,
        w.ref === null ? null : `ref ${w.ref}`,
        w.sha === null ? null : `sha ${w.sha.slice(0, 7)}`,
        w.url === null ? null : w.url,
      ].filter((x): x is string => x !== null);
      return `${w.key}: ${w.state} ${where}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}${w.note === null ? "" : ` — ${w.note}`}`;
    });
}
