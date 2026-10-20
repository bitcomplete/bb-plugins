import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parsePlaybook } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { gateState } from "./reconcile.js";
import { MIGRATIONS, createStore } from "./store.js";
import { LINEAR_TICKETS } from "./templates.js";
import { formatProjectWake, formatWake, workerQuestion, type DigestRecords, type WakeInput } from "./wake.js";

const T = Date.parse("2026-10-18T05:00:00Z");
const DAY = 86_400_000;

function world() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const s = createStore(db, () => T);
  const bind = (key: string) => s.create({ projectId: "p1", source: "linear", entityId: key, entityKey: key, url: null, title: null, kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
  return { s, bind };
}

const status = (summary: string) => ({ phase: "In Progress", summary, nextAction: "Open the PR", actor: "steward" as const, blockedOn: null, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: T });

function wakeInput(over: Partial<WakeInput> = {}): WakeInput {
  const { s, bind } = world();
  const binding = over.binding ?? bind("ENG-12");
  const parsed = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!parsed.ok) throw new Error(parsed.error);
  const playbook = parsed.value;
  return {
    reason: "changed",
    binding,
    playbook,
    observed: { entity: issue(), pulls: [] },
    gate: gateState(playbook, binding.ready, ""),
    escalations: [],
    routedToMe: [],
    workers: [],
    workerQuestions: [],
    children: [],
    workerFlags: "--provider claude-code --model claude-opus-5-5 --reasoning-level high",
    changes: [],
    own: new Set(),
    label: "bb-managed",
    now: T,
    ...over,
  };
}

describe("a steward's wake", () => {
  it("carries the standing rules: credentials through bb secret request, one ask, and build-time decisions", () => {
    const wake = formatWake(wakeInput());
    expect(wake).toContain("bb secret request");
    expect(wake).toContain("the `secrets` skill");
    expect(wake).toContain("never paste a secret");
    expect(wake).toContain("One ask per reply");
    expect(wake).toContain("escalated as a `decision` in the same turn");
  });

  it("names the worker and reviewer models as flags that are not the steward's to choose", () => {
    const wake = formatWake(wakeInput());
    expect(wake).toContain("--provider claude-code --model claude-opus-5-5 --reasoning-level high");
    expect(wake).toContain("your workers' and reviewers' models");
    expect(wake).toContain("not yours to choose");
  });

  it("lists an open escalation and approval request as on the Stewards page, not to be asked again", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const decision = s.escalate({ bindingId: binding.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "me", recommendation: null });
    const approval = s.escalate({ bindingId: binding.id, kind: "approval", question: "Approve the spec?", meanwhile: "Waiting.", route: "me", recommendation: null });
    const wake = formatWake(wakeInput({ binding, escalations: [decision, approval] }));
    const note = "These are listed for the user on the Stewards page. Do not ask for them in your reply.";
    // Once under the open escalations, once with the approval request in the gate.
    expect(wake.split(note)).toHaveLength(3);
    expect(wake).toContain("counts like a missed report toward `stuck`");
  });

  it("names the reviewer's sha and the head when the approval is on an earlier commit", () => {
    const marker = comment({ id: "m1", author: "trotterdylan", body: "<!-- bb-review round=1 sha=bbbbbbb2 verdict=approved lane=no-review -->", signedBy: "thr_reviewer", createdAt: "2026-10-18T04:00:00Z" });
    const entity = pull({ comments: [marker] }, { headSha: "aaaaaaa1", checks: { state: "success", failing: [] } });
    const wake = formatWake(wakeInput({ observed: { entity, pulls: [] } }));
    expect(wake).toContain("- Lane gate: met (reviewer approved bbbbbbb, head aaaaaaa, checks green, lane no-review)");
  });

  it("takes a worker's closing question, but not one it resolved later in the message", () => {
    expect(workerQuestion("Pushed the fix.\nShould I bring the reviewer back?")).toBe("Should I bring the reviewer back?");
    // A question buried above the last few lines is not what the message ended with.
    expect(workerQuestion("Should I open a follow-up?\nNever mind, I did it.\nPushed.\nDone and verified.")).toBeNull();
    expect(workerQuestion("No question here.")).toBeNull();
    expect(workerQuestion(null)).toBeNull();
  });

  it("names a worker's question ahead of every other change, with how to answer", () => {
    const wake = formatWake(
      wakeInput({
        workers: [{ threadId: "thr_w1", bindingId: "b1", title: "Implement", status: "finished", result: "Should I bring the reviewer back?", startedAt: T, endedAt: T }],
        workerQuestions: [{ threadId: "thr_w1", question: "Should I bring the reviewer back?", state: "live" }],
        changes: ["1 new comment from Sam"],
      }),
    );
    expect(wake).toContain("- **Worker thr_w1 asked:** Should I bring the reviewer back?");
    expect(wake).toContain("Answer it with `bb thread tell thr_w1 <answer>`, or escalate it, before anything else.");
    expect(wake.indexOf("Worker thr_w1 asked:")).toBeLessThan(wake.indexOf("1 new comment from Sam"));
  });
});

