/** A shared cadence for visible views: each pass reads the next batch of PRs in turn, so every PR is read. */
export function createPrPoll(options: { now: () => number; intervalMs: number; batchSize: number }) {
  let lastAt: number | null = null;
  let cursor = 0;
  return {
    select(openUrls: readonly string[]): string[] {
      const now = options.now();
      if (lastAt !== null && now - lastAt < options.intervalMs) return [];
      lastAt = now;
      const known = [...new Set(openUrls)].sort();
      if (known.length === 0) return [];
      const count = Math.min(options.batchSize, known.length);
      const selected = Array.from({ length: count }, (_, index) => known[(cursor + index) % known.length]!);
      cursor = (cursor + count) % known.length;
      return selected;
    },
  };
}
