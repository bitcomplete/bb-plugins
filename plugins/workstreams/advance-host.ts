// Live preparation facts. Nothing in this reader writes to GitHub or a checkout.
import { z } from "zod";
import { approvalHasBody, parseMergeStateStatus } from "./gh.js";
import { prTarget, readReviewThreads, type GhRunner, type Run } from "./ghactions.js";
import type { AdvanceFacts, AdvanceInspection } from "./advance-contract.js";

const branch = z.string().min(1).max(300).refine((value) => !value.startsWith("-"));
const oid = z.string().regex(/^[0-9a-f]{40}$/u);
const viewSchema = z.object({
  url: z.string(), number: z.number().int().positive(), title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), isCrossRepository: z.boolean(),
  headRefName: branch, baseRefName: branch, headRefOid: oid,
  reviewDecision: z.string().nullable(), mergeStateStatus: z.string(), mergeable: z.string(),
  latestReviews: z.array(z.object({ state: z.string(), body: z.string().optional() }).passthrough()),
  statusCheckRollup: z.array(z.unknown()),
});
const terminalSchema = viewSchema.pick({ url: true, number: true, title: true, state: true });
/** Completed PRs need no surviving branch or review history to leave the queue. */
function terminalFacts(value: unknown, prUrl: string, repo: string, number: number): AdvanceInspection | null {
  const parsed = terminalSchema.safeParse(value);
  if (!parsed.success || parsed.data.state === "OPEN") return null;
  const view = parsed.data;
  if (view.number !== number || view.url.toLowerCase() !== prUrl.toLowerCase()) return { ok: false, error: "GitHub returned a different pull request." };
  const raw = value as Record<string, unknown>;
  return { ok: true, facts: {
    prUrl: view.url, number, title: view.title.slice(0, 300), repo,
    headRefName: branch.safeParse(raw.headRefName).data ?? "", baseRefName: branch.safeParse(raw.baseRefName).data ?? "",
    headOid: oid.safeParse(raw.headRefOid).data ?? "", baseOid: "",
    state: view.state, isDraft: false, isCrossRepository: raw.isCrossRepository === true,
    reviewDecision: null, mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN", needsPreparation: false,
    readiness: view.state === "MERGED" ? "merged" : "closed", detail: view.state === "MERGED" ? "PR merged." : "PR closed without merging.",
    unresolvedThreads: 0, checks: "unknown", basePrNumber: null, approvalNotePending: false,
  } };
}
const fields = Object.keys(viewSchema.shape).join(",");
const refsSchema = z.object({ headRefOid: oid, baseRefName: branch, baseRef: z.object({ name: branch, target: z.object({ oid }) }) });
const refsQuery = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefName baseRef{name target{oid}}}}}";

function refsOf(result: Run) {
  const body = decoded(result) as { errors?: unknown; data?: { repository?: { pullRequest?: unknown } } } | undefined;
  return refsSchema.safeParse(body?.errors === undefined ? body?.data?.repository?.pullRequest : undefined);
}

function decoded(result: Run): unknown {
  if (!result.ok) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

/** Empty conclusions on queued/running checks must never look like passing checks. */
export function advanceChecks(rollup: readonly unknown[]): AdvanceFacts["checks"] {
  let pending = false;
  let unknown = false;
  for (const item of rollup) {
    if (item === null || typeof item !== "object") { unknown = true; continue; }
    const check = item as Record<string, unknown>;
    if (check.status !== undefined) {
      if (["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(String(check.status))) { pending = true; continue; }
      if (check.status !== "COMPLETED") { unknown = true; continue; }
      if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(String(check.conclusion))) return "failed";
      if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(check.conclusion))) unknown = true;
    } else if (check.state === "PENDING" || check.state === "EXPECTED") pending = true;
    else if (check.state === "ERROR" || check.state === "FAILURE") return "failed";
    else if (check.state !== "SUCCESS") unknown = true;
  }
  return unknown ? "unknown" : pending ? "pending" : "passed";
}

