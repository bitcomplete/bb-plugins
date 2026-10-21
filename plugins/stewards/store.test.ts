import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BASE_MIGRATIONS, CHAIN_MIGRATIONS, LESSON_COUNTER_MIGRATIONS, MIGRATIONS, createStore, lessonScope } from "./store.js";

function store() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  let now = 1_000;
  const s = createStore(db, () => now);
  const binding = s.create({ projectId: "p1", source: "linear", entityId: "uuid-12", entityKey: "ENG-12", url: null, title: "Fix login", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
  return { s, binding, advance: (ms: number) => (now += ms) };
}

describe("questions to the user", () => {
  it("are kept from ask to answer, and an answered one is never open again", () => {
    const { s, binding, advance } = store();
    const q = s.ask({ projectId: "p1", bindingId: binding.id, escalationId: null, question: "File an a11y ticket?", context: "Seen in review." });
    expect(q).toMatchObject({ id: expect.stringMatching(/^qst_/u), projectId: "p1", bindingId: binding.id, status: "open", answer: null, createdAt: 1_000 });
    const unbound = s.ask({ projectId: "p1", bindingId: null, escalationId: null, question: "Freeze on Friday?", context: null });
    expect(s.openQuestions("p1").map((x) => x.id)).toEqual([q.id, unbound.id]);
    expect(s.openQuestions("p2")).toEqual([]);

    advance(500);
    expect(s.answer(q.id, "Yes, file it.", "thr_project")).toBe(true);
    expect(s.answer(q.id, "Again", "thr_project")).toBe(false);
    expect(s.question(q.id)).toMatchObject({ status: "answered", answer: "Yes, file it.", answeredBy: "thr_project", resolvedAt: 1_500 });
    expect(s.openQuestions("p1").map((x) => x.id)).toEqual([unbound.id]);
    expect(s.answeredSince("p1", 1_200).map((x) => x.id)).toEqual([q.id]);
    expect(s.answeredSince("p1", 1_600)).toEqual([]);
  });

  it("made by forwarding an escalation, closes with it either way round", () => {
    const { s, binding } = store();
    const ask = () => {
      const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "Include SSO?", meanwhile: "Wait.", route: "me", recommendation: null });
      return { x, q: s.ask({ projectId: "p1", bindingId: binding.id, escalationId: x.id, question: x.question, context: null }) };
    };

    // Resolving the escalation, from anywhere (here the binding ending), closes the question.
    const first = ask();
    expect(s.resolve(first.x.id, "The binding ended.")).toBe(true);
    expect(s.question(first.q.id)).toMatchObject({ status: "answered", answer: "The binding ended.", answeredBy: "plugin" });

    // Closing the question resolves the escalation.
    const second = ask();
    expect(s.answer(second.q.id, "No SSO.", "user")).toBe(true);
    expect(s.escalation(second.x.id)).toMatchObject({ status: "resolved", resolution: "No SSO." });
    expect(s.resolve(second.x.id, "late")).toBe(false);
    expect(s.openQuestions("p1")).toEqual([]);
  });
});

