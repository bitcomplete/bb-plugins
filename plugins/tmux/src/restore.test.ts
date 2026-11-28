import type { PluginSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import { PLUGIN_STORAGE_KEYS } from "./constants";
import {
  buildSnapshot,
  decideRestore,
  isRouteReconciled,
  readSnapshot,
  removeSnapshot,
  writeSnapshot,
  type LayoutSnapshot,
  type RestoreInput,
  type SnapshotPane,
} from "./restore";

function makeLayout(panes: readonly SnapshotPane[]): PluginSidebarSplitLayout {
  return {
    panes: panes.map((pane, index) => ({
      ...pane,
      rect: { x: index / panes.length, y: 0, width: 1 / panes.length, height: 1 },
    })),
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function storedSnapshot(value: unknown) {
  return memoryStorage({
    [PLUGIN_STORAGE_KEYS.layoutSnapshot]:
      typeof value === "string" ? value : JSON.stringify(value),
  });
}

const SPLIT_PANES: SnapshotPane[] = [
  { paneId: "pane-1", threadId: "thr_left", isFocused: false },
  { paneId: "pane-2", threadId: "thr_focused", isFocused: true },
];

const SPLIT_SNAPSHOT: LayoutSnapshot = {
  version: 1,
  savedAt: 1000,
  focusedThreadId: "thr_focused",
  panes: SPLIT_PANES,
};

const SINGLE_SNAPSHOT: LayoutSnapshot = {
  version: 1,
  savedAt: 1000,
  focusedThreadId: "thr_only",
  panes: [],
};

const ACTIVE_IDS = new Set(["thr_left", "thr_focused", "thr_only", "thr_other"]);

const COLD_START_SPLIT_LAYOUT = makeLayout([
  { paneId: "pane-1", threadId: "thr_left", isFocused: false },
  { paneId: "pane-2", threadId: null, isFocused: true },
]);

function decideSplit(overrides: Partial<RestoreInput> = {}): string | null {
  return decideRestore({
    snapshot: SPLIT_SNAPSHOT,
    layout: COLD_START_SPLIT_LAYOUT,
    contextThreadId: null,
    pathname: "/",
    activeThreadIds: ACTIVE_IDS,
    ...overrides,
  });
}

function decideSingle(overrides: Partial<RestoreInput> = {}): string | null {
  return decideRestore({
    snapshot: SINGLE_SNAPSHOT,
    layout: null,
    contextThreadId: null,
    pathname: "/",
    activeThreadIds: ACTIVE_IDS,
    ...overrides,
  });
}

describe("buildSnapshot", () => {
  it("mirrors the panes and records the focused pane's thread", () => {
    const layout = makeLayout(SPLIT_PANES);
    expect(buildSnapshot(layout, "thr_focused", 1234)).toEqual({
      version: 1,
      savedAt: 1234,
      focusedThreadId: "thr_focused",
      panes: SPLIT_PANES,
    });
  });

  it("stores only the pane id, thread id and focus flag of each pane", () => {
    const snapshot = buildSnapshot(makeLayout(SPLIT_PANES), null, 1);
    expect(Object.keys(snapshot.panes[0] ?? {}).sort()).toEqual([
      "isFocused",
      "paneId",
      "threadId",
    ]);
  });

  it("records no focused thread when the focused pane shows no thread", () => {
    const layout = makeLayout([
      { paneId: "pane-1", threadId: "thr_left", isFocused: false },
      { paneId: "pane-2", threadId: null, isFocused: true },
    ]);
    expect(buildSnapshot(layout, "thr_ignored", 1).focusedThreadId).toBeNull();
  });

  it("records no focused thread when no pane is focused", () => {
    const layout = makeLayout([
      { paneId: "pane-1", threadId: "thr_left", isFocused: false },
      { paneId: "pane-2", threadId: "thr_right", isFocused: false },
    ]);
    expect(buildSnapshot(layout, "thr_left", 1).focusedThreadId).toBeNull();
  });

  it("uses the context thread and no panes when there is no split", () => {
    expect(buildSnapshot(null, "thr_only", 99)).toEqual({
      version: 1,
      savedAt: 99,
      focusedThreadId: "thr_only",
      panes: [],
    });
    expect(buildSnapshot(null, null, 99).focusedThreadId).toBeNull();
  });
});

describe("writeSnapshot and readSnapshot", () => {
  it("round-trips a snapshot under the plugin's storage key", () => {
    const storage = memoryStorage();
    writeSnapshot(storage, SPLIT_SNAPSHOT);
    expect([...storage.values.keys()]).toEqual([PLUGIN_STORAGE_KEYS.layoutSnapshot]);
    expect(readSnapshot(storage)).toEqual(SPLIT_SNAPSHOT);
  });

  it("round-trips a single-pane snapshot", () => {
    const storage = memoryStorage();
    writeSnapshot(storage, SINGLE_SNAPSHOT);
    expect(readSnapshot(storage)).toEqual(SINGLE_SNAPSHOT);
  });

  it("returns null when nothing is stored", () => {
    expect(readSnapshot(memoryStorage())).toBeNull();
  });

  it("returns null when storage throws on read", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage is disabled");
      },
    };
    expect(readSnapshot(storage)).toBeNull();
  });

  it("swallows storage errors on write", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => writeSnapshot(storage, SPLIT_SNAPSHOT)).not.toThrow();
  });

  it("removes the stored snapshot, and nothing else that the storage holds", () => {
    const storage = memoryStorage({ other: "kept" });
    writeSnapshot(storage, SPLIT_SNAPSHOT);

    removeSnapshot(storage);

    expect(readSnapshot(storage)).toBeNull();
    expect([...storage.values.keys()]).toEqual(["other"]);
  });

  it("swallows storage errors on removal", () => {
    const storage = {
      removeItem: () => {
        throw new Error("storage is disabled");
      },
    };
    expect(() => removeSnapshot(storage)).not.toThrow();
  });

  it.each<[string, unknown]>([
    ["text that is not JSON", "{not json"],
    ["a JSON null", null],
    ["a JSON array", []],
    ["a JSON string", '"snapshot"'],
    ["a JSON number", "42"],
    ["a different version", { ...SPLIT_SNAPSHOT, version: 2 }],
    ["a missing version", { savedAt: 1, focusedThreadId: null, panes: [] }],
    ["a savedAt that is not a number", { ...SPLIT_SNAPSHOT, savedAt: "now" }],
    ["a savedAt that is not finite", { ...SPLIT_SNAPSHOT, savedAt: null }],
    ["a missing focusedThreadId", { version: 1, savedAt: 1, panes: [] }],
    ["a numeric focusedThreadId", { ...SPLIT_SNAPSHOT, focusedThreadId: 7 }],
    ["missing panes", { version: 1, savedAt: 1, focusedThreadId: null }],
    ["panes that are not an array", { ...SPLIT_SNAPSHOT, panes: {} }],
    ["a pane that is not an object", { ...SPLIT_SNAPSHOT, panes: ["pane-1"] }],
    [
      "a pane without a pane id",
      { ...SPLIT_SNAPSHOT, panes: [{ threadId: null, isFocused: true }] },
    ],
    [
      "a pane with a numeric thread id",
      { ...SPLIT_SNAPSHOT, panes: [{ paneId: "pane-1", threadId: 3, isFocused: true }] },
    ],
    [
      "a pane without a thread id",
      { ...SPLIT_SNAPSHOT, panes: [{ paneId: "pane-1", isFocused: true }] },
    ],
    [
      "a pane with a focus flag that is not a boolean",
      {
        ...SPLIT_SNAPSHOT,
        panes: [{ paneId: "pane-1", threadId: null, isFocused: "yes" }],
      },
    ],
  ])("returns null for %s", (_label, value) => {
    expect(readSnapshot(storedSnapshot(value))).toBeNull();
  });
});

