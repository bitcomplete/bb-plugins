// BB-328 Part 2: the pure half of the playbook refresh. Which stamped
// playbooks lag, whether one may be queued (one open per playbook, no retry
// after a decline until the template changes), how a published diff is
// classified, and the pull request body.
import { describe, expect, it } from "vitest";
import { classifyRefresh, hasTemplateStamp, laggingPlaybooks, refreshPrBody, refreshQueueDecision } from "./refresh.js";
import type { PlaybookRefresh } from "./store.js";

const refresh = (over: Partial<PlaybookRefresh>): PlaybookRefresh => ({
  id: "rfr_1",
  projectId: "p1",
  file: "stewards/playbooks/ops-watch.md",
  playbook: "ops-watch",
  templateName: "ops-watch",
  fromHash: "old",
  targetHash: "new",
  state: "queued",
  threadId: null,
  branch: null,
  pr: null,
  classification: null,
  removals: [],
  questionId: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
  resolvedAt: null,
  ...over,
});

const candidate = { name: "ops-watch", templateName: "ops-watch", fromHash: "old", toHash: "new" };

describe("laggingPlaybooks", () => {
  it("reports a stamped playbook whose hash moved, and nothing else", () => {
    const hashes = new Map([["ops-watch", "new"]]);
    const lags = laggingPlaybooks(
      [
        { name: "ops-watch", template: { name: "ops-watch", hash: "old" } },
        { name: "current", template: { name: "ops-watch", hash: "new" } },
        { name: "unstamped", template: null },
        { name: "gone", template: { name: "gone", hash: "old" } },
      ],
      hashes,
    );
    expect(lags).toEqual([{ name: "ops-watch", templateName: "ops-watch", fromHash: "old", toHash: "new" }]);
  });

  it("reports a playbook once however many load paths reached it", () => {
    const lags = laggingPlaybooks(
      [
        { name: "ops-watch", template: { name: "ops-watch", hash: "old" } },
        { name: "ops-watch", template: { name: "ops-watch", hash: "old" } },
      ],
      new Map([["ops-watch", "new"]]),
    );
    expect(lags).toHaveLength(1);
  });
});

describe("refreshQueueDecision", () => {
  it("queues when the playbook has no refresh yet", () => {
    expect(refreshQueueDecision([], candidate)).toEqual({ queue: true });
  });

  it("does not queue while a refresh is open (one open per playbook)", () => {
    for (const state of ["queued", "spawned", "pr_open"] as const) {
      expect(refreshQueueDecision([refresh({ state })], candidate)).toEqual({ queue: false, reason: "open" });
    }
  });

  it("does not retry a declined refresh until the template changes", () => {
    const declined = [refresh({ state: "declined", targetHash: "new" })];
    expect(refreshQueueDecision(declined, candidate)).toEqual({ queue: false, reason: "declined" });
    // The template moved again: a new target hash is a new refresh.
    expect(refreshQueueDecision(declined, { ...candidate, toHash: "newer" })).toEqual({ queue: true });
  });

  it("does not retry a failed refresh until the template changes", () => {
    const failed = [refresh({ state: "failed", targetHash: "new" })];
    expect(refreshQueueDecision(failed, candidate)).toEqual({ queue: false, reason: "failed" });
    expect(refreshQueueDecision(failed, { ...candidate, toHash: "newer" })).toEqual({ queue: true });
  });

  it("does not re-queue a target a merged refresh already updated", () => {
    const merged = [refresh({ state: "merged", targetHash: "new" })];
    expect(refreshQueueDecision(merged, candidate)).toEqual({ queue: false, reason: "merged" });
    expect(refreshQueueDecision(merged, { ...candidate, toHash: "newer" })).toEqual({ queue: true });
  });

  it("reads the newest refresh, so an older decline does not block a newer target", () => {
    const prior = [refresh({ id: "rfr_old", state: "declined", targetHash: "old" }), refresh({ id: "rfr_new", state: "merged", targetHash: "new" })];
    expect(refreshQueueDecision(prior, candidate)).toEqual({ queue: false, reason: "merged" });
  });
});