describe("the fingerprint map", () => {
  const ops = (s: ReturnType<typeof store>["s"], projectId = "p1") =>
    s.create({ projectId, source: "ops", entityId: "k8s-namespace/prod", entityKey: "k8s-namespace/prod", url: null, title: "Ops watch: prod", kind: "ops", playbook: "ops-watch", playbookVersion: "v1", parentBindingId: null, phase: "watching", stage: null });
  const fp = "k8s-namespace/prod/web/app#CrashLoopBackOff:Error:1";

  it("enters a problem on first sight with no ticket, and counts each sighting after", () => {
    const { s, advance } = store();
    const b = ops(s);
    const first = s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes" }]);
    expect(first.get(fp)).toMatchObject({ fingerprint: fp, bindingId: b.id, ticketKey: null, firstSeenAt: 1_000, lastSeenAt: 1_000, seenCount: 1, filedAt: null, lastCommentedAt: null });
    advance(60_000);
    const again = s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes, 9 restarts" }]);
    expect(again.get(fp)).toMatchObject({ ticketKey: null, firstSeenAt: 1_000, lastSeenAt: 61_000, seenCount: 2, summary: "web crashes, 9 restarts" });
    expect(s.fingerprints(b.id).map((f) => f.fingerprint)).toEqual([fp]);
  });

  it("points a problem at the ticket filed for it, and a comment moves only the last word", () => {
    const { s, advance } = store();
    const b = ops(s);
    s.sight("p1", b.id, [{ fingerprint: fp, summary: "web crashes" }]);
    expect(s.recordTicket("p1", "k8s-namespace/prod/other#x", "OPS-1", "filed")).toBe(false);
    advance(1_000);
    expect(s.recordTicket("p1", fp, "ops-7", "filed")).toBe(true);
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-7", filedAt: 2_000, lastCommentedAt: 2_000 });
    advance(1_000);
    s.recordTicket("p1", fp, "OPS-7", "commented");
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-7", filedAt: 2_000, lastCommentedAt: 3_000 });
    // Back after OPS-7 was closed, filed anew: the next sighting is OPS-9's.
    advance(1_000);
    s.recordTicket("p1", fp, "OPS-9", "filed");
    expect(s.fingerprint("p1", fp)).toMatchObject({ ticketKey: "OPS-9", filedAt: 4_000 });
    // Another project's map is its own.
    expect(s.fingerprint("p2", fp)).toBeNull();
  });

  it("keeps an ops binding's last look", () => {
    const { s } = store();
    const b = ops(s);
    expect(b).toMatchObject({ source: "ops", kind: "ops", opsLook: null, lastSnapshot: null });
    const look = { at: 5, target: "k8s-namespace/prod", error: "403: forbidden", pods: 0, healthy: 0, deployments: [], warnings: [], logs: "unneeded" as const, notes: [], findings: [] };
    expect(s.patch(b.id, { opsLook: look }).opsLook).toEqual(look);
  });
});

describe("needs you items", () => {
  it("are deduplicated by (binding, kind, url) while open, and close once", () => {
    const { s, binding, advance } = store();
    const first = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret", how: "Settings → API", filedBy: "steward" });
    expect(first).toMatchObject({ id: expect.stringMatching(/^need_/u), kind: "configure", status: "open", filedBy: "steward", createdAt: 1_000 });
    // The same key updates the wording rather than adding a row.
    advance(10);
    const again = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret (new wording)", how: null, filedBy: "steward" });
    expect(again.id).toBe(first.id);
    expect(s.openNeeds(binding.id)).toHaveLength(1);
    expect(s.openNeeds(binding.id)[0]!.what).toBe("Add the client secret (new wording)");
    // A different url is a different item.
    s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/agent", what: "Install the agent", how: null, filedBy: "steward" });
    expect(s.openNeeds(binding.id)).toHaveLength(2);
    // Closing it lets the same key be filed again as a new row.
    expect(s.closeNeed(first.id, "done")).toBe(true);
    expect(s.closeNeed(first.id, "again")).toBe(false);
    expect(s.needs(binding.id, true).filter((n) => n.kind === "configure")).toHaveLength(2);
    const refiled = s.fileNeed({ bindingId: binding.id, kind: "configure", url: "https://linear.app/secret", what: "Add the client secret again", how: null, filedBy: "steward" });
    expect(refiled.id).not.toBe(first.id);
    expect(s.needs(binding.id, true)).toHaveLength(3);
  });
});

