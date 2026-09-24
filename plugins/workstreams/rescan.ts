// A finished run rescans the checkout it touched, so its row moves on its own.
// Several runs finishing together share one rescan: paths collect for a short
// window, then go to the scanner as one batch.

export type RescanQueue = { add(path: string): void; dispose(): void };

export function createRescanQueue(options: {
  delayMs: number;
  /** Rescan these paths. Resolve false when the scanner is busy, and they are retried after another delay. */
  rescan: (paths: string[]) => Promise<boolean>;
  onError?: (error: unknown) => void;
}): RescanQueue {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;

  const schedule = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, options.delayMs);
  };

  async function flush(): Promise<void> {
    if (running || pending.size === 0) return;
    running = true;
    const batch = [...pending];
    pending.clear();
    let done = true;
    try {
      done = await options.rescan(batch);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
    if (!done) for (const path of batch) pending.add(path);
    // Paths that arrived mid-rescan, or a busy scanner, get the next window.
    if (pending.size > 0) schedule();
  }

  return {
    add(path) {
      if (disposed) return;
      pending.add(path);
      if (!running) schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
