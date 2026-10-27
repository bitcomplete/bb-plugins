// The sidebar thread list's pure core: joining the host's live thread view to
// the `stewardsSidebar` RPC result, grouping threads into efforts, deriving each
// effort's state / section / phrase, and ordering them. No React and no SDK, so
// the component and its tests share exactly this code.
//
// Grouping comes from the steward relationship, then the thread tree. A worker
// belongs to its binding through the plugin's `workers` table, which the RPC
// carries; a reviewer through its worker, which the RPC names. The thread tree
// covers what the records do not: a one-off thread's children, and a worker an
// older steward left with only its lifecycle owner. Since BB-72 a worker's
// parent is its steward and a reviewer's is its worker, so the fallback and
// the records agree.

import type { DeployState } from "./deploy.js";

/** A binding as `stewardsSidebar` reports it. */
export interface SidebarBinding {
  key: string;
  kind: string;
  stage: string | null;
  /** The entity's own state, as the playbook's `phases` table names it; null when the binding has none. */
  phase: string | null;
  threadId: string | null;
  hold: string | null;
  /** Entity keys this hold waits behind. */
  holdBehind: string[];
  blockedOn: string | null;
  needsUser: boolean;
  /** An open `stuck` escalation (BB-76). */
  stuck: boolean;
  /** The status report's actor, next action and timestamp, or null with no report. */
  status: { actor: string; nextAction: string; at: number } | null;
  /** The state of the newest deployment watch, or null with none (BB-76). */
  deployment: DeployState | null;
  /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
  pending: { text: string; quiet?: boolean }[];
  /** When the binding is next due a look, for `next look <time>` (BB-83). */
  requeueAt: number | null;
  advancedAt: number | null;
  workers: SidebarWorker[];
  reviewers: SidebarReviewer[];
}

export interface SidebarWorker {
  threadId: string;
  title: string;
  /** The plugin's own worker status, so the running count is of running workers. */
  status: string;
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

/** The four glyphs, in precedence order: you › blocked › running › quiet. */
export type SidebarEffortState = "you" | "blocked" | "running" | "quiet";

/** Which section an effort belongs to. `ops` bindings are `monitors` unless they need you or are blocked. */
export type SidebarSection = "blocked" | "inflight" | "monitors";

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
  /** The entity's own phase, shown on line two; null for ops and one-off threads. */
  phase: string | null;
  hold: string | null;
  holdBehind: string[];
  blockedOn: string | null;
  needsUser: boolean;
  stuck: boolean;
  statusActor: string | null;
  statusNextAction: string | null;
  statusAt: number | null;
  deployment: DeployState | null;
  /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
  pending: { text: string; quiet?: boolean }[];
  /** When the binding is next due a look, for `next look <time>` (BB-83). */
  requeueAt: number | null;
  /** How many of the binding's workers are running (worker-table status). */
  runningWorkers: number;
  pinned: boolean;
  busy: boolean;
  /** The most recent activity anywhere in the effort, epoch ms. */
  recency: number;
  /** Derived: the glyph. */
  state: SidebarEffortState;
  /** Derived: the section it sits in. */
  section: SidebarSection;
  /** Derived: line two's status phrase. */
  phrase: string;
  children: SidebarChild[];
}

export interface SidebarTab {
  projectId: string;
  name: string;
  isPersonal: boolean;
  /** Needs-you (yellow) then blocked (red) efforts: stewarded and ops. */
  blocked: SidebarEffort[];
  /** In-flight stewarded efforts, running before quiet. `ops` bindings are in `monitors`, one-off threads in `threads`. */
  efforts: SidebarEffort[];
  /** One-off threads (no steward binding), ordered. */
  threads: SidebarEffort[];
  /** `ops`, Dependabot and Sentry bindings that are neither waiting on you nor blocked. */
  monitors: SidebarEffort[];
  projectStewardThreadId: string | null;
  ended: SidebarEnded[];
}

const BUSY = new Set(["starting", "active", "stopping"]);

/** bb's own list counts these as busy. */
export const isBusy = (status: string): boolean => BUSY.has(status);

const parentOf = (t: Pick<SidebarLiveThread, "parentThreadId" | "lifecycleOwnerThreadId">): string | null => t.parentThreadId ?? t.lifecycleOwnerThreadId;

/**
 * The fields the glyph, section and phrase rules read. A `SidebarEffort` has
 * all of them; the Stewards page builds one from its board RPC's steward shape,
 * so both surfaces derive the same state and phrase from the same rules (BB-78).
 * `busy` is the live steward thread's status, so a surface with no live view
 * passes `false` and relies on the running-worker count.
 */
export interface EffortStatus {
  busy: boolean;
  runningWorkers: number;
  needsUser: boolean;
  blockedOn: string | null;
  hold: string | null;
  holdBehind: string[];
  stuck: boolean;
  statusActor: string | null;
  statusNextAction: string | null;
  deployment: DeployState | null;
  /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
  pending: readonly { text: string; quiet?: boolean }[];
  /** When the binding is next due a look, for `next look <time>` (BB-83). */
  requeueAt: number | null;
}