describe("lessons", () => {
  it("are recorded pending with their source, and resolved once", () => {
    const { s, binding, advance } = store();
    const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "New column?", meanwhile: "Wait.", route: "project", recommendation: null });
    const lesson = s.addLesson({ projectId: "p1", bindingId: binding.id, escalationId: x.id, file: "stewards/linear-tickets.md", text: "A new column read with SELECT * breaks the previous image.", scope: "procedure", branch: "refs/heads/guidance-thr_project" });
    expect(lesson).toMatchObject({
      id: expect.stringMatching(/^lsn_/u),
      projectId: "p1",
      bindingId: binding.id,
      escalationId: x.id,
      file: "stewards/linear-tickets.md",
      scope: "procedure",
      status: "pending",
      branch: "refs/heads/guidance-thr_project",
      mergeSha: null,
      createdAt: 1_000,
      resolvedAt: null,
    });
    expect(s.lessons("p1").map((l) => l.id)).toEqual([lesson.id]);
    expect(s.lessons("p2")).toEqual([]);
    expect(s.lessons("p1", true)).toHaveLength(1);

    advance(500);
    s.markLessonMerged(lesson.id, "a".repeat(40), "refs/heads/guidance-thr_project");
    expect(s.lesson(lesson.id)).toMatchObject({ status: "merged", mergeSha: "a".repeat(40), resolvedAt: 1_500 });
    expect(s.lessons("p1")).toEqual([]);
    expect(s.lessons("p1", true)).toHaveLength(1);
    expect(s.mergedLessonsSince("p1", 1_400).map((l) => l.id)).toEqual([lesson.id]);
    expect(s.mergedLessonsSince("p1", 1_600)).toEqual([]);

    // Marking it merged again is idempotent and does not move resolved_at.
    s.markLessonMerged(lesson.id, "b".repeat(40), null);
    expect(s.lesson(lesson.id)).toMatchObject({ status: "merged", mergeSha: "b".repeat(40), resolvedAt: 1_500 });
  });

  it("are dropped with a note, and a dropped one is never pending again", () => {
    const { s, binding } = store();
    const lesson = s.addLesson({ projectId: "p1", bindingId: binding.id, escalationId: null, file: "AGENTS.md", text: "Who may direct a server.", scope: "boundary", branch: null });
    s.setLessonBranch(lesson.id, "refs/heads/guidance-thr_project");
    s.noteLesson(lesson.id, "Refused: changes files other than AGENTS.md.");
    expect(s.lesson(lesson.id)).toMatchObject({ branch: "refs/heads/guidance-thr_project", note: "Refused: changes files other than AGENTS.md." });
    s.markLessonDropped(lesson.id, "Dropped on the Stewards page.");
    expect(s.lesson(lesson.id)).toMatchObject({ status: "dropped", resolvedAt: expect.any(Number) });
    expect(s.lessons("p1")).toEqual([]);
  });
});

