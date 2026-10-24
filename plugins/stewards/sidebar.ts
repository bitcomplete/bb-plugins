// The sidebar thread list's pure core: joining the host's live thread view to
// the `stewardsSidebar` RPC result, grouping threads into efforts, and ordering
// them. No React and no SDK, so the component and its tests share exactly this
// code.
//
// Grouping comes from the steward relationship, not the thread tree. A worker
// belongs to its binding through the plugin's `workers` table, which the RPC
// carries; a reviewer through its worker, which the RPC names. The thread tree
// is used only for one-off threads, which have nothing else, and as a fallback
// for a pre-BB-23 worker whose parent is its steward (BB-23 removed that link,
// so it is a fallback, never the rule).

/** A binding as `stewardsSidebar` reports it. */
export interface SidebarBinding {
  key: string;
  kind: string;
  stage: string | null;
  threadId: string | null;
  hold: string | null;
  blockedOn: string | null;
  needsUser: boolean;
  advancedAt: number | null;
  workers: SidebarWorker[];
  reviewers: SidebarReviewer[];
}

export interface SidebarWorker {
  threadId: string;
  title: string;
}

export interface SidebarReviewer {
  threadId: string;
  workerThreadId: string;
}

export interface SidebarEnded {
  key: string;
  kind: string;
  threadId: string | null;
  title: string | null;
  endedAt: number;
}

export interface SidebarProjectData {
  projectId: string;
  name: string;
  projectStewardThreadId: string | null;
  bindings: SidebarBinding[];
  ended: SidebarEnded[];
}

/** The live-view fields grouping reads (`experimental_useSidebarThreads`). */
export interface SidebarLiveThread {
  id: string;
  projectId: string;
  displayTitle: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  status: string;
  isPinned: boolean;
  updatedAt: number;
}

export interface SidebarLiveProject {
  id: string;
  name: string;
  isPersonal: boolean;
}

export type SidebarChildRole = "worker" | "reviewer" | "thread";

/** One thread under an effort: a worker, its reviewer, or a one-off's fork/child. */
export interface SidebarChild {
  threadId: string;
  title: string;
  role: SidebarChildRole;
  children: SidebarChild[];
}

/** One effort: a root thread and the threads that belong to it. */
export interface SidebarEffort {
  /** Stable identity: the binding key for a stewarded effort, `thread:<id>` for a one-off. */
  key: string;
  /** The binding key, or null for a one-off thread. */
  bindingKey: string | null;
  rootThreadId: string;
  title: string;
  kind: string | null;
  stage: string | null;
  hold: string | null;
  blockedOn: string | null;
  needsUser: boolean;
  pinned: boolean;
  busy: boolean;
  /** The most recent activity anywhere in the effort, epoch ms. */
  recency: number;
  children: SidebarChild[];
}

export interface SidebarTab {
  projectId: string;
  name: string;
  isPersonal: boolean;
  /** In-flight stewarded efforts, ordered. `ops` bindings are in `watches`, one-off threads in `threads`. */
  efforts: SidebarEffort[];
  /** One-off threads (no steward binding), ordered. */
  threads: SidebarEffort[];
  /** `ops`, Dependabot and Sentry bindings, grouped in a collapsed row. */
  watches: SidebarEffort[];
  projectStewardThreadId: string | null;
  ended: SidebarEnded[];
}

const BUSY = new Set(["starting", "active", "stopping"]);

/** bb's own list counts these as busy. */
export const isBusy = (status: string): boolean => BUSY.has(status);

const parentOf = (t: Pick<SidebarLiveThread, "parentThreadId" | "lifecycleOwnerThreadId">): string | null => t.parentThreadId ?? t.lifecycleOwnerThreadId;

/**
 * bb's precedence for its own list: pinned first, then threads that need the
 * user, then busy threads (`starting` / `active` / `stopping`), then most
 * recent activity. The tie-break by title keeps the order stable.
 */
export function compareEfforts(a: SidebarEffort, b: SidebarEffort): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.needsUser !== b.needsUser) return a.needsUser ? -1 : 1;
  if (a.busy !== b.busy) return a.busy ? -1 : 1;
  if (b.recency !== a.recency) return b.recency - a.recency;
  return a.title.localeCompare(b.title);
}

/** Every live project gets a tab; a project with no stewards still gets its one-off threads. */
export function buildSidebar(input: {
  projects: readonly SidebarLiveProject[];
  threads: readonly SidebarLiveThread[];
  data: readonly SidebarProjectData[];
}): SidebarTab[] {
  const dataByProject = new Map(input.data.map((d) => [d.projectId, d] as const));
  const threadsByProject = new Map<string, SidebarLiveThread[]>();
  for (const t of input.threads) {
    const list = threadsByProject.get(t.projectId) ?? [];
    list.push(t);
    threadsByProject.set(t.projectId, list);
  }
  return input.projects.map((project) => buildTab(project, dataByProject.get(project.id), threadsByProject.get(project.id) ?? []));
}

