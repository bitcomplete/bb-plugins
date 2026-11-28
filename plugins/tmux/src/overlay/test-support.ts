import type {
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

// Only the fields the plugin reads. With equal times the recency order falls
// back to the thread id, so threads list in id order unless a test says more.
export function makeThread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "proj-1",
    displayTitle: `Thread ${id}`,
    isArchived: false,
    isHidden: false,
    status: "idle",
    createdAt: 0,
    latestAttentionAt: 0,
    parentThreadId: null,
    isUnread: false,
    ...overrides,
  } as PluginSidebarThread;
}

export function makeProject(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false, href: "", settingsHref: "" };
}

interface PaneSpec {
  paneId: string;
  threadId: string | null;
  isFocused: boolean;
}

export function makeLayout(
  panes: readonly PaneSpec[],
): PluginSidebarSplitLayout {
  const width = 1 / panes.length;
  return {
    panes: panes.map((pane, index) => ({
      ...pane,
      rect: { x: index * width, y: 0, width, height: 1 },
    })),
  };
}

// Radix keeps a closing dialog in the page while its exit animation runs and
// reads the animation name from the computed style. jsdom has no animations,
// so this reports one for every element that carries Radix's data-state.
// Returns the function that undoes it.
export function keepClosingDialogsMounted(): () => void {
  const original = window.getComputedStyle;
  const realGetComputedStyle = original.bind(window);
  const withAnimation = (element: Element, styles: CSSStyleDeclaration) =>
    new Proxy(styles, {
      get(target, property) {
        if (property === "animationName") {
          return element.getAttribute("data-state") === "closed"
            ? "fade-out"
            : "fade-in";
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  window.getComputedStyle = (element, pseudoElement) => {
    const styles = realGetComputedStyle(element, pseudoElement);
    return element.hasAttribute("data-state")
      ? withAnimation(element, styles)
      : styles;
  };
  return () => {
    window.getComputedStyle = original;
  };
}

export interface FakeLock {
  name: string;
  clientId: string;
}

export const THIS_WINDOW_CLIENT_ID = "this-window";

// A stand-in for the browser's Web Locks API (navigator.locks), which jsdom
// does not have. heldElsewhere are the locks of other windows.
export function installFakeLocks(heldElsewhere: readonly FakeLock[] = []) {
  const held: FakeLock[] = [...heldElsewhere];
  const locks = {
    request: async (
      name: string,
      _options: LockOptions,
      callback: (lock: FakeLock) => Promise<void>,
    ): Promise<void> => {
      const own = { name, clientId: THIS_WINDOW_CLIENT_ID };
      held.push(own);
      try {
        await callback(own);
      } finally {
        held.splice(held.indexOf(own), 1);
      }
    },
    query: async () => ({ held: [...held], pending: [] }),
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  return { locks, held };
}

export function removeFakeLocks(): void {
  Reflect.deleteProperty(navigator, "locks");
}

// What a screen reader says of a live region that is polite and atomic and
// leaves aria-relevant at its default, "additions text": all of the region
// whenever an element or text is added to it, and nothing when something is
// only taken out. The function it returns gives what was said since it was
// last called.
export function listenToLiveRegion(region: HTMLElement): () => string[] {
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => {
    changes.push(...records);
  });
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  return () => {
    changes.push(...observer.takeRecords());
    const hasAddition = changes
      .splice(0)
      .some((record) => record.type === "characterData" || record.addedNodes.length > 0);
    const text = region.textContent ?? "";
    return hasAddition && text !== "" ? [text] : [];
  };
}
