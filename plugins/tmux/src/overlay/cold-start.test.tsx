// @vitest-environment jsdom
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LOCKS } from "../constants";
import { useColdStartRepair, type ColdStartInput } from "./cold-start";
import {
  installFakeLocks,
  makeLayout,
  makeThread,
  removeFakeLocks,
  THIS_WINDOW_CLIENT_ID,
} from "./test-support";

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  buildSnapshot: vi.fn(),
  decideRestore: vi.fn(),
  isRouteReconciled: vi.fn(),
}));

vi.mock("../restore", () => ({
  readSnapshot: mocks.readSnapshot,
  writeSnapshot: mocks.writeSnapshot,
  buildSnapshot: mocks.buildSnapshot,
  decideRestore: mocks.decideRestore,
  isRouteReconciled: mocks.isRouteReconciled,
}));
vi.mock("../thread-order", () => ({
  activeThreads: (threads: readonly unknown[]) => threads,
}));

const THREADS = [makeThread("thr-1"), makeThread("thr-2")];
const SPLIT = makeLayout([
  { paneId: "pane-1", threadId: null, isFocused: true },
  { paneId: "pane-2", threadId: "thr-1", isFocused: false },
]);
const REPAIRED = makeLayout([
  { paneId: "pane-1", threadId: "thr-2", isFocused: true },
  { paneId: "pane-2", threadId: "thr-1", isFocused: false },
]);
const STORED_SNAPSHOT = {
  version: 1,
  savedAt: 1,
  focusedThreadId: "thr-2",
  panes: [],
};

const toThread = vi.fn();
const navigate = { toThread } as unknown as BbNavigate;

function input(overrides: Partial<ColdStartInput> = {}): ColdStartInput {
  return {
    navigate,
    layout: SPLIT,
    contextThreadId: null,
    threads: THREADS,
    threadsReady: true,
    ...overrides,
  };
}

function renderRepair(initial: ColdStartInput) {
  return renderHook((props: ColdStartInput) => useColdStartRepair(props), {
    initialProps: initial,
  });
}

// navigator.userActivation, which jsdom does not have: hasBeenActive turns
// true with the first click or key press in the window and stays true.
function setWindowUsed(hasBeenActive: boolean): void {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive, isActive: false },
  });
}

beforeEach(() => {
  mocks.readSnapshot.mockReturnValue(STORED_SNAPSHOT);
  mocks.decideRestore.mockReturnValue(null);
  mocks.isRouteReconciled.mockReturnValue(true);
  mocks.buildSnapshot.mockImplementation((layout, contextThreadId) => ({
    layout,
    contextThreadId,
  }));
});

afterEach(() => {
  cleanup();
  removeFakeLocks();
  Reflect.deleteProperty(navigator, "userActivation");
  vi.clearAllMocks();
});

describe("useColdStartRepair", () => {
  it("waits for the thread list, then decides once with the snapshot read at mount", () => {
    const { rerender } = renderRepair(
      input({ threadsReady: false, threads: [] }),
    );
    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    mocks.decideRestore.mockReturnValue("thr-2");
    rerender(input());
    rerender(input({ layout: REPAIRED, contextThreadId: "thr-2" }));

    expect(mocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).toHaveBeenCalledWith({
      snapshot: STORED_SNAPSHOT,
      layout: SPLIT,
      contextThreadId: null,
      pathname: window.location.pathname,
      activeThreadIds: new Set(["thr-1", "thr-2"]),
    });
    expect(toThread).toHaveBeenCalledTimes(1);
    expect(toThread).toHaveBeenCalledWith("thr-2");
  });

  it("waits until bb has applied the route to the layout", () => {
    mocks.isRouteReconciled.mockReturnValue(false);
    mocks.decideRestore.mockReturnValue("thr-2");
    const { rerender } = renderRepair(input({ layout: REPAIRED }));

    expect(mocks.isRouteReconciled).toHaveBeenCalledWith(
      REPAIRED,
      window.location.pathname,
    );
    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    mocks.isRouteReconciled.mockReturnValue(true);
    rerender(input());

    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).toHaveBeenCalledWith(
      expect.objectContaining({ layout: SPLIT }),
    );
    expect(toThread).toHaveBeenCalledWith("thr-2");
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("writes a fresh snapshot whenever the layout or the context thread changes", () => {
    const { rerender } = renderRepair(input());
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.writeSnapshot).toHaveBeenLastCalledWith(window.localStorage, {
      layout: SPLIT,
      contextThreadId: null,
    });

    rerender(input({ layout: REPAIRED }));
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.writeSnapshot).toHaveBeenLastCalledWith(window.localStorage, {
      layout: REPAIRED,
      contextThreadId: null,
    });

    rerender(input({ layout: REPAIRED, contextThreadId: "thr-2" }));
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.writeSnapshot).toHaveBeenLastCalledWith(window.localStorage, {
      layout: REPAIRED,
      contextThreadId: "thr-2",
    });
  });

  it("does not write again when neither the layout nor the context thread changed", () => {
    const { rerender } = renderRepair(input());

    rerender(input({ threads: [...THREADS] }));
    rerender(input({ navigate: { toThread } as unknown as BbNavigate }));

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
  });

  it("stamps the snapshot with the current time", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    renderRepair(input());

    expect(mocks.buildSnapshot).toHaveBeenCalledWith(SPLIT, null, 1234);
    vi.restoreAllMocks();
  });
});

