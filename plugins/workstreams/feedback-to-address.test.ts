// Feedback to address is what keeps a PR from reading ready: a reviewer said something and nothing you did on GitHub answered it. Only
// an answer the reviewer sees on the PR (your reply) or your evidence-checked Confirm clears it. A push can't: new commits say nothing
// about a question or a condition. Neither can a PR or issue that mentions it: the rest of a stack mentions it without answering anyone.
import { describe, expect, it } from "vitest";
import { feedbackToAddress, isBot, type FeedbackFacts } from "./feedback-to-address.js";

const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour)).toISOString();
const PRESENT = { status: "present" };
/** An approval that said something at 10, and nothing since. */
const noted = (patch: Partial<NonNullable<FeedbackFacts["reviewFeedback"]>> = {}): FeedbackFacts => ({ approvalFeedback: PRESENT,
  reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: at(10), followUpAt: null, ...patch } });

describe("feedback to address", () => {
  it("holds an approval that said something until you answer it", () => {
    expect(feedbackToAddress(noted(), false)).toEqual([{ kind: "approval", login: null, since: Date.parse(at(10)) }]);
    // A reply before the note answers an older question, not this one.
    expect(feedbackToAddress(noted({ repliedAt: at(9) }), false)).toHaveLength(1);
  });

  it("clears it with your reply after it or your Confirm", () => {
    expect(feedbackToAddress(noted({ repliedAt: at(11) }), false)).toEqual([]);
    expect(feedbackToAddress(noted(), true)).toEqual([]);
  });

  // The live case: a conditional approval, then the rest of its stack mentioned the PR hours later, and it read as answered.
  it("never clears on a PR or issue that links it, however late", () => {
    expect(feedbackToAddress(noted({ followUpAt: at(15) }), false)).toEqual([{ kind: "approval", login: null, since: Date.parse(at(10)) }]);
    expect(feedbackToAddress(noted({ repliedAt: at(9), followUpAt: at(15) }), false)).toHaveLength(1);
  });

  // Nothing here reads the head: a new commit is not an answer, whatever it changed.
  it("never clears on a push", () => {
    const pushed = { ...noted(), headCommittedAt: at(12), headRefOid: "d".repeat(40) } as FeedbackFacts;
    expect(feedbackToAddress(pushed, false)).toHaveLength(1);
  });

  it("holds an approval's notes no read dated until you confirm them", () => {
    expect(feedbackToAddress({ approvalFeedback: PRESENT, reviewFeedback: { openThreads: 0, comment: null, repliedAt: at(12) } }, false))
      .toEqual([{ kind: "approval", login: null, since: null }]);
    expect(feedbackToAddress({ approvalFeedback: PRESENT }, false)).toHaveLength(1);
  });

  it("holds a reviewer's comment until you reply, whatever links it, and Confirm doesn't answer it", () => {
    const facts: FeedbackFacts = { approvalFeedback: { status: "none" },
      reviewFeedback: { openThreads: 0, comment: { login: "theo-k", at: at(10) }, repliedAt: null, noteAt: null, followUpAt: null } };
    expect(feedbackToAddress(facts, true)).toEqual([{ kind: "comment", login: "theo-k", since: Date.parse(at(10)) }]);
    expect(feedbackToAddress({ ...facts, reviewFeedback: { ...facts.reviewFeedback!, repliedAt: at(11) } }, false)).toEqual([]);
    expect(feedbackToAddress({ ...facts, reviewFeedback: { ...facts.reviewFeedback!, followUpAt: at(11) } }, false)).toHaveLength(1);
  });

  it("names the approval first when both wait", () => {
    const both = noted({ comment: { login: "theo-k", at: at(11) } });
    expect(feedbackToAddress(both, false).map((item) => item.kind)).toEqual(["approval", "comment"]);
  });

  it("asks nothing with no approval note and no comment", () => {
    expect(feedbackToAddress({ approvalFeedback: { status: "none" }, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null } }, false)).toEqual([]);
    expect(feedbackToAddress({}, false)).toEqual([]);
  });

  it("knows a bot by GitHub's type, its [bot] suffix, or a known app login", () => {
    for (const login of ["vercel", "linear", "github-actions", "chatgpt-codex-connector", "renovate[bot]", "inkwell-ci-bot"]) expect(isBot(login)).toBe(true);
    expect(isBot("press-helper", "Bot")).toBe(true);
    for (const login of ["theo-k", "mira-l", "robotta"]) expect(isBot(login, "User")).toBe(false);
  });

  // Claude's, Codex's, and Copilot's review apps leave bot notes, never a person's feedback, however a read names them.
  it("knows Claude, Codex, and Copilot's review apps, with or without [bot]", () => {
    for (const login of ["claude", "claude[bot]", "Claude", "codex", "openai-codex", "chatgpt-codex-connector", "chatgpt-codex-connector[bot]", "copilot",
      "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"]) expect([login, isBot(login)]).toEqual([login, true]);
  });
});
