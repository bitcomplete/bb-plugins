import { describe, expect, it } from "vitest";
import { buildSidebar, compareBlocked, compareEfforts, compareInflight, deploymentPhrase, effortPhrase, effortSection, effortState, effortTitle, isBusy, type SidebarEffort, type SidebarLiveProject, type SidebarLiveThread, type SidebarProjectData } from "./sidebar.js";

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
  phase: null,
  hold: null,
  holdBehind: [],
  blockedOn: null,
  needsUser: false,
  stuck: false,
  status: null,
  deployment: null,
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
  runningWorkers: 0,
  pinned: false,
  busy: false,
  recency: 0,
  state: "quiet",
  section: "inflight",
  phrase: "",
  children: [],
  ...over,
});

describe("stewards sidebar grouping", () => {
  it("puts a worker with no parent or lifecycle owner under its binding through the workers table", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_worker" })],
      data: [data({ projectId: "p1", bindings: [binding({ key: "ENG-1", threadId: "thr_steward", workers: [{ threadId: "thr_worker", title: "Implement", status: "running" }] })] })],
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
          bindings: [binding({ key: "ENG-1", threadId: "thr_steward", workers: [{ threadId: "thr_worker", title: "Implement", status: "running" }], reviewers: [{ threadId: "thr_reviewer", workerThreadId: "thr_worker" }] })],
        }),
      ],
    });
    const workers = tabs[0]!.efforts[0]!.children;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.children).toMatchObject([{ threadId: "thr_reviewer", role: "reviewer" }]);
  });

  // BB-72: stewards nest under the project steward, workers under their
  // steward, reviewers under their worker. The thread tree alone (parentOf)
  // must produce that chain when the worker/reviewer records are absent.
  it("nests steward, worker and reviewer from the thread tree, with the project steward at the tab root", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [
        thread({ id: "thr_project" }),
        thread({ id: "thr_steward", parentThreadId: "thr_project" }),
        thread({ id: "thr_worker", parentThreadId: "thr_steward" }),
        thread({ id: "thr_reviewer", parentThreadId: "thr_worker" }),
      ],
      data: [data({ projectId: "p1", projectStewardThreadId: "thr_project", bindings: [binding({ key: "ENG-1", threadId: "thr_steward" })] })],
    });
    expect(tabs[0]!.projectStewardThreadId).toBe("thr_project");
    expect(tabs[0]!.efforts[0]!.children).toMatchObject([
      { threadId: "thr_worker", role: "worker", children: [{ threadId: "thr_reviewer", role: "reviewer" }] },
    ]);
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

  it("returns stewarded efforts, one-off threads and ops monitors as separate lists", () => {
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
    expect(tabs[0]!.monitors.map((e) => e.key)).toEqual(["acme/web"]);
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

  it("groups quiet ops bindings under monitors, not in flight", () => {
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
    expect(tabs[0]!.monitors.map((e) => e.key)).toEqual(["acme/web"]);
  });

  it("moves a blocked or needs-you ops binding into blocked, out of monitors", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_ops_blocked" }), thread({ id: "thr_ops_you" }), thread({ id: "thr_ops_quiet" })],
      data: [
        data({
          projectId: "p1",
          bindings: [
            binding({ key: "acme/sentry", threadId: "thr_ops_blocked", kind: "ops", stage: null, blockedOn: "a rotation" }),
            binding({ key: "acme/deps", threadId: "thr_ops_you", kind: "ops", stage: null, needsUser: true }),
            binding({ key: "acme/ns", threadId: "thr_ops_quiet", kind: "ops", stage: null }),
          ],
        }),
      ],
    });
    expect(tabs[0]!.monitors.map((e) => e.key)).toEqual(["acme/ns"]);
    expect(tabs[0]!.blocked.map((e) => e.key)).toEqual(["acme/deps", "acme/sentry"]);
  });

  it("keeps a blocked non-ops effort out of in flight", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_steward" }), thread({ id: "thr_ok" })],
      data: [
        data({
          projectId: "p1",
          bindings: [binding({ key: "ENG-1", threadId: "thr_steward", hold: "a freeze", holdBehind: ["ENG-9"] }), binding({ key: "ENG-2", threadId: "thr_ok" })],
        }),
      ],
    });
    expect(tabs[0]!.blocked.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(tabs[0]!.efforts.map((e) => e.key)).toEqual(["ENG-2"]);
  });

  // BB-81: an external wait is not a block, so it files by kind and the wait
  // phrase comes after the running-worker count.
  it("files an external wait by kind: ops in monitors grey, ticket and review in flight, only blockedOn and needsUser blocked", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_ops_wait" }), thread({ id: "thr_ops_blocked" }), thread({ id: "thr_ops_you" }), thread({ id: "thr_ticket_wait" }), thread({ id: "thr_review_wait" }), thread({ id: "thr_worker" })],
      data: [
        data({
          projectId: "p1",
          bindings: [
            binding({ key: "acme/deps", threadId: "thr_ops_wait", kind: "ops", stage: null, status: { actor: "other", nextAction: "Next scheduled look", at: 1 } }),
            binding({ key: "acme/sentry", threadId: "thr_ops_blocked", kind: "ops", stage: null, blockedOn: "a rotation" }),
            binding({ key: "acme/ns", threadId: "thr_ops_you", kind: "ops", stage: null, needsUser: true }),
            binding({ key: "ENG-1", threadId: "thr_ticket_wait", status: { actor: "other", nextAction: "an author push", at: 1 } }),
            binding({ key: "acme/web#728", threadId: "thr_review_wait", kind: "review", status: { actor: "other", nextAction: "an author push", at: 1 }, workers: [{ threadId: "thr_worker", title: "Review", status: "running" }] }),
          ],
        }),
      ],
    });
    const tab = tabs[0]!;
    // ops + other is a monitor, grey, with the wait phrase.
    expect(tab.monitors.map((e) => e.key)).toEqual(["acme/deps"]);
    expect(tab.monitors[0]!.state).toBe("quiet");
    expect(tab.monitors[0]!.phrase).toBe("waiting on Next scheduled look");
    // ops with blockedOn or needsUser is still blocked, out of monitors.
    expect(tab.blocked.map((e) => e.key).sort()).toEqual(["acme/ns", "acme/sentry"]);
    // ticket + other is in flight, grey, with the wait phrase; review + other
    // with a running worker is blue and reads the count.
    expect(tab.efforts.map((e) => e.key).sort()).toEqual(["ENG-1", "acme/web#728"]);
    const ticketWait = tab.efforts.find((e) => e.key === "ENG-1")!;
    expect(ticketWait.state).toBe("quiet");
    expect(ticketWait.phrase).toBe("waiting on an author push");
    const reviewWait = tab.efforts.find((e) => e.key === "acme/web#728")!;
    expect(reviewWait.state).toBe("running");
    expect(reviewWait.phrase).toBe("1 worker running");
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

  it("orders a tab's threads and monitors with the same comparator", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_quiet", updatedAt: 5 }), thread({ id: "thr_busy", status: "active", updatedAt: 1 })],
      data: [data({ projectId: "p1" })],
    });
    expect(tabs[0]!.threads.map((e) => e.rootThreadId)).toEqual(["thr_busy", "thr_quiet"]);
  });

  it("orders blocked: pinned, then needs-you (yellow) before red, then recency", () => {
    const you = effort({ key: "you", needsUser: true, state: "you", recency: 1 });
    const blockedOld = effort({ key: "blocked-old", blockedOn: "x", state: "blocked", recency: 5 });
    const blockedNew = effort({ key: "blocked-new", blockedOn: "y", state: "blocked", recency: 50 });
    const pinned = effort({ key: "pinned", pinned: true, blockedOn: "z", state: "blocked", recency: 0 });
    const ordered = [blockedOld, you, pinned, blockedNew].sort(compareBlocked).map((e) => e.key);
    expect(ordered).toEqual(["pinned", "you", "blocked-new", "blocked-old"]);
  });

  it("orders in flight: pinned, then running before quiet, then recency", () => {
    const runningOld = effort({ key: "running-old", runningWorkers: 1, state: "running", recency: 1 });
    const quietNew = effort({ key: "quiet-new", recency: 99 });
    const pinned = effort({ key: "pinned", pinned: true, recency: 0 });
    const ordered = [quietNew, runningOld, pinned].sort(compareInflight).map((e) => e.key);
    expect(ordered).toEqual(["pinned", "running-old", "quiet-new"]);
  });
});

