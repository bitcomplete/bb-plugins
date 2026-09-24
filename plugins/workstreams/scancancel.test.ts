// A scan killed by a reload must not read as a broken install, and a real
// scan failure must never be hidden as one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanFailure } from "./scancancel.js";

afterEach(() => vi.useRealTimers());

describe("scanFailure", () => {
  it("calls any failure during a dispose a cancellation, because the reload killed the scan and nothing is wrong", async () => {
    const disposal = new AbortController();
    disposal.abort();
    expect(await scanFailure(new Error("host plugin worker exited (0)"), disposal.signal, 1_000)).toBe("cancelled");
    expect(await scanFailure(new DOMException("aborted", "AbortError"), disposal.signal, 1_000)).toBe("cancelled");
  });

  it("calls a worker exit or command timeout a cancellation when the dispose arrives just after it", async () => {
    vi.useFakeTimers();
    for (const message of ["Error: host plugin worker exited (0)", "Timed out waiting for command result"]) {
      const disposal = new AbortController();
      const verdict = scanFailure(new Error(message), disposal.signal, 3_000);
      await vi.advanceTimersByTimeAsync(500);
      disposal.abort();
      expect(await verdict).toBe("cancelled");
    }
  });

  it("keeps a worker exit with no dispose after it a failure, because a host that crashes on its own is a real problem", async () => {
    vi.useFakeTimers();
    const verdict = scanFailure(new Error("host plugin worker exited (1)"), new AbortController().signal, 3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await verdict).toBe("failed");
  });

  it("keeps any other error outside a reload a failure, at once", async () => {
    expect(await scanFailure(new Error("gh: authentication required"), new AbortController().signal, 3_000)).toBe("failed");
  });
});
