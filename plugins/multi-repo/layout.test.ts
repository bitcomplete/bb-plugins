import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_MAX,
  describeRepo,
  findWorkspaceRepo,
  formatInstructions,
  readyRepos,
  withSharedNotice,
  type WorkspaceManifest,
} from "./layout.js";

function manifest(overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    root: "/data/workspaces/thr_1",
    pathKey: "thr_1",
    hostId: "host_1",
    threadId: "thr_1",
    projectId: "proj_1",
    branchName: "dylan/fix-the-thing",
    layout: "standalone",
    projectSourcePath: "/home/me/projects/acme",
    definitionBase: null,
    unpushed: null,
    createdAt: 0,
    repos: [
      {
        dir: "bb-dylan",
        path: "/data/workspaces/thr_1/bb-dylan",
        branch: "dylan/fix-the-thing",
        baseBranch: "main",
        remote: "git@github.com:you/bb-dylan.git",
        status: "ready",
      },
      {
        dir: ".bb",
        path: "/data/workspaces/thr_1/.bb",
        branch: "main",
        baseBranch: "main",
        remote: "/home/me/projects/acme",
        status: "ready",
      },
    ],
    ...overrides,
  };
}

describe("formatInstructions", () => {
  it("states that the root is not a git repo", () => {
    const text = formatInstructions(manifest());
    expect(text).toContain("not itself a git repo");
  });

  it("lists every ready repo with its absolute path and branch", () => {
    const text = formatInstructions(manifest());
    expect(text).toContain("/data/workspaces/thr_1/bb-dylan");
    expect(text).toContain("dylan/fix-the-thing");
  });

  it("says the branch is shared, so PRs correlate by head ref", () => {
    expect(formatInstructions(manifest())).toContain("same branch");
  });

  it("states the single base branch when every repo shares one", () => {
    expect(formatInstructions(manifest())).toContain("measured against `main`");
  });

  it("lists per-repo bases when they differ", () => {
    const text = formatInstructions(
      manifest({
        repos: [
          { dir: "a", path: "/w/a", branch: "b", baseBranch: "main", remote: "u", status: "ready" },
          { dir: "c", path: "/w/c", branch: "b", baseBranch: "develop", remote: "u2", status: "ready" },
        ],
      }),
    );
    expect(text).toContain("a → `main`");
    expect(text).toContain("c → `develop`");
  });

  it("names a repo that failed rather than letting it be discovered as an ENOENT", () => {
    const text = formatInstructions(
      manifest({
        repos: [
          ...manifest().repos,
          {
            dir: "gone",
            path: "/w/gone",
            branch: "b",
            baseBranch: "main",
            remote: "u",
            status: "failed",
            message: "authentication failed",
          },
        ],
      }),
    );
    expect(text).toContain("Missing repos");
    expect(text).toContain("gone");
    expect(text).toContain("authentication failed");
  });

  it("explains what .bb is for, or agents never write to it", () => {
    const text = formatInstructions(manifest());
    expect(text).toContain("shared by every thread");
    expect(text).toContain("durable cross-repo knowledge");
  });

  it("warns that the block is fixed at thread start", () => {
    expect(formatInstructions(manifest())).toContain("workspace_add_repo");
  });

  it("prints nothing extra when the project checkout is level with its origin", () => {
    const clean = formatInstructions(manifest({ unpushed: null }));
    expect(clean).toBe(formatInstructions(manifest()));
    expect(clean).not.toContain("Unpushed");
    expect(clean).not.toContain("Push with");
  });

  it("says every .bb write publishes by the policy and reports a failure", () => {
    const text = formatInstructions(manifest());
    expect(text).toContain("publishes to `origin`");
    expect(text).toContain("pull request");
    expect(text).toContain("A failed publish keeps the local commit");
    // The old sentence said the plugin commits locally and never pushes.
    expect(text).not.toContain("do not push it");
  });

  it("prints count, subjects, the server-only warning and the push command when ahead", () => {
    const text = formatInstructions(
      manifest({
        projectSourcePath: "/home/me/projects/acme",
        unpushed: { branch: "main", count: 2, subjects: ["Add a repo to the repo set", "Rewrite cross-repo guidance"] },
      }),
    );
    expect(text).toContain("Unpushed `.bb`");
    expect(text).toContain("2 commits on main are live on this server only");
    expect(text).toContain("Add a repo to the repo set; Rewrite cross-repo guidance");
    expect(text).toContain('git -C "/home/me/projects/acme" push origin main');
  });

  it("uses the singular for one commit", () => {
    const text = formatInstructions(
      manifest({ unpushed: { branch: "main", count: 1, subjects: ["Only change"] } }),
    );
    expect(text).toContain("1 commit on main is live on this server only");
  });

  it("caps the subjects it lists and counts the rest", () => {
    const text = formatInstructions(
      manifest({
        unpushed: {
          branch: "release",
          count: 12,
          subjects: Array.from({ length: 10 }, (_, index) => `subject-${index}`),
        },
      }),
    );
    expect(text).toContain("12 commits on release are live on this server only");
    expect(text).toContain("and 2 more");
  });

  it("stays under the 4096-character contribution ceiling for a large repo set", () => {
    const many = Array.from({ length: 32 }, (_, index) => ({
      dir: `repository-number-${index}`,
      path: `/data/workspaces/thr_1/repository-number-${index}`,
      branch: "dylan/a-fairly-long-branch-name-here",
      baseBranch: "main",
      remote: `git@github.com:an-organization/repository-number-${index}.git`,
      status: "ready" as const,
    }));
    const text = formatInstructions(manifest({ repos: many }));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
  });

  it("keeps the unpushed line and the .bb paragraph at the repo-set ceiling", () => {
    const many = Array.from({ length: 32 }, (_, index) => ({
      dir: `repository-number-${index}`,
      path: `/data/workspaces/thr_1/repository-number-${index}`,
      branch: "dylan/a-fairly-long-branch-name-here",
      baseBranch: "main",
      remote: `git@github.com:an-organization/repository-number-${index}.git`,
      status: "ready" as const,
    }));
    const text = formatInstructions(
      manifest({
        repos: many,
        unpushed: { branch: "main", count: 2, subjects: ["Add a repo", "Rewrite guidance"] },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    // The table gives up rows; the prose after it and the unpushed line do not.
    expect(text).toContain("Unpushed `.bb`");
    expect(text).toContain("publishes to `origin`");
    expect(text).toContain("workspace_add_repo");
    expect(text).toContain("truncated");
  });

  it("cuts whole lines and says so rather than truncating mid-table", () => {
    const huge = Array.from({ length: 200 }, (_, index) => ({
      dir: `repo-${index}`,
      path: `/data/workspaces/thr_1/repo-${index}`,
      branch: "branch",
      baseBranch: "main",
      remote: "u",
      status: "ready" as const,
    }));
    const text = formatInstructions(manifest({ repos: huge }));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    expect(text).toContain("truncated");
  });

  it("says so plainly when nothing materialized", () => {
    const text = formatInstructions(manifest({ repos: [] }));
    expect(text).toContain("No repos materialized");
  });
});

describe("helpers", () => {
  it("readyRepos drops failures and keeps repos.json order", () => {
    const value = manifest({
      repos: [
        { dir: "a", path: "/w/a", branch: "b", baseBranch: "main", remote: "u", status: "failed", message: "x" },
        { dir: "c", path: "/w/c", branch: "b", baseBranch: "main", remote: "u", status: "ready" },
      ],
    });
    expect(readyRepos(value).map((repo) => repo.dir)).toEqual(["c"]);
  });

  it("findWorkspaceRepo answers by directory name", () => {
    expect(findWorkspaceRepo(manifest(), "bb-dylan")?.dir).toBe("bb-dylan");
    expect(findWorkspaceRepo(manifest(), "nope")).toBeNull();
  });

  it("describeRepo marks a failure instead of printing a branch it does not have", () => {
    const line = describeRepo({
      dir: "gone",
      path: "/w/gone",
      branch: "b",
      baseBranch: "main",
      remote: "u",
      status: "failed",
      message: "no such branch",
    });
    expect(line).toContain("MISSING");
    expect(line).toContain("no such branch");
  });
});

describe("withSharedNotice", () => {
  it("adds nothing when the thread is alone in its checkout", () => {
    const text = formatInstructions(manifest());
    expect(withSharedNotice(text, { others: 0, branchName: "b" })).toBe(text);
  });

  it("names the branch the other thread is committing to", () => {
    const notice = withSharedNotice("block", { others: 1, branchName: "bb/thing" });
    expect(notice.startsWith("block\n\n")).toBe(true);
    expect(notice).toContain("Another thread is");
    expect(notice).toContain("`bb/thing`");
  });

  it("counts more than one", () => {
    expect(withSharedNotice("block", { others: 3, branchName: "b" })).toContain("3 other threads are");
  });

  it("keeps the warning when the block is already at the ceiling", () => {
    const long = Array.from({ length: 400 }, (_, index) => `| repo-${index} | branch | /path |`).join("\n");
    const notice = withSharedNotice(long.slice(0, INSTRUCTIONS_MAX), { others: 1, branchName: "b" });
    expect(notice.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    expect(notice).toContain("This checkout is shared.");
  });
});
