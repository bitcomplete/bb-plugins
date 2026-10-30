import { expect, it } from "vitest";
import { feedbackOf } from "./feedback.js";
import { fixture } from "./fixtures.js";
import { prStatus } from "./pr-status.js";
import { rowSchema } from "./types.js";

it("counts every PR once, keeping feedback, draft and held PRs out of reviewer waits", () => {
  const row = rowSchema.parse({ ...feedbackOf({ ...fixture(), requested: [] }), dismissed: false,
    dispatch: { kind: "none" }, threadStatus: null });
  expect(prStatus(row)).toBe("turn");
  const waiting = { ...row, turn: null };
  expect(prStatus(waiting)).toBe("waiting");
  const approved = { ...waiting, status: { ...fixture().pr, checks: "SUCCESS" as const, reviewDecision: "APPROVED" as const } };
  expect(prStatus(approved)).toBe("approved");
  expect(prStatus({ ...approved, status: { ...approved.status, checks: "FAILURE" } })).toBe("blocked");
  expect(prStatus({ ...approved, status: { ...approved.status, mergeable: "CONFLICTING" } })).toBe("blocked");
  expect(prStatus({ ...approved, draft: true })).toBe("draft");
  expect(prStatus({ ...row, draft: true })).toBe("turn");
  expect(prStatus({ ...row, holdUntil: "2099-01-01T00:00:00Z" })).toBe("held");
  expect(prStatus({ ...row, dismissed: true })).toBe("waiting");
  expect(prStatus({ ...waiting, status: null })).toBe("unknown");
});
