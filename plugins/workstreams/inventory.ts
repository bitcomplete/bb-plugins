// Authored open PRs exist independently of local checkouts. Only gh supplies
// their facts; no local paths or synthetic checkout state enter this inventory.
import type { Pr } from "./contract.js";
import { parsePrList, PR_FIELDS } from "./gh.js";
import { prTarget, readReviewThreads, type GhRunner } from "./ghactions.js";

export type InventoryEntry = { repo: string; pr: Pr };
export type InventoryResult = {
  owners: string[];
  entries: InventoryEntry[];
  /** A complete discovery permits removing cached repos absent from the result. */
  discoveryComplete: boolean;
  /** Membership completeness: true permits removing missing PRs from this repo. */
  repositories: { repo: string; complete: boolean }[];
  /** Includes review-thread verification, independently of membership coverage. */
  complete: boolean;
  warnings: string[];
};
/** A PR a read found merged, with GitHub's merge time, and the title and branch that still place it in an effort once it leaves the inventory. */
export type MergeSighting = { url: string; at: string; title: string; headRefName: string | null };
export type InventoryInspection = { entries: InventoryEntry[]; closed: string[]; failed: string[]; warnings: string[]; merged?: MergeSighting[] };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
export const INVENTORY_LIMIT = 1_000;
const CONCURRENCY = 4;
const AGES_BATCH = 25;
// The query text varies only with how many PRs one read names; every value is a typed -f/-F field.
const AGES_FRAGMENT = "fragment ages on PullRequest{commits(last:1){nodes{commit{oid committedDate}}} " +
  "timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT],last:100){nodes{...on ReviewRequestedEvent{createdAt requestedReviewer{...on User{login}...on Bot{login}...on Team{combinedSlug}}}}}}";

/** One GraphQL read of a repository's PRs, for the dates GitHub keeps but `gh pr list` doesn't return. */
export function agesArgv(repo: string, numbers: readonly number[]): string[] {
  const [owner, name] = repo.split("/") as [string, string];
  const query = `query($owner:String!,$name:String!,${numbers.map((_, index) => `$n${index}:Int!`).join(",")}){repository(owner:$owner,name:$name){` +
    `${numbers.map((_, index) => `p${index}:pullRequest(number:$n${index}){...ages}`).join(" ")}}}${AGES_FRAGMENT}`;
  return ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
    ...numbers.flatMap((number, index) => ["-F", `n${index}=${number}`])];
}

function jsonArray(raw: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function bounded<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]!);
  }));
}

/** A PR a reviewer approved or asked to change, whose approval evidence is read, a draft's too: an approval's notes wait on you there too. */
const readsApproval = (pr: Pr) => pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED";
/** A PR whose review threads are read: one of those, and not a draft. */
const readsReviewThreads = (pr: Pr) => !pr.isDraft && readsApproval(pr);
/**
 * A PR whose review read says what feedback waits on you (your-turn.ts): those, and any other a reviewer has reviewed, drafts included.
 * Only those keep approval evidence, and only the ones not in draft their thread counts, so a PR with only comments keeps its state word.
 * The checkout scan reads by it too, through reviewFacts: a PR it names left unread would say nothing waits on you.
 */
const readsReviewFeedback = (pr: Pr) => readsApproval(pr) || pr.latestReviews.some((review) => review.state !== "PENDING");

/**
 * Read into this PR the feedback waiting on it, when it has any to read: the inventory's and the checkout scan's one review read. `read`
 * includes the follow-up read: your replies and reviewers' comments in the conversation date the feedback.
 */
export async function reviewFacts(read: (url: string) => ReturnType<typeof readReviewThreads>, pr: Pr, warn: (message: string) => void): Promise<void> {
  if (!readsReviewFeedback(pr)) return;
  const named = `${prTarget(pr.url)?.slug} #${pr.number}`;
  const threads = await read(pr.url);
  if (!threads.ok) {
    warn(`${named}: review threads could not be checked: ${threads.error}`);
    return;
  }
  if (threads.reviewFeedback) pr.reviewFeedback = threads.reviewFeedback;
  if (readsApproval(pr)) pr.approvalFeedback = threads.approvalFeedback;
  if (!readsReviewThreads(pr)) return;
  pr.unresolvedReviewThreads = threads.count;
  pr.resolvedReviewThreads = threads.resolvedCount;
  pr.reviewFollowupPosted = threads.reviewFollowupPosted;
  if (threads.hasNextPage) warn(`${named}: more review threads remain unread.`);
}
/** The inventory's review read: one gh call per PR, with the follow-up read. */
const threadsRead = (run: GhRunner) => (url: string) => readReviewThreads(run, prTarget(url)!, true);

