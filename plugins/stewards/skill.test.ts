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
    expect(skill).toContain("reviews/{id}/dismissals");
    expect(skill).toContain('-f message="Dismissed: round N at <sha> found no blockers" -f event=DISMISS');
    // Only the reviewer's own posts, identified by the marker or signature.
    expect(skill).toContain("carries a `bb-review` marker or the `_— from bb thread …_` signature");
    expect(skill).toContain("never a person's");
    // changes-requested rounds are untouched, and a missing review is skipped.
    expect(skill).toContain("`changes-requested` rounds are unchanged");
    expect(skill).toMatch(/Skip quietly when no review you\s+posted is still in state `CHANGES_REQUESTED`/u);
    // The round's comment records the dismissal.
    expect(skill).toMatch(/says which earlier review was dismissed, by round and id/u);
  });
});
