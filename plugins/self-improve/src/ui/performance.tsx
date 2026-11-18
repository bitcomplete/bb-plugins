import { PublicationStatus } from "./publication-status.js";
import { ActivityCosts } from "./activity-costs.js";
import { useEffect, useId, useRef, useState } from "react";
import type { Solution } from "../domain/types.js";
import type { DashboardApi, PerformancePoint } from "./types.js";

const timestamp = (ms: number) => Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toLocaleString() : "Time unavailable";
const rateLabel = (rate: number) => rate === 0 ? "0" : Math.abs(rate) < .001 ? rate.toPrecision(2) : rate.toFixed(3);
function costLabel(costs: PerformancePoint["costs"]): string {
  return costs.length ? costs.map(c => `${((c.reportedMicros + c.estimatedMicros) / 1_000_000).toFixed(4)} ${c.currency}${c.unknownAttempts ? ` + ${c.unknownAttempts} unknown` : ""}`).join(" · ") : "Not attributed";
}
export function Performance({ api, solutions, refreshKey }: { api: DashboardApi; solutions: Solution[]; refreshKey: number }) {
  const [selected, setSelected] = useState("");
  const [points, setPoints] = useState<PerformancePoint[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current; setBusy(true); setError(""); setPoints([]);
    void api.performance(selected ? { solutionId: selected } : {}).then(result => {
      if (current === sequence.current) setPoints(result.points);
    }).catch(e => {
      if (current === sequence.current) setError(e instanceof Error ? e.message.slice(0, 500) : "Performance could not be loaded.");
    }).finally(() => { if (current === sequence.current) setBusy(false); });
    return () => { sequence.current++; };
  }, [api, selected, refreshKey, retry]);
  const ids = [...new Set(points.map(p => p.solutionId))];
  return <div className="si-performance"><header><div><span className="si-eyebrow">Measure the effect</span><h2>Is the loop making things better?</h2><p>Compare observed votes per eligible session. Exposure, confounders and cost stay beside the result.</p></div><label>Solution<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">All solutions</option>{solutions.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label></header>
    {busy ? <p className="si-loading" role="status">Loading performance history…</p> : error ? <div className="si-notice si-notice-bad" role="alert"><span>{error}</span><button className="si-button" onClick={() => setRetry(n => n + 1)}>Retry performance</button></div> : !points.length ? <div className="si-empty"><h3>No performance observations yet</h3><p>Baseline and follow-up windows appear after verification. No data means no claim of improvement.</p></div> : <>
      <p className="si-section-note">Rates are observed associations. A small or confounded sample cannot establish that a solution caused the change. Snapshot costs may repeat across baseline and follow-up rows; do not add them together.</p>
      <div className="si-trend-grid">{ids.map(id => <Trend key={id} name={solutions.find(s => s.id === id)?.title ?? id} points={points.filter(p => p.solutionId === id)}/>)}</div>
      <div className="si-table-wrap" tabIndex={0} role="region" aria-label="Performance observations"><table><caption>Recorded observation windows</caption><thead><tr><th>Solution / observed at</th><th>Phase</th><th>Votes</th><th>Sessions</th><th>Votes / session</th><th>Snapshot cost</th><th>Confounders</th></tr></thead><tbody>{[...points].sort((a,b) => b.atMs - a.atMs).map(p => <tr key={p.id}><th scope="row">{solutions.find(s => s.id === p.solutionId)?.title ?? p.solutionId}<small>{timestamp(p.atMs)}</small></th><td>{p.phase === "baseline" ? "Baseline" : "After adoption"}</td><td>{p.votes}</td><td>{p.sessions}</td><td>{p.rate === null ? "Insufficient exposure" : rateLabel(p.rate)}</td><td>{costLabel(p.costs)}<ActivityCosts value={p.activityCosts}/></td><td>{p.confounders.length ? p.confounders.join("; ") : "None recorded"}</td></tr>)}</tbody></table></div>
    </>}
    <PublicationStatus api={api} solutionId={selected || undefined} refreshKey={refreshKey}/>
  </div>;
}

function Trend({ name, points }: { name: string; points: PerformancePoint[] }) {
  const id = useId();
  const ordered = [...points].filter(p => Number.isFinite(new Date(p.atMs).getTime())).sort((a,b) => a.atMs - b.atMs);
  const finite = ordered.filter((p): p is PerformancePoint & {rate:number} => p.rate !== null && Number.isFinite(p.rate) && p.rate >= 0);
  const start = ordered[0]?.atMs ?? 0, end = ordered.at(-1)?.atMs ?? start;
  const observedMaximum = finite.reduce((maximum, p) => Math.max(maximum, p.rate), 0);
  const maximum = observedMaximum > 0 ? observedMaximum * 1.15 : 1;
  const x = (ms:number) => end === start ? 270 : 50 + 440 * ((ms - start) / (end - start));
  const y = (rate:number) => 160 - 120 * rate / maximum;
  return <section className="si-trend"><h3>{name}</h3>{finite.length < 2 && <p className="si-muted">At least two measured windows are needed to see a trend.</p>}
    {finite.length > 0 && <svg className="si-trend-chart" viewBox="0 0 540 205" role="img" aria-labelledby={`${id}-title ${id}-description`}><title id={`${id}-title`}>{name}: observed votes per session</title><desc id={`${id}-description`}>{finite.map(p => `${p.phase}: ${rateLabel(p.rate)} votes per session, ${timestamp(p.atMs)}`).join(". ")}. Full exposure and confounders are in the table below.</desc><line x1="50" y1="40" x2="50" y2="160" className="si-chart-axis"/><line x1="50" y1="160" x2="490" y2="160" className="si-chart-axis"/><line x1="50" y1="100" x2="490" y2="100" className="si-chart-grid"/><text x="40" y="44" textAnchor="end">{rateLabel(maximum)}</text><text x="40" y="164" textAnchor="end">0</text><text x="50" y="190">{new Date(start).toLocaleDateString()}</text><text x="490" y="190" textAnchor="end">{new Date(end).toLocaleDateString()}</text>{finite.map(p => p.phase === "baseline" ? <rect key={p.id} x={x(p.atMs)-5} y={y(p.rate)-5} width="10" height="10" className="si-chart-baseline"><title>{timestamp(p.atMs)}: {rateLabel(p.rate)} votes/session · baseline</title></rect> : <circle key={p.id} cx={x(p.atMs)} cy={y(p.rate)} r="5" className="si-chart-after"><title>{timestamp(p.atMs)}: {rateLabel(p.rate)} votes/session · after adoption</title></circle>)}</svg>}
    <div className="si-chart-legend"><span><i className="si-chart-baseline"/>Baseline</span><span><i className="si-chart-after"/>After adoption</span><small>Each mark is one measured window.</small></div>
  </section>;
}
