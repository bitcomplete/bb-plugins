import { useState } from "react";
import type { DashboardApi, DashboardData } from "./types.js";

const ERRORS: Record<string, string> = { "invalid-model-json": "the model's answer couldn't be read", "configure-bb-provider-model-project-environment": "Execution isn't set up" };
/** One line saying whether a search is running, or how the last one ended. */
export function searchStatus(setup: NonNullable<DashboardData["setup"]>, now = Date.now()): string | null {
  if (setup.minerQueued) return "Looking for problems in your recent threads…";
  const last = setup.lastSearch; if (!last) return null;
  const minutes = Math.max(0, Math.round((now - last.endedAtMs) / 60000));
  const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : new Date(last.endedAtMs).toLocaleString();
  if (last.status === "failed") return `Last search failed ${when}: ${last.error ? ERRORS[last.error] ?? last.error : "unknown error"}. Try again.`;
  const found = last.problems ? `found ${last.problems} new ${last.problems === 1 ? "problem" : "problems"}` : last.votes ? `found ${last.votes} more ${last.votes === 1 ? "sign" : "signs"} of known problems` : "found nothing new";
  return `Last search ${when}: looked at ${last.sessions} ${last.sessions === 1 ? "conversation" : "conversations"} and ${found}.`;
}

type Step = { done: boolean; title: string; detail: string; optional?: boolean; action?: React.ReactNode };

/**
 * A short checklist of what Self improve needs, shown prominently until the required steps are done and then folded
 * into a quiet "Find problems" control.
 */
export function SetupGuide({ data, api, onQueued, settings }: { data: DashboardData; api: DashboardApi; onQueued: () => void; settings?: React.ReactNode }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const setup = data.setup;
  if (!setup || !api.findProblems) return null;
  const find = async () => {
    setBusy(true); setMessage("");
    try { await api.findProblems!({}); setMessage(""); onQueued(); }
    catch (e) { setMessage(e instanceof Error ? e.message.slice(0, 300) : "Could not start looking for problems."); }
    finally { setBusy(false); }
  };
  const ready = setup.worker && setup.model, searching = busy || setup.minerQueued;
  const findButton = (primary: boolean) => <button className={`si-button${primary ? " si-button-primary" : ""}`} disabled={!ready || searching} onClick={() => void find()}>{searching ? "Looking for problems…" : "Find problems now"}</button>;
  const steps: Step[] = [
    { done: setup.worker, title: "Choose where agent work runs", detail: "Under Execution below, pick a project and environment. A scratch environment is safest." },
    { done: setup.model, title: "Choose a provider and model", detail: "Also under Execution. Agent work uses your existing BB sign-in." },
    { done: setup.mined, title: "Find problems", detail: "Looks through the last two days of your BB threads for failures and corrections worth learning from.", action: findButton(true) },
    { done: setup.scheduled, optional: true, title: "Keep looking automatically", detail: "Turn on “Run scheduled improvements” in Settings → Plugins → Self improve to look every 15 minutes and run research and ranking daily." },
    { done: setup.testCases, optional: true, title: "Add development test cases", detail: "Builds need test cases (the evaluationSuite setting) to try candidate fixes." },
  ];
  const required = steps.filter(s => !s.optional), status = message || searchStatus(setup);
  if (required.every(s => s.done)) {
    return <div className="si-setup-quiet">{status && <span role="status">{status}</span>}{findButton(false)}</div>;
  }
  return <section className="si-setup" aria-label="Get started with Self improve">
    <h2>Get started</h2>
    <ol>{steps.map(s => <li key={s.title} className={s.done ? "si-setup-done" : undefined}>
      <span aria-hidden="true">{s.done ? "✓" : "○"}</span>
      <div><strong>{s.title}{s.optional ? " (optional)" : ""}</strong><p>{s.detail}</p>{!s.done && s.action}</div>
    </li>)}</ol>
    {!ready && settings && <div className="si-setup-settings">{settings}</div>}
    {status && <p role="status">{status}</p>}
  </section>;
}