describe("isRouteReconciled", () => {
  const staleLayout = makeLayout(SPLIT_PANES);

  it("is false on the New thread route while the focused pane still shows a thread", () => {
    expect(isRouteReconciled(staleLayout, "/")).toBe(false);
  });

  it("is true once the focused pane shows no thread", () => {
    expect(isRouteReconciled(COLD_START_SPLIT_LAYOUT, "/")).toBe(true);
  });

  it("is true on any other route", () => {
    expect(isRouteReconciled(staleLayout, "/threads/thr_focused")).toBe(true);
  });

  it("is true without a split", () => {
    expect(isRouteReconciled(null, "/")).toBe(true);
  });
});

describe("decideRestore split case", () => {
  it("reopens the thread of the pane that was focused when that pane lost it", () => {
    expect(decideSplit()).toBe("thr_focused");
  });

  it("returns null without a snapshot", () => {
    expect(decideSplit({ snapshot: null })).toBeNull();
  });

  it("returns null when the focused pane showed no thread at quit", () => {
    const snapshot: LayoutSnapshot = {
      ...SPLIT_SNAPSHOT,
      focusedThreadId: null,
      panes: [
        { paneId: "pane-1", threadId: "thr_left", isFocused: false },
        { paneId: "pane-2", threadId: null, isFocused: true },
      ],
    };
    expect(decideSplit({ snapshot })).toBeNull();
  });

  it("returns null when the thread is archived, deleted or not loaded", () => {
    expect(decideSplit({ activeThreadIds: new Set(["thr_left"]) })).toBeNull();
    expect(decideSplit({ activeThreadIds: new Set() })).toBeNull();
  });

  it("returns null when the app did not start on the New thread route", () => {
    expect(decideSplit({ pathname: "/threads/thr_other" })).toBeNull();
    expect(decideSplit({ pathname: "/settings/general" })).toBeNull();
    expect(decideSplit({ pathname: "" })).toBeNull();
  });

  it("returns null when a thread is already the current route", () => {
    expect(decideSplit({ contextThreadId: "thr_other" })).toBeNull();
    expect(decideSplit({ contextThreadId: "thr_focused" })).toBeNull();
  });

  it("returns null when the thread is still shown in a pane", () => {
    const sameLayout = makeLayout(SPLIT_PANES);
    expect(decideSplit({ layout: sameLayout })).toBeNull();
    const movedLayout = makeLayout([
      { paneId: "pane-1", threadId: "thr_focused", isFocused: false },
      { paneId: "pane-2", threadId: null, isFocused: true },
    ]);
    expect(decideSplit({ layout: movedLayout })).toBeNull();
  });

  it("returns null when the split is gone", () => {
    expect(decideSplit({ layout: null })).toBeNull();
  });

  it("returns null when the pane that was focused no longer exists", () => {
    const layout = makeLayout([
      { paneId: "pane-1", threadId: "thr_left", isFocused: false },
      { paneId: "pane-3", threadId: null, isFocused: true },
    ]);
    expect(decideSplit({ layout })).toBeNull();
  });

  it("returns null when the pane that was focused now shows another thread", () => {
    const layout = makeLayout([
      { paneId: "pane-1", threadId: "thr_left", isFocused: false },
      { paneId: "pane-2", threadId: "thr_other", isFocused: true },
    ]);
    expect(decideSplit({ layout })).toBeNull();
  });

  it("returns null when the emptied pane is no longer the focused pane", () => {
    const layout = makeLayout([
      { paneId: "pane-1", threadId: "thr_left", isFocused: true },
      { paneId: "pane-2", threadId: null, isFocused: false },
    ]);
    expect(decideSplit({ layout })).toBeNull();
  });

  it("returns null when the snapshot has panes but none was focused", () => {
    const snapshot: LayoutSnapshot = {
      ...SPLIT_SNAPSHOT,
      panes: SPLIT_PANES.map((pane) => ({ ...pane, isFocused: false })),
    };
    expect(decideSplit({ snapshot })).toBeNull();
  });
});

