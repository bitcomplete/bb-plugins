import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parsePlaybook } from "./config.js";
import { explainDecision, formatDecisionListing } from "./decisions.js";
import { comment, issue, pull } from "./fixtures.js";
import { gateState } from "./reconcile.js";
import { MIGRATIONS, RESOLUTION_KINDS, createStore } from "./store.js";
import { ESCALATED_NEED_KINDS } from "./store.js";
import { DEPS_PRS, GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS } from "./templates.js";
import { STANDING_RULES, formatProjectWake, formatWake, spawnCommand, workerQuestion, type DigestRecords, type WakeInput } from "./wake.js";

const T = Date.parse("2026-10-18T05:00:00Z");
const DAY = 86_400_000;

function world() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const s = createStore(db, () => T);
  const bind = (key: string) => s.create({ projectId: "p1", source: "linear", entityId: key, entityKey: key, url: null, title: null, kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "In Progress", stage: "build" });
  return { s, bind };
}

const status = (summary: string) => ({ phase: "In Progress", summary, nextAction: "Open the PR", actor: "steward" as const, waitingOn: null, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: T });

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
  it("carries the standing rules: a credential is an escalation, not a provide-secret need (BB-51)", () => {
    const wake = formatWake(wakeInput());
    expect(wake).toContain("steward_report { escalate");
    for (const kind of ESCALATED_NEED_KINDS) expect(wake).toContain(kind);
    expect(wake).toContain("writeEnv");
    expect(wake).toMatch(/never paste a secret/iu);
    expect(wake).toContain("One ask per reply");
    expect(wake).toContain("escalated as a `decision` in the same turn");
    // The old contradiction is gone: no rule tells a steward to file one.
    expect(wake).not.toMatch(/File it with `steward_report \{ needs/);
  });

  it("names the worker and reviewer models as flags that are not the steward's to choose", () => {
    const wake = formatWake(wakeInput());
    expect(wake).toContain("--provider claude-code --model claude-opus-5-5 --reasoning-level high");
    expect(wake).toContain("your workers' and reviewers' models");
    expect(wake).toContain("not yours to choose");
  });

  // BB-134: the plugin ships build-tickets and pr-reviewer, so the ticket and
  // PR steward wakes name them for the worker task; a review steward's own
  // playbook does not use them.
  it("names the worker and reviewer skills for a ticket or PR steward to put in the worker task", () => {
    const ticket = formatWake(wakeInput());
    expect(ticket).toContain("follows the `build-tickets` skill");
    expect(ticket).toContain("spawn its reviewer with the `pr-reviewer` skill");
    expect(ticket).toContain("`.bb/skills/<name>` copy overrides either");

    const { s } = world();
    const playbook = (name: string, text: string) => {
      const parsed = parsePlaybook(text, name);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const pr = s.create({ projectId: "p1", source: "github", entityId: "acme/web#7", entityKey: "acme/web#7", url: "https://github.com/acme/web/pull/7", title: "Fix", kind: "pr", playbook: "github-prs", playbookVersion: "v1", parentBindingId: null, phase: "open", stage: "review" });
    const prPlaybook = playbook("github-prs", GITHUB_PRS);
    expect(formatWake(wakeInput({ binding: pr, playbook: prPlaybook, gate: gateState(prPlaybook, pr.ready, "") }))).toContain("follows the `build-tickets` skill");

    const review = s.create({ projectId: "p1", source: "github", entityId: "acme/web#8", entityKey: "acme/web#8", url: "https://github.com/acme/web/pull/8", title: "Review", kind: "review", playbook: "github-reviews", playbookVersion: "v1", parentBindingId: null, phase: "open", stage: "review" });
    const reviewPlaybook = playbook("github-reviews", GITHUB_REVIEWS);
    expect(formatWake(wakeInput({ binding: review, playbook: reviewPlaybook, gate: gateState(reviewPlaybook, review.ready, "") }))).not.toContain("follows the `build-tickets` skill");

    // A deps-prs worker runs the review loop but never merges, so it must not
    // be told to follow build-tickets (BB-134 review round 1).
    const depsPrs = s.create({ projectId: "p1", source: "github", entityId: "acme/web#9", entityKey: "acme/web#9", url: "https://github.com/acme/web/pull/9", title: "Bump", kind: "pr", playbook: "deps-prs", playbookVersion: "v1", parentBindingId: null, phase: "open", stage: "review" });
    const depsPrsPlaybook = playbook("deps-prs", DEPS_PRS);
    expect(formatWake(wakeInput({ binding: depsPrs, playbook: depsPrsPlaybook, gate: gateState(depsPrsPlaybook, depsPrs.ready, "") }))).not.toContain("follows the `build-tickets` skill");
  });

  // BB-55: the Todo wake must say that an unjudged substantiality is settled
  // by a `substantial: false` report, which passes the gate at once.
  it("says an unjudged substantiality is passed by a substantial: false report in the same turn", () => {
    const wake = formatWake(wakeInput());
    expect(wake).toContain("- Substantial: not judged yet (treated as yes)");
    expect(wake).toContain("with every checklist item met");
    expect(wake).toMatch(/report `substantial: false`.*the gate passes immediately on that report.*start the worker in the same turn/u);
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

  it("tells the steward to cite the lessons behind a routed escalation (BB-35 step 2)", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "steward", recommendation: null });
    const wake = formatWake(wakeInput({ binding, routedToMe: [{ escalation: x, from: binding }] }));
    expect(wake).toMatch(/resolve, cites: \[lesson ids or guidance unit ids\]/u);
    expect(wake).toMatch(/forward, recommendation, cites: \[lesson ids or guidance unit ids\]/u);
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
        workers: [{ threadId: "thr_w1", bindingId: "b1", title: "Implement", status: "finished", result: "Should I bring the reviewer back?", startedAt: T, endedAt: T, modelCheckPending: false }],
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

  it("tells the project steward to cite the lessons a decision rested on (BB-35 step 2)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const x = s.escalate({ bindingId: b.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "project", recommendation: null });
    const wake = formatProjectWake({ reason: "escalation", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(wake).toMatch(/cites: \[ids\]/u);
    expect(wake).toMatch(/a decision must cite what it was decided from/u);
    // A forward can cite too: the recommendation a correction is measured against lives there.
    expect(wake).toMatch(/forward, recommendation, cites: \[ids\]/u);
  });

  it("injects trial lessons under their own heading and never a candidate (BB-35 step 3)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const trial = s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: "Auth is the plugin's.", scope: "procedure", branch: null });
    const candidate = s.addLesson({ projectId: "p1", bindingId: null, escalationId: null, file: "AGENTS.md", text: "Maybe later.", scope: "procedure", branch: null, tier: "candidate" });
    const wake = formatWake(wakeInput({ binding: b, lessons: [trial, candidate] }));
    expect(wake).toContain("## Lessons (trial)");
    expect(wake).toContain(`- ${trial.id} (procedure, AGENTS.md): Auth is the plugin's.`);
    expect(wake).not.toContain(candidate.id);
    expect(wake).not.toContain("Maybe later.");
  });

  it("groups the project's lessons by tier: trial to decide from, promoted to land, retired to remove (BB-35 step 3)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const trial = s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: "Auth is the plugin's.", scope: "procedure", branch: null });
    const promoted = s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: "Read SELECT * carefully.", scope: "procedure", branch: null });
    s.setLessonTier(promoted.id, "promoted");
    const retired = s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: "An old rule.", scope: "procedure", branch: null });
    s.markLessonMerged(retired.id, "a".repeat(40), null);
    s.setLessonTier(retired.id, "retired");
    const wake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], lessons: s.allLessons("p1") });
    expect(wake).toContain("## Lessons (trial)");
    expect(wake).toContain(`- ${trial.id} (procedure, AGENTS.md): Auth is the plugin's.`);
    expect(wake).toContain("## Lessons to land");
    expect(wake).toContain(`<!-- lesson:${promoted.id} -->`);
    expect(wake).toContain("## Lessons to retire");
    expect(wake).toContain(`- ${retired.id} (AGENTS.md): An old rule.`);
    // It is listed once, as to-land, not also under the trial heading.
    expect(wake.split(`- ${promoted.id} `)).toHaveLength(2);
  });

  it("caps the trial lessons in a project wake at lessons.trial.max", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const lessons = [1, 2, 3].map((n) => s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: `Rule ${n}.`, scope: "procedure", branch: null }));
    const wake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], lessons: s.allLessons("p1"), lessonRules: { trial: { max: 1, retireDays: 30 }, promote: { hits: 3, days: 14 }, promoted: { maxPerFile: 10, retireDays: 90, corrections: 2 }, decayHalfLifeDays: 30, validations: { perWeek: 1 } } });
    expect(wake).toContain(`- ${lessons[0]!.id} (procedure, AGENTS.md): Rule 1.`);
    expect(wake).not.toContain(`- ${lessons[1]!.id} `);
    expect(wake).not.toContain(`- ${lessons[2]!.id} `);
  });

  it("names the five resolution kinds and how a credential is forwarded (BB-51)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const x = s.escalate({ bindingId: b.id, kind: "decision", question: "Provide API_TOKEN.", meanwhile: "Wait.", route: "project", recommendation: null });
    const wake = formatProjectWake({ reason: "escalation", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    for (const kind of RESOLUTION_KINDS) expect(wake).toContain(`\`${kind}\``);
    expect(wake).toMatch(/resolution: "secret"/u);
    expect(wake).toContain("variable");
    expect(wake).toContain("purpose");
    expect(wake).toContain("writeEnv");
    expect(wake).toContain("setting");
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

  it("shows the project's standing-rules list in an approval wake, and works with none configured (BB-54)", () => {    const { s, bind } = world();
    const b = bind("ENG-12");
    const x = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve ENG-12's spec?", meanwhile: "Waiting.", route: "project", recommendation: null });
    const withRules = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], standingRules: ["Migrations are append-only.", "The PR body carries the restart note."] });
    expect(withRules).toContain("- Migrations are append-only.");
    expect(withRules).toContain("- The PR body carries the restart note.");
    expect(withRules).toMatch(/Add only the limits this change needs that this list does not cover, in at most three points/u);
    expect(withRules).toMatch(/The guidance written to the binding is your additions only/u);
    const none = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(none).toMatch(/no standing-rules list configured/u);
    expect(none).toMatch(/Add only the limits this change needs, in at most three points/u);
  });
});

