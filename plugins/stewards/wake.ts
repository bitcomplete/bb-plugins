// The messages stewards send: a binding's wake in its fixed five-part form,
// and the project steward's. Pure: everything is handed in.
//
// Each wake is self-contained. A steward that has compacted away everything
// it ever saw can act correctly from one wake alone, which is what lets its
// transcript stop being the source of truth.
import { formatDuration, phaseInstructions, type Playbook } from "./config.js";
import { newHumanComments, reportedItem, type GateState } from "./reconcile.js";
import type { EntitySnapshot, SnapshotComment } from "./source-contract.js";
import type { Binding, Escalation, Observed, Worker } from "./store.js";

/** A wake longer than this is cut in its snapshot, never in what changed or what to do. */
export const WAKE_MAX_CHARS = 30_000;
const DESCRIPTION_CHARS = 4000;
const COMMENT_CHARS = 1500;
const RESULT_CHARS = 1500;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);
const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");

/**
 * Join a message's three parts within WAKE_MAX_CHARS, cutting the middle
 * (the snapshot, the list of bindings) and keeping the head and the tail: the
 * tail says what changed and what to do, which a cut wake must not lose.
 */
function fit(head: string[], middle: string[], tail: string[]): string {
  const h = head.join("\n");
  const t = tail.join("\n");
  const room = WAKE_MAX_CHARS - h.length - t.length - 200;
  const m = middle.join("\n");
  if (room <= 0) return clip([h, t].join("\n"), WAKE_MAX_CHARS);
  return [h, clip(m, room), t].join("\n");
}

/** Why this wake: an ordinary reconcile, or a lifecycle turn with its own instructions. */
export type WakeReason = "adopted" | "changed" | "requeue" | "nightly" | "terminal" | "detach" | "reopen";

const LIFECYCLE_INSTRUCTIONS: Partial<Record<WakeReason, string>> = {
  terminal:
    "The entity has reached a terminal state. This is your wrap-up turn: post a final signed comment if one is useful, start no workers, and end with steward_report. The binding and its workers are archived after this turn.",
  detach:
    "The label was removed, so this binding is detached. Take no new actions on the entity and start no workers; running workers have been stopped. End with steward_report, saying the work is done here. Adding the label back brings this thread back.",
  reopen: "The entity came back from a terminal or detached state and this binding has resumed. Re-read everything below as if new.",
  adopted: "You have just been bound to this entity. Read everything below, then act on the phase's instructions.",
  nightly: "This is the nightly reconcile pass: nothing may have changed. Check for drift the event path missed, and report.",
};

export type ChildView = { binding: Binding; openEscalations: Escalation[] };

export type WakeInput = {
  reason: WakeReason;
  binding: Binding;
  playbook: Playbook;
  observed: Observed;
  gate: GateState;
  /** Escalations on this binding, and those routed to it from children. */
  escalations: Escalation[];
  routedToMe: Array<{ escalation: Escalation; from: Binding }>;
  workers: Worker[];
  children: ChildView[];
  /** The worker model, as `bb thread spawn` flags. */
  workerFlags: string;
  changes: string[];
  /** The steward's thread and its workers': their comments are not news. */
  own: ReadonlySet<string>;
  /** The project's adoption label. */
  label: string;
  now: number;
};

function commentLines(comments: SnapshotComment[]): string[] {
  const lines: string[] = [];
  for (const c of comments) {
    lines.push(`**${c.author}** ${c.did} — ${c.createdAt}${c.url === null ? "" : ` (${c.url})`}${c.signedBy === null ? "" : ` [signed by thread ${c.signedBy}]`}`);
    const body = clip(c.body.trim(), COMMENT_CHARS);
    lines.push(body === "" ? "> (empty)" : quote(body), "");
  }
  return lines;
}

