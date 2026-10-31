// Deployment watching: the per-pull-request state a binding keeps between a
// merge and the deployment that confirms it is live (BB-53). Pure: the store
// holds the state, and server.ts feeds in the snapshots and the deployment
// doorbells. A free-text `carries` is the steward's to apply; a structured one
// is evaluated by `carries.ts` (BB-132), and either way the steward reports a
// verdict it disagrees with.
import { z } from "zod";
import { matchCarriesRule } from "./carries.js";
import type { DeploymentTarget } from "./config.js";
import type { Deployment, EntitySnapshot, WorkflowRun } from "./source-contract.js";
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
  /**
   * The target this watch belongs to, keyed name-or-`repo@environment`
   * (BB-132). Empty on a watch stored before targets could be many; a
   * playbook with one unnamed target still keys its watches by the pull
   * request alone, so old watches and new ones share a key.
   */
  target: z.string().default(""),
  /**
   * When the pull request merged, the clock a workflow run is compared
   * against. Null on a watch stored before BB-132, when `at` is used.
   */
  mergedAt: z.number().nullable().default(null),
  /** The merged pull request's own repo, for matching a carries rule's `when.repo`. */
  prRepo: z.string().default(""),
  /** The merged pull request's changed paths, for matching a carries rule's `when.paths`. */
  files: z.array(z.string()).default([]),
  /** The playbook's target, recorded with the watch so a later playbook edit does not move it. */
  repo: z.string(),
  environment: z.string(),
  deploymentId: z.number().int().nullable().default(null),
  /** The deployment's own last status (success, failure, in_progress…), so a repeat read is not news. */
  deploymentState: z.string().nullable().default(null),
  ref: z.string().nullable().default(null),
  sha: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** When the state last changed. */
  at: z.number(),
  /** No matching deployment by then wakes the steward; null once there is one. */
  deadlineAt: z.number().nullable().default(null),
  /** Why, in words: a failure state, or a steward's "does not carry this merge yet". */
  note: z.string().nullable().default(null),
  /**
   * The `workflow_run` events this watch has been woken for, as
   * `<owner/repo#run id>#<attempt>`, so a repeat delivery of one run and
   * attempt is not news (BB-61). The watch's state is not moved by a run.
   */
  workflowRuns: z.array(z.string()).default([]),
});
export type DeploymentWatch = z.infer<typeof deploymentWatchSchema>;

export const deploymentsSchema = z.record(z.string(), deploymentWatchSchema);
export type Deployments = Record<string, DeploymentWatch>;

/** The merged pull requests a binding should watch: its own entity when it is a pull request, and a ticket's linked ones. */
export function mergedPulls(observed: Observed): EntitySnapshot[] {
  return [observed.entity, ...observed.pulls].filter((e) => e.pull !== null && (e.pull.merged || e.state.toLowerCase() === "merged"));
}

/** The target's stable key: its name when it has one, else `repo@environment`. */
export const targetKeyOf = (target: Pick<DeploymentTarget, "name" | "repo" | "environment">): string => target.name ?? `${target.repo}@${target.environment}`;

/**
 * The map key a watch for one merged pull request and one target uses. A
 * single unnamed target keeps today's key (the pull request's own), so a
 * project with one target reads and writes exactly as before (BB-132).
 */
export const watchId = (pullKey: string, target: Pick<DeploymentTarget, "name" | "repo" | "environment">, multiple: boolean): string => (!multiple && target.name === undefined ? pullKey : `${pullKey}::${targetKeyOf(target)}`);

/**
 * Whether a target can concern a merge at all (BB-132 follow-up). A free-text
 * `carries` is the steward's and keeps today's behaviour, so it always
 * applies. A structured one applies only when one of its rules matches the
 * merge's repo and changed files; a target that does not apply gets no watch,
 * so it never sits in `deploying` or times out to `failed` over a merge it
 * cannot carry.
 */
export const targetAppliesToMerge = (target: DeploymentTarget, prRepo: string, files: readonly string[]): boolean =>
  typeof target.carries === "string" || matchCarriesRule(target.carries, prRepo, files) !== null;

