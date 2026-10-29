// @vitest-environment jsdom
// BB-113: the per-project last place map, in localStorage keyed by plugin id,
// guarded against storage errors and malformed values.
import { afterEach, describe, expect, it, vi } from "vitest";
import { lastPlaceStorageKey, readLastPlace, readLastPlaces, writeLastPlace } from "./last-place.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the per-project last place (BB-113)", () => {
  it("round-trips a thread and a board place", () => {
    writeLastPlace("test-plugin", "p1", { kind: "thread", threadId: "thr_1" });
    writeLastPlace("test-plugin", "p2", { kind: "board", key: "ENG-1" });
    writeLastPlace("test-plugin", "p3", { kind: "board", key: null });
    expect(readLastPlace("test-plugin", "p1")).toEqual({ kind: "thread", threadId: "thr_1" });
    expect(readLastPlace("test-plugin", "p2")).toEqual({ kind: "board", key: "ENG-1" });
    expect(readLastPlace("test-plugin", "p3")).toEqual({ kind: "board", key: null });
  });

  it("keeps every other project's place when one is written", () => {
    writeLastPlace("test-plugin", "p1", { kind: "thread", threadId: "thr_1" });
    writeLastPlace("test-plugin", "p2", { kind: "thread", threadId: "thr_2" });
    expect(readLastPlaces("test-plugin")).toEqual({
      p1: { kind: "thread", threadId: "thr_1" },
      p2: { kind: "thread", threadId: "thr_2" },
    });
  });

  it("keys the entry by plugin id, so two copies do not share one", () => {
    writeLastPlace("plugin-a", "p1", { kind: "thread", threadId: "thr_a" });
    writeLastPlace("plugin-b", "p1", { kind: "thread", threadId: "thr_b" });
    expect(readLastPlace("plugin-a", "p1")).toEqual({ kind: "thread", threadId: "thr_a" });
    expect(readLastPlace("plugin-b", "p1")).toEqual({ kind: "thread", threadId: "thr_b" });
    expect(window.localStorage.getItem(lastPlaceStorageKey("plugin-a"))).not.toBe(window.localStorage.getItem(lastPlaceStorageKey("plugin-b")));
  });

  it("reads an absent project, an absent store and malformed JSON as no memory", () => {
    expect(readLastPlace("test-plugin", "p1")).toBeNull();
    expect(readLastPlaces("test-plugin")).toEqual({});
    window.localStorage.setItem(lastPlaceStorageKey("test-plugin"), "{not json");
    expect(readLastPlaces("test-plugin")).toEqual({});
    expect(readLastPlace("test-plugin", "p1")).toBeNull();
  });

  it("drops malformed entries and keeps the ones it understands", () => {
    window.localStorage.setItem(
      lastPlaceStorageKey("test-plugin"),
      JSON.stringify({
        goodThread: { kind: "thread", threadId: "thr_1" },
        goodBoard: { kind: "board", key: "ENG-1" },
        goodPage: { kind: "board", key: null },
        badKind: { kind: "settings" },
        badThread: { kind: "thread" },
        badThreadEmpty: { kind: "thread", threadId: "" },
        badBoardKey: { kind: "board", key: 7 },
        badValue: 7,
        badNull: null,
      }),
    );
    expect(readLastPlaces("test-plugin")).toEqual({
      goodThread: { kind: "thread", threadId: "thr_1" },
      goodBoard: { kind: "board", key: "ENG-1" },
      goodPage: { kind: "board", key: null },
    });
  });

  it("reads a non-object root as no memory", () => {
    window.localStorage.setItem(lastPlaceStorageKey("test-plugin"), JSON.stringify([1, 2, 3]));
    expect(readLastPlaces("test-plugin")).toEqual({});
    window.localStorage.setItem(lastPlaceStorageKey("test-plugin"), JSON.stringify("a string"));
    expect(readLastPlaces("test-plugin")).toEqual({});
  });

  it("survives a store that throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(readLastPlaces("test-plugin")).toEqual({});
    expect(readLastPlace("test-plugin", "p1")).toBeNull();
  });

  it("survives a store that throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeLastPlace("test-plugin", "p1", { kind: "thread", threadId: "thr_1" })).not.toThrow();
  });
});
