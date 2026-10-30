import type { LiveItems } from "./deck-flow";
import type { CardScreen, Tone } from "./deck-view-model";

export type StatusLabel = { text: string; tone: Tone };
export type PrStatus = {
  prUrl: string; repo: string; number: number; title: string; ref: string;
  status: StatusLabel; action: StatusLabel | null; detail: string | null;
  held: boolean; advance: "available" | "queued" | "sending" | null;
  thread: { id: string; title: string; status: StatusLabel } | null;
};

const ACTION: Record<string, string> = { nudge: "Nudge", request: "Request review", ready: "Mark ready", address: "Address feedback",
  ask: "Ask thread", fix: "Fix", release: "Release hold", confirm: "Confirm notes" };
const STATE: Record<string, StatusLabel> = { pending: { text: "Queued", tone: "blue" }, queued: { text: "Queued", tone: "blue" },
  sending: { text: "Sending", tone: "blue" }, sent: { text: "Sent", tone: "green" }, refused: { text: "Not sent", tone: "red" },
  unknown: { text: "Result unknown", tone: "red" } };
const ADVANCE = new Set(["nudge", "request", "ready"]);

/** The thread's actual state, with a pending interaction taking priority over its active/idle word. */
export function threadStatus(thread: { status: string; waiting?: boolean }): StatusLabel {
  if (thread.waiting || thread.status === "needs-you") return { text: "Needs you", tone: "amber" };
  switch (thread.status) {
    case "active": return { text: "Working", tone: "blue" };
    case "error": case "failed": return { text: "Failed", tone: "red" };
    case "idle": return { text: "Idle", tone: "gray" };
    case "starting": case "queued": return { text: "Starting", tone: "blue" };
    default: return { text: thread.status.charAt(0).toUpperCase() + thread.status.slice(1), tone: "gray" };
  }
}

/** Every open PR, including held ones. Advance availability is derived from the exact scope its button plans. */
export function prStatuses(screen: CardScreen, live?: LiveItems): PrStatus[] {
  const available = new Set(screen.chores.prUrls);
  const threads = new Map(screen.threads.map((thread) => [thread.id, thread]));
  return screen.lines.flatMap((line): PrStatus[] => {
    const row = line.row;
    if (!row || line.ghost) return [];
    const held = !!row.hold || row.section === "held" || screen.card.pile === "held";
    const current = live?.get(row.prUrl);
    const acted = current ?? row.acted;
    const pending = acted && ["pending", "queued", "sending"].includes(acted.state);
    let action: StatusLabel | null = null;
    let advance: PrStatus["advance"] = !held && available.has(row.prUrl) && !pending
      && (!current || current.state === "refused" || current.state === "unknown") ? "available" : null;
    if (acted && (current || pending || line.dim || ["refused", "unknown"].includes(acted.state))) {
      const state = STATE[acted.state];
      if (state) action = { text: `${ACTION[acted.kind] ?? acted.kind} · ${state.text}`, tone: state.tone };
      if (pending && ADVANCE.has(acted.kind)) advance = acted.state === "sending" ? "sending" : "queued";
    } else if (!held && available.has(row.prUrl)) {
      advance = "available";
      const verb = row.section === "nudge" ? `Nudge ${row.nudge.map((login) => `@${login}`).join(", ")}`
        : row.section === "request" ? `Request ${row.suggested[0] ? `@${row.suggested[0]}` : "review"}` : "Mark ready";
      action = { text: `Advance: ${verb}`, tone: "blue" };
    }
    const link = row.addressing?.threadId ? { id: row.addressing.threadId, title: row.addressing.title ?? "Feedback thread" } : row.sent?.threadId ? { id: row.sent.threadId, title: row.sent.title ?? "Feedback thread" } : row.thread;
    const linked = link ? threads.get(link.id) : null;
    const sentState = row.sent?.state;
    const status = held ? { text: "Held", tone: "gray" as const } : { text: row.status,
      tone: row.failed ? "red" as const : row.turn.list === "turn" ? "amber" as const : row.section === "merge" ? "green" as const
        : row.section === "work" ? "red" as const : "gray" as const };
    const detail = held ? row.hold?.reason || screen.card.reason || "Waiting for release"
      : row.waitsOn ? `${row.waitsOn.on} · ${row.waitsOn.what}` : row.step?.text ?? null;
    return [{ prUrl: row.prUrl, repo: row.repo.split("/").at(-1) ?? row.repo, number: row.number, ref: line.ref, title: row.title,
      status, action, detail, held, advance, thread: link ? { id: link.id, title: link.title,
        status: sentState === "needs-you" ? { text: "Needs you", tone: "amber" } : sentState === "failed" ? { text: "Failed", tone: "red" }
          : linked ? threadStatus(linked) : row.thread?.active ? { text: "Working", tone: "blue" } : sentState === "idle" ? { text: "Idle", tone: "gray" }
            : { text: "Status unavailable", tone: "gray" } } : null }];
  });
}