describe("classifyRefresh", () => {
  const before = ["---", "name: ops-watch", "kind: ops", "models:", "  worker: claude/opus", "---", "", "## New", "", "Existing rule.", ""].join("\n");

  it("calls an insertion-only body change purely additive", () => {
    const after = before.replace("Existing rule.", "Existing rule.\n\nNew template rule.");
    expect(classifyRefresh(before, after)).toEqual({ classification: "additive", removals: [], rewrites: [], reasons: [] });
  });

  it("treats the stamp change alone as additive", () => {
    const after = before.replace("kind: ops", "kind: ops\ntemplate: ops-watch@new");
    expect(classifyRefresh(before, after).classification).toBe("additive");
  });

  it("is not additive when a body line is removed", () => {
    const after = before.replace("Existing rule.\n", "");
    const c = classifyRefresh(before, after);
    expect(c.classification).toBe("not-additive");
    expect(c.removals).toContain("Existing rule.");
  });

  it("is not additive when a body line is rewritten", () => {
    const after = before.replace("Existing rule.", "Existing rule, changed.");
    const c = classifyRefresh(before, after);
    expect(c.classification).toBe("not-additive");
    expect(c.rewrites).toEqual([{ before: "Existing rule.", after: "Existing rule, changed." }]);
  });

  it("is never additive when models, may, a gate or requeue-default changes", () => {
    const base = ["---", "name: ops-watch", "kind: ops", "models: claude/opus", "may: [comment]", "requeue-default: 1h", "---", "", "Body.", ""].join("\n");
    for (const [key, value] of [
      ["models", "claude/sonnet"],
      ["may", "[comment, edit]"],
      ["requeue-default", "2h"],
      ["ready-gate", "on"],
    ] as const) {
      const after = base.includes(`${key}:`) ? base.replace(new RegExp(`^${key}:.*$`, "mu"), `${key}: ${value}`) : base.replace("kind: ops", `kind: ops\n${key}: ${value}`);
      const c = classifyRefresh(base, after);
      expect(c.classification, key).toBe("not-additive");
      expect(c.reasons.join(" "), key).toContain(key);
    }
  });

  it("is not additive when any other front-matter key changes", () => {
    const after = before.replace("kind: ops", "kind: ops, ops");
    expect(classifyRefresh(before, after).classification).toBe("not-additive");
  });
});

describe("refreshPrBody", () => {
  it("names the template, the stamp move and the removals", () => {
    const body = refreshPrBody(
      { playbook: "ops-watch", templateName: "ops-watch", fromHash: "old", targetHash: "new" },
      { classification: "not-additive", removals: ["Dropped rule."], rewrites: [{ before: "Old.", after: "New." }], reasons: [] },
      "thr_refresh",
    );
    expect(body).toContain("stewards/playbooks/ops-watch.md");
    expect(body).toContain("`old` → `new`");
    expect(body).toContain("Not purely additive");
    expect(body).toContain("Dropped rule.");
    expect(body).toContain("`Old.` → `New.`");
    expect(body).toContain("thr_refresh");
  });

  it("keeps the refresh thread's own summary as its claim", () => {
    const body = refreshPrBody(
      { playbook: "ops-watch", templateName: "ops-watch", fromHash: "old", targetHash: "new" },
      { classification: "additive", removals: [], rewrites: [], reasons: [] },
      "thr_refresh",
      "Purely additive: I added the new paragraph.",
    );
    expect(body).toContain("its claim, not the decision");
    expect(body).toContain("Purely additive: I added the new paragraph.");
  });
});

describe("hasTemplateStamp", () => {
  it("finds the stamp the refresh writes, and not another hash or name", () => {
    const text = "---\nname: ops-watch\ntemplate: ops-watch@abc123\n---\n\nBody.\n";
    expect(hasTemplateStamp(text, "ops-watch", "abc123")).toBe(true);
    expect(hasTemplateStamp(text, "ops-watch", "other")).toBe(false);
    expect(hasTemplateStamp(text, "other", "abc123")).toBe(false);
  });
});
