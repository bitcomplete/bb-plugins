import { useEffect, useSyncExternalStore } from "react";

const FRESH_MS = 15_000;

export function createSnapshotCache<T>() {
  let snapshot: { data: T | null; error: string | null } = { data: null, error: null };
  let updatedAt = Number.NEGATIVE_INFINITY;
  let revision = 0;
  let pending: Promise<void> | null = null;
  let scheduled: { load: () => Promise<T> } | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };

  const read = (load: () => Promise<T>): void => {
    if (pending || (snapshot.data !== null && Date.now() - updatedAt < FRESH_MS)) return;
    const started = revision;
    const request = load().then((data) => {
      if (started !== revision) return;
      snapshot = { data, error: null };
      updatedAt = Date.now();
      publish();
    }, (cause: unknown) => {
      if (started !== revision) return;
      snapshot = { ...snapshot, error: cause instanceof Error ? cause.message : String(cause) };
      publish();
    }).finally(() => {
      if (pending !== request) return;
      pending = null;
      if (started !== revision) read(load);
    });
    pending = request;
  };

  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read,
    refresh(load: () => Promise<T>) {
      if (scheduled) return;
      const task = { load };
      scheduled = task;
      queueMicrotask(() => {
        if (scheduled !== task) return;
        scheduled = null;
        updatedAt = Number.NEGATIVE_INFINITY;
        revision++;
        read(load);
      });
    },
    clear() {
      revision++;
      pending = null;
      scheduled = null;
      updatedAt = Number.NEGATIVE_INFINITY;
      snapshot = { data: null, error: null };
      publish();
    },
  };
}

export function useSnapshot<T>(cache: ReturnType<typeof createSnapshotCache<T>>, load: () => Promise<T>) {
  const snapshot = useSyncExternalStore(cache.subscribe, cache.get, cache.get);
  useEffect(() => {
    cache.read(load);
    const readVisible = () => { if (document.visibilityState !== "hidden") cache.read(load); };
    const timer = setInterval(readVisible, FRESH_MS);
    document.addEventListener("visibilitychange", readVisible);
    window.addEventListener("focus", readVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", readVisible);
      window.removeEventListener("focus", readVisible);
    };
  }, [cache, load]);
  return snapshot;
}
