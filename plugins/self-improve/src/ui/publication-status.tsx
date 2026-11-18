import { useEffect, useId, useRef, useState } from "react";
import type { PublicationApi, PublicationSummary } from "../publication-view.js";
import type { PublicationObservation } from "../publication-state.js";

const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : "Publication records could not be loaded.";
const timestamp = (ms: number) => Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toLocaleString() : "Time unavailable";
function safeLink(value: string | null, repository: string): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(`/${repository}/`) ? url.href : null;
  } catch { return null; }
}
function matching(observation: PublicationObservation, publication: PublicationSummary): boolean {
  return observation.publicationId === publication.id && observation.draftId === publication.draftId
    && observation.solutionId === publication.solutionId && observation.revision === publication.revision;
}
function mergeHistory(previous: PublicationObservation[], next: PublicationObservation[]): PublicationObservation[] {
  return [...new Map([...previous, ...next].map(item => [item.id, item])).values()].sort((a, b) => b.sequence - a.sequence);
}

/** Loading or inspecting the ledger never dispatches a remote publication check. */
export function PublicationStatus({ api, solutionId, refreshKey }: { api: Partial<PublicationApi>; solutionId?: string; refreshKey: number }) {
  if (!api.publications || !api.publicationHistory || !api.reconcilePublication) return <section className="si-publication" aria-label="Publication status"><h3>Publication status</h3><p className="si-muted">Publication tracking is unavailable in this connection.</p></section>;
  // A new selection owns fresh state; requests from the old selection cannot populate it.
  return <PublicationList key={JSON.stringify([solutionId ?? null])} api={api as PublicationApi} solutionId={solutionId} refreshKey={refreshKey}/>;
}
function PublicationList({ api, solutionId, refreshKey }: { api: PublicationApi; solutionId?: string; refreshKey: number }) {
  const [publications, setPublications] = useState<PublicationSummary[] | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null), [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current; setBusy(true); setError("");
    void api.publications(solutionId === undefined ? {} : { solutionId }).then(result => {
      if (sequence.current !== current) return;
      setPublications(result.publications); setLoadedAt(Date.now());
    }).catch(cause => { if (sequence.current === current) setError(errorText(cause)); })
      .finally(() => { if (sequence.current === current) setBusy(false); });
    return () => { sequence.current++; };
  }, [api, solutionId, refreshKey, retry]);
  return <section className="si-publication" aria-label="Publication status">
    <div className="si-form-actions"><h3>Publication status</h3><button type="button" className="si-button" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh saved records</button></div>
    <p className="si-section-note">Saved observations describe the exact package at the recorded commit and time. Check publication reads GitHub; it does not merge, create releases, list in a marketplace or install anything.</p>
    {loadedAt !== null && <p className="si-muted">Ledger loaded: {timestamp(loadedAt)}. Remote observation times are shown below.</p>}
    {busy && <p role="status">Loading saved publication records…</p>}
    {error && <p role="alert" className="si-action-error">{error}{publications !== null ? " Showing the last loaded records." : " Use Refresh saved records to retry."}</p>}
    {!busy && publications?.length === 0 && <p>No publication submissions are recorded for this selection.</p>}
    <div className="si-trend-grid">{publications?.map(publication => <PublicationRecord key={JSON.stringify([publication.id, publication.draftId, publication.solutionId, publication.revision])} api={api} publication={publication}/>)}</div>
  </section>;
}
function Observation({ observation, repository }: { observation: PublicationObservation; repository: string }) {
  const review = { unsubmitted: "No PR submitted", open: "PR open", closed: "PR closed without merge", merged: "PR merged", unknown: "Review not confirmed" }[observation.review.state];
  const content = { unconfirmed: "Repository content not confirmed", available: "Exact bundle confirmed at merge commit", "content-changed": "Bundle differs at merge commit" }[observation.repository.state];
  const release = { "not-requested": "Release not checked", unconfirmed: "Release not confirmed", draft: "Draft release", released: "Release contains exact bundle", "content-changed": "Release bundle differs" }[observation.release.state];
  const reviewUrl = safeLink(observation.review.url, repository), contentUrl = safeLink(observation.repository.url, repository), releaseUrl = safeLink(observation.release.url, repository);
  return <div className="si-metadata">
    <p>Remote observation: {timestamp(observation.observedAtMs)}</p>
    <dl><dt>Review</dt><dd>{review}{reviewUrl && <> · <a href={reviewUrl} target="_blank" rel="noopener noreferrer">Open PR</a></>}
      {observation.review.submittedCommitChanged === true && <p>The PR head changed after submission.</p>}</dd>
      <dt>Repository</dt><dd>{content}{observation.repository.commit && <><br/><code>{observation.repository.commit}</code></>}{contentUrl && <> · <a href={contentUrl} target="_blank" rel="noopener noreferrer">Inspect merge commit</a></>}</dd>
      <dt>Release</dt><dd>{release}{observation.release.tag && <> · Tag: {observation.release.tag}</>}{observation.release.prerelease === true && <> · Prerelease</>}
        {observation.release.commit && <><br/><code>{observation.release.commit}</code></>}{releaseUrl && <> · <a href={releaseUrl} target="_blank" rel="noopener noreferrer">Open release</a></>}</dd>
    </dl>
    {observation.issues.length > 0 && <p className="si-action-error">Some states could not be confirmed at this check. Past confirmations remain in recorded history.</p>}
    <details><summary>Observed package identity</summary><dl><dt>Revision</dt><dd>{observation.revision}</dd><dt>Bundle SHA-256</dt><dd><code>{observation.bundleSha256}</code></dd></dl></details>
  </div>;
}
function PublicationRecord({ api, publication }: { api: PublicationApi; publication: PublicationSummary }) {
  const heading = useId(), historyId = useId();
  const [checked, setChecked] = useState<PublicationObservation | null>(null), [tag, setTag] = useState(publication.latest?.releaseTag ?? "");
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false), [history, setHistory] = useState<PublicationObservation[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState("");
  const generation = useRef(0), inFlight = useRef(false), historySequence = useRef(0);
  const historyRef = useRef<PublicationObservation[]>([]);
  useEffect(() => {
    generation.current++; inFlight.current = false; setChecking(false); setHistoryBusy(false);
    return () => { generation.current++; historySequence.current++; };
  }, [api]);
  const saved = publication.latest && matching(publication.latest, publication) ? publication.latest : null;
  const latest = checked && (!saved || checked.sequence > saved.sequence) ? checked : saved;
  const submissionUrl = safeLink(publication.url, publication.repository);
  const validTag = tag.length <= 200 && !/[\x00-\x20\x7f]/.test(tag);
  const retain = (values: PublicationObservation[]) => {
    historyRef.current = mergeHistory(historyRef.current, values); setHistory(historyRef.current);
  };
  const loadHistory = async () => {
    const current = generation.current, request = ++historySequence.current;
    setHistoryBusy(true); setHistoryError("");
    try {
      const result = await api.publicationHistory({ publicationId: publication.id });
      if (generation.current !== current || historySequence.current !== request) return;
      if (result.observations.some(item => !matching(item, publication))) throw new Error("Recorded history does not match this publication.");
      retain(result.observations);
    } catch (cause) { if (generation.current === current && historySequence.current === request) setHistoryError(errorText(cause)); }
    finally { if (generation.current === current && historySequence.current === request) setHistoryBusy(false); }
  };
  const check = async () => {
    if (inFlight.current || !validTag) return;
    const current = generation.current; inFlight.current = true; setChecking(true); setCheckError("");
    try {
      const result = await api.reconcilePublication({ publicationId: publication.id, ...(tag ? { releaseTag: tag } : {}) });
      if (generation.current !== current) return;
      if (!matching(result, publication)) throw new Error("The response does not match this publication. Refresh saved records.");
      setChecked(previous => !previous || result.sequence > previous.sequence ? result : previous);
      retain([...(latest ? [latest] : []), result]);
      if (historyOpen) void loadHistory();
    } catch (cause) { if (generation.current === current) setCheckError(errorText(cause)); }
    finally { if (generation.current === current) { inFlight.current = false; setChecking(false); } }
  };
  return <article className="si-trend" aria-labelledby={heading}>
    <h4 id={heading}>{publication.repository} / {publication.directory}</h4>
    <p>Solution: {publication.solutionId} · Revision: {publication.revision}</p>
    <p>Submission: {publication.submission === "submitted-for-review" ? "Submitted for review" : "Preparing submission"}{submissionUrl && <> · <a href={submissionUrl} target="_blank" rel="noopener noreferrer">Open submitted PR</a></>}</p>
    {latest ? <Observation observation={latest} repository={publication.repository}/> : <p>No remote observation recorded. Review, repository content and release are unconfirmed.</p>}
    <div className="si-form-row"><label>Release tag (optional)<input value={tag} maxLength={200} disabled={checking} aria-invalid={!validTag} onChange={event => setTag(event.target.value)} placeholder="v1.0.0"/></label></div>
    {!validTag && <p role="alert" className="si-action-error">Use a release tag of at most 200 characters without spaces or control characters.</p>}
    <div className="si-form-actions"><button type="button" className="si-button" disabled={checking || !validTag} onClick={() => void check()}>{checking ? "Checking publication…" : "Check publication"}</button>
      <button type="button" className="si-button si-button-quiet" aria-expanded={historyOpen} aria-controls={historyId} onClick={() => { if (!historyOpen) void loadHistory(); setHistoryOpen(value => !value); }}>{historyOpen ? "Hide recorded history" : "Show recorded history"}</button></div>
    {checkError && <p role="alert" className="si-action-error">{checkError} Previous observations are retained.</p>}
    {historyOpen && <section id={historyId} aria-label="Recorded publication history">
      <h4>Recorded history</h4><p className="si-section-note">Past observations describe their recorded commit and time; they do not confirm the current remote state.</p>
      <button type="button" className="si-button" disabled={historyBusy} onClick={() => void loadHistory()}>Refresh recorded history</button>
      {historyBusy && <p role="status">Loading recorded history…</p>}
      {historyError && <p role="alert" className="si-action-error">{historyError} Previous observations are retained.</p>}
      {history?.length === 0 && !historyBusy && <p>No recorded remote observations.</p>}
      {history?.map(item => <details key={item.id}><summary>Check {item.sequence} · {timestamp(item.observedAtMs)}</summary><Observation observation={item} repository={publication.repository}/></details>)}
    </section>}
  </article>;
}
