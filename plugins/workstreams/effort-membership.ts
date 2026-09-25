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
