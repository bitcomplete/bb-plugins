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
export type InventoryInspection = { entries: InventoryEntry[]; closed: string[]; failed: string[]; warnings: string[] };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
export const INVENTORY_LIMIT = 1_000;
const CONCURRENCY = 4;

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

async function reviewFacts(run: GhRunner, entry: InventoryEntry, warn: (message: string) => void): Promise<void> {
  const { repo, pr } = entry;
  if (pr.isDraft || (pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== "CHANGES_REQUESTED")) return;
  const threads = await readReviewThreads(run, prTarget(pr.url)!, pr.reviewDecision === "CHANGES_REQUESTED" || pr.approvalHasBody === true);
  if (!threads.ok) {
    warn(`${repo} #${pr.number}: review threads could not be checked: ${threads.error}`);
    return;
  }
  pr.unresolvedReviewThreads = threads.count;
  pr.resolvedReviewThreads = threads.resolvedCount;
  pr.approvalNoteFollowedUp = threads.approvalNoteFollowedUp;
  pr.reviewFollowupPosted = threads.reviewFollowupPosted;
  if (threads.hasNextPage) warn(`${repo} #${pr.number}: more review threads remain unread.`);
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
      return;
    }
    const entry = { repo: target.slug, pr: parsed.pr };
    await reviewFacts(run, entry, warn);
    result.entries.push(entry);
  });
  result.entries.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
  result.closed.sort();
  result.failed.sort();
  return result;
}

/** Empty or invalid scope never expands discovery to unrelated organizations. */
export async function readAuthoredPrs(run: GhRunner, scopeOwners: readonly string[]): Promise<InventoryResult> {
  const owners = [...new Set(scopeOwners.filter((owner) => OWNER.test(owner)).map((owner) => owner.toLowerCase()))].sort().slice(0, 50);
  const result: InventoryResult = { owners, entries: [], discoveryComplete: false, repositories: [], complete: true, warnings: [] };
  const warn = (message: string) => {
    result.complete = false;
    if (result.warnings.length < 50) result.warnings.push(message.slice(0, 500));
  };
  if (owners.length === 0 || scopeOwners.some((owner) => !OWNER.test(owner)) || new Set(scopeOwners.map((owner) => owner.toLowerCase())).size > 50) {
    warn("Authored PR discovery needs 1–50 valid GitHub organization names from the scanned projects.");
    return result;
  }
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
  await bounded(result.entries, (entry) => reviewFacts(run, entry, warn));
  return result;
}
