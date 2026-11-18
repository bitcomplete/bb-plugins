import { useEffect, useId, useRef, useState } from "react";
import type { DashboardApi, ObjectiveInput } from "./types.js";

/** An intake form. It records the owner's intent without inventing observation evidence. */
export function ObjectiveForm({ api, onCreated, onClose }: {
  api: DashboardApi; onCreated: (id: string) => void; onClose: () => void;
}) {
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false), mounted = useRef(true);
  const pendingRequest = useRef<{ key: string; requestId: string } | null>(null);
  const [kind, setKind] = useState<ObjectiveInput["kind"]>("problem");
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [priority, setPriority] = useState<ObjectiveInput["priority"]>("normal");
  const [withMetric, setWithMetric] = useState(false), [metricName, setMetricName] = useState("");
  const [metricUnit, setMetricUnit] = useState("");
  const [target, setTarget] = useState(""), [direction, setDirection] = useState<"lower" | "higher">("lower");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; titleRef.current?.focus(); return () => { mounted.current = false; }; }, []);
  return <section className="si-intake" aria-labelledby={`${id}-title`}>
    <header><div><span className="si-eyebrow">Start with what matters</span><h2 id={`${id}-title`}>Add a problem or goal</h2></div><button type="button" className="si-button si-button-quiet" onClick={onClose} disabled={busy}>Close form</button></header>
    <p className="si-muted">Describe a rough edge or something you want to improve. Your request stays distinct from measured evidence.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (submitting.current) return;
      if (!title.trim() || !description.trim()) { setError("Add a title and description."); return; }
      const needsMetric = withMetric || kind === "goal";
      if (needsMetric && (!metricName.trim() || !metricUnit.trim() || !target.trim() || !Number.isFinite(Number(target)))) { setError("Add a metric name, unit and a finite numeric target."); return; }
      const input: Omit<ObjectiveInput, "requestId"> = { kind, title: title.trim(), description: description.trim(), priority,
        ...(needsMetric ? { metric: { name: metricName.trim(), unit: metricUnit.trim(), target: Number(target), direction } } : {}) };
      const key = JSON.stringify(input);
      // An unchanged draft retries the original intent even if its response was lost.
      if (pendingRequest.current?.key !== key) pendingRequest.current = { key, requestId: crypto.randomUUID() };
      const requestId = pendingRequest.current.requestId;
      submitting.current = true; setBusy(true); setError("");
      try {
        const result = await api.createObjective({ ...input, requestId });
        pendingRequest.current = null;
        if (mounted.current) onCreated(result.id);
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message.slice(0, 500) : "Could not save. Your draft is still here."); }
      finally { submitting.current = false; if (mounted.current) setBusy(false); }
    }}>
      <fieldset disabled={busy}><legend className="si-sr-only">Problem or goal details</legend>
        <div className="si-form-row"><label>Type<select value={kind} onChange={e => setKind(e.target.value as ObjectiveInput["kind"])}><option value="problem">Problem to solve</option><option value="goal">Goal to optimize</option></select></label><label>Priority<select value={priority} onChange={e => setPriority(e.target.value as ObjectiveInput["priority"])}><option value="normal">Normal exploration</option><option value="focus">Focus on this</option></select></label></div>
        <label>Title<input ref={titleRef} required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="Make the test feedback loop faster"/></label>
        <label>Description<textarea required maxLength={4000} rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="What happens today? What would better look like?"/></label>
        {kind === "problem" ? <label className="si-checkbox"><input type="checkbox" checked={withMetric} onChange={e => setWithMetric(e.target.checked)}/>I have a measurable target</label> : <p className="si-section-note">An optimization goal needs a target so progress can be measured.</p>}
        {(withMetric || kind === "goal") && <div className="si-form-row"><label>Metric name<input required maxLength={100} value={metricName} onChange={e => setMetricName(e.target.value)} placeholder="Test feedback time"/></label><label>Unit<input required maxLength={100} value={metricUnit} onChange={e => setMetricUnit(e.target.value)} placeholder="seconds"/></label><label>Target<input required type="number" step="any" value={target} onChange={e => setTarget(e.target.value)}/></label><label>Better means<select value={direction} onChange={e => setDirection(e.target.value as "lower" | "higher")}><option value="lower">A lower value</option><option value="higher">A higher value</option></select></label></div>}
        {error && <p className="si-action-error" role="alert">{error}</p>}
        <div className="si-form-actions"><small>Saved to the ledger with an audit record.</small><button className="si-button si-button-primary" type="submit">{busy ? "Saving…" : "Add to ledger"}</button></div>
      </fieldset>
    </form>
  </section>;
}