/** All the PRs a thread owns on this card, including a feedback batch's several PRs. */
export function threadRefs(screen: CardScreen, thread: CardScreen["threads"][number]): string {
  const refs = screen.lines.filter((line) => line.row && [line.row.thread?.id, line.row.sent?.threadId, line.row.addressing?.threadId].includes(thread.id))
    .map((line) => line.ref);
  return refs.length ? refs.join(" · ") : thread.ref;
}

/** One readable state per PR; queued/sending work and holds take precedence over eligibility. */
export function prReadState(pr: PrStatus): StatusLabel {
  if (pr.held) return pr.status;
  if (pr.action) return { ...pr.action, text: pr.advance === "available" ? `${pr.action.text.replace(/^Advance: /u, "")} · Available` : pr.action.text };
  return pr.status;
}

/** A short effort summary. Exact PR and worker identities live in the roster below it. */
export function effortReadSummary(screen: CardScreen, prs: readonly PrStatus[]): string {
  if (screen.card.pile === "held") return `On hold${screen.card.reason ? `: ${screen.card.reason}` : "."}`;
  const needs = screen.threads.filter((t) => threadStatus(t).text === "Needs you").length;
  const failed = screen.threads.filter((t) => threadStatus(t).text === "Failed").length;
  const ready = screen.lines.filter((l) => l.row && !l.ghost && l.section === "merge" && !l.dim && !l.row.waitsOn && l.row.stackedOn === null && !prs.find((p) => p.prUrl === l.prUrl)?.held).length;
  const parts = [needs ? `${needs} ${needs === 1 ? "thread needs" : "threads need"} your answer` : null,
    screen.yourTurn ? `${screen.yourTurn} ${screen.yourTurn === 1 ? "PR needs" : "PRs need"} your feedback response` : null,
    ready ? `${ready} ready to merge` : null, failed ? `${failed} ${failed === 1 ? "worker failed" : "workers failed"}` : null].filter(Boolean);
  if (parts.length) return parts.join(". ") + ".";
  const working = screen.threads.filter((t) => threadStatus(t).text === "Working").length;
  if (working) return `${working} ${working === 1 ? "worker is" : "workers are"} working.`;
  return prs.length ? `${prs.length} open ${prs.length === 1 ? "PR" : "PRs"}. ${screen.blocked.length ? "Waiting on dependencies or review." : "No feedback waiting on you."}` : screen.threads.length ? "No open PRs. Linked threads below." : "No open work.";
}


/** Cached thread facts only; activity is BB's last update, not another event-log fetch. */
export function threadReadSummary(screen: CardScreen): string {
  const counts = new Map<string, number>();
  for (const thread of screen.threads) {
    const label = threadStatus(thread).text;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${n} ${label === "Needs you" ? n === 1 ? "needs you" : "need you" : label.toLowerCase()}`);
  const latest = screen.card.threads.filter((t) => t.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!)[0];
  const last = latest && screen.threads.find((t) => t.id === latest.id)?.age;
  if (last) parts.push(`Last activity ${last} ago`);
  return parts.join(" · ");
}
