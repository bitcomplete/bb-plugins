// @vitest-environment jsdom
// BB-311: the overlay's transcript pane follows the latest text while pinned,
// stops following when the owner scrolls up past the threshold, and resumes
// when they scroll back to the bottom or press "Jump to latest".
//
// The test mounts the overlay directly with `react-dom/client` (the plugin's
// vitest include is `**/*.test.ts`, and the pane is measured by mocking
// `scrollHeight`/`clientHeight`), and fakes the Realtime client so a test can
// drive transcript lines without WebRTC.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RealtimeVoiceOverlay } from "./app.js";

const clientMock = vi.hoisted(() => ({
  callbacks: null as {
    onLine: (line: { id: string; role: "user" | "assistant"; text: string }) => void;
  } | null,
  clients: [] as Array<{ stop: () => void; setMuted: (muted: boolean) => void }>,
}));

vi.mock("./realtime-client.js", () => {
  class RealtimeSessionTakenError extends Error {}
  class RealtimeSessionClient {
    constructor(callbacks: unknown) {
      clientMock.callbacks = callbacks as typeof clientMock.callbacks;
      clientMock.clients.push(this as unknown as { stop: () => void; setMuted: (muted: boolean) => void });
    }
    start(): void {}
    stop(): void {}
    setMuted(_muted: boolean): void {}
  }
  return { RealtimeSessionClient, RealtimeSessionTakenError };
});

let signalHandler: ((payload: unknown) => void) | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

function installRuntime(): void {
  (globalThis as unknown as { __bbPluginRuntime?: unknown }).__bbPluginRuntime = {
    react: React,
    pluginSdkApp: {
      useRealtime: (_channel: string, handler: (payload: unknown) => void): void => {
        signalHandler = handler;
      },
    },
  };
}

/** Mount the overlay and open a session, then return the transcript pane. */
async function mountOverlay(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(RealtimeVoiceOverlay));
  });
  await act(async () => {
    signalHandler?.({ sessionId: "session-1" });
  });
  const pane = container.querySelector<HTMLDivElement>('[data-testid="realtime-transcript"]');
  if (pane === null) throw new Error("the transcript pane did not mount");
  return pane;
}

/**
 * jsdom reports 0 for both heights. A test sets the sizes it wants the pane to
 * see; `scrollTop` clamps to the browser's max, so the programmatic-scroll
 * guard is exercised the way it is in a real pane.
 */
function mockPaneSize(pane: HTMLDivElement, size: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(pane, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(pane, "clientHeight", { configurable: true, get: () => size.clientHeight });
  let scrollTop = 0;
  Object.defineProperty(pane, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, size.scrollHeight - size.clientHeight));
    },
  });
}

async function addLine(line: { id: string; role: "user" | "assistant"; text: string }): Promise<void> {
  await act(async () => {
    clientMock.callbacks?.onLine(line);
  });
}

async function scrollPane(pane: HTMLDivElement, scrollTop: number): Promise<void> {
  pane.scrollTop = scrollTop;
  await act(async () => {
    pane.dispatchEvent(new Event("scroll"));
  });
}

function jumpButton(): HTMLButtonElement | null {
  if (container === null) return null;
  return (
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Jump to latest") ?? null
  );
}

beforeEach(() => {
  installRuntime();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  signalHandler = null;
  clientMock.callbacks = null;
  clientMock.clients = [];
  if (originalResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  }
});

describe("RealtimeVoiceOverlay transcript scrolling", () => {
  it("keeps the bottom in view as lines arrive while pinned", async () => {
    const pane = await mountOverlay();
    const size = { scrollHeight: 300, clientHeight: 100 };
    mockPaneSize(pane, size);

    await addLine({ id: "a1", role: "assistant", text: "first" });
    expect(pane.scrollTop).toBe(200);

    size.scrollHeight = 450;
    await addLine({ id: "a2", role: "assistant", text: "second" });
    expect(pane.scrollTop).toBe(350);
  });

  it("stops following after the owner scrolls up past the threshold", async () => {
    const pane = await mountOverlay();
    const size = { scrollHeight: 400, clientHeight: 100 };
    mockPaneSize(pane, size);
    await addLine({ id: "a1", role: "assistant", text: "first" });
    expect(pane.scrollTop).toBe(300);
    expect(jumpButton()).toBeNull();

    await scrollPane(pane, 100);
    expect(jumpButton()).not.toBeNull();

    size.scrollHeight = 500;
    await addLine({ id: "a2", role: "assistant", text: "second" });
    expect(pane.scrollTop).toBe(100);
  });

  it("resumes following when the owner scrolls back to the bottom", async () => {
    const pane = await mountOverlay();
    const size = { scrollHeight: 400, clientHeight: 100 };
    mockPaneSize(pane, size);
    await addLine({ id: "a1", role: "assistant", text: "first" });
    await scrollPane(pane, 100);
    expect(jumpButton()).not.toBeNull();

    await scrollPane(pane, 300);
    expect(jumpButton()).toBeNull();

    size.scrollHeight = 500;
    await addLine({ id: "a2", role: "assistant", text: "second" });
    expect(pane.scrollTop).toBe(400);
  });

  it("re-pins and scrolls down when Jump to latest is pressed", async () => {
    const pane = await mountOverlay();
    const size = { scrollHeight: 400, clientHeight: 100 };
    mockPaneSize(pane, size);
    await addLine({ id: "a1", role: "assistant", text: "first" });
    await scrollPane(pane, 50);

    const button = jumpButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(pane.scrollTop).toBe(300);
    expect(jumpButton()).toBeNull();
  });

  it("resets to pinned when a new session opens after the owner scrolled up", async () => {
    const pane = await mountOverlay();
    const size = { scrollHeight: 400, clientHeight: 100 };
    mockPaneSize(pane, size);
    await addLine({ id: "a1", role: "assistant", text: "first" });
    await scrollPane(pane, 50);
    expect(jumpButton()).not.toBeNull();

    await act(async () => {
      signalHandler?.({ sessionId: "session-2" });
    });
    expect(jumpButton()).toBeNull();

    size.scrollHeight = 500;
    await addLine({ id: "b1", role: "assistant", text: "second session" });
    expect(pane.scrollTop).toBe(400);
  });

  it("follows content that grows without a new line", async () => {
    const observers: Array<{ callback: ResizeObserverCallback }> = [];
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback });
      }
      observe(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

    const pane = await mountOverlay();
    const size = { scrollHeight: 300, clientHeight: 100 };
    mockPaneSize(pane, size);
    expect(observers.length).toBeGreaterThan(0);

    size.scrollHeight = 600;
    await act(async () => {
      observers[observers.length - 1]!.callback([], {} as ResizeObserver);
    });
    expect(pane.scrollTop).toBe(500);
  });
});
