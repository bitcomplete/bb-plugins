import type {
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  activeThreads,
  isThreadRunning,
  sortThreadsByRecency,
} from "./thread-order";
import type { ChooserItem } from "./types";

export interface ChooserInput {
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  layout: PluginSidebarSplitLayout | null;
  contextThreadId: string | null;
  query: string;
}

const UNTITLED = "Untitled";

function visibleThreadIds(
  layout: PluginSidebarSplitLayout | null,
  contextThreadId: string | null,
): Set<string> {
  if (layout === null) {
    return new Set(contextThreadId === null ? [] : [contextThreadId]);
  }
  const threadIds = new Set<string>();
  for (const pane of layout.panes) {
    if (pane.threadId !== null) threadIds.add(pane.threadId);
  }
  return threadIds;
}

function focusedThreadId(
  layout: PluginSidebarSplitLayout | null,
  contextThreadId: string | null,
): string | null {
  if (layout === null) return contextThreadId;
  return layout.panes.find((pane) => pane.isFocused)?.threadId ?? null;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

function matchesQuery(item: ChooserItem, terms: readonly string[]): boolean {
  const searchable = `${item.title}\n${item.projectName ?? ""}`.toLowerCase();
  return terms.every((term) => searchable.includes(term));
}

export function buildChooserItems(input: ChooserInput): ChooserItem[] {
  const { threads, projects, layout, contextThreadId, query } = input;
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const visible = visibleThreadIds(layout, contextThreadId);
  const focused = focusedThreadId(layout, contextThreadId);
  const terms = queryTerms(query);
  return sortThreadsByRecency(activeThreads(threads))
    .map(
      (thread): ChooserItem => ({
        threadId: thread.id,
        title: thread.displayTitle.trim() === "" ? UNTITLED : thread.displayTitle,
        projectName: projectNames.get(thread.projectId) ?? null,
        isVisibleInPane: visible.has(thread.id),
        isFocusedPane: thread.id === focused,
        isChild: thread.parentThreadId !== null,
        isRunning: isThreadRunning(thread),
        isUnread: thread.isUnread,
      }),
    )
    .filter((item) => matchesQuery(item, terms));
}
