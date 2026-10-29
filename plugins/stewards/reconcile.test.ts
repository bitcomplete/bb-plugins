import { describe, expect, it } from "vitest";
import { parsePlaybook, phaseOf } from "./config.js";
import { comment, issue, pull } from "./fixtures.js";
import { approvalMarkerLine, approvalWanted, answerDiffers, anyWorkerInFlight, asksForOpenApproval, classifyApproval, commentDiffersFromRecommendation, compactDue, diffObserved, endingDeadline, followingThrough, gateKnownUnmet, gateState, idleInActiveStage, isCommentNews, isOwnStageMove, lifecycle, markerLaneChange, namesUserAsBlocker, ownPullClosed, ownerApproval, prGate, projectApprovalMarker, resolveChecklistItem, reviewMarker, reviewWorkerThread, specHash, stuckDue, UNREADABLE_VERDICT, unheardWait, workerInFlight, workerReportedTerminal, type IdleBinding, type ProjectApprovalRecord } from "./reconcile.js";
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
    const before = { entity: pull({}, { requestedReviewers: [] }), pulls: [] };
    const ownPush = { entity: pull({}, { headSha: "bbbbbbb2", headAuthor: "jane", requestedReviewers: [] }), pulls: [] };
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
    const running = { ...ctx, workerInFlight: true, ownPulls: new Set(["acme/web#7"]) };
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