describe("the decide-list listing in the wakes (BB-135)", () => {
  const entries = [
    { text: "Identity and access", decide: "user" as const, paths: ["bb-gate/hooks/**"] },
    { text: "A cross-repo contract", decide: "project" as const, paths: ["bb-gate/docs/hooks.md"] },
  ];
  const listing = () => formatDecisionListing(explainDecision(["bb-gate/hooks/slack.go", "bb-gate/docs/hooks.md"], entries));

  it("prints the listing on an approval escalation routed to the project steward", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const x = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve acme/web#7", meanwhile: "Wait for the project steward's decision.", route: "project", recommendation: null, resolutionKind: "approve-decline", url: "https://github.com/acme/web/pull/7" });
    const wake = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b, listing: listing() }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(wake).toContain('"Identity and access" [user] — bb-gate/hooks/slack.go');
    expect(wake).toContain('"A cross-repo contract" [project] — bb-gate/docs/hooks.md');
    expect(wake).toContain('Deciding entry: "Identity and access" [user].');
    expect(wake).toContain("Rule: a `user` entry wins");
  });

  it("prints the listing on a plugin-filed approve-pr need in the project wake", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const need = s.fileNeed({ bindingId: b.id, kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve acme/web#7 on GitHub", how: `Post the unsigned comment as you.\n\n${listing()}`, data: { decideListing: listing() }, filedBy: "plugin" });
    const wake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], needs: [{ need, binding: b }] });
    expect(wake).toContain("## Needs you");
    expect(wake).toContain('Deciding entry: "Identity and access" [user].');
    expect(wake).toContain("Rule: a `user` entry wins");
  });

  it("prints the listing on the owner's approve-pr item in the steward wake", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const need = s.fileNeed({ bindingId: b.id, kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve acme/web#7 on GitHub", how: `Post the unsigned comment as you.\n\n${listing()}`, data: { decideListing: listing() }, filedBy: "plugin" });
    const wake = formatWake(wakeInput({ binding: b, needs: [need] }));
    expect(wake).toContain("## Waiting on you");
    expect(wake).toContain('Deciding entry: "Identity and access" [user].');
    expect(wake).toContain("Rule: a `user` entry wins");
  });
});

