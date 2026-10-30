import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadEffortRefresh } from "./thread-effort-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("thread effort refreshes", () => {
  it("coalesces paired events, paints the completed read, and preserves a queued picker-open read under a burst", async () => {
    const first = deferred<string>(), second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const apply = vi.fn();
    const refresh = createThreadEffortRefresh({ read, apply, failed: vi.fn() });
    refresh.request(); refresh.request();
    await vi.advanceTimersByTimeAsync(80);
    expect(read).toHaveBeenCalledTimes(1);
    refresh.request(true);
    for (let i = 0; i < 100; i++) refresh.request();
    first.resolve("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledWith("first", false);
    await vi.advanceTimersByTimeAsync(80);
    expect(read).toHaveBeenCalledTimes(2);
    second.resolve("fresh list");
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenLastCalledWith("fresh list", true);
    refresh.dispose();
  });

  it("does not postpone reads indefinitely when events arrive faster than the debounce", async () => {
    const read = vi.fn().mockResolvedValue("chip"), apply = vi.fn();
    const refresh = createThreadEffortRefresh({ read, apply, failed: vi.fn() });
    refresh.request();
    await vi.advanceTimersByTimeAsync(60);
    refresh.request();
    await vi.advanceTimersByTimeAsync(20);
    expect(apply).toHaveBeenCalledWith("chip", false);
    refresh.dispose();
  });

  it("discards pre-save replies and waits for the save to finish before refreshing", async () => {
    const old = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue("saved chip");
    const apply = vi.fn();
    const refresh = createThreadEffortRefresh({ read, apply, failed: vi.fn() });
    refresh.request(true);
    await vi.advanceTimersByTimeAsync(80);
    refresh.hold(); refresh.request();
    old.resolve("old chip");
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    refresh.resume();
    await vi.advanceTimersByTimeAsync(80);
    expect(apply).toHaveBeenCalledWith("saved chip", true);
    refresh.dispose();
  });

  it("recovers after a failed read and ignores replies and queued work after unmount", async () => {
    const first = deferred<string>(), second = deferred<string>();
    const failed = vi.fn(), apply = vi.fn();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = createThreadEffortRefresh({ read, apply, failed });
    refresh.request();
    await vi.advanceTimersByTimeAsync(80);
    refresh.request();
    first.reject(new Error("temporary failure"));
    await vi.advanceTimersByTimeAsync(80);
    expect(failed).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    refresh.request(true);
    refresh.dispose();
    second.resolve("old thread");
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
