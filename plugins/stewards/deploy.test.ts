import { describe, expect, it } from "vitest";
import { pull } from "./fixtures.js";
import type { DeploymentTarget } from "./config.js";
import { allDeployed, applyDeployment, applyDeploymentRead, applyWorkflowRun, awaitingOnRepo, deploymentLines, deploymentsSchema, matchesTarget, matchesWorkflow, mergedPulls, recordMerged, reportDeployment, timeOut, timeoutsDue, workflowRunKey, type Deployments } from "./deploy.js";
import type { Deployment, WorkflowRun } from "./source-contract.js";
import type { Observed } from "./store.js";

const target: DeploymentTarget = { source: "github", repo: "acme/web", environment: "production", carries: "the pinned ref contains the merge", timeout: 3_600_000, workflows: [] };
const named: DeploymentTarget = { ...target, workflows: ["build.yaml"] };
// The two-target playbook front matter (BB-132 follow-up): structured rules,
// disjoint repos, so a merge is watched only where a rule can carry it.
const bbGateTarget: DeploymentTarget = {
  name: "web",
  source: "github",
  repo: "acme/web",
  environment: "production",
  carries: [
    { when: { repo: "acme/app" }, strategy: { kind: "ref-contains-merge" } },
    { when: { repo: "acme/web" }, strategy: { kind: "ref-contains-merge" } },
  ],
  timeout: 3_600_000,
  workflows: [],
};
const toolsTarget: DeploymentTarget = {
  name: "tools",
  source: "github",
  repo: "acme/tools",
  environment: "production",
  carries: [{ when: { repo: "acme/tools" }, strategy: { kind: "ref-contains-merge" } }],
  timeout: 3_600_000,
  workflows: [],
};
// The split web rule (BB-260): deploy and backend.json wait for the apply,
// .bb/docs/markdown are live at merge, and anything else builds the router.
const liveAtMergeTarget: DeploymentTarget = {
  name: "web",
  source: "github",
  repo: "acme/web",
  environment: "production",
  carries: [
    { when: { repo: "acme/web", paths: ["deploy/**", "backend.json"] }, strategy: { kind: "ref-contains-merge" } },
    { when: { repo: "acme/web", paths: [".bb/**", "docs/**", "**.md"] }, strategy: { kind: "live-at-merge" } },
    { when: { repo: "acme/web" }, strategy: { kind: "image-tag", manifest: "deploy/kustomization.yaml", image: "web", workflow: "image.yaml" } },
  ],
  timeout: 3_600_000,
  workflows: [],
};
const NOW = Date.parse("2026-10-14T15:00:00Z");

const observed = (over: { entity?: ReturnType<typeof pull>; pulls?: Array<ReturnType<typeof pull>> } = {}): Observed => ({
  entity: over.entity ?? pull({ key: "acme/web#7" }, { merged: true, mergeCommit: "aaaaaaa1" }),
  pulls: over.pulls ?? [],
});

const deployment = (over: Partial<Deployment> = {}): Deployment => ({ id: 7, environment: "production", ref: "main", sha: "bbbbbbb2", state: "success", url: "https://github.com/acme/web/actions/runs/9", ...over });

