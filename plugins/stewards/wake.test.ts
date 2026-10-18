import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, createStore } from "./store.js";
import { formatProjectWake, type DigestRecords } from "./wake.js";

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