/** Whether a worker or reviewer thread is running: the binding is in flight, not quiet. */
export const isRunning = (e: Pick<EffortStatus, "busy" | "runningWorkers">): boolean => e.busy || e.runningWorkers > 0;

/**
 * The effort's glyph, first match wins (BB-76):
 * needs you › blocked › running › quiet. Blocked is `blockedOn`, a hold or
 * `stuck` only; an external wait (`actor = other`) is not a block, so it is
 * running when a worker or reviewer runs and quiet otherwise. A running
 * effort that also needs you is yellow.
 */
export function effortState(e: EffortStatus): SidebarEffortState {
  if (e.needsUser) return "you";
  if (e.blockedOn !== null || e.hold !== null || e.stuck) return "blocked";
  if (isRunning(e)) return "running";
  return "quiet";
}

/** The section the effort sits in: blocked (you or red), monitors for a quiet/running `ops`, else in flight. */
export function effortSection(e: { state: SidebarEffortState; kind: string | null }): SidebarSection {
  if (e.state === "you" || e.state === "blocked") return "blocked";
  return e.kind === "ops" ? "monitors" : "inflight";
}

/** A deployment watch's state, in words: the three the row shows. */
export function deploymentPhrase(state: DeployState): string {
  if (state === "deployed") return "deployed";
  if (state === "failed") return "deploy failed";
  return "deploying";
}

/**
 * A pending note that a worker finished its turn quietly (BB-52 rule 3): the
 * one whose place a stale status summary must not keep (BB-83).
 */
export const isQuietWorkerFinish = (n: { text: string; quiet?: boolean }): boolean => n.quiet === true && /^Worker ".+" finished its turn\.$/u.test(n.text);

/** A short relative time to a future moment, for `next look <time>` (BB-83). */
export function untilPhrase(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Line two's status phrase, first match wins (BB-76, BB-86, BB-83):
 * needs you › blockedOn › hold › stuck › running › quiet worker finish ›
 * deployment › nextAction › no report. An external wait is not a prefix: an
 * `other` actor reads its `nextAction` verbatim like any other actor, and
 * `the other party` only stands in when there is no report at all.
 *
 * The quiet worker finish (BB-83) sits after the running count and before the
 * external wait: a binding whose worker finished and has nothing to wait on
 * says so instead of repeating the status summary the worker's finish made
 * stale. `now` is the clock for the relative `next look` time; it defaults to
 * the wall clock so a caller with no clock still gets a phrase.
 */
export function effortPhrase(e: EffortStatus, now: number = Date.now()): string {
  if (e.needsUser) return "needs you";
  if (e.blockedOn !== null) return `blocked on ${e.blockedOn}`;
  if (e.hold !== null) return e.holdBehind.length > 0 ? `held behind ${e.holdBehind.join(", ")}` : "on hold";
  if (e.stuck) return "stuck";
  // A running worker or reviewer paints the blue ring, but the count is of
  // running workers: a busy steward or reviewer with no running worker falls
  // through rather than reading "0 workers running". A wait on someone else
  // is not a block, so a waiting effort with a running worker reads the count.
  if (e.runningWorkers > 0) {
    const n = e.runningWorkers;
    return `${n} worker${n === 1 ? "" : "s"} running`;
  }
  if (e.pending.some(isQuietWorkerFinish)) return e.requeueAt === null ? "worker finished" : `worker finished, next look ${untilPhrase(e.requeueAt, now)}`;
  if (e.deployment !== null) return deploymentPhrase(e.deployment);
  if (e.statusNextAction !== null) return e.statusNextAction;
  if (e.statusActor === "other") return "the other party";
  return "no report yet";
}

/** Fill in the derived fields. Grouping calls this once the effort's children are attached. */
function derive(e: SidebarEffort, now: number): SidebarEffort {
  e.state = effortState(e);
  e.section = effortSection(e);
  e.phrase = effortPhrase(e, now);
  return e;
}

/**
 * The title with the key prefix stripped, so line one can show the key and the
 * title without repeating it. Steward threads are titled `<key>: <title>`, and
 * a review `<Review key>: <title>`; the key is shown separately either way.
 */
export function effortTitle(displayTitle: string, key: string | null): string {
  if (key === null) return displayTitle;
  for (const prefix of [`Review ${key}: `, `${key}: `]) {
    if (displayTitle.startsWith(prefix)) return displayTitle.slice(prefix.length);
  }
  return displayTitle;
}

/**
 * The fields the ordering comparators read. A `SidebarEffort` has all of them;
 * the Stewards page builds one from its board RPC's steward shape, so both
 * surfaces order by the same rules (BB-78).
 */
export interface EffortOrder {
  pinned: boolean;
  state: SidebarEffortState;
  recency: number;
  title: string;
}

/** An effort's ordering plus the two flags bb's own precedence reads. */
export interface EffortPriority extends EffortOrder {
  needsUser: boolean;
  busy: boolean;
}

/**
 * bb's precedence for its own list: pinned first, then threads that need the
 * user, then busy threads (`starting` / `active` / `stopping`), then most
 * recent activity. The tie-break by title keeps the order stable.
 */
export function compareEfforts(a: EffortPriority, b: EffortPriority): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.needsUser !== b.needsUser) return a.needsUser ? -1 : 1;
  if (a.busy !== b.busy) return a.busy ? -1 : 1;
  if (b.recency !== a.recency) return b.recency - a.recency;
  return a.title.localeCompare(b.title);
}

