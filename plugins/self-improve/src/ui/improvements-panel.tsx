import { useState } from "react";
import type { DashboardApi, DashboardData } from "./types.js";

/** Improvements added to agent turns: each can be disabled or re-enabled, and automatic applying can be switched off. */
export function ImprovementsPanel({ data, api, onChanged }: { data: DashboardData; api: DashboardApi; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const info = data.improvements;
  if (!info || !api.setImprovementEnabled) return null;
  const titles = new Map(data.solutions.map(s => [s.id, s.title]));
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await run(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message.slice(0, 300) : "That didn't work."); } finally { setBusy(null); }
  };
  const enabled = info.applied.filter(i => i.enabled).length;
  return <details className="si-metadata si-improvements" open={info.applied.length > 0 || info.awaiting.length > 0 || undefined}>
    <summary>Improvements · {enabled} applied{info.awaiting.length ? ` · ${info.awaiting.length} waiting` : ""}</summary>
    <p>Applied improvements are added to every agent turn in {info.scope === "all-except-worker" ? "all your projects except the worker project" : "the projects listed in settings"}. Disabling one takes effect from the next turn.</p>
    <label className="si-toggle"><input type="checkbox" checked={info.autoApply} disabled={busy !== null} onChange={e => { const next = e.target.checked; void act("auto", () => api.setAutoApply!({ autoApply: next })); }}/> Apply tested improvements automatically</label>
    {info.applied.length > 0 && <ul className="si-improvement-list">{info.applied.map(item => <li key={item.solutionId} className={item.enabled ? undefined : "si-improvement-off"}>
      <div><strong>{titles.get(item.solutionId) ?? item.solutionId}</strong>
        <small>{item.enabled ? item.waiting ? "Applied, waiting: the per-turn limit is full" : "Applied" : "Disabled"} · {item.source === "automatic" ? "applied automatically" : "applied by you"} · added to {item.usage.turns} {item.usage.turns === 1 ? "turn" : "turns"}</small>
        <details><summary>What it adds</summary><p>{item.content}</p></details></div>
      <button className="si-button" disabled={busy !== null} onClick={() => void act(item.solutionId, () => api.setImprovementEnabled!({ solutionId: item.solutionId, enabled: !item.enabled }))}>{busy === item.solutionId ? "Saving…" : item.enabled ? "Disable" : "Enable"}</button>
    </li>)}</ul>}
    {info.awaiting.length > 0 && <><p>Passed their tests and waiting for you:</p><ul className="si-improvement-list">{info.awaiting.map(id => <li key={id}>
      <div><strong>{titles.get(id) ?? id}</strong><small>Passed its test runs</small></div>
      <button className="si-button si-button-primary" disabled={busy !== null} onClick={() => void act(id, () => api.applyImprovement!({ solutionId: id }))}>{busy === id ? "Applying…" : "Apply"}</button>
    </li>)}</ul></>}
    {!info.applied.length && !info.awaiting.length && <p>Nothing applied yet. Fixes are applied here once they pass their test runs, which needs development test cases.</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
