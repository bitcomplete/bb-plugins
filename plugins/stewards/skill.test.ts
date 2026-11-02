// BB-211: on an owner-lane round that approves without submitting an
// APPROVED review, the reviewer posts a Comment review, which never clears
// an earlier Request Changes from the same login. The shipped pr-reviewer
// skill is the change, so this guards its text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skill = readFileSync(fileURLToPath(new URL("./skills/pr-reviewer/SKILL.md", import.meta.url)), "utf8");

describe("the shipped pr-reviewer skill (BB-211)", () => {
  it("dismisses its own stale Request Changes when an owner-lane round approves", () => {
    expect(skill).toContain("reviews/<id>/dismissals");
    expect(skill).toContain('-f message="Dismissed: round N at <sha> found no blockers" -f event=DISMISS');
    // Only the reviewer's own posts, identified by the marker or signature.
    expect(skill).toContain("carries a `bb-review` marker or the `_— from bb thread …_` signature");
    expect(skill).toContain("never a person's");
    // The dismissal happens before the round is posted, and names the review.
    expect(skill).toContain("**Before you\n  post the round's review**");
    expect(skill).toMatch(/Name the dismissed review[^.]*its round and id[^.]*in the round's review\s+body/u);
    // changes-requested rounds are untouched, and a missing review is skipped.
    expect(skill).toMatch(/`changes-requested`\s+rounds are unchanged/u);
    expect(skill).toMatch(/Skip quietly when no review you posted is still in\s+state `CHANGES_REQUESTED`/u);
  });
});
