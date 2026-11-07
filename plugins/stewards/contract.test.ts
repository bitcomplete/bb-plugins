// The contract is copied into linear and github-watcher; the copies must not drift.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMissingPlugin, signatureLine, signedBy, snapshotPullSchema, sourceContract } from "./source-contract.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe("source-contract.ts", () => {
  for (const sibling of ["linear", "github-watcher"]) {
    const path = here(`../${sibling}/source-contract.ts`);
    it.skipIf(!existsSync(path))(`is byte-identical in ${sibling}`, () => {
      expect(readFileSync(path, "utf8")).toBe(readFileSync(here("./source-contract.ts"), "utf8"));
    });
  }

  it("reads the last signature in a body", () => {
    expect(signedBy(`hello\n\n${signatureLine("thr_abc")}`)).toBe("thr_abc");
    expect(signedBy(`> ${signatureLine("thr_old")}\n\nreply\n\n${signatureLine("thr_new")}`)).toBe("thr_new");
    expect(signedBy("no signature")).toBeNull();
  });

  it("tells a missing plugin from a failing one", () => {
    expect(isMissingPlugin(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(isMissingPlugin(new Error("plugin stewards is not installed"))).toBe(true);
    expect(isMissingPlugin(Object.assign(new Error("boom"), { code: "handler_error" }))).toBe(false);
  });

  it("parses sourceEnsureLabel and its per-unit results", () => {
    expect(sourceContract.sourceEnsureLabel.input.parse({ units: ["ENG", "acme/web"], label: "bb-managed" })).toEqual({ units: ["ENG", "acme/web"], label: "bb-managed" });
    expect(sourceContract.sourceEnsureLabel.input.safeParse({ units: [""], label: "bb-managed" }).success).toBe(false);
    expect(sourceContract.sourceEnsureLabel.output.parse({ results: [{ unit: "ENG", status: "created" }, { unit: "acme/web", status: "existed", error: null }, { unit: "acme/gone", status: "error", error: "no such repository" }] })).toEqual({
      results: [
        { unit: "ENG", status: "created", error: null },
        { unit: "acme/web", status: "existed", error: null },
        { unit: "acme/gone", status: "error", error: "no such repository" },
      ],
    });
    expect(sourceContract.sourceEnsureLabel.output.safeParse({ results: [{ unit: "ENG", status: "failed" }] }).success).toBe(false);
  });

  it("parses the deployment-read RPCs and the merge commit on the pull snapshot (BB-132)", () => {
    expect(sourceContract.sourceFileAtRef.input.parse({ repo: "bitcomplete/bb-gate", path: "kploy/production/kustomization.yaml", ref: "main" })).toEqual({ repo: "bitcomplete/bb-gate", path: "kploy/production/kustomization.yaml", ref: "main" });
    expect(sourceContract.sourceFileAtRef.input.safeParse({ repo: "", path: "x", ref: "main" }).success).toBe(false);
    expect(sourceContract.sourceFileAtRef.output.parse({ content: null, error: "x" })).toEqual({ content: null, error: "x" });
    expect(sourceContract.sourceLatestCommit.output.parse({ sha: "abc", committedAt: null, error: null })).toEqual({ sha: "abc", committedAt: null, error: null });
    // A run is by workflow and number, or by id, and its output carries jobs.
    expect(sourceContract.sourceWorkflowRun.input.parse({ repo: "bitcomplete/bb-gate", workflow: "bb-server.yaml", runNumber: 3 })).toEqual({ repo: "bitcomplete/bb-gate", workflow: "bb-server.yaml", runNumber: 3 });
    expect(sourceContract.sourceWorkflowRun.input.parse({ repo: "bitcomplete/bb-gate", runId: 9 })).toEqual({ repo: "bitcomplete/bb-gate", runId: 9 });
    expect(sourceContract.sourceWorkflowRun.output.parse({ run: { id: 1, runNumber: 3, headSha: null, startedAt: null, jobs: [{ name: "build", startedAt: null, conclusion: null }] }, error: null })).toMatchObject({ run: { runNumber: 3, jobs: [{ name: "build" }] } });
    expect(sourceContract.sourceCompare.output.parse({ status: "identical", error: null })).toEqual({ status: "identical", error: null });
    expect(sourceContract.sourceCompare.output.safeParse({ status: "sideways", error: null }).success).toBe(false);
    // The pull snapshot parses a merge commit and changed files, defaulting when absent.
    const pull = snapshotPullSchema.parse({ draft: false, merged: true, base: "main", head: "x", headSha: "h", headAuthor: null, reviewDecision: null, requestedReviewers: [], reviews: [], checks: null, mergeCommit: "m", files: ["a"] });
    expect(pull).toMatchObject({ mergeCommit: "m", files: ["a"] });
    expect(snapshotPullSchema.parse({ draft: false, merged: false, base: null, head: null, headSha: null, headAuthor: null, reviewDecision: null, requestedReviewers: [], reviews: [], checks: null })).toMatchObject({ mergeCommit: null, files: [] });
  });

  it("parses a GitHub issue snapshot whose state is a status label, with linked pulls (BB-232)", () => {
    const snapshot = {
      source: "github" as const,
      kind: "issue" as const,
      id: "acme/web#42",
      key: "acme/web#42",
      url: "https://github.com/acme/web/issues/42",
      title: "Fix login",
      // A status label is a label named `status:<phase>`; with exactly one, state is its name and stateType stays null.
      state: "status:todo",
      stateType: null,
      unit: "acme/web",
      labels: ["bb-managed", "status:todo"],
      author: "dylan",
      assignees: ["dylan"],
      priority: null,
      estimate: null,
      description: "Users cannot log in.",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      comments: [],
      parent: null,
      children: [],
      linkedPulls: [{ url: "https://github.com/acme/web/pull/7", key: "acme/web#7" }],
      pull: null,
      viewer: "dylan",
    };
    const parsed = sourceContract.sourceSnapshot.output.parse({ snapshot });
    expect(parsed.snapshot).toMatchObject({ source: "github", kind: "issue", state: "status:todo", stateType: null, linkedPulls: [{ key: "acme/web#7" }] });
    // With no status label the issue is open; closed carries its reason.
    expect(sourceContract.sourceSnapshot.output.parse({ snapshot: { ...snapshot, state: "open", labels: ["bb-managed"] } }).snapshot).toMatchObject({ state: "open", stateType: null });
    expect(sourceContract.sourceSnapshot.output.parse({ snapshot: { ...snapshot, state: "closed (not planned)" } }).snapshot).toMatchObject({ state: "closed (not planned)", stateType: null });
  });
});
