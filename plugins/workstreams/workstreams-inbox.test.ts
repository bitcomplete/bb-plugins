// The Board's inbox rules. Fixtures are the invented Inkwell bookstore: repos
// quill, folio, margin, colophon and spine; PR numbers 42–99.
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  INBOX_COLLAPSED,
  INBOX_SECTIONS,
  LIFECYCLES,
  RECENTLY_SHIPPED_DAYS,
  ageLabel,
  byInboxOrder,
  inboxSection,
  inboxVerb,
  matchesInboxQuery,
  relativeTime,
  stateAge,
  threadPrompt,
  trackTransitions,
  type InboxSection,
  type InboxUnitFacts,
  type Lifecycle,
  type Transition,
} from "./workstreams.js";
import type { MergeStateStatus } from "./contract.js";

const NOW = Date.parse("2030-01-10T12:00:00Z");

function facts(overrides: Partial<InboxUnitFacts> = {}): InboxUnitFacts {
  return {
    ticket: "ABC-101",
    lifecycle: "awaiting-review",
    stack: null,
    // CLEAN by default so tests that don't care about mergeStateStatus keep
    // reading an `awaiting-merge` row as ready, the pre-mergeStateStatus behavior.
    pr: { mergedAt: null, mergeStateStatus: "CLEAN" },
    ...overrides,
  };
}

describe("inboxSection", () => {
  const cases: [Lifecycle, InboxSection, string][] = [
    ["blocked", "fix", "red CI is the one thing only a fix clears"],
    ["awaiting-followup", "respond", "the reviewer acted and the ball is with the author"],
    ["approved-with-comments", "respond", "approval hides comments the author still has to read"],
    ["awaiting-merge", "merge", "one button stands between it and done"],
    ["awaiting-review", "waiting", "someone else holds it"],
    ["active", "in-flight", "it is being edited, not waiting on anyone"],
    ["in-progress", "in-flight", "commits or a draft, still the author's own"],
    ["up-next", "parked", "a branch with nothing on it is not work yet"],
    ["closed", "parked", "abandoned work needs nothing"],
  ];
  for (const [lifecycle, section, why] of cases) {
    it(`files ${lifecycle} under ${section}, because ${why}`, () => {
      expect(inboxSection(facts({ lifecycle }), NOW)).toBe(section);
    });
  }

  it("covers every lifecycle, so no checkout can fall off the Board", () => {
    for (const lifecycle of LIFECYCLES) {
      expect(INBOX_SECTIONS).toContain(inboxSection(facts({ lifecycle }), NOW));
    }
  });

  it("files a green, approved PR stacked on an unmerged one under Waiting as 'Behind #46', never under Merge, because merge order is the real constraint", () => {
    const stacked = facts({ lifecycle: "awaiting-merge", stack: { blockedBelow: 46 } });
    expect(inboxSection(stacked, NOW)).toBe("waiting");
    expect(inboxVerb(stacked, "waiting")).toBe("Behind #46");
  });

  it("files ANY stack-blocked live row under Waiting, CI failures included, so nothing asks to be worked before the PR below it merges", () => {
    expect(inboxSection(facts({ lifecycle: "blocked", stack: { blockedBelow: 51 } }), NOW)).toBe("waiting");
    expect(inboxSection(facts({ lifecycle: "in-progress", stack: { blockedBelow: 51 } }), NOW)).toBe("waiting");
  });

  it("keeps the bottom of a stack in its own section, because nothing is below it", () => {
    expect(inboxSection(facts({ lifecycle: "awaiting-merge", stack: { blockedBelow: null } }), NOW)).toBe("merge");
  });

  it("parks a ticketless clone with no PR whatever its state, because a default-branch clone is not work", () => {
    expect(inboxSection(facts({ ticket: null, pr: null, lifecycle: "active" }), NOW)).toBe("parked");
  });

  it("keeps a ticketless branch that HAS a pull request in its real section, because a PR is work whatever its branch name", () => {
    expect(inboxSection(facts({ ticket: null, lifecycle: "blocked" }), NOW)).toBe("fix");
  });

  it("collapses exactly the three context sections by default", () => {
    expect(INBOX_SECTIONS.filter((section) => INBOX_COLLAPSED[section])).toEqual(["in-flight", "shipped", "parked"]);
  });
});

