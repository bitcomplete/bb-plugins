import type { ActivityAccounting } from "./activity-accounting.js";

/** Display observations separately from invoice attestations and token estimates. */
export interface ActivityCostView {
  nativeTasks: number; chatConversations: number; observedChatRequests: number;
  unknownBillingActivities: number; unknownCurrencyActivities: number; ambiguousAttributionActivities: number;
  totals: Array<{ currency: string; observedSessionFloorMicros: number }>;
  /** Tokens BB reported for agent sessions, each session counted once. */
  tokens: { total: number; sessionsReporting: number };
  limitations: string[];
}
type NativeTasks = ReturnType<ActivityAccounting["summary"]>["native"]["tasks"];
function tokenTotals(tasks: NativeTasks): ActivityCostView["tokens"] {
  const sessions = new Map<string, number>();
  for (const task of tasks) for (const session of task.usage?.sessions ?? []) {
    if (session.tokens) sessions.set(`${task.providerId}:${session.providerSessionId}`, Math.max(sessions.get(`${task.providerId}:${session.providerSessionId}`) ?? 0, session.tokens.totalTokens));
  }
  return { total: [...sessions.values()].reduce((a, b) => a + b, 0), sessionsReporting: sessions.size };
}
/** One row per run of agent work (a build, retest, revalidation, mining pass…), newest first. */
export interface AgentRunUsage { runId: string; stage: string; solutionId: string | null; tasks: number; startedAtMs: number; tokens: number; costs: Array<{ currency: string; observedFloorMicros: number }> }
export function recentAgentRuns(value: ReturnType<ActivityAccounting["summary"]>, limit = 20): AgentRunUsage[] {
  const runs = new Map<string, NativeTasks>();
  for (const task of value.native.tasks) if (task.runId) runs.set(task.runId, [...(runs.get(task.runId) ?? []), task]);
  return [...runs.entries()].map(([runId, tasks]) => {
    const costs = new Map<string, number>();
    for (const task of tasks) for (const session of task.sessions) costs.set(session.currency, (costs.get(session.currency) ?? 0) + session.observedFloorMicros);
    return { runId, stage: tasks[0]!.stage, solutionId: tasks[0]!.solutionId ?? null, tasks: tasks.length, startedAtMs: Math.min(...tasks.map(t => t.startedAtMs)),
      tokens: tokenTotals(tasks).total, costs: [...costs].map(([currency, observedFloorMicros]) => ({ currency, observedFloorMicros })) };
  }).sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
}
export function activityCostView(value: ReturnType<ActivityAccounting["summary"]>): ActivityCostView {
  return {
    nativeTasks: value.native.nativeAdmissions,
    chatConversations: value.chats.length,
    observedChatRequests: value.calls.observedChatRequests,
    unknownBillingActivities: value.native.nativeUnknownBillingTasks + value.chats.length,
    unknownCurrencyActivities: value.native.tasks.filter(task => task.billingCompleteness === "unknown" && !task.sessions.length).length
      + value.chats.filter(chat => !chat.sessions.length).length,
    ambiguousAttributionActivities: value.native.tasks.filter(task => task.unknownReasons.some(reason => reason.startsWith("provider-session-shared"))).length
      + value.chats.filter(chat => chat.unknownReasons.some(reason => reason.startsWith("provider-session-shared"))).length,
    totals: value.totals.filter(total => value.native.tasks.some(task => task.sessions.some(session => session.currency === total.currency))
      || value.chats.some(chat => chat.sessions.some(session => session.currency === total.currency)))
      .map(total => ({ currency: total.currency, observedSessionFloorMicros: total.sharedNativeAndChatObservedFloorMicros })),
    tokens: tokenTotals(value.native.tasks),
    limitations: [...value.limitations],
  };
}