describe("recording merged pull requests", () => {
  it("records a merged pull request once, with the target and a deadline", () => {
    const first = recordMerged({}, observed(), [target], NOW);
    expect(first).toEqual({
      "acme/web#7": {
        key: "acme/web#7",
        state: "merged",
        mergeSha: "aaaaaaa1",
        target: "",
        mergedAt: NOW,
        prRepo: "acme/web",
        files: [],
        repo: "acme/web",
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
    expect(recordMerged(first, observed(), [target], NOW + 1000)).toBe(first);
  });

  it("stores the merge commit, not the head, and notes an unknown oid", () => {
    const merged = pull({ key: "acme/web#9" }, { merged: true, headSha: "headsha1", mergeCommit: "mergesha" });
    const deployments = recordMerged({}, { entity: merged, pulls: [] }, [target], NOW);
    expect(deployments["acme/web#9"]).toMatchObject({ mergeSha: "mergesha" });
    const unknown = pull({ key: "acme/web#10" }, { merged: true, headSha: "headsha2", mergeCommit: null });
    const noted = recordMerged({}, { entity: unknown, pulls: [] }, [target], NOW);
    expect(noted["acme/web#10"]).toMatchObject({ mergeSha: null, note: expect.stringMatching(/merge commit is not known/u) });
  });

  it("re-resolves a stored PR-head merge sha to the merge commit, keeping a settled watch's note", () => {
    const before = recordMerged({}, { entity: pull({ key: "acme/web#11" }, { merged: true, headSha: "headsha3", mergeCommit: null }), pulls: [] }, [target], NOW);
    const after = recordMerged(before, { entity: pull({ key: "acme/web#11" }, { merged: true, headSha: "headsha3", mergeCommit: "mergesha3" }), pulls: [] }, [target], NOW + 1000);
    expect(after["acme/web#11"]).toMatchObject({ mergeSha: "mergesha3", note: expect.stringMatching(/re-resolved/u) });
    // A settled watch's own note is kept, not overwritten.
    const failed = { ...before, "acme/web#11": { ...before["acme/web#11"]!, state: "failed" as const, note: "Deployment 7 reported failure" } };
    const resolved = recordMerged(failed, { entity: pull({ key: "acme/web#11" }, { merged: true, headSha: "headsha3", mergeCommit: "mergesha3" }), pulls: [] }, [target], NOW + 2000);
    expect(resolved["acme/web#11"]!.note).toBe("Deployment 7 reported failure (Merge commit re-resolved to mergesh)");
  });

  // BB-259: a `merged` watch whose sha is re-resolved while it already holds a
  // success deployment is put back to `deploying`, so the reconcile's carries
  // re-evaluation loop settles it in the same pass, and the stale not-yet note
  // is replaced rather than left to contradict the re-resolved sha.
  it("re-evaluates a merged watch that holds a success deployment when its merge sha is re-resolved (BB-259)", () => {
    const before = recordMerged({}, { entity: pull({ key: "acme/web#12" }, { merged: true, headSha: "headsha4", mergeCommit: "stacked1" }), pulls: [] }, [target], NOW);
    const deploying = applyDeployment(before, target, deployment(), NOW + 1000).deployments;
    const notYet = reportDeployment(deploying, { state: "not-yet", note: "image-tag: run 1 pinned stacked1, which does not contain merge stacked1" }, NOW + 2000, target.timeout).deployments;
    expect(notYet["acme/web#12"]).toMatchObject({ state: "merged", deploymentId: 7, deploymentState: "success" });
    const after = recordMerged(notYet, { entity: pull({ key: "acme/web#12" }, { merged: true, headSha: "headsha4", mergeCommit: "base0001" }), pulls: [] }, [target], NOW + 3000);
    expect(after["acme/web#12"]).toMatchObject({ state: "deploying", mergeSha: "base0001", deploymentId: 7, deploymentState: "success", note: "Merge commit re-resolved to base000" });
  });

  it("leaves a re-resolved watch merged when it holds no success deployment (BB-259)", () => {
    const before = recordMerged({}, { entity: pull({ key: "acme/web#13" }, { merged: true, headSha: "headsha5", mergeCommit: null }), pulls: [] }, [target], NOW);
    const after = recordMerged(before, { entity: pull({ key: "acme/web#13" }, { merged: true, headSha: "headsha5", mergeCommit: "mergesha5" }), pulls: [] }, [target], NOW + 1000);
    expect(after["acme/web#13"]).toMatchObject({ state: "merged", mergeSha: "mergesha5", deploymentId: null });
  });

  it("keys two targets on one pull request independently, and a single unnamed target as before", () => {
    const tools: DeploymentTarget = { ...target, repo: "acme/tools", environment: "production", name: "tools" };
    const both = recordMerged({}, observed(), [target, tools], NOW);
    expect(Object.keys(both).sort()).toEqual(["acme/web#7::acme/web@production", "acme/web#7::tools"]);
    expect(both["acme/web#7::tools"]).toMatchObject({ key: "acme/web#7", target: "tools", repo: "acme/tools" });
    expect(both["acme/web#7::acme/web@production"]).toMatchObject({ key: "acme/web#7", target: "acme/web@production", repo: "acme/web" });
    // A single unnamed target keeps today's key.
    expect(Object.keys(recordMerged({}, observed(), [target], NOW))).toEqual(["acme/web#7"]);
  });

  it("migrates a legacy single-target watch to the keyed form when a second target appears", () => {
    const tools: DeploymentTarget = { ...target, repo: "acme/tools", environment: "production", name: "tools" };
    const legacy = recordMerged({}, observed(), [target], NOW);
    const migrated = recordMerged(legacy, observed(), [target, tools], NOW + 1000);
    expect(Object.keys(migrated).sort()).toEqual(["acme/web#7::acme/web@production", "acme/web#7::tools"]);
    expect(migrated["acme/web#7::acme/web@production"]).toMatchObject({ key: "acme/web#7", target: "acme/web@production", repo: "acme/web", mergeSha: "aaaaaaa1" });
    expect(migrated["acme/web#7::tools"]).toMatchObject({ key: "acme/web#7", target: "tools", repo: "acme/tools" });
  });

  // BB-132 follow-up: a target whose structured rules do not match the merge
  // gets no watch, so it never sits in deploying, times out to failed, or
  // blocks the ticket from closing.
  it("watches only the target whose structured rules match a merge", () => {
    const plugins = { entity: pull({ key: "acme/app#7", unit: "acme/app" }, { merged: true, mergeCommit: "aaaaaaa1", files: ["plugins/stewards/deploy.ts"] }), pulls: [] };
    const gateOnly = recordMerged({}, plugins, [bbGateTarget, toolsTarget], NOW);
    expect(Object.keys(gateOnly)).toEqual(["acme/app#7::web"]);
    expect(gateOnly["acme/app#7::web"]).toMatchObject({ key: "acme/app#7", target: "web", repo: "acme/web", prRepo: "acme/app" });

    const dev = { entity: pull({ key: "acme/tools#9", unit: "acme/tools" }, { merged: true, mergeCommit: "bbbbbbb2", files: ["gate/server.go"] }), pulls: [] };
    const toolsOnly = recordMerged({}, dev, [bbGateTarget, toolsTarget], NOW);
    expect(Object.keys(toolsOnly)).toEqual(["acme/tools#9::tools"]);
    expect(toolsOnly["acme/tools#9::tools"]).toMatchObject({ key: "acme/tools#9", target: "tools", repo: "acme/tools", prRepo: "acme/tools" });
  });

  it("drops a stored watch on a target whose structured rules do not apply", () => {
    const plugins = { entity: pull({ key: "acme/app#7", unit: "acme/app" }, { merged: true, mergeCommit: "aaaaaaa1", files: ["plugins/stewards/deploy.ts"] }), pulls: [] };
    // A watch recorded before the filtering existed, on the tools target.
    const stale = recordMerged({}, plugins, [toolsTarget], NOW);
    expect(Object.keys(stale)).toEqual(["acme/app#7::tools"]);
    const fixed = recordMerged(stale, plugins, [bbGateTarget, toolsTarget], NOW + 1000);
    expect(Object.keys(fixed)).toEqual(["acme/app#7::web"]);
  });

  it("keeps an in-flight paths-gated watch when a later read's files list is empty", () => {
    const pathsTarget: DeploymentTarget = {
      name: "web",
      source: "github",
      repo: "acme/web",
      environment: "production",
      carries: [{ when: { repo: "acme/web", paths: ["docker/app/**"] }, strategy: { kind: "ref-contains-merge" } }],
      timeout: 3_600_000,
      workflows: [],
    };
    const withFiles = { entity: pull({ key: "acme/web#4", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files: ["docker/app/Dockerfile"] }), pulls: [] };
    const recorded = recordMerged({}, withFiles, [pathsTarget], NOW);
    expect(Object.keys(recorded)).toEqual(["acme/web#4::web"]);
    // The stored watch's own files decide, so an empty fresh list neither
    // drops it nor brings in the other target.
    const empty = { entity: pull({ key: "acme/web#4", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files: [] }), pulls: [] };
    const again = recordMerged(recorded, empty, [pathsTarget, toolsTarget], NOW + 1000);
    expect(Object.keys(again)).toEqual(["acme/web#4::web"]);
  });

  it("still watches a merge no target's rules match, on the steward-decided path", () => {
    const other = { entity: pull({ key: "acme/other#3", unit: "acme/other" }, { merged: true, mergeCommit: "ccccccc3", files: ["README.md"] }), pulls: [] };
    const deployments = recordMerged({}, other, [bbGateTarget, toolsTarget], NOW);
    expect(Object.keys(deployments).sort()).toEqual(["acme/other#3::tools", "acme/other#3::web"]);
  });

  // BB-260: a merge nothing deploys is `deployed` the moment it is recorded,
  // with no deadline, so the steward is woken without waiting for any
  // deployment.
  it("marks a .bb-only merge deployed at merge, with no deadline", () => {
    const bbOnly = { entity: pull({ key: "acme/web#4", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files: [".bb/stewards/project.json"] }), pulls: [] };
    const recorded = recordMerged({}, bbOnly, [liveAtMergeTarget], NOW);
    expect(Object.keys(recorded)).toEqual(["acme/web#4::web"]);
    expect(recorded["acme/web#4::web"]).toMatchObject({ state: "deployed", deadlineAt: null, note: "live-at-merge: nothing deploys .bb/**, docs/**, **.md" });
    // Nothing times out and nothing awaits a deployment.
    expect(timeoutsDue(recorded, NOW + liveAtMergeTarget.timeout)).toEqual([]);
    expect(awaitingOnRepo(recorded, "acme/web")).toEqual([]);
  });

  it("treats a docs-only or markdown-only merge as live at merge too", () => {
    for (const files of [["docs/design.md"], ["README.md"]]) {
      const merged = { entity: pull({ key: "acme/web#8", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files }), pulls: [] };
      const recorded = recordMerged({}, merged, [liveAtMergeTarget], NOW);
      expect(recorded["acme/web#8::web"]).toMatchObject({ state: "deployed" });
    }
  });

  // BB-292: the web#106 deployment scenario. #106 changed only
  // `.bb/AGENTS.md` and `.bb/stewards/playbooks/linear-tickets.md`, both under
  // the split rule's live-at-merge paths, so the watch settles `deployed` the
  // moment the merge is recorded: no deadline, no deployment read, and the wake
  // that follows names it deployed rather than awaiting.
  it("pins the web#106 scenario: a .bb-only merge is deployed at merge with the wake following it", () => {
    const bb106 = { entity: pull({ key: "acme/web#106", unit: "acme/web" }, { merged: true, mergeCommit: "dc8fb02", files: [".bb/AGENTS.md", ".bb/stewards/playbooks/linear-tickets.md"] }), pulls: [] };
    const recorded = recordMerged({}, bb106, [liveAtMergeTarget], NOW);
    expect(Object.keys(recorded)).toEqual(["acme/web#106::web"]);
    expect(recorded["acme/web#106::web"]).toMatchObject({
      state: "deployed",
      deadlineAt: null,
      note: "live-at-merge: nothing deploys .bb/**, docs/**, **.md",
    });
    // No deployment read is needed: nothing times out and nothing awaits.
    expect(timeoutsDue(recorded, NOW + liveAtMergeTarget.timeout)).toEqual([]);
    expect(awaitingOnRepo(recorded, "acme/web")).toEqual([]);
    expect(allDeployed(recorded)).toBe(true);
    // The wake that follows prints the watch deployed, not awaiting.
    expect(deploymentLines(recorded)).toEqual(["acme/web#106 [web]: deployed → acme/web production — live-at-merge: nothing deploys .bb/**, docs/**, **.md"]);
  });

  it("follows an earlier deploy rule for a mixed PR rather than live-at-merge", () => {
    const mixed = { entity: pull({ key: "acme/web#5", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files: ["deploy/kustomization.yaml", ".bb/stewards/project.json"] }), pulls: [] };
    const recorded = recordMerged({}, mixed, [liveAtMergeTarget], NOW);
    expect(recorded["acme/web#5::web"]).toMatchObject({ state: "merged", deadlineAt: NOW + liveAtMergeTarget.timeout, note: null });
  });

  it("reaches the web image-tag rule for .bb plus router code", () => {
    for (const files of [[".bb/stewards/project.json", "cmd/router/main.go"], [".bb/stewards/project.json", "internal/gate/server.go"]]) {
      const router = { entity: pull({ key: "acme/web#6", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files }), pulls: [] };
      const recorded = recordMerged({}, router, [liveAtMergeTarget], NOW);
      // Awaiting the router image build, not deployed at merge.
      expect(recorded["acme/web#6::web"]).toMatchObject({ state: "merged", deadlineAt: NOW + liveAtMergeTarget.timeout, note: null });
    }
  });

  it("does not deploy an empty or unreadable file list at merge", () => {
    const liveOnly: DeploymentTarget = { ...liveAtMergeTarget, carries: [{ when: { repo: "acme/web", paths: [".bb/**"] }, strategy: { kind: "live-at-merge" } }] };
    for (const files of [[], undefined]) {
      const merged = pull({ key: "acme/web#7", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files });
      const recorded = recordMerged({}, { entity: merged, pulls: [] }, [liveOnly], NOW);
      expect(recorded["acme/web#7::web"]).toMatchObject({ state: "merged" });
    }
  });

  // BB-260: GitHub's changed-files read is capped at 100, so a full page may
  // hide a file outside the paths. It must not be treated as every-file.
  it("does not deploy a merge at GitHub's changed-files page limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => `docs/${i}.md`);
    const merged = pull({ key: "acme/web#9", unit: "acme/web" }, { merged: true, mergeCommit: "aaaaaaa1", files: many });
    const recorded = recordMerged({}, { entity: merged, pulls: [] }, [liveAtMergeTarget], NOW);
    expect(recorded["acme/web#9::web"]).toMatchObject({ state: "merged" });
  });

  // BB-260: a stacked pull request merged into its base branch is not on main,
  // so it is not live at merge. Under bottom-up (BB-264) it is retargeted and
  // merged to main rather than carried by the base's merge, so the live check
  // reads its own base.
  it("does not mark a stacked .bb-only merge deployed before it reaches the default branch", () => {
    const stacked = pull({ key: "acme/web#20", unit: "acme/web" }, { merged: true, mergeCommit: "stacked1", base: "feature-base", head: "feature-stacked", files: [".bb/AGENTS.md"] });
    const isDefaultBase = (_repo: string, base: string | null) => base === "main";
    const recorded = recordMerged({}, { entity: stacked, pulls: [] }, [liveAtMergeTarget], NOW, isDefaultBase);
    expect(recorded["acme/web#20::web"]).toMatchObject({ state: "merged", mergeSha: "stacked1", deadlineAt: NOW + liveAtMergeTarget.timeout });
  });

  // BB-286: a watch recorded under an older playbook is re-matched against
  // the current one on every read, so a rule that is now live-at-merge
  // settles it with no deployment read. The first-record contract above still
  // holds when the rule has not changed.
  it("re-matches a pre-existing merged watch when the playbook's rule becomes live-at-merge (BB-286)", () => {
    const refTarget: DeploymentTarget = { name: "web", source: "github", repo: "acme/web", environment: "production", carries: [{ when: { repo: "acme/web" }, strategy: { kind: "ref-contains-merge" } }], timeout: 3_600_000, workflows: [] };
    const liveTarget: DeploymentTarget = { ...refTarget, carries: [{ when: { repo: "acme/web", paths: [".bb/**"] }, strategy: { kind: "live-at-merge" } }] };
    const mergedPull = { entity: pull({ key: "acme/web#7" }, { merged: true, mergeCommit: "aaaaaaa1", files: [".bb/stewards/project.json"] }), pulls: [] };
    const before = recordMerged({}, mergedPull, [refTarget], NOW);
    expect(before["acme/web#7::web"]).toMatchObject({ state: "merged", deadlineAt: NOW + refTarget.timeout });
    const after = recordMerged(before, mergedPull, [liveTarget], NOW + 1000);
    expect(after["acme/web#7::web"]).toMatchObject({ state: "deployed", deadlineAt: null, note: "live-at-merge: nothing deploys .bb/**" });
    // No deployment read is needed: nothing times out and nothing awaits.
    expect(timeoutsDue(after, NOW + liveTarget.timeout)).toEqual([]);
    expect(awaitingOnRepo(after, "acme/web")).toEqual([]);
  });

  // BB-337: the web#106 watch was recorded under an older playbook whose
  // rule put `.bb/**` under `ref-contains-merge`. The playbook now has
  // `live-at-merge` for it, so the next read settles it `deployed` with the
  // live note, no deadline and no deployment read.
  it("re-matches the web#106 watch from ref-contains-merge to live-at-merge (BB-337)", () => {
    const refTarget: DeploymentTarget = { name: "web", source: "github", repo: "acme/web", environment: "production", carries: [{ when: { repo: "acme/web", paths: [".bb/**"] }, strategy: { kind: "ref-contains-merge" } }], timeout: 3_600_000, workflows: [] };
    const liveTarget: DeploymentTarget = { ...refTarget, carries: [{ when: { repo: "acme/web", paths: [".bb/**"] }, strategy: { kind: "live-at-merge" } }] };
    const bb106 = { entity: pull({ key: "acme/web#106", unit: "acme/web" }, { merged: true, mergeCommit: "dc8fb02", files: [".bb/AGENTS.md", ".bb/stewards/playbooks/linear-tickets.md"] }), pulls: [] };
    const before = recordMerged({}, bb106, [refTarget], NOW);
    expect(before["acme/web#106::web"]).toMatchObject({ state: "merged", deadlineAt: NOW + refTarget.timeout });
    const after = recordMerged(before, bb106, [liveTarget], NOW + 1000);
    expect(after["acme/web#106::web"]).toMatchObject({ state: "deployed", deadlineAt: null, note: "live-at-merge: nothing deploys .bb/**" });
    // No deployment read is needed: nothing times out and nothing awaits.
    expect(timeoutsDue(after, NOW + liveTarget.timeout)).toEqual([]);
    expect(awaitingOnRepo(after, "acme/web")).toEqual([]);
  });

  it("does not record an open pull request, and reads a ticket's linked merged ones", () => {
    expect(recordMerged({}, observed({ entity: pull({ key: "acme/web#7" }, { merged: false }) }), [target], NOW)).toEqual({});
    const linked = recordMerged({}, observed({ entity: pull({ key: "acme/web#7", kind: "pull" }, { merged: false }), pulls: [pull({ key: "acme/web#8" }, { merged: true })] }), [target], NOW);
    expect(Object.keys(linked)).toEqual(["acme/web#8"]);
  });

  it("treats a pull request whose state is merged as merged", () => {
    expect(mergedPulls({ entity: pull({ state: "merged" }, { merged: false }), pulls: [] })).toHaveLength(1);
  });
});

describe("applying a deployment doorbell", () => {
  it("matches the target repo and environment, ignoring case, and moves the watch to deploying", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    expect(matchesTarget(target, "Acme/Web", "Production")).toBe(true);
    expect(matchesTarget(target, "acme/other", "production")).toBe(false);
    const applied = applyDeployment(deployments, target, deployment(), NOW + 60_000);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentId: 7, ref: "main", sha: "bbbbbbb2", url: "https://github.com/acme/web/actions/runs/9", deadlineAt: NOW + 60_000 + target.timeout });
  });

  it("marks a failure or error deployment failed, with the deployment's URL", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    for (const state of ["failure", "error"]) {
      const applied = applyDeployment(deployments, target, deployment({ state }), NOW);
      expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "failed", note: `Deployment 7 reported ${state}` });
    }
  });

  // BB-204: a deployment that has not reached a final status has not applied
  // the image yet, so it must not move the watch or wake the steward.
  it("leaves a watch alone for an in_progress, created or empty-state deployment", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    for (const state of ["in_progress", "created", ""]) {
      const applied = applyDeployment(deployments, target, deployment({ state }), NOW + 1000);
      expect(applied.changed).toEqual([]);
      expect(applied.deployments).toBe(deployments);
      expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "merged", deploymentId: null, deploymentState: null });
    }
  });

  it("ignores a doorbell for another repo or environment, and one for a settled watch", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    expect(applyDeployment(deployments, target, deployment({ environment: "staging" }), NOW).changed).toEqual([]);
    expect(applyDeployment(deployments, { ...target, repo: "acme/other" }, deployment(), NOW).changed).toEqual([]);
    const settled: Deployments = { "acme/web#7": { ...deployments["acme/web#7"]!, state: "deployed" } };
    expect(applyDeployment(settled, target, deployment(), NOW).changed).toEqual([]);
  });
});

