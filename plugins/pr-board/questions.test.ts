import { expect, it } from "vitest";
import { parseQuestion, afterRefresh, type Marker } from "./markers";

const question = { id: "fixture-1", prompt: "Repair the fixture?", options: [
  { id: "repair", label: "Repair", message: "Repair the fixture and run checks." },
  { id: "stop", label: "Stop", message: "Stop and report the remaining work." },
] };
const block = (value: unknown) => `## Decisions for Matt\n1. Repair or stop.\n\n\`\`\`pr-board-question\n${JSON.stringify(value)}\n\`\`\``;

it("recognizes only a validated final question block, never prose that sounds like a question", () => {
  expect(parseQuestion(block({ version: 1, question }))).toEqual({ kind: "valid", question });
  expect(parseQuestion(block({ version: 1, question: null }) + "\n" + block({ version: 1, question }))).toEqual({ kind: "valid", question });
  expect(parseQuestion("Should I fix it? Options: yes, no.")).toEqual({ kind: "invalid" });
  expect(parseQuestion(block({ version: 1, question }) + "\nStill working")).toEqual({ kind: "invalid" });
  expect(parseQuestion(block({ version: 1, question: { ...question, options: [question.options[0], question.options[0]] } }))).toEqual({ kind: "invalid" });
  expect(parseQuestion(block({ version: 2, question }))).toEqual({ kind: "invalid" });
  expect(parseQuestion(block({ version: 1, question: null }))).toEqual({ kind: "valid", question: null });
});

it("preserves an unanswered question after the worker pushes, until the PR closes, even when the thread lookup fails", () => {
  const marker: Marker = { key: "acme/repo#1", action: "fix-ci", status: "started", at: "t0", threadId: "t", title: "Repair check", head: "old", move: "ci", reason: null, question, answeredQuestions: [], answering: null, answerError: null, report: null };
  const threads = { t: { live: false, updatedAt: "t1" } };
  expect(afterRefresh([marker], { [marker.key]: { head_oid: "new", move: "ready" } }, threads, "t2")).toEqual([marker]);
  expect(afterRefresh([marker], {}, threads, "t2")).toEqual([]);
  expect(afterRefresh([marker], { [marker.key]: { head_oid: "new", move: "ready" } }, { t: null }, "t2")).toEqual([marker]);
});