describe("lesson citation counts (BB-35 step 2)", () => {
  const second = (s: ReturnType<typeof store>["s"]) =>
    s.create({ projectId: "p1", source: "linear", entityId: "uuid-13", entityKey: "ENG-13", url: null, title: "Other", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
  const lesson = (s: ReturnType<typeof store>["s"], projectId = "p1") => s.addLesson({ projectId, bindingId: null, escalationId: null, file: "AGENTS.md", text: "A rule.", scope: "procedure", branch: null });

  it("count hits once per distinct binding, refresh lastCitedAt, and ignore unknown ids", () => {
    const { s, binding, advance } = store();
    const l = lesson(s);
    const other = second(s);
    expect(l).toMatchObject({ hits: 0, corrections: 0, lastCitedAt: null, citedBindings: [] });

    const first = s.recordCitations("p1", [l.id], binding.id);
    expect(first.unknown).toEqual([]);
    expect(first.cited).toMatchObject([{ id: l.id, hits: 1, lastCitedAt: 1_000, citedBindings: [binding.id] }]);

    // The same binding again is not a new hit, but it does refresh the time.
    advance(500);
    expect(s.recordCitations("p1", [l.id], binding.id).cited).toMatchObject([{ hits: 1, lastCitedAt: 1_500 }]);

    // A different binding is a second hit.
    advance(500);
    expect(s.recordCitations("p1", [l.id], other.id).cited).toMatchObject([{ hits: 2, citedBindings: [binding.id, other.id] }]);

    // Unknown and other-project ids never count.
    const stranger = lesson(s, "p2");
    const unknown = s.recordCitations("p1", ["lsn_nope", stranger.id], binding.id);
    expect(unknown).toEqual({ cited: [], unknown: ["lsn_nope", stranger.id] });
    expect(s.lesson(stranger.id)).toMatchObject({ hits: 0 });

    // A citation with no binding counts once for the project.
    expect(s.recordCitations("p1", [l.id], null).cited).toMatchObject([{ hits: 3, citedBindings: [binding.id, other.id, "project:p1"] }]);
    expect(s.recordCitations("p1", [l.id], null).cited).toMatchObject([{ hits: 3 }]);
  });

  it("count corrections once each, and keep them on the escalation's citations", () => {
    const { s, binding } = store();
    const l = lesson(s);
    const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "Q", meanwhile: "m", route: "me", recommendation: "Do it." });
    expect(s.escalation(x.id)).toMatchObject({ citedLessons: [], correctionsCounted: false });
    s.setEscalationCitations(x.id, [l.id, l.id]);
    expect(s.escalation(x.id)).toMatchObject({ citedLessons: [l.id] });
    s.recordCorrections([l.id, l.id]);
    expect(s.lesson(l.id)).toMatchObject({ corrections: 1 });
    s.recordCorrections([l.id]);
    expect(s.lesson(l.id)).toMatchObject({ corrections: 2 });
    s.markEscalationCorrected(x.id);
    expect(s.escalation(x.id)).toMatchObject({ correctionsCounted: true });
  });

  it("fails closed: a lesson with no scope or an unknown one reads as boundary", () => {
    expect(lessonScope(null)).toBe("boundary");
    expect(lessonScope(undefined)).toBe("boundary");
    expect(lessonScope("procedure")).toBe("procedure");
    expect(lessonScope("anything-else")).toBe("boundary");
  });

  it("migrates losslessly: an existing lesson keeps its values and gets the counters at zero", () => {
    const db = new Database(":memory:");
    for (const sql of BASE_MIGRATIONS) db.exec(sql);
    for (const sql of CHAIN_MIGRATIONS) db.exec(sql);
    db.exec(`INSERT INTO bindings (id, project_id, source, entity_id, entity_key, kind, playbook, playbook_version, created_at)
             VALUES ('bnd_1', 'p1', 'linear', 'uuid-12', 'ENG-12', 'ticket', 'linear-tickets', 'v1', 1000)`);
    db.exec(`INSERT INTO lessons (id, project_id, binding_id, escalation_id, file, text, scope, status, branch, merge_sha, note, created_at, updated_at, resolved_at)
             VALUES ('lsn_old', 'p1', 'bnd_1', NULL, 'AGENTS.md', 'An old rule.', 'boundary', 'pending', 'refs/heads/guidance-thr_x', NULL, 'kept', 1000, 1100, NULL)`);
    for (const sql of LESSON_COUNTER_MIGRATIONS) db.exec(sql);
    const s = createStore(db, () => 2000);
    expect(s.lesson("lsn_old")).toMatchObject({
      id: "lsn_old",
      projectId: "p1",
      bindingId: "bnd_1",
      file: "AGENTS.md",
      text: "An old rule.",
      scope: "boundary",
      status: "pending",
      branch: "refs/heads/guidance-thr_x",
      note: "kept",
      createdAt: 1_000,
      updatedAt: 1_100,
      hits: 0,
      corrections: 0,
      lastCitedAt: null,
      citedBindings: [],
    });
    // The old columns are all still there; nothing was dropped or renamed.
    const columns = (db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["id", "project_id", "binding_id", "escalation_id", "file", "text", "scope", "status", "branch", "merge_sha", "note", "created_at", "updated_at", "resolved_at", "hits", "corrections", "last_cited_at", "cited_bindings"]));
  });
});