describe("the spawn command (BB-133)", () => {
  const flags = "--environment-provider multi-repo-workspace --provider claude-code --model claude-opus-5-5";

  it("is unchanged for the worker role, and adds the reviewer's hidden full-permission flags", () => {
    const worker = spawnCommand({ projectId: "p1", entityKey: "ENG-12", workerFlags: flags });
    expect(worker).toContain('bb thread spawn --project p1 --parent-self --parent-notifications off --lifecycle-owner-thread "$BB_THREAD_ID" --environment-provider multi-repo-workspace --provider claude-code --model claude-opus-5-5 --title "ENG-12: <task>" --prompt-file -');
    expect(worker).not.toContain("--visibility hidden");
    expect(worker).not.toContain("--permission-mode");

    const reviewer = spawnCommand({ projectId: "p1", entityKey: "ENG-12", workerFlags: flags, role: "reviewer" });
    expect(reviewer).toContain("--visibility hidden --permission-mode full");
    expect(reviewer).toContain('--title "Review ENG-12: <task>"');
    // The reviewer is started from the worker thread, so `--parent-self` makes
    // it that worker's child, and the lifecycle owner stays the worker.
    expect(reviewer).toContain("--parent-self --parent-notifications off --lifecycle-owner-thread \"$BB_THREAD_ID\"");
  });
});