export async function readAdvancePr(run: GhRunner, prUrl: string): Promise<AdvanceInspection> {
  const target = prTarget(prUrl);
  if (target === null) return { ok: false, error: "That is not a pull request URL." };
  const readView = () => run(["pr", "view", String(target.number), "--repo", target.slug, "--json", fields]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const firstRun = await readView();
    const terminal = terminalFacts(decoded(firstRun), prUrl, target.slug, target.number);
    if (terminal) return terminal;
    const first = viewSchema.safeParse(decoded(firstRun));
    if (!first.success) return { ok: false, error: firstRun.ok ? "GitHub returned incomplete PR preparation facts." : `Could not read the PR: ${firstRun.error}`.slice(0, 800) };
    if (first.data.number !== target.number || first.data.url.toLowerCase() !== prUrl.toLowerCase()) return { ok: false, error: "GitHub returned a different pull request." };
    let reviewRefs: z.infer<typeof refsSchema> | undefined;
    const capture: GhRunner = async (args, stdin) => {
      const response = await run(args, stdin);
      const refs = refsOf(response);
      if (refs.success) reviewRefs = refs.data;
      return response;
    };
    const [threads, basesRun] = await Promise.all([
      readReviewThreads(capture, target, true, true),
      run(["pr", "list", "--repo", target.slug, "--head", first.data.baseRefName, "--state", "open", "--limit", "2", "--json", "number,headRefName"]),
    ]);
    if (!threads.ok) return { ok: false, error: `Could not verify review feedback: ${threads.error}`.slice(0, 800) };
    const bases = z.array(z.object({ number: z.number().int().positive(), headRefName: z.string() })).safeParse(decoded(basesRun));
    if (!bases.success || bases.data.some((base) => base.headRefName !== first.data.baseRefName)) return { ok: false, error: "Could not verify the PR's stack dependencies." };
    if (bases.data.length > 1) return { ok: false, error: "Multiple open PRs match the base branch; its stack dependency is ambiguous." };
    const [finalRun, finalRefsRun] = await Promise.all([
      readView(),
      run(["api", "graphql", ...(target.host === "github.com" ? [] : ["--hostname", target.host]),
        "-f", `query=${refsQuery}`, "-f", `owner=${target.owner}`, "-f", `name=${target.name}`, "-F", `number=${target.number}`]),
    ]);
    const completed = terminalFacts(decoded(finalRun), prUrl, target.slug, target.number);
    if (completed) return completed;
    const final = viewSchema.safeParse(decoded(finalRun));
    const finalRefs = refsOf(finalRefsRun);
    if (!final.success) return { ok: false, error: "Could not verify the final PR head and base commits." };
    if (!reviewRefs || !finalRefs.success) return { ok: false, error: "Could not verify the current base branch tip." };
    // Review/check snapshots must describe the same commits and review decision.
    // PR.baseRefOid is a historical per-PR snapshot, not the current ref target.
    const identity = (view: z.infer<typeof viewSchema>) => JSON.stringify([view.url, view.headRefOid, view.headRefName, view.baseRefName, view.state, view.isDraft, view.isCrossRepository, view.reviewDecision, view.latestReviews]);
    const refs = finalRefs.data;
    if (identity(first.data) !== identity(final.data) || reviewRefs.headRefOid !== final.data.headRefOid || refs.headRefOid !== final.data.headRefOid ||
        reviewRefs.baseRefName !== final.data.baseRefName || refs.baseRefName !== final.data.baseRefName ||
        reviewRefs.baseRef.name !== final.data.baseRefName || refs.baseRef.name !== final.data.baseRefName ||
        reviewRefs.baseRef.target.oid !== refs.baseRef.target.oid) continue;
    const view = final.data;
    const checks = advanceChecks(view.statusCheckRollup);
    const approvalNotePending = approvalHasBody(view.latestReviews) && threads.approvalNoteFollowedUp !== true;
    const mergeStateStatus = parseMergeStateStatus(view.mergeStateStatus);
    const needsPreparation = mergeStateStatus === "BEHIND" || mergeStateStatus === "DIRTY" || view.mergeable === "CONFLICTING";
    const basePrNumber = bases.data[0]?.number ?? null;
    let readiness: AdvanceFacts["readiness"] = "needs-attention";
    let detail: string;
    if (view.state !== "OPEN") detail = "This PR is no longer open.";
    else if (view.isDraft) detail = "This PR is still a draft.";
    else if (needsPreparation) detail = mergeStateStatus === "DIRTY" || view.mergeable === "CONFLICTING" ? "Resolve conflicts, test, and push the prepared branch." : "Update the branch against its base, test, and push.";
    else if (threads.count > 0) detail = `${threads.count}${threads.hasNextPage ? "+" : ""} unresolved review threads need attention.`;
    else if (threads.hasNextPage) detail = "Review threads are incomplete; readiness needs another check.";
    else if (threads.approvalNotesComplete !== true) detail = "Review history is incomplete; readiness needs another check.";
    else if (approvalNotePending) detail = "An approving review includes a note without confirmed follow-up.";
    else if (checks === "failed") detail = "One or more checks failed.";
    else if (checks === "unknown") detail = "Check results are incomplete or unknown.";
    else if (view.reviewDecision !== "APPROVED") { readiness = "waiting-review"; detail = view.reviewDecision === "CHANGES_REQUESTED" ? "Review still requests changes; wait for a new approval after follow-up." : "Waiting for approval on the current PR."; }
    else if (basePrNumber !== null) detail = "The base branch belongs to another open PR; advance that dependency first.";
    else if (checks === "pending") { readiness = "waiting-checks"; detail = "Waiting for checks on the current head commit."; }
    else if (view.mergeable !== "MERGEABLE" || !["CLEAN", "HAS_HOOKS"].includes(mergeStateStatus)) detail = "GitHub has not confirmed that all merge requirements are satisfied.";
    else { readiness = "ready"; detail = "Approved, review feedback clear, checks passed, and branch ready to merge."; }
    return { ok: true, facts: {
      prUrl: view.url, number: view.number, title: view.title.slice(0, 300), repo: target.slug,
      headRefName: view.headRefName, baseRefName: view.baseRefName, headOid: view.headRefOid, baseOid: refs.baseRef.target.oid,
      state: view.state, isDraft: view.isDraft, isCrossRepository: view.isCrossRepository,
      reviewDecision: view.reviewDecision || null, mergeStateStatus, mergeable: view.mergeable,
      needsPreparation, readiness, detail, unresolvedThreads: threads.count, checks, basePrNumber, approvalNotePending,
    } };
  }
  return { ok: false, error: "The PR head, base, or reviews changed during verification. Refresh and try again." };
}
