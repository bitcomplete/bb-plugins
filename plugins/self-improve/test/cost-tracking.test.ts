import { expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { recentAgentRuns, activityCostView } from "../src/activity-view.js";
import type { ActivityAccounting } from "../src/activity-accounting.js";

it("allows agent work by default, with no daily cap and no spending limit", () => {
  expect(defaultConfig().budgets).toMatchObject({ allowUnknown: true, maxDailyCalls: null, dailyMicros: null, monthlyMicros: null });
});

it("lists each run's sessions, tokens and reported cost, counting a shared session's tokens once", () => {
  const session = (id: string, totalTokens: number) => ({ providerSessionId: id, tokens: { totalTokens } });
  const task = (taskId: string, runId: string, stage: string, startedAtMs: number, sessions: Array<ReturnType<typeof session>>, cost = 0) => ({
    taskId, runId, stage, solutionId: "s-a", providerId: "codex", model: "m", startedAtMs,
    usage: { sessions }, sessions: cost ? [{ providerSessionId: sessions[0]!.providerSessionId, currency: "USD", latestReportedMicros: cost, observedFloorMicros: cost }] : [],
    unknownReasons: [], billingCompleteness: "unknown" });
  const summary = { native: { nativeAdmissions: 3, nativeUnknownBillingTasks: 3, tasks: [
    task("a", "build-1", "builder", 1000, [session("s1", 500)], 20_000),
    task("b", "build-1", "builder", 1100, [session("s1", 800)]),
    task("c", "mine-1", "miner", 2000, [session("s2", 300)]),
  ] }, chats: [], calls: { observedChatRequests: 0 }, totals: [], limitations: [] } as unknown as ReturnType<ActivityAccounting["summary"]>;
  expect(recentAgentRuns(summary)).toEqual([
    { runId: "mine-1", stage: "miner", solutionId: "s-a", tasks: 1, startedAtMs: 2000, tokens: 300, costs: [] },
    { runId: "build-1", stage: "builder", solutionId: "s-a", tasks: 2, startedAtMs: 1000, tokens: 800, costs: [{ currency: "USD", observedFloorMicros: 20_000 }] },
  ]);
  expect(activityCostView(summary).tokens).toEqual({ total: 1100, sessionsReporting: 2 });
});
