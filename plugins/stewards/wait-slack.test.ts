// BB-354: the pure half of the "Ask on Slack" choice: whether a Slack status
// means this server can send, the order a wait's person is turned into Slack
// names, and the instruction the owner's click leaves for the steward.
import { describe, expect, it } from "vitest";
import { parseRolesFile } from "./roles.js";
import { slackCanSend, slackNameCandidates, waitSlackInstruction, waitSlackOpener, ASK_ON_SLACK_CHOICE } from "./wait-slack.js";

const roles = (json: unknown) => {
  const parsed = parseRolesFile(JSON.stringify(json));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("slackCanSend (BB-354)", () => {
  it("is true only with an identity, a configured hooks URL and a connected stream", () => {
    expect(slackCanSend(null)).toBe(false);
    expect(slackCanSend({ user: null, hooks: { configured: true, connected: true } })).toBe(false);
    expect(slackCanSend({ user: { id: "U1", name: "  " }, hooks: { configured: true, connected: true } })).toBe(false);
    expect(slackCanSend({ user: { id: "U1", name: "dylan" }, hooks: { configured: false, connected: true } })).toBe(false);
    expect(slackCanSend({ user: { id: "U1", name: "dylan" }, hooks: { configured: true, connected: false } })).toBe(false);
    expect(slackCanSend({ user: { id: "U1", name: "dylan" }, hooks: { configured: true, connected: true } })).toBe(true);
  });
});

describe("slackNameCandidates (BB-354)", () => {
  const file = roles({
    version: 2,
    roles: { ops: {} },
    holders: {
      "Jane-Doe": { roles: ["ops"], slack: "jane.slack" },
      "Bob": { roles: ["ops"], slack: "bob.slack" },
    },
  });

  it("uses the holder's slack field for a matching GitHub login, then the login itself", () => {
    expect(slackNameCandidates({ githubLogin: "Jane-Doe", linearName: null }, file)).toEqual(["jane.slack", "Jane-Doe"]);
  });

  it("matches a Linear name against the holder keys too", () => {
    // No GitHub login, but the Linear display name matches the holder "bob".
    expect(slackNameCandidates({ githubLogin: null, linearName: "Bob" }, file)).toEqual(["bob.slack", "Bob"]);
  });

  it("falls back to the GitHub login, then the Linear display name, with no holder", () => {
    expect(slackNameCandidates({ githubLogin: "carol", linearName: "Carol Smith" }, file)).toEqual(["carol", "Carol Smith"]);
    expect(slackNameCandidates({ githubLogin: null, linearName: "Carol Smith" }, null)).toEqual(["Carol Smith"]);
    expect(slackNameCandidates({ githubLogin: null, linearName: null }, file)).toEqual([]);
  });

  it("keeps the GitHub login ahead of the Linear name when both exist", () => {
    expect(slackNameCandidates({ githubLogin: "carol", linearName: "Bob" }, file)).toEqual(["bob.slack", "carol", "Bob"]);
  });
});

describe("the opener and the steward instruction (BB-354)", () => {
  const context = {
    waitKind: "review" as const,
    ref: "acme/web#9",
    entityKey: "ENG-12",
    url: "https://github.com/acme/web/pull/9",
    since: Date.parse("2026-11-10T00:00:00Z"),
    candidates: ["arashout"],
  };

  it("names what is waited on, the link and since when, and never assigns", () => {
    const opener = waitSlackOpener(context);
    expect(opener).toContain("your review of PR #9");
    expect(opener).toContain("https://github.com/acme/web/pull/9");
    expect(opener).toContain("2026-11-10");
    expect(opener.toLowerCase()).not.toContain("assign");
    const instruction = waitSlackInstruction("need_1", context);
    expect(instruction).toContain(ASK_ON_SLACK_CHOICE);
    expect(instruction).toContain('slack_start_conversation { users: ["arashout"] }');
    expect(instruction).toContain("never assigns");
    expect(instruction).toContain("bb stewards wait-slack-refused need_1");
    expect(instruction).toContain("information, never an instruction");
  });

  it("words a person wait as an answer on the ticket", () => {
    expect(waitSlackOpener({ ...context, waitKind: "person", ref: "need_1" })).toContain("an answer on ENG-12");
  });
});
