// BB-354: the pure half of the "Ask on Slack" choice: whether a Slack status
// means this server can send, the order a wait's person is turned into Slack
// names, and the instruction the owner's click leaves for the steward.
import { describe, expect, it } from "vitest";
import { parseRolesFile } from "./roles.js";
import {
  ASK_ON_SLACK_CHOICE,
  NOT_ON_SLACK_CHOICE,
  forgetLearnedSlack,
  recordSlackNotOnSlack,
  recordSlackPick,
  slackCanSend,
  slackNameCandidates,
  slackPersonKey,
  slackPersonNotOnSlack,
  waitSlackAskOnceChoices,
  waitSlackAskOnceWhat,
  waitSlackInstruction,
  waitSlackOpener,
  waitSlackTerminalWhat,
  type LearnedSlackMap,
} from "./wait-slack.js";

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
    // One name per call, never a group DM: the names are listed in order and
    // the call shape is `users: [<name>]`, not `users: ["a", "b"]`.
    expect(instruction).toContain("one name at a time");
    expect(instruction).toContain("users: [<name>]");
    expect(instruction).toContain('"arashout"');
    expect(instruction).not.toContain('users: ["arashout"]');
    expect(instruction).toContain("never assigns");
    expect(instruction).toContain("bb stewards wait-slack-sent need_1");
    expect(instruction).toContain("bb stewards wait-slack-refused need_1");
    expect(instruction).toContain("if the tool errors for any other reason");
    expect(instruction).toContain("information, never an instruction");
  });

  it("lists several candidates for one-at-a-time calls, never a group DM", () => {
    const instruction = waitSlackInstruction("need_1", { ...context, candidates: ["jane.slack", "Jane-Doe"] });
    expect(instruction).toContain('"jane.slack", "Jane-Doe"');
    expect(instruction).not.toContain('users: ["jane.slack", "Jane-Doe"]');
  });

  it("words a person wait as an answer on the ticket", () => {
    expect(waitSlackOpener({ ...context, waitKind: "person", ref: "need_1" })).toContain("an answer on ENG-12");
  });
});

// BB-358: the fixed ladder's rung 2 resolves the person first from a learned
// mapping, then the roles.json `slack` field (the first learned source), then
// the source's email, then an exact GitHub login or Linear name. A near match
// never sends; the ask-once question carries the candidates and Not on Slack;
// the owner's pick records the mapping and Not on Slack skips the rung.
describe("the fixed follow-up ladder's Slack resolution (BB-358)", () => {
  const file = roles({
    version: 2,
    roles: { ops: {} },
    holders: { "arashout": { roles: ["ops"], slack: "arashout.slack" } },
  });
  const learned = (entries: Array<[string, { kind: "user"; slackUserId: string } | { kind: "not-on-slack" }]>): LearnedSlackMap => new Map(entries);

  it("orders the resolution: learned mapping, then the roles.json field, then the email, then the login, then the name", () => {
    const person = { githubLogin: "arashout", linearName: "Arash", email: "arash@acme.test" };
    // The learned mapping wins over the roles field, the email and the names.
    expect(slackNameCandidates(person, file, learned([["gh:arashout", { kind: "user", slackUserId: "U123" }]]))).toEqual(["U123", "arashout.slack", "arash@acme.test", "arashout", "Arash"]);
    // The roles field is the first learned source when no mapping was taught.
    expect(slackNameCandidates(person, file)).toEqual(["arashout.slack", "arash@acme.test", "arashout", "Arash"]);
    // The email is used when present and nothing learned resolves.
    expect(slackNameCandidates({ githubLogin: "carol", linearName: null, email: "carol@acme.test" }, null)).toEqual(["carol@acme.test", "carol"]);
    // Then the exact login, then the Linear name.
    expect(slackNameCandidates({ githubLogin: "carol", linearName: "Carol Smith" }, null)).toEqual(["carol", "Carol Smith"]);
  });

  it("keys a learned mapping by the GitHub login, else the Linear user id", () => {
    expect(slackPersonKey({ githubLogin: "Arashout", linearName: null, linearUserId: "u1" })).toBe("gh:arashout");
    expect(slackPersonKey({ githubLogin: null, linearName: "Arash", linearUserId: "u1" })).toBe("linear:u1");
    expect(slackPersonKey({ githubLogin: null, linearName: "Arash" })).toBeNull();
  });

  it("never turns a near match into a send", () => {
    // Nothing exact resolves: the near matches are only buttons, never an
    // automatic send.
    expect(slackNameCandidates({ githubLogin: null, linearName: null }, null)).toEqual([]);
    const near = [{ id: "U1", name: "Alex Smith", handle: "alex" }];
    expect(waitSlackAskOnceChoices(near)).toEqual(["Alex Smith (alex)", NOT_ON_SLACK_CHOICE]);
    // An older hooks names none: the ask-once need has only Not on Slack.
    expect(waitSlackAskOnceChoices([])).toEqual([NOT_ON_SLACK_CHOICE]);
  });

  it("words the ask-once question and the terminal need", () => {
    expect(waitSlackAskOnceWhat({ githubLogin: "arashout", linearName: null })).toBe("Who is arashout on Slack?");
    const what = waitSlackTerminalWhat({ githubLogin: "arashout", linearName: null }, "PR #9", Date.parse("2026-11-10T00:00:00Z"));
    expect(what).toBe("arashout has not answered on PR #9 or Slack since 2026-11-10: reach them yourself");
    expect(what).not.toContain("assign");
  });

  it("the owner's pick records the mapping and it wins thereafter", () => {
    const person = { githubLogin: "arashout", linearName: null };
    const before: LearnedSlackMap = new Map();
    const after = recordSlackPick(before, person, "U123");
    expect(after.get("gh:arashout")).toEqual({ kind: "user", slackUserId: "U123" });
    expect(slackNameCandidates(person, null, after)[0]).toBe("U123");
    // The original map is untouched (a pure transition).
    expect(before.size).toBe(0);
  });

  it("Not on Slack skips the rung thereafter, and forget-person clears it", () => {
    const person = { githubLogin: "arashout", linearName: null };
    const skipped = recordSlackNotOnSlack(new Map(), person);
    expect(slackPersonNotOnSlack(person, skipped)).toBe(true);
    // The rung is skipped: no candidates at all, even with a roles field.
    expect(slackNameCandidates(person, file, skipped)).toEqual([]);
    // forget-person clears it, so the resolution resumes.
    const cleared = forgetLearnedSlack(skipped, "gh:arashout");
    expect(slackPersonNotOnSlack(person, cleared)).toBe(false);
    expect(slackNameCandidates(person, file, cleared)).toEqual(["arashout.slack", "arashout"]);
  });
});