function entityLines(e: EntitySnapshot, cursor: string, own: ReadonlySet<string>, heading: string): string[] {
  const lines = [`### ${heading}`, ""];
  lines.push(`- ${e.key}: ${e.title ?? "(untitled)"}${e.url === null ? "" : ` — ${e.url}`}`);
  lines.push(`- State: ${e.state}${e.stateType === null ? "" : ` (${e.stateType})`}`);
  lines.push(`- Labels: ${e.labels.join(", ") || "(none)"}; assignees: ${e.assignees.join(", ") || "(none)"}${e.author === null ? "" : `; author: ${e.author}`}`);
  if (e.priority !== null || e.estimate !== null) lines.push(`- Priority: ${e.priority ?? "(none)"}; estimate: ${e.estimate ?? "(none)"}`);
  if (e.parent !== null) lines.push(`- Parent: ${e.parent.key}`);
  if (e.pull !== null) {
    const p = e.pull;
    lines.push(`- Branch: ${p.head ?? "?"} → ${p.base ?? "?"} at ${p.headSha?.slice(0, 7) ?? "?"}${p.headAuthor === null ? "" : ` (by ${p.headAuthor})`}`);
    lines.push(`- Checks: ${p.checks === null ? "none" : `${p.checks.state}${p.checks.failing.length > 0 ? ` — failing: ${p.checks.failing.join(", ")}` : ""}`}`);
    lines.push(`- Review decision: ${p.reviewDecision ?? "(none)"}; requested: ${p.requestedReviewers.join(", ") || "(none)"}`);
    const latest = new Map<string, string>();
    for (const r of p.reviews) latest.set(r.author, `${r.state}${r.commit === null ? "" : ` at ${r.commit.slice(0, 7)}`}`);
    if (latest.size > 0) lines.push(`- Latest reviews: ${[...latest].map(([a, s]) => `${a} ${s}`).join("; ")}`);
  }
  if (e.children.length > 0) lines.push(`- Sub-issues: ${e.children.map((c) => `${c.key} (${c.state ?? "?"}${c.labels.length > 0 ? `; ${c.labels.join(", ")}` : ""})`).join(", ")}`);
  if (e.linkedPulls.length > 0) lines.push(`- Linked pull requests: ${e.linkedPulls.map((l) => l.key ?? l.url).join(", ")}`);
  if (e.description !== null && e.description.trim() !== "") lines.push("", "Description:", "", quote(clip(e.description.trim(), DESCRIPTION_CHARS)));
  const fresh = newHumanComments(e, cursor, own);
  if (fresh.length > 0) lines.push("", `Comments from others since your last turn (${fresh.length}):`, "", ...commentLines(fresh));
  return lines;
}

function gateLines(input: WakeInput): string[] {
  const { gate, binding, playbook } = input;
  if (gate.none) return ["No ready gate in this playbook."];
  const lines: string[] = [];
  playbook.ready!.checklist.forEach((item, i) => {
    const c = reportedItem(binding.ready, item);
    lines.push(`- [${c?.met ? "x" : " "}] ${i + 1}. ${item}${c?.note ? ` — ${c.note}` : ""}`);
  });
  lines.push("  Report each item in steward_report's ready.checklist by its number: { item: 1, met: true, note }.");
  lines.push(`- Substantial: ${gate.substantial === null ? "not judged yet (treated as yes)" : gate.substantial ? "yes" : "no"}${binding.ready.why ? ` — ${binding.ready.why}` : ""}`);
  lines.push(`  Substantial when any of: ${playbook.ready!.substantial.join("; ") || "(none listed)"}`);
  const approval = playbook.ready!.approval;
  const how = approval === "me" ? "the user" : approval === "project" ? "the project steward" : `the ticket reaching ${approval["linear-state"]}`;
  if (!gate.approvalNeeded) lines.push("- Approval: not needed");
  else if (!gate.approved) lines.push(`- Approval: not given (given by ${how})${binding.ready.voidedAt === null ? "" : `; the last one was voided ${iso(binding.ready.voidedAt)}`}`);
  else lines.push(`- Approval: given ${iso(binding.ready.approval!.at)}${gate.approvalStale ? " — the spec has changed since. Judge whether the change is material; if so void it (steward_report voidApproval) and ask again." : ""}`);
  lines.push(`- Gate: ${gate.passed ? "PASSED" : "not passed — start no implementation workers"}`);
  return lines;
}