describe("the worker's own pull requests and state moves (BB-52)", () => {
  const stageOf = (state: string) => phaseOf(tickets, state)?.stage ?? null;
  const linked = { linkedPulls: [{ key: "acme/web#7", url: "https://github.com/acme/web/pull/7" }] };
  const running = { ...ctx, workerInFlight: true, stageOf };
  const ownPulls = new Set(["acme/web#7"]);

  it("quiets the worker's own pull request activity, and treats an unknown pull request as foreign", () => {
    const before = { entity: issue({ ...linked }), pulls: [pull({ author: "jane" }, { headAuthor: "jane" })] };
    const busy = { entity: issue({ ...linked }), pulls: [pull({ author: "jane", comments: [comment({ id: "r1", author: "jane" })] }, { headSha: "bbbbbbb2", headAuthor: "jane", checks: { state: "success", failing: [] } })] };
    expect(actionable(diffObserved(before, busy, { ...running, ownPulls }))).toEqual([]);
    // Ownership the plugin cannot establish is foreign: the same activity wakes.
    expect(actionable(diffObserved(before, busy, { ...running, ownPulls: new Set() }))).toEqual(["acme/web#7: Checks finished: success", "acme/web#7: 1 new comment from jane"]);
  });

  it("wakes for a foreign pull request linked while a worker is in flight, and keeps its activity actionable", () => {
    const before = { entity: issue({ state: "In Progress", stateType: "started" }), pulls: [] };
    const after = { entity: issue({ state: "In Progress", stateType: "started", ...linked }), pulls: [pull({ author: "sam" }, { headAuthor: "sam" })] };
    const foreign = actionable(diffObserved(before, after, { ...running, ownPulls: new Set() }));
    expect(foreign).toContain("Pull request linked (not this ticket's worker): acme/web#7");
    expect(foreign).toContain("acme/web#7: now followed (open)");
    // The worker's own link is a quiet note, as the BB-17 quieting always was.
    expect(actionable(diffObserved(before, after, { ...running, ownPulls }))).toEqual([]);
  });

  it("quiets a build/review state move while a worker is in flight, and wakes for any other", () => {
    const before = { entity: issue({ state: "In Progress", stateType: "started" }), pulls: [] };
    const review = { entity: issue({ state: "In Review", stateType: "started" }), pulls: [] };
    expect(actionable(diffObserved(before, review, running))).toEqual([]);
    expect(actionable(diffObserved(review, before, running))).toEqual([]);
    // A move outside the build/review pair wakes: a non-owner move to another stage.
    const backlog = { entity: issue({ state: "Backlog", stateType: "backlog" }), pulls: [] };
    expect(actionable(diffObserved(before, backlog, running))).toEqual(["State: In Progress → Backlog"]);
    // With no worker in flight the same build/review move wakes.
    expect(actionable(diffObserved(before, review, ctx))).toEqual(["State: In Progress → In Review"]);
  });

  it("names the build/review move, so the server can hand the playbook's stages in", () => {
    expect(isOwnStageMove(stageOf, "In Progress", "In Review")).toBe(true);
    expect(isOwnStageMove(stageOf, "In Review", "In Progress")).toBe(true);
    expect(isOwnStageMove(stageOf, "In Progress", "Backlog")).toBe(false);
    expect(isOwnStageMove(stageOf, "Todo", "In Progress")).toBe(false);
    expect(isOwnStageMove(undefined, "In Progress", "In Review")).toBe(false);
  });

  it("keeps a linked pull request quiet when no worker is in flight, as before", () => {
    const before = { entity: issue({ state: "In Progress", stateType: "started" }), pulls: [] };
    const after = { entity: issue({ state: "In Progress", stateType: "started", ...linked }), pulls: [pull({ author: "sam" }, { headAuthor: "sam" })] };
    expect(actionable(diffObserved(before, after, { ...ctx, stageOf }))).toEqual([]);
  });

  it("reads a worker's final message that moved the entity to a terminal state", () => {
    expect(workerReportedTerminal("Merged acme/web#7 and set ENG-12 to Done.", "ENG-12", tickets)).toBe(true);
    expect(workerReportedTerminal("Set ENG-12 to Done", "ENG-12", tickets)).toBe(true);
    expect(workerReportedTerminal("ENG-12: Done", "ENG-12", tickets)).toBe(true);
    expect(workerReportedTerminal("ENG-12 is still In Review.", "ENG-12", tickets)).toBe(false);
    // A prediction is not a report that the state was set.
    expect(workerReportedTerminal("ENG-12 should be Done once the rollout lands.", "ENG-12", tickets)).toBe(false);
    expect(workerReportedTerminal("Done for OPS-9.", "ENG-12", tickets)).toBe(false);
    expect(workerReportedTerminal(null, "ENG-12", tickets)).toBe(false);
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
    expect(actionable(diffObserved(before, after, { ...ctx, workerInFlight: true, ownPulls: new Set(["acme/web#7"]) }))).toEqual([]);
    // A round that changes the lane is not.
    const changed = { entity: pull({ author: "jane", comments: [marker(1, "no-review"), marker(2, "owner-reviewed")] }), pulls: [] };
    expect(actionable(diffObserved(after, changed, { ...ctx, workerInFlight: true, ownPulls: new Set(["acme/web#7"]) }))).toEqual(["Review lane: no-review → owner-reviewed"]);
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
    expect(actionable(diffObserved(before, reviewed, { ...ctx, workerInFlight: true, ownPulls: new Set(["acme/web#7"]) }))).toEqual([]);
    // The worker pushes (woken again), still in flight.
    const pushed = { entity: reviewed.entity, pulls: [pull({ author: "jane", comments: reviewed.pulls[0]!.comments }, { headSha: "bbbbbbb2", headAuthor: "jane", checks: { state: "success", failing: [] } })] };
    expect(actionable(diffObserved(reviewed, pushed, { ...ctx, workerInFlight: true, ownPulls: new Set(["acme/web#7"]) }))).toEqual([]);
    // Nothing was actionable while it was in flight, so the steward is woken
    // once, at the finish, with all of it as quiet notes.
    const changes = diffObserved(before, pushed, { ...ctx, workerInFlight: anyWorkerInFlight([worker("stopped")]), ownPulls: new Set(["acme/web#7"]) });
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
  const status = (waitingOn: string | null) => ({ phase: "Todo", summary: "s", nextAction: "n", actor: "other" as const, waitingOn, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });
  const open = [{ id: "esc_1", bindingId: "b", kind: "decision" as const, question: "q", context: null, meanwhile: "m", route: "project" as const, recommendation: null, choices: [], status: "open" as const, resolution: null, createdAt: 1, resolvedAt: null, deliveredAt: null, projectId: null, origin: { threadId: null, bindingId: null, chain: [] }, resolutionKind: null, url: null, data: {}, answeredBy: null, forwardedFrom: null, headSha: null, isQuestion: false, citedLessons: [], correctionsCounted: false, rationaleWanted: null, rationaleAsked: false, rationaleGiven: false, clusterKey: null }];

  it("flags a status waiting on the project steward or the user with no escalation open", () => {
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
    for (const text of ["no", "No.", "not approved", "don't ship it", "declined", "reject", "changes needed", "don't", "do not approve", "No, not yet", "won't approve until the migration is named", "can't approve without SSO", "cannot approve this spec yet", "shouldn't approve until naming is fixed", "never approve this as-is"]) expect(classifyApproval(text), text).toBe("decline");
    // A word ending in "nt" is not a contraction: wanting to approve approves.
    expect(classifyApproval("I want to approve")).toBe("approve");
    for (const text of ["", "maybe", "name the migration in the spec", "what about SSO?"]) expect(classifyApproval(text), text).toBe("ambiguous");
  });

  it("flags a report that asks for an approval already open, and only that", () => {
    const status = (summary: string, nextAction: string) => ({ phase: "Todo", summary, nextAction, actor: "user" as const, waitingOn: null, requeueAfterMs: null, conditions: [], resources: { workers: [], pullRequests: [], children: [] }, at: 1 });
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

  it("releases a ticket whose assignee set no longer names this server, and reopens it when it returns", () => {
    const owner = "jane";
    expect(lifecycle(open, tickets, issue({ assignees: ["jane"] }), "bb-managed", { owner }).kind).toBe("continue");
    expect(lifecycle(open, tickets, issue({ assignees: ["sam"] }), "bb-managed", { owner }).kind).toBe("reassigned");
    expect(lifecycle(open, tickets, issue({ assignees: [] }), "bb-managed", { owner }).kind).toBe("reassigned");
    // A login that could not be read never releases a binding (BB-115 limit a).
    expect(lifecycle(open, tickets, issue({ assignees: ["sam"] }), "bb-managed", { owner: null }).kind).toBe("continue");
    expect(lifecycle(open, tickets, issue({ assignees: ["sam"] }), "bb-managed", {}).kind).toBe("continue");
    // A review or pr binding follows its label, not an assignee.
    expect(lifecycle({ ...open, kind: "review" }, reviews, pull(), "bb-managed", { owner }).kind).toBe("continue");
    // Assigned back to this server, an ended reassignment resumes; one still
    // assigned elsewhere stays ended.
    expect(lifecycle({ ...open, endedAt: 1, endReason: "reassigned" }, tickets, issue({ assignees: ["jane"] }), "bb-managed", { owner }).kind).toBe("reopen");
    expect(lifecycle({ ...open, endedAt: 1, endReason: "reassigned" }, tickets, issue({ assignees: ["sam"] }), "bb-managed", { owner }).kind).toBe("stay-ended");
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

describe("the pull request gate (build-tickets)", () => {
  const head = "aaaaaaa1";
  const marker = (sha: string, verdict: string, lane: string) =>
    comment({ id: `m-${sha}-${verdict}-${lane}`, author: "trotterdylan", body: `<!-- bb-review round=1 sha=${sha} verdict=${verdict} lane=${lane} -->`, signedBy: "thr_reviewer", createdAt: "2026-10-14T16:00:00Z" });
  const owner = (body: string) => comment({ id: `oa-${body}`, author: "jane", body, signedBy: null, createdAt: "2026-10-14T17:00:00Z" });
  const approval = (sha: string, entry: string | null, verdict: "approved" | "declined" = "approved", id = `ap-${sha}-${verdict}`, createdAt = "2026-10-14T16:10:00Z") =>
    comment({ id, author: "trotterdylan", body: approvalMarkerLine({ sha, entry, verdict }), signedBy: "thr_project", createdAt });
  const record = (commentId: string, verdict: "approved" | "declined" = "approved"): ProjectApprovalRecord => ({ commentId, verdict });
  const green = { checks: { state: "success", failing: [] } };

  it("is met with the reviewer's approval on the head and green checks in the no-review lane", () => {
    const gate = prGate(pull({ comments: [marker(head, "approved", "no-review")] }, green));
    expect(gate).toMatchObject({ lane: "no-review", checksGreen: true, ownerApproved: false, gateMet: true, needsOwnerApproval: false, missing: null });
  });

  it("honours an approved marker on an earlier sha, in both lanes, until a later verdict or failing checks", () => {
    const earlier = "bbbbbbb2";
    // Approved on A with the head at B: the no-review gate is met, and the owner lane waits only on the owner.
    const met = prGate(pull({ comments: [marker(earlier, "approved", "no-review")] }, green));
    expect(met).toMatchObject({ lane: "no-review", checksGreen: true, gateMet: true, needsOwnerApproval: false, missing: null });
    expect(met.marker?.sha).toBe(earlier);
    expect(met.headSha).toBe(head);
    const waiting = prGate(pull({ comments: [marker(earlier, "approved", "owner-reviewed")] }, green));
    expect(waiting).toMatchObject({ gateMet: false, needsOwnerApproval: true, missing: "owner approval needed" });
    const approved = prGate(pull({ comments: [marker(earlier, "approved", "owner-reviewed"), owner("LGTM")] }, green));
    expect(approved).toMatchObject({ gateMet: true, needsOwnerApproval: false });
    // The latest marker wins: a later changes-requested on any sha blocks the gate.
    const later = comment({ id: "m-later", author: "trotterdylan", body: "<!-- bb-review round=2 sha=ccccccc3 verdict=changes-requested lane=no-review -->", signedBy: "thr_reviewer", createdAt: "2026-10-14T16:30:00Z" });
    expect(prGate(pull({ comments: [marker(earlier, "approved", "no-review"), later] }, green)).missing).toMatch(/reviewer verdict: changes-requested/u);
    // Checks failing on the head close it whatever the marker says.
    expect(prGate(pull({ comments: [marker(earlier, "approved", "no-review")] }, { checks: { state: "failure", failing: ["ci"] } })).missing).toMatch(/checks failure/u);
  });

  it("reads a malformed later marker as a round that is not approved, never as the earlier approval (bb-plugins#88)", () => {
    // The reviewer's round 2 on bb-plugins#88 was `<!-- bb-review round=2 sha=S changes-requested -->`:
    // no `verdict=`, no `lane=`. Skipping it would make round 1's `approved` the latest word
    // and file an approve-pr item for the owner on a head the reviewer had just rejected.
    const bad = comment({ id: "m-bad", author: "trotterdylan", body: "<!-- bb-review round=2 sha=ccccccc3 changes-requested -->\n\n## Review round 2", signedBy: "thr_reviewer", createdAt: "2026-10-14T16:30:00Z" });
    expect(reviewMarker(bad.body)).toEqual({ round: 2, sha: "ccccccc3", verdict: "changes-requested", lane: null });
    const gate = prGate(pull({ comments: [marker(head, "approved", "owner-reviewed"), bad] }, green));
    expect(gate).toMatchObject({ gateMet: false, needsOwnerApproval: false, lane: null, missing: "reviewer verdict: changes-requested" });
    // A marker with nothing readable at all still closes the gate, in the owner's lane.
    const empty = comment({ id: "m-empty", author: "trotterdylan", body: "<!-- bb-review -->", signedBy: "thr_reviewer", createdAt: "2026-10-14T16:40:00Z" });
    expect(reviewMarker(empty.body)).toEqual({ round: 0, sha: "", verdict: UNREADABLE_VERDICT, lane: null });
    expect(prGate(pull({ comments: [marker(head, "approved", "no-review"), empty] }, green))).toMatchObject({ gateMet: false, needsOwnerApproval: false, missing: `reviewer verdict: ${UNREADABLE_VERDICT}` });
    // A marker that names no lane is not a lane change.
    expect(markerLaneChange([marker(head, "approved", "owner-reviewed")], [marker(head, "approved", "owner-reviewed"), bad])).toBeNull();
    // Keys in another order, or a verdict that is not approved, still read.
    expect(reviewMarker("<!-- bb-review lane=no-review verdict=approved sha=abc round=3 -->")).toEqual({ round: 3, sha: "abc", verdict: "approved", lane: "no-review" });
    expect(reviewMarker("<!-- bb-reviewer round=1 -->")).toBeNull();
  });

  it("waits on the owner in the owner-reviewed lane, and closes once they approve", () => {
    const waiting = prGate(pull({ comments: [marker(head, "approved", "owner-reviewed")] }, green));
    expect(waiting).toMatchObject({ gateMet: false, needsOwnerApproval: true, missing: "owner approval needed" });
    const approved = prGate(pull({ comments: [marker(head, "approved", "owner-reviewed"), owner("LGTM")] }, green));
    expect(approved).toMatchObject({ gateMet: true, ownerApproved: true, needsOwnerApproval: false });
  });

  it("accepts a project-steward approval for a project entry, and only the user's for a user entry (BB-30)", () => {
    const ap = approval(head, "A cross-repo contract");
    const project = pull({ comments: [marker(head, "approved", "owner-reviewed"), ap] }, green);
    expect(prGate(project, { decision: "project", projectApprovals: [record(ap.id)] })).toMatchObject({ decision: "project", projectApproved: true, gateMet: true, needsOwnerApproval: false });
    // The same approval on a `user` entry is ignored: the user's unsigned GitHub approval is required.
    expect(prGate(project, { decision: "user", projectApprovals: [record(ap.id)] })).toMatchObject({ decision: "user", projectApproved: false, gateMet: false, needsOwnerApproval: true, missing: "owner approval needed" });
    // The user's unsigned approval satisfies it either way.
    const ownerApproved = pull({ comments: [marker(head, "approved", "owner-reviewed"), owner("LGTM")] }, green);
    expect(prGate(ownerApproved, { decision: "user" }).gateMet).toBe(true);
    // No project approval means the owner's.
    expect(prGate(pull({ comments: [marker(head, "approved", "owner-reviewed")] }, green), { projectApprovals: [] }).needsOwnerApproval).toBe(true);
  });

  it("makes the decide mark the whole gate: a project entry the project steward, everything else the owner (BB-51)", () => {
    const ap = approval(head, "A cross-repo contract");
    const project = pull({ comments: [marker(head, "approved", "owner-reviewed"), ap] }, green);
    const projectWaiting = prGate(project, { decision: "project", projectApprovals: [] });
    expect(projectWaiting).toMatchObject({ decision: "project", needsProjectApproval: true, needsOwnerApproval: false, gateMet: false, missing: "project steward approval needed" });
    expect(prGate(project, { decision: "project", projectApprovals: [record(ap.id)] })).toMatchObject({ gateMet: true, needsProjectApproval: false });
    // A user entry needs the owner, and a project-steward approval is not the gate.
    const userWaiting = prGate(project, { decision: "user", projectApprovals: [] });
    expect(userWaiting).toMatchObject({ decision: "user", needsOwnerApproval: true, needsProjectApproval: false, gateMet: false, missing: "owner approval needed" });
    expect(prGate(project, { decision: "user", projectApprovals: [record(ap.id)] })).toMatchObject({ projectApproved: false, gateMet: false, needsOwnerApproval: true });
    // An owner approval satisfies the user lane, not the project lane.
    const ownerApproved = pull({ comments: [marker(head, "approved", "owner-reviewed"), owner("LGTM")] }, green);
    expect(prGate(ownerApproved, { decision: "user" }).gateMet).toBe(true);
    expect(prGate(ownerApproved, { decision: "project", projectApprovals: [] }).gateMet).toBe(false);
  });

  it("honours a project-steward marker only when the plugin recorded its comment id (BB-77)", () => {
    // A hand-typed lookalike: the marker text is right, the comment id is not in the store.
    const fake = approval(head, "A cross-repo contract", "approved", "typed-by-hand");
    const project = pull({ comments: [marker(head, "approved", "owner-reviewed"), fake] }, green);
    expect(prGate(project, { decision: "project", projectApprovals: [record("IC_1")] })).toMatchObject({ projectApproved: false, gateMet: false, missing: "project steward approval needed" });
    // The record alone, with the marker gone from the snapshot, is not an approval either.
    expect(prGate(pull({ comments: [marker(head, "approved", "owner-reviewed")] }, green), { decision: "project", projectApprovals: [record(fake.id)] })).toMatchObject({ projectApproved: false, gateMet: false });
    // A declined marker is not an approval even when its record matches.
    const declined = approval(head, "A cross-repo contract", "declined", "IC_declined");
    expect(prGate(pull({ comments: [marker(head, "approved", "owner-reviewed"), declined] }, green), { decision: "project", projectApprovals: [record(declined.id, "declined")] })).toMatchObject({ projectApproved: false, gateMet: false, missing: "project steward approval needed" });
  });

  it("lets a decline at a later sha revoke an earlier approval, and a later approval revoke the decline (BB-77)", () => {
    const sha1 = "aaaaaaa1";
    const sha2 = "bbbbbbb2";
    const sha3 = "ccccccc3";
    const approved = approval(sha1, "A cross-repo contract", "approved", "IC_approved", "2026-10-14T16:10:00Z");
    const declined = approval(sha2, "A cross-repo contract", "declined", "IC_declined", "2026-10-14T16:20:00Z");
    const records: ProjectApprovalRecord[] = [record(approved.id), record(declined.id, "declined")];
    const declinedPull = pull({ comments: [marker(sha1, "approved", "owner-reviewed"), approved, declined] }, { ...green, headSha: sha3 });
    expect(prGate(declinedPull, { decision: "project", projectApprovals: records })).toMatchObject({ projectApproved: false, gateMet: false, missing: "project steward approval needed" });
    const approvedAgain = approval(sha3, "A cross-repo contract", "approved", "IC_approved_again", "2026-10-14T16:30:00Z");
    const reapproved = pull({ comments: [marker(sha1, "approved", "owner-reviewed"), approved, declined, approvedAgain] }, { ...green, headSha: sha3 });
    expect(prGate(reapproved, { decision: "project", projectApprovals: [...records, record(approvedAgain.id)] })).toMatchObject({ projectApproved: true, gateMet: true });
  });

  it("covers a later head with an approval recorded on an earlier one (BB-77)", () => {
    const earlier = "bbbbbbb2";
    const ap = approval(earlier, "A cross-repo contract");
    const moved = pull({ comments: [marker(earlier, "approved", "owner-reviewed"), ap] }, { ...green, headSha: head });
    expect(moved.pull?.headSha).toBe(head);
    expect(prGate(moved, { decision: "project", projectApprovals: [record(ap.id)] })).toMatchObject({ projectApproved: true, gateMet: true, headSha: head });
  });

  it("renders and parses the approval marker, quoting an entry with spaces (BB-77)", () => {
    const line = approvalMarkerLine({ sha: head, entry: "A cross-repo contract other repos implement", verdict: "approved" });
    expect(line).toBe(`<!-- bb-approval by=project-steward sha=${head} entry="A cross-repo contract other repos implement" -->`);
    expect(projectApprovalMarker(line)).toEqual({ by: "project-steward", sha: head, entry: "A cross-repo contract other repos implement", verdict: null });
    expect(projectApprovalMarker(approvalMarkerLine({ sha: head, entry: null, verdict: "declined" }))).toEqual({ by: "project-steward", sha: head, entry: null, verdict: "declined" });
    expect(projectApprovalMarker("<!-- bb-review round=1 -->")).toBeNull();
  });

  it("finds the worker that posted build-tickets' review comment (BB-77)", () => {
    const c = comment({ id: "w", body: "Independent review running in bb thread thr_w.", signedBy: "thr_w" });
    expect(reviewWorkerThread([c])).toBe("thr_w");
    expect(reviewWorkerThread([comment({ id: "u", body: "Independent review running.", signedBy: null })])).toBeNull();
  });

  it("fails closed on a lane the plugin cannot read (BB-30)", () => {
    // An unknown lane is treated as owner-reviewed, not no-review.
    const unknown = prGate(pull({ comments: [marker(head, "approved", "something-else")] }, green), { projectApprovals: [] });
    expect(unknown).toMatchObject({ lane: "something-else", gateMet: false, needsOwnerApproval: true });
    // With a project approval it is satisfied as owner-reviewed, not as no-review.
    const ap = approval(head, "A cross-repo contract");
    const withAp = pull({ comments: [marker(head, "approved", "something-else"), ap] }, green);
    expect(prGate(withAp, { decision: "project", projectApprovals: [record(ap.id)] }).gateMet).toBe(true);
    expect(prGate(withAp, { projectApprovals: [] }).gateMet).toBe(false);
  });

  it("is not met when the verdict is not approved, checks are not green, or there is no round", () => {
    expect(prGate(pull({ comments: [marker(head, "changes-requested", "no-review")] }, green)).missing).toMatch(/reviewer verdict: changes-requested/u);
    expect(prGate(pull({ comments: [marker(head, "approved", "no-review")] }, { checks: { state: "pending", failing: [] } })).missing).toMatch(/checks pending/u);
    expect(prGate(pull({ comments: [] })).missing).toMatch(/no reviewer round/u);
  });

  it("takes an APPROVED review by the connected user, but never a signed comment", () => {
    const review = pull({ comments: [marker(head, "approved", "owner-reviewed")] }, { ...green, reviews: [{ author: "jane", state: "APPROVED", submittedAt: "2026-10-14T17:00:00Z", commit: head }] });
    expect(ownerApproval(review)).toMatchObject({ approved: true });
    const signed = pull({ comments: [marker(head, "approved", "owner-reviewed"), comment({ author: "jane", body: "LGTM", signedBy: "thr_w" })] }, green);
    expect(ownerApproval(signed).approved).toBe(false);
  });

  it("never reads an unsigned bb-review marker comment as the owner's approval (BB-110)", () => {
    // The reviewer posts as the connected user; when it leaves its signature
    // off, the marker still makes the comment a thread's, not the owner's.
    const unsignedMarker = (body: string) => comment({ id: "rev", author: "jane", body, signedBy: null, createdAt: "2026-10-14T17:00:00Z" });
    const marked = pull({ comments: [marker(head, "approved", "owner-reviewed"), unsignedMarker("<!-- bb-review round=2 sha=bbbbbbb2 verdict=approved lane=owner-reviewed -->\n\nLGTM, approved.")] }, green);
    expect(ownerApproval(marked).approved).toBe(false);
    // The same approving body without the marker is the owner's approval.
    const unmarked = pull({ comments: [marker(head, "approved", "owner-reviewed"), unsignedMarker("LGTM, approved.")] }, green);
    expect(ownerApproval(unmarked)).toMatchObject({ approved: true, at: "2026-10-14T17:00:00Z" });
  });

  it("never reads an unsigned bb-approval marker comment as the owner's approval (BB-110)", () => {
    const typed = comment({ id: "typed", author: "jane", body: approvalMarkerLine({ sha: head, entry: null, verdict: "approved" }), signedBy: null, createdAt: "2026-10-14T17:00:00Z" });
    expect(ownerApproval(pull({ comments: [marker(head, "approved", "owner-reviewed"), typed] }, green)).approved).toBe(false);
    // It is still read by the project-approval path when the plugin recorded its id.
    const ap = approval(head, "A cross-repo contract", "approved", "IC_recorded");
    const recorded = pull({ comments: [marker(head, "approved", "owner-reviewed"), { ...ap, author: "jane", signedBy: null }] }, green);
    expect(ownerApproval(recorded).approved).toBe(false);
    expect(prGate(recorded, { decision: "project", projectApprovals: [record(ap.id)] })).toMatchObject({ projectApproved: true, gateMet: true });
  });
});

describe("a waitingOn naming the user", () => {
  it("is refused without an item and allowed with one", () => {
    expect(namesUserAsBlocker("the user's answer on scope")).toBe(true);
    expect(namesUserAsBlocker("the owner's approval")).toBe(true);
    expect(namesUserAsBlocker("a human has to install it")).toBe(true);
    expect(namesUserAsBlocker("the project steward's call")).toBe(false);
    expect(namesUserAsBlocker("sam's review")).toBe(false);
  });
});

// BB-35 step 2: the citation counters. A correction is the owner's own words
// differing from the steward's recommendation on a decision that cited a
// lesson; only the owner's own unsigned comment counts.
describe("a correction from a comment", () => {
  it("is the connected owner's own unsigned words differing from the recommendation", () => {
    const mine = comment({ author: "jane", body: "Do it the other way.", signedBy: null });
    expect(commentDiffersFromRecommendation(mine, "jane", "Do it the recommended way.")).toBe(true);
    expect(commentDiffersFromRecommendation(mine, "jane", "Do it the other way.")).toBe(false);
    expect(commentDiffersFromRecommendation(mine, "jane", null)).toBe(false);
    expect(commentDiffersFromRecommendation(mine, null, "Do it the recommended way.")).toBe(false);
  });

  it("never counts someone else's comment, or a signed one", () => {
    // A non-owner's words are information, not an instruction.
    expect(commentDiffersFromRecommendation(comment({ author: "Sam", body: "No, do it the other way." }), "jane", "Do it the recommended way.")).toBe(false);
    // A signed comment belongs to a thread, however it reads.
    expect(commentDiffersFromRecommendation(comment({ author: "jane", body: "No, do it the other way.", signedBy: "thr_w" }), "jane", "Do it the recommended way.")).toBe(false);
  });

  it("never counts a thread's marker comment as the owner's correction, signed or not (BB-110)", () => {
    const marked = comment({ author: "jane", body: "<!-- bb-review round=1 sha=abc verdict=approved lane=owner-reviewed -->\n\nNo, do it the other way.", signedBy: null });
    expect(commentDiffersFromRecommendation(marked, "jane", "Do it the recommended way.")).toBe(false);
    const approvalMarked = comment({ author: "jane", body: `${approvalMarkerLine({ sha: "abc", entry: null, verdict: "approved" })}\n\nNo, do it the other way.`, signedBy: null });
    expect(commentDiffersFromRecommendation(approvalMarked, "jane", "Do it the recommended way.")).toBe(false);
    // The same words without the marker still correct.
    expect(commentDiffersFromRecommendation(comment({ author: "jane", body: "No, do it the other way.", signedBy: null }), "jane", "Do it the recommended way.")).toBe(true);
  });

  it("treats an empty side as no difference", () => {
    expect(answerDiffers("", "Do it.")).toBe(false);
    expect(answerDiffers("Do it.", "")).toBe(false);
    expect(answerDiffers("  do   it. ", "Do it.")).toBe(false);
    expect(answerDiffers("Don't do it.", "Do it.")).toBe(true);
  });
});

// BB-83: a binding in a build or review stage with nothing left to wait on is
// idle. The predicate is the whole mechanical rule; the server measures the
// grace and keeps it to one wake per idle period.
describe("idle in an active stage (BB-83)", () => {
  const own = new Set(["acme/web#7", "https://github.com/acme/web/pull/7"]);
  const binding = (over: Partial<IdleBinding> = {}): IdleBinding => ({
    stage: "review",
    ending: null,
    hold: null,
    deployments: {},
    workers: [{ status: "finished" }],
    ownPulls: own,
    escalations: [],
    needs: [],
    ...over,
  });
  const merged = { entity: issue({ state: "In Review" }), pulls: [pull({ state: "merged" })] };

  it("is true with nothing left to wait on", () => {
    expect(idleInActiveStage(binding(), merged)).toBe(true);
    // No worker at all, a build stage, and an open pull request that is not
    // the worker's own are each still idle.
    expect(idleInActiveStage(binding({ workers: [], stage: "build" }), merged)).toBe(true);
    expect(idleInActiveStage(binding(), { entity: issue({ state: "In Review" }), pulls: [pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9", state: "open" })] })).toBe(true);
    // A wait on the project steward is not a wait on the user.
    expect(idleInActiveStage(binding({ escalations: [{ status: "open", route: "project" }] }), merged)).toBe(true);
  });

  it("is false when any of the waits is present", () => {
    expect(idleInActiveStage(binding({ workers: [{ status: "running" }] }), merged)).toBe(false);
    expect(idleInActiveStage(binding(), { entity: issue({ state: "In Review" }), pulls: [pull({ state: "open" })] })).toBe(false);
    expect(idleInActiveStage(binding({ deployments: { "acme/web#7": { state: "merged" } as never } }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ deployments: { "acme/web#7": { state: "deploying" } as never } }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ hold: "a freeze" }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ ending: "terminal" }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ escalations: [{ status: "open", route: "me" }] }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ needs: [{ kind: "approve-pr" }] }), merged)).toBe(false);
    // The spec stage is not active, and a deployment that is already deployed
    // is nothing to wait on.
    expect(idleInActiveStage(binding({ stage: "spec" }), merged)).toBe(false);
    expect(idleInActiveStage(binding({ deployments: { "acme/web#7": { state: "deployed" } as never } }), merged)).toBe(true);
  });

  it("starts a new idle period when an own pull request closes", () => {
    const before = { entity: issue({ state: "In Review" }), pulls: [pull({ state: "open" })] };
    expect(ownPullClosed(before, merged, own)).toBe(true);
    expect(ownPullClosed(merged, merged, own)).toBe(false);
    // A foreign pull request closing is not the binding's own event.
    expect(ownPullClosed(before, { entity: issue({ state: "In Review" }), pulls: [pull({ key: "acme/web#9", url: "https://github.com/acme/web/pull/9", state: "merged" })] }, own)).toBe(false);
  });
});
