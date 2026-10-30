import { canonicalPrUrl } from "./pr-holds.js";

/** The same PR key for inventory, checkouts, and copied GitHub links. */
export function prWorkItemKey(url: string): string {
  return canonicalPrUrl(url) ?? url.replace(/\/$/u, "").toLowerCase();
}

export type RemotePrObservation<T> = { url: string; stale: boolean; tickets?: readonly string[]; value: T };
export type LocalPrObservation<T> = { url: string; path: string; tickets: readonly string[]; value: T };
export type WorkItem<TRemote, TLocal> = {
  key: string;
  remote: TRemote | null;
  locals: TLocal[];
  paths: string[];
  tickets: string[];
};

/** One PR per key. Fresh inventory wins; all checkout evidence remains available. */
export function workItemIndex<TRemote, TLocal>(
  remotes: readonly RemotePrObservation<TRemote>[],
  locals: readonly LocalPrObservation<TLocal>[],
): Map<string, WorkItem<TRemote, TLocal>> {
  const items = new Map<string, WorkItem<TRemote, TLocal>>();
  const get = (url: string): WorkItem<TRemote, TLocal> => {
    const key = prWorkItemKey(url);
    const item = items.get(key) ?? { key, remote: null, locals: [], paths: [], tickets: [] };
    items.set(key, item);
    return item;
  };
  const remoteStale = new Map<string, boolean>();
  const remoteTickets = new Map<string, readonly string[]>();
  for (const observation of remotes) {
    const item = get(observation.url);
    if (item.remote === null || remoteStale.get(item.key) && !observation.stale) {
      item.remote = observation.value;
      remoteStale.set(item.key, observation.stale);
      remoteTickets.set(item.key, observation.tickets ?? []);
    }
  }
  for (const observation of locals) {
    const item = get(observation.url);
    item.locals.push(observation.value);
    if (!item.paths.includes(observation.path)) item.paths.push(observation.path);
    for (const ticket of observation.tickets) if (!item.tickets.includes(ticket)) item.tickets.push(ticket);
  }
  for (const item of items.values()) {
    for (const ticket of remoteTickets.get(item.key) ?? []) if (!item.tickets.includes(ticket)) item.tickets.push(ticket);
    item.paths.sort();
    item.tickets.sort();
  }
  return items;
}
