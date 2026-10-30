import { canonicalPrUrl } from "./pr-holds.js";
import type { EffortMembers } from "./effort-store.js";

export type PrWork = { key: string; tickets: readonly string[] };

/** Only recorded PR identities and an exact scanned checkout identify thread work. */
export function confirmedThreadPrUrls(input: {
  metadata: Record<string, unknown>;
  recordedUrls: readonly string[];
  environmentPath: string | null;
  scanned: readonly { path: string; pr: { url: string } | null }[];
  knownUrls: readonly string[];
}): string[] {
  const known = new Set(input.knownUrls.map((url) => canonicalPrUrl(url)).filter((url): url is string => url !== null));
  const candidates = [input.metadata.linkedPrUrl, input.metadata.prUrl, ...input.recordedUrls,
    ...input.scanned.filter((unit) => input.environmentPath !== null &&
      unit.path.replace(/\/+$/u, "") === input.environmentPath!.replace(/\/+$/u, ""))
      .flatMap((unit) => unit.pr?.url ?? [])];
  return [...new Set(candidates.flatMap((value) => typeof value === "string" ? [canonicalPrUrl(value)] : [])
    .filter((url): url is string => url !== null && known.has(url)))].sort();
}

/** A connected ticket cohort claims only confirmed PRs, with sibling PRs as conflict guards. */
export function confirmedPrCohorts(confirmedUrls: readonly string[], work: readonly PrWork[]):
  { members: EffortMembers; guard: EffortMembers }[] {
  const byUrl = new Map(work.map((item) => [item.key, item]));
  const pending = new Set(confirmedUrls.filter((url) => byUrl.has(url)));
  const cohorts: { members: EffortMembers; guard: EffortMembers }[] = [];
  while (pending.size > 0) {
    const urls = new Set<string>([pending.values().next().value!]);
    const tickets = new Set<string>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const url of urls) for (const ticket of byUrl.get(url)?.tickets ?? []) tickets.add(ticket);
      for (const url of pending) {
        if (urls.has(url)) continue;
        if ((byUrl.get(url)?.tickets ?? []).some((ticket) => tickets.has(ticket))) { urls.add(url); expanded = true; }
      }
    }
    for (const url of urls) pending.delete(url);
    const guardUrls = new Set(urls);
    const guardTickets = new Set(tickets);
    expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of work) {
        if (!item.tickets.some((ticket) => guardTickets.has(ticket)) || guardUrls.has(item.key)) continue;
        guardUrls.add(item.key);
        for (const ticket of item.tickets) guardTickets.add(ticket);
        expanded = true;
      }
    }
    cohorts.push({ members: { tickets: [...tickets].sort(), prUrls: [...urls].sort() },
      guard: { tickets: [...guardTickets].sort(), prUrls: [...guardUrls].sort() } });
  }
  return cohorts;
}
