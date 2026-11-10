import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { DepsDecision } from "./store.js";
import { parsePlaybook } from "./config.js";
import { explainDecision, formatDecisionListing } from "./decisions.js";
import { comment, issue, pull } from "./fixtures.js";
import { gateState } from "./ready-gate.js";
import { MIGRATIONS, RESOLUTION_KINDS, createStore } from "./store.js";
import { DEPS_PRS, GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, DEPS_ALERTS, PLAYBOOK_TEMPLATES } from "./templates.js";
import { STANDING_RULES, BRIEF_PREFIX, formatBrief, formatDepsWake, formatOpsWake, formatProjectWake, formatRecords, formatWake, GUIDANCE_UNITS_MAX, initiativeProgress, initiativeProgressFlag, spawnCommand, WAKE_MAX_CHARS, workerFinishNote, workerQuestion, type DigestRecords, type WakeInput } from "./wake.js";
import { BRIEF_MAX_CHARS } from "./server.js";
import type { OpsFinding } from "./ops.js";
import type { DepsFinding } from "./deps.js";
import { ESCALATED_NEED_KINDS, type Assumption } from "./store.js";
import type { EntitySnapshot } from "./source-contract.js";

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

  // BB-207: a review playbook has no ready gate, but its `substantial` list is
  // the reviewer's criteria; the wake carries the list and the verdict, and
  // says to report it on the binding.
  it("shows the github-reviews substantial criteria and the reported verdict on a review binding", () => {
    const { s } = world();
    const review = s.create({ projectId: "p1", source: "github", entityId: "acme/web#8", entityKey: "acme/web#8", url: "https://github.com/acme/web/pull/8", title: "Review", kind: "review", playbook: "github-reviews", playbookVersion: "v1", parentBindingId: null, phase: "open", stage: "review" });
    const parsed = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!parsed.ok) throw new Error(parsed.error);
    const playbook = parsed.value;
    const input = (binding = review) => wakeInput({ binding, playbook, gate: gateState(playbook, binding.ready, ""), observed: { entity: pull(), pulls: [] } });
    const unjudged = formatWake(input());
    expect(unjudged).toContain("- Substantial: not judged yet");
    expect(unjudged).toContain("a new outbound integration or dependency");
    expect(unjudged).toContain("the reviewer computes it from the diff, never the pull request body");
    // Once the reviewer reports the verdict on the binding, the wake carries it.
    s.patch(review.id, { ready: { ...review.ready, substantial: true, why: "a new outbound integration" } });
    expect(formatWake(input(s.binding(review.id)!))).toContain("- Substantial: yes — a new outbound integration");
  });

  // BB-154: a binding marked waiting with no wake source carries one paragraph
  // naming what the plugin does not track and what the steward can do.
  it("carries the no-wake-source paragraph only while marked", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const status = { phase: "In Progress", summary: "Waiting on the vendor.", nextAction: "the vendor", actor: "other" as const, waitingOn: "the vendor's reply", requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: T };
    s.patch(binding.id, { status });
    const marked = formatWake(wakeInput({ binding: s.binding(binding.id)! }));
    expect(marked).not.toContain("**Waiting with no wake source.**");

    s.patch(binding.id, { noWakeSource: true });
    const wake = formatWake(wakeInput({ binding: s.binding(binding.id)! }));
    expect(wake).toContain("**Waiting with no wake source.**");
    expect(wake).toContain("Nothing the plugin tracks will deliver this wait");
    expect(wake).toContain('"the vendor\'s reply"');
    expect(wake).toContain("a binding to hold behind, a pull request, a deployment target, a worker");
    expect(wake).toContain("the condition is your own to re-examine");
  });

  // BB-194: a failed watch is settled and will not wake the steward, so the
  // paragraph names every failed key and the exact not-yet report that
  // re-arms it. A merged watch is not named.
  it("names each failed deployment watch and the not-yet report that re-arms it", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const watch = (key: string, state: "failed" | "merged") => ({
      key,
      state,
      mergeSha: null,
      target: "",
      mergedAt: T,
      prRepo: "acme/web",
      files: [],
      repo: "acme/bb-gate",
      environment: "production",
      deploymentId: null,
      deploymentState: null,
      ref: null,
      sha: null,
      url: null,
      at: T,
      deadlineAt: state === "failed" ? null : T + 3_600_000,
      note: state === "failed" ? "No matching deployment within the playbook's timeout; last: image-tag: behind" : null,
      workflowRuns: [],
    });
    s.patch(binding.id, {
      deployments: { "acme/web#7": watch("acme/web#7", "failed"), "acme/web#8": watch("acme/web#8", "failed"), "acme/web#9": watch("acme/web#9", "merged") },
      noWakeSource: true,
    });
    const wake = formatWake(wakeInput({ binding: s.binding(binding.id)! }));
    expect(wake).toContain("The failed deployment watches for acme/web#7, acme/web#8 are settled and will not wake you on their own");
    expect(wake).toContain('re-arm acme/web#7 with `steward_report { deployment: { state: "not-yet", key: "acme/web#7" } }` and acme/web#8 with `steward_report { deployment: { state: "not-yet", key: "acme/web#8" } }`');
    expect(wake).toContain("puts each back to merged with a fresh deadline so the next deployment doorbell wakes you");
    expect(wake).not.toContain('key: "acme/web#9"');
  });

  it("lists an open escalation and approval request as on the Stewards page, not to be asked again", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const decision = s.escalate({ bindingId: binding.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "user", recommendation: null });
    const approval = s.escalate({ bindingId: binding.id, kind: "approval", question: "Approve the spec?", meanwhile: "Waiting.", route: "user", recommendation: null });
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
        workers: [{ threadId: "thr_w1", bindingId: "b1", title: "Implement", status: "finished", result: "Should I bring the reviewer back?", startedAt: T, endedAt: T, modelCheckPending: false, stopReason: null }],
        workerQuestions: [{ threadId: "thr_w1", question: "Should I bring the reviewer back?", state: "live" }],
        changes: ["1 new comment from Sam"],
      }),
    );
    expect(wake).toContain("- **Worker thr_w1 asked:** Should I bring the reviewer back?");
    expect(wake).toContain("Answer it with `bb thread tell thr_w1 <answer>`, or escalate it, before anything else.");
    expect(wake.indexOf("Worker thr_w1 asked:")).toBeLessThan(wake.indexOf("1 new comment from Sam"));
  });
});

