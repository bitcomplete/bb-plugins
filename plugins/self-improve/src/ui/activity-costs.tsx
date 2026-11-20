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
  const sessions = value.nativeTasks + value.chatConversations;
  return <details className="si-metadata si-native-costs"><summary>BB usage · {value.nativeTasks} agent {value.nativeTasks === 1 ? "session" : "sessions"} · {value.chatConversations} {value.chatConversations === 1 ? "chat" : "chats"}{value.tokens?.total ? ` · ${tokensLabel(value.tokens.total)}` : ""}</summary>
    <p>{value.tokens?.total ? `${tokensLabel(value.tokens.total)} used, as reported by BB.` : "No token counts reported yet; they usually arrive within a minute or two of the work."}</p>
    {value.totals.length ? <ul>{value.totals.map(total => <li key={total.currency}>
      {(total.observedSessionFloorMicros / 1_000_000).toFixed(4)} {total.currency} reported by the provider
    </li>)}</ul> : <p>No dollar cost reported. That's normal on a subscription: BB reports tokens, not a price.</p>}
    {value.ambiguousAttributionActivities > 0 && <p>{value.ambiguousAttributionActivities} of these shared a provider session with other work, so their usage can't be split exactly.</p>}
    {sessions > 0 && value.unknownBillingActivities > 0 && <p>Provider reports don't include retries or account switches, so treat these numbers as a floor.</p>}
  </details>;
}
