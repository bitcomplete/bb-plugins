import { describe, expect, it } from "vitest";
import { parsePlaybook } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { approvalWanted, asksForOpenApproval, classifyApproval, diffObserved, endingDeadline, followingThrough, gateKnownUnmet, gateState, isCommentNews, lifecycle, resolveChecklistItem, specHash, stuckDue, unheardWait } from "./reconcile.js";
import { readyStateSchema } from "./store.js";
import { GITHUB_REVIEWS, LINEAR_TICKETS } from "./templates.js";

const tickets = (() => {
  const p = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();
const reviews = (() => {
  const p = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
  if (!p.ok) throw new Error(p.error);
  return p.value;
})();

const ctx = { own: new Set(["thr_s", "thr_w"]), stewardThreadId: "thr_s", approved: false, cursor: "2026-10-01T12:00:00Z", workerRunning: false };
const actionable = (cs: Array<{ text: string; actionable: boolean }>) => cs.filter((c) => c.actionable).map((c) => c.text);

describe("what changed", () => {
  it("wakes for others' comments and not for the steward's own", () => {
    const before = { entity: issue(), pulls: [] };
    const own = { entity: issue({ comments: [comment({ id: "c0", body: "Plan…", signedBy: "thr_s" }), comment({ id: "c9", signedBy: "thr_w" })] }), pulls: [] };
    expect(actionable(diffObserved(before, own, ctx))).toEqual([]);
    const other = { entity: issue({ comments: [comment()] }), pulls: [] };
    expect(actionable(diffObserved(before, other, ctx))).toEqual(["1 new comment from Sam"]);
    const stale = { entity: issue({ comments: [comment({ createdAt: "2026-09-30T00:00:00Z" })] }), pulls: [] };
    expect(actionable(diffObserved(before, stale, ctx))).toEqual([]);
  });

  it("treats state and description as actionable and label churn as not", () => {
    const before = { entity: issue(), pulls: [] };
    const after = { entity: issue({ state: "In Progress", labels: ["bb-managed", "auth"], description: "Users cannot log in with SSO." }), pulls: [] };
    expect(actionable(diffObserved(before, after, ctx))).toEqual(["State: Todo → In Progress", "Description edited"]);
  });

  it("counts a spec comment only once an approval is pinned", () => {
    const before = { entity: issue(), pulls: [] };
    const after = { entity: issue({ comments: [comment({ id: "s1", body: "**Spec:** acceptance criteria…", signedBy: "thr_s" })] }), pulls: [] };
    expect(actionable(diffObserved(before, after, ctx))).toEqual([]);
    expect(actionable(diffObserved(before, after, { ...ctx, approved: true }))).toEqual(["Spec comment added"]);
  });

  it("on a pull request: checks finishing, others' pushes and reviews, re-requests", () => {
    const before = { entity: pull(), pulls: [] };
    const ownPush = { entity: pull({}, { headSha: "bbbbbbb2", headAuthor: "jane" }), pulls: [] };
    expect(actionable(diffObserved(before, ownPush, ctx))).toEqual([]);
    const theirs = { entity: pull({}, { headSha: "bbbbbbb2", headAuthor: "sam", checks: { state: "failure", failing: ["ci"] }, requestedReviewers: ["jane"], reviews: [{ author: "lee", state: "approved", submittedAt: "2026-10-02T00:00:00Z", commit: null }] }), pulls: [] };
    expect(actionable(diffObserved(before, theirs, ctx))).toEqual(["Pushed bbbbbbb by sam", "Checks finished: failure (failing: ci)", "Review: lee approved", "Your review was requested"]);
  });

  it("names its comment counts so a queued one can be told apart", () => {
    const after = { entity: issue({ comments: [comment()] }), pulls: [pull({ comments: [comment({ id: "p1" }), comment({ id: "p2", author: "Lee" })] })] };
    const lines = actionable(diffObserved({ entity: issue(), pulls: [pull()] }, after, ctx));
    expect(lines).toEqual(["1 new comment from Sam", "acme/web#7: 2 new comments from Sam, Lee"]);
    expect(lines.every(isCommentNews)).toBe(true);
    expect(isCommentNews("acme/web#7: State: open → merged")).toBe(false);
    expect(isCommentNews('Worker "ENG-12: 1 new comment from Sam" finished its turn.')).toBe(false);
  });

  it("while a worker runs, its own work on a pull request is not news, and people still are", () => {
    // HUB-183 on bithub: the worker pushes, edits the description, posts as
    // the viewer (unsigned, and its reviewer too) and waits for checks.
    const running = { ...ctx, workerRunning: true };
    const before = { entity: issue(), pulls: [pull({ author: "jane" }, { headAuthor: "jane" })] };
    const busy = {
      entity: issue(),
      pulls: [
        pull(
          { author: "jane", description: "Retries login, with a test.", comments: [comment({ id: "r1", author: "jane", body: "Independent review running in bb thread thr_r." }), comment({ id: "r2", author: "jane", body: "Round 2: all three suggestions taken." })] },
          { headSha: "bbbbbbb2", headAuthor: "jane", checks: { state: "success", failing: [] } },
        ),
      ],
    };
    const changes = diffObserved(before, busy, running);
    expect(actionable(changes)).toEqual([]);
    // Still reported, for the next turn something else makes due.
    expect(changes.map((c) => c.text)).toEqual(["acme/web#7: Description edited", "acme/web#7: Pushed bbbbbbb by jane", "acme/web#7: Checks finished: success", "acme/web#7: 2 new comments from jane"]);
    // With no worker running the same checks and edit are news, as before.
    expect(actionable(diffObserved(before, busy, ctx))).toEqual(["acme/web#7: Description edited", "acme/web#7: Checks finished: success", "acme/web#7: 2 new comments from jane"]);

    const people = {
      entity: issue({ comments: [comment({ id: "l1", author: "Jane", body: "Please also cover SSO." })] }),
      pulls: [
        pull(
          { author: "jane", state: "merged", comments: [comment({ id: "g1", author: "lee", body: "Why a retry and not a timeout?" })] },
          { headSha: "ccccccc3", headAuthor: "lee", reviews: [{ author: "lee", state: "changes_requested", submittedAt: "2026-10-02T00:00:00Z", commit: null }] },
        ),
      ],
    };
    // The ticket's own comments, a teammate's push, review and comment, and the merge all still wake it.
    expect(actionable(diffObserved(before, people, running))).toEqual([
      "acme/web#7: State: open → merged",
      "acme/web#7: Pushed ccccccc by lee",
      "acme/web#7: Review: lee changes_requested",
      "1 new comment from Jane",
      "acme/web#7: 1 new comment from lee",
    ]);
  });

  it("follows a ticket's linked pull requests", () => {
    const before = { entity: issue(), pulls: [pull()] };
    const after = { entity: issue(), pulls: [pull({ state: "merged" })] };
    expect(actionable(diffObserved(before, after, ctx))).toEqual(["acme/web#7: State: open → merged"]);
  });
});

describe("waits nobody hears", () => {
  const status = (blockedOn: string | null) => ({ phase: "Todo", summary: "s", nextAction: "n", actor: "other" as const, blockedOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });
  const open = [{ id: "esc_1", bindingId: "b", kind: "decision" as const, question: "q", meanwhile: "m", route: "project" as const, recommendation: null, status: "open" as const, resolution: null, createdAt: 1, resolvedAt: null, deliveredAt: null }];

  it("flags a status blocked on the project steward or the user with no escalation open", () => {
    expect(unheardWait(status("project steward's approval of the new spec"), [])).toMatch(/project steward/u);
    expect(unheardWait(status("the user's answer on scope"), [])).toMatch(/the user/u);
    expect(unheardWait(status("project steward's approval"), open)).toBeNull();
    expect(unheardWait(status("Sam's review"), [])).toBeNull();
    expect(unheardWait(status(null), [])).toBeNull();
  });

  it("tells the steward's own signed description edit from someone else's edit of it", () => {
    const signed = (text: string) => issue({ description: `${text}\n\n_— from bb thread thr_s_` });
    const own = (before: ReturnType<typeof issue>, after: ReturnType<typeof issue>) => diffObserved({ entity: before, pulls: [] }, { entity: after, pulls: [] }, ctx).find((c) => c.text.startsWith("Description edited"))!;
    expect(own(issue(), signed("New scope."))).toMatchObject({ own: true, actionable: true });
    expect(own(signed("New scope."), signed("Newer scope, by hand.")).own).toBeUndefined();
    expect(own(issue(), issue({ description: "By hand." })).own).toBeUndefined();
  });
});

describe("approval words", () => {
  it("tells approval, refusal and ambiguity apart", () => {
    for (const text of ["LGTM", "Approved", "approved, it is fully specified", "ship it", "go ahead", "Looks good", "yes", "signed off"]) expect(classifyApproval(text), text).toBe("approve");
    // Approving words with a bare "no" beside them still approve.
    for (const text of ["LGTM, no concerns from me", "Ship it, no further changes needed", "Approved, no notes"]) expect(classifyApproval(text), text).toBe("approve");
    for (const text of ["no", "No.", "not approved", "don't ship it", "declined", "reject", "changes needed", "don't", "do not approve", "No, not yet"]) expect(classifyApproval(text), text).toBe("decline");
    for (const text of ["", "maybe", "name the migration in the spec", "what about SSO?"]) expect(classifyApproval(text), text).toBe("ambiguous");
  });

  it("flags a report that asks for an approval already open, and only that", () => {
    const status = (summary: string, nextAction: string) => ({ phase: "Todo", summary, nextAction, actor: "me" as const, blockedOn: null, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });
    const open = [{ kind: "approval" } as never];
    expect(asksForOpenApproval(status("Spec posted.", "Ask the user to approve the spec"), open)).toMatch(/already open/u);
    // Waiting on the request, or on the project steward, is not asking again.
    expect(asksForOpenApproval(status("Spec posted.", "Wait for the project steward's approval"), open)).toBeNull();
    expect(asksForOpenApproval(status("Approval requested from the user; waiting.", "Wait for the user to approve the spec"), open)).toBeNull();
    expect(asksForOpenApproval(status("Spec posted.", "Ask the user to approve the spec"), [])).toBeNull();
  });
});

describe("the ready gate", () => {
  const ready = (over: object) => readyStateSchema.parse(over);
  const allMet = tickets.ready!.checklist.map((item) => ({ item, met: true }));

  it("needs the whole checklist, and approval unless judged not substantial", () => {
    const hash = specHash(issue(), "thr_s");
    expect(gateState(tickets, ready({}), hash)).toMatchObject({ passed: false, unmet: tickets.ready!.checklist });
    expect(gateState(tickets, ready({ checklist: allMet }), hash)).toMatchObject({ passed: false, approvalNeeded: true });
    expect(gateState(tickets, ready({ checklist: allMet, substantial: false }), hash).passed).toBe(true);
    expect(gateState(tickets, ready({ checklist: allMet, approval: { at: 1, specHash: hash, by: "thr_s" } }), hash).passed).toBe(true);
  });

  it("wants its approver while the checklist is met and the current spec has none", () => {
    const hash = specHash(issue(), "thr_s");
    const approval = { at: 1, specHash: hash, by: "thr_p" };
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet.slice(1), substantial: true }), hash))).toBe(false);
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet, substantial: false }), hash))).toBe(false);
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet, substantial: true }), hash))).toBe(true);
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet }), hash))).toBe(true);
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet, substantial: true, approval }), hash))).toBe(false);
    expect(approvalWanted(gateState(tickets, ready({ checklist: allMet, substantial: true, approval }), "changed"))).toBe(true);
  });

  it("is known unmet on a missing or stale approval or an item reported unmet, not on an unreported item", () => {
    const hash = specHash(issue(), "thr_s");
    const approval = { at: 1, specHash: hash, by: "thr_p" };
    expect(gateKnownUnmet(tickets, ready({}), hash)).toBe(true);
    expect(gateKnownUnmet(tickets, ready({ approval }), hash)).toBe(false);
    expect(gateKnownUnmet(tickets, ready({ approval, checklist: allMet.slice(1) }), hash)).toBe(false);
    expect(gateKnownUnmet(tickets, ready({ approval }), "changed")).toBe(true);
    expect(gateKnownUnmet(tickets, ready({ substantial: false }), hash)).toBe(false);
    expect(gateKnownUnmet(tickets, ready({ approval, checklist: [{ ...allMet[0]!, met: false }] }), hash)).toBe(true);
    expect(gateKnownUnmet(tickets, ready({ checklist: allMet, approval }), hash)).toBe(false);
  });

  it("knows a reported item by its number or the playbook's own words, never a paraphrase", () => {
    const items = ["The problem, as observed: the current behaviour and where in the code it comes from", "What is out of scope"];
    expect(resolveChecklistItem(items, 1)).toBe(items[0]);
    expect(resolveChecklistItem(items, "2")).toBe(items[1]);
    expect(resolveChecklistItem(items, "#2.")).toBe(items[1]);
    expect(resolveChecklistItem(items, "what is  out of scope.")).toBe(items[1]);
    // What bithub's stewards actually reported, and numbers past either end.
    for (const bad of ["The problem, as observed", "Out of scope", 0, 3, "0"]) expect(resolveChecklistItem(items, bad), String(bad)).toBeNull();
  });

  it("matches what was recorded to the checklist ignoring case and spacing", () => {
    const hash = specHash(issue(), "thr_s");
    const loose = tickets.ready!.checklist.map((item) => ({ item: `${item.toUpperCase()}.`, met: true }));
    expect(gateState(tickets, ready({ checklist: loose, substantial: false }), hash).passed).toBe(true);
  });

  it("pins approval to the description and spec comments", () => {
    const hash = specHash(issue(), "thr_s");
    const r = ready({ checklist: allMet, approval: { at: 1, specHash: hash, by: "thr_s" } });
    const edited = specHash(issue({ description: "Users cannot log in. Also SSO." }), "thr_s");
    expect(gateState(tickets, r, edited)).toMatchObject({ passed: false, approvalStale: true });
    // Others' comments are not spec; the steward's signature on its own edit does not change the hash.
    expect(specHash(issue({ comments: [comment({ body: "Spec: mine" })] }), "thr_s")).toBe(hash);
    expect(specHash(issue({ description: "Users cannot log in.\n\n_— from bb thread thr_s_" }), "thr_s")).toBe(hash);
  });

  it("counts a spec comment the user wrote, and tells it apart from the steward's", () => {
    const base = specHash(issue(), "thr_s");
    const user = (tid: string) => tid === "thr_user";
    const amended = issue({ comments: [comment({ id: "u1", author: "Jane", body: "**Spec:** narrower scope", signedBy: "thr_user", createdAt: "2026-10-14T16:00:00Z" })] });
    // Without the predicate the signing thread is unknown, so it is not spec.
    expect(specHash(amended, "thr_s")).toBe(base);
    expect(specHash(amended, "thr_s", user)).not.toBe(base);
  });

  it("marks a spec comment the user wrote as the user's, and wakes for it", () => {
    const before = { entity: issue(), pulls: [] };
    const after = { entity: issue({ comments: [comment({ id: "u1", author: "Jane", body: "**Spec:** narrower scope", signedBy: "thr_user" })] }), pulls: [] };
    const changes = diffObserved(before, after, { ...ctx, userThread: (tid) => tid === "thr_user" });
    expect(changes).toContainEqual({ text: "Spec comment added by the user", actionable: true, byUser: true });
  });
});

