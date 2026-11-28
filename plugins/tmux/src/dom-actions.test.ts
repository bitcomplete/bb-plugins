// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPluginSyntheticEvent } from "./bb-commands";
import {
  activatePaneByPointer,
  cancelPendingSidebarFocus,
  clickClosePane,
  clickMaximizePane,
  focusPaneElement,
  focusSidebarEdge,
  focusSidebarRowForThread,
  getFocusedPaneElement,
  getFocusedSidebarRow,
  getPaneElementById,
  getSidebarRows,
  getThreadPaneElements,
  getTimelineViewport,
  hasOpenModal,
  hasSidebarSelection,
  isCompactViewport,
  isInSelectionMenu,
  isPaneZoomed,
  isSelectionMenu,
  isSidebarOpen,
  isSidebarRowFocusedByPointer,
  moveSidebarFocus,
  pageSidebarFocus,
  noteSidebarPointerDown,
  runSelfCheck,
  scrollTimelineBy,
  sidebarRowThreadId,
  toggleSidebar,
} from "./dom-actions";

interface PaneOptions {
  id: string;
  focused?: boolean;
  hiddenByZoom?: boolean;
  maximized?: boolean;
}

// The fixtures below mirror bb 0.50.1 markup: SplitThreadArea.tsx (pane roots),
// ThreadDetailHeader.tsx (pane actions), ThreadScreen.tsx and
// bottom-anchored-scroll-body.tsx (timeline), ui/sidebar.tsx, AppSidebar.tsx,
// ThreadRow.tsx and SidebarWindowedItems.tsx (sidebar).
function threadScreenHtml(label: string): string {
  return `
    <header>
      <div data-thread-header-pane-actions="">
        <button type="button" aria-label="Full Screen (Shift+Cmd+E)" aria-pressed="false" aria-haspopup="menu" data-test="maximize-${label}"></button>
        <button type="button" aria-label="Close pane" data-test="close-${label}"></button>
        <button type="button" aria-label="Pin thread context" aria-pressed="false" data-test="context-${label}"></button>
      </div>
    </header>
    <div data-thread-window="">
      <div data-page-scroll-viewport="" data-test="viewport-${label}">
        <div data-timeline-row-list="top-level"></div>
        <div data-scroll-footer="">
          <div data-app-composer="" data-app-composer-role="primary">
            <button type="button" aria-label="Scroll to latest event" data-test="latest-${label}"></button>
            <div contenteditable="true" role="textbox" data-test="composer-${label}"></div>
          </div>
        </div>
      </div>
    </div>`;
}

function splitPaneHtml(options: PaneOptions): string {
  const hidden = options.hiddenByZoom ? ' aria-hidden="true"' : "";
  const maximized = options.maximized ? ' data-maximized="true"' : "";
  return `
    <div tabindex="-1" data-split-pane-id="${options.id}" data-focused="${options.focused ? "true" : "false"}"${maximized}${hidden}>
      ${threadScreenHtml(options.id)}
    </div>`;
}

const SIDE_PANEL_HTML = `
  <div id="split-workspace-main-panel">
    <div data-sidebar-split-container="">
      <div data-split-pane-id="pane-1" data-focused="true" data-maximized="true">
        <button type="button" aria-label="Close pane" data-test="close-side-panel"></button>
        <div data-thread-window="" data-surface-tone="sidebar">
          <div data-page-scroll-viewport="" data-test="viewport-side-panel"></div>
        </div>
      </div>
      <div data-split-pane-id="pane-secondary" data-focused="false"></div>
    </div>
  </div>`;

function mountSplit(panes: PaneOptions[], withSidePanel = true): void {
  document.body.innerHTML = `
    <main>
      <div class="workspace">
        ${panes.map(splitPaneHtml).join("")}
        ${withSidePanel ? SIDE_PANEL_HTML : ""}
      </div>
    </main>`;
}

function mountSinglePane(): void {
  document.body.innerHTML = `
    <main>
      <div data-split-pane-id="pane-1">${threadScreenHtml("pane-1")}</div>
      ${SIDE_PANEL_HTML}
    </main>`;
}

function rowHtml(threadId: string): string {
  return `
    <div data-sidebar-rename-row="">
      <a href="/threads/${threadId}" draggable="false" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="${threadId}" data-sidebar-rename-anchor="" aria-label="Open ${threadId}"></a>
      <span class="bb-thread-title">${threadId}</span>
    </div>`;
}

function windowedItemHtml(threadIds: string[]): string {
  return `<div data-sidebar-windowed-item="">${threadIds.map(rowHtml).join("")}</div>`;
}

function placeholderHtml(threadIds: string[], test: string): string {
  const nav = threadIds.map((id) => `${id}:proj_1`).join(" ");
  return `<div data-sidebar-windowed-item="" data-sidebar-windowed-nav="${nav}" style="height: 60px" data-test="${test}"></div>`;
}

function mountSidebar(listHtml: string, state: "expanded" | "collapsed" = "expanded"): void {
  document.body.innerHTML = `
    <div class="group peer" data-state="${state}" data-collapsible="${state === "collapsed" ? "offcanvas" : ""}" data-variant="sidebar" data-side="left">
      <div data-sidebar="gap"></div>
      <div data-sidebar="panel">
        <div data-sidebar="sidebar">
          <div data-sidebar="collapsible-body">
            <div data-testid="app-sidebar-body">
              <div data-sidebar="content">${listHtml}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button type="button" data-sidebar="trigger" aria-expanded="${state === "expanded"}" data-test="trigger"></button>
    <main><input data-test="other-input" /></main>`;
}

function byTest<T extends HTMLElement = HTMLElement>(name: string): T {
  const element = document.querySelector<T>(`[data-test="${name}"]`);
  if (element === null) throw new Error(`fixture element ${name} is missing`);
  return element;
}

