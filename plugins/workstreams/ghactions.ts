// The Board's direct GitHub actions: merge, update branch, nudge reviewers.
// Every command is an argv ARRAY handed to execFile, never a shell string, so a
// PR title, branch name or comment can never be read as shell syntax. Comment
// bodies go in on stdin (`--body-file -`), never as a flag value. Every repo is
// named with `--repo`, which also stops `gh pr merge` from touching the local
// checkout. The runner is injected, so tests drive all of it against a fake.
import { parseMergeStateStatus } from "./gh.js";
import { SHA, type LiveMergeFacts, type MergeMethod } from "./actions.js";

export type Run = { ok: true; stdout: string } | { ok: false; error: string };
/** Runs `gh` with these arguments, optionally writing `stdin` to it. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<Run>;

/** A pull request as `gh --repo` names it. `slug` is OWNER/REPO, or HOST/OWNER/REPO off github.com. */
export type PrTarget = { host: string; owner: string; name: string; slug: string; number: number };

const PR_URL = /^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})$/u;

/** The PR's repo and number from its URL, or null when the URL is not a PR URL. */
export function prTarget(url: string): PrTarget | null {
  const match = PR_URL.exec(url.trim());
  if (match === null) return null;
  const [, host, owner, name, number] = match as unknown as [string, string, string, string, string];
  if (name === "." || name === "..") return null;
  return {
    host,
    owner,
    name,
    slug: host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`,
    number: Number(number),
  };
}

/** A GitHub login, or an org/team slug. Anything else is dropped, never passed to gh. */
export const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$/u;

/**
 * `gh pr list --json reviewRequests`: users carry `login`; teams carry a
 * `slug`, qualified with the organization when gh reports it. Bounded and
 * validated, because these become `--add-reviewer` values.
 */
export function parseReviewRequests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    let name: unknown = record.login;
    if (record.__typename === "Team") {
      const org = (record.organization as Record<string, unknown> | undefined)?.login;
      const slug = record.slug;
      name = typeof slug === "string" && !slug.includes("/") && typeof org === "string" ? `${org}/${slug}` : slug;
    }
    if (typeof name === "string" && REVIEWER.test(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 20);
}

const repoArgs = (target: PrTarget) => [String(target.number), "--repo", target.slug];

export function viewArgv(target: PrTarget): string[] {
  return ["pr", "view", ...repoArgs(target), "--json", "state,isDraft,reviewDecision,mergeStateStatus,headRefOid,headRefName"];
}

export function stackedArgv(target: PrTarget, headRefName: string): string[] {
  return ["pr", "list", "--repo", target.slug, "--base", headRefName, "--state", "open", "--json", "number", "--limit", "50"];
}

/** Constant: the only variables are passed as typed -f/-F fields, never spliced in. */
export const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved}}}}}";

export function threadsArgv(target: PrTarget): string[] {
  return [
    "api",
    "graphql",
    ...(target.host === "github.com" ? [] : ["--hostname", target.host]),
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.name}`,
    "-F",
    `number=${target.number}`,
  ];
}

export function mergeArgv(target: PrTarget, method: MergeMethod, sha: string, deleteBranch: boolean): string[] {
  if (!SHA.test(sha)) throw new Error("A merge needs the exact head commit it was confirmed against.");
  return ["pr", "merge", ...repoArgs(target), `--${method}`, "--match-head-commit", sha, ...(deleteBranch ? ["--delete-branch"] : [])];
}

export function updateBranchArgv(target: PrTarget): string[] {
  return ["pr", "update-branch", ...repoArgs(target)];
}

export function rerequestArgv(target: PrTarget, reviewers: readonly string[]): string[] {
  const valid = reviewers.filter((reviewer) => REVIEWER.test(reviewer));
  if (valid.length === 0) throw new Error("No valid reviewers to re-request.");
  return ["pr", "edit", ...repoArgs(target), "--add-reviewer", valid.join(",")];
}

/** The body is NOT in here: it goes on stdin. */
export function commentArgv(target: PrTarget): string[] {
  return ["pr", "comment", ...repoArgs(target), "--body-file", "-"];
}