describe("the escalation-chain migration (BB-30)", () => {
  function legacy() {
    const db = new Database(":memory:");
    for (const sql of BASE_MIGRATIONS) db.exec(sql);
    db.exec(`INSERT INTO bindings (id, project_id, source, entity_id, entity_key, kind, playbook, playbook_version, created_at)
             VALUES ('bnd_1', 'p1', 'linear', 'uuid-12', 'ENG-12', 'ticket', 'linear-tickets', 'v1', 1000)`);
    // A question with no linked escalation, answered, with choices.
    db.exec(`INSERT INTO questions (id, project_id, binding_id, escalation_id, question, context, status, answer, answered_by, created_at, resolved_at, choices)
             VALUES ('qst_open', 'p1', 'bnd_1', NULL, 'Ship on Friday?', 'A context.', 'open', NULL, NULL, 1000, NULL, NULL)`);
    db.exec(`INSERT INTO questions (id, project_id, binding_id, escalation_id, question, context, status, answer, answered_by, created_at, resolved_at, choices)
             VALUES ('qst_answered', 'p1', NULL, NULL, 'File an a11y ticket?', NULL, 'answered', 'Yes, file it.', 'user', 1100, 1200, '["Yes","No"]')`);
    // A question forwarded from an escalation, answered; the escalation is open.
    db.exec(`INSERT INTO escalations (id, binding_id, kind, question, meanwhile, route, status, created_at)
             VALUES ('esc_1', 'bnd_1', 'decision', 'Include SSO?', 'Wait.', 'me', 'open', 1300)`);
    db.exec(`INSERT INTO questions (id, project_id, binding_id, escalation_id, question, context, status, answer, answered_by, created_at, resolved_at, choices)
             VALUES ('qst_forwarded', 'p1', 'bnd_1', 'esc_1', 'Include SSO?', NULL, 'answered', 'Yes, include SSO.', 'user', 1300, 1400, NULL)`);
    // Steward-filed needs of each kind, open and answered.
    db.exec(`INSERT INTO needs (id, binding_id, kind, url, what, how, data, filed_by, status, resolution, created_at, resolved_at)
             VALUES ('need_decide', 'bnd_1', 'decide', 'https://x/1', 'Merge or close?', NULL, '{"choices":["Merge","Close"]}', 'steward', 'open', NULL, 1500, NULL)`);
    db.exec(`INSERT INTO needs (id, binding_id, kind, url, what, how, data, filed_by, status, resolution, created_at, resolved_at)
             VALUES ('need_config', 'bnd_1', 'configure', '', 'Enable SSO on the page.', 'Steps.', '{"page":"https://x/page"}', 'steward', 'done', 'Done.', 1600, 1700)`);
    db.exec(`INSERT INTO needs (id, binding_id, kind, url, what, how, data, filed_by, status, resolution, created_at, resolved_at)
             VALUES ('need_secret', 'bnd_1', 'provide-secret', 'https://x/thread', 'Provide API_TOKEN.', NULL, '{"variable":"API_TOKEN","purpose":"deploys","setting":"githubToken"}', 'steward', 'open', NULL, 1800, NULL)`);
    // A plugin-filed gate item stays in needs.
    db.exec(`INSERT INTO needs (id, binding_id, kind, url, what, how, data, filed_by, status, resolution, created_at, resolved_at)
             VALUES ('need_approve', 'bnd_1', 'approve-pr', 'https://github.com/acme/web/pull/7', 'Approve the PR.', NULL, '{}', 'plugin', 'open', NULL, 1900, NULL)`);
    for (const sql of CHAIN_MIGRATIONS) db.exec(sql);
    for (const sql of LESSON_COUNTER_MIGRATIONS) db.exec(sql);
    let now = 2000;
    return { db, s: createStore(db, () => now) };
  }

  it("carries every question into escalations with its answer, and renames the old table", () => {
    const { db, s } = legacy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions_legacy'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions'").get()).toBeUndefined();

    expect(s.question("qst_open")).toMatchObject({ status: "open", answer: null, question: "Ship on Friday?", context: "A context." });
    expect(s.question("qst_answered")).toMatchObject({ status: "answered", answer: "Yes, file it.", answeredBy: "user", choices: ["Yes", "No"] });
    expect(s.question("qst_forwarded")).toMatchObject({ status: "answered", answer: "Yes, include SSO.", escalationId: "esc_1" });
    // The escalation a forwarded question answered is resolved with that answer.
    expect(s.escalation("esc_1")).toMatchObject({ status: "resolved", resolution: "Yes, include SSO." });
    expect(s.openQuestions("p1").map((q) => q.id)).toEqual(["qst_open"]);
  });

  it("carries every steward-filed need into escalations with its answer, and keeps the plugin gate item in needs", () => {
    const { db, s } = legacy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='needs_legacy'").get()).toBeDefined();

    expect(s.need("need_decide")).toMatchObject({ kind: "decide", status: "open", what: "Merge or close?", data: { choices: ["Merge", "Close"] } });
    expect(s.need("need_config")).toMatchObject({ kind: "configure", status: "done", resolution: "Done." });
    expect(s.need("need_secret")).toMatchObject({ kind: "provide-secret", status: "open", data: { variable: "API_TOKEN", setting: "githubToken" } });

    const migrated = s.escalation("need_decide")!;
    expect(migrated).toMatchObject({ resolutionKind: "choice", projectId: "p1", route: "me" });
    expect(s.escalation("need_secret")).toMatchObject({ resolutionKind: "secret", url: "https://x/thread" });
    // The gate item is still a need and not an escalation.
    expect(s.need("need_approve")).toMatchObject({ kind: "approve-pr", status: "open" });
    expect(s.escalation("need_approve")).toBeNull();
  });

  it("keeps a fresh database's needs table for gate items", () => {
    const { s, binding } = store();
    const need = s.fileNeed({ bindingId: binding.id, kind: "approve-pr", url: "https://github.com/acme/web/pull/7", what: "Approve.", how: null, data: {} });
    expect(s.need(need.id)).toMatchObject({ kind: "approve-pr" });
  });
});

