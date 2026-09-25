type PrThreadLink = { threadId: string; environmentId: string | null; urls: readonly string[] };

/** Native events invalidate PR facts; one delayed read also catches GitHub settling after a push. */
export function createPrFreshness(options: {
  subscribe: (environmentId: string, changed: () => void) => () => void;
  schedule: (urls: readonly string[]) => void;
  settleMs: number;
}) {
  let threads = new Map<string, PrThreadLink>();
  let environments = new Map<string, Set<string>>();
  const subscriptions = new Map<string, () => void>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function changed(urls: Iterable<string>): void {
    if (disposed) return;
    const fresh = [...new Set(urls)].filter((url) => !settling.has(url));
    if (fresh.length === 0) return;
    for (const url of fresh) {
      settling.set(url, setTimeout(() => {
        settling.delete(url);
        if (!disposed) options.schedule([url]);
      }, options.settleMs));
    }
    options.schedule(fresh);
  }

  return {
    setLinks(links: readonly PrThreadLink[]): void {
      if (disposed) return;
      threads = new Map(links.map((link) => [link.threadId, link]));
      environments = new Map();
      for (const link of links) {
        if (link.environmentId === null || link.urls.length === 0) continue;
        const urls = environments.get(link.environmentId) ?? new Set<string>();
        for (const url of link.urls) urls.add(url);
        environments.set(link.environmentId, urls);
      }
      for (const [environmentId, unsubscribe] of subscriptions) {
        if (environments.has(environmentId)) continue;
        unsubscribe();
        subscriptions.delete(environmentId);
      }
      for (const environmentId of environments.keys()) {
        if (subscriptions.has(environmentId)) continue;
        subscriptions.set(environmentId, options.subscribe(environmentId, () => changed(environments.get(environmentId) ?? [])));
      }
    },
    threadIdle(threadId: string): void {
      changed(threads.get(threadId)?.urls ?? []);
    },
    dispose(): void {
      disposed = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      for (const timer of settling.values()) clearTimeout(timer);
      subscriptions.clear();
      settling.clear();
      threads.clear();
      environments.clear();
    },
  };
}
