import { describe, expect, it } from "vitest";
import { buildSidebar, compareEfforts, isBusy, type SidebarEffort, type SidebarLiveProject, type SidebarLiveThread, type SidebarProjectData } from "./sidebar.js";

const thread = (over: Partial<SidebarLiveThread> & { id: string }): SidebarLiveThread => ({
  projectId: "p1",
  displayTitle: over.id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  status: "idle",
  isPinned: false,
  updatedAt: 0,
  ...over,
});

const project = (over: Partial<SidebarLiveProject> & { id: string }): SidebarLiveProject => ({ name: over.id, isPersonal: false, ...over });

const binding = (over: Partial<SidebarProjectData["bindings"][number]> & { key: string; threadId: string }): SidebarProjectData["bindings"][number] => ({
  kind: "ticket",
  stage: "build",
  hold: null,
  blockedOn: null,
  needsUser: false,
  advancedAt: null,
  workers: [],
  reviewers: [],
  ...over,
});

const data = (over: Partial<SidebarProjectData> & { projectId: string }): SidebarProjectData => ({
  name: over.projectId,
  projectStewardThreadId: null,
  bindings: [],
  ended: [],
  ...over,
});

const effort = (over: Partial<SidebarEffort> & { key: string }): SidebarEffort => ({
  bindingKey: null,
  rootThreadId: over.key,
  title: over.key,
  kind: null,
  stage: null,
  hold: null,
  blockedOn: null,
  needsUser: false,
  pinned: false,
  busy: false,
  recency: 0,
  children: [],
  ...over,
});

describe("stewards sidebar grouping", () => {
  it("puts a worker with no parent or lifecycle owner under its binding through the workers table", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_worker" })],
      data: [data({ projectId: "p1", bindings: [binding({ key: "ENG-1", threadId: "thr_steward", workers: [{ threadId: "thr_worker", title: "Implement" }] })] })],
    });
    expect(tabs[0]!.efforts).toHaveLength(1);
    expect(tabs[0]!.efforts[0]!.children).toMatchObject([{ threadId: "thr_worker", role: "worker" }]);
  });

  it("puts a reviewer under its worker, not at the effort root", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_worker" }), thread({ id: "thr_reviewer", parentThreadId: "thr_worker" })],
      data: [
        data({
          projectId: "p1",
          bindings: [binding({ key: "ENG-1", threadId: "thr_steward", workers: [{ threadId: "thr_worker", title: "Implement" }], reviewers: [{ threadId: "thr_reviewer", workerThreadId: "thr_worker" }] })],
        }),
      ],
    });
    const workers = tabs[0]!.efforts[0]!.children;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.children).toMatchObject([{ threadId: "thr_reviewer", role: "reviewer" }]);
  });

  it("lands a pre-BB-23 worker whose parent is the steward with the steward, even with no workers record", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_old_worker", parentThreadId: "thr_steward" })],
      data: [data({ projectId: "p1", bindings: [binding({ key: "ENG-1", threadId: "thr_steward" })] })],
    });
    expect(tabs[0]!.efforts[0]!.children).toMatchObject([{ threadId: "thr_old_worker", role: "worker" }]);
  });

  it("trees a one-off thread's forks and children from the thread tree", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_root" }), thread({ id: "thr_child", parentThreadId: "thr_root" }), thread({ id: "thr_fork", lifecycleOwnerThreadId: "thr_child" })],
      data: [data({ projectId: "p1" })],
    });
    expect(tabs[0]!.efforts).toHaveLength(0);
    expect(tabs[0]!.threads).toHaveLength(1);
    expect(tabs[0]!.threads[0]).toMatchObject({ rootThreadId: "thr_root", key: "thread:thr_root" });
    expect(tabs[0]!.threads[0]!.children).toMatchObject([{ threadId: "thr_child", role: "thread", children: [{ threadId: "thr_fork", role: "thread" }] }]);
  });

  it("returns stewarded efforts, one-off threads and ops watches as separate lists", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_ops" }), thread({ id: "thr_oneoff" })],
      data: [
        data({
          projectId: "p1",
          bindings: [binding({ key: "ENG-1", threadId: "thr_steward" }), binding({ key: "acme/web", threadId: "thr_ops", kind: "ops", stage: null })],
        }),
      ],
    });
    expect(tabs[0]!.efforts.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(tabs[0]!.threads.map((e) => e.key)).toEqual(["thread:thr_oneoff"]);
    expect(tabs[0]!.watches.map((e) => e.key)).toEqual(["acme/web"]);
  });

  it("skips a binding whose steward thread is not in the live view", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_other" })],
      data: [data({ projectId: "p1", bindings: [binding({ key: "ENG-1", threadId: "thr_archived" })] })],
    });
    expect(tabs[0]!.efforts).toHaveLength(0);
    expect(tabs[0]!.threads.map((e) => e.key)).toEqual(["thread:thr_other"]);
  });

  it("gives every live project a tab, stewarded or not, including the personal project", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" }), project({ id: "personal", isPersonal: true })],
      threads: [],
      data: [data({ projectId: "p1" })],
    });
    expect(tabs.map((t) => t.projectId)).toEqual(["p1", "personal"]);
    expect(tabs[1]!.isPersonal).toBe(true);
  });

  it("groups ops bindings under watches, not in flight", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_ticket" }), thread({ id: "thr_ops" })],
      data: [
        data({
          projectId: "p1",
          bindings: [binding({ key: "ENG-1", threadId: "thr_ticket" }), binding({ key: "acme/web", threadId: "thr_ops", kind: "ops", stage: null })],
        }),
      ],
    });
    expect(tabs[0]!.efforts.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(tabs[0]!.watches.map((e) => e.key)).toEqual(["acme/web"]);
  });
});

describe("stewards sidebar ordering", () => {
  it("orders pinned, then needsUser, then busy, then most recent activity", () => {
    const pinned = effort({ key: "pinned", pinned: true, recency: 1 });
    const needs = effort({ key: "needs", needsUser: true, recency: 2 });
    const busy = effort({ key: "busy", busy: true, recency: 3 });
    const recent = effort({ key: "recent", recency: 100 });
    const old = effort({ key: "old", recency: 10 });
    const ordered = [old, recent, busy, needs, pinned].sort(compareEfforts).map((e) => e.key);
    expect(ordered).toEqual(["pinned", "needs", "busy", "recent", "old"]);
  });

  it("counts starting, active and stopping as busy, and nothing else", () => {
    expect(["starting", "active", "stopping"].every(isBusy)).toBe(true);
    expect(["idle", "finished", "failed"].some(isBusy)).toBe(false);
  });

  it("orders a tab's threads and watches with the same comparator", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_quiet", updatedAt: 5 }), thread({ id: "thr_busy", status: "active", updatedAt: 1 })],
      data: [data({ projectId: "p1" })],
    });
    expect(tabs[0]!.threads.map((e) => e.rootThreadId)).toEqual(["thr_busy", "thr_quiet"]);
  });
});
