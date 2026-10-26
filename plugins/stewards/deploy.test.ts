import { describe, expect, it } from "vitest";
import { pull } from "./fixtures.js";
import type { DeploymentTarget } from "./config.js";
import { allDeployed, applyDeployment, applyDeploymentRead, applyWorkflowRun, awaitingOnRepo, deploymentLines, deploymentsSchema, matchesTarget, matchesWorkflow, mergedPulls, recordMerged, reportDeployment, timeOut, timeoutsDue, workflowRunKey, type Deployments } from "./deploy.js";
import type { Deployment, WorkflowRun } from "./source-contract.js";
import type { Observed } from "./store.js";

const target: DeploymentTarget = { source: "github", repo: "acme/bb-gate", environment: "production", carries: "the pinned ref contains the merge", timeout: 3_600_000, workflows: [] };
const named: DeploymentTarget = { ...target, workflows: ["bb-server.yaml"] };
const NOW = Date.parse("2026-10-14T15:00:00Z");

const observed = (over: { entity?: ReturnType<typeof pull>; pulls?: Array<ReturnType<typeof pull>> } = {}): Observed => ({
  entity: over.entity ?? pull({ key: "acme/web#7" }, { merged: true }),
  pulls: over.pulls ?? [],
});

const deployment = (over: Partial<Deployment> = {}): Deployment => ({ id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", state: "success", url: "https://github.com/acme/bb-gate/actions/runs/9", ...over });

describe("recording merged pull requests", () => {
  it("records a merged pull request once, with the target and a deadline", () => {
    const first = recordMerged({}, observed(), target, NOW);
    expect(first).toEqual({
      "acme/web#7": {
        key: "acme/web#7",
        state: "merged",
        mergeSha: "aaaaaaa1",
        repo: "acme/bb-gate",
        environment: "production",
        deploymentId: null,
        deploymentState: null,
        ref: null,
        sha: null,
        url: null,
        at: NOW,
        deadlineAt: NOW + target.timeout,
        note: null,
        workflowRuns: [],
      },
    });
    // A second read does not reset the deadline or the merge sha.
    expect(recordMerged(first, observed(), target, NOW + 1000)).toBe(first);
  });

  it("does not record an open pull request, and reads a ticket's linked merged ones", () => {
    expect(recordMerged({}, observed({ entity: pull({ key: "acme/web#7" }, { merged: false }) }), target, NOW)).toEqual({});
    const linked = recordMerged({}, observed({ entity: pull({ key: "acme/web#7", kind: "pull" }, { merged: false }), pulls: [pull({ key: "acme/web#8" }, { merged: true })] }), target, NOW);
    expect(Object.keys(linked)).toEqual(["acme/web#8"]);
  });

  it("treats a pull request whose state is merged as merged", () => {
    expect(mergedPulls({ entity: pull({ state: "merged" }, { merged: false }), pulls: [] })).toHaveLength(1);
  });
});

describe("applying a deployment doorbell", () => {
  it("matches the target repo and environment, ignoring case, and moves the watch to deploying", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    expect(matchesTarget(target, "Acme/BB-Gate", "Production")).toBe(true);
    expect(matchesTarget(target, "acme/other", "production")).toBe(false);
    const applied = applyDeployment(deployments, target, deployment(), NOW + 60_000);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentId: 7, ref: "main", sha: "bbbbbbb2", url: "https://github.com/acme/bb-gate/actions/runs/9", deadlineAt: NOW + 60_000 + target.timeout });
  });

  it("marks a failure or error deployment failed, with the deployment's URL", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    for (const state of ["failure", "error"]) {
      const applied = applyDeployment(deployments, target, deployment({ state }), NOW);
      expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "failed", note: `Deployment 7 reported ${state}` });
    }
  });

  it("ignores a doorbell for another repo or environment, and one for a settled watch", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    expect(applyDeployment(deployments, target, deployment({ environment: "staging" }), NOW).changed).toEqual([]);
    expect(applyDeployment(deployments, { ...target, repo: "acme/other" }, deployment(), NOW).changed).toEqual([]);
    const settled: Deployments = { "acme/web#7": { ...deployments["acme/web#7"]!, state: "deployed" } };
    expect(applyDeployment(settled, target, deployment(), NOW).changed).toEqual([]);
  });
});

describe("the no-deployment timeout", () => {
  it("reports a watch past its deadline, and marking it failed is idempotent", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    expect(timeoutsDue(deployments, NOW + target.timeout - 1)).toEqual([]);
    expect(timeoutsDue(deployments, NOW + target.timeout)).toEqual(["acme/web#7"]);
    const failed = timeOut(deployments, ["acme/web#7"], NOW + target.timeout);
    expect(failed["acme/web#7"]).toMatchObject({ state: "failed", deadlineAt: null });
    expect(timeoutsDue(failed, NOW + target.timeout + 1000)).toEqual([]);
  });

  it("keeps a deadline while deploying, so a deployment with no final status still times out", () => {
    const applied = applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment(), NOW);
    expect(timeoutsDue(applied.deployments, NOW + target.timeout - 1)).toEqual([]);
    expect(timeoutsDue(applied.deployments, NOW + target.timeout)).toEqual(["acme/web#7"]);
  });
});

