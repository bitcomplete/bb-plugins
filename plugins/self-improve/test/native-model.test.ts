import { describe, expect, it, vi } from "vitest";
import { buildInventorPrompt, completeJson, parseInventions, parseJsonReply, type NativeJsonRequest } from "../src/native-model.js";
import type { NativeTaskReceipt } from "../src/native-tasks.js";
const request: NativeJsonRequest = { id: "t", runId: "r", stage: "inventor", instructions: "Return JSON", input: "{}", privacyGeneration: "p1", execution: { providerId: "codex", model: "selected", projectId: "p", environment: { type: "reuse", environmentId: "e" } } };
function receipt(req: NativeJsonRequest, text = "[]"): NativeTaskReceipt { return { taskId: req.id, runId: req.runId, stage: req.stage, providerId: req.execution.providerId, model: req.execution.model, threadId: "thread", requestId: "request", turnId: "turn", text, promptHash: "a".repeat(64), startedAtMs: 1, endedAtMs: 2, modelIdentitySource: "requested-selection" }; }
describe("native structured model proposals", () => {
  it.each(["codex", "claude-code"])("uses the same native task contract for %s", async providerId => {
    const req = { ...request, execution: { ...request.execution, providerId } };
    const result = receipt(req, '{"ok":true}'), execute = vi.fn(async () => result), signal = new AbortController().signal;
    expect(await completeJson({ execute }, req, signal)).toEqual({ ...result, value: { ok: true } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(req, signal);
  });
  it("projects only sanitized problem text and explicitly discloses context limits", () => {
    const input = { symptoms: ["Acme call retry failed"], rootCause: "Validation omitted", history: "private history", paper: "irrelevant prior paper", id: "secret-ref" };
    const prompt = buildInventorPrompt(input, { clientNames: ["Acme"] });
    expect(JSON.parse(prompt.input)).toEqual({ symptoms: ["[redacted] call retry failed"], rootCauseHypothesis: "Validation omitted" });
    expect(prompt.instructions).toContain("not enforced context isolation");
    expect(prompt.instructions).toContain("plugins, skills");
  });
  it("rejects unstructured or oversized replies without accepting a partial proposal", () => {
    expect(parseJsonReply('```json\n[]\n```')).toEqual([]);
    expect(() => parseJsonReply('Here you go: ```json\n[]\n```')).toThrow("Model must return only valid JSON");
    expect(() => parseJsonReply('```json\n[]\n``` and more')).toThrow("Model must return only valid JSON");
    expect(() => parseJsonReply(" ".repeat(200_001))).toThrow("exceeds its limit");
    expect(() => parseInventions([{ mechanism: "a", prediction: "b", test: "c", assumptions: [], effort: 1, risk: 1 }])).toThrow("Declare assumptions and dependencies");
  });
  it("rejects another task's receipt and a result delivered after cancellation", async () => {
    await expect(completeJson({ execute: async () => ({ ...receipt(request), taskId: "other" }) }, request)).rejects.toThrow("does not match");
    const controller = new AbortController();
    await expect(completeJson({ execute: async () => { controller.abort(); return receipt(request); } }, request, controller.signal)).rejects.toThrow();
  });
});