const date = (value: unknown): string | null => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value.slice(0, 40) : null;
type AgesNode = { commits?: { nodes?: { commit?: { oid?: unknown; committedDate?: unknown } }[] };
  timelineItems?: { nodes?: ({ createdAt?: unknown; requestedReviewer?: { login?: unknown; combinedSlug?: unknown } | null } | null)[] } };

/**
 * The head commit's date, only when it is the head `gh pr list` returned, and when each reviewer still requested
 * was last asked. Anything unread stays absent, and an absent date never ages a reason.
 */
function agesOf(node: unknown, pr: Pr): Pick<Pr, "headCommittedAt" | "reviewRequestedAt"> {
  const view = (node !== null && typeof node === "object" ? node : {}) as AgesNode;
  const head = Array.isArray(view.commits?.nodes) ? view.commits.nodes[0]?.commit : undefined;
  const committed = pr.headRefOid !== undefined && head?.oid === pr.headRefOid ? date(head.committedDate) : null;
  if (!Array.isArray(view.timelineItems?.nodes)) return committed === null ? {} : { headCommittedAt: committed };
  const asked = new Map<string, string>();
  for (const event of view.timelineItems.nodes) {
    const who = event?.requestedReviewer?.login ?? event?.requestedReviewer?.combinedSlug;
    const at = date(event?.createdAt);
    if (typeof who !== "string" || at === null) continue;
    const previous = asked.get(who.toLowerCase());
    if (previous === undefined || Date.parse(at) > Date.parse(previous)) asked.set(who.toLowerCase(), at);
  }
  return { ...(committed === null ? {} : { headCommittedAt: committed }),
    reviewRequestedAt: pr.reviewRequests.flatMap((reviewer) => { const at = asked.get(reviewer.toLowerCase()); return at ? [{ reviewer, at }] : []; }) };
}

/** Date what PR attention ages, one read per repository and batch. A failed read leaves its PRs undated, which nudges no one. */
async function readAges(run: GhRunner, entries: readonly InventoryEntry[], warn: (message: string) => void): Promise<void> {
  const byRepo = new Map<string, InventoryEntry[]>();
  for (const entry of entries) byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), entry]);
  const batches = [...byRepo.values()].flatMap((list) =>
    Array.from({ length: Math.ceil(list.length / AGES_BATCH) }, (_, index) => list.slice(index * AGES_BATCH, (index + 1) * AGES_BATCH)));
  await bounded(batches, async (batch) => {
    const repo = batch[0]!.repo;
    const read = await run(agesArgv(repo, batch.map((entry) => entry.pr.number)));
    let body: { errors?: unknown; data?: { repository?: Record<string, unknown> | null } } | undefined;
    if (read.ok) try { body = JSON.parse(read.stdout); } catch { /* Reported below. */ }
    const repository = body?.errors === undefined ? body?.data?.repository : undefined;
    if (repository === null || repository === undefined || typeof repository !== "object") {
      warn(`${repo}: PR ages could not be read${read.ok ? "" : `: ${read.error}`}; their waits stay undated.`);
      return;
    }
    batch.forEach((entry, index) => Object.assign(entry.pr, agesOf(repository[`p${index}`], entry.pr)));
  });
}

