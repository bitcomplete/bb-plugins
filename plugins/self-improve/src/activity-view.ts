import type { ActivityAccounting } from "./activity-accounting.js";

/** Display observations separately from invoice attestations and token estimates. */
export interface ActivityCostView {
  nativeTasks: number; chatConversations: number; observedChatRequests: number;
  unknownBillingActivities: number; unknownCurrencyActivities: number; ambiguousAttributionActivities: number;
  totals: Array<{ currency: string; observedSessionFloorMicros: number }>;
  limitations: string[];
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
    limitations: [...value.limitations],
  };
}
