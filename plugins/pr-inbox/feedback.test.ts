import { describe, expect, it } from "vitest";
import { feedbackOf } from "./feedback.js";
import { actor, at, comment, fixture, review, thread } from "./fixtures.js";

const read = (patch: Partial<ReturnType<typeof fixture>> = {}) => feedbackOf({ ...fixture(), ...patch, requested: [] });
describe("Workstreams' Your turn rules", () => {
  it.each([
    [{ reviews: [review({ state: "CHANGES_REQUESTED" })] }, "Changes requested by @reviewer"],
    [{ reviews: [review({ state: "APPROVED" })] }, "Approval comment from @reviewer"],
    [{ reviews: [], comments: [comment()] }, "Comment from @reviewer"],
    [{ reviews: [], threads: [thread([comment()])] }, "1 open thread"],
  ])("includes each kind of human feedback", (patch, reason) => {
    expect(read(patch).turn?.why).toContain(reason);
  });
  it("includes drafts and excludes CI-only or bot-only feedback", () => {
    expect(read({ pr: { ...fixture().pr, isDraft: true } }).turn?.why).toBe("Comment from @reviewer");
    expect(read({ reviews: [] }).turn).toBeNull();
    for (const login of ["claude", "chatgpt-codex-connector", "copilot-pull-request-reviewer", "custom[bot]"]) {
      expect(read({ reviews: [review({ author: actor(login), state: "CHANGES_REQUESTED" })], threads: [thread([comment({ author: actor(login) })])] }).turn).toBeNull();
    }
  });
  it("a push answers changes requested, while comments and approval notes require a reply", () => {
    const pr = fixture().pr; pr.commits.nodes = [{ commit: { committedDate: at(12) } }];
    expect(read({ pr, reviews: [review({ state: "CHANGES_REQUESTED", body: "" })] }).turn).toBeNull();
    expect(read({ pr }).turn?.why).toBe("Comment from @reviewer");
    expect(read({ pr, reviews: [review({ state: "APPROVED" })] }).turn?.why).toBe("Approval comment from @reviewer");
    const reply = comment({ author: actor("me"), createdAt: at(13) });
    expect(read({ pr, reviews: [review({ state: "APPROVED" })], comments: [reply] }).turn).toBeNull();
  });
  it("a human author's last word clears a thread, while a bot's reply clears nothing", () => {
    expect(read({ reviews: [], threads: [thread([comment(), comment({ author: actor("me"), createdAt: at(11) })])] }).turn).toBeNull();
    expect(read({ reviews: [], threads: [thread([comment(), comment({ author: actor("claude"), createdAt: at(11) })])] }).turn?.why).toContain("1 open thread");
  });
  it("a later standing approval covers the reviewer's earlier comments", () => {
    expect(read({ reviews: [review({ state: "APPROVED", body: "", submittedAt: at(12) })], comments: [comment()] }).turn).toBeNull();
  });
  it("approval inline notes count even with an empty approval body", () => {
    expect(read({ reviews: [review({ state: "APPROVED", body: "" })], threads: [thread([comment({ pullRequestReview: { id: "R1" } })], true)] }).turn?.why).toBe("Approval comment from @reviewer");
  });
  it("new human comments and pushes change dismissal identity, but bot-only activity does not", () => {
    const original = read();
    expect(read({ threads: [thread([comment({ author: actor("claude") })])] }).activity).toBe(original.activity);
    expect(read({ comments: [comment({ createdAt: at(12) })] }).activity).not.toBe(original.activity);
    expect(read({ pr: { ...fixture().pr, headRefOid: "b".repeat(40) } }).activity).not.toBe(original.activity);
  });
});