describe("the steward's verdict", () => {
  const deploying = () => applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment(), NOW).deployments;

  it("settles a watch on deployed, and reports all deployed", () => {
    const result = reportDeployment(deploying(), { state: "deployed" }, NOW + 1000, target.timeout);
    expect(result.changed).toMatchObject({ key: "acme/web#7", state: "deployed", deadlineAt: null });
    expect(allDeployed(result.deployments)).toBe(true);
    expect(allDeployed({})).toBe(false);
  });

  it("puts a deployment that does not carry the merge back to awaiting, with a fresh deadline", () => {
    const result = reportDeployment(deploying(), { state: "not-yet", note: "ref does not pin the merge" }, NOW + 1000, target.timeout);
    expect(result.changed).toMatchObject({ state: "merged", note: "ref does not pin the merge", deadlineAt: NOW + 1000 + target.timeout });
    expect(allDeployed(result.deployments)).toBe(false);
  });

  it("marks a failed deployment failed", () => {
    const result = reportDeployment(deploying(), { state: "failed", note: "run 9 red" }, NOW + 1000, target.timeout);
    expect(result.changed).toMatchObject({ state: "failed", note: "run 9 red" });
  });

  it("picks the watch a report names, by key or deployment id", () => {
    const two = recordMerged(recordMerged({}, observed(), target, NOW), observed({ entity: pull({ key: "acme/web#8" }, { merged: true }) }), target, NOW);
    expect(reportDeployment(two, { state: "deployed", key: "ACME/WEB#8" }, NOW, target.timeout).changed?.key).toBe("acme/web#8");
    const withDeployment = applyDeployment(two, target, deployment(), NOW).deployments;
    expect(reportDeployment(withDeployment, { state: "deployed", deploymentId: 7 }, NOW, target.timeout).changed?.key).toBe("acme/web#7");
    // No key and more than one unsettled watch: nothing is picked.
    expect(reportDeployment(two, { state: "deployed" }, NOW, target.timeout).changed).toBeNull();
  });
});

describe("confirming from a deployment read (BB-59)", () => {
  it("applies the newest deployment for the target and records its facts", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    const read = [deployment({ id: 6, state: "failure", url: "https://example.test/6" }), deployment({ id: 7, state: "success" })];
    const applied = applyDeploymentRead(deployments, target, read, NOW + 60_000);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployment).toMatchObject({ id: 7, state: "success" });
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentId: 7, deploymentState: "success", ref: "main", sha: "bbbbbbb2", url: "https://github.com/acme/bb-gate/actions/runs/9", deadlineAt: NOW + 60_000 + target.timeout });
  });

  it("treats a failed newest deployment as the failure it is", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    const applied = applyDeploymentRead(deployments, target, [deployment({ state: "failure", url: "https://example.test/12" })], NOW);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "failed", deploymentState: "failure", deadlineAt: null, note: "Deployment 7 reported failure" });
  });

  it("changes nothing when the target's environment has no deployments", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    expect(applyDeploymentRead(deployments, target, [], NOW)).toEqual({ deployments, changed: [], deployment: null });
    expect(applyDeploymentRead(deployments, target, [deployment({ environment: "staging" })], NOW).changed).toEqual([]);
  });

  it("does not re-wake for a deployment it already recorded with the same state, but does for a new state", () => {
    const first = applyDeploymentRead(recordMerged({}, observed(), target, NOW), target, [deployment({ state: "in_progress" })], NOW);
    expect(first.changed).toEqual(["acme/web#7"]);
    // The same deployment, same state: a repeat read is not news.
    expect(applyDeploymentRead(first.deployments, target, [deployment({ state: "in_progress" })], NOW + 1000).changed).toEqual([]);
    // The same deployment reaching success is news.
    const second = applyDeploymentRead(first.deployments, target, [deployment({ state: "success" })], NOW + 2000);
    expect(second.changed).toEqual(["acme/web#7"]);
    expect(second.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentState: "success" });
  });

  it("never moves a watch backwards to an older deployment", () => {
    const held = applyDeploymentRead(recordMerged({}, observed(), target, NOW), target, [deployment({ id: 9, state: "success" })], NOW).deployments;
    expect(applyDeploymentRead(held, target, [deployment({ id: 7, state: "success" })], NOW + 1000).changed).toEqual([]);
    expect(held["acme/web#7"]).toMatchObject({ deploymentId: 9 });
  });

  it("leaves a settled watch alone", () => {
    const settled = applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment(), NOW).deployments;
    const done = reportDeployment(settled, { state: "deployed" }, NOW, target.timeout).deployments;
    expect(applyDeploymentRead(done, target, [deployment({ id: 8, state: "success" })], NOW + 1000).changed).toEqual([]);
  });
});

