import { describe, expect, it } from "vitest";
import { parsePlaybook } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { approvalWanted, anyWorkerInFlight, compactDue, diffObserved, endingDeadline, followingThrough, gateKnownUnmet, gateState, isCommentNews, lifecycle, markerLaneChange, resolveChecklistItem, reviewMarker, specHash, stuckDue, unheardWait, workerInFlight } from "./reconcile.js";
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

const ctx = { own: new Set(["thr_s", "thr_w"]), stewardThreadId: "thr_s", approved: false, cursor: "2026-10-01T12:00:00Z", workerInFlight: false };
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
    const running = { ...ctx, workerInFlight: true };
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

describe("a worker in flight between its turns (BB-11)", () => {
  const worker = (status: "running" | "finished" | "failed" | "stopped") => ({ status });

  it("counts a worker in flight from spawn until it is stopped, failed or archived", () => {
    expect(workerInFlight(worker("running"))).toBe(true);
    // Its turn ending is a pause, not a finish: it is woken again to push.
    expect(workerInFlight(worker("finished"))).toBe(true);
    expect(workerInFlight(worker("failed"))).toBe(false);
    expect(workerInFlight(worker("stopped"))).toBe(false);
    expect(anyWorkerInFlight([worker("stopped"), worker("finished")])).toBe(true);
    expect(anyWorkerInFlight([worker("stopped"), worker("failed")])).toBe(false);
    expect(anyWorkerInFlight([])).toBe(false);
  });

  it("keeps the reviewer's marker comments for the worker, and wakes on a lane change", () => {
    const marker = (round: number, lane: string) => comment({ id: `m${round}`, author: "jane", body: `<!-- bb-review round=${round} sha=abc${round} verdict=approved lane=${lane} -->\n\nLGTM.`, createdAt: `2026-10-02T0${round}:00:00Z` });
    expect(reviewMarker(marker(1, "no-review").body)).toEqual({ round: 1, sha: "abc1", verdict: "approved", lane: "no-review" });
    expect(reviewMarker("just a comment")).toBeNull();
    // A marker is a marker only on the first line.
    expect(reviewMarker("Hello\n<!-- bb-review round=1 sha=abc verdict=approved lane=no-review -->")).toBeNull();

    const before = { entity: pull({ author: "jane" }), pulls: [] };
    const after = { entity: pull({ author: "jane", comments: [marker(1, "no-review")] }), pulls: [] };
    // In flight, the round is the worker's business.
    expect(actionable(diffObserved(before, after, { ...ctx, workerInFlight: true }))).toEqual([]);
    // A round that changes the lane is not.
    const changed = { entity: pull({ author: "jane", comments: [marker(1, "no-review"), marker(2, "owner-reviewed")] }), pulls: [] };
    expect(actionable(diffObserved(after, changed, { ...ctx, workerInFlight: true }))).toEqual(["Review lane: no-review → owner-reviewed"]);
    expect(markerLaneChange(after.entity.comments, changed.entity.comments)).toEqual({ from: "no-review", to: "owner-reviewed" });
    // Once no worker is in flight, the same markers are ordinary comment news.
    expect(actionable(diffObserved(before, after, ctx))).toEqual(["1 new comment from jane"]);
  });

  it("covers the BB-11 sequence: a worker's own PR activity stays quiet until it finishes", () => {
    // Worker spawns, goes idle waiting (still in flight), the reviewer posts,
    // checks finish, the worker pushes; only the finish is actionable.
    const linked = { linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] };
    const before = { entity: issue({ state: "In Progress", stateType: "started", ...linked }), pulls: [pull({ author: "jane" }, { headAuthor: "jane" })] };
    // Its turn ended to wait, so its status is `finished`; it is still in flight.
    expect(anyWorkerInFlight([worker("finished")])).toBe(true);
    const reviewed = {
      entity: issue({ state: "In Progress", stateType: "started", ...linked }),
      pulls: [pull({ author: "jane", comments: [comment({ id: "r1", author: "jane", body: "<!-- bb-review round=1 sha=aaaaaaa verdict=approved lane=no-review -->", createdAt: "2026-10-02T00:00:00Z" })] }, { headAuthor: "jane", checks: { state: "success", failing: [] } })],
    };
    expect(actionable(diffObserved(before, reviewed, { ...ctx, workerInFlight: true }))).toEqual([]);
    // The worker pushes (woken again), still in flight.
    const pushed = { entity: reviewed.entity, pulls: [pull({ author: "jane", comments: reviewed.pulls[0]!.comments }, { headSha: "bbbbbbb2", headAuthor: "jane", checks: { state: "success", failing: [] } })] };
    expect(actionable(diffObserved(reviewed, pushed, { ...ctx, workerInFlight: true }))).toEqual([]);
    // Nothing was actionable while it was in flight, so the steward is woken
    // once, at the finish, with all of it as quiet notes.
    const changes = diffObserved(before, pushed, { ...ctx, workerInFlight: anyWorkerInFlight([worker("stopped")]) });
    expect(actionable(changes)).toEqual(["acme/web#7: Checks finished: success", "acme/web#7: 1 new comment from jane"]);
    expect(changes.map((c) => c.text)).toContain("acme/web#7: Pushed bbbbbbb by jane");
  });

  it("compacts when the transcript is over the limit or the wake would push it over", () => {
    expect(compactDue(null, 120_000, 0)).toBe(false);
    expect(compactDue(90_000, 120_000, 0)).toBe(false);
    expect(compactDue(121_000, 120_000, 0)).toBe(true);
    // A 115k-token steward and a 30k-character wake (the wake cap) overshoot.
    expect(compactDue(115_000, 120_000, 30_000)).toBe(true);
    expect(compactDue(90_000, 120_000, 30_000)).toBe(false);
    expect(compactDue(90_000, 120_000, 1_000)).toBe(false);
    // 0 leaves compaction to the provider.
    expect(compactDue(1_000_000, 0, 1_000_000)).toBe(false);
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
