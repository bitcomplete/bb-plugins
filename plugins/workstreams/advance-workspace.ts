// Provision one isolated checkout per PR. Existing author checkouts are never reset.
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { githubRepoFromRemote } from "./gh.js";
import { prTarget, type GhRunner, type Run } from "./ghactions.js";
import { readAdvancePr } from "./advance-host.js";
import { advanceWorkspaceInputSchema, type AdvanceWorkspaceInput, type AdvanceWorkspace } from "./advance-contract.js";

export type AdvanceGitRunner = (args: string[], cwd: string) => Promise<Run>;

export async function prepareAdvanceWorkspace(
  git: AdvanceGitRunner,
  gh: GhRunner,
  input: AdvanceWorkspaceInput,
  root = join(homedir(), ".bb", "plugins", "workstreams", "worktrees"),
): Promise<AdvanceWorkspace> {
  const valid = advanceWorkspaceInputSchema.safeParse(input);
  if (!valid.success || !isAbsolute(input.sourcePath)) return { ok: false, error: "Invalid preparation workspace request." };
  const target = prTarget(input.prUrl);
  if (target === null || target.host !== "github.com") return { ok: false, error: "Bulk preparation requires an exactly matched github.com source repository." };
  const fail = (error: string): AdvanceWorkspace => ({ ok: false, error: error.slice(0, 800) });
  try {
    const sourcePath = await realpath(input.sourcePath);
    const sourceRoot = await git(["rev-parse", "--show-toplevel"], sourcePath);
    if (!sourceRoot.ok || await realpath(sourceRoot.stdout.trim()) !== sourcePath) return fail("The mapped source is not an exact repository checkout root.");
    const remote = await git(["remote", "get-url", "origin"], sourcePath);
    if (!remote.ok || githubRepoFromRemote(remote.stdout)?.toLowerCase() !== `${target.owner}/${target.name}`.toLowerCase()) return fail("The mapped source origin does not match the PR repository.");
    const pushRemote = await git(["remote", "get-url", "--push", "--all", "origin"], sourcePath);
    if (!pushRemote.ok || pushRemote.stdout.trim().split("\n").some((url) => githubRepoFromRemote(url)?.toLowerCase() !== `${target.owner}/${target.name}`.toLowerCase())) return fail("The mapped source push origin does not match the PR repository.");
    const inspected = await readAdvancePr(gh, input.prUrl);
    if (!inspected.ok) return inspected;
    const facts = inspected.facts;
    if (facts.state !== "OPEN" || facts.isDraft || facts.isCrossRepository) return fail("This PR is closed, a draft, or a fork; bulk preparation cannot write its branch.");
    if (facts.headOid !== input.expectedHeadOid || facts.baseOid !== input.expectedBaseOid) return fail("The PR head or base changed before workspace preparation. Refresh its plan.");
    for (const branch of [facts.headRefName, facts.baseRefName]) {
      if (!(await git(["check-ref-format", `refs/heads/${branch}`], sourcePath)).ok) return fail("GitHub returned an invalid branch reference.");
    }
    // Private refs avoid FETCH_HEAD races and never update an author's local branch.
    const prefix = `refs/workstreams/advance/${input.batchId}/${input.jobId}`;
    const fetched = await git(["fetch", "--no-tags", "--no-write-fetch-head", "origin",
      `+refs/pull/${target.number}/head:${prefix}/head`, `+refs/heads/${facts.baseRefName}:${prefix}/base`], sourcePath);
    if (!fetched.ok) return fail(`Could not fetch the PR and base: ${fetched.error}`);
    const [head, base] = await Promise.all([
      git(["rev-parse", "--verify", `${prefix}/head^{commit}`], sourcePath),
      git(["rev-parse", "--verify", `${prefix}/base^{commit}`], sourcePath),
    ]);
    if (!head.ok || !base.ok || head.stdout.trim() !== input.expectedHeadOid || base.stdout.trim() !== input.expectedBaseOid) return fail("The fetched PR head or base changed. No checkout was created; refresh its plan.");
    const workerPath = join(root, input.batchId, `${target.owner}--${target.name}`);
    const path = join(workerPath, input.jobId);
    await mkdir(workerPath, { recursive: true });
    let exists = false;
    try { exists = (await stat(path)).isDirectory(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const [existingRoot, current, status, common, sourceCommon] = await Promise.all([
        git(["rev-parse", "--show-toplevel"], path), git(["rev-parse", "HEAD"], path),
        git(["status", "--porcelain"], path), git(["rev-parse", "--git-common-dir"], path),
        git(["rev-parse", "--git-common-dir"], sourcePath),
      ]);
      if (!existingRoot.ok || await realpath(existingRoot.stdout.trim()) !== await realpath(path) ||
          !current.ok || current.stdout.trim() !== input.expectedHeadOid || !status.ok || status.stdout.trim() !== "" ||
          !common.ok || !sourceCommon.ok || await realpath(resolve(path, common.stdout.trim())) !== await realpath(resolve(sourcePath, sourceCommon.stdout.trim()))) {
        return fail("The batch checkout already exists with changed or unverified work. It was preserved for inspection.");
      }
      return { ok: true, path, workerPath, sourcePath, created: false };
    }
    const added = await git(["worktree", "add", "--detach", "--", path, input.expectedHeadOid], sourcePath);
    if (!added.ok) return fail(`Could not create the isolated PR checkout: ${added.error}`);
    return { ok: true, path, workerPath, sourcePath, created: true };
  } catch (error) {
    return fail(`Could not prepare the isolated PR checkout: ${String(error)}`);
  }
}
