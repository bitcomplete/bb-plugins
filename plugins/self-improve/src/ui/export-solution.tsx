import { useEffect, useRef, useState } from "react";
import type { DashboardApi, ExportArtifact } from "./types.js";
import { Publication } from "./publication.js";

export function ExportSolution({ api, solutionId, expectedVersion, repositories = [] }: {
  api: DashboardApi; solutionId: string; expectedVersion?: number; repositories?: string[];
}) {
  const [format, setFormat] = useState<"skill" | "plugin">("skill");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [artifact, setArtifact] = useState<ExportArtifact | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!artifact || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }));
    setDownloadUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [artifact]);
  return <section className="si-export"><h3>Make the good ideas reusable</h3><p>Package this solution as a draft skill or plugin, with its evidence and provenance. Review the files before installing or submitting a draft PR for review.</p>
    <div className="si-export-actions"><label>Export format<select value={format} disabled={busy} onChange={e => { setFormat(e.target.value as "skill" | "plugin"); setArtifact(null); setDownloadUrl(""); }}><option value="skill">Skill</option><option value="plugin">Plugin</option></select></label><button className="si-button" disabled={busy || expectedVersion === undefined} onClick={async () => {
      if (inFlight.current || expectedVersion === undefined) return;
      inFlight.current = true; setBusy(true); setError(""); setArtifact(null); setDownloadUrl("");
      try { const result = await api.exportSolution({ solutionId, expectedVersion, format }); if (mounted.current) setArtifact(result); }
      catch (e) { if (mounted.current) setError(e instanceof Error ? e.message.slice(0, 500) : "The export could not be created."); }
      finally { inFlight.current = false; if (mounted.current) setBusy(false); }
    }}>{busy ? "Preparing draft…" : "Export solution"}</button></div>
    {expectedVersion === undefined && <p className="si-muted">Refresh to load a record version before exporting.</p>}
    {error && <p className="si-action-error" role="alert">{error}</p>}
    {artifact && <div className="si-artifact"><p role="status">Draft ready · {artifact.files.length} {artifact.files.length===1?"file":"files"}. Review the files before sharing or installing.</p>{downloadUrl && <a className="si-button" download={`self-improve-${format}-draft.json`} href={downloadUrl}>Download draft bundle (.json)</a>}<p className="si-section-note">The JSON bundle contains each file path and its full content. You can also inspect every file below.</p>{artifact.files.map((file, index) => <details key={`${file.path}:${index}`}><summary>{file.path}</summary><pre><code>{file.content}</code></pre></details>)}<Publication key={`${artifact.artifactId}:${artifact.bundleSha256}`} api={api} artifact={artifact} repositories={repositories} initialDirectory={`${format==="plugin"?"plugins":"skills"}/improvement-${solutionId.slice(-12).replace(/[^A-Za-z0-9_-]/g,"-")}`}/></div>}
  </section>;
}