describe("mergeStateStatus on an awaiting-merge PR", () => {
  const awaitingMerge = (mergeStateStatus: MergeStateStatus) =>
    facts({ lifecycle: "awaiting-merge", pr: { mergedAt: null, mergeStateStatus } });

  const cases: [MergeStateStatus, InboxSection, string, string][] = [
    ["CLEAN", "merge", "Ready to merge", "nothing GitHub knows about blocks the merge button"],
    ["HAS_HOOKS", "merge", "Ready to merge", "a required hook still counts as clear to merge"],
    ["UNSTABLE", "merge", "Ready to merge", "an optional, non-required check counts as clear to merge"],
    ["BEHIND", "merge", "Update branch", "still Merge, but the reader needs to update the branch first"],
    ["BLOCKED", "waiting", "Blocked by branch rules", "branch protection, not the reader, is what's unsatisfied"],
    ["UNKNOWN", "waiting", "Checking mergeability", "an unread signal must never be read as ready"],
  ];
  for (const [status, section, verb, why] of cases) {
    it(`reads ${status} as ${section} ("${verb}"), because ${why}`, () => {
      const unit = awaitingMerge(status);
      expect(inboxSection(unit, NOW)).toBe(section);
      expect(inboxVerb(unit, section)).toBe(verb);
    });
  }

  it("never files UNKNOWN as ready, even though every other unset field on the row defaults leniently", () => {
    const unit = facts({ lifecycle: "awaiting-merge", pr: { mergedAt: null } });
    expect(inboxSection(unit, NOW)).toBe("waiting");
    expect(inboxSection(unit, NOW)).not.toBe("merge");
  });
});

describe("DIRTY (merge conflicts) in the inbox precedence", () => {
  it("outranks approved-with-comments, because nothing can happen until the conflict is resolved regardless of open comments", () => {
    const unit = facts({ lifecycle: "approved-with-comments", pr: { mergedAt: null, mergeStateStatus: "DIRTY" } });
    expect(inboxSection(unit, NOW)).toBe("fix");
    expect(inboxVerb(unit, "fix")).toBe("Resolve conflicts");
  });

  it("outranks changes-requested, because the review state does not change what has to happen first", () => {
    const unit = facts({ lifecycle: "awaiting-followup", pr: { mergedAt: null, mergeStateStatus: "DIRTY" } });
    expect(inboxSection(unit, NOW)).toBe("fix");
    expect(inboxVerb(unit, "fix")).toBe("Resolve conflicts");
  });

  it("outranks plain in-review, for the same reason", () => {
    const unit = facts({ lifecycle: "awaiting-review", pr: { mergedAt: null, mergeStateStatus: "DIRTY" } });
    expect(inboxSection(unit, NOW)).toBe("fix");
    expect(inboxVerb(unit, "fix")).toBe("Resolve conflicts");
  });

  it("outranks awaiting-merge itself, so an approved, green PR with a conflict still lands under Fix, not Merge", () => {
    const unit = facts({ lifecycle: "awaiting-merge", pr: { mergedAt: null, mergeStateStatus: "DIRTY" } });
    expect(inboxSection(unit, NOW)).toBe("fix");
    expect(inboxVerb(unit, "fix")).toBe("Resolve conflicts");
  });

  it("is outranked by CI failing, because the fix and the reason are the same section either way", () => {
    const unit = facts({ lifecycle: "blocked", pr: { mergedAt: null, mergeStateStatus: "DIRTY" } });
    expect(inboxSection(unit, NOW)).toBe("fix");
    expect(inboxVerb(unit, "fix")).toBe("CI failing");
  });

  it("is outranked by stack position, because merge order is checked before mergeStateStatus is even read", () => {
    const unit = facts({
      lifecycle: "awaiting-merge",
      stack: { blockedBelow: 46 },
      pr: { mergedAt: null, mergeStateStatus: "DIRTY" },
    });
    expect(inboxSection(unit, NOW)).toBe("waiting");
    expect(inboxVerb(unit, "waiting")).toBe("Behind #46");
  });
});

describe("the recently-shipped window", () => {
  const mergedAgo = (ms: number) => facts({ lifecycle: "merged", pr: { mergedAt: new Date(NOW - ms).toISOString() } });

  it("includes work merged exactly seven days ago, inclusive", () => {
    expect(inboxSection(mergedAgo(RECENTLY_SHIPPED_DAYS * DAY_MS), NOW)).toBe("shipped");
  });

  it("parks work merged a second past the window, because older done work is context, not news", () => {
    expect(inboxSection(mergedAgo(RECENTLY_SHIPPED_DAYS * DAY_MS + 1_000), NOW)).toBe("parked");
  });

  it("applies the same window to shipped", () => {
    const shipped = facts({ lifecycle: "shipped", pr: { mergedAt: new Date(NOW - DAY_MS).toISOString() } });
    expect(inboxSection(shipped, NOW)).toBe("shipped");
    expect(inboxVerb(shipped, "shipped")).toBe("Shipped");
  });

  it("parks merged work with no or unreadable merge time rather than inventing recency", () => {
    expect(inboxSection(facts({ lifecycle: "merged", pr: { mergedAt: null } }), NOW)).toBe("parked");
    expect(inboxSection(facts({ lifecycle: "merged", pr: {} }), NOW)).toBe("parked");
    expect(inboxSection(facts({ lifecycle: "merged", pr: { mergedAt: "soon" } }), NOW)).toBe("parked");
  });

  it("ignores stack position once a PR has merged, because it has left the merge order", () => {
    const merged = facts({
      lifecycle: "merged",
      stack: { blockedBelow: 44 },
      pr: { mergedAt: new Date(NOW - DAY_MS).toISOString() },
    });
    expect(inboxSection(merged, NOW)).toBe("shipped");
  });
});