/** One wake, in the fixed form: instructions, ready gate, steering, snapshot, changes. */
export function formatWake(input: WakeInput): string {
  const { binding, playbook, observed } = input;
  const e = observed.entity;
  const out: string[] = [];
  out.push(`# Steward wake: ${e.key} — ${e.title ?? "(untitled)"}`);
  out.push(`Binding ${binding.id} · ${binding.kind} · playbook ${playbook.name}@${playbook.version} · phase ${binding.phase ?? e.state}${binding.stage === null ? "" : ` (stage ${binding.stage})`}`);
  // Stewards share the project steward's workspace, whose path names that
  // thread; a steward that read its id from there signed as the project steward.
  out.push(
    "",
    `${binding.threadId === null ? "Your thread id is in `$BB_THREAD_ID`." : `Your thread id is ${binding.threadId}.`} Use it wherever you name yourself (a worker's task, a gh signature), and never take one from your workspace's path: you share the project steward's workspace, and its path names that thread.`,
  );
  const special = LIFECYCLE_INSTRUCTIONS[input.reason];
  if (special !== undefined) out.push("", `**${special}**`);

  out.push("", "## 1. Instructions");
  if (playbook.general !== "") out.push("", playbook.general);
  const section = phaseInstructions(playbook, binding.phase ?? e.state);
  out.push("", section === null ? `(The playbook has no section for ${JSON.stringify(binding.phase ?? e.state)}; use the general instructions and escalate a decision if unsure.)` : `### ${binding.phase ?? e.state}\n\n${section}`);
  if (binding.kind === "ticket" && playbook.promote !== null) out.push("", `Promote a sub-issue (add the label \`${input.label}\`) when: ${playbook.promote}`);
  out.push("", `Allowed actions: ${playbook.may.join(", ") || "(none)"}.`);
  out.push(
    "",
    "Start a worker for one bounded task with:",
    "",
    `    bb thread spawn --project ${binding.projectId} --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --visibility hidden ${input.workerFlags} --title "${e.key}: <task>" --prompt-file - <<'EOF'`,
    "    <the whole task>",
    "    EOF",
    "",
    "Follow it up with `bb thread tell <id> <message>`. You are woken when a worker finishes, with its final message.",
  );

  out.push("", "## 2. Ready gate", "", ...gateLines(input));

  out.push("", "## 3. Guidance, priority and holds", "");
  if (binding.guidance.length === 0) out.push("No standing guidance.");
  for (const g of binding.guidance) out.push(`- ${iso(g.at)} (${g.by}): ${g.text}`);
  out.push(`- Priority: ${binding.priority ?? "normal"}`);
  out.push(binding.hold === null ? "- Hold: none" : `- **HOLD: ${binding.hold}** — take no new actions and start no workers until it is lifted.`);

  const head = out.splice(0);
  out.push("", "## 4. Snapshot", "");
  out.push(...entityLines(e, binding.commentCursor, input.own, "The entity"));
  for (const pull of observed.pulls) out.push("", ...entityLines(pull, binding.commentCursor, input.own, `Linked pull request ${pull.key}`));
  if (input.workers.length > 0) {
    out.push("", "### Workers", "");
    for (const w of input.workers) {
      out.push(`- ${w.title} (thread ${w.threadId}): ${w.status}${w.endedAt === null ? ` since ${iso(w.startedAt)}` : ` at ${iso(w.endedAt)}`}`);
      if (w.result !== null && w.result.trim() !== "") out.push(quote(clip(w.result.trim(), RESULT_CHARS)));
    }
  }
  if (input.children.length > 0) {
    out.push("", "### Child stewards", "");
    for (const c of input.children) {
      const s = c.binding.status;
      out.push(`- ${c.binding.entityKey} (${c.binding.kind}, thread ${c.binding.threadId ?? "?"}): ${c.binding.phase ?? "?"} — ${s === null ? "no report yet" : `${s.summary} Next: ${s.nextAction} (${s.actor})`}${c.openEscalations.length > 0 ? ` — ${c.openEscalations.length} open escalation(s)` : ""}`);
    }
  }
  const open = input.escalations.filter((x) => x.status === "open");
  if (open.length > 0 || input.routedToMe.length > 0) {
    out.push("", "### Open escalations", "");
    for (const x of open) out.push(`- ${x.id} (${x.kind}, with ${x.route === "me" ? "the user" : x.route === "parent" ? "your parent steward" : "the project steward"}): ${x.question} Meanwhile: ${x.meanwhile}${x.recommendation === null ? "" : ` Recommendation: ${x.recommendation}`}`);
    for (const { escalation: x, from } of input.routedToMe) {
      out.push(`- ${x.id} from ${from.entityKey} (${x.kind}) — routed to you: ${x.question} Meanwhile: ${x.meanwhile}${x.recommendation === null ? "" : ` Recommendation: ${x.recommendation}`}`);
      out.push("  Decide it with steward_update { binding, guidance, resolve }, or pass it up with steward_update { binding, forward, recommendation }.");
    }
  }

  const snapshot = out.splice(0);
  out.push("", "## 5. What changed since your last turn", "");
  if (input.changes.length === 0) out.push("Nothing actionable; this is a scheduled look.");
  for (const c of input.changes) out.push(`- ${c}`);

  out.push(
    "",
    "---",
    `Before acting, look for evidence that you already did it (a signed comment, a worker, an open pull request, a review). End your turn with steward_report; requeueAfter defaults to ${formatDuration(playbook.requeueDefaultMs)}.`,
  );
  return fit(head, snapshot, out);
}

