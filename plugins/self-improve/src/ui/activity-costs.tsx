import type { ActivityCostView } from "../activity-view.js";

export function ActivityCosts({ value }: { value?: ActivityCostView }) {
  if (!value || (!value.nativeTasks && !value.chatConversations)) return null;
  return <details className="si-metadata si-native-costs"><summary>BB usage · {value.nativeTasks} tasks · {value.chatConversations} chats</summary>
    <p>Provider-session reports are observations, not subscription invoices. They are kept separate from recorded charges and estimates.</p>
    {value.totals.length ? <ul>{value.totals.map(total => <li key={total.currency}>
      {(total.observedSessionFloorMicros / 1_000_000).toFixed(4)} {total.currency} observed session floor
    </li>)}</ul> : <p>No monetary session report received.</p>}
    {value.ambiguousAttributionActivities > 0 && <p>Cost attribution is ambiguous for {value.ambiguousAttributionActivities} activities: their provider sessions are shared. The floor can include other solutions or runs; do not add filtered totals together.</p>}
    <p>{value.unknownBillingActivities} activities have incomplete billing; {value.unknownCurrencyActivities} have no reported cost currency. Unknown does not mean free.</p>
    <p>{value.observedChatRequests} chat requests observed. Reporting can lag; spending limits stop future work using the available reports.</p>
  </details>;
}
