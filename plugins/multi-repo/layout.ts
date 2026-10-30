/**
 * The workspace manifest, and the instruction block the agent reads.
 *
 * **Why this is precomputed.** `bb.agents.contributeInstructions` is
 * synchronous and runs on the thread-start path, so the callback cannot shell
 * out to git — asking four repos for their branch at thread start would put a
 * process spawn between the user pressing send and the model seeing anything.
 * `create()` already knows every fact the block needs, so it writes the
 * manifest to plugin storage and the callback formats what it finds. No git in
 * the callback and no work proportional to the repo count at thread start.
 *
 * **Why it is a table of facts and nothing else.** The generated block says
 * where things are; `.bb/AGENTS.md` says what they mean. Paths written into
 * `AGENTS.md` drift the first time a repo is renamed, and intent written into
 * this block cannot be edited by the person who holds it. Keeping the split
 * clean is what makes both halves trustworthy.
 *
 * Pure: the formatting is a function of the manifest, so the 4096-character
 * ceiling is testable without a server.
 */

import type { ProjectLayout } from "./paths.js";

/** Core truncates a contribution at 4096 characters. Stay under it deliberately. */
export const INSTRUCTIONS_MAX = 4096;

export type RepoStatus = "ready" | "failed";

export interface WorkspaceRepo {
  /** Directory name inside the workspace, from `repos.json`. */
  dir: string;
  /** Absolute path of the clone on the machine. */
  path: string;
  /** The branch checked out: the thread's shared branch for a work repo. */
  branch: string;
  /** What this repo's changes are measured against. */
  baseBranch: string;
  /** `origin` as the agent will see it — the real remote, not the cache. */
  remote: string;
  status: RepoStatus;
  /** Why a repo failed to materialize. Present only when `status` is failed. */
  message?: string;
}

export interface WorkspaceManifest {
  root: string;
  pathKey: string;
  hostId: string;
  /**
   * The thread `create()` ran for. Not the only thread that may be using this
   * checkout — a fork keeps its source's environment, and therefore this
   * workspace. Ask the binding table who else is here.
   */
  threadId: string;
  projectId: string;
  /** The shared thread branch, from `context.suggestedBranchName`. */
  branchName: string;
  /** Which layout the project source had when this workspace was provisioned. */
  layout: ProjectLayout;
  /** The canonical `.bb` checkout on this machine, outside the sandbox. */
  projectSourcePath: string;
  /** The default-branch commit `.bb/` was materialized from, for a primary project. */
  definitionBase: string | null;
  repos: WorkspaceRepo[];
  createdAt: number;
}

/** The repos an agent can actually work in, in `repos.json` order. */
export function readyRepos(manifest: WorkspaceManifest): WorkspaceRepo[] {
  return manifest.repos.filter((repo) => repo.status === "ready");
}

export function findWorkspaceRepo(manifest: WorkspaceManifest, dir: string): WorkspaceRepo | null {
  return manifest.repos.find((repo) => repo.dir === dir) ?? null;
}

/** Pad to a column width, for the fixed-width table below. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * The instruction block: what is on disk, where, and on which branch.
 *
 * Every row is one repo. Paths are absolute because the agent's `cwd` is the
 * workspace root but its tools are given absolute paths, and a relative path
 * here would be one more thing to get wrong. The remote column is the real
 * remote rather than the object cache the clone actually reads from — the
 * cache is an implementation detail the agent must never push to.
 *
 * Failed repos are listed too. A thread with three of four repos present is
 * still useful, but only if the agent is told which one is missing rather than
 * discovering it as a confusing `ENOENT` halfway through a task.
 */
