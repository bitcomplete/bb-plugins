import { describe, expect, it } from "vitest";
import { pull } from "./fixtures.js";
import type { DeploymentTarget } from "./config.js";
import { allDeployed, applyDeployment, deploymentLines, deploymentsSchema, matchesTarget, mergedPulls, recordMerged, reportDeployment, timeOut, timeoutsDue, type Deployments } from "./deploy.js";
import type { Deployment } from "./source-contract.js";
import type { Observed } from "./store.js";

const target: DeploymentTarget = { source: "github", repo: "acme/bb-gate", environment: "production", carries: "the pinned ref contains the merge", timeout: 3_600_000 };
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
        ref: null,
        sha: null,
        url: null,
        at: NOW,
        deadlineAt: NOW + target.timeout,
        note: null,
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
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentId: 7, ref: "main", sha: "bbbbbbb2", url: "https://github.com/acme/bb-gate/actions/runs/9", deadlineAt: null });
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

  it("does not time out a watch that already has a deployment", () => {
    const applied = applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment(), NOW);
    expect(timeoutsDue(applied.deployments, NOW + target.timeout * 10)).toEqual([]);
  });
});

describe("the steward's verdict", () => {
  const deploying = () => applyDeployment(recordMerged({}, observed(), target, NOW), target, deployment(), NOW).deployments;

  it("settles a watch on deployed, and reports all deployed", () => {
    const result = reportDeployment(deploying(), { state: "deployed" }, NOW + 1000);
    expect(result.changed).toMatchObject({ key: "acme/web#7", state: "deployed", deadlineAt: null });
    expect(allDeployed(result.deployments)).toBe(true);
    expect(allDeployed({})).toBe(false);
  });

  it("puts a deployment that does not carry the merge back to awaiting", () => {
    const result = reportDeployment(deploying(), { state: "not-yet", note: "ref does not pin the merge" }, NOW + 1000);
    expect(result.changed).toMatchObject({ state: "merged", note: "ref does not pin the merge" });
    expect(allDeployed(result.deployments)).toBe(false);
  });

  it("marks a failed deployment failed", () => {
    const result = reportDeployment(deploying(), { state: "failed", note: "run 9 red" }, NOW + 1000);
    expect(result.changed).toMatchObject({ state: "failed", note: "run 9 red" });
  });

  it("picks the watch a report names, by key or deployment id", () => {
    const two = recordMerged(recordMerged({}, observed(), target, NOW), observed({ entity: pull({ key: "acme/web#8" }, { merged: true }) }), target, NOW);
    expect(reportDeployment(two, { state: "deployed", key: "ACME/WEB#8" }, NOW).changed?.key).toBe("acme/web#8");
    const withDeployment = applyDeployment(two, target, deployment(), NOW).deployments;
    expect(reportDeployment(withDeployment, { state: "deployed", deploymentId: 7 }, NOW).changed?.key).toBe("acme/web#7");
    // No key and more than one unsettled watch: nothing is picked.
    expect(reportDeployment(two, { state: "deployed" }, NOW).changed).toBeNull();
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
