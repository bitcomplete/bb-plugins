import type { BriefFields } from "./contract.js";

export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

export interface TranscriptInput {
  title: string | null;
  outline: readonly OutlineItem[];
  /** The last assistant text in full, from `threads.output`. */
  lastAssistantText: string | null;
  previousBrief: BriefFields | null;
}

/** Keep the opening exchanges: the goal is anchored there. */
const HEAD_ITEMS = 6;
/** Keep the recent exchanges: current state and next step live there. */
const TAIL_ITEMS = 24;
const PREVIEW_CHARS = 400;
const LAST_TEXT_CHARS = 4000;

function clamp(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}

/**
 * Keep the head and the tail, elide the middle.
 *
 * A long thread's opening exchange is what states the goal, and its recent
 * exchanges are what state the current position — the middle is the part a
 * brief can most afford to lose, and dropping it is what keeps the prompt
 * bounded on threads that run for days.
 */
export function selectOutline(
  outline: readonly OutlineItem[],
): { items: OutlineItem[]; elided: number } {
  if (outline.length <= HEAD_ITEMS + TAIL_ITEMS) {
    return { items: [...outline], elided: 0 };
  }
  return {
    items: [
      ...outline.slice(0, HEAD_ITEMS),
      ...outline.slice(outline.length - TAIL_ITEMS),
    ],
    elided: outline.length - HEAD_ITEMS - TAIL_ITEMS,
  };
}

/** A question mark at the end of the agent's last words is the cheap, honest
 * signal that it handed the turn back with an ask. */
export function endsWithQuestion(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  if (trimmed === "") return false;
  // Ignore trailing markdown/formatting noise so "...decide? **" still counts.
  const tail = trimmed.slice(-400).replace(/[\s*_`>)\]]+$/u, "");
  return tail.endsWith("?");
}

/**
 * Render the summarizer's view of the thread. Plain labelled text rather than
 * JSON: it survives elision cleanly and every model reads it the same way.
 */
export function renderTranscript(input: TranscriptInput): string {
  const parts: string[] = [];

  parts.push(`Thread title: ${input.title ?? "(untitled)"}`);

  if (input.previousBrief !== null) {
    const previous = input.previousBrief;
    parts.push(
      [
        "Previous brief (update it; keep what is still true, correct what is not):",
        `  goal: ${previous.goal || "(empty)"}`,
        `  currentState: ${previous.currentState || "(empty)"}`,
        `  nextStep: ${previous.nextStep || "(empty)"}`,
        `  blockedOn: ${previous.blockedOn || "(empty)"}`,
        `  constraints: ${previous.constraints || "(empty)"}`,
      ].join("\n"),
    );
  }

  const { items, elided } = selectOutline(input.outline);
  const lines: string[] = [];
  items.forEach((item, index) => {
    if (elided > 0 && index === HEAD_ITEMS) {
      lines.push(`[… ${elided} earlier messages elided …]`);
    }
    const speaker = item.role === "user" ? "User" : "Agent";
    lines.push(`${speaker}: ${clamp(item.preview, PREVIEW_CHARS)}`);
  });
  parts.push(
    lines.length === 0
      ? "Conversation: (no messages yet)"
      : `Conversation:\n${lines.join("\n")}`,
  );

  if (input.lastAssistantText !== null && input.lastAssistantText.trim() !== "") {
    parts.push(
      `The agent's most recent message, in full:\n${clamp(
        input.lastAssistantText,
        LAST_TEXT_CHARS,
      )}`,
    );
  }

  return parts.join("\n\n");
}
