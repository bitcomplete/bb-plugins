import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  chatCompletionsUrl,
  clampProse,
  extractJson,
  normalizeRefresher,
  normalizeTitle,
  normalizeStatus,
  parseSummary,
} from "./summarize.js";
import { MAX_REFRESHER_LENGTH, MAX_TITLE_LENGTH } from "./contract.js";
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
  status: "waiting-on-me",
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
    // `refresher` comes back null rather than absent: a model that ignored the
    // two prose keys still wrote a usable brief, and the only consequence is a
    // thread that never shows a re-entry card.
    expect(parseSummary(reply(full), null)).toEqual({ ...full, refresher: null });
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

  it("keeps a recognised actor, case and spacing aside", () => {
    expect(
      parseSummary(reply({ ...full, nextStepActor: "  Other " }), null)
        .nextStepActor,
    ).toBe("other");
    expect(
      parseSummary(reply({ ...full, nextStepActor: "me" }), null).nextStepActor,
    ).toBe("me");
  });

  it("drops an actor it does not recognise rather than failing the brief", () => {
    // An unknown actor must fall back to the actor-free derivation, not cost
    // the whole summary — the same bar as an unrecognised stage.
    const parsed = parseSummary(reply({ ...full, nextStepActor: "dylan" }), null);
    expect(parsed.nextStepActor).toBeUndefined();
    expect(parsed.goal).toBe(full.goal);
  });

  it("drops an actor named for a next step that does not exist", () => {
    expect(
      parseSummary(
        reply({ ...full, nextStep: "", nextStepActor: "agent" }),
        null,
      ).nextStepActor,
    ).toBeUndefined();
  });

  it("leaves the actor absent when the model omits it", () => {
    expect(parseSummary(reply(full), null).nextStepActor).toBeUndefined();
  });
});

