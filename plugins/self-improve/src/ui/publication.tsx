import { useEffect, useRef, useState } from "react";
import type { DashboardApi, ExportArtifact } from "./types.js";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
function safeDirectory(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.toLowerCase().endsWith(".lock"));
}
function reviewLink(value: string, repository: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    const prefix = `/${repository}/pull/`;
    return url.pathname.toLowerCase().startsWith(prefix.toLowerCase()) && /^[1-9]\d*$/.test(url.pathname.slice(prefix.length)) ? url.href : null;
  } catch { return null; }
}

/** The owner action binds review to the shown artifact digest and exact destination. */
export function Publication({ api, artifact, repositories, initialDirectory }: {
  api: DashboardApi; artifact: ExportArtifact; repositories: string[]; initialDirectory: string;
}) {
  const allowed = [...new Set(repositories.filter(repository => repositoryPattern.test(repository)))];
  const [repository, setRepository] = useState(allowed[0] ?? "");
  const [directory, setDirectory] = useState(initialDirectory), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<{ url: string; repository: string } | null>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowedKey = allowed.join("\n");
  useEffect(() => {
    const next = allowedKey.split("\n").filter(Boolean);
    if (!busy && !submitted && !next.includes(repository)) { setRepository(next[0] ?? ""); setReviewed(false); }
  }, [allowedKey, repository, busy, submitted]);
  const validDirectory = safeDirectory(directory);
  const validBundle = /^[a-f0-9]{64}$/.test(artifact.bundleSha256);
  const canSubmit = reviewed && allowed.includes(repository) && validDirectory && validBundle && !busy && !submitted;
  const url = submitted ? reviewLink(submitted.url, submitted.repository) : null;
  return <section className="si-publication" aria-label="Submit export for review">
    <h4>Share it for review</h4>
    <p>Create a draft pull request in an allowed GitHub repository. The destination must be a new directory; existing files are never overwritten.</p>
    {!allowed.length ? <p className="si-muted">Configure an allowed publication repository in Self improve settings to create a draft PR here. You can still download the bundle.</p> : <>
      <div className="si-form-row"><label>Repository<select value={repository} disabled={busy || !!submitted} onChange={event => { setRepository(event.target.value); setReviewed(false); setError(""); }}>{allowed.map(value => <option value={value} key={value}>{value}</option>)}</select></label><label>New directory<input value={directory} maxLength={200} disabled={busy || !!submitted} onChange={event => { setDirectory(event.target.value); setReviewed(false); setError(""); }} placeholder="plugins/my-improvement" aria-invalid={!validDirectory}/></label></div>
      {!validDirectory && <p className="si-action-error">Use a relative directory with letters, numbers, dots, underscores or hyphens in each segment. Parent traversal, hidden segments and .lock suffixes are not allowed.</p>}
      <p className="si-section-note">Review the complete files above, including EVIDENCE.md. The draft PR is a review submission. Release, marketplace listing and installation are separate steps.</p>
      <details className="si-bundle-digest"><summary>Bundle fingerprint</summary><code>{artifact.bundleSha256}</code></details>
      {!validBundle && <p className="si-action-error" role="alert">The bundle fingerprint is missing or invalid. Export the solution again before submitting for review.</p>}
      <label className="si-checkbox"><input type="checkbox" checked={reviewed} disabled={busy || !!submitted} onChange={event => setReviewed(event.target.checked)}/>I reviewed these files, evidence and destination.</label>
      <button className="si-button si-button-primary" disabled={!canSubmit} onClick={async () => {
        if (!canSubmit || inFlight.current) return;
        inFlight.current = true; setBusy(true); setError("");
        const targetRepository = repository;
        try {
          const result = await api.publishExport({ artifactId: artifact.artifactId, repository: targetRepository, directory, bundleSha256: artifact.bundleSha256, reviewed: true });
          if (mounted.current) setSubmitted({ url: result.url, repository: targetRepository });
        } catch (e) { if (mounted.current) { setError(e instanceof Error ? e.message.slice(0, 500) : "The draft PR could not be created."); setReviewed(false); } }
        finally { inFlight.current = false; if (mounted.current) setBusy(false); }
      }}>{busy ? "Creating draft PR…" : submitted ? "Submitted for review" : "Create draft PR"}</button>
      {error && <p className="si-action-error" role="alert">{error}</p>}
    </>}
      {submitted && <div className="si-publication-result" role="status">{url ? <><p>Submitted for review as a draft PR. This does not confirm a release, marketplace listing or activation.</p><a className="si-button" href={url} target="_blank" rel="noopener noreferrer">Open draft PR</a></> : <p>The server reported a created PR, but its review link could not be verified. Check the selected repository before retrying.</p>}</div>}
  </section>;
}