describe("the nightly prompt", () => {
  it("is assembled from the records: previous digest with its date, open questions, what moved, waiting on you, stuck", () => {
    const { s, bind } = world();
    const moved = s.patch(bind("ENG-1").id, { status: status("Implementation half done."), advancedAt: T - 3_600_000 });
    const ended = s.patch(bind("ENG-2").id, { endedAt: T - 7_200_000, endReason: "terminal" });
    const held = s.patch(bind("ENG-3").id, { hold: "billing freeze" });
    const quiet = bind("ENG-4");
    const forwarded = s.escalate({ bindingId: quiet.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "me", recommendation: "No." });
    const approval = s.escalate({ bindingId: moved.id, kind: "approval", question: "Approve ENG-1's spec?", meanwhile: "Waiting.", route: "me", recommendation: null });
    const stuck = s.escalate({ bindingId: held.id, kind: "stuck", question: "Status has not moved in 3 days.", meanwhile: "Carrying on.", route: "project", recommendation: null });
    const fromForward = s.ask({ projectId: "p1", bindingId: quiet.id, escalationId: forwarded.id, question: "Include SSO?", context: "A decision escalation from ENG-4." });
    const a11y = s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Should I file an a11y ticket?", context: null });
    const answered = { ...s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Ship on Friday?", context: null }), status: "answered" as const, answer: "No.", answeredBy: "user", resolvedAt: T - 60_000 };
    const questions = [fromForward, a11y].map((question) => ({ question, about: question.bindingId === null ? null : s.binding(question.bindingId) }));
    const records: DigestRecords = {
      previous: { text: "PR #429 still waits for approval.", at: T - DAY },
      since: T - DAY,
      moved: [moved],
      ended: [ended],
      answered: [answered],
      withUser: [
        { escalation: forwarded, from: quiet },
        { escalation: approval, from: moved },
      ],
      stuck: [{ escalation: stuck, from: held }],
      held: [held],
    };
    const wake = formatProjectWake({ reason: "nightly pass 2026-10-18", bindings: [], routed: [], withUser: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions, records });

    expect(wake).toContain("## Questions open with the user");
    expect(wake).toContain(`- ${fromForward.id} (asked 2026-10-18, about ENG-4, forwarded escalation ${forwarded.id}): Include SSO? Context: A decision escalation from ENG-4.`);
    expect(wake).toContain(`- ${a11y.id} (asked 2026-10-18): Should I file an a11y ticket?`);
    expect(wake).toContain("### Your previous digest (2026-10-17T05:00:00Z)\n\n> PR #429 still waits for approval.");
    const section = (title: string) => wake.split(`### ${title}\n\n`)[1]!.split("\n\n")[0]!;
    expect(section("What moved").split("\n")).toEqual([
      "- ENG-1 (ticket, In Progress), moved 2026-10-18T04:00:00Z: Implementation half done. Next: Open the PR (steward)",
      "- Ended: ENG-2 (ticket), terminal at 2026-10-18T03:00:00Z",
      `- Answered: ${answered.id} "Ship on Friday?" → No. (by the user, on the stewards page)`,
    ]);
    // A forwarded escalation is listed once, as its question.
    expect(section("Waiting on the user").split("\n")).toEqual([
      `- Question ${fromForward.id} (since 2026-10-18, about ENG-4): Include SSO?`,
      `- Question ${a11y.id} (since 2026-10-18): Should I file an a11y ticket?`,
      `- Approval of ENG-1's spec (${approval.id}, since 2026-10-18)`,
    ]);
    expect(section("Stuck or held").split("\n")).toEqual([`- ENG-3: stuck escalation ${stuck.id} with project, since 2026-10-18: Status has not moved in 3 days.`, "- ENG-3: on hold: billing freeze"]);
    expect(wake).toMatch(/Write it from the record above, not from memory/u);
    expect(wake.indexOf("## The record since")).toBeLessThan(wake.indexOf("reply with the morning digest"));
  });

  it("gives dates in the project's nightly time zone", () => {
    const { s } = world();
    const q = s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Freeze on Friday?", context: null });
    const questions = [{ question: q, about: null }];
    const records: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], held: [] };
    const wake = (timeZone?: string) => formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions, records, ...(timeZone === undefined ? {} : { timeZone }) });
    // 05:00Z on the 18th is still the evening of the 17th in Los Angeles.
    expect(wake("America/Los_Angeles")).toContain(`- ${q.id} (asked 2026-10-17): Freeze on Friday?`);
    expect(wake("America/Los_Angeles")).toContain(`- Question ${q.id} (since 2026-10-17): Freeze on Friday?`);
    expect(wake()).toContain(`- ${q.id} (asked 2026-10-18): Freeze on Friday?`);
  });

  it("says so when there is nothing, and leaves the record out of a wake that wants no digest", () => {
    const empty: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], held: [] };
    const nightly = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions: [], records: empty });
    expect(nightly).toMatch(/### Your previous digest\n\nNone yet\./u);
    expect(nightly).toMatch(/### What moved\n\nNothing moved\./u);
    expect(nightly).toMatch(/### Waiting on the user\n\nNothing\./u);
    expect(nightly).toMatch(/### Stuck or held\n\nNothing\./u);
    expect(nightly).not.toContain("## Questions open with the user");
    const escalation = formatProjectWake({ reason: "escalation", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], records: empty });
    expect(escalation).not.toContain("## The record since");
  });
});