/** What the project steward is woken with, at the end of a nightly pass or when an escalation reaches it. */
export function formatProjectWake(input: {
  reason: string;
  bindings: Array<{ binding: Binding; openEscalations: Escalation[] }>;
  routed: Array<{ escalation: Escalation; from: Binding }>;
  problems: string[];
  digestDue: boolean;
  notes: string[];
  bigDecisions: string[];
}): string {
  const out: string[] = [`# Project steward: ${input.reason}`, ""];
  if (input.notes.length > 0) out.push(...input.notes.map((n) => `- ${n}`), "");
  if (input.problems.length > 0) out.push("## Configuration problems", "", ...input.problems.map((p) => `- ${p}`), "");
  if (input.routed.length > 0) {
    out.push("## Escalations routed to you", "");
    for (const { escalation: x, from } of input.routed) {
      out.push(`- ${x.id} from ${from.entityKey} (${x.kind}): ${x.question} Meanwhile: ${x.meanwhile}${x.recommendation === null ? "" : ` Recommendation: ${x.recommendation}`}`);
    }
    out.push(
      "",
      "Decide each from the project's guidance (AGENTS.md, architecture and design docs) with steward_update { binding, guidance, resolve }. Forward one to the user (steward_update { binding, forward, recommendation }) only when it is one of these big decisions:",
      "",
      ...input.bigDecisions.map((d) => `- ${d}`),
      "",
    );
  }
  const head = out.splice(0);
  out.push(`## Bindings (${input.bindings.length} open)`, "");
  for (const { binding: b, openEscalations } of input.bindings.slice(0, 200)) {
    const s = b.status;
    const flags = [b.priority === null ? null : `priority ${b.priority}`, b.hold === null ? null : `HOLD: ${b.hold}`, openEscalations.length > 0 ? `${openEscalations.length} escalation(s): ${openEscalations.map((x) => `${x.kind}→${x.route}`).join(", ")}` : null].filter((f): f is string => f !== null);
    out.push(`- ${b.entityKey} (${b.kind}, ${b.phase ?? "?"}): ${s === null ? "no report yet" : `${s.summary} Next: ${s.nextAction} (${s.actor})${s.blockedOn === null ? "" : `; blocked on ${s.blockedOn}`}`}${flags.length > 0 ? ` [${flags.join("; ")}]` : ""}`);
  }
  const bindings = out.splice(0);
  if (input.digestDue) {
    out.push(
      "",
      "Adjust priority and holds with steward_update first if they need it. Then reply with the morning digest, and nothing else: what moved overnight, what is waiting on the user, what is stuck, and today's priorities. Your reply is saved as the digest.",
    );
  }
  return fit(head, bindings, out);
}

export const PROJECT_STEWARD_INTRO = `You are this project's steward. Every Linear ticket and GitHub pull request in this project that is being managed has its own steward thread; you sit above them all.

- You decide what the stewards below you cannot, from the project's own guidance: AGENTS.md, architecture and design docs. Only the project's big decisions go to the user.
- You read status records, never transcripts: \`bb stewards list\` and \`bb stewards show <key>\`.
- steward_update sets guidance, priority, holds and models on any binding, approves a substantial ticket's spec, and resolves or forwards escalations.
- You are woken by escalations, at the end of each nightly pass to write the morning digest, and by the user. When the user says something like "hold everything touching billing", turn it into steward_update calls on the bindings it concerns, and say what you changed.
- Budget is advisory: keep the total work sensible through priority and holds.

Wait for the user or a wake; there is nothing to do right now.`;
