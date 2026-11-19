import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Store, MIGRATIONS } from "../src/store.js";
import { createRevalidation } from "../src/revalidation.js";
import { createRevalidationDraftEditor } from "../src/revalidation-edit.js";
import type { EditRevalidationDraft } from "../src/revalidation-edit-contract.js";
import { solution } from "./domain/fixtures.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const chat = { kind: "chat" as const, id: "chat-thread" };
function fixture() {
  const db = new Database(":memory:"); databases.push(db); MIGRATIONS.forEach(sql => db.exec(sql)); const store = new Store(db);
  const content = "Keep the original request unchanged.", artifactDigest = createHash("sha256").update(content).digest("hex");
  store.put("solutions", "solution", solution("solution"));
  store.put("native-evaluation-artifacts", "artifact", { solutionId: "solution", revision: "r1", kind: "instruction", content, artifactDigest });
  const domain = createRevalidation(store, { redact: v => v });
  const input: EditRevalidationDraft = { action: "create", requestId: "intent-1", definition: {
    target: { solutionId: "solution", namespace: "native-evaluation-artifacts", artifactId: "artifact", revision: "r1", artifactDigest },
    concern: "Does it preserve every field?", claim: { id: "claim", text: "Payload preservation" },
    cases: [{ id: "case-1", input: "Copy the payload.", expected: "original" }],
    criteria: [{ id: "pass", measure: "pass-rate", statistic: "treatment", operator: "at-least", value: 1, required: true }],
    limits: { maxDurationMs: 600_000 } } };
  return { store, domain, edit: createRevalidationDraftEditor(domain.plans), input };
}
it("creates once per request and revises into new versions", () => {
  const f = fixture(), first = f.edit(f.input, chat);
  expect(f.edit(f.input, chat)).toEqual(first);
  expect(() => f.edit({ ...f.input, definition: { ...f.input.definition, concern: "Different" } }, chat)).toThrow("request-conflict");
  const revised = f.edit({ action: "revise", planId: first.id, expectedVersion: 1, definition: { ...f.input.definition, cases: [{ id: "case-1", input: "Copy the payload.", expected: "next" }] } }, chat);
  expect(revised.version).toBe(2);
  expect(f.domain.plans.history(first.id).versions.map(v => v.definition.cases[0]!.expected)).toEqual(["original", "next"]);
  expect(() => f.edit({ action: "revise", planId: first.id, expectedVersion: 1, definition: f.input.definition }, chat)).toThrow("version-conflict");
});
it("accepts no result, score or verdict fields", () => {
  const f = fixture();
  expect(() => f.edit({ ...f.input, verdict: "supported" } as never, chat)).toThrow();
  expect(() => f.edit({ ...f.input, definition: { ...f.input.definition, passed: 3 } } as never, chat)).toThrow();
});