describe("lifecycle", () => {
  const open = { kind: "ticket" as const, endedAt: null, endReason: null, manualDetach: false, ending: null };
  it("ends on a terminal state or a removed label, and comes back", () => {
    expect(lifecycle(open, tickets, issue(), "bb-managed").kind).toBe("continue");
    expect(lifecycle(open, tickets, issue({ state: "Done" }), "bb-managed").kind).toBe("terminal");
    expect(lifecycle(open, tickets, issue({ labels: [] }), "bb-managed").kind).toBe("detach");
    expect(lifecycle({ ...open, endedAt: 1, endReason: "terminal" }, tickets, issue({ state: "Todo" }), "bb-managed").kind).toBe("reopen");
    expect(lifecycle({ ...open, endedAt: 1, endReason: "detach" }, tickets, issue(), "bb-managed").kind).toBe("reopen");
    expect(lifecycle({ ...open, endedAt: 1, endReason: "detach", manualDetach: true }, tickets, issue(), "bb-managed").kind).toBe("stay-ended");
  });

  it("takes back an ending when the entity leaves its terminal state before the binding ends", () => {
    // Linear's merge-to-Done automation, and someone moving the ticket straight back.
    const ending = { ...open, ending: "terminal" };
    expect(lifecycle(ending, tickets, issue({ state: "Done" }), "bb-managed").kind).toBe("terminal");
    expect(lifecycle(ending, tickets, issue({ state: "In Progress" }), "bb-managed")).toEqual({ kind: "reopen", why: "reopened before the binding ended: now In Progress" });
    // A detach under way is not undone by a state change.
    expect(lifecycle({ ...open, ending: "detach" }, tickets, issue({ state: "In Progress", labels: [] }), "bb-managed").kind).toBe("detach");
  });

  it("keeps an ending open for follow-through until its cap, and a bare wrap-up turn for its timeout", () => {
    expect(followingThrough({ ending: "terminal", followThrough: "watch the deploy" })).toBe(true);
    expect(followingThrough({ ending: "terminal", followThrough: null })).toBe(false);
    expect(followingThrough({ ending: "detach", followThrough: "watch the deploy" })).toBe(false);
    expect(endingDeadline({ ending: null, endingAt: null, followThroughUntil: null }, 60_000)).toBeNull();
    expect(endingDeadline({ ending: "terminal", endingAt: 1000, followThroughUntil: null }, 60_000)).toBe(61_000);
    expect(endingDeadline({ ending: "terminal", endingAt: 1000, followThroughUntil: 9_000_000 }, 60_000)).toBe(9_000_000);
  });

  it("does not detach a review binding, which has no label", () => {
    expect(lifecycle({ ...open, kind: "review" }, reviews, pull(), "bb-managed").kind).toBe("continue");
    expect(lifecycle({ ...open, kind: "review" }, reviews, pull({ state: "merged" }), "bb-managed").kind).toBe("terminal");
  });
});

describe("the stuck backstop", () => {
  it("fires after the phase's limit without progress, once", () => {
    const b = { advancedAt: 0, createdAt: 0, phase: "In Progress" };
    expect(stuckDue(b, tickets, [], 86_400_000)).toBeNull();
    expect(stuckDue(b, tickets, [], 3 * 86_400_000)).toBe(2 * 86_400_000);
    expect(stuckDue({ ...b, phase: "Todo" }, tickets, [], 30 * 86_400_000)).toBeNull();
    expect(stuckDue(b, tickets, [{ kind: "stuck" } as never], 3 * 86_400_000)).toBeNull();
  });
});