// BB-61: a failed (or cancelled/timed-out) run of a workflow a deployment
// target names wakes every watch still awaiting a deployment, once per run
// and attempt, without moving the watch's state.
describe("a failed workflow run (BB-61)", () => {
  const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({ workflow: ".github/workflows/bb-server.yaml", name: "bb-server", conclusion: "failure", url: "https://github.com/acme/bb-gate/actions/runs/42", sha: "ccccccc3", run_attempt: 1, ...over });
  const mergedWatch = () => recordMerged({}, observed(), target, NOW);

  it("matches a workflow by path, basename or name, ignoring case, and nothing when the list is empty", () => {
    expect(matchesWorkflow(named, run())).toBe(true);
    expect(matchesWorkflow({ workflows: [".github/workflows/bb-server.yaml"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["BB-SERVER.YAML"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["bb-server"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["image.yaml"] }, run())).toBe(false);
    expect(matchesWorkflow(target, run())).toBe(false);
  });

  it("wakes an awaiting watch once per run and attempt, leaving its state alone", () => {
    const first = applyWorkflowRun(mergedWatch(), "acme/bb-gate#42", "acme/bb-gate", run(), NOW + 1000);
    expect(first.woken).toEqual(["acme/web#7"]);
    expect(first.deployments["acme/web#7"]).toMatchObject({ state: "merged", workflowRuns: ["acme/bb-gate#42#1"] });
    // The same run and attempt is not news, however often it is delivered.
    const repeat = applyWorkflowRun(first.deployments, "acme/bb-gate#42", "acme/bb-gate", run(), NOW + 2000);
    expect(repeat.woken).toEqual([]);
    expect(repeat.deployments).toEqual(first.deployments);
    // A re-run (a higher attempt) wakes again.
    const again = applyWorkflowRun(first.deployments, "acme/bb-gate#42", "acme/bb-gate", run({ run_attempt: 2 }), NOW + 3000);
    expect(again.woken).toEqual(["acme/web#7"]);
  });

  it("skips another repo, a settled watch, and a watch recorded after the doorbell arrived", () => {
    const deployments = mergedWatch();
    expect(applyWorkflowRun(deployments, "acme/other#42", "acme/other", run(), NOW).woken).toEqual([]);
    const settled: Deployments = { "acme/web#7": { ...deployments["acme/web#7"]!, state: "deployed" } };
    expect(applyWorkflowRun(settled, "acme/bb-gate#42", "acme/bb-gate", run(), NOW).woken).toEqual([]);
    // The watch was recorded after the doorbell arrived: the run cannot concern
    // it, so it is not woken, but the event is recorded on it so a repeat
    // delivery of the same run and attempt does not wake it later.
    const late = applyWorkflowRun(deployments, "acme/bb-gate#42", "acme/bb-gate", run(), NOW - 1);
    expect(late.woken).toEqual([]);
    expect(late.deployments["acme/web#7"]!.workflowRuns).toEqual(["acme/bb-gate#42#1"]);
    expect(applyWorkflowRun(late.deployments, "acme/bb-gate#42", "acme/bb-gate", run(), NOW).woken).toEqual([]);
  });

  it("lists the watches still awaiting a deployment on a repo, and keys an event by run and attempt", () => {
    const deployments = recordMerged(recordMerged({}, observed(), target, NOW), observed({ entity: pull({ key: "acme/web#8" }, { merged: true }) }), target, NOW);
    expect(awaitingOnRepo(deployments, "Acme/BB-Gate").map((w) => w.key)).toEqual(["acme/web#7", "acme/web#8"]);
    expect(workflowRunKey("Acme/BB-Gate#42", 2)).toBe("acme/bb-gate#42#2");
  });
});

describe("the show lines", () => {
  it("names each watch's state, target, deployment facts and note", () => {
    const deployments = applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment({ state: "failure" }), NOW).deployments;
    expect(deploymentLines(deployments)).toEqual(["acme/web#7: failed → acme/bb-gate production (deployment 7, ref main, sha bbbbbbb, https://github.com/acme/bb-gate/actions/runs/9) — Deployment 7 reported failure"]);
  });

  it("round-trips through the store schema", () => {
    const deployments = recordMerged({}, observed(), target, NOW);
    expect(deploymentsSchema.parse(JSON.parse(JSON.stringify(deployments)))).toEqual(deployments);
  });
});