describe("stewards sidebar state, section and phrase (BB-76)", () => {
  it("takes the state in precedence order: you › blocked › running › quiet", () => {
    // A running effort that also needs you is yellow.
    expect(effortState(effort({ key: "a", needsUser: true, blockedOn: "x", runningWorkers: 1 }))).toBe("you");
    expect(effortState(effort({ key: "b", blockedOn: "x", runningWorkers: 1 }))).toBe("blocked");
    expect(effortState(effort({ key: "c", runningWorkers: 1 }))).toBe("running");
    expect(effortState(effort({ key: "d" }))).toBe("quiet");
  });

  it("treats each block signal as blocked: blockedOn, hold and stuck", () => {
    expect(effortState(effort({ key: "a", blockedOn: "a review" }))).toBe("blocked");
    expect(effortState(effort({ key: "b", hold: "a freeze" }))).toBe("blocked");
    expect(effortState(effort({ key: "c", stuck: true }))).toBe("blocked");
  });

  it("does not treat an external wait as a block: quiet, or running with a running worker", () => {
    expect(effortState(effort({ key: "a", statusActor: "other", statusNextAction: "the vendor" }))).toBe("quiet");
    expect(effortState(effort({ key: "b", statusActor: "other", statusNextAction: "the vendor", runningWorkers: 1 }))).toBe("running");
  });

  it("counts a busy thread or a running worker as running", () => {
    expect(effortState(effort({ key: "a", busy: true }))).toBe("running");
    expect(effortState(effort({ key: "b", runningWorkers: 2 }))).toBe("running");
  });

  it("puts needs-you and blocked in the blocked section, ops in monitors, the rest in flight", () => {
    expect(effortSection(effort({ key: "a", needsUser: true, state: "you" }))).toBe("blocked");
    expect(effortSection(effort({ key: "b", blockedOn: "x", state: "blocked" }))).toBe("blocked");
    expect(effortSection(effort({ key: "c", kind: "ops", state: "quiet" }))).toBe("monitors");
    expect(effortSection(effort({ key: "d", kind: "ticket", state: "running" }))).toBe("inflight");
  });

  it("phrases every rule, first match wins", () => {
    // 1. needs you
    expect(effortPhrase(effort({ key: "a", needsUser: true, blockedOn: "x" }))).toBe("needs you");
    // 2. blockedOn
    expect(effortPhrase(effort({ key: "b", blockedOn: "bb-gate#88" }))).toBe("blocked on bb-gate#88");
    // 3. hold
    expect(effortPhrase(effort({ key: "c", hold: "a freeze", holdBehind: ["BB-57", "BB-61"] }))).toBe("held behind BB-57, BB-61");
    expect(effortPhrase(effort({ key: "d", hold: "a freeze" }))).toBe("on hold");
    // 4. stuck
    expect(effortPhrase(effort({ key: "e", stuck: true }))).toBe("stuck");
    // 5. running workers, before the external wait so a waiting effort with a
    // running worker reads the count (BB-81).
    expect(effortPhrase(effort({ key: "g", runningWorkers: 2 }))).toBe("2 workers running");
    expect(effortPhrase(effort({ key: "h", runningWorkers: 1 }))).toBe("1 worker running");
    // A busy steward or reviewer with no running worker falls through, not "0 workers running".
    expect(effortPhrase(effort({ key: "g2", busy: true, statusNextAction: "a reviewer is checking" }))).toBe("a reviewer is checking");
    expect(effortPhrase(effort({ key: "g3", busy: true }))).toBe("no report yet");
    // 6. actor = other, after the count
    expect(effortPhrase(effort({ key: "f", statusActor: "other", statusNextAction: "an owner LGTM" }))).toBe("waiting on an owner LGTM");
    expect(effortPhrase(effort({ key: "f2", statusActor: "other", statusNextAction: "the vendor", runningWorkers: 1 }))).toBe("1 worker running");
    // 7. deployment
    expect(effortPhrase(effort({ key: "i", deployment: "merged" }))).toBe("deploying");
    expect(effortPhrase(effort({ key: "j", deployment: "deployed" }))).toBe("deployed");
    expect(effortPhrase(effort({ key: "k", deployment: "failed" }))).toBe("deploy failed");
    // 8. nextAction
    expect(effortPhrase(effort({ key: "l", statusNextAction: "wait for the review" }))).toBe("wait for the review");
    // 9. no report
    expect(effortPhrase(effort({ key: "m" }))).toBe("no report yet");
  });

  it("phrases a deployment watch's state", () => {
    expect(deploymentPhrase("merged")).toBe("deploying");
    expect(deploymentPhrase("deploying")).toBe("deploying");
    expect(deploymentPhrase("deployed")).toBe("deployed");
    expect(deploymentPhrase("failed")).toBe("deploy failed");
  });

  it("strips the key prefix so line one shows the key and title without repeating it", () => {
    expect(effortTitle("ENG-1: Fix login", "ENG-1")).toBe("Fix login");
    expect(effortTitle("Review acme/web#612: Read metrics", "acme/web#612")).toBe("Read metrics");
    expect(effortTitle("A title that keeps its words", "ENG-1")).toBe("A title that keeps its words");
    expect(effortTitle("Any title", null)).toBe("Any title");
  });

  it("derives state, section and phrase for every effort a tab builds", () => {
    const tabs = buildSidebar({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "thr_you" }), thread({ id: "thr_run" }), thread({ id: "thr_ops" })],
      data: [
        data({
          projectId: "p1",
          bindings: [
            binding({ key: "ENG-1", threadId: "thr_you", needsUser: true }),
            binding({ key: "ENG-2", threadId: "thr_run", workers: [{ threadId: "thr_w", title: "w", status: "running" }] }),
            binding({ key: "acme/web", threadId: "thr_ops", kind: "ops", stage: null }),
          ],
        }),
      ],
    });
    expect(tabs[0]!.blocked.map((e) => `${e.key}:${e.state}:${e.phrase}`)).toEqual(["ENG-1:you:needs you"]);
    expect(tabs[0]!.efforts.map((e) => `${e.key}:${e.state}`)).toEqual(["ENG-2:running"]);
    expect(tabs[0]!.monitors.map((e) => `${e.key}:${e.state}:${e.phrase}`)).toEqual(["acme/web:quiet:no report yet"]);
  });
});