// bb 0.50.1 loads this plugin only after the first screen has painted
// (plugin-frontend.ts waits for whenScreenPainted), so the New thread screen
// is already usable when the repair runs.
describe("useColdStartRepair in a window the user has already used", () => {
  beforeEach(() => {
    mocks.decideRestore.mockReturnValue("thr-2");
  });

  it("reopens the thread while the window has not been clicked or typed in", () => {
    setWindowUsed(false);

    renderRepair(input());

    expect(toThread).toHaveBeenCalledExactlyOnceWith("thr-2");
  });

  it("leaves the New thread screen alone once the window has been clicked or typed in", () => {
    setWindowUsed(true);

    renderRepair(input());

    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(toThread).not.toHaveBeenCalled();
  });

  it("still records the layout from then on", () => {
    setWindowUsed(true);
    const { rerender } = renderRepair(input());
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1);

    rerender(input({ layout: REPAIRED, contextThreadId: "thr-2" }));

    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.writeSnapshot).toHaveBeenLastCalledWith(window.localStorage, {
      layout: REPAIRED,
      contextThreadId: "thr-2",
    });
    expect(toThread).not.toHaveBeenCalled();
  });

  it("does not come back to the decision when the user was typing while the thread list loaded", () => {
    setWindowUsed(false);
    const { rerender } = renderRepair(input({ threadsReady: false, threads: [] }));
    setWindowUsed(true);

    rerender(input());
    setWindowUsed(false);
    rerender(input({ layout: REPAIRED }));

    expect(toThread).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("reads the window's state when the browser has answered about other windows", async () => {
    installFakeLocks();
    setWindowUsed(false);
    renderRepair(input());
    setWindowUsed(true);

    await waitFor(() => expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1));

    expect(toThread).not.toHaveBeenCalled();
  });

  it("reopens the thread in a browser that does not tell whether the window was used", () => {
    expect("userActivation" in navigator).toBe(false);

    renderRepair(input());

    expect(toThread).toHaveBeenCalledExactlyOnceWith("thr-2");
  });
});

describe("useColdStartRepair with more than one bb window", () => {
  const OTHER_WINDOW = {
    name: PLUGIN_LOCKS.openWindow,
    clientId: "other-window",
  };

  beforeEach(() => {
    mocks.decideRestore.mockReturnValue("thr-2");
  });

  it("waits for the browser's answer, then repairs the only window", async () => {
    installFakeLocks();
    renderRepair(input());
    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();

    await waitFor(() => expect(toThread).toHaveBeenCalledWith("thr-2"));
    await waitFor(() => expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1));

    expect(mocks.decideRestore).toHaveBeenCalledTimes(1);
  });

  it("leaves a new window on the New thread screen while another window is open", async () => {
    installFakeLocks([OTHER_WINDOW]);
    renderRepair(input());

    await waitFor(() => expect(mocks.writeSnapshot).toHaveBeenCalledTimes(1));

    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(toThread).not.toHaveBeenCalled();
  });

  it("does not take its own lock from an earlier run of the plugin for another window", async () => {
    installFakeLocks([
      { name: PLUGIN_LOCKS.openWindow, clientId: THIS_WINDOW_CLIENT_ID },
    ]);
    renderRepair(input());

    await waitFor(() => expect(toThread).toHaveBeenCalledWith("thr-2"));
  });

  it("gives its lock back when the overlay unmounts", async () => {
    const { held } = installFakeLocks();
    const { unmount } = renderRepair(input());
    await waitFor(() => expect(held).toHaveLength(1));

    unmount();

    await waitFor(() => expect(held).toHaveLength(0));
  });

  it("decides nothing when the overlay unmounts before the browser answered", async () => {
    const { held } = installFakeLocks();
    const { unmount } = renderRepair(input());

    unmount();
    await waitFor(() => expect(held).toHaveLength(0));

    expect(mocks.decideRestore).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });
});
