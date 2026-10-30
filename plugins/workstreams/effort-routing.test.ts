import { describe, expect, it, vi } from "vitest";
import { activeCheckoutThread } from "./effort-routing.js";

describe("active checkout ownership", () => {
  it("blocks only the same path on the same host, including waiting writers and unknown hosts", async () => {
    const base = { id: "writer", status: "running", environmentPath: "/work/repo/", environmentHostId: "host-a" };
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [base])).toBe("writer");
    expect(await activeCheckoutThread("/work/repo", "host-b", async () => [base])).toBeNull();
    expect(await activeCheckoutThread("/work/repo-other", "host-a", async () => [base])).toBeNull();
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [{ ...base, status: "waiting", environmentHostId: null }])).toBe("writer");
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [{ ...base, status: "idle" }, { ...base, id: "failed", status: "error" }])).toBeNull();
  });

  it("checks later pages instead of overlooking a writer outside the first hundred threads", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, status: "idle", environmentPath: null }));
    const list = vi.fn(async (offset: number) => offset === 0 ? page : [{ id: "writer", status: "running", environmentPath: "/work/repo" }]);
    expect(await activeCheckoutThread("/work/repo", "host", list)).toBe("writer");
    expect(list.mock.calls.map(([offset]) => offset)).toEqual([0, 100]);
  });

  it("fails closed when ownership cannot be read or the traversal is incomplete", async () => {
    await expect(activeCheckoutThread("/work/repo", "host", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, status: "idle", environmentPath: null }));
    await expect(activeCheckoutThread("/work/repo", "host", async () => page)).rejects.toThrow("Too many threads");
  });
});