/** Blocked: pinned first, then needs-you (yellow) before red, then by recency. */
export function compareBlocked(a: EffortOrder, b: EffortOrder): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aYou = a.state === "you" ? 0 : 1;
  const bYou = b.state === "you" ? 0 : 1;
  if (aYou !== bYou) return aYou - bYou;
  if (b.recency !== a.recency) return b.recency - a.recency;
  return a.title.localeCompare(b.title);
}

/** In flight: pinned first, then running (blue) before quiet (grey), then by recency. */
export function compareInflight(a: EffortOrder, b: EffortOrder): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aRun = a.state === "running" ? 0 : 1;
  const bRun = b.state === "running" ? 0 : 1;
  if (aRun !== bRun) return aRun - bRun;
  if (b.recency !== a.recency) return b.recency - a.recency;
  return a.title.localeCompare(b.title);
}

/** Every live project gets a tab; a project with no stewards still gets its one-off threads. */
export function buildSidebar(input: {
  projects: readonly SidebarLiveProject[];
  threads: readonly SidebarLiveThread[];
  data: readonly SidebarProjectData[];
  /** The clock for relative phrases (BB-83); the wall clock when left out. */
  now?: number;
}): SidebarTab[] {
  const now = input.now ?? Date.now();
  const dataByProject = new Map(input.data.map((d) => [d.projectId, d] as const));
  const threadsByProject = new Map<string, SidebarLiveThread[]>();
  for (const t of input.threads) {
    const list = threadsByProject.get(t.projectId) ?? [];
    list.push(t);
    threadsByProject.set(t.projectId, list);
  }
  return input.projects.map((project) => buildTab(project, dataByProject.get(project.id), threadsByProject.get(project.id) ?? [], now));
}

function buildTab(project: SidebarLiveProject, data: SidebarProjectData | undefined, threads: readonly SidebarLiveThread[], now: number): SidebarTab {
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
      phase: b.phase,
      hold: b.hold,
      holdBehind: b.holdBehind,
      blockedOn: b.blockedOn,
      needsUser: b.needsUser,
      stuck: b.stuck,
      statusActor: b.status?.actor ?? null,
      statusNextAction: b.status?.nextAction ?? null,
      statusAt: b.status?.at ?? null,
      deployment: b.deployment,
      pending: b.pending,
      requeueAt: b.requeueAt,
      runningWorkers: b.workers.filter((w) => w.status === "running").length,
      pinned: root.isPinned,
      busy: isBusy(root.status),
      recency: root.updatedAt,
      state: "quiet",
      section: "inflight",
      phrase: "",
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
    derive(effort, now);
  }

  // The fallback the RPC records do not cover: a worker whose parent is its
  // steward, and anything else a claimed thread owns. Run to a fixed point so
  // a child of a fallback-attached thread lands too.
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
  // A fallback child can flip busy after the effort was derived.
  for (const effort of efforts) derive(effort, now);

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
      phase: null,
      hold: null,
      holdBehind: [],
      blockedOn: null,
      needsUser: false,
      stuck: false,
      statusActor: null,
      statusNextAction: null,
      statusAt: null,
      deployment: null,
      pending: [],
      requeueAt: null,
      runningWorkers: 0,
      pinned: root.isPinned,
      busy: isBusy(root.status),
      recency: root.updatedAt,
      state: "quiet",
      section: "inflight",
      phrase: "",
      children: [],
    };
    const visit = (t: SidebarLiveThread): SidebarChild => {
      touch(effort, t);
      return { threadId: t.id, title: t.displayTitle, role: "thread", children: (childrenByParent.get(t.id) ?? []).map(visit) };
    };
    effort.children = (childrenByParent.get(root.id) ?? []).map(visit);
    efforts.push(derive(effort, now));
  }

  const nonOps = efforts.filter((e) => e.bindingKey !== null && e.kind !== "ops");
  const ops = efforts.filter((e) => e.kind === "ops");
  return {
    projectId: project.id,
    name: project.name,
    isPersonal: project.isPersonal,
    blocked: [...nonOps, ...ops].filter((e) => e.section === "blocked").sort(compareBlocked),
    efforts: nonOps.filter((e) => e.section === "inflight").sort(compareInflight),
    threads: efforts.filter((e) => e.bindingKey === null).sort(compareEfforts),
    monitors: ops.filter((e) => e.section === "monitors").sort(compareEfforts),
    projectStewardThreadId: stewardThreadId,
    ended: data?.ended ?? [],
  };
}
