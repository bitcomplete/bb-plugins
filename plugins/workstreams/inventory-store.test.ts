import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrList } from "./gh.js";
import type { Pr } from "./contract.js";
import { createInventoryStore, INVENTORY_MIGRATIONS, PR_MERGES_MIGRATION, PR_OBSERVATION_CLOSED_MIGRATION, PR_OBSERVATION_ERROR_MIGRATION,
  PR_OBSERVATIONS_MIGRATION, PR_STATE_SINCE_MIGRATION } from "./inventory-store.js";
import { INVENTORY_LIMIT, type InventoryEntry, type InventoryResult } from "./inventory.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup(datesStates = false, keepsErrors = false, keepsClosed = false, keepsMerges = false) {
  const db = new Database(":memory:");
  databases.push(db);
  for (const migration of INVENTORY_MIGRATIONS) db.exec(migration);
  db.exec(PR_OBSERVATIONS_MIGRATION);
  if (datesStates) db.exec(PR_STATE_SINCE_MIGRATION);
  if (keepsErrors) db.exec(PR_OBSERVATION_ERROR_MIGRATION);
  if (keepsClosed) db.exec(PR_OBSERVATION_CLOSED_MIGRATION);
  if (keepsMerges) db.exec(PR_MERGES_MIGRATION);
  let clock = 1_000;
  return { db, store: createInventoryStore(db, () => clock), tick: () => { clock += 1_000; } };
}
function entry(number: number, repo = "inkwell/folio"): InventoryEntry {
  return { repo, pr: parsePrList(JSON.stringify([{ number, state: "OPEN", url: `https://github.com/${repo}/pull/${number}`, title: "Improve manuscript review" }]))!.pr };
}
function result(entries: InventoryEntry[], extra: Partial<InventoryResult> = {}): InventoryResult {
  return { owners: ["inkwell"], entries, discoveryComplete: true, complete: true, warnings: [],
    repositories: [...new Set(entries.map((row) => row.repo))].map((repo) => ({ repo, complete: true })), ...extra };
}

