import type { BriefFields } from "./contract.js";

export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

/**
 * A block reason, placed in the conversation.
 *
 * `userMessagesSeen` is how many user messages the thread held when the note
 * was made; the renderer puts the note after that many, so the model can tell
 * what was said before the user called the thread blocked from what was said
 * after — which is the whole of "treat it as true unless the conversation
 * since shows it resolved".
 */
export interface BlockReasonNote {
  text: string;
  recordedAt: number;
  userMessagesSeen: number;
}

export interface TranscriptInput {
  title: string | null;
  outline: readonly OutlineItem[];
  /** The last assistant text in full, from `threads.output`. */
  lastAssistantText: string | null;
  previousBrief: BriefFields | null;
  /** The user's note on why the thread is blocked, if one is held. */
  blockReason?: BlockReasonNote | null;
}

/** The marker the note is rendered under, so the prompt can name it. */
export const BLOCK_NOTE_MARKER = "User's note";

/** One line of conversation as the model sees it: a message or the note. */
type Line = { kind: "message"; item: OutlineItem } | { kind: "note" };

/**
 * The outline with the block note slotted in just before the user message
 * that followed it.
 *
 * Before the next *user* message rather than straight after the last one,
 * because the count cannot see the agent's reply in between — and a thread is
 * nearly always parked after reading that reply, not before it. A note
 * recorded before any message — a count of zero — leads; one recorded after
 * more user messages than the outline now holds trails, which still reads
 * correctly: it was made after everything shown.
 */
export function placeBlockNote(
  outline: readonly OutlineItem[],
  note: BlockReasonNote | null | undefined,
): Line[] {
  const lines: Line[] = outline.map((item) => ({ kind: "message", item }));
  if (note === null || note === undefined) return lines;
  let seen = 0;
  for (const [index, item] of outline.entries()) {
    if (item.role !== "user") continue;
    if (seen === note.userMessagesSeen) {
      lines.splice(index, 0, { kind: "note" });
      return lines;
    }
    seen += 1;
  }
  lines.push({ kind: "note" });
  return lines;
}

/** A date the model can quote back, without a time it would misread. */
function noteDate(recordedAt: number): string {
  return new Date(recordedAt).toISOString().slice(0, 10);
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
export function selectOutline<T>(
  outline: readonly T[],
): { items: T[]; elided: number } {
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
        // Only the fields that should hold still from one summary to the next.
        // `nextStep`, `blockedOn` and the status are left out: they describe
        // where the thread stands *now*, and handed back as a starting point
        // they survive the turns that made them obsolete — a step the agent
        // has since retired, a rollout that has since finished.
        "Previous brief (update it; keep what is still true, correct what is not):",
        // Fed back so the name only moves when the work moved. Without it the
        // model renames from scratch every summary and a settled thread
        // wobbles between synonyms in the sidebar.
        `  title: ${previous.title || "(empty)"}`,
        `  goal: ${previous.goal || "(empty)"}`,
        `  currentState: ${previous.currentState || "(empty)"}`,
        `  constraints: ${previous.constraints || "(empty)"}`,
      ].join("\n"),
    );
  }

  const note = input.blockReason ?? null;
  const placed = placeBlockNote(input.outline, note);
  let { items, elided } = selectOutline(placed);
  // The note is a line the prompt refers to by name, so it must survive
  // elision. One that fell in the elided middle is re-placed at the cut: it
  // was made after the head and before the tail, which is all the cut says.
  if (note !== null && !items.some((line) => line.kind === "note")) {
    items = [
      ...items.slice(0, HEAD_ITEMS),
      { kind: "note" },
      ...items.slice(HEAD_ITEMS),
    ];
  }
  const lines: string[] = [];
  items.forEach((line, index) => {
    if (elided > 0 && index === HEAD_ITEMS) {
      lines.push(`[… ${elided} earlier messages elided …]`);
    }
    if (line.kind === "note") {
      // Only reached with a note held; the guard above is what makes the
      // non-null assertion safe, and it is kept out of the type to keep
      // `Line` free of the note's payload.
      const held = note as BlockReasonNote;
      lines.push(
        `[${BLOCK_NOTE_MARKER}, recorded ${noteDate(
          held.recordedAt,
        )}: this thread is blocked because "${clamp(held.text, PREVIEW_CHARS)}"]`,
      );
      return;
    }
    const speaker = line.item.role === "user" ? "User" : "Agent";
    lines.push(`${speaker}: ${clamp(line.item.preview, PREVIEW_CHARS)}`);
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