function row(threadId: string): HTMLAnchorElement {
  const element = document.querySelector<HTMLAnchorElement>(
    `a[data-sidebar-thread-id="${threadId}"]`,
  );
  if (element === null) throw new Error(`fixture row ${threadId} is missing`);
  return element;
}

function onClick(element: HTMLElement): ReturnType<typeof vi.fn> {
  const listener = vi.fn();
  element.addEventListener("click", listener);
  return listener;
}

function realize(placeholder: HTMLElement, threadIds: string[]): void {
  placeholder.removeAttribute("data-sidebar-windowed-nav");
  placeholder.innerHTML = threadIds.map(rowHtml).join("");
}

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let scrolledIntoView: { element: Element; options: unknown }[];
let listeners: AbortController;

function runFrame(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

beforeEach(() => {
  frames = new Map();
  nextFrameId = 0;
  scrolledIntoView = [];
  listeners = new AbortController();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(
    this: HTMLElement,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    scrolledIntoView.push({ element: this, options });
  };
});

afterEach(() => {
  listeners.abort();
  document.body.innerHTML = "";
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pane lookups", () => {
  it("ignore the side panel's own split container", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    const ids = getThreadPaneElements().map((pane) => pane.dataset.splitPaneId);
    expect(ids).toEqual(["pane-1", "pane-2"]);
    expect(getPaneElementById("pane-secondary")).toBeNull();
    expect(getPaneElementById("pane-1")?.closest("[data-sidebar-split-container]")).toBeNull();
    expect(isPaneZoomed()).toBe(false);
  });

  it("find a pane by id and return null for an unknown id", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    expect(getPaneElementById("pane-2")?.dataset.focused).toBe("true");
    expect(getPaneElementById('pane-"3"]')).toBeNull();
  });

  it("use the only pane as the focused pane, although it carries no data-focused", () => {
    mountSinglePane();
    const pane = getFocusedPaneElement();
    expect(pane?.dataset.splitPaneId).toBe("pane-1");
    expect(pane?.hasAttribute("data-focused")).toBe(false);
    expect(pane?.closest("[data-sidebar-split-container]")).toBeNull();
  });

  it("pick the pane marked focused among several", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }, { id: "pane-3" }]);
    expect(getFocusedPaneElement()?.dataset.splitPaneId).toBe("pane-2");
  });

  it("find the zoomed pane, which bb marks as the focused one, and report the zoom", () => {
    mountSplit([
      { id: "pane-1", hiddenByZoom: true },
      { id: "pane-2", focused: true, maximized: true },
    ]);
    expect(getFocusedPaneElement()?.dataset.splitPaneId).toBe("pane-2");
    expect(isPaneZoomed()).toBe(true);
  });

  it("skip a pane hidden by zoom should it carry the focus mark, which bb 0.50.1 does not draw", () => {
    mountSplit([
      { id: "pane-1", focused: true, hiddenByZoom: true },
      { id: "pane-2", focused: true, maximized: true },
    ]);
    expect(getFocusedPaneElement()?.dataset.splitPaneId).toBe("pane-2");
  });

  it("return null when several panes exist and none is focused", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2" }]);
    expect(getFocusedPaneElement()).toBeNull();
    expect(getTimelineViewport()).toBeNull();
  });

  it("accept an explicit document", () => {
    const other = document.implementation.createHTMLDocument("other");
    other.body.innerHTML = splitPaneHtml({ id: "pane-9", focused: true });
    expect(getThreadPaneElements(other)).toHaveLength(1);
    expect(getFocusedPaneElement(other)?.dataset.splitPaneId).toBe("pane-9");
    expect(getThreadPaneElements()).toHaveLength(0);
  });
});

describe("isCompactViewport", () => {
  it("follows the width below which bb shows a single pane", () => {
    const queries: string[] = [];
    let isNarrow = true;
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return { matches: isNarrow };
    });

    expect(isCompactViewport()).toBe(true);
    isNarrow = false;
    expect(isCompactViewport()).toBe(false);
    expect(queries).toEqual(["(max-width: 767px)", "(max-width: 767px)"]);
  });

  it("is false where the browser cannot answer media queries", () => {
    expect(window.matchMedia).toBeUndefined();
    expect(isCompactViewport()).toBe(false);
  });
});

