import { describe, expect, it } from "vitest";
import { backlogThreads } from "./backlog-threads";

const url = "https://github.com/acme/app/pull/1";
const liveThread = (patch: Partial<Parameters<typeof backlogThreads>[4][number]> = {}) => ({
  id: "worker", title: "Repair the CI failure", titleFallback: null, updatedAt: 5,
  indicator: "none" as const, hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 }, ...patch,
});
describe("backlog thread access", () => {
  it("keeps remote worker links without a checkout or a usable readiness result", () => {
    expect(backlogThreads(url, [], [], [{ prUrl: `${url.toUpperCase()}/`, threadId: "worker", status: "needs-attention" }], [])).toEqual([{ id: "worker", title: "Rebasing...", tier: "started", active: false }]);
  });
  it("combines author, action, and worker links once without borrowing sibling PR threads", () => {
    const local = [{ id: "author", title: "Author", tier: "environment" as const, active: false }];
    const runs = [{ prUrl: url, threadId: "author", status: "done" }, { prUrl: `${url}0`, threadId: "other", status: "running" }];
    expect(backlogThreads(url, local, runs, [{ prUrl: url, threadId: "worker", status: "running" }], []).map((thread) => thread.id)).toEqual(["worker", "author"]);
  });
  it("retains the previous worker after handing a failed job to a repair thread", () => {
    const jobs = [{ prUrl: url, threadId: "repair", status: "running", previousAttempts: [{ threadId: "original", status: "needs-attention" }] }];
    expect(backlogThreads(url, [], [], jobs, []).map((thread) => thread.id)).toEqual(["repair", "original"]);
  });
  it("keeps a live runtime active when auxiliary work counts are zero", () => {
    const live = [liveThread({ indicator: "runtime" })];
    expect(backlogThreads(url, [], [], [{ prUrl: url, threadId: "worker", status: "needs-attention" }], live)[0]?.active).toBe(true);
  });
  it.each(["unread-success", "unread-error"] as const)("does not mistake %s for active work", (indicator) => {
    const live = [liveThread({ indicator })];
    expect(backlogThreads(url, [], [], [{ prUrl: url, threadId: "worker", status: "running" }], live)[0]?.active).toBe(false);
  });
  it.each(["planMode", "goals"] as const)("includes live %s activity", (kind) => {
    const live = [liveThread({ activity: { ...liveThread().activity, [kind]: 1 } })];
    expect(backlogThreads(url, [], [], [{ prUrl: url, threadId: "worker", status: "ready" }], live)[0]?.active).toBe(true);
  });
  it("uses live thread titles and activity instead of stale run state", () => {
    const live = [liveThread()];
    expect(backlogThreads(url, [], [], [{ prUrl: url, threadId: "worker", status: "running" }], live)[0]).toMatchObject({ title: "Repair the CI failure", active: false });
  });
});
