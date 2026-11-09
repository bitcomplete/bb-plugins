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

describe("the shipped pr-reviewer skill's product ack (BB-207)", () => {
  it("judges substantial from the diff before the rebase and the lane, and opens a Product section before Blockers", () => {
    // The marker carries the diff judgment and the referenced ticket's spec.
    expect(skill).toContain("substantial=yes|no");
    expect(skill).toContain("spec=yes|no");
    // Compute substantial first, from the diff, never the body.
    expect(skill).toMatch(/Judge substantial, and the referenced ticket's spec\.[\s\S]*?before\s+the rebase push, the tests or the lane classification, and from the diff/u);
    expect(skill).toContain("never from the pull request body");
    // The Product section comes before Blockers, and names what was searched.
    expect(skill).toMatch(/### Product[\s\S]*?### Blockers/u);
    expect(skill).toContain("docs/product.md");
    expect(skill).toMatch(/naming what you searched/u);
    expect(skill).toMatch(/Omit this whole section when the change is not substantial/u);
    // A playbook with no list has not opted in, so nothing is substantial.
    expect(skill).toMatch(/playbook\s+with no `substantial` list has not opted in/u);
    expect(skill).toMatch(/mark `substantial=no spec=no`/u);
    // A body assertion never stands in for the owner's ack.
    expect(skill).toMatch(/self-asserted ack in the[\s\S]*?never counts/u);
    // A standing owner approval carries across a rebase, product included.
    expect(skill).toMatch(/product ack is of the pull request too/u);
  });
});

// BB-250: a GitHub ticket steward files a child as a native sub-issue, so the
// create command assigns it to this server's login (a GitHub issue is adopted
// only when the login is an assignee) and the attach uses the REST endpoint.
const stewardsSkill = readFileSync(fileURLToPath(new URL("./skills/stewards/SKILL.md", import.meta.url)), "utf8");

describe("the shipped stewards skill's GitHub child filing (BB-250)", () => {
  it("carries the create-and-attach commands and assigns the child to this server's login", () => {
    expect(stewardsSkill).toContain("### Filing a child on GitHub");
    expect(stewardsSkill).toContain("repos/{owner}/{repo}/issues/{parent}/sub_issues");
    expect(stewardsSkill).toContain("--assignee @me");
    expect(stewardsSkill).toContain('echo "filed child #$n"');
    expect(stewardsSkill).toContain("-F sub_issue_id=");
  });
});