describe("focusPaneElement", () => {
  it("focuses a pane root that has a tabindex without scrolling", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    const pane = getPaneElementById("pane-2");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focusPaneElement(pane);
    expect(document.activeElement).toBe(pane);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("blurs the active element when the only pane cannot take focus", () => {
    mountSinglePane();
    const composer = byTest("composer-pane-1");
    composer.tabIndex = 0;
    composer.focus();
    expect(document.activeElement).toBe(composer);
    focusPaneElement(getFocusedPaneElement());
    expect(document.activeElement).toBe(document.body);
  });

  it("blurs the active element for a missing pane", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    row("thr_a").focus();
    focusPaneElement(null);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("activatePaneByPointer", () => {
  it("dispatches a bubbling pointerdown on the thread pane root, where bb's handler listens", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    const seen: Event[] = [];
    document.addEventListener("pointerdown", (event) => seen.push(event), {
      signal: listeners.signal,
    });
    expect(activatePaneByPointer("pane-2")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("pointerdown");
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].target).toBe(getPaneElementById("pane-2"));
    expect((seen[0] as PointerEvent).pointerType).toBe("mouse");
    expect((seen[0] as PointerEvent).button).toBe(0);
  });

  it("marks the press as the plugin's own, so that the key handler does not take it for a mouse press of the user", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    const marks: boolean[] = [];
    window.addEventListener(
      "pointerdown",
      (event) => marks.push(isPluginSyntheticEvent(event)),
      { capture: true, signal: listeners.signal },
    );

    activatePaneByPointer("pane-2");
    getPaneElementById("pane-2")?.dispatchEvent(
      new Event("pointerdown", { bubbles: true }),
    );

    expect(marks).toEqual([true, false]);
  });

  it("targets the thread pane even when a side panel group shares the id", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    const targets: (EventTarget | null)[] = [];
    document.addEventListener("pointerdown", (event) => targets.push(event.target), {
      signal: listeners.signal,
    });
    activatePaneByPointer("pane-1");
    expect((targets[0] as HTMLElement).closest("[data-sidebar-split-container]")).toBeNull();
  });

  it("returns false when the pane element is missing", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    const seen = vi.fn();
    document.addEventListener("pointerdown", seen, { signal: listeners.signal });
    expect(activatePaneByPointer("pane-7")).toBe(false);
    expect(activatePaneByPointer("pane-secondary")).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it("releases the press at once, so that bb does not take the mouse button for held from then on", () => {
    mountSplit([{ id: "pane-1", focused: true }, { id: "pane-2" }]);
    // As bb's selection menu does: held from a press until a release.
    let isHeld = false;
    const seen: string[] = [];
    const note = (event: Event): void => {
      const pointer = event as PointerEvent;
      isHeld = event.type === "pointerdown";
      seen.push(
        `${event.type} ${pointer.pointerType} buttons ${pointer.buttons} own ${isPluginSyntheticEvent(event)}`,
      );
      expect(event.target).toBe(getPaneElementById("pane-2"));
    };
    for (const type of ["pointerdown", "pointerup", "pointercancel", "mouseup"]) {
      document.addEventListener(type, note, { signal: listeners.signal });
    }

    activatePaneByPointer("pane-2");

    expect(seen).toEqual([
      "pointerdown mouse buttons 1 own true",
      "pointerup mouse buttons 0 own true",
    ]);
    expect(isHeld).toBe(false);
  });
});

describe("pane buttons", () => {
  it("clicks the focused pane's own close button", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    const focusedClose = onClick(byTest("close-pane-2"));
    const otherClose = onClick(byTest("close-pane-1"));
    const sidePanelClose = onClick(byTest("close-side-panel"));
    expect(clickClosePane()).toBe(true);
    expect(focusedClose).toHaveBeenCalledTimes(1);
    expect(otherClose).not.toHaveBeenCalled();
    expect(sidePanelClose).not.toHaveBeenCalled();
  });

  it("returns false when the focused pane has no close button", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    byTest("close-pane-2").remove();
    const otherClose = onClick(byTest("close-pane-1"));
    expect(clickClosePane()).toBe(false);
    expect(otherClose).not.toHaveBeenCalled();
  });

  it("clicks the focused pane's maximize button and not the thread context toggle", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    const maximize = onClick(byTest("maximize-pane-2"));
    const context = onClick(byTest("context-pane-2"));
    const otherMaximize = onClick(byTest("maximize-pane-1"));
    expect(clickMaximizePane()).toBe(true);
    expect(maximize).toHaveBeenCalledTimes(1);
    expect(context).not.toHaveBeenCalled();
    expect(otherMaximize).not.toHaveBeenCalled();
  });

  it.each(["Exit Full Screen", "Maximize pane (Ctrl+Shift+E)", "Restore split"])(
    "recognises the maximize button labelled %s",
    (label) => {
      mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
      const button = byTest("maximize-pane-2");
      button.setAttribute("aria-label", label);
      const maximize = onClick(button);
      expect(clickMaximizePane()).toBe(true);
      expect(maximize).toHaveBeenCalledTimes(1);
    },
  );

  it("returns false in a single pane, where only the thread context toggle is pressed-capable", () => {
    mountSinglePane();
    byTest("maximize-pane-1").remove();
    const context = onClick(byTest("context-pane-1"));
    expect(clickMaximizePane()).toBe(false);
    expect(context).not.toHaveBeenCalled();
  });

  it("does not click a disabled button", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    byTest<HTMLButtonElement>("close-pane-2").disabled = true;
    expect(clickClosePane()).toBe(false);
  });
});

describe("timeline scrolling", () => {
  it("finds the viewport of the focused pane", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    expect(getTimelineViewport()).toBe(byTest("viewport-pane-2"));
  });

  it("finds the viewport of the only pane and never the side panel's thread", () => {
    mountSinglePane();
    expect(getTimelineViewport()).toBe(byTest("viewport-pane-1"));
  });

  it("falls back to the document when there is no pane element", () => {
    document.body.innerHTML = `<main>${threadScreenHtml("bare")}</main>`;
    expect(getTimelineViewport()).toBe(byTest("viewport-bare"));
  });

  it("returns null when the focused pane shows no thread", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    getPaneElementById("pane-2")?.querySelector("[data-thread-window]")?.remove();
    expect(getTimelineViewport()).toBeNull();
    expect(scrollTimelineBy(80)).toBe(false);
  });

  it("dispatches the wheel event on the viewport before scrolling", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    const viewport = byTest("viewport-pane-2");
    const order: string[] = [];
    viewport.addEventListener("wheel", (event) => {
      order.push(`wheel ${event.deltaY} bubbles=${event.bubbles}`);
    });
    viewport.scrollBy = ((options: ScrollToOptions) => {
      order.push(`scrollBy ${options.top} ${options.behavior}`);
    }) as typeof viewport.scrollBy;

    expect(scrollTimelineBy(-80)).toBe(true);
    expect(order).toEqual(["wheel -80 bubbles=false", "scrollBy -80 instant"]);
  });

  it("does not touch the other pane's viewport", () => {
    mountSplit([{ id: "pane-1" }, { id: "pane-2", focused: true }]);
    const other = byTest("viewport-pane-1");
    const wheel = vi.fn();
    other.addEventListener("wheel", wheel);
    other.scrollTop = 40;
    scrollTimelineBy(80);
    expect(wheel).not.toHaveBeenCalled();
    expect(other.scrollTop).toBe(40);
  });

  it("falls back to scrollTop where scrollBy is missing", () => {
    mountSinglePane();
    const viewport = byTest("viewport-pane-1");
    viewport.scrollTop = 100;
    expect(scrollTimelineBy(80)).toBe(true);
    expect(viewport.scrollTop).toBe(180);
  });

});