describe("chatCompletionsUrl", () => {
  it("appends the path to an API root", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

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

  // Providers document the full endpoint, so it gets pasted in as the base URL.
  // Appending blindly produced /chat/completions/chat/completions and a 404.
  it("leaves a full Fireworks endpoint alone", () => {
    expect(
      chatCompletionsUrl("https://api.fireworks.ai/inference/v1/chat/completions"),
    ).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
  });

  it("accepts the Fireworks API root too", () => {
    expect(chatCompletionsUrl("https://api.fireworks.ai/inference/v1")).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions",
    );
  });

  it("leaves a full endpoint with a trailing slash alone", () => {
    expect(chatCompletionsUrl("https://x.test/v1/chat/completions/")).toBe(
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

  it("says nothing about a status when none is pinned", () => {
    const prompt = buildUserPrompt({ transcript: "t", fixedStage: null });
    expect(prompt).not.toContain("refresherShort");
  });

  it("tells the refreshers about a pinned status, and only them", () => {
    // The pin sits in front of the derivation rather than editing the fields it
    // reads: a `nextStep` blanked to satisfy a pin would be fed back as the
    // previous brief and written into storage. So the prompt scopes the pin to
    // the two prose fields and says the rest still describes the work.
    const prompt = buildUserPrompt({
      transcript: "t",
      fixedStage: null,
      pinnedStatus: "waiting-on-other",
    });
    expect(prompt).toContain('For "refresherShort" and "refresherFull" only');
    expect(prompt).toContain("must not tell them to carry on");
    expect(prompt).toContain("The other fields still describe the work");
  });

  it("tells the model what to do with a block note, when there is one", () => {
    // Unlike the pinned-status line this one is addressed to the fields: the
    // note is a fact the transcript lacks, and the model is to write
    // `blockedOn` and `status` from it as it would from a message.
    const prompt = buildUserPrompt({
      transcript: "t",
      fixedStage: null,
      hasBlockReason: true,
    });
    expect(prompt).toContain('marked "User\'s note"');
    expect(prompt).toContain("Treat it as true unless the conversation after that line");
    expect(prompt).toContain('"status" is "waiting-on-other"');
    expect(
      buildUserPrompt({ transcript: "t", fixedStage: null, hasBlockReason: false }),
    ).not.toContain("User's note");
  });

  it("tells them not to hand out a next step on a thread pinned done", () => {
    const prompt = buildUserPrompt({
      transcript: "t",
      fixedStage: null,
      pinnedStatus: "done",
    });
    expect(prompt).toContain("must not hand out a next action");
  });
});

describe("clampProse", () => {
  it("leaves prose inside the budget alone, whitespace collapsed", () => {
    expect(clampProse("You were\n  mid-reconcile.", 100)).toBe(
      "You were mid-reconcile.",
    );
  });

  it("cuts back to the last whole sentence", () => {
    // What survives has to read as sentences. A clause ending in an ellipsis is
    // the thing people skip.
    const text = "You wired the sections. The order is not pinned. Run the reconcile and check it lands where you expect.";
    expect(clampProse(text, 60)).toBe(
      "You wired the sections. The order is not pinned.",
    );
  });

  it("falls back to a word boundary for one very long sentence", () => {
    const text = `${"word ".repeat(40)}end.`;
    const clamped = clampProse(text, 50);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.length).toBeLessThanOrEqual(50);
  });

  it("keeps cutting when the only sentence end is right at the start", () => {
    // A boundary in the first fifth of the budget is a one-line answer to a
    // three-line question, not a clamp; taking it would throw the rest away.
    const text = `Yes. ${"word ".repeat(40)}end.`;
    expect(clampProse(text, 60).endsWith("…")).toBe(true);
  });
});

describe("normalizeRefresher", () => {
  it("keeps both variants", () => {
    expect(
      normalizeRefresher({ short: " One line. ", full: "Two lines, really." }),
    ).toEqual({ short: "One line.", full: "Two lines, really." });
  });

  it("keeps a lone variant rather than dropping the pair", () => {
    // `chooseRefresher` falls back to whichever one exists, so a model that
    // answered only the short form still reorients someone back after a week.
    expect(normalizeRefresher({ short: "One line.", full: "" })).toEqual({
      short: "One line.",
      full: "",
    });
  });

  it("returns null when the model ignored both keys", () => {
    expect(normalizeRefresher({ short: undefined, full: undefined })).toBeNull();
    expect(normalizeRefresher({ short: "none", full: "N/A" })).toBeNull();
  });

  it("clamps each variant to its own budget", () => {
    const long = `${"Sentence here. ".repeat(80)}`;
    const prose = normalizeRefresher({ short: long, full: long });
    expect(prose!.short.length).toBeLessThanOrEqual(MAX_REFRESHER_LENGTH.short);
    expect(prose!.full.length).toBeLessThanOrEqual(MAX_REFRESHER_LENGTH.full);
    expect(prose!.full.length).toBeGreaterThan(prose!.short.length);
  });
});

describe("normalizeStatus", () => {
  it("keeps each status the model can answer, case and spacing aside", () => {
    expect(normalizeStatus("done", "")).toBe("done");
    expect(normalizeStatus(" Waiting-On-Me ", "")).toBe("waiting-on-me");
    expect(normalizeStatus("waiting-on-other", "Review from Sam")).toBe(
      "waiting-on-other",
    );
  });

  it("falls back to waiting-on-me, the reading whose mistake is cheap", () => {
    // A wrong waiting-on-me is sidebar noise; a wrong done is archived two
    // days later. An answer we cannot read must land on the cheap side.
    expect(normalizeStatus(undefined, "")).toBe("waiting-on-me");
    expect(normalizeStatus("finished", "")).toBe("waiting-on-me");
    expect(normalizeStatus(true, "")).toBe("waiting-on-me");
  });

  it("never calls a thread done while it names something it is waiting on", () => {
    expect(normalizeStatus("done", "Review from Sam")).toBe("waiting-on-other");
  });
});

describe("parseSummary status", () => {
  it("takes the status the model answered, not one read off nextStep", () => {
    // A finished thread may carry a suggestion; an unfinished one may have no
    // step written down. Neither field decides the other.
    expect(
      parseSummary(reply({ ...full, nextStep: "Add a lint rule", status: "done" }), null)
        .status,
    ).toBe("done");
    expect(
      parseSummary(reply({ ...full, nextStep: "", status: "waiting-on-me" }), null)
        .status,
    ).toBe("waiting-on-me");
  });

  it("applies the blockedOn guard after empty synonyms are cleared", () => {
    expect(
      parseSummary(reply({ ...full, blockedOn: "None", status: "done" }), null).status,
    ).toBe("done");
    expect(
      parseSummary(reply({ ...full, blockedOn: "Sam's review", status: "done" }), null)
        .status,
    ).toBe("waiting-on-other");
  });

  it("leaves the stage as the model judged it, whatever nextStep says", () => {
    expect(
      parseSummary(reply({ ...full, nextStep: "", stage: "implementation" }), null)
        .stage,
    ).toBe("implementation");
  });
});

describe("parseSummary refreshers", () => {
  it("reads the two prose keys off the reply", () => {
    const parsed = parseSummary(
      reply({
        ...full,
        refresherShort: "You were mid-reconcile. Run the tests.",
        refresherFull: "You were mid-reconcile on the section sync. It lands, but the order is unpinned. Run the tests.",
      }),
      null,
    );
    expect(parsed.refresher).toEqual({
      short: "You were mid-reconcile. Run the tests.",
      full: "You were mid-reconcile on the section sync. It lands, but the order is unpinned. Run the tests.",
    });
  });

  it("does not fail the brief over a model that skipped them", () => {
    // Losing the five fields, the ring and the sidebar section over a missing
    // paragraph would be a bad trade in every direction.
    const parsed = parseSummary(reply(full), null);
    expect(parsed.refresher).toBeNull();
    expect(parsed.goal).toBe(full.goal);
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
  it("feeds back the settled fields of the previous brief, not where it stood", () => {
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
    expect(text).toContain("currentState: half done");
    // nextStep and blockedOn are re-read from the transcript every time: handed
    // back, they outlive the turns that made them obsolete.
    expect(text).not.toContain("nextStep");
    expect(text).not.toContain("blockedOn");
    expect(text).toContain("User: Build it");
  });

  it("places the block note after the user message it followed", () => {
    const text = renderTranscript({
      title: null,
      outline: [
        { role: "user", preview: "Build it" },
        { role: "assistant", preview: "Built." },
        { role: "user", preview: "Where were we?" },
      ],
      lastAssistantText: null,
      previousBrief: null,
      blockReason: {
        text: "not before the release",
        recordedAt: Date.UTC(2026, 9, 3),
        userMessagesSeen: 1,
      },
    });
    const lines = text.split("\n");
    const note = lines.findIndex((line) => line.startsWith("[User's note"));
    expect(lines[note]).toBe(
      "[User's note, recorded 2026-10-03: this thread is blocked because \"not before the release\"]",
    );
    expect(lines[note - 1]).toBe("Agent: Built.");
    expect(lines[note + 1]).toBe("User: Where were we?");
  });

  it("keeps the block note through elision", () => {
    const outline = Array.from({ length: 100 }, (_, n) => ({
      role: "user" as const,
      preview: `m${n}`,
    }));
    const text = renderTranscript({
      title: null,
      outline,
      lastAssistantText: null,
      previousBrief: null,
      blockReason: { text: "parked", recordedAt: 0, userMessagesSeen: 50 },
    });
    expect(text).toContain("[User's note");
    expect(text).toContain("earlier messages elided");
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

describe("normalizeTitle", () => {
  it("keeps a well-formed name as it is", () => {
    expect(normalizeTitle("Sidebar grouping by brief status")).toBe(
      "Sidebar grouping by brief status",
    );
  });

  it("strips the wrapping quotes and trailing punctuation models add", () => {
    expect(normalizeTitle('"Kploy image tracking".')).toBe("Kploy image tracking");
    expect(normalizeTitle("`Machine pod memory limits`")).toBe(
      "Machine pod memory limits",
    );
  });

  it("collapses the whitespace of a wrapped reply", () => {
    expect(normalizeTitle("  Thread brief\n  titles  ")).toBe("Thread brief titles");
  });

  it("truncates an over-long name at a word boundary", () => {
    const title = normalizeTitle(
      "Adding a summarizer-chosen short name and renaming bb threads to match it",
    );
    expect(title).toBe("Adding a summarizer-chosen short name and");
    expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });

  it("hard-cuts a single word longer than the cap", () => {
    // An identifier with no space to break on is better truncated than dropped.
    const title = normalizeTitle("a".repeat(80));
    expect(title).toBe("a".repeat(MAX_TITLE_LENGTH));
  });

  it("rejects a non-answer rather than putting it on a thread", () => {
    expect(normalizeTitle("")).toBeUndefined();
    expect(normalizeTitle("   ")).toBeUndefined();
    expect(normalizeTitle("N/A")).toBeUndefined();
    expect(normalizeTitle("unknown")).toBeUndefined();
    expect(normalizeTitle(null)).toBeUndefined();
    expect(normalizeTitle(42)).toBeUndefined();
  });
});

describe("parseSummary titles", () => {
  it("carries a usable title through", () => {
    expect(parseSummary(reply({ ...full, title: "Thread brief titles" }), null).title).toBe(
      "Thread brief titles",
    );
  });

  it("leaves the title absent when the model omitted it", () => {
    // Absent, not empty: the brief is still good and the thread keeps its name.
    expect(parseSummary(reply(full), null).title).toBeUndefined();
  });

  it("does not fail the whole brief over a bad title", () => {
    const summary = parseSummary(reply({ ...full, title: 12 }), null);
    expect(summary.title).toBeUndefined();
    expect(summary.goal).toBe("Ship thread briefs");
  });
});
