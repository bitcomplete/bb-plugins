import type { ActivityCostView, AgentRunUsage } from "../activity-view.js";

export const tokensLabel = (tokens: number) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M tokens` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k tokens` : `${tokens} tokens`;
const STAGES: Record<string, string> = { miner: "Mining", scout: "Research", inventor: "Invention", ranker: "Ranking", builder: "Build or test", verifier: "Verification" };

/** Every run of agent work and what BB reported it used, newest first. */
export function RecentAgentRuns({ runs, titles }: { runs?: AgentRunUsage[]; titles: Record<string, string> }) {
  if (!runs?.length) return null;
  return <details className="si-metadata si-recent-runs"><summary>Recent agent work · {runs.length} runs</summary>
    <div className="si-table-wrap" tabIndex={0} role="region" aria-label="Recent agent work"><table><thead><tr><th>Started</th><th>Work</th><th>Solution</th><th>Sessions</th><th>Tokens</th><th>Reported cost</th></tr></thead>
      <tbody>{runs.map(r => <tr key={r.runId}><td>{new Date(r.startedAtMs).toLocaleString()}</td><td>{STAGES[r.stage] ?? r.stage}</td><td>{r.solutionId ? titles[r.solutionId] ?? r.solutionId : "—"}</td><td>{r.tasks}</td>
        <td>{r.tokens ? tokensLabel(r.tokens) : "Not reported yet"}</td><td>{r.costs.length ? r.costs.map(c => `${(c.observedFloorMicros / 1_000_000).toFixed(4)} ${c.currency}`).join(" · ") : "Not reported"}</td></tr>)}</tbody></table></div>
    <p>Usage comes from BB's session reports and can lag a few minutes behind the work.</p>
  </details>;
}

export function ActivityCosts({ value }: { value?: ActivityCostView }) {
  if (!value || (!value.nativeTasks && !value.chatConversations)) return null;
  return <details className="si-metadata si-native-costs"><summary>BB usage · {value.nativeTasks} tasks · {value.chatConversations} chats{value.tokens?.total ? ` · ${tokensLabel(value.tokens.total)}` : ""}</summary>
    <p>Provider-session reports are observations, not subscription invoices. They are kept separate from recorded charges and estimates.</p>
    {value.totals.length ? <ul>{value.totals.map(total => <li key={total.currency}>
      {(total.observedSessionFloorMicros / 1_000_000).toFixed(4)} {total.currency} observed session floor
    </li>)}</ul> : <p>No monetary session report received.</p>}
    {value.ambiguousAttributionActivities > 0 && <p>Cost attribution is ambiguous for {value.ambiguousAttributionActivities} activities: their provider sessions are shared. The floor can include other solutions or runs; do not add filtered totals together.</p>}
    <p>{value.unknownBillingActivities} activities have incomplete billing; {value.unknownCurrencyActivities} have no reported cost currency. Unknown does not mean free.</p>
    <p>{value.observedChatRequests} chat requests observed. Reporting can lag behind the work.</p>
  </details>;
}