describe("sidebar state", () => {
  it("reads the expanded and collapsed state from the sidebar root", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    expect(isSidebarOpen()).toBe(true);
    mountSidebar(windowedItemHtml(["thr_a"]), "collapsed");
    expect(isSidebarOpen()).toBe(false);
  });

  it("reads the narrow-window drawer state", () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" data-sidebar="panel" data-sidebar-state="expanded" data-state="open" data-collapsible="" data-variant="sidebar" data-side="left">
        <div data-sidebar="sidebar"></div>
      </div>`;
    expect(isSidebarOpen()).toBe(true);
    document.querySelector("[data-sidebar='panel']")?.setAttribute("data-state", "closed");
    expect(isSidebarOpen()).toBe(false);
  });

  it("falls back to the trigger's aria-expanded", () => {
    document.body.innerHTML = `<button data-sidebar="trigger" aria-expanded="true"></button>`;
    expect(isSidebarOpen()).toBe(true);
    document.body.innerHTML = `<button data-sidebar="trigger" aria-expanded="false"></button>`;
    expect(isSidebarOpen()).toBe(false);
  });

  it("clicks the sidebar trigger to toggle", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    const trigger = onClick(byTest("trigger"));
    expect(toggleSidebar()).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("returns false when the trigger is missing", () => {
    document.body.innerHTML = "<main></main>";
    expect(toggleSidebar()).toBe(false);
  });
});

describe("sidebar rows", () => {
  it("lists mounted rows in DOM order and skips overflow rows", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a", "thr_b"])}
      ${placeholderHtml(["thr_c", "thr_d"], "placeholder")}
      ${windowedItemHtml(["thr_e"])}
      <div data-sidebar-overflow="true">${rowHtml("thr_hidden")}</div>`);
    expect(getSidebarRows().map(sidebarRowThreadId)).toEqual(["thr_a", "thr_b", "thr_e"]);
  });

  it("skips rows that fail checkVisibility, with the option bb passes", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    const checkVisibility = vi.fn(() => false);
    row("thr_b").checkVisibility = checkVisibility;
    row("thr_c").checkVisibility = () => true;
    expect(getSidebarRows().map(sidebarRowThreadId)).toEqual(["thr_a", "thr_c"]);
    expect(checkVisibility).toHaveBeenCalledWith({ visibilityProperty: true });
  });

  it("finds no rows while a route sidebar hides the list body", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b"]));
    document.querySelector('[data-testid="app-sidebar-body"]')?.setAttribute("hidden", "");
    expect(getSidebarRows()).toEqual([]);
    expect(focusSidebarRowForThread("thr_a")).toBe(false);
  });

  it("ignores row-like anchors outside the sidebar", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    document.querySelector("main")?.insertAdjacentHTML("beforeend", rowHtml("thr_menu"));
    expect(getSidebarRows().map(sidebarRowThreadId)).toEqual(["thr_a"]);
  });

  it("reads the thread id of a row", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    expect(sidebarRowThreadId(row("thr_a"))).toBe("thr_a");
    expect(sidebarRowThreadId(document.body)).toBeNull();
    expect(sidebarRowThreadId(null)).toBeNull();
  });

  it("reports the focused row", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b"]));
    expect(getFocusedSidebarRow()).toBeNull();
    row("thr_b").focus();
    expect(getFocusedSidebarRow()).toBe(row("thr_b"));
    byTest("other-input").focus();
    expect(getFocusedSidebarRow()).toBeNull();
  });

  it("focuses the row of the given thread and scrolls it into view", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    expect(focusSidebarRowForThread("thr_b")).toBe(true);
    expect(document.activeElement).toBe(row("thr_b"));
    expect(scrolledIntoView).toEqual([
      { element: row("thr_b"), options: { block: "nearest" } },
    ]);
  });

  it("focuses the first row when the thread has no row or is unknown", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b"]));
    expect(focusSidebarRowForThread("thr_zzz")).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
    row("thr_b").focus();
    expect(focusSidebarRowForThread(null)).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("returns false with no rows", () => {
    mountSidebar("");
    expect(focusSidebarRowForThread("thr_a")).toBe(false);
  });
});

