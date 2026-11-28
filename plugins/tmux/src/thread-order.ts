import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ATTRIBUTES, SELECTORS } from "./constants";
import type { ThreadOrderMode } from "./settings";

export type ThreadOrderSource = "sidebar" | "sidebar-cache" | "recent";

export interface ThreadOrderInput {
  mode: ThreadOrderMode;
  domOrder: string[] | null;
  threads: readonly PluginSidebarThread[];
}

export interface ThreadOrderResult {
  order: string[];
  source: ThreadOrderSource;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "active",
  "stopping",
]);

let cachedSidebarOrder: string[] | null = null;

export function isThreadRunning(thread: PluginSidebarThread): boolean {
  return RUNNING_STATUSES.has(thread.status);
}

export function activeThreads(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived && !thread.isHidden);
}

function compareByRecency(
  left: PluginSidebarThread,
  right: PluginSidebarThread,
): number {
  const leftRunning = isThreadRunning(left);
  if (leftRunning !== isThreadRunning(right)) return leftRunning ? -1 : 1;
  const attentionDelta = right.latestAttentionAt - left.latestAttentionAt;
  if (attentionDelta !== 0) return attentionDelta;
  const createdDelta = right.createdAt - left.createdAt;
  if (createdDelta !== 0) return createdDelta;
  if (left.id < right.id) return -1;
  return left.id > right.id ? 1 : 0;
}

export function sortThreadsByRecency(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return [...threads].sort(compareByRecency);
}

function placeholderThreadIds(encoded: string): string[] {
  const threadIds: string[] = [];
  for (const pair of encoded.split(" ")) {
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) continue;
    threadIds.push(pair.slice(0, separator));
  }
  return threadIds;
}

function sidebarEntryThreadIds(element: Element): string[] {
  if (element.matches(SELECTORS.sidebarRow)) {
    const threadId = element.getAttribute(ATTRIBUTES.sidebarThreadId);
    return threadId ? [threadId] : [];
  }
  const encoded = element.getAttribute(ATTRIBUTES.sidebarWindowedNav);
  return encoded ? placeholderThreadIds(encoded) : [];
}

// Rows are not filtered by visibility on purpose: a collapsed sidebar is only
// hidden with CSS, and bb's own visibility filter is what makes its thread
// shortcuts stop working there.
export function readSidebarThreadOrder(doc: Document = document): string[] | null {
  const body = doc.querySelector(SELECTORS.sidebarBody);
  if (body === null || body.hasAttribute("hidden")) return null;
  const entries = body.querySelectorAll(
    `${SELECTORS.sidebarRow}, ${SELECTORS.sidebarWindowedNav}`,
  );
  const threadIds = new Set<string>();
  for (const entry of entries) {
    if (entry.closest(SELECTORS.sidebarOverflow) !== null) continue;
    for (const threadId of sidebarEntryThreadIds(entry)) threadIds.add(threadId);
  }
  return [...threadIds];
}

function recentOrder(threads: readonly PluginSidebarThread[]): ThreadOrderResult {
  return {
    order: sortThreadsByRecency(activeThreads(threads)).map((thread) => thread.id),
    source: "recent",
  };
}

export function resolveThreadOrder(input: ThreadOrderInput): ThreadOrderResult {
  const { mode, domOrder, threads } = input;
  if (mode === "recent") return recentOrder(threads);
  const activeIds = new Set(activeThreads(threads).map((thread) => thread.id));
  const isActive = (threadId: string) => activeIds.has(threadId);
  if (domOrder !== null && domOrder.length > 0) {
    const order = threads.length === 0 ? [...domOrder] : domOrder.filter(isActive);
    if (order.length > 0) {
      cachedSidebarOrder = [...order];
      return { order, source: "sidebar" };
    }
  }
  const cached = cachedSidebarOrder?.filter(isActive) ?? [];
  if (cached.length > 0) return { order: cached, source: "sidebar-cache" };
  return recentOrder(threads);
}

export function cycleThread(
  order: readonly string[],
  currentThreadId: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = currentThreadId === null ? -1 : order.indexOf(currentThreadId);
  if (index === -1) {
    return order[delta === 1 ? 0 : order.length - 1] ?? null;
  }
  if (order.length === 1) return null;
  return order[(index + delta + order.length) % order.length] ?? null;
}

export function nthThread(order: readonly string[], index: number): string | null {
  if (!Number.isInteger(index) || index < 1) return null;
  return order[index - 1] ?? null;
}

export function lastThread(order: readonly string[]): string | null {
  return order.at(-1) ?? null;
}

export function resetThreadOrderCache(): void {
  cachedSidebarOrder = null;
}
