import { prWorkItemKey, workItemIndex, type LocalPrObservation, type RemotePrObservation } from "./work-item-index.js";

export type WorkOwner = { id: string; key: string; name: string };
export type WorkOwnerKind = "ticket" | "prUrl" | "checkoutPath";
export type ThreadLinkSource = "cluster" | "metadata" | "run" | "advance" | "worker" | "coordinator" | "repo";
export type WorkThreadLink = {
  prUrl: string; threadId: string; source: ThreadLinkSource; role: "coordinator" | "repo" | "pr" | "linked";
  title: string; tier: "started" | "environment" | "ticket" | "paths"; contextual?: boolean;
};
export type ResolvedThreadLink = Omit<WorkThreadLink, "source" | "contextual"> & {
  direct: boolean; sources: ThreadLinkSource[];
};

/** One read-only identity and evidence view. Its links never assign work to an effort. */
export function workContextIndex<TRemote, TLocal>(input: {
  remotes: readonly RemotePrObservation<TRemote>[];
  locals: readonly LocalPrObservation<TLocal>[];
  links: readonly WorkThreadLink[] | ((work: { items: ReturnType<typeof workItemIndex<TRemote, TLocal>>;
    owner: (kind: WorkOwnerKind, id: string) => WorkOwner | null; ownerForPr: (prUrl: string) => WorkOwner | null }) => readonly WorkThreadLink[]);
  ownerOf?: (kind: WorkOwnerKind, id: string) => WorkOwner | null;
}) {
  const items = workItemIndex(input.remotes, input.locals);
  const owners = new Map<string, WorkOwner | null>();
  const owner = (kind: WorkOwnerKind, id: string): WorkOwner | null => {
    const key = `${kind}:${kind === "prUrl" ? prWorkItemKey(id) : id}`;
    if (!owners.has(key)) owners.set(key, input.ownerOf?.(kind, kind === "prUrl" ? prWorkItemKey(id) : id) ?? null);
    return owners.get(key) ?? null;
  };
  const ownerForPr = (prUrl: string): WorkOwner | null => {
    const key = prWorkItemKey(prUrl);
    const exact = owner("prUrl", key);
    if (exact) return exact;
    const ticketOwners = [...new Map((items.get(key)?.tickets ?? []).flatMap((ticket) => {
      const found = owner("ticket", ticket);
      return found ? [[found.id, found] as const] : [];
    })).values()];
    return ticketOwners.length === 1 ? ticketOwners[0]! : null;
  };
  const links = typeof input.links === "function" ? input.links({ items, owner, ownerForPr }) : input.links;
  const byPr = new Map<string, Map<string, ResolvedThreadLink>>();
  const byThread = new Map<string, Set<string>>();
  const rank = { repo: 0, coordinator: 1, pr: 2, linked: 3 };
  for (const link of links) {
    const key = prWorkItemKey(link.prUrl);
    if (!items.has(key) || !link.threadId) continue;
    const bucket = byPr.get(key) ?? new Map<string, ResolvedThreadLink>();
    const previous = bucket.get(link.threadId);
    const preferred = previous && rank[previous.role] <= rank[link.role] ? previous : link;
    bucket.set(link.threadId, {
      ...preferred, prUrl: key, threadId: link.threadId,
      direct: (previous?.direct ?? false) || !link.contextual,
      sources: previous?.sources.includes(link.source) ? previous.sources : [...(previous?.sources ?? []), link.source],
    });
    byPr.set(key, bucket);
    if (!link.contextual) {
      const urls = byThread.get(link.threadId) ?? new Set<string>();
      urls.add(key);
      byThread.set(link.threadId, urls);
    }
  }
  const connectedTickets = (initial: readonly string[]): string[] => {
    const tickets = new Set(initial);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of items.values()) if (item.tickets.some((ticket) => tickets.has(ticket))) {
        for (const ticket of item.tickets) if (!tickets.has(ticket)) { tickets.add(ticket); expanded = true; }
      }
    }
    return [...tickets].sort();
  };
  return {
    items, owner, ownerForPr, connectedTickets,
    linksForPr: (prUrl: string, includeContextual = true): ResolvedThreadLink[] =>
      [...(byPr.get(prWorkItemKey(prUrl))?.values() ?? [])].filter((link) => includeContextual || link.direct),
    directThreadIds: (prUrl: string): string[] =>
      [...(byPr.get(prWorkItemKey(prUrl))?.values() ?? [])].filter((link) => link.direct).map((link) => link.threadId),
    prUrlsForThread: (threadId: string): string[] => [...(byThread.get(threadId) ?? [])].sort(),
  };
}
