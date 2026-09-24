// What a Board row displays. The short forms exist to free width for the
// title, so each must stay unambiguous, and the full wording must survive in
// the hover rather than disappear.
import { describe, expect, it } from "vitest";
import { ageHint, primaryHint, shortAge, shortVerb, titleHint } from "./rowlabels.js";

const NOW = Date.UTC(2030, 0, 10, 12);
const HOUR = 3_600_000;

describe("shortVerb", () => {
  it("shortens the long verbs so the verb column can shrink, and passes short ones through", () => {
    expect(shortVerb("Resolve conflicts")).toBe("Conflicts");
    expect(shortVerb("Changes requested")).toBe("Changes req.");
    expect(shortVerb("Approved, comments open")).toBe("Comments");
    expect(shortVerb("Ready to merge")).toBe("Ready");
    expect(shortVerb("Blocked by branch rules")).toBe("Rules block");
    expect(shortVerb("Checking mergeability")).toBe("Checking");
    for (const verb of ["CI failing", "Update branch", "In review", "Behind #42", "Editing", "In progress"]) {
      expect(shortVerb(verb)).toBe(verb);
    }
  });

  it("keeps every short label distinct, because two sections showing the same word would be ambiguous", () => {
    const full = [
      "CI failing", "Resolve conflicts", "Changes requested", "Approved, comments open", "Ready to merge",
      "Update branch", "In review", "Blocked by branch rules", "Checking mergeability", "Editing", "In progress",
    ];
    expect(new Set(full.map(shortVerb)).size).toBe(full.length);
  });
});

describe("primaryHint", () => {
  it("names the full verb, what a click does, and the key, because the chip itself only shows the short verb", () => {
    expect(primaryHint("Resolve conflicts", { kind: "agent", action: "resolve-conflicts", label: "Resolve conflicts" })).toBe(
      "Resolve conflicts: start an agent to resolve conflicts (a)",
    );
    expect(primaryHint("Ready to merge", { kind: "direct", action: "merge", label: "Merge" })).toBe("Ready to merge: merge (a)");
    expect(primaryHint("Behind #42", { kind: "jump", behind: 42, label: "Go to #42" })).toBe("Behind #42: go to #42 (a)");
  });
});

describe("age", () => {
  it("shows the bare unit on the row and the meaning in the hover", () => {
    const age = { since: NOW - 3 * 24 * HOUR, basis: "state" as const };
    expect(shortAge(age, NOW)).toBe("3d");
    expect(ageHint(age, "CI failing", NOW)).toBe("CI failing for 3d");
  });

  it("says when the age is only the last commit, so a quiet branch is not read as time in its state", () => {
    const age = { since: NOW - 23 * HOUR, basis: "last-commit" as const };
    expect(shortAge(age, NOW)).toBe("23h");
    expect(ageHint(age, "In review", NOW)).toBe("No state change seen yet: last commit 23h ago");
  });

  it("shows nothing for an unknown age rather than inventing one", () => {
    expect(shortAge({ since: null, basis: "last-commit" }, NOW)).toBe("");
    expect(ageHint({ since: null, basis: "last-commit" }, null, NOW)).toBe("No commit date");
  });
});

describe("titleHint", () => {
  it("shows the PR's full original title, not the cleaned one, with repo, number and branch", () => {
    expect(
      titleHint({
        title: "Show gift card balance",
        repo: "folio",
        pr: { number: 42, title: "ABC-101: Show gift card balance" },
        branch: "dev/abc-101",
      }),
    ).toBe("ABC-101: Show gift card balance\nfolio #42 · dev/abc-101");
  });

  it("falls back to the row's title for a branch with no PR", () => {
    expect(titleHint({ title: "dev/web-7", repo: "quill", pr: null, branch: "dev/web-7" })).toBe("dev/web-7\nquill · dev/web-7");
  });
});