export function formatInstructions(manifest: WorkspaceManifest): string {
  const lines: string[] = [];
  lines.push("## Multi-repo workspace");
  lines.push("");
  lines.push(
    `Your working directory is a plain directory holding one git clone per repo. It is not itself a git repo — run git inside a repo directory, never at the root.`,
  );
  lines.push("");

  const ready = manifest.repos.filter((repo) => repo.status === "ready");
  if (ready.length > 0) {
    const dirWidth = Math.max(4, ...ready.map((repo) => repo.dir.length));
    const branchWidth = Math.max(6, ...ready.map((repo) => repo.branch.length));
    lines.push("| " + pad("repo", dirWidth) + " | " + pad("branch", branchWidth) + " | path |");
    lines.push("| " + "-".repeat(dirWidth) + " | " + "-".repeat(branchWidth) + " | ---- |");
    for (const repo of ready) {
      lines.push(`| ${pad(repo.dir, dirWidth)} | ${pad(repo.branch, branchWidth)} | ${repo.path} |`);
    }
    lines.push("");
    lines.push(
      `Every work repo is on the same branch, \`${manifest.branchName}\`, so pull requests across repos correlate by head ref. Each repo's \`origin\` is its real remote; push and open PRs per repo as usual.`,
    );
    const bases = new Set(ready.map((repo) => repo.baseBranch));
    lines.push(
      bases.size === 1
        ? `Each repo's changes are measured against \`${[...bases][0]}\`.`
        : `Base branches differ per repo: ${ready.map((repo) => `${repo.dir} → \`${repo.baseBranch}\``).join(", ")}.`,
    );
  } else {
    lines.push("No repos materialized in this workspace. Check the plugin's Repos panel.");
  }

  const failed = manifest.repos.filter((repo) => repo.status === "failed");
  if (failed.length > 0) {
    lines.push("");
    lines.push("**Missing repos.** These are in the repo set but are not on disk:");
    for (const repo of failed) {
      lines.push(`- \`${repo.dir}\` — ${repo.message ?? "failed to clone"}`);
    }
  }

  lines.push("");
  lines.push(
    manifest.layout === "primary"
      ? "`.bb/` is the project definition: the repo set (`repos.json`), cross-repo guidance (`AGENTS.md`), and project skills. It is a directory on the primary repo's default branch, shared by every thread in this project and versioned, so it is the right place to record durable cross-repo knowledge — and the wrong place for anything specific to this thread. In this workspace `.bb/` is a link to the primary clone's `.bb/`, so an edit under it is a working-tree change in that clone on this thread's branch. Changes to it are reviewed like code: commit them with the thread's pull request, or publish them on their own with `workspace_publish_guidance` (it commits for you on a `guidance-<thread>` branch)."
      : "`.bb/` is the project's own repo: the repo set (`repos.json`), cross-repo guidance (`AGENTS.md`), and project skills. It is shared by every thread in this project and versioned, so it is the right place to record durable cross-repo knowledge — and the wrong place for anything specific to this thread.",
  );
  lines.push("");
  lines.push(
    "Use `workspace_add_repo` to add a repo to this workspace without restarting the thread; the table above is fixed at thread start and will not show later additions.",
  );

  const text = lines.join("\n");
  if (text.length <= INSTRUCTIONS_MAX) return text;
  // A repo set large enough to overflow has already lost the plot, but
  // truncating mid-table would leave the agent with a row it cannot trust.
  // Cut whole lines from the end and say so.
  const notice = "\n\n(Repo list truncated.)";
  let kept = lines;
  while (kept.length > 1 && kept.join("\n").length + notice.length > INSTRUCTIONS_MAX) {
    kept = kept.slice(0, -1);
  }
  return kept.join("\n") + notice;
}

/**
 * The shared-checkout warning, appended to the stored instruction block.
 *
 * Kept out of `formatInstructions` because it is not a fact of the workspace:
 * `create()` writes the block once, and a second thread can attach to the same
 * checkout at any time afterwards by being forked from the first. The block is
 * stored, this is added on the way out.
 *
 * It matters enough to spend characters on. Two agents on one branch in one
 * directory will overwrite each other's work, and neither can see the other
 * from inside the sandbox — this line is the only warning there is.
 */
export function withSharedNotice(instructions: string, args: { others: number; branchName: string }): string {
  if (args.others <= 0) return instructions;
  const others =
    args.others === 1 ? "Another thread is" : `${args.others} other threads are`;
  const notice = [
    "",
    "",
    `**This checkout is shared.** ${others} working in this same directory on the same branch \`${args.branchName}\` — a forked thread keeps the environment it was forked from. Your commits land on the branch they are committing to, and neither side can see the other's uncommitted work as anything but its own. Check with the user before committing, rebasing, or pushing.`,
  ].join("\n");
  if (instructions.length + notice.length <= INSTRUCTIONS_MAX) return instructions + notice;
  // The warning outranks the tail of the block: a truncated repo table is a
  // nuisance, two agents silently sharing a branch is lost work.
  let kept = instructions.split("\n");
  while (kept.length > 1 && kept.join("\n").length + notice.length > INSTRUCTIONS_MAX) {
    kept = kept.slice(0, -1);
  }
  return kept.join("\n") + notice;
}

/** The one-line summary the `workspace_list_repos` tool and `bb repos` print. */
export function describeRepo(repo: WorkspaceRepo): string {
  const status = repo.status === "ready" ? repo.branch : `MISSING — ${repo.message ?? "failed to clone"}`;
  return `${repo.dir}\t${status}\t${repo.path}`;
}
