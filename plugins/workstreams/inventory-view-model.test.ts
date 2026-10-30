import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { APPROVAL_FEEDBACK_MIGRATION, createApprovalFeedbackStore } from "./approval-feedback.js";
import { REVIEWER } from "./ghactions.js";
import { inkwellInventory, inkwellInventoryPrs, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { createInventoryActions } from "./inventory-actions.js";
import { inventoryViewSchema, type InventoryRow, type InventoryView } from "./inventory-view.js";
import { DEFAULT_ATTENTION_THRESHOLDS, type AttentionReason } from "./pr-attention.js";
import type { Sent } from "./your-turn.js";
import { actionCall, onYourTurn, pickRows, sendable, INVENTORY_CHANGED, INVENTORY_HOW, inventoryLine, inventoryScreen, LOGIN, parseLogins, QUESTIONS, withOutcome, type InventoryLine, type Outcome,
  type Pending } from "./inventory-view-model.js";

const VIEW = inkwellInventory();
const screen = (view: InventoryView = VIEW, options: { filter?: Parameters<typeof inventoryScreen>[1]["filter"]; now?: number; pending?: Pending;
  outcomes?: ReadonlyMap<string, Outcome> } = {}) => inventoryScreen(view, { now: NOW, filter: null, ...options });
const lines = (view: InventoryView = VIEW) => screen(view).groups.flatMap((group) => group.lines.map((line) => ({ group: group.label, line })));
const find = (pr: string, view: InventoryView = VIEW): InventoryLine => lines(view).find(({ line }) => `${line.repo} #${line.number}` === pr)!.line;
const rowOf = (pr: string, view: InventoryView = VIEW): InventoryRow => view.groups.flatMap((group) => group.rows).find((row) => `${row.repo.split("/")[1]} #${row.number}` === pr)!;
const action = (line: InventoryLine, id: InventoryLine["actions"][number]["id"]) => line.actions.find((item) => item.id === id);
/** The fixture with one row changed, as the server would send it. */
const withRow = (pr: string, patch: Partial<InventoryRow>, view: InventoryView = VIEW): InventoryView => ({ ...view,
  groups: view.groups.map((group) => ({ ...group, rows: group.rows.map((row) => `${row.repo.split("/")[1]} #${row.number}` === pr ? { ...row, ...patch } : row) })) });
const reason = (patch: Partial<AttentionReason>): AttentionReason => ({ question: "needs-nudge", kind: "review-waiting", action: "nudge", nextStep: "Nudge @mira-l",
  owner: "reviewers", reviewers: ["mira-l"], since: NOW - 2 * 86_400_000, ageMs: 2 * 86_400_000, basis: "github", ...patch });

describe("the PR inventory screen: A13 acceptance shape", () => {
  it("reads the server's inventory shape, so the fixture can't drift from what inventory_get returns", () => {
    expect(inventoryViewSchema.parse(VIEW)).toEqual(VIEW);
  });

  // The live board's 14 "needs you" items, classified with no worker: each row's effort group, state word, next step, who owns it, and the
  // action it leads with. A row that moves group, changes owner, or offers another action here would send you to the wrong PR first.
  it("files each of the 17 PRs under its effort with its state word, next step, owner, and offered action", () => {
    const table = lines().map(({ group, line }) => [group, `${"  ".repeat(line.depth)}${line.repo} #${line.number}`, line.status,
      line.steps.map((step) => step.text).join(" + "), line.steps[0]?.owner.label ?? null, line.primary, line.primary && action(line, line.primary)!.enabled]);
    expect(table).toEqual([
      ["Shelf order", "folio #330", "Conflicts", "Resolve the conflicts", "you", "thread", true],
      // The approved stack merges in order: the parent now, each child once the one beneath it has merged.
      ["Shelf order", "folio #340", "Ready to merge", "Merge", "you", "merge", true],
      ["Shelf order", "  folio #341", "Behind #340", "Merge after #340", "you", "merge", false],
      ["Shelf order", "    folio #342", "Behind #341", "Merge after #341", "you", "merge", false],
      ["Shelf order", "      folio #343", "Behind #342", "Merge after #342", "you", "merge", false],
      ["Store pickup", "quill #210", "Conflicts", "Resolve the conflicts", "you", "thread", true],
      // Waiting on a parent whose own row asks for changes is not yours to act on.
      ["Store pickup", "  quill #212", "Behind #210", "Waits on #210", "#210", null, null],
      ["Store pickup", "quill #211", "Changes requested", "Address the requested changes", "you", "thread", true],
      ["Store pickup", "spine #155", "Changes requested", "Address the requested changes", "you", "thread", true],
      ["Store pickup", "  spine #156", "Behind #155", "Waits on #155", "#155", null, null],
      ["No effort", "atlas #410", "Conflicts", "Request a review + Resolve the conflicts", "you", "request-review", true],
      ["No effort", "catalog #96", "Awaiting review", "Nudge @mira-l, @theo-k", "reviewers", "nudge", true],
      // The one code-work row with no thread can't open one.
      ["No effort", "catalog #97", "Conflicts", "Resolve the conflicts", "you", "thread", false],
      // Approved, green, and clean, but the approvals left comments that only you can confirm handled before either merges.
      ["No effort", "folio #301", "Approval comment to address", "Answer the approval's comment", "you", "confirm-handled", true],
      ["No effort", "folio #305", "CI failing", "Request a review + Fix the failing checks", "you", "request-review", true],
      ["No effort", "folio #318", "Approval comment to address", "Answer the approval's comment", "you", "confirm-handled", true],
      ["No effort", "folio #325", "Conflicts", "Request a review + Resolve the conflicts", "you", "request-review", true],
    ]);
  });

  // Confirm handled is the one step between these two approvals and a merge. Through the action, store, and attention the server
  // composes, your confirmation of each moves it to Ready to merge with Merge…, and moves nothing else.
  it("moves folio #301 and #318 from an approval comment to address to mergeable, confirmed by you with no check, once you confirm each handled", async () => {
    const approvedWithComments = ["folio #301", "folio #318"];
    for (const pr of approvedWithComments) expect(action(find(pr), "merge")).toBeUndefined();
    const db = new Database(":memory:"); db.exec(APPROVAL_FEEDBACK_MIGRATION);
    const store = createApprovalFeedbackStore(db);
    const actions = createInventoryActions({ now: () => NOW, listed: () => true, hold: () => null, effortHold: async () => null, writer: () => null, lock: () => () => {},
      read: async (prUrl) => ({ ok: true, pr: inkwellInventoryPrs(store.get).find((pr) => pr.url === prUrl) ?? null }),
      attention: async (fresh) => inkwellInventory(store.get).groups.flatMap((group) => group.rows).find((row) => row.prUrl === fresh.url)!.attention,
      write: async () => { throw new Error("Confirming writes nothing to GitHub"); },
      // Each author replied after the approval, so one click may confirm it.
      handling: async (prUrl) => { const pr = inkwellInventoryPrs(store.get).find((item) => item.url === prUrl)!;
        return { ok: true, headOid: pr.headRefOid!, fingerprint: pr.approvalFeedback!.fingerprint!, sources: [],
          evidence: { since: new Date(NOW - 86_400_000).toISOString(), commits: 0, replies: 1, threads: { total: 0, resolved: 0 }, complete: true } }; },
      confirm: (prUrl, headOid, feedback, evidence) => { store.confirm(prUrl, feedback, headOid, NOW, evidence); }, record: async () => {},
      ask: async () => { throw new Error("Confirming asks no thread"); }, fix: async () => { throw new Error("Confirming asks no thread"); } });
    for (const pr of approvedWithComments) {
      // The row's click opens its notes; the confirm there binds to the head and notes the read showed.
      const call = actionCall(rowOf(pr), action(find(pr), "confirm-handled")!);
      if (call.kind !== "notes") throw new Error(`${pr} offers no confirmation`);
      expect(await actions.confirmHandled(call.prUrl, rowOf(pr).head!, rowOf(pr).feedbackFingerprint!)).toMatchObject({ ok: true });
    }
    const confirmed = inkwellInventory(store.get);
    for (const pr of approvedWithComments) {
      const line = find(pr, confirmed);
      // Ready on your word alone never reads as "Ready to merge", and your word can be taken back.
      expect([line.status, line.steps.map((step) => step.text), line.steps[0]!.owner.kind, line.primary])
        .toEqual(["Ready · your word", ["Merge"], "you", "merge"]);
      expect(line.actions.map((item) => [item.id, item.enabled])).toEqual([["revoke", true], ["merge", true], ["refresh", true], ["thread", false]]);
    }
    // A new head on #301 leaves your confirmation behind: it asks for its notes again. A worker's evidence for #318 replaces yours, and the
    // approval's comment waits on your answer again: the reviewer saw no reply.
    const pushed = withRow("folio #301", { head: "d".repeat(40), attention: rowOf("folio #301").attention,
      confirmation: { ...rowOf("folio #301", confirmed).confirmation!, current: false } }, confirmed);
    expect(find("folio #301", pushed)).toMatchObject({ status: "Approval comment to address", primary: "confirm-handled" });
    const mine = store.get("https://github.com/inkwell/folio/pull/318")!;
    store.save(mine.prUrl, "thr_worker", { attemptId: "worker-1", headOid: mine.headOid, fingerprint: mine.fingerprint, blockers: [],
      findings: mine.findings.map((finding) => ({ ...finding, resolution: "no-change-needed" as const, validation: { outcome: "passed" as const, detail: "Tests pass." } })) }, NOW);
    expect(find("folio #318", inkwellInventory(store.get))).toMatchObject({ status: "Approval comment to address", primary: "confirm-handled" });
    expect(action(find("folio #318", inkwellInventory(store.get)), "merge")).toBeUndefined();
    const others = (view: InventoryView) => lines(view).filter(({ line }) => !approvedWithComments.includes(`${line.repo} #${line.number}`))
      .map(({ group, line }) => [group, line.number, line.status, line.primary]);
    expect(others(confirmed)).toEqual(others(VIEW));
    expect(screen(confirmed).counts).toEqual(screen().counts);
    db.close();
  });

  it("counts 3 PRs missing a reviewer, each offering Request review with the repository's recent reviewers", () => {
    expect(screen().counts.map(({ label, count }) => [label, count])).toEqual([["Forgotten in draft", 0], ["Missing a reviewer", 3], ["Needs a nudge", 10]]);
    const missing = screen(VIEW, { filter: "missing-reviewer" }).groups.flatMap((group) => group.lines);
    expect(missing.map((line) => `${line.repo} #${line.number}`)).toEqual(["atlas #410", "folio #305", "folio #325"]);
    for (const line of missing) expect(action(line, "request-review")).toMatchObject({ enabled: true, label: "Request review…" });
    expect(rowOf("folio #325").suggestedReviewers).toEqual(["mira-l", "theo-k"]);
  });

  it("nudges exactly the two reviewers catalog #96 has waited on since Monday", () => {
    const line = find("catalog #96");
    expect(line.reviewers).toEqual([{ login: "mira-l", state: "requested" }, { login: "theo-k", state: "requested" }]);
    expect(line.steps).toMatchObject([{ owner: { kind: "reviewers" }, age: "2d" }]);
    expect(actionCall(rowOf("catalog #96"), action(line, "nudge")!)).toEqual({ kind: "rpc", method: "inventory_nudge",
      input: { prUrl: "https://github.com/inkwell/catalog/pull/96", reviewers: ["mira-l", "theo-k"] } });
  });

  it("shows why the two waiting rows wait: each parent's own row asks for changes, and #210's also conflicts", () => {
    for (const [child, parent] of [["quill #212", "quill #210"], ["spine #156", "spine #155"]] as const) {
      expect(find(child).steps[0]!.owner.kind).toBe("parent");
      expect(find(child).actions.filter((item) => item.enabled).map((item) => item.id)).toEqual(["refresh"]);
      expect(find(parent).reviewers.map((reviewer) => reviewer.state)).toEqual(["changes requested"]);
    }
    expect(find("quill #210").status).toBe("Conflicts");
  });

  it("links every code-work row to its existing thread, except catalog #97, which has none", () => {
    const code = lines().filter(({ line }) => line.primary === "thread" || line.steps.some((step) => /^(Resolve|Fix|Address)/u.test(step.text)));
    expect(code.map(({ line }) => `${line.repo} #${line.number}`)).toEqual(["folio #330", "quill #210", "quill #211", "spine #155", "atlas #410", "catalog #97",
      "folio #305", "folio #325"]);
    for (const { line } of code) {
      const open = action(line, "thread")!;
      if (line.number === 97) expect(open).toMatchObject({ enabled: false, why: "No thread is linked to this PR yet" });
      else expect(open).toMatchObject({ enabled: true, threadId: `thr_${line.repo}_${line.number}` });
    }
    // Where the work started shows too, when it isn't the thread working on it.
    expect(find("quill #210").threads.map((thread) => [thread.role, thread.id])).toEqual([["working", "thr_quill_210"], ["started", "thr_quill_210_plan"]]);
  });
});

describe("the PR inventory screen view model", () => {
  it("imports only types and Your turn's pure rule, so it can't compute attention or reach a server module", () => {
    const source = readFileSync(new URL("./inventory-view-model.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import (type )?.* from "(.+)";$/gmu)].map((match) => [match[2], match[1] === "type " ? "type" : "value"]);
    expect(imports).toEqual([["./inventory-view", "type"], ["./pr-attention", "type"], ["./effort-classify", "type"], ["./your-turn", "value"]]);
    // The server publishes this channel (inventory-get-server.test.ts pins its side), and the picker checks logins as gh would.
    expect(INVENTORY_CHANGED).toBe("inventory-changed");
    expect(LOGIN.source).toBe(REVIEWER.source);
  });

  it("filters rows to one question while its count and the others still count every row, and says so when none match", () => {
    const drafts = screen(VIEW, { filter: "forgotten-draft" });
    expect(drafts.groups).toEqual([]);
    expect(drafts.empty).toBe("No PR is forgotten in draft.");
    expect(drafts.counts.map((count) => [count.count, count.active])).toEqual([[0, true], [3, false], [10, false]]);
    // A child whose parent the filter hides stands on its own.
    const nudges = screen(withRow("folio #341", { attention: [reason({})] }), { filter: "needs-nudge" }).groups.find((group) => group.label === "Shelf order")!;
    expect(nudges.lines.map((line) => [line.number, line.depth])).toEqual([[330, 0], [340, 0], [341, 1]]);
  });

  // A row no question asks about yet still says what's next from its state word, so an authored row that needs you never reads blank,
  // and one that waits on reviewers says so instead of offering you a step.
  it("names the step a row's state word implies when no question asks about it yet, with who takes it and the action it leads with", () => {
    const cases: [Partial<InventoryRow>, string | null, string | null, string | null][] = [
      [{ status: "CI failing" }, "Fix the failing checks", "you", "thread"],
      [{ status: "Conflicts" }, "Resolve the conflicts", "you", "thread"],
      [{ status: "Branch behind" }, "Update the branch", "you", "thread"],
      [{ status: "Draft", draft: true }, "Finish the draft", "you", "thread"],
      [{ status: "2 open threads" }, "Resolve the open review threads", "you", "thread"],
      // Approval notes no one has confirmed handled hold the merge; reading them happens on GitHub, so no row button leads.
      [{ status: "Feedback verification needed" }, "Read the approval's notes and confirm they're handled", "you", null],
      [{ status: "New review feedback" }, "Read the new review feedback", "you", null],
      [{ status: "Verification needs recheck" }, "Recheck the approval's notes against the new head", "you", null],
      [{ status: "Status unknown" }, "Refresh to read it again", "you", "refresh"],
      [{ status: "Review history unknown" }, "Refresh to read it again", "you", "refresh"],
      [{ status: "Awaiting review", reviewers: { requested: ["mira-l", "theo-k"], reviewed: [] } }, "Waiting on @mira-l, @theo-k", "reviewers", null],
      [{ status: "Awaiting re-review" }, "Waiting on re-review", "reviewers", null],
      // Nothing here is anyone's step yet: the state word says what it waits on.
      [{ status: "Checks pending" }, null, null, null],
    ];
    for (const [patch, text, owner, primary] of cases) {
      // A PR with no feedback waiting on you, so only its state word speaks.
      const line = find("folio #301", withRow("folio #301", { attention: [], yourTurn: null, ...patch }));
      expect([patch.status, line.steps.map((step) => step.text)[0] ?? null, line.steps[0]?.owner.kind ?? null, line.primary])
        .toEqual([patch.status, text, owner, primary]);
    }
  });

  it("lists the reviewers asked now first, then each past reviewer once, with the word for their latest review", () => {
    const reviewed = [{ login: "mira-l", state: "APPROVED" }, { login: "otto-v", state: "COMMENTED" }, { login: "ines-v", state: "DISMISSED" },
      { login: "theo-k", state: "CHANGES_REQUESTED" }, { login: "lee-q", state: "A_NEW_STATE" }];
    // @Mira-L is asked again, so her older approval doesn't show beside the request.
    expect(find("folio #301", withRow("folio #301", { reviewers: { requested: ["Mira-L"], reviewed } })).reviewers).toEqual([
      { login: "Mira-L", state: "requested" }, { login: "otto-v", state: "commented" }, { login: "ines-v", state: "dismissed" },
      { login: "theo-k", state: "changes requested" }, { login: "lee-q", state: "reviewed" }]);
  });

  it("merges a stacked child in order only once it's approved: one still in review waits on its parent", () => {
    const line = find("folio #341", withRow("folio #341", { stage: "review" }));
    expect(line.steps).toMatchObject([{ text: "Waits on #340", owner: { kind: "parent", label: "#340" } }]);
    expect(line.actions.map((item) => item.id)).toEqual(["refresh", "thread"]);
  });

  it("still shows every row of a stack that loops back on itself", () => {
    const loop = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) =>
      row.number === 301 ? { ...row, stackedOn: 318 } : row.number === 318 ? { ...row, stackedOn: 301 } : row) })) };
    const none = screen(loop).groups.find((group) => group.label === "No effort")!;
    expect(none.lines.map((line) => line.number).sort()).toEqual(VIEW.groups.at(-1)!.rows.map((row) => row.number).sort());
  });

  it("says what an empty inventory means: nothing open, or GitHub not read yet", () => {
    expect(screen({ ...VIEW, groups: [] }).empty).toBe("No open PRs you author or an effort names.");
    expect(screen({ ...VIEW, groups: [], checkedAt: null }).empty).toBe("GitHub hasn't been read yet; the first read lists your open PRs.");
  });

  it("offers Mark ready on a forgotten draft, pinned to the head its row showed, and explains when no head is known", () => {
    const draft = reason({ question: "forgotten-draft", kind: "draft-ready", action: "mark-ready", nextStep: "Mark ready for review", owner: "you", reviewers: [] });
    const view = withRow("folio #325", { draft: true, attention: [draft] });
    const markReady = action(find("folio #325", view), "mark-ready")!;
    expect(markReady).toMatchObject({ enabled: true, label: "Mark ready" });
    expect(actionCall(rowOf("folio #325", view), markReady)).toEqual({ kind: "rpc", method: "inventory_mark_ready",
      input: { prUrl: "https://github.com/inkwell/folio/pull/325", headOid: rowOf("folio #325").head } });
    expect(action(find("folio #325", withRow("folio #325", { draft: true, attention: [draft], head: null })), "mark-ready"))
      .toMatchObject({ enabled: false, why: "No head commit read yet; Refresh first" });
    // Like every write, it waits for the action already running on the PR and for GitHub's rate limit.
    const busy = screen(view, { pending: new Map([["https://github.com/inkwell/folio/pull/325", "refresh"]]) }).groups.flatMap((group) => group.lines)
      .find((line) => line.number === 325)!;
    expect(action(busy, "mark-ready")).toMatchObject({ enabled: false, why: "Another action on this PR is running" });
    expect(action(screen({ ...view, rateLimitedUntil: NOW + 60_000 }).groups.flatMap((group) => group.lines).find((line) => line.number === 325)!, "mark-ready"))
      .toMatchObject({ enabled: false, why: expect.stringMatching(/^GitHub's rate limit holds reads until/u) });
  });

  it("sends a review request with the reviewers the row showed, so a change since is refused rather than overwritten", () => {
    const line = find("folio #325");
    expect(actionCall(rowOf("folio #325"), action(line, "request-review")!, ["mira-l"])).toEqual({ kind: "rpc", method: "inventory_request_review",
      input: { prUrl: "https://github.com/inkwell/folio/pull/325", logins: ["mira-l"], shown: rowOf("folio #325").reviewers } });
    expect(actionCall(rowOf("folio #325"), action(line, "request-review")!, [])).toEqual({ kind: "refuse", why: "Pick or type a reviewer first" });
    expect(parseLogins("@mira-l, theo-k  bad!name inkwell/shelf-team")).toEqual({ logins: ["mira-l", "theo-k", "inkwell/shelf-team"], invalid: ["bad!name"] });
  });

  // One click never records a confirmation: it opens the notes, which read GitHub first and show what came after the approval.
  it("offers Confirm handled… on an approval with comments, opening its notes, and says why when it can't", () => {
    const line = find("folio #301");
    expect(line).toMatchObject({ status: "Approval comment to address", steps: [{ text: "Answer the approval's comment", owner: { kind: "you" }, age: "2d" }] });
    expect(action(line, "confirm-handled")).toMatchObject({ enabled: true, label: "Confirm handled…" });
    expect(actionCall(rowOf("folio #301"), action(line, "confirm-handled")!)).toEqual({ kind: "notes", prUrl: "https://github.com/inkwell/folio/pull/301" });
    for (const patch of [{ head: null }, { feedbackFingerprint: null }]) {
      expect(action(find("folio #301", withRow("folio #301", patch)), "confirm-handled"))
        .toMatchObject({ enabled: false, why: "No head or approval comments read yet; Refresh first" });
    }
    // It reads GitHub first, so it waits for another action on the PR and for the rate limit, like every write.
    const running = screen(VIEW, { pending: new Map([["https://github.com/inkwell/folio/pull/301", "confirm-handled"]]) }).groups
      .flatMap((group) => group.lines).find((item) => item.number === 301)!;
    expect(action(running, "confirm-handled")).toMatchObject({ label: "Confirming…", enabled: false, why: "Another action on this PR is running" });
    expect(action(screen({ ...VIEW, rateLimitedUntil: NOW + 60_000 }).groups.flatMap((group) => group.lines).find((item) => item.number === 301)!,
      "confirm-handled")).toMatchObject({ enabled: false, why: expect.stringMatching(/^GitHub's rate limit holds reads until/u) });
    const refused = "The approval's comments changed since the row was shown. Read them and try again; nothing was written.";
    expect(find("folio #301", withRow("folio #301", { lastAction: { at: NOW - 60_000, action: "confirm-handled", ok: false, detail: refused, reviewers: [] } })).last)
      .toEqual({ ok: false, text: `Confirm handled refused 1m ago: ${refused}` });
  });

  // Your word on review notes can always be taken back: on any row with your confirmation, however old, and while its effort is held.
  it("offers Revoke confirmation on any row with your confirmation, even a held effort's, and sends only the PR", () => {
    const confirmed = withRow("folio #340", { confirmation: { at: NOW - 30 * 86_400_000, current: true, evidence: false } });
    const line = find("folio #340", confirmed);
    expect(action(line, "revoke")).toMatchObject({ enabled: true, label: "Revoke confirmation" });
    expect(actionCall(rowOf("folio #340", confirmed), action(line, "revoke")!)).toEqual({ kind: "rpc", method: "inventory_confirm_revoke",
      input: { prUrl: "https://github.com/inkwell/folio/pull/340" } });
    expect(action(find("folio #340"), "revoke")).toBeUndefined();
    const held = inventoryLine(rowOf("folio #340", confirmed), new Map(), { now: NOW, limitedUntil: null, effortPile: "held" });
    expect(held.actions.map((item) => item.id)).toEqual(["revoke", "refresh", "thread"]);
  });

  it("re-requests the reviewers an answered change request names, with the same Nudge", () => {
    const rerequest = reason({ kind: "rereview-needed", action: "rerequest", nextStep: "Re-request review from @otto-v", owner: "you", reviewers: ["otto-v"] });
    const line = find("quill #211", withRow("quill #211", { attention: [rerequest], yourTurn: null }));
    expect(line).toMatchObject({ primary: "nudge", steps: [{ text: "Re-request review from @otto-v", owner: { kind: "you" } }] });
    expect(action(line, "nudge")).toMatchObject({ enabled: true, reviewers: ["otto-v"] });
  });

  // The live case: a reviewer approved and left open threads while another was asked over a business day ago. You owe answers first, and a
  // Nudge to the slow one leaves them waiting; it returns once the feedback clears and the row leaves Your turn.
  it("offers no Nudge for a reviewer who hasn't answered on a Your turn row, and still does where Your turn doesn't list it", () => {
    const threads = { why: "Approval comment from @mira-l · 5 open threads", since: null, latest: null };
    const turn = find("catalog #96", withRow("catalog #96", { yourTurn: threads }));
    expect(onYourTurn(turn)).toBe(true);
    expect(rowOf("catalog #96").attention.map((item) => [item.kind, item.action])).toEqual([["review-waiting", "nudge"]]);
    expect(action(turn, "nudge")).toBeUndefined();
    // Feedback answered: the same overdue review offers its Nudge again.
    expect(action(find("catalog #96"), "nudge")).toMatchObject({ enabled: true, label: "Nudge", reviewers: ["mira-l", "theo-k"] });
    // A thread working the feedback now takes the row off Your turn, where Nudge is unchanged.
    const working = { id: "thr_catalog_96", title: "Series order", active: true };
    const inFlight = find("catalog #96", withRow("catalog #96", { yourTurn: threads, threads: { origin: null, executor: working } }));
    expect(onYourTurn(inFlight)).toBe(false);
    expect(action(inFlight, "nudge")).toMatchObject({ enabled: true, label: "Nudge", reviewers: ["mira-l", "theo-k"] });
  });

  // The button a row leads with is presentation: Your turn and Address read the PR's facts. A note to confirm leads with Confirm and a
  // comment with its thread, and a thread at work on either takes it off alike; a re-request leading the row (756e943) changes nothing.
  it("lists a row on Your turn, and lets Address take it, whatever button it leads with", () => {
    const working = { origin: null, executor: { id: "thr_catalog_96", title: "Series order", active: true } };
    const note = reason({ kind: "approval-note", action: "confirm-handled", nextStep: "Answer the approval's comment", owner: "you", reviewers: [] });
    const comment = reason({ kind: "review-comments", action: "open-thread", nextStep: "Answer @theo-k's comment", owner: "you", reviewers: [] });
    const yourTurn = { why: "Comment from @theo-k", since: null, latest: null };
    for (const attention of [[note], [comment]]) {
      const free = find("catalog #96", withRow("catalog #96", { attention, yourTurn }));
      const busy = find("catalog #96", withRow("catalog #96", { attention, yourTurn, threads: working }));
      expect([onYourTurn(free), sendable(free), onYourTurn(busy), sendable(busy)]).toEqual([true, true, false, false]);
      for (const primary of ["thread", "confirm-handled", "nudge", "merge", null] as const) {
        const [led, busyLed]: InventoryLine[] = [{ ...free, primary }, { ...busy, primary }];
        expect([primary, onYourTurn(led), sendable(led), onYourTurn(busyLed)]).toEqual([primary, true, true, false]);
      }
    }
  });

  // Your turn's moves are Address, Refresh, and Dismiss: while a person's feedback waits on you, asking a reviewer again only hands them a
  // PR you haven't answered. Off Your turn, an answered change request reads Re-request for every reviewer it asks again.
  it("offers no Nudge or Re-request on a Your turn row, and names the re-request once it leaves", () => {
    const rerequest = reason({ kind: "rereview-needed", action: "rerequest", nextStep: "Re-request review from @otto-v, @ines-v", owner: "you", reviewers: ["otto-v", "ines-v"] });
    for (const attention of [[rerequest], [reason({ reviewers: ["mira-l"] }), rerequest]]) {
      const turn = find("quill #211", withRow("quill #211", { attention }));
      expect([onYourTurn(turn), action(turn, "nudge")]).toEqual([true, undefined]);
    }
    const line = find("quill #211", withRow("quill #211", { attention: [rerequest], yourTurn: null }));
    expect(action(line, "nudge")).toMatchObject({ label: "Re-request @otto-v, @ines-v", title: "Re-request review from @otto-v, @ines-v on quill #211",
      enabled: true, reviewers: ["otto-v", "ines-v"] });
    // The write is the existing nudge, so the server re-adds those reviewers.
    expect(actionCall(rowOf("quill #211"), action(line, "nudge")!)).toEqual({ kind: "rpc", method: "inventory_nudge",
      input: { prUrl: "https://github.com/inkwell/quill/pull/211", reviewers: ["otto-v", "ines-v"] } });
    const running = screen(withRow("quill #211", { attention: [rerequest], yourTurn: null }), { pending: new Map([["https://github.com/inkwell/quill/pull/211", "nudge"]]) })
      .groups.flatMap((group) => group.lines).find((item) => item.number === 211)!;
    expect(action(running, "nudge")).toMatchObject({ label: "Re-requesting…", enabled: false });
    // An overdue review beside it keeps Nudge, for everyone due.
    expect(action(find("quill #211", withRow("quill #211", { attention: [reason({ reviewers: ["mira-l"] }), rerequest], yourTurn: null })), "nudge"))
      .toMatchObject({ label: "Nudge", reviewers: ["mira-l", "otto-v", "ines-v"] });
  });

  it("never merges from a row: Merge… only opens the fresh preview, and nothing a row sends carries a head to merge", () => {
    const merge = action(find("folio #340"), "merge")!;
    expect(merge).toMatchObject({ label: "Merge…", enabled: true });
    expect(actionCall(rowOf("folio #340"), merge)).toEqual({ kind: "preview", target: "https://github.com/inkwell/folio/pull/340" });
    for (const { line } of lines()) for (const item of line.actions) {
      const call = actionCall(rowOf(`${line.repo} #${line.number}`), item, ["mira-l"]);
      expect(call.kind === "rpc" ? call.method : call.kind).not.toMatch(/merge(?!_preview)/u);
    }
  });

  it("shows a hold as a pin that asks nothing, and a teammate's PR as asking nothing of you", () => {
    const held = find("folio #301", withRow("folio #301", { hold: { reason: "Wait for the store launch", heldAt: NOW - 3_600_000 }, attention: [], status: "On hold" }));
    expect(held).toMatchObject({ status: "On hold", hold: { reason: "Wait for the store launch", age: "1h" }, steps: [], primary: null });
    expect(held.actions.map((item) => item.id)).toEqual(["refresh", "thread"]);
    const teammate = find("folio #301", withRow("folio #301", { authored: false, attention: [] }));
    expect(teammate).toMatchObject({ authored: false, steps: [], primary: null });
    expect(teammate.actions.map((item) => item.id)).toEqual(["refresh", "thread"]);
    // A teammate's PR with a checkout refreshes here; one nothing on the board reads would only fail, so Refresh says why instead.
    expect(action(teammate, "refresh")!.enabled).toBe(true);
    const unread = find("folio #301", withRow("folio #301", { authored: false, attention: [], stage: null, status: "Not read yet" }));
    expect(action(unread, "refresh")).toMatchObject({ enabled: false, why: "The board reads a teammate's PR only from its checkout" });
  });

  it("waits out GitHub's rate limit: writes explain until when, Refresh stays, and the notice names the reset", () => {
    const limited = screen({ ...VIEW, rateLimitedUntil: NOW + 5 * 60_000 });
    expect(limited.notices[0]).toMatchObject({ tone: "error" });
    expect(limited.notices[0]!.text).toMatch(/^GitHub's rate limit holds reads until \d{2}:\d{2}\. Rows show the last good read\.$/u);
    const line = limited.groups.flatMap((group) => group.lines).find((item) => item.number === 96)!;
    expect(action(line, "nudge")).toMatchObject({ enabled: false, why: expect.stringMatching(/^GitHub's rate limit holds reads until \d{2}:\d{2}; try then$/u) });
    expect(action(line, "refresh")!.enabled).toBe(true);
    // A limit that has passed is no notice.
    expect(screen({ ...VIEW, rateLimitedUntil: NOW - 1 }).notices).toEqual([]);
  });

  it("says when the last read didn't finish and when a row's own read failed, with GitHub's reason", () => {
    const failed = screen({ ...VIEW, attemptedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW - 5 * 60_000).toISOString(),
      warnings: ["GitHub search failed: HTTP 502"] });
    expect(failed.notices).toEqual([{ tone: "error", text: "The last GitHub read, 1m ago, didn't finish. Rows show the read from 5m ago." },
      { tone: "info", text: "GitHub search failed: HTTP 502" }]);
    expect(failed.read.text).toBe("Last read 5m ago");
    // A read still running hasn't failed.
    expect(screen({ ...VIEW, attemptedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW - 5 * 60_000).toISOString(), refreshing: true }).notices)
      .toEqual([]);
    expect(screen({ ...VIEW, refreshing: true }).read.text).toBe("Last read 25s ago · reading now");
    const row = find("folio #301", withRow("folio #301", { failure: { at: new Date(NOW - 120_000).toISOString(), error: "HTTP 502" }, stale: true }));
    expect(row.checked).toMatchObject({ text: "read failed 2m ago", failed: true, stale: true });
    expect(row.checked.title).toBe("GitHub didn't answer: HTTP 502. Last good read 25s ago; the last full read didn't list it, so it may be out of date.");
    expect(find("folio #301").checked).toMatchObject({ text: "checked 25s ago", failed: false, stale: false });
  });

  it("runs one action on a PR at a time, and shows what the last one did, or the server's refusal word for word", () => {
    expect(find("catalog #96").last).toBeNull();
    const running = screen(VIEW, { pending: new Map([["https://github.com/inkwell/catalog/pull/96", "nudge"]]) }).groups.flatMap((group) => group.lines)
      .find((line) => line.number === 96)!;
    expect(action(running, "nudge")).toMatchObject({ label: "Nudging…", enabled: false, why: "Another action on this PR is running" });
    const reading = screen(VIEW, { pending: new Map([["https://github.com/inkwell/catalog/pull/96", "refresh"]]) }).groups.flatMap((group) => group.lines)
      .find((line) => line.number === 96)!;
    expect(action(reading, "refresh")).toMatchObject({ label: "Reading…", enabled: false, why: "Reading GitHub now" });
    const refused = "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written.";
    const recorded = withRow("catalog #96", { lastAction: { at: NOW - 60_000, action: "nudge", ok: false, detail: refused, reviewers: [] } });
    expect(find("catalog #96", recorded).last).toEqual({ ok: false, text: `Nudge refused 1m ago: ${refused}` });
    // This visit's own click, newer than the server's record, shows until the next one.
    const outcomes = new Map([["https://github.com/inkwell/catalog/pull/96", { at: NOW - 5_000, action: "refresh" as const, ok: false, text: "HTTP 502" }]]);
    expect(screen(recorded, { outcomes }).groups.flatMap((group) => group.lines).find((line) => line.number === 96)!.last)
      .toEqual({ ok: false, text: "Refresh failed 5s ago: HTTP 502" });
  });

  it("drops this visit's failed read once a read succeeds, but keeps a refused write's reason, which a read doesn't answer", () => {
    const url = "https://github.com/inkwell/catalog/pull/96";
    const failed = new Map([[url, { at: NOW - 5_000, action: "refresh" as const, ok: false, text: "HTTP 502" }]]);
    expect(withOutcome(failed, url, null).has(url)).toBe(false);
    expect(screen(VIEW, { outcomes: failed }).groups.flatMap((group) => group.lines).find((line) => line.number === 96)!.last).not.toBeNull();
    expect(screen(VIEW, { outcomes: withOutcome(failed, url, null) }).groups.flatMap((group) => group.lines).find((line) => line.number === 96)!.last).toBeNull();
    const refused = new Map([[url, { at: NOW - 5_000, action: "nudge" as const, ok: false, text: "Who needs a nudge changed" }]]);
    expect(withOutcome(refused, url, null).get(url)).toEqual(refused.get(url));
    const next: Outcome = { at: NOW, action: "refresh", ok: false, text: "GitHub is still checking this PR." };
    expect(withOutcome(refused, url, next).get(url)).toEqual(next);
  });

  // Feedback the state word doesn't name is still yours, and a thread's to address, so the deck files it under Work in threads.
  it("leads a Your turn row the state word doesn't explain with the review feedback, which its thread addresses", () => {
    const commented = withRow("catalog #96", { attention: [], yourTurn: { why: "Comment from @theo-k", since: NOW - 3_600_000, latest: NOW - 3_600_000 } });
    expect(find("catalog #96", commented)).toMatchObject({ steps: [{ text: "Address the review feedback", owner: { kind: "you" } }], primary: "thread",
      yourTurn: { why: "Comment from @theo-k", age: "1h" } });
    // A read that left it unknown asks for a read first.
    expect(find("catalog #96", withRow("catalog #96", { status: "Status unknown" }, commented)).primary).toBe("refresh");
    // With no feedback, it waits on its reviewers as before.
    expect(find("catalog #96", withRow("catalog #96", { attention: [] })).steps[0]?.owner.kind).toBe("reviewers");
  });

  // Merging, nudging someone else, or asking again leaves Your turn's feedback waiting on you, so the row leads with the move that answers
  // it, or with the feedback itself, and the deck files it where Your turn lists it: never under Merge or Nudge reviewers while it waits.
  it("leads a Your turn row with the move that answers its feedback, or the feedback, before a merge, a nudge, or a re-request", () => {
    const comments = { why: "Comment from @ines-v", since: NOW - 3_600_000, latest: NOW - 3_600_000 };
    const merge = reason({ kind: "merge-waiting", action: "merge", nextStep: "Merge", owner: "you", reviewers: [] });
    expect(find("folio #340", withRow("folio #340", { attention: [merge], yourTurn: comments }))).toMatchObject({ primary: "thread",
      steps: [{ text: "Address the review feedback", age: "1h", since: NOW - 3_600_000 }, { text: "Merge" }] });
    expect(find("catalog #96", withRow("catalog #96", { yourTurn: comments }))).toMatchObject({ primary: "thread",
      steps: [{ text: "Address the review feedback" }, { text: "Nudge @mira-l, @theo-k", owner: { kind: "reviewers" } }] });
    // A re-request follows a change request you answered: a person's thread, or another's change request, still waits, and its fix leads.
    const rerequest = reason({ kind: "rereview-needed", action: "rerequest", nextStep: "Re-request review from @otto-v", owner: "you", reviewers: ["otto-v"] });
    const threads = { why: "1 open thread", since: null, latest: null };
    const answered = find("quill #211", withRow("quill #211", { attention: [rerequest], yourTurn: threads }));
    expect(answered).toMatchObject({ primary: "thread", steps: [{ text: "Address the review feedback" }, { text: "Re-request review from @otto-v" }] });
    // An approval's notes are yours to confirm, even behind an overdue review; with no feedback waiting, attention keeps its own order.
    const overdue = [reason({}), ...rowOf("folio #301").attention];
    expect(find("folio #301", withRow("folio #301", { attention: overdue }))).toMatchObject({ primary: "confirm-handled",
      steps: [{ text: "Answer the approval's comment" }, { text: "Nudge @mira-l" }] });
    expect(find("folio #301", withRow("folio #301", { attention: overdue, yourTurn: null })).primary).toBe("nudge");
  });

  // Address takes exactly the rows you picked: a click toggles one, Shift takes the run from the last one you clicked, in the order drawn.
  it("toggles a clicked row, and takes a Shift-click's range from the last row clicked", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect([...pickRows(order, new Set(), "b", false, null)]).toEqual(["b"]);
    expect([...pickRows(order, new Set(["b"]), "b", false, "b")]).toEqual([]);
    expect([...pickRows(order, new Set(["b"]), "d", true, "b")]).toEqual(["b", "c", "d"]);
    // Upward works the same, and adds to what's already picked.
    expect([...pickRows(order, new Set(["e"]), "a", true, "c")].sort()).toEqual(["a", "b", "c", "e"]);
    // With no row clicked yet, Shift toggles the one row; a picked row that left the list drops out.
    expect([...pickRows(order, new Set(["z"]), "c", true, null)]).toEqual(["c"]);
  });

  // A sent PR stays on Your turn only while the rule says so, and Address takes it again only once nothing it sent is under way, which the
  // server's claim enforces too.
  it("keeps a sent PR on Your turn only while its feedback waits, and Address takes it again only once its thread is idle", () => {
    const sent = (state: Sent["state"], patch: Partial<InventoryRow> = {}) => find("quill #211", withRow("quill #211", { sent: { state, threadId: "thr-batch",
      title: "Address feedback on 2 PRs", detail: null, batchId: null }, ...patch }));
    const held = sent("working", { addressing: { threadId: "thr-batch", title: "Address feedback on 2 PRs" } });
    expect([held.addressing, onYourTurn(held), sendable(held)]).toEqual([{ threadId: "thr-batch" }, true, false]);
    for (const state of ["sending", "needs-you"] as const) expect([state, onYourTurn(sent(state)), sendable(sent(state))]).toEqual([state, true, false]);
    for (const state of ["idle", "refused"] as const) expect([state, onYourTurn(sent(state)), sendable(sent(state))]).toEqual([state, true, true]);
    expect(onYourTurn(sent("idle", { yourTurn: null }))).toBe(false);
    expect([onYourTurn(find("quill #211")), sendable(find("quill #211"))]).toEqual([true, true]);
    // Its batch thread ended and another thread took the PR: that one has it, so Address can't, as the server's listing refuses it.
    const other = sent("idle", { threads: { origin: null, executor: { id: "thr_quill_211", title: "Work on quill #211", active: true } } });
    expect([onYourTurn(other), sendable(other)]).toEqual([false, false]);
  });

  it("explains the two lists and why Nudge is conditional", () => {
    const words = new Map(INVENTORY_HOW.rows);
    expect(INVENTORY_HOW.intro).toContain("Your turn lists your PRs where a reviewer's feedback waits on you");
    expect(INVENTORY_HOW.intro).not.toContain("Reviews");
    expect(words.get("Your turn")).toContain("Bots never put a PR here");
    expect(words.get("Your turn")).toContain("Held PRs stay out");
    expect(words.has("Back to me")).toBe(false);
    // Your turn's moves are Address, Refresh, and Dismiss: no Ask its thread, and no Nudge until you've answered.
    expect(words.has("Ask its thread")).toBe(false);
    // Address has no listing and no choice of thread: one thread starts, with Undo, and each sent PR links it while the PR is open.
    expect(words.get("Address")).toContain("One thread starts for all of them at once, with 8 s to Undo");
    expect(words.get("Address")).not.toMatch(/confirm|each PR's own/u);
    expect(words.get("Sent")).toContain("Working, Needs you, or Idle");
    expect(words.get("Dismiss")).toContain("until its head moves");
    expect(words.get("Nudge")).toContain("server checks again");
    expect(words.get("Nudge")).toContain("Your turn offers none");
    // Routing: any row moves, and only a suggestion the classifier stands behind shows.
    expect(words.get("Move")).toContain("Select any rows");
    expect(words.get("Suggestion")).toContain("Weak or tied picks show nothing");
  });

  it("names each effort's group, with No effort last", () => {
    expect(screen().groups.map((group) => [group.label, group.effort?.id ?? null])).toEqual([["Shelf order", INVENTORY_EFFORTS.shelf.id],
      ["Store pickup", INVENTORY_EFFORTS.pickup.id], ["No effort", null]]);
  });
});
