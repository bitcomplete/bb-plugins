// Targeted rescans after runs finish: batched, so several finishing runs cost
// one rescan rather than one each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRescanQueue } from "./rescan.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createRescanQueue", () => {
  it("batches paths that finish within the window into one rescan", async () => {
    const calls: string[][] = [];
    const queue = createRescanQueue({ delayMs: 2_000, rescan: async (paths) => (calls.push(paths), true) });
    queue.add("/p/quill-abc-101");
    await vi.advanceTimersByTimeAsync(1_000);
    queue.add("/p/folio-abc-102");
    queue.add("/p/quill-abc-101");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([["/p/quill-abc-101", "/p/folio-abc-102"]]);
  });

  it("runs nothing before the window closes", async () => {
    const rescan = vi.fn(async () => true);
    const queue = createRescanQueue({ delayMs: 2_000, rescan });
    queue.add("/p/margin-ops-7");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(rescan).not.toHaveBeenCalled();
  });

  it("retries a batch the scanner was too busy for, in the next window", async () => {
    const calls: string[][] = [];
    let busy = true;
    const queue = createRescanQueue({
      delayMs: 1_000,
      rescan: async (paths) => {
        calls.push(paths);
        if (busy) {
          busy = false;
          return false;
        }
        return true;
      },
    });
    queue.add("/p/spine-web-9");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([["/p/spine-web-9"], ["/p/spine-web-9"]]);
  });

  it("holds paths that arrive mid-rescan for one more rescan, never a concurrent one", async () => {
    let release: (() => void) | null = null;
    const calls: string[][] = [];
    const queue = createRescanQueue({
      delayMs: 1_000,
      rescan: (paths) =>
        new Promise<boolean>((resolve) => {
          calls.push(paths);
          release = () => resolve(true);
        }),
    });
    queue.add("/p/a");
    await vi.advanceTimersByTimeAsync(1_000);
    queue.add("/p/b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual([["/p/a"]]);
    release!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([["/p/a"], ["/p/b"]]);
  });

  it("does nothing after dispose, so a reload leaves no timer behind", async () => {
    const rescan = vi.fn(async () => true);
    const queue = createRescanQueue({ delayMs: 1_000, rescan });
    queue.add("/p/a");
    queue.dispose();
    queue.add("/p/b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rescan).not.toHaveBeenCalled();
  });
});
