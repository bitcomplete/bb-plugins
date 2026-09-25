// What a Board row displays. Status labels must distinguish current approval
// from feedback and waiting; the full action wording survives in the hover.
import { describe, expect, it } from "vitest";
import { ageHint, primaryHint, rowAge, shortAge, shortVerb, titleHint } from "./rowlabels.js";

const NOW = Date.UTC(2030, 0, 10, 12);
const HOUR = 3_600_000;

describe("shortVerb", () => {
  it("shows review state before the next action, and shortens unrelated long verbs", () => {
    expect(shortVerb("Resolve conflicts")).toBe("Conflicts");
    expect(shortVerb("Approved, comments open")).toBe("Approved · open threads");
    expect(shortVerb("Review approval note")).toBe("Approved · review note");
    expect(shortVerb("Ready to merge")).toBe("Approved · ready");
    expect(shortVerb("In review")).toBe("Waiting for review");
    expect(shortVerb("Blocked by branch rules")).toBe("Rules block");
    expect(shortVerb("Checking mergeability")).toBe("Checking");
    for (const verb of ["CI failing", "Update branch", "Changes requested", "Behind #42", "Editing", "In progress"]) {
      expect(shortVerb(verb)).toBe(verb);
    }
  });

  it("keeps every display label distinct, because two states sharing a label would be ambiguous", () => {
    const full = [
      "CI failing", "Resolve conflicts", "Changes requested", "Approved, comments open", "Review approval note", "Ready to merge",
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
  it("dates a PR from GitHub's open time, regardless of a newer commit", () => {
    const age = rowAge({ createdAt: new Date(NOW - 3 * 24 * HOUR).toISOString() }, new Date(NOW - HOUR).toISOString());
    expect(shortAge(age, NOW)).toBe("3d");
    expect(ageHint(age, NOW)).toBe("PR opened 3d ago");
  });

  it("labels the last-commit fallback on a checkout without a PR", () => {
    const age = rowAge(null, new Date(NOW - 23 * HOUR).toISOString());
    expect(shortAge(age, NOW)).toBe("commit 23h");
    expect(ageHint(age, NOW)).toBe("Last commit 23h ago");
  });

  it("does not substitute a commit time for a PR in an older scan without createdAt", () => {
    const age = rowAge({}, new Date(NOW - HOUR).toISOString());
    expect(shortAge(age, NOW)).toBe("");
    expect(ageHint(age, NOW)).toBe("PR open date unavailable");
    expect(ageHint(rowAge(null, null), NOW)).toBe("No commit date");
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

  it("adds the Linear title, state and project as one line when known, and nothing when not", () => {
    const base = { title: "Show gift card balance", repo: "folio", pr: { number: 42, title: "Show gift card balance" }, branch: null };
    expect(titleHint({ ...base, linear: { title: "Gift cards in the cart", state: "In Progress", project: "Print run" } })).toBe(
      "Show gift card balance\nfolio #42\nLinear: Gift cards in the cart · In Progress · Print run",
    );
    expect(titleHint({ ...base, linear: null })).toBe(titleHint(base));
    expect(titleHint({ ...base, linear: { title: null, state: null, project: null } })).toBe(titleHint(base));
  });
});