function json(run: Run): unknown {
  if (!run.ok) return undefined;
  try {
    return JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
}

export type LiveRead = { ok: true; live: LiveMergeFacts } | { ok: false; error: string };

/** Read only the first page: a positive count is enough to block merge; an empty
 * page with more pages is unknown, never clear. */
export async function readReviewThreads(run: GhRunner, target: PrTarget): Promise<{ ok: true; count: number; hasNextPage: boolean } | { ok: false; error: string }> {
  const result = await run(threadsArgv(target));
  if (!result.ok) return { ok: false, error: result.error };
  const body = json(result) as { errors?: unknown; data?: { repository?: { pullRequest?: { reviewThreads?: unknown } } } } | undefined;
  if (body === undefined || body.errors !== undefined) return { ok: false, error: "GitHub did not return complete review thread data." };
  const threads = body.data?.repository?.pullRequest?.reviewThreads as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | undefined;
  if (!Array.isArray(threads?.nodes) || typeof threads.pageInfo?.hasNextPage !== "boolean" ||
      !threads.nodes.every((node) => node !== null && typeof node === "object" && typeof node.isResolved === "boolean")) {
    return { ok: false, error: "GitHub did not return the PR's review threads." };
  }
  const count = threads.nodes.filter((node) => node.isResolved === false).length;
  if (count === 0 && threads.pageInfo.hasNextPage) {
    return { ok: false, error: "More review thread pages remain unread." };
  }
  return { ok: true, count, hasNextPage: threads.pageInfo.hasNextPage };
}

/**
 * Re-read, live, everything the merge dialog shows: the PR's own state, any
 * open PR stacked on its head branch, and how many review threads are still
 * unresolved. Three read-only calls; nothing here writes.
 */
export async function readLiveMerge(run: GhRunner, target: PrTarget): Promise<LiveRead> {
  const viewed = await run(viewArgv(target));
  if (!viewed.ok) return { ok: false, error: `gh pr view failed: ${viewed.error}` };
  const view = json(viewed) as Record<string, unknown> | undefined;
  if (view === undefined || view === null || typeof view !== "object") return { ok: false, error: "gh pr view returned no data." };
  const head = typeof view.headRefName === "string" && !view.headRefName.startsWith("-") ? view.headRefName : null;
  const [stacked, threads] = await Promise.all([
    head === null ? Promise.resolve<Run>({ ok: true, stdout: "[]" }) : run(stackedArgv(target, head)),
    readReviewThreads(run, target),
  ]);
  if (!stacked.ok) return { ok: false, error: `Could not check for stacked PRs: ${stacked.error}` };
  if (!threads.ok) return { ok: false, error: `Could not count unresolved review threads: ${threads.error}` };
  const above = json(stacked);
  return {
    ok: true,
    live: {
      state: typeof view.state === "string" ? view.state.toUpperCase() : "",
      isDraft: view.isDraft === true,
      reviewDecision: typeof view.reviewDecision === "string" && view.reviewDecision !== "" ? view.reviewDecision.toUpperCase() : null,
      mergeStateStatus: parseMergeStateStatus(view.mergeStateStatus),
      headRefOid: typeof view.headRefOid === "string" && SHA.test(view.headRefOid) ? view.headRefOid : null,
      stackedAbove: Array.isArray(above)
        ? above.flatMap((entry) => (typeof entry?.number === "number" ? [entry.number as number] : [])).slice(0, 50)
        : [],
      unresolvedThreads: threads.count,
      unresolvedAtLeast: threads.hasNextPage,
    },
  };
}

export type WriteResult = { ok: true; detail: string } | { ok: false; error: string };

export async function runMerge(
  run: GhRunner,
  target: PrTarget,
  method: MergeMethod,
  sha: string,
  deleteBranch: boolean,
): Promise<WriteResult> {
  const merged = await run(mergeArgv(target, method, sha, deleteBranch));
  return merged.ok
    ? { ok: true, detail: `Merged ${target.slug} #${target.number}${deleteBranch ? " and deleted its branch" : ""}.` }
    : { ok: false, error: `GitHub refused the merge: ${merged.error}` };
}

export async function runUpdateBranch(run: GhRunner, target: PrTarget): Promise<WriteResult> {
  const updated = await run(updateBranchArgv(target));
  return updated.ok
    ? { ok: true, detail: `Updated the branch of ${target.slug} #${target.number}.` }
    : { ok: false, error: `GitHub refused the branch update: ${updated.error}` };
}

/** Re-request review and/or comment. Each part is optional; a failure says which part failed. */
export async function runNudge(
  run: GhRunner,
  target: PrTarget,
  reviewers: readonly string[],
  comment: string | null,
): Promise<WriteResult> {
  const done: string[] = [];
  if (reviewers.length > 0) {
    const edited = await run(rerequestArgv(target, reviewers));
    if (!edited.ok) return { ok: false, error: `Re-requesting review failed: ${edited.error}` };
    done.push(`re-requested review from ${reviewers.length}`);
  }
  if (comment !== null && comment.trim() !== "") {
    const posted = await run(commentArgv(target), comment);
    if (!posted.ok) {
      return { ok: false, error: `${done.length > 0 ? "Review was re-requested, but posting" : "Posting"} the comment failed: ${posted.error}` };
    }
    done.push("posted the comment");
  }
  if (done.length === 0) return { ok: false, error: "Nothing to do: choose re-request, a comment, or both." };
  return { ok: true, detail: `${target.slug} #${target.number}: ${done.join(" and ")}.` };
}