describe("answers go straight to the originator (BB-30)", () => {
  it("records the answer verbatim as guidance on the originating binding, with who decided", () => {
    const { s, binding } = store();
    const other = s.create({ projectId: "p1", source: "linear", entityId: "uuid-13", entityKey: "ENG-13", url: null, title: "Other", kind: "ticket", playbook: "linear-tickets", playbookVersion: "v1", parentBindingId: null, phase: "Todo", stage: "spec" });
    const x = s.escalate({
      bindingId: binding.id,
      kind: "decision",
      question: "Include SSO?",
      meanwhile: "Wait.",
      route: "me",
      recommendation: null,
      origin: { threadId: "thr_worker", bindingId: binding.id, chain: [{ threadId: "thr_mid", bindingId: other.id, rewording: "Still include SSO?" }] },
    });
    expect(s.resolve(x.id, "Yes, include SSO.", "user")).toBe(true);
    // Verbatim, with who decided as the author.
    expect(s.binding(binding.id)!.guidance).toMatchObject([{ text: "Yes, include SSO.", by: "user" }]);
    // The binding between gets a quiet note only.
    expect(s.binding(other.id)!.pending).toMatchObject([{ text: expect.stringContaining("Yes, include SSO."), quiet: true }]);
    // One delivery is queued for the originating thread.
    expect(s.pendingDeliveries()).toMatchObject([{ originThreadId: "thr_worker", originBindingId: binding.id, text: "Yes, include SSO.", decidedBy: "user" }]);
    s.markDeliveryDone(s.pendingDeliveries()[0]!.id);
    expect(s.pendingDeliveries()).toEqual([]);
  });

  it("does not queue a delivery when the origin has no thread", () => {
    const { s, binding } = store();
    const x = s.escalate({ bindingId: binding.id, kind: "decision", question: "Q", meanwhile: "Wait.", route: "me", recommendation: null, origin: { threadId: null, bindingId: binding.id, chain: [] } });
    s.resolve(x.id, "Answer.", "project");
    expect(s.binding(binding.id)!.guidance).toMatchObject([{ text: "Answer.", by: "project" }]);
    expect(s.pendingDeliveries()).toEqual([]);
  });
});