/** Re-read known PRs after an action or native BB invalidation, without rediscovery. */
export async function readInventoryPrs(run: GhRunner, prUrls: readonly string[]): Promise<InventoryInspection> {
  const result: InventoryInspection = { entries: [], closed: [], failed: [], warnings: [] };
  const warn = (message: string) => { if (result.warnings.length < 50) result.warnings.push(message.slice(0, 500)); };
  await bounded([...new Set(prUrls)].slice(0, 100), async (url) => {
    const target = prTarget(url);
    if (target === null || target.host.toLowerCase() !== "github.com") {
      result.failed.push(url);
      warn("A PR refresh target is not a valid github.com PR URL.");
      return;
    }
    const read = await run(["pr", "view", String(target.number), "--repo", target.slug, "--json", PR_FIELDS]);
    let parsed: ReturnType<typeof parsePrList> = null;
    if (read.ok) {
      try { parsed = parsePrList(JSON.stringify([JSON.parse(read.stdout)])); } catch { /* Report unreadable data below. */ }
    }
    if (parsed === null || parsed.pr.url.toLowerCase() !== url.toLowerCase() || parsed.pr.number !== target.number ||
        !["OPEN", "CLOSED", "MERGED"].includes(parsed.pr.state)) {
      result.failed.push(url);
      warn(`${target.slug} #${target.number}: PR refresh failed: ${read.ok ? "unreadable PR data" : read.error}`);
      return;
    }
    if (parsed.pr.state !== "OPEN") {
      result.closed.push(url);
      if (parsed.pr.state === "MERGED" && parsed.pr.mergedAt) (result.merged ??= []).push({ url, at: parsed.pr.mergedAt, title: parsed.pr.title,
        headRefName: parsed.pr.headRefName });
      return;
    }
    const entry = { repo: target.slug, pr: parsed.pr };
    await reviewFacts(threadsRead(run), entry.pr, warn);
    result.entries.push(entry);
  });
  await readAges(run, result.entries, warn);
  result.entries.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
  result.closed.sort();
  result.failed.sort();
  result.merged?.sort((a, b) => a.url.localeCompare(b.url));
  return result;
}

/** An empty read of these organizations; not valid, with the result warning why, when the scope is empty or invalid. */
function scoped(scopeOwners: readonly string[]): { result: InventoryResult; warn: (message: string) => void; valid: boolean } {
  const owners = [...new Set(scopeOwners.filter((owner) => OWNER.test(owner)).map((owner) => owner.toLowerCase()))].sort().slice(0, 50);
  const result: InventoryResult = { owners, entries: [], discoveryComplete: false, repositories: [], complete: true, warnings: [] };
  const warn = (message: string) => {
    result.complete = false;
    if (result.warnings.length < 50) result.warnings.push(message.slice(0, 500));
  };
  const valid = owners.length > 0 && scopeOwners.every((owner) => OWNER.test(owner)) && new Set(scopeOwners.map((owner) => owner.toLowerCase())).size <= 50;
  if (!valid) warn("Authored PR discovery needs 1–50 valid GitHub organization names from the scanned projects.");
  return { result, warn, valid };
}

const POLL_PAGE = 50;
/**
 * Constant: the search text and cursor are typed -f fields, never spliced in. Each PR carries what `gh pr list --json` returns, the
 * dates the ages read adds, and its review threads' resolution; approval feedback and a changes request's follow-up need the PR's own read.
 */