describe("inboxVerb", () => {
  it("names the action in the row's own words", () => {
    expect(inboxVerb(facts({ lifecycle: "blocked" }), "fix")).toBe("CI failing");
    expect(inboxVerb(facts({ lifecycle: "awaiting-followup" }), "respond")).toBe("Changes requested");
    expect(inboxVerb(facts({ lifecycle: "approved-with-comments" }), "respond")).toBe("Approved, comments open");
    expect(inboxVerb(facts({ lifecycle: "awaiting-merge" }), "merge")).toBe("Ready to merge");
    expect(inboxVerb(facts({ lifecycle: "awaiting-review" }), "waiting")).toBe("In review");
    expect(inboxVerb(facts({ lifecycle: "active" }), "in-flight")).toBe("Editing");
    expect(inboxVerb(facts({ lifecycle: "in-progress" }), "in-flight")).toBe("In progress");
  });

  it("gives parked rows no verb, because there is nothing to do with them", () => {
    expect(inboxVerb(facts({ lifecycle: "up-next" }), "parked")).toBeNull();
    expect(inboxVerb(facts({ lifecycle: "merged" }), "parked")).toBeNull();
  });
});

describe("trackTransitions", () => {
  const T0 = NOW - 3 * DAY_MS;
  const table = (entries: [string, Transition][]) => new Map(entries);

  it("records an unknown entry time the first time a unit is seen, because the first scan cannot know how long it has been there", () => {
    const next = trackTransitions(new Map(), [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: null });
  });

  it("records the time when a unit is seen ENTERING a state", () => {
    const previous = table([["/p/quill", { lifecycle: "awaiting-review", enteredAt: null }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: NOW });
  });

  it("keeps the entry time while a unit stays put, so 'CI failing 3d' keeps counting across scans", () => {
    const previous = table([["/p/quill", { lifecycle: "blocked", enteredAt: T0 }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: T0 });
  });

  it("resets the entry time when the state changes again", () => {
    const previous = table([["/p/quill", { lifecycle: "blocked", enteredAt: T0 }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "awaiting-review" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "awaiting-review", enteredAt: NOW });
  });

  it("drops a unit that left the scan", () => {
    const previous = table([["/p/gone", { lifecycle: "blocked", enteredAt: T0 }]]);
    expect(trackTransitions(previous, [], NOW).size).toBe(0);
  });
});

describe("stateAge and its label", () => {
  const base = { lifecycle: "blocked" as Lifecycle, lastCommitAt: new Date(NOW - 12 * DAY_MS).toISOString(), enteredAt: null, pr: null };

  it("uses the observed transition when there is one", () => {
    const age = stateAge({ ...base, enteredAt: new Date(NOW - 3 * DAY_MS).toISOString() });
    expect(age.basis).toBe("state");
    expect(ageLabel(age, NOW)).toBe("3d");
  });

  it("falls back to the last commit and SAYS so, because a proxy must never pass for the state age", () => {
    const age = stateAge(base);
    expect(age.basis).toBe("last-commit");
    expect(ageLabel(age, NOW)).toBe("last commit 12d");
  });

  it("treats GitHub's merge time as the state age of merged work", () => {
    const age = stateAge({ ...base, lifecycle: "merged", pr: { mergedAt: new Date(NOW - 2 * DAY_MS).toISOString() } });
    expect(age).toEqual({ since: NOW - 2 * DAY_MS, basis: "state" });
  });

  it("does not use the merge time for shipped, because shipping happened later than the merge", () => {
    const age = stateAge({ ...base, lifecycle: "shipped", pr: { mergedAt: new Date(NOW - 2 * DAY_MS).toISOString() } });
    expect(age.basis).toBe("last-commit");
  });

  it("says there is no commit date rather than printing a number it does not have", () => {
    expect(ageLabel(stateAge({ ...base, lastCommitAt: null }), NOW)).toBe("no commit date");
  });

  it("prints hours and minutes for young states", () => {
    expect(ageLabel({ since: NOW - 5 * 3_600_000, basis: "state" }, NOW)).toBe("5h");
    expect(ageLabel({ since: NOW - 45 * 60_000, basis: "state" }, NOW)).toBe("45m");
  });
});

describe("byInboxOrder", () => {
  const row = (repo: string, prNumber: number | null, since: number | null, path = `/p/${repo}-${prNumber}`) => ({
    repo,
    prNumber,
    since,
    path,
  });

  it("puts the oldest in state first, because the most stuck row is the one to see first", () => {
    const rows = [row("quill", 42, NOW - DAY_MS), row("folio", 43, NOW - 9 * DAY_MS), row("margin", 44, NOW - 3 * DAY_MS)];
    expect(rows.sort(byInboxOrder).map((r) => r.prNumber)).toEqual([43, 44, 42]);
  });

  it("breaks ties by repo, then PR number, then path, so the order is total and stable", () => {
    const at = NOW - DAY_MS;
    const rows = [row("spine", 50, at), row("colophon", 61, at), row("colophon", 58, at), row("colophon", null, at, "/p/b"), row("colophon", null, at, "/p/a")];
    expect(rows.sort(byInboxOrder).map((r) => `${r.repo}#${r.prNumber}${r.path}`)).toEqual([
      "colophon#58/p/colophon-58",
      "colophon#61/p/colophon-61",
      "colophon#null/p/a",
      "colophon#null/p/b",
      "spine#50/p/spine-50",
    ]);
  });

  it("treats a row with no evidence of age as the oldest", () => {
    const rows = [row("quill", 42, NOW - 30 * DAY_MS), row("folio", 43, null)];
    expect(rows.sort(byInboxOrder)[0]?.repo).toBe("folio");
  });

  it("produces the same order from any input order", () => {
    const rows = [row("quill", 42, NOW - DAY_MS), row("folio", 43, NOW - DAY_MS), row("margin", 44, NOW - 2 * DAY_MS)];
    const once = [...rows].sort(byInboxOrder);
    const reversed = [...rows].reverse().sort(byInboxOrder);
    expect(reversed).toEqual(once);
  });
});

describe("matchesInboxQuery", () => {
  const row = { ticket: "ABC-101", title: "Show gift card balance", repo: "folio", effort: "Gift cards" };
  it("matches ticket, title, repo and effort, case-insensitively", () => {
    for (const query of ["abc-101", "GIFT CARD", "folio", "gift cards", "  "]) {
      expect(matchesInboxQuery(row, query)).toBe(true);
    }
    expect(matchesInboxQuery(row, "colophon")).toBe(false);
  });
});

describe("threadPrompt", () => {
  const facts = { repo: "folio", prNumber: 47, title: "Show gift card balance", branch: "dev/abc-101-gift-cards", path: "/p/folio-abc-101" };

  it("asks for a CI fix under Fix, with every field", () => {
    expect(threadPrompt("fix", facts)).toBe(
      "CI is failing on folio #47 (Show gift card balance), branch dev/abc-101-gift-cards, checkout /p/folio-abc-101. Investigate the failure and propose a fix.",
    );
  });

  it("asks to address review under Respond", () => {
    expect(threadPrompt("respond", facts)).toBe(
      "Review feedback is waiting on folio #47 (Show gift card balance), branch dev/abc-101-gift-cards, checkout /p/folio-abc-101. Read the review comments and address them.",
    );
  });

  it("asks to pick the work up everywhere else", () => {
    for (const section of ["merge", "waiting", "in-flight", "shipped", "parked"] as const) {
      expect(threadPrompt(section, facts)).toBe(
        "Pick up folio #47 (Show gift card balance), branch dev/abc-101-gift-cards, checkout /p/folio-abc-101.",
      );
    }
  });

  it("says plainly when there is no PR or no branch, rather than leaving a hole in the sentence", () => {
    expect(threadPrompt("waiting", { ...facts, prNumber: null, title: null, branch: null })).toBe(
      "Pick up folio (no pull request), no branch checked out, checkout /p/folio-abc-101.",
    );
  });
});

describe("relativeTime", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  it("reads under a minute, and a future time from clock skew, as just now", () => {
    expect(relativeTime(at(0), NOW)).toBe("just now");
    expect(relativeTime(at(59_999), NOW)).toBe("just now");
    expect(relativeTime(at(-5_000), NOW)).toBe("just now");
  });

  it("switches units at the minute, hour and day boundaries", () => {
    expect(relativeTime(at(60_000), NOW)).toBe("1m ago");
    expect(relativeTime(at(59 * 60_000), NOW)).toBe("59m ago");
    expect(relativeTime(at(60 * 60_000), NOW)).toBe("1h ago");
    expect(relativeTime(at(DAY_MS - 1), NOW)).toBe("23h ago");
    expect(relativeTime(at(DAY_MS), NOW)).toBe("1d ago");
  });

  it("says never or unknown rather than inventing a time", () => {
    expect(relativeTime(null, NOW)).toBe("never");
    expect(relativeTime("yesterday-ish", NOW)).toBe("unknown");
  });
});
