import { displayTitle } from "./workstreams.js";
import { ticketsIn } from "./threads.js";
import type { Pr } from "./contract.js";
import type { EstablishedEffort } from "./effort-store.js";

type Group = { key: string; name: string; clusters: readonly { ticket: string; units: readonly { pr: { url: string } | null }[] }[] };
/** Checkout availability affects actions, never exact-ticket membership. Ambiguous tickets stay unassigned. */
export function inventoryEffort(pr: Pick<Pr, "url" | "title" | "headRefName">, groups: readonly Group[], efforts: readonly EstablishedEffort[], pattern: RegExp): { effortKey: string; effortName: string } | null {
  const url = pr.url.toLowerCase();
  const ticketRefs = ticketsIn(`${pr.title}\n${pr.headRefName ?? ""}`, pattern);
  const exact = efforts.find((effort) => effort.members.prUrls.includes(url));
  if (exact) return { effortKey: exact.key, effortName: exact.name };
  const explicit = efforts.filter((effort) => ticketRefs.some((ticket) => effort.members.tickets.includes(ticket)));
  if (explicit.length === 1) return { effortKey: explicit[0]!.key, effortName: explicit[0]!.name };
  if (explicit.length > 1) return null;
  const matched = groups.filter((group) => group.clusters.some((cluster) =>
    cluster.units.some((unit) => unit.pr?.url.toLowerCase() === url) || ticketRefs.includes(cluster.ticket)));
  return matched.length === 1 ? { effortKey: matched[0]!.key, effortName: matched[0]!.name } : null;
}


export type InventoryTicketEffort = { key: string; name: string; ticket: string; prUrls: string[]; repoCount: number };
const prKey = (url: string) => url.replace(/\/$/u, "").toLowerCase();

/** Exact remote ticket cohorts add membership, never pretend to be local checkouts. */
export function inventoryTicketEfforts(
  entries: readonly { repo: string; pr: Pick<Pr, "url" | "title" | "headRefName" | "state"> }[],
  groups: readonly Group[], efforts: readonly EstablishedEffort[], pattern: RegExp,
  cachedTitles: ReadonlyMap<string, string> = new Map(),
): InventoryTicketEffort[] {
  const anchoredTickets = new Set([...groups.flatMap((group) => group.clusters.map((cluster) => cluster.ticket)), ...efforts.flatMap((effort) => effort.members.tickets)]);
  const anchoredUrls = new Set([...groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.units.flatMap((unit) => unit.pr ? [prKey(unit.pr.url)] : []))), ...efforts.flatMap((effort) => effort.members.prUrls.map(prKey))]);
  const cohorts = new Map<string, Map<string, (typeof entries)[number]>>();
  for (const entry of entries) {
    if (entry.pr.state !== "OPEN" || anchoredUrls.has(prKey(entry.pr.url))) continue;
    const tickets = ticketsIn(`${entry.pr.title}\n${entry.pr.headRefName ?? ""}`, pattern);
    if (tickets.length !== 1 || anchoredTickets.has(tickets[0]!)) continue;
    const ticket = tickets[0]!;
    const cohort = cohorts.get(ticket) ?? new Map();
    cohort.set(prKey(entry.pr.url), entry);
    cohorts.set(ticket, cohort);
  }
  return [...cohorts].filter(([, members]) => members.size >= 2).sort(([a], [b]) => a.localeCompare(b)).map(([ticket, members]) => {
    const titles = [...new Set([...members.values()].map(({ pr }) => displayTitle(pr.title).trim()))].filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const words = (titles[0] ?? ticket).split(/\s+/u);
    let shared = words.length;
    for (const title of titles.slice(1)) {
      const next = title.split(/\s+/u);
      shared = Math.min(shared, next.length);
      for (let index = 0; index < shared; index++) if (words[index]!.toLowerCase() !== next[index]!.toLowerCase()) { shared = index; break; }
    }
    const prefix = words.slice(0, shared).join(" ").replace(/[\s:;—–-]+$/u, "");
    const meaningful = prefix.split(/\s+/u).filter((word) => !/^(?:add|fix|use|require|update|create|support|the|a|an|for|to|with)$/iu.test(word));
    const title = cachedTitles.get(ticket)?.trim() || (meaningful.length >= 2 ? prefix : titles[0]) || ticket;
    return { key: `ticket:${ticket}`, name: title === ticket ? ticket : `${title} (${ticket})`, ticket,
      prUrls: [...members.keys()].sort(), repoCount: new Set([...members.values()].map((entry) => entry.repo.toLowerCase())).size };
  });
}
