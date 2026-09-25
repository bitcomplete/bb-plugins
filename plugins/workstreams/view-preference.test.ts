import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastView, storeLastView, viewFromSubPath, VIEW_STORAGE_KEY } from "./view-preference.js";

afterEach(() => vi.unstubAllGlobals());

describe("Workstreams view preference", () => {
  it("keeps explicit view links independent of the remembered view", () => {
    expect(viewFromSubPath("map")).toBe("map");
    expect(viewFromSubPath("board/details")).toBe("board");
    expect(viewFromSubPath("board-v2/details")).toBe("board");
    expect(viewFromSubPath("")).toBeNull();
    expect(viewFromSubPath("unknown")).toBeNull();
  });

  it("defaults to Map and remembers the last explicit view", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    expect(readLastView()).toBe("map");
    storeLastView("board");
    expect(values.get(VIEW_STORAGE_KEY)).toBe("board");
    expect(readLastView()).toBe("board");
    values.set(VIEW_STORAGE_KEY, "board-v2");
    expect(readLastView()).toBe("board");
    storeLastView("map");
    expect(readLastView()).toBe("map");
    values.set(VIEW_STORAGE_KEY, "unexpected");
    expect(readLastView()).toBe("map");
  });

  it("keeps every view usable when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("Storage disabled");
      },
    });
    expect(readLastView()).toBe("map");
    expect(() => storeLastView("board")).not.toThrow();
  });
});