function buildTab(project: SidebarLiveProject, data: SidebarProjectData | undefined, threads: readonly SidebarLiveThread[]): SidebarTab {
  const byId = new Map(threads.map((t) => [t.id, t] as const));
  const bindings = data?.bindings ?? [];
  const stewardThreadId = data?.projectStewardThreadId ?? null;

  // Where a claimed thread sits: the effort it belongs to and its own child row.
  const index = new Map<string, { effort: SidebarEffort; byThread: Map<string, SidebarChild> }>();
  const roleByThread = new Map<string, SidebarChildRole | "steward">();
  const claimed = new Set<string>();
  const efforts: SidebarEffort[] = [];

  const touch = (effort: SidebarEffort, t: SidebarLiveThread): void => {
    if (t.updatedAt > effort.recency) effort.recency = t.updatedAt;
    if (isBusy(t.status)) effort.busy = true;
  };

  for (const b of bindings) {
    const root = b.threadId === null ? undefined : byId.get(b.threadId);
    // A binding whose steward thread is not in the live view (archived) is skipped.
    if (root === undefined) continue;
    claimed.add(root.id);
    roleByThread.set(root.id, "steward");
    const effort: SidebarEffort = {
      key: b.key,
      bindingKey: b.key,
      rootThreadId: root.id,
      title: root.displayTitle,
      kind: b.kind,
      stage: b.stage,
      hold: b.hold,
      blockedOn: b.blockedOn,
      needsUser: b.needsUser,
      pinned: root.isPinned,
      busy: isBusy(root.status),
      recency: root.updatedAt,
      children: [],
    };
    const byThread = new Map<string, SidebarChild>();
    index.set(root.id, { effort, byThread });
    efforts.push(effort);

    // Workers from the plugin's own table: the binding relationship, whatever
    // the thread's parent or lifecycle owner says.
    for (const w of b.workers) {
      const thread = byId.get(w.threadId);
      if (thread === undefined) continue;
      claimed.add(thread.id);
      roleByThread.set(thread.id, "worker");
      const child: SidebarChild = { threadId: thread.id, title: thread.displayTitle, role: "worker", children: [] };
      effort.children.push(child);
      byThread.set(thread.id, child);
      touch(effort, thread);
    }
    // Reviewers, each under the worker the RPC names.
    for (const r of b.reviewers) {
      const thread = byId.get(r.threadId);
      if (thread === undefined) continue;
      claimed.add(thread.id);
      roleByThread.set(thread.id, "reviewer");
      const child: SidebarChild = { threadId: thread.id, title: thread.displayTitle, role: "reviewer", children: [] };
      (byThread.get(r.workerThreadId)?.children ?? effort.children).push(child);
      byThread.set(thread.id, child);
      touch(effort, thread);
    }
  }

  // The fallback the RPC records do not cover: a pre-BB-23 worker whose parent
  // is its steward, and anything else a claimed thread owns. Run to a fixed
  // point so a child of a fallback-attached thread lands too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of threads) {
      if (claimed.has(t.id) || t.id === stewardThreadId) continue;
      const parent = parentOf(t);
      const holder = parent === null ? undefined : index.get(parent);
      if (holder === undefined) continue;
      claimed.add(t.id);
      const parentRole = roleByThread.get(parent!) ?? "steward";
      const role: SidebarChildRole = parentRole === "steward" ? "worker" : parentRole === "worker" ? "reviewer" : "thread";
      roleByThread.set(t.id, role);
      const child: SidebarChild = { threadId: t.id, title: t.displayTitle, role, children: [] };
      (holder.byThread.get(parent!)?.children ?? holder.effort.children).push(child);
      holder.byThread.set(t.id, child);
      index.set(t.id, holder);
      touch(holder.effort, t);
      changed = true;
    }
  }

  // One-off efforts: everything left, treed by parent / lifecycle owner.
  const remaining = threads.filter((t) => !claimed.has(t.id) && t.id !== stewardThreadId);
  const remainingById = new Map(remaining.map((t) => [t.id, t] as const));
  const childrenByParent = new Map<string, SidebarLiveThread[]>();
  for (const t of remaining) {
    const parent = parentOf(t);
    if (parent === null || !remainingById.has(parent)) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(t);
    childrenByParent.set(parent, list);
  }
  const roots = remaining.filter((t) => {
    const parent = parentOf(t);
    return parent === null || !remainingById.has(parent);
  });
  for (const root of roots) {
    const effort: SidebarEffort = {
      key: `thread:${root.id}`,
      bindingKey: null,
      rootThreadId: root.id,
      title: root.displayTitle,
      kind: null,
      stage: null,
      hold: null,
      blockedOn: null,
      needsUser: false,
      pinned: root.isPinned,
      busy: isBusy(root.status),
      recency: root.updatedAt,
      children: [],
    };
    const visit = (t: SidebarLiveThread): SidebarChild => {
      touch(effort, t);
      return { threadId: t.id, title: t.displayTitle, role: "thread", children: (childrenByParent.get(t.id) ?? []).map(visit) };
    };
    effort.children = (childrenByParent.get(root.id) ?? []).map(visit);
    efforts.push(effort);
  }

  return {
    projectId: project.id,
    name: project.name,
    isPersonal: project.isPersonal,
    efforts: efforts.filter((e) => e.bindingKey !== null && e.kind !== "ops").sort(compareEfforts),
    threads: efforts.filter((e) => e.bindingKey === null).sort(compareEfforts),
    watches: efforts.filter((e) => e.kind === "ops").sort(compareEfforts),
    projectStewardThreadId: stewardThreadId,
    ended: data?.ended ?? [],
  };
}
