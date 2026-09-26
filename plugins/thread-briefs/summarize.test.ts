import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  chatCompletionsUrl,
  extractJson,
  parseSummary,
} from "./summarize.js";
import {
  endsWithQuestion,
  renderTranscript,
  selectOutline,
  type OutlineItem,
} from "./transcript.js";

const reply = (fields: Record<string, unknown>) => JSON.stringify(fields);

const full = {
  goal: "Ship thread briefs",
  currentState: "Server written",
  nextStep: "Run the tests",
  blockedOn: "",
  constraints: "",
  stage: "implementation",
};

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced object", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses an object wrapped in prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/u);
  });
});

describe("parseSummary", () => {
  it("returns the five fields and the stage", () => {
    expect(parseSummary(reply(full), null)).toEqual(full);
  });

  it("treats 'none' and friends as empty, so status derivation stays right", () => {
    const parsed = parseSummary(
      reply({ ...full, nextStep: "N/A", blockedOn: "None", constraints: "-" }),
      null,
    );
    expect(parsed.nextStep).toBe("");
    expect(parsed.blockedOn).toBe("");
    expect(parsed.constraints).toBe("");
  });

  it("falls back to implementation for an unrecognized stage", () => {
    expect(parseSummary(reply({ ...full, stage: "vibes" }), null).stage).toBe(
      "implementation",
    );
  });

  it("forces the user's stage over the model's", () => {
    expect(parseSummary(reply({ ...full, stage: "discovery" }), "review").stage).toBe(
      "review",
    );
  });

  it("fills in missing fields rather than failing the brief", () => {
    const parsed = parseSummary(reply({ goal: "Just this" }), null);
    expect(parsed.goal).toBe("Just this");
    expect(parsed.currentState).toBe("");
    expect(parsed.nextStep).toBe("");
  });
});

describe("chatCompletionsUrl", () => {
  it("tolerates a trailing slash", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(chatCompletionsUrl("  https://x.test/v1  ")).toBe(
      "https://x.test/v1/chat/completions",
    );
  });
});

describe("buildUserPrompt", () => {
  it("tells the model to judge the stage when there is no override", () => {
    expect(buildUserPrompt({ transcript: "t", fixedStage: null })).toContain(
      "Judge \"stage\"",
    );
  });

  it("pins the stage when the user set one", () => {
    const prompt = buildUserPrompt({ transcript: "t", fixedStage: "review" });
    expect(prompt).toContain('"stage" is fixed to "review"');
  });
});

describe("endsWithQuestion", () => {
  it("detects a trailing question", () => {
    expect(endsWithQuestion("Which approach do you want?")).toBe(true);
  });

  it("looks past trailing markdown noise", () => {
    expect(endsWithQuestion("Should I proceed?**\n")).toBe(true);
  });

  it("is false for a statement", () => {
    expect(endsWithQuestion("Done — tests pass.")).toBe(false);
  });

  it("is false for no output at all", () => {
    expect(endsWithQuestion(null)).toBe(false);
  });
});

describe("selectOutline", () => {
  const item = (n: number): OutlineItem => ({
    role: n % 2 === 0 ? "user" : "assistant",
    preview: `message ${n}`,
  });

  it("keeps a short outline whole", () => {
    const outline = Array.from({ length: 10 }, (_, n) => item(n));
    expect(selectOutline(outline)).toEqual({ items: outline, elided: 0 });
  });

  it("keeps the head and tail of a long outline and elides the middle", () => {
    const outline = Array.from({ length: 100 }, (_, n) => item(n));
    const { items, elided } = selectOutline(outline);
    expect(elided).toBe(70);
    expect(items).toHaveLength(30);
    // The opening states the goal; the tail states the current position.
    expect(items[0]?.preview).toBe("message 0");
    expect(items.at(-1)?.preview).toBe("message 99");
  });
});

describe("renderTranscript", () => {
  it("includes the previous brief so the summarizer updates rather than restarts", () => {
    const text = renderTranscript({
      title: "Thread briefs",
      outline: [{ role: "user", preview: "Build it" }],
      lastAssistantText: "Done.",
      previousBrief: {
        goal: "Ship briefs",
        currentState: "half done",
        nextStep: "finish",
        blockedOn: "",
        constraints: "kv rows cap at 256KB",
      },
    });
    expect(text).toContain("Previous brief");
    expect(text).toContain("kv rows cap at 256KB");
    expect(text).toContain("blockedOn: (empty)");
    expect(text).toContain("User: Build it");
  });

  it("marks where the middle was elided", () => {
    const outline = Array.from({ length: 100 }, (_, n) => ({
      role: "user" as const,
      preview: `m${n}`,
    }));
    const text = renderTranscript({
      title: null,
      outline,
      lastAssistantText: null,
      previousBrief: null,
    });
    expect(text).toContain("earlier messages elided");
    expect(text).toContain("(untitled)");
  });
});