describe("the worker finish note (BB-152)", () => {
  it("always carries the worker's final message, clipped to a bounded length", () => {
    expect(workerFinishNote("ENG-12: Implement", "Opened acme/web#7; waiting on the reviewer.", false)).toBe(
      'Worker "ENG-12: Implement" finished its turn. Its final message: Opened acme/web#7; waiting on the reviewer.',
    );
    expect(workerFinishNote("ENG-12: Implement", null, false)).toBe('Worker "ENG-12: Implement" finished its turn.');
    // Whitespace is flattened and the report is bounded.
    const long = `line one\n\nline two ${"x".repeat(900)}`;
    const note = workerFinishNote("ENG-12: Implement", long, false);
    expect(note.length).toBeLessThan(600);
    expect(note).toContain("line one line two");
    expect(note).toContain("…");
  });

  it("prompts the steward when its waitingOn named the worker", () => {
    const note = workerFinishNote("ENG-12: Implement", "I posted the gate; the merge was refused.", true);
    expect(note).toMatch(/finished its turn while you were waiting on it/u);
    expect(note).toMatch(/Check whether what you waited on \(a merge, an apply\) happened/u);
    expect(note).toMatch(/do it yourself/u);
    expect(note).toMatch(/`gh pr merge`/u);
    expect(note).toMatch(/Do not re-wait on this worker/u);
    expect(note).toContain("I posted the gate; the merge was refused.");
  });
});