describe("the no-deployment timeout", () => {
  it("reports a watch past its deadline, and marking it failed is idempotent", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    expect(timeoutsDue(deployments, NOW + target.timeout - 1)).toEqual([]);
    expect(timeoutsDue(deployments, NOW + target.timeout)).toEqual(["acme/web#7"]);
    const failed = timeOut(deployments, ["acme/web#7"], NOW + target.timeout);
    expect(failed["acme/web#7"]).toMatchObject({ state: "failed", deadlineAt: null, note: "No matching deployment within the playbook's timeout" });
    expect(timeoutsDue(failed, NOW + target.timeout + 1000)).toEqual([]);
  });

  // BB-194: a not-yet verdict leaves a note, and the timeout must not let it
  // mask the timeout message. The timeout comes first, the stale reason after.
  it("puts the timeout message in front of the note a not-yet watch carried", () => {
    const notYet = reportDeployment(
      applyDeployment(recordMerged({}, observed(), [target], NOW), target, deployment(), NOW).deployments,
      { state: "not-yet", note: "image-tag: build.yaml run 2858 pinned PLUGIN_REF=3c9f4ef, which does not contain merge b6957dd (behind)" },
      NOW + 1000,
      target.timeout,
    ).deployments;
    expect(notYet["acme/web#7"]).toMatchObject({ state: "merged", note: "image-tag: build.yaml run 2858 pinned PLUGIN_REF=3c9f4ef, which does not contain merge b6957dd (behind)" });
    const failed = timeOut(notYet, ["acme/web#7"], NOW + 1000 + target.timeout);
    expect(failed["acme/web#7"]).toMatchObject({
      state: "failed",
      deadlineAt: null,
      note: "No matching deployment within the playbook's timeout; last: image-tag: build.yaml run 2858 pinned PLUGIN_REF=3c9f4ef, which does not contain merge b6957dd (behind)",
    });
  });

  it("keeps a deadline while deploying, so a deployment with no final status still times out", () => {
    const applied = applyDeployment(recordMerged({}, observed(), [target], NOW), target, deployment(), NOW);
    expect(timeoutsDue(applied.deployments, NOW + target.timeout - 1)).toEqual([]);
    expect(timeoutsDue(applied.deployments, NOW + target.timeout)).toEqual(["acme/web#7"]);
  });
});