/**
 * Add a `merged` watch for every merged pull request the binding does not
 * already watch, for each of the playbook's deployment targets (BB-132). The
 * target's timeout is the deadline; a watch that already exists is left
 * alone, except that its `mergeSha` is re-resolved to the merge commit when
 * the source now knows one and the stored one differs (a watch recorded
 * before BB-132 holds the pull request head, which a squash merge rewrites).
 *
 * A target whose structured `carries` has no rule for the merge is not
 * applicable and is skipped; a watch already stored for it is dropped, so it
 * cannot block closing the ticket. When no target applies at all, every
 * target is watched, as before, so the merge still lands on the
 * steward-decided path rather than getting no watch (BB-132 follow-up).
 */
export function recordMerged(deployments: Deployments, observed: Observed, targets: readonly DeploymentTarget[], now: number): Deployments {
  const pulls = mergedPulls(observed);
  if (pulls.length === 0 || targets.length === 0) return deployments;
  const multiple = targets.length > 1;
  const next = { ...deployments };
  let changed = false;
  for (const p of pulls) {
    const merge = p.pull?.mergeCommit ?? null;
    const files = p.pull?.files ?? [];
    const applicable = targets.filter((t) => targetAppliesToMerge(t, p.unit, files));
    const chosen = applicable.length > 0 ? applicable : targets;
    const chosenIds = new Set(chosen.map((t) => watchId(p.key, t, multiple)));
    for (const target of chosen) {
      const id = watchId(p.key, target, multiple);
      let existing = next[id];
      // A playbook that grew a target, or named its single one, leaves a
      // watch stored before BB-132 keyed by the pull request alone. When its
      // recorded target is this one, move it to the keyed form rather than
      // orphaning it.
      if (existing === undefined && id !== p.key) {
        const legacy = next[p.key];
        if (legacy !== undefined && legacy.target === "" && matchesTarget(target, legacy.repo, legacy.environment)) {
          delete next[p.key];
          existing = { ...legacy, target: targetKeyOf(target) };
          next[id] = existing;
          changed = true;
        }
      }
      if (existing !== undefined) {
        // Re-resolve a stored PR-head merge sha to the merge commit (BB-132).
        // An unknown oid leaves the watch on the steward-decided path. The
        // old note is kept: a settled watch's failure text must not vanish.
        if (merge !== null && existing.mergeSha !== merge) {
          const resolved = `Merge commit re-resolved to ${merge.slice(0, 7)}`;
          next[id] = { ...existing, mergeSha: merge, note: existing.note === null || existing.note === undefined || existing.note === "" ? resolved : `${existing.note} (${resolved})` };
          changed = true;
        }
        continue;
      }
      next[id] = {
        key: p.key,
        state: "merged",
        mergeSha: merge,
        target: multiple || target.name !== undefined ? targetKeyOf(target) : "",
        mergedAt: now,
        prRepo: p.unit,
        files: p.pull?.files ?? [],
        repo: target.repo,
        environment: target.environment,
        deploymentId: null,
        deploymentState: null,
        ref: null,
        sha: null,
        url: null,
        at: now,
        deadlineAt: now + target.timeout,
        note: merge === null ? "The merge commit is not known yet; the next read re-resolves it" : null,
        workflowRuns: [],
      };
      changed = true;
    }
    // A watch stored for this pull on a target whose rules no longer apply is
    // not-applicable: drop it so it never blocks closing the ticket and never
    // times out to failed.
    for (const [id, watch] of Object.entries(next)) {
      if (watch.key !== p.key || chosenIds.has(id)) continue;
      delete next[id];
      changed = true;
    }
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
  for (const [id, watch] of Object.entries(next)) {
    if (watch.state === "deployed" || watch.state === "failed") continue;
    if (!matchesTarget(target, watch.repo, watch.environment)) continue;
    // The doorbell's own environment has to be the target's too; the caller
    // matched the repo already, and a doorbell for another environment is not
    // this target's.
    if (deployment.environment.toLowerCase() !== watch.environment.toLowerCase()) continue;
    next[id] = {
      ...watch,
      state: failed ? "failed" : "deploying",
      deploymentId: deployment.id,
      deploymentState: deployment.state,
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

/**
 * Whether a run is one a deployment target names (BB-61). A playbook lists a
 * workflow by file path (`.github/workflows/bb-server.yaml`), its basename
 * (`bb-server.yaml`) or its name (`bb-server`), matched ignoring case. An
 * empty list matches nothing, so a target with no `workflows` behaves exactly
 * as before.
 */
export function matchesWorkflow(target: Pick<DeploymentTarget, "workflows">, run: WorkflowRun): boolean {
  if (target.workflows.length === 0) return false;
  const file = run.workflow.trim().toLowerCase();
  const base = file.split("/").pop() ?? "";
  const name = run.name.trim().toLowerCase();
  return target.workflows.some((w) => {
    const want = w.trim().toLowerCase();
    return want !== "" && (want === file || want === base || want === name);
  });
}

/** One workflow-run event's dedupe key: the run's entity id and its attempt. */
export const workflowRunKey = (id: string, runAttempt: number): string => `${id.toLowerCase()}#${runAttempt}`;

/** The watches on a repository that are still awaiting a deployment, for a run wake's list. */
export const awaitingOnRepo = (deployments: Deployments, repo: string): DeploymentWatch[] =>
  Object.values(deployments).filter((w) => (w.state === "merged" || w.state === "deploying") && w.repo.toLowerCase() === repo.toLowerCase());

/**
 * Apply a `workflow_run` doorbell to a binding's watches (BB-61): every watch
 * for the run's repository that is still awaiting a deployment is recorded as
 * having heard this run and attempt, and the steward is woken once for it.
 * The watch's deployment state is not moved: the plugin forwards only the
 * fact that a named workflow failed, and the steward applies its playbook as
 * for a timeout. `receivedAt` is when the doorbell reached the server; a
 * watch recorded after that (its merge came later) is not woken, since the
 * run cannot concern it, but the event is still recorded on it so a repeat
 * delivery of the same run and attempt does not wake it later. The doorbell
 * carries no run start or completion time, so arrival is the only clock there
 * is, and the run's `sha` is never matched: it is usually the deploying
 * repository's commit, not the merge's. `woken` is the watches this event is
 * news for; `recorded` is every watch that now carries the key, which the
 * caller must persist even when nothing is woken, or a repeat delivery would
 * wake an arrival-skipped watch later.
 */
export function applyWorkflowRun(deployments: Deployments, id: string, repo: string, run: WorkflowRun, receivedAt: number, runStartedAt: number | null = null): { deployments: Deployments; woken: string[]; recorded: string[] } {
  const key = workflowRunKey(id, run.run_attempt);
  // The run's own start is the clock when it is known (BB-132); the doorbell's
  // arrival is the fallback. A run that started before a watch's merge cannot
  // concern it, so that watch is recorded but not woken.
  const startedAt = runStartedAt ?? receivedAt;
  const next = { ...deployments };
  const woken: string[] = [];
  const recorded: string[] = [];
  for (const [id, watch] of Object.entries(next)) {
    if (watch.state !== "merged" && watch.state !== "deploying") continue;
    if (watch.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (watch.workflowRuns.includes(key)) continue;
    next[id] = { ...watch, workflowRuns: [...watch.workflowRuns, key] };
    recorded.push(watch.key);
    if ((watch.mergedAt ?? watch.at) <= startedAt) woken.push(watch.key);
  }
  return { deployments: next, woken, recorded };
}

/**
 * Apply the newest deployment from a source read (BB-59). A merge carried by a
 * deployment that already exists is confirmed on the steward's next read, not
 * only by a doorbell, so a missed doorbell costs a sweep rather than the
 * timeout. Unlike a doorbell, a read repeats what it finds: a deployment
 * already recorded with the same state is not news, and a deployment older
 * than the one a watch holds never moves it backwards. Returns the deployment
 * that was news, or null when nothing changed.
 */
export function applyDeploymentRead(
  deployments: Deployments,
  target: Pick<DeploymentTarget, "repo" | "environment" | "timeout">,
  read: readonly Deployment[],
  now: number,
): { deployments: Deployments; changed: string[]; deployment: Deployment | null } {
  const latest = read.filter((d) => d.environment.toLowerCase() === target.environment.toLowerCase()).sort((a, b) => b.id - a.id)[0];
  if (latest === undefined) return { deployments, changed: [], deployment: null };
  const failed = latest.state === "failure" || latest.state === "error";
  const next = { ...deployments };
  const changed: string[] = [];
  for (const [id, watch] of Object.entries(next)) {
    if (watch.state === "deployed" || watch.state === "failed") continue;
    if (!matchesTarget(target, watch.repo, watch.environment)) continue;
    if (latest.environment.toLowerCase() !== watch.environment.toLowerCase()) continue;
    // The read repeats; the same deployment in the same state is not news.
    if (watch.deploymentId === latest.id && watch.deploymentState === latest.state) continue;
    // A read can only move a watch forward; an older deployment is stale.
    if (watch.deploymentId !== null && latest.id < watch.deploymentId) continue;
    next[id] = {
      ...watch,
      state: failed ? "failed" : "deploying",
      deploymentId: latest.id,
      deploymentState: latest.state,
      ref: latest.ref === "" ? null : latest.ref,
      sha: latest.sha === "" ? null : latest.sha,
      url: latest.url,
      at: now,
      deadlineAt: failed ? null : now + target.timeout,
      note: failed ? `Deployment ${latest.id} reported ${latest.state}` : watch.note,
    };
    changed.push(watch.key);
  }
  return changed.length === 0 ? { deployments, changed, deployment: null } : { deployments: next, changed, deployment: latest };
}

/** The watches still awaiting a deployment whose deadline has passed, by map id. */
export const timeoutsDue = (deployments: Deployments, now: number): string[] =>
  Object.entries(deployments)
    .filter(([, w]) => (w.state === "merged" || w.state === "deploying") && w.deadlineAt !== null && now >= w.deadlineAt)
    .map(([id]) => id);

/** Mark timed-out watches failed, so the steward is woken once and the state does not flap. */
export function timeOut(deployments: Deployments, ids: readonly string[], now: number): Deployments {
  const next = { ...deployments };
  const wanted = new Set(ids);
  for (const [id, watch] of Object.entries(next)) {
    if (!wanted.has(id)) continue;
    next[id] = { ...watch, state: "failed", at: now, deadlineAt: null, note: watch.note ?? "No matching deployment within the playbook's timeout" };
  }
  return next;
}

/** What a steward reports about a deployment: whether it carries the merge, or that it failed. */
export const deploymentReportSchema = z.object({
  state: z.enum(["deployed", "failed", "not-yet"]),
  /** The pull request key, when the binding watches more than one. */
  key: z.string().trim().min(1).max(300).optional(),
  /** The deployment target's name, when the binding watches more than one (BB-132). */
  target: z.string().trim().min(1).max(200).optional(),
  /** The deployment id, when the steward is answering a specific doorbell. */
  deploymentId: z.number().int().nonnegative().optional(),
  note: z.string().trim().max(2000).optional(),
});
export type DeploymentReport = z.infer<typeof deploymentReportSchema>;

/** The watch a report names: by key (and target, when named), by deployment id, or the only unsettled one. */
export function pickWatch(deployments: Deployments, report: DeploymentReport): DeploymentWatch | null {
  const all = Object.values(deployments);
  if (report.key !== undefined) {
    const matches = all.filter((w) => w.key.toLowerCase() === report.key!.toLowerCase());
    if (report.target !== undefined) return matches.find((w) => w.target.toLowerCase() === report.target!.toLowerCase()) ?? null;
    return matches[0] ?? null;
  }
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
  const entry = Object.entries(deployments).find(([, w]) => w === watch);
  if (entry === undefined) return { deployments, changed: null };
  const [id] = entry;
  const next = { ...deployments };
  const note = report.note ?? null;
  if (report.state === "deployed") next[id] = { ...watch, state: "deployed", at: now, deadlineAt: null, note };
  else if (report.state === "failed") next[id] = { ...watch, state: "failed", at: now, deadlineAt: null, note: note ?? watch.note };
  // A deployment that does not carry the merge is not settled: it keeps a
  // fresh deadline, so another deployment, or the timeout, still wakes the
  // steward within the playbook's time.
  else next[id] = { ...watch, state: "merged", at: now, deadlineAt: now + timeoutMs, note: note ?? "The deployment does not carry this merge yet" };
  return { deployments: next, changed: next[id]! };
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
      const named = w.target !== "" && w.target !== `${w.repo}@${w.environment}` ? ` [${w.target}]` : "";
      const facts = [
        w.deploymentId === null ? null : `deployment ${w.deploymentId}`,
        w.ref === null ? null : `ref ${w.ref}`,
        w.sha === null ? null : `sha ${w.sha.slice(0, 7)}`,
        w.url === null ? null : w.url,
      ].filter((x): x is string => x !== null);
      return `${w.key}${named}: ${w.state} ${where}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}${w.note === null ? "" : ` — ${w.note}`}`;
    });
}
