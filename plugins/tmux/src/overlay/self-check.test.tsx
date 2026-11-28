// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelfCheck } from "./self-check";

const BB_SHELL = `
  <div data-variant="sidebar" data-state="expanded">
    <div data-sidebar="sidebar"></div>
  </div>
  <button data-sidebar="trigger"></button>
`;

function renderSelfCheck(isAppReady: boolean) {
  return renderHook((ready: boolean) => useSelfCheck(ready), {
    initialProps: isAppReady,
  });
}

function stubCompactViewport(isCompact: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: isCompact,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useSelfCheck", () => {
  it("stays silent when bb's markup is present", () => {
    document.body.innerHTML = BB_SHELL;

    renderSelfCheck(true);

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns once with the names of the missing markup", () => {
    const view = renderSelfCheck(true);
    view.rerender(true);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("sidebarRoot, sidebarTrigger"),
    );
  });

  it("does not check a second time when the app is ready again after it was not", () => {
    const view = renderSelfCheck(true);
    view.rerender(false);
    view.rerender(true);

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("waits until the app is ready", () => {
    const view = renderSelfCheck(false);
    expect(console.warn).not.toHaveBeenCalled();

    view.rerender(true);

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("does not check on a compact viewport", () => {
    stubCompactViewport(true);

    renderSelfCheck(true);

    expect(console.warn).not.toHaveBeenCalled();
  });
});
