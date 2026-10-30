import { afterEach, expect, it, vi } from "vitest";
import { createSnapshotCache } from "../lib/snapshot-cache.js";

afterEach(() => vi.restoreAllMocks());

it("deduplicates reads, reuses fresh snapshots, and revalidates stale data without clearing it", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const cache = createSnapshotCache<string[]>();
  const load = vi.fn(async () => ["first"]);
  cache.read(load); cache.read(load);
  await vi.waitFor(() => expect(cache.get().data).toEqual(["first"]));
  cache.read(load);
  expect(load).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(16_000);
  let finish: ((data: string[]) => void) | undefined;
  const slow = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
  cache.read(slow);
  expect(cache.get().data).toEqual(["first"]);
  finish?.(["second"]);
  await vi.waitFor(() => expect(cache.get().data).toEqual(["second"]));
});

it("keeps the last good snapshot after a failed refresh and clears the error on recovery", async () => {
  const cache = createSnapshotCache<string[]>();
  cache.read(async () => ["saved"]);
  await vi.waitFor(() => expect(cache.get().data).toEqual(["saved"]));
  cache.refresh(async () => { throw new Error("Offline"); });
  await vi.waitFor(() => expect(cache.get()).toEqual({ data: ["saved"], error: "Offline" }));
  cache.refresh(async () => ["updated"]);
  await vi.waitFor(() => expect(cache.get()).toEqual({ data: ["updated"], error: null }));
});

it("coalesces invalidations and never publishes a response that predates a change", async () => {
  const cache = createSnapshotCache<string[]>();
  let finish: ((data: string[]) => void) | undefined;
  const load = vi.fn()
    .mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }))
    .mockResolvedValue(["current"]);
  const received: (string[] | null)[] = [];
  cache.subscribe(() => received.push(cache.get().data));
  cache.read(load);
  cache.refresh(load); cache.refresh(load);
  await Promise.resolve();
  finish?.(["obsolete"]);
  await vi.waitFor(() => expect(cache.get().data).toEqual(["current"]));
  expect(load).toHaveBeenCalledTimes(2);
  expect(received).toEqual([["current"]]);
});