describe("the steward's verdict", () => {
  const deploying = () => applyDeployment(recordMerged({}, observed(), [target], NOW), target, deployment(), NOW).deployments;

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
    const two = recordMerged(recordMerged({}, observed(), [target], NOW), observed({ entity: pull({ key: "acme/web#8" }, { merged: true }) }), [target], NOW);
    expect(reportDeployment(two, { state: "deployed", key: "ACME/WEB#8" }, NOW, target.timeout).changed?.key).toBe("acme/web#8");
    const withDeployment = applyDeployment(two, target, deployment(), NOW).deployments;
    expect(reportDeployment(withDeployment, { state: "deployed", deploymentId: 7 }, NOW, target.timeout).changed?.key).toBe("acme/web#7");
    // No key and more than one unsettled watch: nothing is picked.
    expect(reportDeployment(two, { state: "deployed" }, NOW, target.timeout).changed).toBeNull();
  });
});

describe("confirming from a deployment read (BB-59)", () => {
  it("applies the newest deployment for the target and records its facts", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    const read = [deployment({ id: 6, state: "failure", url: "https://example.test/6" }), deployment({ id: 7, state: "success" })];
    const applied = applyDeploymentRead(deployments, target, read, NOW + 60_000);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployment).toMatchObject({ id: 7, state: "success" });
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentId: 7, deploymentState: "success", ref: "main", sha: "bbbbbbb2", url: "https://github.com/acme/web/actions/runs/9", deadlineAt: NOW + 60_000 + target.timeout });
  });

  it("treats a failed newest deployment as the failure it is", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    const applied = applyDeploymentRead(deployments, target, [deployment({ state: "failure", url: "https://example.test/12" })], NOW);
    expect(applied.changed).toEqual(["acme/web#7"]);
    expect(applied.deployments["acme/web#7"]).toMatchObject({ state: "failed", deploymentState: "failure", deadlineAt: null, note: "Deployment 7 reported failure" });
  });

  it("changes nothing when the target's environment has no deployments", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    expect(applyDeploymentRead(deployments, target, [], NOW)).toEqual({ deployments, changed: [], deployment: null });
    expect(applyDeploymentRead(deployments, target, [deployment({ environment: "staging" })], NOW).changed).toEqual([]);
  });

  it("does not re-wake for a deployment it already recorded with the same state, but does for a new state", () => {
    const first = applyDeploymentRead(recordMerged({}, observed(), [target], NOW), target, [deployment({ state: "in_progress" })], NOW);
    expect(first.changed).toEqual(["acme/web#7"]);
    // The same deployment, same state: a repeat read is not news.
    expect(applyDeploymentRead(first.deployments, target, [deployment({ state: "in_progress" })], NOW + 1000).changed).toEqual([]);
    // The same deployment reaching success is news.
    const second = applyDeploymentRead(first.deployments, target, [deployment({ state: "success" })], NOW + 2000);
    expect(second.changed).toEqual(["acme/web#7"]);
    expect(second.deployments["acme/web#7"]).toMatchObject({ state: "deploying", deploymentState: "success" });
  });

  it("never moves a watch backwards to an older deployment", () => {
    const held = applyDeploymentRead(recordMerged({}, observed(), [target], NOW), target, [deployment({ id: 9, state: "success" })], NOW).deployments;
    expect(applyDeploymentRead(held, target, [deployment({ id: 7, state: "success" })], NOW + 1000).changed).toEqual([]);
    expect(held["acme/web#7"]).toMatchObject({ deploymentId: 9 });
  });

  it("leaves a settled watch alone", () => {
    const settled = applyDeployment(recordMerged({}, observed(), [target], NOW), target, deployment(), NOW).deployments;
    const done = reportDeployment(settled, { state: "deployed" }, NOW, target.timeout).deployments;
    expect(applyDeploymentRead(done, target, [deployment({ id: 8, state: "success" })], NOW + 1000).changed).toEqual([]);
  });
});

