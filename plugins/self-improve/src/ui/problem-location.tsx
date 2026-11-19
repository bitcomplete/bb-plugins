import { useState } from "react";
import type { Problem } from "../domain/types.js";
import type { DashboardApi } from "./types.js";

const LABELS: Record<NonNullable<Problem["location"]>["kind"], string> = {
  agent: "How the agent worked", plugin: "A plugin", skill: "A skill", bb: "BB itself", configuration: "A setting or configuration", unknown: "Not yet known",
};

/** Where the cause seems to be. Outside the agent, Self improve can only work around it, so it offers a report to send. */
export function ProblemLocationSection({ api, problem }: { api: DashboardApi; problem: Problem }) {
  const [report, setReport] = useState<{ title: string; body: string; issueUrl: string | null } | null>(null), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  const location = problem.location;
  if (!location) return null;
  const outside = location.kind !== "agent" && location.kind !== "unknown";
  const load = async () => { setError(""); try { setReport(await api.problemReport!({ problemId: problem.id })); } catch (e) { setError(e instanceof Error ? e.message.slice(0, 300) : "The report couldn't be built."); } };
  return <section className="si-location"><h3>Where the cause seems to be</h3>
    <p><strong>{LABELS[location.kind]}{location.name ? `: ${location.name}` : ""}</strong></p>
    {outside && <p className="si-section-note">Self improve only changes the instructions it adds to agent turns, so it can work around this but not fix it. Send the report to whoever maintains it.</p>}
    {outside && api.problemReport && !report && <button className="si-button" onClick={() => void load()}>Write a report</button>}
    {report && <div className="si-report">
      <pre>{`${report.title}\n\n${report.body}`}</pre>
      <div className="si-form-actions">
        <button className="si-button" onClick={() => { void navigator.clipboard?.writeText(`${report.title}\n\n${report.body}`).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy report"}</button>
        {report.issueUrl && <a className="si-button" href={report.issueUrl} target="_blank" rel="noreferrer">Open an issue</a>}
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