describe("authored PR cache coverage", () => {
  it("finds a URL without case sensitivity and refuses closed or corrupt persisted rows", () => {
    const { db, store } = setup();
    const first = entry(1);
    store.apply(result([first]));
    expect(store.get(first.pr.url.toUpperCase())?.pr.number).toBe(1);
    db.prepare(`UPDATE authored_prs SET entry = ? WHERE url = ?`).run(JSON.stringify({ ...first, pr: { ...first.pr, state: "CLOSED" } }), first.pr.url);
    expect(store.get(first.pr.url)).toBeUndefined();
    db.prepare(`UPDATE authored_prs SET entry = ? WHERE url = ?`).run("bad json", first.pr.url);
    expect(store.get(first.pr.url)).toBeUndefined();
  });

  it("loads cached PRs with the retired approval reply field without treating it as feedback evidence", () => {
    const { db, store } = setup();
    const first = entry(1);
    const legacy = { ...first, pr: { ...first.pr, reviewDecision: "APPROVED", approvalNoteFollowedUp: true } };
    db.prepare(`INSERT INTO authored_prs (url, repo, entry, stale) VALUES (?, ?, ?, 0)`)
      .run(first.pr.url.toLowerCase(), first.repo, JSON.stringify(legacy));
    expect(store.read().entries).toMatchObject([{ pr: { number: 1, approvalNoteFollowedUp: true } }]);
    expect(store.get(first.pr.url)?.pr.approvalFeedback).toBeUndefined();
  });

  it("removes closed PRs in successful repositories while retaining failed repositories as stale", () => {
    const { store, tick } = setup();
    store.apply(result([entry(1), entry(2, "inkwell/spine")]));
    const success = store.read().lastSuccessAt;
    tick();
    store.apply(result([], { complete: false, repositories: [
      { repo: "inkwell/folio", complete: true }, { repo: "inkwell/spine", complete: false },
    ], warnings: ["spine is offline"] }));
    expect(store.read()).toMatchObject({ complete: false, lastSuccessAt: success, entries: [{ repo: "inkwell/spine", stale: true }] });
    expect(store.read().lastAttemptAt).not.toBe(success);
    expect(store.observation(entry(2, "inkwell/spine").pr.url)).toEqual({
      checkedAt: success, failedAt: new Date(2_000).toISOString(),
    });
  });

  it("removes undiscovered repositories only when discovery is complete", () => {
    const { store } = setup();
    store.apply(result([entry(1), entry(2, "inkwell/spine")]));
    store.apply(result([entry(1)], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toHaveLength(2);
    store.apply(result([entry(1)]));
    expect(store.read().entries.map((row) => row.repo)).toEqual(["inkwell/folio"]);
  });

  it("removes organizations outside the current project scope even when discovery fails", () => {
    const { store } = setup();
    store.apply(result([entry(1), entry(2, "margin/paper")], { owners: ["inkwell", "margin"] }));
    store.apply(result([], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toMatchObject([{ repo: "inkwell/folio", stale: true }]);
  });

  it("keeps a targeted failed read stale, removes confirmed closed PRs, and refuses unrelated inserts", () => {
    const { store, tick } = setup();
    const first = entry(1), second = entry(2);
    store.apply(result([first, second]));
    const checkedAt = store.observation(second.pr.url)?.checkedAt;
    tick();
    store.inspect({ entries: [entry(3)], closed: [first.pr.url], failed: [second.pr.url], warnings: ["offline"] });
    expect(store.read()).toMatchObject({ complete: false, entries: [{ pr: { number: 2 }, stale: true }] });
    expect(store.observation(second.pr.url)).toEqual({ checkedAt, failedAt: new Date(2_000).toISOString() });
    expect(store.observation(first.pr.url)).toEqual({ checkedAt: new Date(2_000).toISOString(), failedAt: null });
    tick();
    store.inspect({ entries: [second], closed: [], failed: [], warnings: [] });
    expect(store.get(second.pr.url)?.stale).toBe(false);
    expect(store.observation(second.pr.url)).toEqual({ checkedAt: new Date(3_000).toISOString(), failedAt: null });
  });

  it("bounds retained failed-repository history when new repositories arrive", () => {
    const { store } = setup();
    store.apply(result(Array.from({ length: INVENTORY_LIMIT }, (_, index) => entry(index + 1))));
    const fresh = entry(1, "inkwell/spine");
    store.apply(result([fresh], { complete: false, discoveryComplete: false }));
    expect(store.read().entries).toHaveLength(INVENTORY_LIMIT);
    expect(store.get(fresh.pr.url)?.stale).toBe(false);
    expect(store.read().warnings[0]).toContain("limit");
  });

  it("keeps why each PR's last read failed beside its time, until a read succeeds", () => {
    const { store, tick } = setup(false, true);
    const first = entry(1), second = entry(2), third = entry(3, "inkwell/spine");
    store.apply(result([first, second, third]));
    expect(store.observation(first.pr.url)).toEqual({ checkedAt: new Date(1_000).toISOString(), failedAt: null, error: null });
    tick();
    // A read that failed for everyone names the shared cause on every PR it couldn't read.
    store.apply(result([], { complete: false, discoveryComplete: false, warnings: ["GitHub's rate limit was reached; the next read waits until 17:05."] }));
    expect(store.observation(third.pr.url)).toMatchObject({ failedAt: new Date(2_000).toISOString(), error: expect.stringContaining("rate limit") });
    tick();
    // A read of one PR names that PR's own failure, not a neighbour's.
    store.inspect({ entries: [], closed: [], failed: [first.pr.url, second.pr.url],
      warnings: ["inkwell/folio #2: PR refresh failed: HTTP 502", "inkwell/folio #1: PR refresh failed: not found"] });
    expect(store.observation(first.pr.url)?.error).toBe("inkwell/folio #1: PR refresh failed: not found");
    expect(store.observation(second.pr.url)?.error).toBe("inkwell/folio #2: PR refresh failed: HTTP 502");
    tick();
    store.inspect({ entries: [first], closed: [], failed: [], warnings: [] });
    expect(store.observation(first.pr.url)).toEqual({ checkedAt: new Date(4_000).toISOString(), failedAt: null, error: null });
  });

  it("remembers that the last read found a PR merged, closed, or gone from your open PRs, until a read finds it open", () => {
    const { store, tick } = setup(false, true, true);
    const first = entry(1), second = entry(2), third = entry(3);
    store.apply(result([first, second, third]));
    tick();
    // #1 left a repository's full listing, a read of #2 found it closed, and a checkout scan found #3 merged.
    store.apply(result([second, third]));
    store.inspect({ entries: [], closed: [second.pr.url], failed: [], warnings: [] });
    store.observe([{ ...third.pr, state: "MERGED" }]);
    expect([first, second, third].map((row) => store.closed(row.pr.url))).toEqual([true, true, true]);
    tick();
    // Reopened, #1 is listed again.
    store.apply(result([first]));
    expect([first, second].map((row) => store.closed(row.pr.url))).toEqual([false, true]);
    // A copy of a database from before the column still records the read, and reads no closure.
    const old = setup(false, true).store;
    old.inspect({ entries: [], closed: [first.pr.url], failed: [], warnings: [] });
    expect([old.observation(first.pr.url)?.checkedAt, old.closed(first.pr.url)]).toEqual([expect.any(String), false]);
  });

  it("keeps each merge a read saw, at GitHub's merge time, after the PR leaves the inventory, so an effort still counts it", () => {
    const { store } = setup(false, false, false, true);
    const first = entry(1), second = entry(2, "inkwell/quill"), third = entry(3);
    store.apply(result([first, second, third]));
    // A read of #1 found it merged; a checkout scan found quill #2 merged and #3 closed without merging.
    store.inspect({ entries: [], closed: [first.pr.url], failed: [], warnings: [],
      merged: [{ url: first.pr.url, at: "2026-09-27T10:00:00Z", title: "ABC-11 Keep shelf order", headRefName: "abc-11-shelf" }] });
    store.observe([{ ...second.pr, state: "MERGED", mergedAt: "2026-09-28T10:00:00Z" }, { ...third.pr, state: "CLOSED" }]);
    expect(store.read().entries).toEqual([]);
    expect(store.merges()).toEqual([
      { url: second.pr.url.toLowerCase(), at: Date.parse("2026-09-28T10:00:00Z"), title: second.pr.title, headRefName: null },
      { url: first.pr.url.toLowerCase(), at: Date.parse("2026-09-27T10:00:00Z"), title: "ABC-11 Keep shelf order", headRefName: "abc-11-shelf" }]);
    // A later sighting of the same merge changes nothing, and a window leaves older merges out.
    store.observe([{ ...first.pr, state: "MERGED", mergedAt: "2026-09-29T10:00:00Z" }]);
    expect(store.merges(Date.parse("2026-09-28T00:00:00Z")).map((merge) => merge.url)).toEqual([second.pr.url.toLowerCase()]);
    // A copy of a database from before the table records and reads none.
    const old = setup().store;
    old.observe([{ ...second.pr, state: "MERGED", mergedAt: "2026-09-28T10:00:00Z" }]);
    expect(old.merges()).toEqual([]);
  });

  it("reflects fresh checkout observations without adding unauthored PRs", () => {
    const { store } = setup();
    const first = entry(1);
    store.apply(result([first]));
    store.observe([{ ...first.pr, state: "CLOSED" }, entry(2).pr]);
    expect(store.read().entries).toEqual([]);
    expect(store.observation(entry(2).pr.url)?.checkedAt).toBe(new Date(1_000).toISOString());
  });

  // The inventory's poll and Refresh own an authored PR's facts. A scan's PR carries no review read of a comment-only PR or a draft, and a
  // PR with none says nothing waits on you: written over the inventory's, it took the PR off Your turn until the next read. Nor does the
  // scan mark the row read: the row would say "checked just now" over facts it didn't write, and Refresh would take it for its own read.
  it("neither rewrites an authored PR a checkout scan read nor marks it read", () => {
    const { store, tick } = setup(true, true);
    const at = "2026-09-28T10:00:00Z";
    const comment: InventoryEntry = { ...entry(1), pr: { ...entry(1).pr, latestReviews: [{ login: "ines", state: "COMMENTED", submittedAt: at }],
      reviewFeedback: { openThreads: 2, comment: { login: "ines", at }, repliedAt: null, noteAt: null, followUpAt: null } } };
    const draft: InventoryEntry = { ...entry(2), pr: { ...entry(2).pr, isDraft: true, reviewDecision: "CHANGES_REQUESTED",
      latestReviews: [{ login: "otto", state: "CHANGES_REQUESTED", submittedAt: at }], approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] },
      reviewFeedback: { openThreads: 1, comment: null, repliedAt: null, noteAt: null, followUpAt: null } } };
    store.apply(result([comment, draft]));
    tick();
    store.inspect({ entries: [], closed: [], failed: [comment.pr.url], warnings: ["inkwell/folio #1: rate limited"] });
    tick();
    const scanned = [comment, draft].map(({ pr: { reviewFeedback: _read, approvalFeedback: _approval, ...pr } }): Pr => ({ ...pr, checkConclusions: ["FAILURE"] }));
    store.observe(scanned);
    expect(store.read().entries.map((row) => row.pr)).toEqual([comment.pr, draft.pr]);
    expect([store.observation(comment.pr.url), store.observation(draft.pr.url)]).toEqual([
      { checkedAt: new Date(1_000).toISOString(), failedAt: new Date(2_000).toISOString(), error: "inkwell/folio #1: rate limited" },
      { checkedAt: new Date(1_000).toISOString(), failedAt: null, error: null }]);
    // Nor does it date a state the row it left alone doesn't show.
    expect(store.statesSince()).toEqual(new Map());
  });
});

describe("undated PR states", () => {
  const url = entry(1).pr.url.toLowerCase();
  const red = (patch: Partial<Pr> = {}): InventoryEntry => ({ ...entry(1), pr: { ...entry(1).pr, checkConclusions: ["FAILURE"], mergeable: "CONFLICTING", ...patch } });

  it("dates red checks and a conflict from the first read that sees them, through full refreshes, until a read sees them end", () => {
    const { store, tick } = setup(true);
    store.apply(result([red()]));
    tick();
    // A full refresh rewrites every row of the repository; the dates stay with the PR.
    store.apply(result([red()]));
    expect(store.statesSince().get(url)).toEqual({ "ci-red": 1_000, conflicting: 1_000 });
    tick();
    // Green again ends the red state; GitHub still computing mergeability neither ends nor restarts the conflict.
    store.inspect({ entries: [red({ checkConclusions: ["SUCCESS"], mergeable: "UNKNOWN" })], closed: [], failed: [], warnings: [] });
    expect(store.statesSince().get(url)).toEqual({ conflicting: 1_000 });
    tick();
    store.inspect({ entries: [red({ checkConclusions: ["FAILURE"], mergeable: "MERGEABLE" })], closed: [], failed: [], warnings: [] });
    expect(store.statesSince().get(url)).toEqual({ "ci-red": 4_000 });
  });

  it("keeps dates through a failed read, and forgets them when the PR closes or leaves the inventory", () => {
    const { store } = setup(true);
    store.apply(result([red(), { ...red(), pr: { ...red().pr, number: 2, url: entry(2).pr.url } }]));
    store.inspect({ entries: [], closed: [], failed: [entry(1).pr.url], warnings: ["GitHub unavailable"] });
    expect([...store.statesSince().keys()]).toEqual([url, entry(2).pr.url.toLowerCase()]);
    store.inspect({ entries: [], closed: [entry(1).pr.url], failed: [], warnings: [] });
    expect([...store.statesSince().keys()]).toEqual([entry(2).pr.url.toLowerCase()]);
    store.apply(result([]));
    expect(store.statesSince()).toEqual(new Map());
    // A PR the inventory doesn't hold is never dated.
    store.inspect({ entries: [red()], closed: [], failed: [], warnings: [] });
    store.observe([red().pr]);
    expect(store.statesSince()).toEqual(new Map());
  });

  it("reads no dates, and writes none, in a database copied before the table existed", () => {
    const { store } = setup();
    store.apply(result([red()]));
    expect(store.statesSince()).toEqual(new Map());
  });
});

describe("PR ages through reads that date nothing", () => {
  const iso = (at: number) => new Date(at).toISOString();
  const head = "a".repeat(40);
  const aged: InventoryEntry = { ...entry(1), pr: { ...entry(1).pr, headRefOid: head, reviewRequests: ["mira", "otto"],
    headCommittedAt: iso(1), reviewRequestedAt: [{ reviewer: "mira", at: iso(2) }, { reviewer: "otto", at: iso(3) }] } };
  const { headCommittedAt: _pushed, reviewRequestedAt: _asked, ...undated } = aged.pr;

  it("keeps the inventory's ages while the head and requests stand, through a read that dates nothing", () => {
    const { store } = setup();
    const read = (pr: Pr) => store.inspect({ entries: [{ ...aged, pr }], closed: [], failed: [], warnings: [] });
    store.apply(result([aged]));
    read({ ...undated, reviewRequests: ["mira"] });
    expect(store.get(aged.pr.url)?.pr).toMatchObject({ headCommittedAt: iso(1), reviewRequestedAt: [{ reviewer: "mira", at: iso(2) }] });
    read({ ...undated, headRefOid: "b".repeat(40), reviewRequests: ["mira"] });
    expect(store.get(aged.pr.url)?.pr.headCommittedAt).toBeUndefined();
    expect(store.get(aged.pr.url)?.pr.reviewRequestedAt).toEqual([{ reviewer: "mira", at: iso(2) }]);
  });

  it("keeps them through a refresh whose ages read GitHub refused, so a rate limit never erases a nudge", () => {
    const { store } = setup();
    store.apply(result([aged]));
    store.apply(result([{ ...aged, pr: undated }], { complete: false, warnings: ["inkwell/folio: PR ages could not be read: API rate limit exceeded"] }));
    expect(store.get(aged.pr.url)?.pr).toMatchObject({ headCommittedAt: iso(1), reviewRequestedAt: aged.pr.reviewRequestedAt });
    store.inspect({ entries: [{ ...aged, pr: { ...undated, reviewRequests: ["otto"] } }], closed: [], failed: [], warnings: ["rate limited"] });
    expect(store.get(aged.pr.url)?.pr).toMatchObject({ headCommittedAt: iso(1), reviewRequestedAt: [{ reviewer: "otto", at: iso(3) }] });
    // A read that dates the PR replaces what the store kept.
    store.inspect({ entries: [{ ...aged, pr: { ...aged.pr, headCommittedAt: iso(9), reviewRequestedAt: [] } }], closed: [], failed: [], warnings: [] });
    expect(store.get(aged.pr.url)?.pr).toMatchObject({ headCommittedAt: iso(9), reviewRequestedAt: [] });
  });
});