// BB-61: a failed (or cancelled/timed-out) run of a workflow a deployment
// target names wakes every watch still awaiting a deployment, once per run
// and attempt, without moving the watch's state.
describe("a failed workflow run (BB-61)", () => {
  const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({ workflow: ".github/workflows/build.yaml", name: "app", conclusion: "failure", url: "https://github.com/acme/web/actions/runs/42", sha: "ccccccc3", run_attempt: 1, startedAt: null, ...over });
  const mergedWatch = () => recordMerged({}, observed(), [target], NOW);

  it("matches a workflow by path, basename or name, ignoring case, and nothing when the list is empty", () => {
    expect(matchesWorkflow(named, run())).toBe(true);
    expect(matchesWorkflow({ workflows: [".github/workflows/build.yaml"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["BUILD.YAML"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["app"] }, run())).toBe(true);
    expect(matchesWorkflow({ workflows: ["image.yaml"] }, run())).toBe(false);
    expect(matchesWorkflow(target, run())).toBe(false);
  });

  it("wakes an awaiting watch once per run and attempt, leaving its state alone", () => {
    const first = applyWorkflowRun(mergedWatch(), "acme/web#42", "acme/web", run(), NOW + 1000);
    expect(first.woken).toEqual(["acme/web#7"]);
    expect(first.recorded).toEqual(["acme/web#7"]);
    expect(first.deployments["acme/web#7"]).toMatchObject({ state: "merged", workflowRuns: ["acme/web#42#1"] });
    // The same run and attempt is not news, however often it is delivered.
    const repeat = applyWorkflowRun(first.deployments, "acme/web#42", "acme/web", run(), NOW + 2000);
    expect(repeat.woken).toEqual([]);
    expect(repeat.recorded).toEqual([]);
    expect(repeat.deployments).toEqual(first.deployments);
    // A re-run (a higher attempt) wakes again.
    const again = applyWorkflowRun(first.deployments, "acme/web#42", "acme/web", run({ run_attempt: 2 }), NOW + 3000);
    expect(again.woken).toEqual(["acme/web#7"]);
  });

  it("skips another repo, a settled watch, and a watch recorded after the doorbell arrived", () => {
    const deployments = mergedWatch();
    expect(applyWorkflowRun(deployments, "acme/other#42", "acme/other", run(), NOW).woken).toEqual([]);
    const settled: Deployments = { "acme/web#7": { ...deployments["acme/web#7"]!, state: "deployed" } };
    expect(applyWorkflowRun(settled, "acme/web#42", "acme/web", run(), NOW).woken).toEqual([]);
    // The watch was recorded after the doorbell arrived: the run cannot concern
    // it, so it is not woken, but the event is recorded on it so a repeat
    // delivery of the same run and attempt does not wake it later.
    const late = applyWorkflowRun(deployments, "acme/web#42", "acme/web", run(), NOW - 1);
    expect(late.woken).toEqual([]);
    expect(late.recorded).toEqual(["acme/web#7"]);
    expect(late.deployments["acme/web#7"]!.workflowRuns).toEqual(["acme/web#42#1"]);
    expect(applyWorkflowRun(late.deployments, "acme/web#42", "acme/web", run(), NOW).woken).toEqual([]);
  });

  it("skips a run that started before the watch's merge and wakes one that started after (BB-132)", () => {
    const deployments = mergedWatch();
    // The watch merged at NOW. A run that started before it cannot concern it,
    // so it is recorded but not woken, even though the doorbell arrived after.
    const before = applyWorkflowRun(deployments, "acme/web#42", "acme/web", run(), NOW + 1000, NOW - 60_000);
    expect(before.woken).toEqual([]);
    expect(before.recorded).toEqual(["acme/web#7"]);
    expect(before.deployments["acme/web#7"]!.workflowRuns).toEqual(["acme/web#42#1"]);
    // A run that started after the merge wakes, and a run at the merge time too.
    expect(applyWorkflowRun(deployments, "acme/web#43", "acme/web", run(), NOW + 1000, NOW + 60_000).woken).toEqual(["acme/web#7"]);
    expect(applyWorkflowRun(deployments, "acme/web#44", "acme/web", run(), NOW + 1000, NOW).woken).toEqual(["acme/web#7"]);
  });

  it("lists the watches still awaiting a deployment on a repo, and keys an event by run and attempt", () => {
    const deployments = recordMerged(recordMerged({}, observed(), [target], NOW), observed({ entity: pull({ key: "acme/web#8" }, { merged: true }) }), [target], NOW);
    expect(awaitingOnRepo(deployments, "Acme/Web").map((w) => w.key)).toEqual(["acme/web#7", "acme/web#8"]);
    expect(workflowRunKey("Acme/Web#42", 2)).toBe("acme/web#42#2");
  });
});

describe("the show lines", () => {
  it("names each watch's state, target, deployment facts and note", () => {
    const deployments = applyDeployment(recordMerged({}, observed(), [target], NOW), target, deployment({ state: "failure" }), NOW).deployments;
    expect(deploymentLines(deployments)).toEqual(["acme/web#7: failed → acme/web production (deployment 7, ref main, sha bbbbbbb, https://github.com/acme/web/actions/runs/9) — Deployment 7 reported failure"]);
  });

  it("round-trips through the store schema", () => {
    const deployments = recordMerged({}, observed(), [target], NOW);
    expect(deploymentsSchema.parse(JSON.parse(JSON.stringify(deployments)))).toEqual(deployments);
  });
});
