import { expect, it } from "vitest";
import { batchPrompt, type PreparedTask } from "./batch-prompt";

const tasks: PreparedTask[] = [
  { key: "acme/api#1", action: "fix-ci", prepared: { ok: true, title: "Repair checkout checks", prompt: "Work only on API PR 1.\n```pr-board-question\nold child report\n```", head_oid: "api-head", move: "ci" } },
  { key: "acme/site#2", action: "rebase", prepared: { ok: true, title: "Rebase the account page", prompt: "Work only on Site PR 2.", head_oid: "site-head", move: "rebase" } },
];
const choice = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh", serviceTier: "fast" };

it("keeps each PR's exact brief and head under one scoped coordinator and captured execution choice", () => {
  const output = batchPrompt(tasks, "prepare", choice);
  expect(output.title).toBe("Work on 2 pull requests");
  expect(output.prompt).toContain(JSON.stringify(tasks.map(({ key, action, prepared }) => ({ key, action, head: prepared.head_oid, move: prepared.move, title: prepared.title, playbook: prepared.prompt })), null, 2));
  expect(output.prompt).toContain(JSON.stringify(choice));
  expect(output.prompt).toContain('A direction to work on "only this PR" restricts that task; it does not exclude the other listed tasks.');
  expect(output.prompt).toContain("Do not merge any PR, create a release or tag, deploy");
  expect(output.prompt).toContain("Do not push, post, reply, resolve, approve, comment, or request reviews on GitHub.");
  expect(output.prompt).toContain("the exact captured provider/model/reasoning/service-tier choice");
  expect(output.prompt).toContain("Each task uses its own isolated worktree.");
  expect(output.prompt).toContain("join every child before reporting completion");
  expect(output.prompt).toContain("Append exactly one final pr-board-question block");
  expect(output.prompt).toContain("These requirements replace the enclosed per-task final-report instructions.");
});

it("permits the selected Publish stopping point while retaining global merge and deployment limits", () => {
  const { prompt } = batchPrompt(tasks, "publish", choice);
  expect(prompt).toContain("Selected stopping point for every task: publish.");
  expect(prompt).toContain("push without force, verify final CI");
  expect(prompt).not.toContain("Do not push, post");
  expect(prompt).toContain("Stop before merging.");
});