describe("the nightly prompt", () => {
  it("is assembled from the records: previous digest with its date, open questions, what moved, waiting on you, stuck", () => {
    const { s, bind } = world();
    const moved = s.patch(bind("ENG-1").id, { status: status("Implementation half done."), advancedAt: T - 3_600_000 });
    const ended = s.patch(bind("ENG-2").id, { endedAt: T - 7_200_000, endReason: "terminal" });
    const held = s.patch(bind("ENG-3").id, { hold: "billing freeze" });
    const quiet = bind("ENG-4");
    const forwarded = s.escalate({ bindingId: quiet.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "user", recommendation: "No." });
    const approval = s.escalate({ bindingId: moved.id, kind: "approval", question: "Approve ENG-1's spec?", meanwhile: "Waiting.", route: "user", recommendation: null });
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
      noWakeSource: [],
      stall: [],
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

  it("tells the project steward it may land a trial lesson early, and that it is not an owner priority (BB-288)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const trial = s.addLesson({ projectId: "p1", bindingId: b.id, escalationId: null, file: "AGENTS.md", text: "Auth is the plugin's.", scope: "procedure", branch: null });
    const wake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions: [], lessons: s.allLessons("p1") });
    expect(wake).toContain("## Lessons (trial)");
    expect(wake).toContain("not owner to-dos");
    expect(wake).toContain("workspace_publish_guidance");
    expect(wake).toContain(`steward_update { lessonAction: { id: "${trial.id}", action: "complete" } }`);
    // The digest is built from the records, which never carry trial lessons,
    // so a trial rule cannot be listed as an owner priority (BB-288).
    const records: DigestRecords = { previous: null, since: T, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], held: [] };
    const digest = formatRecords(records, []).join("\n");
    expect(digest).not.toContain(trial.id);
    expect(digest).not.toContain("Auth is the plugin's.");
  });

  it("renders each AGENTS.md and playbook guidance unit beside its gu_ id in the wake and the brief (BB-288)", () => {
    const units = [
      { id: "gu_0123456789abcdef", file: "AGENTS.md", heading: "Reviews", text: "A merge to bb-plugins main restarts every server.", lessonId: null },
      { id: "gu_fedcba9876543210", file: "stewards/playbooks/linear-tickets.md", heading: "In Progress", text: "Start the worker in the same turn.", lessonId: null },
    ];
    const input = wakeInput({ guidance: units });
    const wake = formatWake(input);
    expect(wake).toContain("## Guidance units");
    expect(wake).toContain("- gu_0123456789abcdef (AGENTS.md §Reviews): A merge to bb-plugins main restarts every server.");
    expect(wake).toContain("- gu_fedcba9876543210 (stewards/playbooks/linear-tickets.md §In Progress): Start the worker in the same turn.");
    const brief = formatBrief({ binding: input.binding, playbook: input.playbook, gate: input.gate, workerFlags: null, guidance: units });
    expect(brief).toContain("gu_0123456789abcdef");
    expect(brief).toContain("gu_fedcba9876543210");
    // With no units the block is absent, so a wake that renders none says nothing.
    expect(formatWake(wakeInput())).not.toContain("## Guidance units");
  });

  it("keeps the snapshot and What changed when the guidance index is large (BB-288)", () => {
    // A realistically sized AGENTS.md: far more units than a wake lists, each
    // with a long paragraph. The compact, capped, clippable block must not
    // push the wake past its cap or cost the snapshot or the changes.
    const units = Array.from({ length: 300 }, (_, i) => ({
      id: `gu_${String(i).padStart(16, "0")}`,
      file: "AGENTS.md",
      heading: `Section ${i}`,
      text: `Guidance paragraph number ${i}. `.repeat(40),
      lessonId: null,
    }));
    const wake = formatWake(wakeInput({ guidance: units, changes: ["Something changed."] }));
    expect(wake).toContain("## Guidance units");
    expect(wake).toContain(`and ${units.length - GUIDANCE_UNITS_MAX} more`);
    expect(wake).toContain("## 4. Snapshot");
    expect(wake).toContain("## 5. What changed since your last turn");
    expect(wake).toContain("- Something changed.");
    expect(wake.length).toBeLessThanOrEqual(WAKE_MAX_CHARS + 200);
  });

  it("names the five resolution kinds and how a credential is forwarded (BB-51, BB-176)", () => {
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
    // BB-176: `secret` is the only resolution for a credential, even when the
    // ticket or spec says the owner produces or seals it by hand.
    expect(wake).toMatch(/even when the ticket or spec says the owner produces or seals it by hand/u);
    expect(wake).toMatch(/corrected at spec approval/u);
    expect(STANDING_RULES.join("\n")).toMatch(/even when the ticket or spec says the owner produces or seals it by hand/u);
  });

  it("carries the rule that the plugin merges a gate-met pull request (BB-257)", () => {
    const rules = STANDING_RULES.join("\n");
    expect(rules).toMatch(/The plugin merges once the lane gate is met/u);
    expect(rules).toMatch(/targets the default branch/u);
    expect(rules).toMatch(/a ticket binding always does/u);
    expect(rules).toMatch(/`may` includes `merge`/u);
    expect(rules).toMatch(/a stacked pull request is held behind its base pull request until that merges/u);
    expect(rules).toMatch(/retargeted to the default branch and rebased/u);
    expect(rules).toMatch(/Do not file a Merge item/u);
  });

  it("carries the merge hold rule and its line (BB-256)", () => {
    expect(STANDING_RULES.join("\n")).toMatch(/do not merge before X is Done/u);
    expect(STANDING_RULES.join("\n")).toMatch(/mergeBehind/u);
    const { s, bind } = world();
    const b = bind("ENG-12");
    s.patch(b.id, { mergeBehind: ["ENG-13"] });
    const wake = formatWake(wakeInput({ binding: s.binding(b.id)! }));
    expect(wake).toMatch(/MERGE HOLD: behind ENG-13/u);
    expect(wake).toMatch(/files no Merge item while it stands/u);
  });

  it("gives dates in the project's nightly time zone", () => {
    const { s } = world();
    const q = s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Freeze on Friday?", context: null });
    const questions = [{ question: q, about: null }];
    const records: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], held: [] };
    const wake = (timeZone?: string) => formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions, records, ...(timeZone === undefined ? {} : { timeZone }) });
    // 05:00Z on the 18th is still the evening of the 17th in Los Angeles.
    expect(wake("America/Los_Angeles")).toContain(`- ${q.id} (asked 2026-10-17): Freeze on Friday?`);
    expect(wake("America/Los_Angeles")).toContain(`- Question ${q.id} (since 2026-10-17): Freeze on Friday?`);
    expect(wake()).toContain(`- ${q.id} (asked 2026-10-18): Freeze on Friday?`);
  });

  it("says so when there is nothing, and leaves the record out of a wake that wants no digest", () => {
    const empty: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], held: [] };
    const nightly = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions: [], records: empty });
    expect(nightly).toMatch(/### Your previous digest\n\nNone yet\./u);
    expect(nightly).toMatch(/### What moved\n\nNothing moved\./u);
    expect(nightly).toMatch(/### Waiting on the user\n\nNothing\./u);
    expect(nightly).toMatch(/### Stuck or held\n\nNothing\./u);
    expect(nightly).not.toContain("## Questions open with the user");
    const escalation = formatProjectWake({ reason: "escalation", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [], records: empty });
    expect(escalation).not.toContain("## The record since");
  });

  // BB-154: the digest lists the marked bindings and open stalls, so a quiet
  // stall is visible once a day even before the requeue threshold.
  it("lists bindings waiting with no wake source and open stall escalations in the digest", () => {
    const { s, bind } = world();
    const marked = bind("ENG-12");
    s.patch(marked.id, {
      noWakeSource: true,
      requeueWakeCount: 2,
      status: { phase: "In Progress", summary: "Waiting.", nextAction: "the vendor", actor: "other", waitingOn: "the vendor's reply", requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: T },
    });
    const stall = s.escalate({ bindingId: marked.id, kind: "stall", question: "ENG-12 has woken by requeue 2 times with the same wait.", meanwhile: "Waiting.", route: "project", recommendation: null });
    const current = s.binding(marked.id)!;
    const records: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [current], stall: [{ escalation: stall, from: current }], held: [] };
    const wake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions: [], records });
    expect(wake).toContain("### Waiting with no wake source");
    expect(wake).toContain("- ENG-12 (ticket, In Progress): waiting with no wake source: the vendor's reply (2 requeue-only wakes)");
    expect(wake).toContain(`- ENG-12: stall escalation ${stall.id} with the project steward, since 2026-10-18: ENG-12 has woken by requeue 2 times with the same wait.`);
  });

  // BB-247: a dated wait is listed in its own digest section, separate from
  // the stalls and the no-wake-source marks.
  it("lists dated waits in their own digest section (BB-247)", () => {
    const { s, bind } = world();
    const dated = bind("ENG-12");
    s.patch(dated.id, {
      requeueUntil: Date.parse("2026-12-01T00:00:00Z"),
      status: { phase: "In Progress", summary: "Waiting.", nextAction: "the vendor", actor: "other", waitingOn: "the vendor's reply", requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: T },
    });
    const current = s.binding(dated.id)!;
    const records: DigestRecords = { previous: null, since: T - DAY, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], datedWaits: [current], held: [] };
    const digest = formatRecords(records, []).join("\n");
    expect(digest).toContain("### Dated waits");
    expect(digest).toContain("- ENG-12 (ticket, In Progress): waiting on the vendor's reply until 2026-12-01");
    // A dated wait is not also in the no-wake-source list.
    expect(digest).toContain("### Waiting with no wake source\n\nNothing.");
  });

  it("shows the project's standing-rules list in an approval wake, and works with none configured (BB-54)", () => {
    const { s, bind } = world();
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

  it("tells the project steward a reviewer escalated an owner-reviewed pull request to the owner (BB-192)", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const x = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve acme/web#7", meanwhile: "Wait.", route: "project", recommendation: null, resolutionKind: "approve-decline", url: "https://github.com/acme/web/pull/7" });
    const escalated = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b, escalated: true }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(escalated).toMatch(/reviewer can escalate an owner-reviewed pull request to the owner/u);
    expect(escalated).toMatch(/do not post one/u);
    expect(escalated).toMatch(/forward the request to the user/u);
    // Without the escalation the line is absent, so a routine approval is unchanged.
    const plain = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(plain).not.toMatch(/reviewer can escalate an owner-reviewed pull request to the owner/u);
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

describe("the re-approval diff in the project wake (BB-249)", () => {
  it("prints the diff an approval escalation carries", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const diff = "--- approved\n+++ current\n@@ -1,2 +1,2 @@\n line one\n-line two\n+line TWO";
    const x = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve ENG-12's spec?", meanwhile: "Waiting.", route: "project", recommendation: null, data: { specDiff: diff, specChangedLines: 2 } });
    const wake = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: x, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(wake).toContain("Re-approval: 2 lines changed from the approved spec:");
    expect(wake).toContain("-line two");
    expect(wake).toContain("+line TWO");
  });

  it("says so when the change was whitespace only, and stays quiet for a first approval", () => {
    const { s, bind } = world();
    const b = bind("ENG-12");
    const whitespace = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve ENG-12's spec?", meanwhile: "Waiting.", route: "project", recommendation: null, data: { specDiff: "", specChangedLines: 0 } });
    const first = s.escalate({ bindingId: b.id, kind: "approval", question: "Approve ENG-12's spec?", meanwhile: "Waiting.", route: "project", recommendation: null });
    const wake = formatProjectWake({ reason: "approval", bindings: [], routed: [{ escalation: whitespace, from: b }, { escalation: first, from: b }], problems: [], digestDue: false, notes: [], bigDecisions: [], questions: [] });
    expect(wake).toContain("Re-approval: no visible change");
    // Only once: the first approval has no diff to print.
    expect(wake.match(/Re-approval:/gu)).toHaveLength(1);
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

describe("the ops and deps wake classification lines (BB-136)", () => {
  const at = Date.parse("2026-10-18T05:00:00Z");
  const binding = (key: string) => world().bind(key);
  const parsedPlaybook = (text: string, name: string) => {
    const parsed = parsePlaybook(text, name);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const opsFinding = (over: Partial<OpsFinding> = {}): OpsFinding => ({
    fingerprint: "k8s-namespace/bb-gate-production/bb-gate-router/router#CrashLoopBackOff:Error:1",
    workload: "bb-gate-router",
    pods: ["bb-gate-router-6d4f9c7b8-x2k4q"],
    container: "router",
    signature: "CrashLoopBackOff:Error:1",
    summary: "Container router is in CrashLoopBackOff, 7 restarts",
    restarts: 7,
    events: [],
    logs: null,
    previous: true,
    class: "new",
    ticket: null,
    ticketState: null,
    closedAt: null,
    window: null,
    assignee: "Jane",
    dedupUnavailable: false,
    firstSeenAt: at,
    lastCommentedAt: null,
    ...over,
  });
  const opsWake = (finding: OpsFinding) =>
    formatOpsWake({
      reason: "changed",
      binding: binding("k8s-namespace/bb-gate-production"),
      playbook: parsedPlaybook(OPS_WATCH, "ops-watch"),
      look: { at, target: "k8s-namespace/bb-gate-production", error: null, pods: 1, healthy: 0, deployments: [], warnings: [], logs: "unneeded", notes: [], findings: [finding] },
      target: { target: "ENG", source: "linear" },
      label: "bb-managed",
      owner: "Jane",
      autoAdopt: [],
      escalations: [],
      changes: [],
    });
  const depsFinding = (over: Partial<DepsFinding> = {}): DepsFinding => ({
    fingerprint: "acme/web#4",
    alertNumber: 4,
    severity: "high",
    package: "lodash",
    ticketLabels: [],
    alertCreatedAt: null,
    ecosystem: "npm",
    manifestPath: "package-lock.json",
    ghsaId: null,
    fixedVersion: "4.17.21",
    summary: "high lodash",
    state: "open",
    url: null,
    dueAt: at + 86_400_000,
    priority: "high",
    class: "new",
    ticket: null,
    ticketState: null,
    closedAt: null,
    window: null,
    assignee: "Jane",
    dedupUnavailable: false,
    firstSeenAt: at,
    lastCommentedAt: null,
    batch: { kind: "new" },
    ...over,
  });
  const depsWake = (finding: DepsFinding) =>
    formatDepsWake({
      reason: "changed",
      binding: binding("dependabot/acme/web"),
      playbook: parsedPlaybook(DEPS_ALERTS, "deps-alerts"),
      look: { at, target: "dependabot/acme/web", error: null, viewer: "jane", alerts: [finding] },
      target: { target: "ENG", source: "linear" },
      label: "bb-managed",
      owner: "Jane",
      autoAdopt: [],
      timeZone: "UTC",
      escalations: [],
      decisions: [],
      changes: [],
    });

  it("shows the class, the ticket and the assignee for every class, in both formatters", () => {
    expect(opsWake(opsFinding())).toMatch(/New \(no ticket found\)/u);
    expect(opsWake(opsFinding())).toMatch(/Assignee: Jane/u);
    const recurring = opsWake(opsFinding({ class: "recurring", ticket: "ENG-50", ticketState: "In Progress" }));
    expect(recurring).toMatch(/Recurring on ENG-50 \(open\)/u);
    expect(recurring).toMatch(/ticket ENG-50 \(In Progress\)/u);
    const returned = opsWake(opsFinding({ class: "returned", ticket: "ENG-50", ticketState: "Done", closedAt: "2026-10-05T00:00:00Z", window: "within" }));
    expect(returned).toMatch(/Returned: ENG-50 closed 2026-10-05T00:00:00Z, within two weeks/u);
    expect(returned).toMatch(/Assignee: Jane/u);

    expect(depsWake(depsFinding())).toMatch(/New \(no ticket found\)/u);
    expect(depsWake(depsFinding())).toMatch(/Assignee: Jane/u);
    expect(depsWake(depsFinding({ class: "recurring", ticket: "ENG-50", ticketState: "Todo" }))).toMatch(/Recurring on ENG-50 \(open\)/u);
    expect(depsWake(depsFinding({ class: "returned", ticket: "ENG-50", ticketState: "Done", closedAt: "2026-10-01T00:00:00Z", window: "outside" }))).toMatch(/Returned: ENG-50 closed 2026-10-01T00:00:00Z, outside two weeks/u);
  });

  it("shows the computed SLA deadline and the alert's own clock, never the ticket's Linear date (SC-111)", () => {
    const sla = Date.parse("2026-11-07T12:00:00Z");
    const recurring = depsWake(depsFinding({ class: "recurring", ticket: "SC-111", ticketState: "Backlog", severity: "medium", priority: "medium", dueAt: sla, ticketLabels: ["security"], alertCreatedAt: "2026-10-29T00:19:43Z" }));
    expect(recurring).toMatch(/\*\*medium\*\* priority medium, due 2026-11-07/u);
    expect(recurring).not.toMatch(/the ticket's date is the one that counts/u);
    expect(recurring).toMatch(/Ticket labels: security/u);
    expect(recurring).toMatch(/opened 2026-10-29T00:19:43Z \(the SLA clock\); first seen by this watch/u);
    expect(depsWake(depsFinding({ dueAt: sla }))).toMatch(/priority high, due 2026-11-07\n/u);
  });

  const decision = (over: Partial<DepsDecision> = {}): DepsDecision => ({ projectId: "p1", ticketKey: "SC-111", entityId: "dependabot/acme/web", fingerprints: ["acme/web#23", "acme/web#24"], severity: "medium", raisedAt: Date.parse("2026-10-13T15:00:00Z"), raisedBy: "thr_filed", needId: "need_1", status: "pending", resolution: null, resolvedAt: null, reminded: ["overdue"], snoozedUntil: null, ...over });
  const decisionsWake = (decisions: DepsDecision[], playbook = DEPS_ALERTS) => {
    const at = Date.parse("2026-10-14T15:00:00Z");
    return formatDepsWake({
      reason: "requeue",
      binding: binding("dependabot/acme/web"),
      playbook: parsedPlaybook(playbook, "deps-alerts"),
      look: { at, target: "dependabot/acme/web", error: null, viewer: "jane", alerts: [depsFinding({ class: "recurring", ticket: "SC-111", ticketState: "Backlog" })] },
      target: { target: "ENG", source: "linear" },
      label: "bb-managed",
      owner: "Jane",
      autoAdopt: ["critical", "high"],
      timeZone: "UTC",
      escalations: [],
      decisions,
      changes: [],
    });
  };

  it("lists the adoption decisions waiting on the owner, with the exact dismiss commands and no steward-initiated dismiss", () => {
    const text = decisionsWake([decision()]);
    expect(text).toMatch(/### Adoption decisions waiting on the owner\n\n- SC-111 \(acme\/web#23, acme\/web#24\), raised 2026-10-13T15:00:00Z, item need_1, reminded: overdue/u);
    expect(text).toMatch(/Adoption of any other ticket is the owner's decision, and the plugin asks it/u);
    expect(text).toMatch(/Dismiss as not used: only when the owner answered with it on that ticket's decide item/u);
    expect(text).toMatch(/re-read each of that decision's alerts on GitHub first and skip any already fixed or dismissed/u);
    expect(text).toMatch(/re-read `\/repos\/acme\/web\/dependabot\/alerts\/23` first and skip it if it is already fixed or dismissed; otherwise `gh api -X PATCH \/repos\/acme\/web\/dependabot\/alerts\/23 -f state=dismissed -f dismissed_reason=not_used/u);
    expect(text).toMatch(/alerts\/24/u);
    expect(text).toMatch(/Keep tracking: keep the ticket open and unadopted/u);
    expect(depsWake(depsFinding())).not.toMatch(/### Adoption decisions/u);
  });

  it("does not offer or describe Dismiss when the playbook's may list lacks dismiss-alert", () => {
    const withoutDismiss = DEPS_ALERTS.replace(", dismiss-alert]", "]");
    expect(withoutDismiss).not.toMatch(/dismiss-alert/u);
    const text = decisionsWake([decision()], withoutDismiss);
    expect(text).not.toMatch(/Dismiss as not used/u);
    expect(text).not.toMatch(/gh api -X PATCH/u);
    expect(text).toMatch(/Adopt: the ticket is labelled and moved to Todo/u);
  });

  it("says unassigned and the dedup note when the login or the search is unavailable", () => {
    const ops = opsWake(opsFinding({ assignee: "unassigned", dedupUnavailable: true }));
    expect(ops).toMatch(/Assignee: unassigned \(login unreadable\)/u);
    expect(ops).toMatch(/Dedup unavailable/u);
    expect(ops).toMatch(/linear_search/u);
    expect(depsWake(depsFinding({ assignee: "unassigned", dedupUnavailable: true }))).toMatch(/Dedup unavailable/u);
  });
});

describe("initiative progress (BB-243)", () => {
  const description = [
    "## Outcome",
    "",
    "The year's claim is filed.",
    "",
    "## Criteria",
    "",
    "- [ ] Scope memo approved (owner)",
    "- [ ] Expenses gathered (check: npm run expenses)",
    "- [ ] Claim filed (owner)",
    "",
    "## Signals",
    "",
    "The progress file.",
  ].join("\n");
  const initiative = (over: Partial<EntitySnapshot> = {}) => issue({ labels: ["bb-managed", "initiative"], description, ...over });
  const met = (text: string, id = text) => comment({ id, body: `**Met:** ${text}` });

  it("counts distinct Met: comments against the description's criteria", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: initiative({ comments: [met("Scope memo approved (owner)"), met("Expenses gathered (check: npm run expenses)")] }), pulls: [] } });
    expect(initiativeProgress(b)).toEqual({ met: 2, criteria: 3, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria 2/3");
  });

  it("counts a criterion once when its Met: comment repeats", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: initiative({ comments: [met("Scope memo approved (owner)", "c1"), met("scope   memo approved (owner)", "c2")] }), pulls: [] } });
    expect(initiativeProgress(b)).toEqual({ met: 1, criteria: 3, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria 1/3");
  });

  it("counts the criteria a signed, evidenced Met: comment names, never above the checklist", () => {
    const { s, bind } = world();
    const signed = (id: string, text: string) => comment({ id, body: `**Met:** ${text}\n\n_— from bb thread thr_steward_` });
    const b = s.patch(bind("ENG-12").id, {
      lastSnapshot: {
        entity: initiative({
          comments: [signed("c1", "Scope memo approved (owner)"), signed("c2", "Scope memo approved — see docs/memo.md"), signed("c3", "Expenses gathered (check: npm run expenses)"), signed("c4", "Claim filed (owner)")],
        }),
        pulls: [],
      },
    });
    expect(initiativeProgress(b)).toEqual({ met: 3, criteria: 3, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria 3/3");
  });

  it("shows unknown, never 0, when no Met: comment can be read", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: initiative({ comments: [] }), pulls: [] } });
    expect(initiativeProgress(b)).toEqual({ met: null, criteria: 3, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria unknown");
  });

  it("shows a lower bound when the snapshot held a full page of comments", () => {
    const { s, bind } = world();
    const comments = Array.from({ length: 50 }, (_, i) => (i < 2 ? comment({ id: `c${i}`, body: `**Met:** ${i === 0 ? "Scope memo approved" : "Expenses gathered"}` }) : comment({ id: `c${i}`, body: `**Note:** noise ${i}` })));
    const b = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: initiative({ comments }), pulls: [] } });
    expect(initiativeProgress(b)).toEqual({ met: 2, criteria: 3, capped: true });
    expect(initiativeProgressFlag(b)).toBe("criteria ≥2/3");
  });

  it("shows met without a criteria count when the description has no criteria section", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: initiative({ description: "## Outcome\n\nJust an outcome.", comments: [met("Something")] }), pulls: [] } });
    expect(initiativeProgress(b)).toEqual({ met: 1, criteria: null, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria 1");
  });

  it("knows an initiative by its playbook before the first snapshot, and shows unknown", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { playbook: "initiative" });
    expect(initiativeProgress(b)).toEqual({ met: null, criteria: null, capped: false });
    expect(initiativeProgressFlag(b)).toBe("criteria unknown");
  });

  it("is null for a ticket without the initiative label, and for a non-ticket", () => {
    const { s, bind } = world();
    const plain = s.patch(bind("ENG-12").id, { lastSnapshot: { entity: issue({ comments: [met("Something")] }), pulls: [] } });
    expect(initiativeProgress(plain)).toBeNull();
    expect(initiativeProgressFlag(plain)).toBeNull();
    expect(initiativeProgress({ ...plain, kind: "pr" })).toBeNull();
  });

  it("rides on the project steward's binding list and digest lines", () => {
    const { s, bind } = world();
    const b = s.patch(bind("ENG-12").id, { status: status("Driving the initiative."), advancedAt: T - 3_600_000, lastSnapshot: { entity: initiative({ comments: [met("Scope memo approved (owner)"), met("Claim filed (owner)")] }), pulls: [] } });
    const records: DigestRecords = { previous: null, since: T - DAY, moved: [b], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [b], stall: [], held: [b] };
    const wake = formatProjectWake({ reason: "nightly", bindings: [{ binding: b, openEscalations: [] }], routed: [], problems: [], digestDue: true, notes: [], bigDecisions: [], questions: [], records });
    expect(wake).toContain("- ENG-12 (ticket, In Progress): Driving the initiative. Next: Open the PR (steward) [criteria 2/3]");
    expect(wake).toMatch(/- ENG-12 \(ticket, In Progress\), moved .*\[criteria 2\/3\]/u);
    expect(wake).toMatch(/- ENG-12: on hold: .*\[criteria 2\/3\]/u);
    expect(wake).toMatch(/- ENG-12 \(ticket, In Progress\): waiting with no wake source.*\[criteria 2\/3\]/u);
  });
});

describe("recorded assumptions (BB-251)", () => {
  const assumption = (over: Partial<Assumption> = {}): Assumption => ({ id: "asm_1", projectId: "p1", bindingId: "bnd_1", text: "SSO is out of scope", context: "the spec does not name it", recordedBy: "thr_s", recordedAt: T, state: "open", answer: null, resolvedBy: null, resolvedAt: null, ...over });

  it("carries the open assumptions in their own section of the binding's wake", () => {
    const wake = formatWake(wakeInput({ assumptions: [assumption()] }));
    expect(wake).toContain("## Assumptions (open)");
    expect(wake).toContain("Assuming: SSO is out of scope");
    expect(wake).toContain("the spec does not name it");
    expect(wake).toContain('steward_update { confirm: "<id>" }');
    // With none open, the section is absent.
    expect(formatWake(wakeInput({ assumptions: [] }))).not.toContain("## Assumptions (open)");
  });

  it("names them in the project steward's wake and digest", () => {
    const { s, bind } = world();
    const binding = bind("ENG-12");
    const rows = [{ assumption: assumption({ bindingId: binding.id }), binding }];
    const wake = formatProjectWake({ reason: "nightly", bindings: [{ binding, openEscalations: [] }], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], assumptions: rows });
    expect(wake).toContain("## Assumptions (open)");
    expect(wake).toContain("Assuming: SSO is out of scope");
    const records: DigestRecords = { previous: null, since: T, moved: [], ended: [], answered: [], withUser: [], stuck: [], noWakeSource: [], stall: [], held: [], assumptions: rows };
    const digest = formatRecords(records, []).join("\n");
    expect(digest).toContain("### Assumptions (open)");
    expect(digest).toContain("Assuming: SSO is out of scope");
    expect(digest).toContain("asm_1");
    // A project-level assumption has no binding and reads as `project`.
    const projectRow = [{ assumption: assumption({ bindingId: null }), binding: null }];
    const projectWake = formatProjectWake({ reason: "nightly", bindings: [], routed: [], problems: [], digestDue: false, notes: [], bigDecisions: [], assumptions: projectRow });
    expect(projectWake).toContain("project: Assuming: SSO is out of scope");
    const projectDigest = formatRecords({ ...records, assumptions: projectRow }, []).join("\n");
    expect(projectDigest).toContain("project: Assuming: SSO is out of scope");
  });
});

describe("the per-turn brief cap (BB-254)", () => {
  /** A brief input for one shipped playbook, with three guidance entries and a hold. */
  function briefInputFor(name: string, text: string, over: { phase?: string | null; guidance?: number; firstGuidance?: string; lastGuidance?: string } = {}) {
    const { s } = world();
    const parsed = parsePlaybook(text, name);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
    const playbook = parsed.value;
    const source = playbook.kind === "ops" ? ("ops" as const) : playbook.source === "linear" ? ("linear" as const) : ("github" as const);
    const base = s.create({
      projectId: "p1",
      source,
      entityId: name,
      entityKey: "ENG-1",
      url: null,
      title: "An entity",
      kind: playbook.kind,
      playbook: name,
      playbookVersion: "v1",
      parentBindingId: null,
      phase: over.phase !== undefined ? over.phase : (Object.keys(playbook.sections)[0] ?? null),
      stage: null,
    });
    const count = over.guidance ?? 3;
    const guidance = Array.from({ length: count }, (_, i) => ({
      at: T,
      by: "owner",
      text: i === 0 && over.firstGuidance !== undefined ? over.firstGuidance : i === count - 1 && over.lastGuidance !== undefined ? over.lastGuidance : `Guidance entry ${i}: do the thing carefully and report.`,
    }));
    const binding = { ...base, guidance, hold: "waiting on a decision" };
    return { playbook, input: { binding, playbook, gate: gateState(playbook, binding.ready, ""), workerFlags: "--provider claude-code --model claude-opus-5-5 --reasoning-level high" } };
  }

  it("carries the whole phase and general section of every shipped playbook at the cap", () => {
    for (const [name, text] of Object.entries(PLAYBOOK_TEMPLATES)) {
      const parsed = parsePlaybook(text, name);
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
      const phases = Object.keys(parsed.value.sections);
      // A playbook with no phase sections is tested once, with no phase.
      for (const phase of phases.length === 0 ? [null] : phases) {
        const { playbook, input } = briefInputFor(name, text, { phase });
        const brief = formatBrief(input, BRIEF_MAX_CHARS);
        // No clipping: the capped and uncapped renders are identical.
        expect(brief, `${name}@${phase ?? "none"}`).toBe(formatBrief(input));
        expect(brief, `${name}@${phase ?? "none"}`).toContain(playbook.general);
        if (phase !== null) expect(brief, `${name}@${phase}`).toContain(playbook.sections[phase]!);
      }
    }
  });

  it("clips the middle first when a brief is over the cap, keeping the prefix and the steward_report tail", () => {
    const { input } = briefInputFor("linear-tickets", LINEAR_TICKETS, { firstGuidance: "x".repeat(40_000), lastGuidance: "SENTINEL_LAST_GUIDANCE" });
    const full = formatBrief(input);
    expect(full.length).toBeGreaterThan(BRIEF_MAX_CHARS);
    expect(full).toContain("SENTINEL_LAST_GUIDANCE");
    const brief = formatBrief(input, BRIEF_MAX_CHARS);
    expect(brief.startsWith(BRIEF_PREFIX)).toBe(true);
    const lines = brief.split("\n");
    expect(lines[lines.length - 1]).toMatch(/^End your turn with steward_report; requeueAfter defaults to /u);
    // The middle gave way, not the head or the tail.
    expect(brief).toContain("… (");
    expect(brief).not.toContain("SENTINEL_LAST_GUIDANCE");
    expect(brief).toContain(STANDING_RULES[0]!);
  });
});
