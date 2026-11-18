// BB-211: on an owner-lane round that approves without submitting an
// APPROVED review, the reviewer posts a Comment review, which never clears
// an earlier Request Changes from the same login. The shipped pr-reviewer
// skill is the change, so this guards its text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GITHUB_ISSUES, LINEAR_TICKETS } from "./templates.js";

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

// BB-264: a stack merges bottom-up, and the rule lives in the shipped skills
// rather than in each project's `.bb`.
const buildTicketsSkill = readFileSync(fileURLToPath(new URL("./skills/build-tickets/SKILL.md", import.meta.url)), "utf8");

describe("the shipped skills' stacked-PR rule (BB-264)", () => {
  it("build-tickets waits for the base, then retargets and rebases --onto before the normal gate", () => {
    expect(buildTicketsSkill).toContain("Wait for the base pull request to merge into the default branch");
    expect(buildTicketsSkill).toContain("gh pr edit <n> --base <default>");
    expect(buildTicketsSkill).toContain("git rebase --onto origin/<default> <old base head>");
    expect(buildTicketsSkill).toContain("approval carry across the rebase");
    // The retired `landedIn` instruction is gone.
    expect(buildTicketsSkill).not.toContain("landedIn");
  });

  it("stewards has the ticket steward report mergeBehind and the project steward's bottom-up note", () => {
    expect(stewardsSkill).toContain("A stacked pull request merges bottom-up");
    expect(stewardsSkill).toContain('steward_report { mergeBehind: ["owner/repo#<base>"] }');
    expect(stewardsSkill).toContain("rebase it onto the default branch");
    expect(stewardsSkill).toContain("--onto origin/<default> <old base head>");
    expect(stewardsSkill).toContain("A stack resolves bottom-up");
    expect(stewardsSkill).toContain("Never answer a schedule escalation by telling a stacked ticket");
  });
});

// BB-267: a by-hand step outside the repos that a feature needs (an app scope,
// a webhook, a registry entry, a tailnet rule) is a configure escalation, and
// the project steward fails item 5 on a spec that leaves it as a README line
// or a follow-up.
describe("the shipped stewards skill's by-hand configure step (BB-267)", () => {
  it("raises it as an escalation, not a README line, and fails item 5 when a spec leaves it undocumented", () => {
    expect(stewardsSkill).toContain("A by-hand step outside the repos the feature needs to work");
    expect(stewardsSkill).toMatch(/an app scope, a webhook, a registry entry, a tailnet rule/u);
    expect(stewardsSkill).toMatch(/a `configure`\s+escalation raised in the spec turn/u);
    expect(stewardsSkill).toMatch(/kind:\s+"decision"/u);
    expect(stewardsSkill).toMatch(/never a README\s+line or a closing-comment follow-up/u);
    expect(stewardsSkill).toMatch(/raise that step again/u);
    expect(stewardsSkill).toMatch(/the user's to grant/u);
    expect(stewardsSkill).toMatch(/never decides it itself/u);
    expect(stewardsSkill).toMatch(/Fail checklist item 5/u);
    expect(stewardsSkill).toMatch(/must be raised again\s+rather than settling/u);
  });
});

// BB-357: cleanup a change leaves behind (a field kept for ordering, a compat
// shim, a flag, a rename's old name, old-name docs/tests, a by-hand step) is
// scoped at spec time and filed as a ticket, never left as a comment line.
const cleanupItem = "Anything the change leaves temporary or deprecated has its removal in scope or in a filed ticket named here";

describe("the shipped templates' cleanup checklist item (BB-357)", () => {
  it("is the last ready-checklist item in both stamped playbooks", () => {
    for (const template of [LINEAR_TICKETS, GITHUB_ISSUES]) {
      expect(template).toContain(`${cleanupItem}\n  substantial:`);
      expect(template.indexOf(cleanupItem)).toBeGreaterThan(template.indexOf("- Out of scope is stated"));
    }
  });
});

describe("the shipped stewards skill's cleanup scoping (BB-357)", () => {
  it("scopes cleanup at spec time, files the follow-up with blockedBy, and files before Done", () => {
    expect(stewardsSkill).toContain("Cleanup a change leaves behind is scoped at spec time and filed");
    expect(stewardsSkill).toMatch(/a field kept\s+for ordering, a compatibility shim, a feature flag, a rename that leaves\s+the old name/u);
    expect(stewardsSkill).toMatch(/filed now, linked to\s+this one, and named in the spec by key/u);
    expect(stewardsSkill).toMatch(/without a key fails the ready checklist/u);
    expect(stewardsSkill).toMatch(/filed straight to Todo \(not\s+Backlog/u);
    expect(stewardsSkill).toMatch(/`blockedBy`\s+relation on the work it waits for/u);
    expect(stewardsSkill).toMatch(/Done comment never names unfiled\s+work/u);
    expect(stewardsSkill).toMatch(/Workers\s+report follow-ups to their steward/u);
    expect(stewardsSkill).toMatch(/the project's guidance overrides it\)\. "Cleanup"/u);
  });
});

describe("the shipped pr-reviewer skill's unreferenced-deprecation blocker (BB-357)", () => {
  it("blocks a diff that introduces a deprecation, compat path, kept-but-ignored field or TODO with no ticket reference", () => {
    expect(skill).toMatch(/introduces a deprecation, a compatibility path, a kept-but-ignored field\s+or a TODO with no ticket reference/u);
    expect(skill).toMatch(/is a blocker, not a suggestion\./u);
    // The suggestion filter's "follow-up" wording is unchanged.
    expect(skill).toContain('"follow-up", "harmless"');
  });
});

describe("the shipped build-tickets skill's cleanup report (BB-357)", () => {
  it("asks the worker's final message to list left-behind cleanup and whether its ticket exists", () => {
    expect(buildTicketsSkill).toMatch(/List any cleanup the pull request leaves behind/u);
    expect(buildTicketsSkill).toMatch(/in this ticket's\nscope or a filed follow-up ticket, naming its key/u);
  });
});
