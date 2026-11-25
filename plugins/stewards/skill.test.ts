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
// source assigns it to this server's login (a GitHub issue is adopted only
// when the login is an assignee). BB-360 moved the step to `ticket_file`.
const stewardsSkill = readFileSync(fileURLToPath(new URL("./skills/stewards/SKILL.md", import.meta.url)), "utf8");
const onboardingSkill = readFileSync(fileURLToPath(new URL("./skills/onboarding/SKILL.md", import.meta.url)), "utf8");

// BB-405: the shipped skill text states project-specific restart details
// generically, so it reads for any project.
describe("the shipped stewards skill names no project-specific restart detail (BB-405)", () => {
  it("keeps bb-gate, the router probe and the pod's commit file out of the shipped text", () => {
    expect(stewardsSkill).not.toMatch(/bb-gate|_bb-gate|\/opt\/bb-plugins-commit|quiet window/u);
  });
});

describe("the shipped stewards skill's child filing (BB-250, BB-360)", () => {
  it("files a child through the source-neutral ticket_file, naming the parent", () => {
    expect(stewardsSkill).toContain("### Filing a child");
    expect(stewardsSkill).toContain('ticket_file { unit, title, description, parent, assignee: "me" }');
    expect(stewardsSkill).toMatch(/native sub-issue/u);
    expect(stewardsSkill).toMatch(/assigns the\s+child to this server's login/u);
  });
});

// BB-360: the shipped skills take every ticket step through the source-neutral
// tools. `linear_*` stays only for a Linear @bb session reply, which has no
// neutral equivalent, and `gh` stays for pull requests.
describe("the shipped skills' source-neutral ticket steps (BB-360)", () => {
  it("names no linear_* tool or gh issue for a ticket step", () => {
    for (const text of [stewardsSkill, buildTicketsSkill, skill, onboardingSkill]) {
      expect(text).not.toMatch(/gh issue/u);
      const linear = [...new Set(text.match(/linear_[a-z_]+/gu) ?? [])].filter((t) => t !== "linear_session_reply");
      expect(linear).toEqual([]);
    }
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

// BB-267 / BB-368: a by-hand step outside the repos that a feature needs (an
// app scope, a webhook, a registry entry, a firewall rule) is named in the
// spec turn with the trigger that makes it doable and escalated when that
// trigger has happened; the project steward meets item 5 on a named step and
// fails it on a README line or a follow-up with no trigger.
describe("the shipped stewards skill's by-hand configure step (BB-267, BB-368)", () => {
  it("names the step with its trigger in the spec, escalates at the trigger, and meets item 5 on the name", () => {
    expect(stewardsSkill).toContain("A by-hand step outside the repos the feature needs to work");
    expect(stewardsSkill).toMatch(/an\s+app scope, a webhook, a registry entry, a firewall rule/u);
    expect(stewardsSkill).toMatch(/Name it in the spec turn with the\s+trigger that makes it doable/u);
    expect(stewardsSkill).toMatch(/a pull request opening, a merge, a deploy/u);
    expect(stewardsSkill).toMatch(/raise the escalation when that trigger has happened/u);
    expect(stewardsSkill).toMatch(/kind:\s+"decision"/u);
    expect(stewardsSkill).toMatch(/never a README\s+line or a closing-comment follow-up/u);
    expect(stewardsSkill).toMatch(/raise that step again/u);
    expect(stewardsSkill).toMatch(/the user's to grant/u);
    expect(stewardsSkill).toMatch(/never\s+decides it itself/u);
    expect(stewardsSkill).toMatch(/Checklist item 5 is met\s+when the spec names a by-hand step/u);
    expect(stewardsSkill).toMatch(/do not decline a\s+spec for deferring it to its trigger/u);
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

// BB-362: a local-only project has no label, so the onboarding skill asks
// about `bb-managed` only when a label-based source is in use.
describe("the onboarding skill's label question (BB-362)", () => {
  it("asks about the label only when the project lists a Linear team or a GitHub issue repo", () => {
    expect(onboardingSkill).toMatch(/ask only when the\s+project lists a Linear team or a GitHub repo it files issues in/u);
    expect(onboardingSkill).toMatch(/a\s+local-only project adopts by state and needs no label/u);
  });
});

// BB-364: the onboarding skill must work on a stock bb with no Linear plugin
// and no repos.json: the survey reports Linear `available: false` without
// derailing the interview, the interview asks for the time zone and the local
// prefix, and it never asks about Linear teams or labels when there is no
// Linear.
describe("the onboarding skill's stock-install path (BB-364)", () => {
  it("handles a no-Linear survey, asks for the zone and prefix, and never assumes repos.json", () => {
    expect(onboardingSkill).toMatch(/the Linear section reads `available: false`/u);
    expect(onboardingSkill).toMatch(/do not ask about Linear teams or\s+labels at all/u);
    expect(onboardingSkill).toMatch(/the local ticket key prefix/u);
    expect(onboardingSkill).toMatch(/no\s+`repos\.json`/u);
    // init is told not to ask Linear on a stock install.
    expect(onboardingSkill).toMatch(/run `init` with no `--teams`/u);
    expect(onboardingSkill).toMatch(/--timezone[\s\S]*?--prefix/u);
  });

  it("splits the guidance landing and decide-list paths for a native single-repo project", () => {
    expect(onboardingSkill).toMatch(/on a native single-repo project commit the\s+branch and open the guidance pull request on the repo yourself/u);
    expect(onboardingSkill).toMatch(/the paths are relative to the repo root/u);
    // The bare multi-repo-only instruction is gone.
    expect(onboardingSkill).not.toMatch(/publish with `workspace_publish_guidance`, and open a\s+pull request/u);
  });
});