export const OPEN_PRS_QUERY = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:${POLL_PAGE},after:$after){pageInfo{hasNextPage endCursor} nodes{...on PullRequest{` +
  "number state isDraft reviewDecision url title mergeable mergeStateStatus baseRefName headRefName headRefOid baseRefOid createdAt updatedAt mergedAt body mergeCommit{oid} " +
  "latestReviews(first:50){nodes{author{login} state submittedAt body}} " +
  "reviewRequests(first:20){nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{slug organization{login}}}}} " +
  "commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{status conclusion} ...on StatusContext{state}}}}}}} " +
  "timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT],last:50){nodes{...on ReviewRequestedEvent{createdAt requestedReviewer{...on User{login}...on Bot{login}...on Team{combinedSlug}}}}} " +
  "reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}}";

type PollNode = Record<string, unknown> & { latestReviews?: { nodes?: unknown }; reviewRequests?: { nodes?: { requestedReviewer?: unknown }[] };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: unknown } } | null } }[] };
  reviewThreads?: { pageInfo?: { hasNextPage?: unknown }; nodes?: { isResolved?: unknown }[] } };

/** A search node as one `gh pr list --json` row, so one parser reads both. */
function pollRow(node: PollNode): unknown {
  return { ...node, latestReviews: node.latestReviews?.nodes, reviewRequests: node.reviewRequests?.nodes?.map((request) => request?.requestedReviewer),
    statusCheckRollup: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [] };
}

/**
 * Every open PR you author in these organizations, from one GraphQL search read 50 PRs a page: the inventory poll's read, in place of
 * discovery, a listing per repository, and a read per PR. Review threads are counted where the per-PR read would count them; the approval
 * feedback and follow-up that read proves are left absent for the caller to carry or read.
 */
export async function readOpenAuthoredPrs(run: GhRunner, scopeOwners: readonly string[]): Promise<InventoryResult> {
  const { result, warn, valid } = scoped(scopeOwners);
  if (!valid) return result;
  const q = `is:pr is:open author:@me sort:created-asc ${result.owners.map((owner) => `user:${owner}`).join(" ")}`;
  const entries = new Map<string, InventoryEntry>();
  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page === INVENTORY_LIMIT / POLL_PAGE) {
      warn(`The authored PR poll reached its ${INVENTORY_LIMIT} PR limit; coverage is partial.`);
      break;
    }
    const read = await run(["api", "graphql", "-f", `query=${OPEN_PRS_QUERY}`, "-f", `q=${q}`, ...(after === null ? [] : ["-f", `after=${after}`])]);
    let body: { errors?: unknown; data?: { search?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } } } | undefined;
    if (read.ok) try { body = JSON.parse(read.stdout); } catch { /* Reported below. */ }
    const search = body?.errors === undefined ? body?.data?.search : undefined;
    const more = search?.pageInfo?.hasNextPage;
    if (!Array.isArray(search?.nodes) || typeof more !== "boolean" || (more && typeof search.pageInfo?.endCursor !== "string")) {
      warn(`Authored PR poll failed: ${read.ok ? "GitHub returned unreadable data" : read.error}`);
      break;
    }
    for (const node of search.nodes as (PollNode | null)[]) {
      const parsed = node === null || typeof node !== "object" ? null : parsePrList(JSON.stringify([pollRow(node)]));
      const target = parsed === null ? null : prTarget(parsed.pr.url);
      if (parsed === null || target === null || target.host.toLowerCase() !== "github.com" || !result.owners.includes(target.owner.toLowerCase()) ||
          parsed.pr.number !== target.number) {
        warn("The authored PR poll returned an unreadable or out-of-scope PR; membership is partial.");
        continue;
      }
      if (parsed.pr.state !== "OPEN") continue;
      const pr: Pr = { ...parsed.pr, url: `https://github.com/${target.owner}/${target.name}/pull/${target.number}`, ...agesOf(node, parsed.pr) };
      const threads = node!.reviewThreads;
      if (readsReviewThreads(pr) && Array.isArray(threads?.nodes) && typeof threads.pageInfo?.hasNextPage === "boolean") {
        const open = threads.nodes.filter((thread) => thread?.isResolved === false).length;
        // As the per-PR read counts them: an unread page leaves the resolved count unknown, and no open thread seen proves nothing.
        if (open > 0 || !threads.pageInfo.hasNextPage) Object.assign(pr, { unresolvedReviewThreads: open,
          resolvedReviewThreads: threads.pageInfo.hasNextPage ? null : threads.nodes.length - open });
      }
      entries.set(pr.url.toLowerCase(), { repo: target.slug, pr });
    }
    if (!more) {
      // Membership is whole only when every page read cleanly: then a PR it no longer lists left the search.
      result.discoveryComplete = result.complete;
      break;
    }
    after = search.pageInfo!.endCursor as string;
  }
  result.entries = [...entries.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
  result.repositories = [...new Set(result.entries.map((entry) => entry.repo))].sort().map((repo) => ({ repo, complete: result.discoveryComplete }));
  return result;
}

/**
 * A polled PR with the review evidence only its own read proves, carried from the stored read while nothing on the PR moved since: its
 * head, review decision, latest reviews, and GitHub's update time. Null when the PR needs that read again. A PR whose reviews aren't read
 * needs nothing. Open threads never outnumber the ones this poll counted.
 */
export function carryReviewFacts(pr: Pr, stored: Pr | undefined): Pr | null {
  if (!readsReviewFeedback(pr)) return pr;
  const approval = readsApproval(pr), threads = readsReviewThreads(pr);
  // A stored read from before feedback to address dated notes and follow-ups can't say whether anything answered them.
  if (stored === undefined || (approval && stored.approvalFeedback === undefined) || stored.reviewFeedback?.followUpAt === undefined ||
      stored.headRefOid !== pr.headRefOid || stored.reviewDecision !== pr.reviewDecision ||
      stored.updatedAt !== pr.updatedAt || JSON.stringify(stored.latestReviews) !== JSON.stringify(pr.latestReviews)) return null;
  const feedback = { ...stored.reviewFeedback, openThreads: Math.min(stored.reviewFeedback.openThreads, pr.unresolvedReviewThreads ?? Number.POSITIVE_INFINITY) };
  return { ...pr, reviewFeedback: feedback, ...approval ? { approvalFeedback: stored.approvalFeedback } : {},
    ...threads && stored.reviewFollowupPosted !== undefined ? { reviewFollowupPosted: stored.reviewFollowupPosted } : {} };
}

/** Empty or invalid scope never expands discovery to unrelated organizations. */
export async function readAuthoredPrs(run: GhRunner, scopeOwners: readonly string[]): Promise<InventoryResult> {
  const { result, warn, valid } = scoped(scopeOwners);
  if (!valid) return result;
  const owners = result.owners;
  const searched = await run(["search", "prs", "--author", "@me", "--state", "open", "--owner", owners.join(","), "--limit", String(INVENTORY_LIMIT), "--json", "url"]);
  if (!searched.ok) {
    warn(`Authored PR discovery failed: ${searched.error}`);
    return result;
  }
  const found = jsonArray(searched.stdout);
  if (found === null) {
    warn("Authored PR discovery returned unreadable data.");
    return result;
  }
  result.discoveryComplete = found.length < INVENTORY_LIMIT;
  if (!result.discoveryComplete) warn(`Authored PR discovery reached its ${INVENTORY_LIMIT} PR limit; coverage is partial.`);
  const repos = new Map<string, string>();
  for (const row of found.slice(0, INVENTORY_LIMIT)) {
    const url = row !== null && typeof row === "object" ? (row as { url?: unknown }).url : null;
    const target = typeof url === "string" ? prTarget(url) : null;
    if (target === null || target.host.toLowerCase() !== "github.com" || !owners.includes(target.owner.toLowerCase())) {
      result.discoveryComplete = false;
      warn("Authored PR discovery included an invalid or out-of-scope PR URL.");
      continue;
    }
    repos.set(target.slug.toLowerCase(), target.slug);
  }
  const collected = new Map<string, InventoryEntry[]>();
  await bounded([...repos.values()].sort(), async (repo) => {
    const coverage = { repo, complete: false };
    result.repositories.push(coverage);
    const listed = await run(["pr", "list", "--repo", repo, "--author", "@me", "--state", "open", "--limit", String(INVENTORY_LIMIT), "--json", PR_FIELDS]);
    if (!listed.ok) {
      warn(`${repo}: authored PRs could not be read: ${listed.error}`);
      return;
    }
    const rows = jsonArray(listed.stdout);
    if (rows === null) {
      warn(`${repo}: authored PRs returned unreadable data.`);
      return;
    }
    coverage.complete = rows.length < INVENTORY_LIMIT;
    if (!coverage.complete) warn(`${repo}: authored PR listing reached its ${INVENTORY_LIMIT} PR limit.`);
    const entries = new Map<string, InventoryEntry>();
    for (const row of rows.slice(0, INVENTORY_LIMIT)) {
      const parsed = parsePrList(JSON.stringify([row]));
      const target = parsed === null ? null : prTarget(parsed.pr.url);
      if (parsed === null || target === null || target.slug.toLowerCase() !== repo.toLowerCase() ||
          !Number.isInteger(parsed.pr.number) || parsed.pr.number !== target.number ||
          !["OPEN", "CLOSED", "MERGED"].includes(parsed.pr.state)) {
        coverage.complete = false;
        warn(`${repo}: an unreadable PR was omitted; membership is partial.`);
        continue;
      }
      // A PR may close between discovery and the repository read.
      if (parsed.pr.state !== "OPEN") continue;
      const url = `https://github.com/${target.owner}/${target.name}/pull/${target.number}`;
      entries.set(url.toLowerCase(), { repo, pr: { ...parsed.pr, url } });
    }
    collected.set(repo, [...entries.values()]);
  });
  result.repositories.sort((a, b) => a.repo.localeCompare(b.repo));
  for (const repo of result.repositories) {
    const entries = collected.get(repo.repo) ?? [];
    const capacity = INVENTORY_LIMIT - result.entries.length;
    if (entries.length > capacity) {
      repo.complete = false;
      warn(`Authored PR inventory reached its ${INVENTORY_LIMIT} PR limit; ${repo.repo} is partial.`);
    }
    result.entries.push(...entries.slice(0, capacity).sort((a, b) => a.pr.number - b.pr.number));
  }
  await bounded(result.entries, (entry) => reviewFacts(threadsRead(run), entry.pr, warn));
  await readAges(run, result.entries, warn);
  return result;
}