describe("a thread row behind the headers that bb pins at the top of the list", () => {
  interface Box {
    top: number;
    height: number;
  }

  function place(element: Element, { top, height }: Box): void {
    element.getBoundingClientRect = () =>
      new DOMRect(0, top, 200, height);
  }

  function headerHtml(tier: string, test: string, inner = ""): string {
    return `<div data-sidebar-sticky-tier="${tier}" data-test="${test}">${inner}</div>`;
  }

  // What the list was scrolled up by, in pixels.
  function mountPinnedList(listHtml: string): () => number {
    mountSidebar(`<div data-sidebar-sticky-stack="">${listHtml}</div>`);
    const scroller = document.querySelector<HTMLElement>('[data-sidebar="content"]');
    if (scroller === null) throw new Error("the fixture has no scroller");
    let scrolledUpBy = 0;
    scroller.scrollBy = ((options: ScrollToOptions) => {
      scrolledUpBy -= options.top ?? 0;
    }) as typeof scroller.scrollBy;
    return () => scrolledUpBy;
  }

  it("scrolls the list up until the row shows below the section label and the project row that cover it", () => {
    const scrolledUpBy = mountPinnedList(`
      ${headerHtml("label", "label")}
      ${headerHtml("project", "project")}
      ${windowedItemHtml(["thr_a", "thr_b"])}`);
    place(byTest("label"), { top: 8, height: 24 });
    place(byTest("project"), { top: 32, height: 28 });
    place(row("thr_a"), { top: 4, height: 28 });
    place(row("thr_b"), { top: 32, height: 28 });
    row("thr_b").focus();

    expect(moveSidebarFocus(-1)).toBe(true);

    expect(document.activeElement).toBe(row("thr_a"));
    expect(scrolledUpBy()).toBe(56);
  });

  it("does the same for the row of the focused thread when the sidebar is entered", () => {
    const scrolledUpBy = mountPinnedList(`
      ${headerHtml("label", "label")}
      ${windowedItemHtml(["thr_a", "thr_b"])}`);
    place(byTest("label"), { top: 8, height: 24 });
    place(row("thr_b"), { top: 10, height: 28 });

    expect(focusSidebarRowForThread("thr_b")).toBe(true);

    expect(scrolledUpBy()).toBe(22);
  });

  it("leaves the list alone for a row that no pinned header covers", () => {
    const scrolledUpBy = mountPinnedList(`
      ${headerHtml("label", "label")}
      ${headerHtml("project", "project")}
      ${windowedItemHtml(["thr_a", "thr_b"])}`);
    place(byTest("label"), { top: 8, height: 24 });
    place(byTest("project"), { top: 32, height: 28 });
    place(row("thr_a"), { top: 60, height: 28 });
    place(row("thr_b"), { top: 88, height: 28 });
    row("thr_b").focus();

    moveSidebarFocus(-1);

    expect(scrolledUpBy()).toBe(0);
  });

  it("does not count a header that comes after the row, nor the pinned row that holds it", () => {
    const scrolledUpBy = mountPinnedList(`
      ${headerHtml("parent", "parent", rowHtml("thr_a"))}
      ${headerHtml("label", "next-label")}
      ${windowedItemHtml(["thr_b"])}`);
    place(byTest("parent"), { top: 0, height: 28 });
    place(byTest("next-label"), { top: 20, height: 24 });
    place(row("thr_a"), { top: 0, height: 28 });
    row("thr_b").focus();

    moveSidebarFocus(-1);

    expect(document.activeElement).toBe(row("thr_a"));
    expect(scrolledUpBy()).toBe(0);
  });

  it("does nothing where the page has no layout, as for a row without a height", () => {
    const scrolledUpBy = mountPinnedList(`
      ${headerHtml("label", "label")}
      ${windowedItemHtml(["thr_a", "thr_b"])}`);
    place(byTest("label"), { top: 8, height: 24 });
    row("thr_b").focus();

    moveSidebarFocus(-1);

    expect(scrolledUpBy()).toBe(0);
  });
});