describe("decideRestore single-pane case", () => {
  it("reopens the only thread when the app cold-started on New thread", () => {
    expect(decideSingle()).toBe("thr_only");
  });

  it("returns null without a snapshot", () => {
    expect(decideSingle({ snapshot: null })).toBeNull();
  });

  it("returns null when the New thread screen was showing at quit", () => {
    expect(
      decideSingle({ snapshot: { ...SINGLE_SNAPSHOT, focusedThreadId: null } }),
    ).toBeNull();
  });

  it("returns null when the thread is not active any more", () => {
    expect(decideSingle({ activeThreadIds: new Set(["thr_other"]) })).toBeNull();
  });

  it("returns null when the app did not start on the New thread route", () => {
    expect(decideSingle({ pathname: "/threads/thr_only" })).toBeNull();
    expect(decideSingle({ pathname: "/plugins/cascade/board" })).toBeNull();
  });

  it("returns null when a thread is already the current route", () => {
    expect(decideSingle({ contextThreadId: "thr_only" })).toBeNull();
    expect(decideSingle({ contextThreadId: "thr_other" })).toBeNull();
  });

  it("returns null when a split exists now", () => {
    const withoutThread = makeLayout([
      { paneId: "pane-1", threadId: null, isFocused: true },
      { paneId: "pane-2", threadId: "thr_other", isFocused: false },
    ]);
    expect(decideSingle({ layout: withoutThread })).toBeNull();
    const withThread = makeLayout([
      { paneId: "pane-1", threadId: null, isFocused: true },
      { paneId: "pane-2", threadId: "thr_only", isFocused: false },
    ]);
    expect(decideSingle({ layout: withThread })).toBeNull();
  });
});