describe("pageSidebarFocus", () => {
  const IDS = Array.from({ length: 30 }, (_value, index) => `thr_${index}`);

  function sizeSidebar(sidebarHeight: number, rowHeight: number): void {
    const sidebar = document.querySelector<HTMLElement>('[data-sidebar="sidebar"]');
    if (sidebar === null) throw new Error("the sidebar is missing");
    sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 240, sidebarHeight);
    for (const id of IDS) {
      row(id).getBoundingClientRect = () => new DOMRect(0, 0, 240, rowHeight);
    }
  }

  it("moves by the rows that the sidebar shows at once, less one", () => {
    mountSidebar(windowedItemHtml(IDS));
    sizeSidebar(200, 40);
    row("thr_10").focus();

    expect(pageSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_14"));
    expect(pageSidebarFocus(-1)).toBe(true);
    expect(pageSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_6"));
  });

  it("ends on the first and on the last row", () => {
    mountSidebar(windowedItemHtml(IDS));
    sizeSidebar(200, 40);
    row("thr_1").focus();

    expect(pageSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_0"));
    row("thr_28").focus();
    expect(pageSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_29"));
    expect(pageSidebarFocus(1)).toBe(false);
  });

  it("moves by ten rows where the rows cannot be measured", () => {
    mountSidebar(windowedItemHtml(IDS));
    row("thr_3").focus();

    expect(pageSidebarFocus(1)).toBe(true);

    expect(document.activeElement).toBe(row("thr_13"));
  });

  it("moves by one row at least, in a sidebar that is lower than two rows", () => {
    mountSidebar(windowedItemHtml(IDS));
    sizeSidebar(50, 40);
    row("thr_3").focus();

    expect(pageSidebarFocus(1)).toBe(true);

    expect(document.activeElement).toBe(row("thr_4"));
  });

  it("does not go around at the first and the last row, also when a page is one row, as in tmux's lists", () => {
    mountSidebar(windowedItemHtml(IDS));
    sizeSidebar(50, 40);
    row("thr_29").focus();

    expect(pageSidebarFocus(1)).toBe(false);
    expect(document.activeElement).toBe(row("thr_29"));
    row("thr_0").focus();
    expect(pageSidebarFocus(-1)).toBe(false);
    expect(document.activeElement).toBe(row("thr_0"));
    expect(frames.size).toBe(0);
  });

  it("goes to the first or the last row when no row has the focus", () => {
    mountSidebar(windowedItemHtml(IDS));

    expect(pageSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_0"));
    row("thr_0").blur();
    expect(pageSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_29"));
  });
});

describe("moveSidebarFocus", () => {
  it("moves to the next and previous row", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    row("thr_a").focus();
    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_b"));
    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_c"));
    expect(moveSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_b"));
  });

  it("goes around from the first row to the last and from the last to the first, as tmux's lists do", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    row("thr_a").focus();
    expect(moveSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_c"));
    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
    expect(frames.size).toBe(0);
  });

  it("stays on the only row of a sidebar", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    row("thr_a").focus();

    expect(moveSidebarFocus(1)).toBe(true);
    expect(moveSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("goes around past the overflow rows, which cannot be reached", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a", "thr_b"])}
      <div data-sidebar-overflow="true">${rowHtml("thr_hidden")}</div>`);
    row("thr_b").focus();

    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("goes around into a placeholder at the other end, and focuses its row once bb mounted it", () => {
    mountSidebar(`
      ${placeholderHtml(["thr_a", "thr_b"], "placeholder")}
      ${windowedItemHtml(["thr_c", "thr_d"])}`);
    const placeholder = byTest("placeholder");
    row("thr_d").focus();

    expect(moveSidebarFocus(1)).toBe(true);
    expect(scrolledIntoView).toEqual([
      { element: placeholder, options: { block: "start" } },
    ]);
    realize(placeholder, ["thr_a", "thr_b"]);
    runFrame();

    expect(document.activeElement).toBe(row("thr_a"));
    expect(frames.size).toBe(0);
  });

  it("skips overflow rows when stepping", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      <div data-sidebar-overflow="true">${rowHtml("thr_hidden")}</div>
      ${windowedItemHtml(["thr_b"])}`);
    row("thr_a").focus();
    moveSidebarFocus(1);
    expect(document.activeElement).toBe(row("thr_b"));
  });

  it("starts from the first or last row when no row is focused", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
    byTest("other-input").focus();
    expect(moveSidebarFocus(-1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_c"));
  });

  it("scrolls a windowed placeholder into view and focuses its first row once bb mounted it", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a", "thr_b"])}
      ${placeholderHtml(["thr_c", "thr_d"], "placeholder")}
      ${windowedItemHtml(["thr_e"])}`);
    const placeholder = byTest("placeholder");
    row("thr_b").focus();

    expect(moveSidebarFocus(1)).toBe(true);
    expect(document.activeElement).toBe(row("thr_b"));
    expect(scrolledIntoView).toEqual([
      { element: placeholder, options: { block: "nearest" } },
    ]);

    runFrame();
    expect(document.activeElement).toBe(row("thr_b"));
    expect(scrolledIntoView).toHaveLength(2);

    realize(placeholder, ["thr_c", "thr_d"]);
    runFrame();
    expect(document.activeElement).toBe(row("thr_c"));
    expect(frames.size).toBe(0);
  });

  it("enters a placeholder above from its last row", () => {
    mountSidebar(`
      ${placeholderHtml(["thr_a", "thr_b"], "placeholder")}
      ${windowedItemHtml(["thr_c"])}`);
    row("thr_c").focus();
    expect(moveSidebarFocus(-1)).toBe(true);
    realize(byTest("placeholder"), ["thr_a", "thr_b"]);
    runFrame();
    expect(document.activeElement).toBe(row("thr_b"));
  });

  it("gives up after a bounded number of frames when the placeholder never mounts", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      ${placeholderHtml(["thr_b"], "placeholder")}`);
    row("thr_a").focus();
    expect(moveSidebarFocus(1)).toBe(true);

    let ranFrames = 0;
    while (frames.size > 0 && ranFrames < 200) {
      runFrame();
      ranFrames += 1;
    }
    expect(ranFrames).toBe(30);
    expect(frames.size).toBe(0);
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("stops retrying when focus moved somewhere else meanwhile", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      ${placeholderHtml(["thr_b"], "placeholder")}`);
    row("thr_a").focus();
    moveSidebarFocus(1);
    const input = byTest("other-input");
    input.focus();
    realize(byTest("placeholder"), ["thr_b"]);
    runFrame();
    expect(document.activeElement).toBe(input);
    expect(frames.size).toBe(0);
  });

  it("does not pull focus back after the plugin moved it to the pane", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      ${placeholderHtml(["thr_b"], "placeholder")}`);
    row("thr_a").focus();
    moveSidebarFocus(1);
    focusPaneElement(null);
    expect(frames.size).toBe(0);
    realize(byTest("placeholder"), ["thr_b"]);
    runFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("lets a newer move replace a pending retry", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a", "thr_b"])}
      ${placeholderHtml(["thr_c"], "placeholder")}`);
    row("thr_b").focus();
    moveSidebarFocus(1);
    expect(frames.size).toBe(1);
    expect(moveSidebarFocus(-1)).toBe(true);
    expect(frames.size).toBe(0);
    realize(byTest("placeholder"), ["thr_c"]);
    runFrame();
    expect(document.activeElement).toBe(row("thr_a"));
  });
});

describe("focusSidebarEdge", () => {
  it("focuses the first and last row", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b", "thr_c"]));
    expect(focusSidebarEdge("bottom")).toBe(true);
    expect(document.activeElement).toBe(row("thr_c"));
    expect(focusSidebarEdge("top")).toBe(true);
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("scrolls to a placeholder at the end and focuses the last row once it mounted", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      ${placeholderHtml(["thr_b", "thr_c"], "placeholder")}`);
    const placeholder = byTest("placeholder");
    row("thr_a").focus();
    expect(focusSidebarEdge("bottom")).toBe(true);
    expect(scrolledIntoView).toEqual([{ element: placeholder, options: { block: "end" } }]);
    realize(placeholder, ["thr_b", "thr_c"]);
    runFrame();
    expect(document.activeElement).toBe(row("thr_c"));
  });

  it("keeps going after the focused row was unmounted by the scroll", () => {
    mountSidebar(`
      ${placeholderHtml(["thr_a"], "placeholder")}
      ${windowedItemHtml(["thr_b"])}`);
    const placeholder = byTest("placeholder");
    row("thr_b").focus();
    expect(focusSidebarEdge("top")).toBe(true);
    expect(scrolledIntoView).toEqual([{ element: placeholder, options: { block: "start" } }]);
    row("thr_b").blur();
    realize(placeholder, ["thr_a"]);
    runFrame();
    expect(document.activeElement).toBe(row("thr_a"));
  });

  it("returns false with no rows", () => {
    mountSidebar("");
    expect(focusSidebarEdge("top")).toBe(false);
    expect(focusSidebarEdge("bottom")).toBe(false);
  });
});

describe("cancelPendingSidebarFocus", () => {
  it("drops the retry that waits for a windowed row to mount", () => {
    mountSidebar(`
      ${windowedItemHtml(["thr_a"])}
      ${placeholderHtml(["thr_b"], "placeholder")}`);
    row("thr_a").focus();
    moveSidebarFocus(1);
    expect(frames.size).toBe(1);

    cancelPendingSidebarFocus();
    realize(byTest("placeholder"), ["thr_b"]);
    runFrame();

    expect(frames.size).toBe(0);
    expect(document.activeElement).toBe(row("thr_a"));
  });
});

describe("a thread row that was clicked", () => {
  beforeEach(() => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b"]));
  });

  afterEach(() => {
    noteSidebarPointerDown(null);
  });

  function click(target: HTMLElement): void {
    noteSidebarPointerDown(target);
    target.focus();
  }

  it("is told apart from a row that the plugin's keys focused", () => {
    focusSidebarRowForThread("thr_a");
    expect(isSidebarRowFocusedByPointer()).toBe(false);

    click(row("thr_a"));
    expect(isSidebarRowFocusedByPointer()).toBe(true);
  });

  it("stops counting as clicked once focus is on another row", () => {
    click(row("thr_a"));

    row("thr_b").focus();

    expect(isSidebarRowFocusedByPointer()).toBe(false);
  });

  it.each([
    ["entering the sidebar on the same row", () => focusSidebarRowForThread("thr_a")],
    ["moving to the next row", () => moveSidebarFocus(1)],
    ["jumping to the last row", () => focusSidebarEdge("bottom")],
  ])("is taken over by %s with the keys", (_label, focusWithKeys) => {
    click(row("thr_a"));

    expect(focusWithKeys()).toBe(true);

    expect(getFocusedSidebarRow()).not.toBeNull();
    expect(isSidebarRowFocusedByPointer()).toBe(false);
  });

  it("is forgotten when the next pointerdown lands outside the rows", () => {
    click(row("thr_a"));

    noteSidebarPointerDown(byTest("other-input"));

    expect(document.activeElement).toBe(row("thr_a"));
    expect(isSidebarRowFocusedByPointer()).toBe(false);
  });

  it("is recognised when the pointer lands on something inside the row link", () => {
    const icon = row("thr_b").appendChild(document.createElement("span"));

    noteSidebarPointerDown(icon);
    row("thr_b").focus();

    expect(isSidebarRowFocusedByPointer()).toBe(true);
  });
});

describe("hasSidebarSelection", () => {
  it("is true while bb marks a row as selected", () => {
    mountSidebar(windowedItemHtml(["thr_a", "thr_b"]));
    expect(hasSidebarSelection()).toBe(false);

    row("thr_b").parentElement?.setAttribute("data-sidebar-thread-selected", "");

    expect(hasSidebarSelection()).toBe(true);
  });
});

// TimelineSelectionMenu.tsx: a Radix popover that bb portals into a layer
// inside the conversation scroller.
describe("isInSelectionMenu", () => {
  const SELECTION_MENU_HTML = `
    <div data-radix-popper-content-wrapper="">
      <div role="dialog" data-state="open" data-bb-portaled-overlay="">
        <button type="button" data-test="add-to-chat"><svg data-test="icon"></svg>Add to chat</button>
      </div>
    </div>`;

  beforeEach(() => {
    mountSplit([{ id: "pane-1", focused: true }]);
  });

  it("is true for the menu, its buttons and what is inside them", () => {
    byTest("viewport-pane-1").insertAdjacentHTML("afterbegin", SELECTION_MENU_HTML);

    expect(isInSelectionMenu(byTest("add-to-chat"))).toBe(true);
    expect(isInSelectionMenu(document.querySelector('[data-test="icon"]'))).toBe(true);
    expect(isInSelectionMenu(byTest("add-to-chat").parentElement)).toBe(true);
  });

  it("is false for the conversation around the menu and for the message box", () => {
    byTest("viewport-pane-1").insertAdjacentHTML("afterbegin", SELECTION_MENU_HTML);

    expect(isInSelectionMenu(byTest("viewport-pane-1"))).toBe(false);
    expect(isInSelectionMenu(byTest("composer-pane-1"))).toBe(false);
    expect(isInSelectionMenu(document.body)).toBe(false);
  });

  it("is false for the same popover outside a conversation", () => {
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU_HTML);

    expect(isInSelectionMenu(byTest("add-to-chat"))).toBe(false);
  });

  it("is false for a target that is not an element", () => {
    expect(isInSelectionMenu(null)).toBe(false);
    expect(isInSelectionMenu(window)).toBe(false);
    expect(isInSelectionMenu(document)).toBe(false);
  });
});

// bb 0.50.1 renders TimelineSelectionMenu.tsx in four places. Only
// ThreadTimelineRows.tsx passes a container inside the conversation scroller.
// ThreadTerminalView.tsx, SecondaryPanelSelectionActions.tsx (file previews)
// and PierreLineSelectionActions.tsx (diff view) pass none, so Radix puts
// those menus on the page body, where bb's other popovers are.
describe("bb's selection menu and other open dialogs", () => {
  const SELECTION_MENU_HTML = `
    <div data-radix-popper-content-wrapper="">
      <div role="dialog" data-state="open" data-bb-portaled-overlay="" data-test="selection-menu">
        <div class="flex items-center">
          <button type="button"><svg aria-hidden="true"></svg>Add to chat</button>
        </div>
      </div>
    </div>`;
  const OTHER_POPOVER_HTML = `
    <div data-radix-popper-content-wrapper="">
      <div role="dialog" data-state="open" data-bb-portaled-overlay="" data-test="other-popover">
        <div role="group" aria-label="Thread context"><button type="button">Pin</button></div>
      </div>
    </div>`;
  const DIALOG_HTML = `
    <div role="dialog" data-state="open" data-test="dialog">
      <button type="button">Add to chat</button>
    </div>`;

  beforeEach(() => {
    mountSplit([{ id: "pane-1", focused: true }]);
  });

  it("knows the menu inside a conversation by its place", () => {
    byTest("viewport-pane-1").insertAdjacentHTML("afterbegin", OTHER_POPOVER_HTML);

    expect(isSelectionMenu(byTest("other-popover"))).toBe(true);
  });

  it("knows the menu on the page body by its Add to chat button", () => {
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU_HTML);

    expect(isSelectionMenu(byTest("selection-menu"))).toBe(true);
  });

  it("does not take another popover on the page body for the menu", () => {
    document.body.insertAdjacentHTML("beforeend", OTHER_POPOVER_HTML);

    expect(isSelectionMenu(byTest("other-popover"))).toBe(false);
  });

  it("does not take a dialog that is not a popover for the menu", () => {
    document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);

    expect(isSelectionMenu(byTest("dialog"))).toBe(false);
  });

  it("reports no open dialog while only selection menus show", () => {
    expect(hasOpenModal()).toBe(false);

    byTest("viewport-pane-1").insertAdjacentHTML("afterbegin", SELECTION_MENU_HTML);
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU_HTML);

    expect(hasOpenModal()).toBe(false);
  });

  it.each([
    ["another popover", OTHER_POPOVER_HTML],
    ["a dialog", DIALOG_HTML],
    ["an aria-modal element", '<div aria-modal="true"></div>'],
  ])("reports an open dialog for %s, also next to a selection menu", (_name, html) => {
    document.body.insertAdjacentHTML("beforeend", html);
    expect(hasOpenModal()).toBe(true);

    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU_HTML);
    expect(hasOpenModal()).toBe(true);
  });

  it("ignores closed and inert dialogs, as bb does", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div role="dialog" data-state="closed"></div>
       <div inert="">${SELECTION_MENU_HTML}${DIALOG_HTML}</div>`,
    );

    expect(hasOpenModal()).toBe(false);
  });

});

describe("runSelfCheck", () => {
  it("reports nothing for bb's usual markup", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    expect(runSelfCheck()).toEqual([]);
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      splitPaneHtml({ id: "pane-1" }) + splitPaneHtml({ id: "pane-2", focused: true }),
    );
    expect(runSelfCheck()).toEqual([]);
  });

  it("names the hooks that are missing", () => {
    document.body.innerHTML = "<main></main>";
    expect(runSelfCheck()).toEqual(["sidebarRoot", "sidebarTrigger"]);
  });

  it("notices a sidebar without its state attribute and panes without a focus marker", () => {
    mountSidebar(windowedItemHtml(["thr_a"]));
    document.querySelector("[data-variant]")?.removeAttribute("data-state");
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      splitPaneHtml({ id: "pane-1" }) + splitPaneHtml({ id: "pane-2" }),
    );
    expect(runSelfCheck()).toEqual(["sidebarStateHolder", "paneFocused"]);
  });
});

describe("an empty document", () => {
  it("makes every function return false, null or nothing instead of throwing", () => {
    document.body.innerHTML = "";
    expect(getThreadPaneElements()).toEqual([]);
    expect(getFocusedPaneElement()).toBeNull();
    expect(getPaneElementById("pane-1")).toBeNull();
    expect(isPaneZoomed()).toBe(false);
    expect(() => focusPaneElement(null)).not.toThrow();
    expect(activatePaneByPointer("pane-1")).toBe(false);
    expect(clickClosePane()).toBe(false);
    expect(clickMaximizePane()).toBe(false);
    expect(getTimelineViewport()).toBeNull();
    expect(scrollTimelineBy(80)).toBe(false);
    expect(isSidebarOpen()).toBe(false);
    expect(toggleSidebar()).toBe(false);
    expect(getSidebarRows()).toEqual([]);
    expect(getFocusedSidebarRow()).toBeNull();
    expect(sidebarRowThreadId(null)).toBeNull();
    expect(focusSidebarRowForThread("thr_a")).toBe(false);
    expect(moveSidebarFocus(1)).toBe(false);
    expect(moveSidebarFocus(-1)).toBe(false);
    expect(focusSidebarEdge("top")).toBe(false);
    expect(focusSidebarEdge("bottom")).toBe(false);
    expect(isSidebarRowFocusedByPointer()).toBe(false);
    expect(hasSidebarSelection()).toBe(false);
    expect(isInSelectionMenu(document.body)).toBe(false);
    expect(isSelectionMenu(document.body)).toBe(false);
    expect(hasOpenModal()).toBe(false);
    expect(() => cancelPendingSidebarFocus()).not.toThrow();
    expect(runSelfCheck()).toEqual(["sidebarRoot", "sidebarTrigger"]);
    expect(frames.size).toBe(0);
  });
});
