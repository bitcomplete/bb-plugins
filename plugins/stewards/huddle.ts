// BB-300 slice 3: the huddle's brain. A huddle is a spoken stand-up between
// the owner and one project's stewards. This module builds the model's
// instructions from a `Briefing`, declares the fixed tool set the model may
// call, and runs a tool call. It is deliberately pure where it can be: the
// readers are injected, so the whole tool surface can be tested without a
// store, a network or OpenAI.
//
// "Nothing is acted on while you talk" holds by construction, not by prompt:
// every tool here reads state, and the only two that write append to or remove
// from the huddle's own note record. No tool touches a binding, a need, an
// escalation, a merge or a resolution. The page applies confirmed notes in a
// later slice (the fan-out), through the paths it already uses.
import type { Briefing } from "./nightly.js";
import type { Binding, Escalation, Lesson } from "./store.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { GuidanceUnit } from "./guidance.js";

/** One function tool, shaped the way the Realtime API's `realtime.open` expects. */
export type HuddleTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** The fixed shapes a typed note may take, plus a free note (BB-300). */
export const HUDDLE_NOTE_TYPES = ["resolve-escalation", "gate", "guidance", "direction", "standing-rule", "free"] as const;
export type HuddleNoteType = (typeof HUDDLE_NOTE_TYPES)[number];

/** What one note in the huddle record is: an action item in a typed shape, or a free note. */
export type HuddleNote = {
  id: string;
  type: HuddleNoteType;
  /** The note in the owner's words. */
  text: string;
  /** The binding key the note is about, for a gate item or per-binding guidance. */
  binding: string | null;
  /** The escalation id the note resolves, for `resolve-escalation`. */
  escalation: string | null;
  /** The gate action, for a `gate` note. */
  action: "approve" | "decline" | "merge" | null;
  createdAt: number;
};

/** The huddle's in-memory record. Slice 4 makes it durable and reads it back. */
export type HuddleRecord = {
  projectId: string;
  startedAt: number;
  notes: HuddleNote[];
  /** True once the overlay has connected and the model has called a tool. */
  connected: boolean;
};

/** The voice plugin's own `realtime.open` instruction cap; the briefing stays under it. */
export const HUDDLE_MAX_INSTRUCTIONS_CHARS = 20_000;
/** The most lines one section lists before it says how many were left out. */
export const HUDDLE_SECTION_MAX = 40;

/** The only tools that write, and they write only to the huddle record. */
export const HUDDLE_WRITE_TOOLS: ReadonlySet<string> = new Set(["take_note", "retract_note"]);

const stringParam = (description: string): Record<string, unknown> => ({ type: "string", description });

/**
 * The fixed, small tool set the huddle opens with. The names are the contract
 * the tests enumerate; the readers behind them are in `runHuddleTool`.
 */
export const HUDDLE_TOOLS: HuddleTool[] = [
  {
    name: "steward_status",
    description: "The status of one steward, by its ticket or pull-request key (for example ENG-12 or owner/repo#34): phase, what it waits on, the guidance it carries, its open escalation and its recent notes.",
    parameters: {
      type: "object",
      properties: { key: stringParam("The steward's ticket or pull-request key.") },
      required: ["key"],
    },
  },
  {
    name: "escalation",
    description: "One escalation in full: its question, context, fixed choices, what happens meanwhile and the project steward's recommendation. Give a binding key to list that steward's open escalations, or an escalation id.",
    parameters: {
      type: "object",
      properties: {
        key: stringParam("A ticket or pull-request key whose open escalations to read."),
        escalationId: stringParam("An escalation id (esc_…) to read directly."),
      },
      required: [],
    },
  },
  {
    name: "entity_snapshot",
    description: "The ticket or pull request itself, through the source snapshot the stewards already read: title, state, labels, author and body.",
    parameters: {
      type: "object",
      properties: { key: stringParam("The ticket or pull-request key.") },
      required: ["key"],
    },
  },
  {
    name: "decision_rationale",
    description: "The reasoning behind decisions about one steward: the lessons recorded from its escalations, with the resolution and citations that produced them.",
    parameters: {
      type: "object",
      properties: { key: stringParam("The ticket or pull-request key.") },
      required: ["key"],
    },
  },
  {
    name: "playbook_paragraph",
    description: "A paragraph of the project's playbooks or AGENTS.md, exactly as written. Give a query to search the text, or a file (such as AGENTS.md or stewards/linear-tickets.md) to read that file's paragraphs.",
    parameters: {
      type: "object",
      properties: {
        query: stringParam("Words to find in the guidance."),
        file: stringParam("A .bb-relative file to read, such as AGENTS.md."),
      },
      required: [],
    },
  },
  {
    name: "take_note",
    description: "Record an action item for the owner to confirm after the huddle, or a free note. This writes only to the huddle record; it never acts on a steward, merges or resolves anything.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...HUDDLE_NOTE_TYPES], description: "resolve-escalation, gate, guidance, direction, standing-rule, or free." },
        text: stringParam("The note, in the owner's words."),
        binding: stringParam("The ticket or pull-request key a gate or guidance note is about."),
        escalationId: stringParam("The escalation id a resolve-escalation note answers."),
        action: { type: "string", enum: ["approve", "decline", "merge"], description: "For a gate note: the action the owner wants taken." },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "retract_note",
    description: "Remove a note the huddle recorded, by its id. This writes only to the huddle record.",
    parameters: {
      type: "object",
      properties: { id: stringParam("The note id (note_…) to remove.") },
      required: ["id"],
    },
  },
];

/** The tool names, in declaration order. */
export const HUDDLE_TOOL_NAMES: readonly string[] = HUDDLE_TOOLS.map((tool) => tool.name);

/** The reader and record a tool call runs against; the server injects the real ones. */
export type HuddleToolContext = {
  projectId: string;
  now: () => number;
  /** The binding for a key (or id), open first, or null. */
  binding: (key: string) => Binding | null;
  /** A binding's open escalations. */
  openEscalations: (bindingId: string) => Escalation[];
  /** One escalation by id, or null. */
  escalation: (id: string) => Escalation | null;
  /** A binding's recorded lessons, whatever their tier. */
  lessons: (bindingId: string) => Lesson[];
  /** The hand-written guidance at `.bb` HEAD. */
  guidance: () => Promise<GuidanceUnit[]>;
  /** The entity snapshot for a binding, read fresh when the source answers. */
  snapshot: (binding: Binding) => Promise<EntitySnapshot | null>;
  /** The huddle's note record. Only `take_note` and `retract_note` touch it. */
  record: HuddleRecord;
};

/** One line for a note's kind, so a note reads back unambiguously. */
const NOTE_LABEL: Record<HuddleNoteType, string> = {
  "resolve-escalation": "resolve an escalation",
  gate: "approve or decline a gate item",
  guidance: "guidance for a binding",
  direction: "direction for the project",
  "standing-rule": "a standing rule",
  free: "a note",
};

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The steward's own status line, or a clear "no such steward" the model can read aloud. */
function stewardStatus(ctx: HuddleToolContext, key: string): string {
  const b = ctx.binding(key);
  if (b === null) return `No steward for ${key} in this project.`;
  const lines = [`${b.entityKey}: ${b.title ?? "(no title)"} — ${b.kind}${b.phase === null ? "" : `, phase ${b.phase}`}.`];
  lines.push(`Waiting on: ${b.status?.waitingOn ?? (b.hold === null ? "nothing the plugin tracks" : `hold: ${b.hold}`)}`);
  lines.push(`Guidance carried: ${b.guidance.length === 0 ? "none" : b.guidance.slice(-5).map((g) => g.text).join(" | ")}`);
  const open = ctx.openEscalations(b.id);
  lines.push(`Open escalation: ${open.length === 0 ? "none" : open.map((x) => `${x.kind}: ${x.question}`).join(" | ")}`);
  lines.push(`Recent notes: ${b.pending.length === 0 ? "none" : b.pending.slice(-5).map((n) => n.text).join(" | ")}`);
  return lines.join("\n");
}

/** One escalation in full: what it asks, the choices, the meanwhile and the recommendation. */
function escalationText(x: Escalation): string {
  const lines = [`${x.id} (${x.kind}${x.route === "user" ? ", with you" : ""}): ${x.question}`];
  if (x.context !== null) lines.push(`Context: ${x.context}`);
  if (x.choices.length > 0) lines.push(`Choices: ${x.choices.join(" / ")}`);
  if (x.meanwhile !== "") lines.push(`Meanwhile: ${x.meanwhile}`);
  if (x.recommendation !== null) lines.push(`The project steward recommends: ${x.recommendation}`);
  return lines.join("\n");
}

/** The escalation tool: by id, or every open escalation for one binding key. */
function escalationTool(ctx: HuddleToolContext, args: Record<string, unknown>): string {
  const id = optionalString(args, "escalationId");
  if (id !== null) {
    const x = ctx.escalation(id);
    return x === null ? `No escalation ${id} in this project.` : escalationText(x);
  }
  const key = optionalString(args, "key");
  if (key === null) throw new Error("Give a binding key or an escalationId");
  const b = ctx.binding(key);
  if (b === null) return `No steward for ${key} in this project.`;
  const open = ctx.openEscalations(b.id);
  if (open.length === 0) return `${b.entityKey} has no open escalation.`;
  return open.map(escalationText).join("\n\n");
}

/** The entity tool: the source snapshot, or the last one the steward kept. */
async function entityTool(ctx: HuddleToolContext, key: string): Promise<string> {
  const b = ctx.binding(key);
  if (b === null) return `No steward for ${key} in this project.`;
  const entity = (await ctx.snapshot(b).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
  if (entity === null) return `No snapshot is available for ${key}.`;
  const lines = [`${entity.key}: ${entity.title ?? "(no title)"}`];
  lines.push(`State: ${entity.state ?? "unknown"}${entity.labels.length === 0 ? "" : ` · labels: ${entity.labels.join(", ")}`}`);
  if (entity.author !== null) lines.push(`Author: ${entity.author}`);
  if (entity.description !== null && entity.description.trim() !== "") lines.push(entity.description.trim());
  return lines.join("\n");
}

/** The rationale tool: the lessons and resolutions behind a binding's decisions. */
function rationaleTool(ctx: HuddleToolContext, key: string): string {
  const b = ctx.binding(key);
  if (b === null) return `No steward for ${key} in this project.`;
  const lessons = ctx.lessons(b.id);
  const parts: string[] = [];
  if (lessons.length === 0) parts.push(`No lesson is recorded for ${b.entityKey}.`);
  else parts.push(lessons.map((l) => `${l.id} (${l.scope}, ${l.tier}): ${l.text}`).join("\n"));
  // The binding's guidance is the owner's own reasoning carried forward.
  if (b.guidance.length > 0) parts.push(`Guidance carried: ${b.guidance.map((g) => `${g.text} (${g.by})`).join(" | ")}`);
  return parts.join("\n");
}

/** The playbook tool: the guidance paragraphs, filtered by file or query. */
async function playbookTool(ctx: HuddleToolContext, args: Record<string, unknown>): Promise<string> {
  const file = optionalString(args, "file");
  const query = optionalString(args, "query");
  const units = await ctx.guidance();
  const needle = query === null ? null : query.toLowerCase();
  const matches = units.filter((u) => (file === null || u.file === file) && (needle === null || `${u.heading ?? ""}\n${u.text}`.toLowerCase().includes(needle)));
  if (matches.length === 0) {
    const where = file === null ? "" : ` in ${file}`;
    const what = query === null ? "" : ` matching ${JSON.stringify(query)}`;
    return `No guidance paragraph${where}${what} at .bb HEAD.`;
  }
  return matches
    .slice(0, 12)
    .map((u) => `${u.file}${u.heading === null ? "" : ` — ${u.heading}`}:\n${u.text}`)
    .join("\n\n");
}

/** Append a typed or free note to the record; the only write in the read tool set. */
function takeNote(ctx: HuddleToolContext, args: Record<string, unknown>): string {
  const type = requireString(args, "type");
  if (!(HUDDLE_NOTE_TYPES as readonly string[]).includes(type)) throw new Error(`type must be one of ${HUDDLE_NOTE_TYPES.join(", ")}`);
  const text = requireString(args, "text");
  const action = optionalString(args, "action");
  if (action !== null && !["approve", "decline", "merge"].includes(action)) throw new Error("action must be approve, decline or merge");
  const note: HuddleNote = {
    id: `note_${crypto.randomUUID()}`,
    type: type as HuddleNoteType,
    text,
    binding: optionalString(args, "binding"),
    escalation: optionalString(args, "escalationId"),
    action: action as HuddleNote["action"],
    createdAt: ctx.now(),
  };
  ctx.record.notes.push(note);
  return `Noted (${NOTE_LABEL[note.type]}, ${note.id}): ${note.text}`;
}

/** Remove a note from the record; the second and last write. */
function retractNote(ctx: HuddleToolContext, args: Record<string, unknown>): string {
  const id = requireString(args, "id");
  const index = ctx.record.notes.findIndex((n) => n.id === id);
  if (index === -1) return `No note ${id} in this huddle.`;
  const [removed] = ctx.record.notes.splice(index, 1);
  return `Retracted ${id}: ${removed!.text}`;
}

/**
 * Run one model tool call against the injected readers. A read tool returns
 * text and never writes; `take_note` and `retract_note` return text and touch
 * only `ctx.record.notes`.
 */
export async function runHuddleTool(name: string, args: Record<string, unknown>, ctx: HuddleToolContext): Promise<string> {
  switch (name) {
    case "steward_status":
      return stewardStatus(ctx, requireString(args, "key"));
    case "escalation":
      return escalationTool(ctx, args);
    case "entity_snapshot":
      return entityTool(ctx, requireString(args, "key"));
    case "decision_rationale":
      return rationaleTool(ctx, requireString(args, "key"));
    case "playbook_paragraph":
      return playbookTool(ctx, args);
    case "take_note":
      return takeNote(ctx, args);
    case "retract_note":
      return retractNote(ctx, args);
    default:
      throw new Error(`No huddle tool named ${name}`);
  }
}

/** One "- " bullet per item, or a single "(none)" line. */
function bullets(lines: readonly string[]): string {
  return lines.length === 0 ? "- (none)" : lines.map((line) => `- ${line}`).join("\n");
}

/** An open question put to the owner, with the binding it attaches to resolved to a key. */
export type HuddleOpenQuestion = { key: string | null; question: string; choices: string[] };

/** The owner's decisions, as one line each: needs, forwarded escalations and open questions. */
function decisionLines(briefing: Briefing, questions: readonly HuddleOpenQuestion[]): string[] {
  const out: string[] = [];
  for (const { need, binding } of briefing.decisions.needs) out.push(`${binding.entityKey}: ${need.what} (${need.kind})`);
  for (const { escalation, from } of briefing.decisions.withUser) out.push(`${from.entityKey}: ${escalation.question}${escalation.recommendation === null ? "" : ` — recommendation: ${escalation.recommendation}`}`);
  // The briefing's `withUser` leaves questions to the digest's own section
  // (slice 1); the huddle is exactly where the owner answers them, so they are
  // added here as decisions rather than dropped.
  for (const q of questions) out.push(`${q.key ?? "the project"}: ${q.question}${q.choices.length === 0 ? "" : ` (choices: ${q.choices.join(" / ")})`}`);
  return out;
}

/** The project steward's escalations, as one line each. */
function projectEscalationLines(briefing: Briefing): string[] {
  return briefing.escalations.map(({ escalation, from }) => `${from.entityKey}: ${escalation.question}${escalation.recommendation === null ? "" : ` — recommendation: ${escalation.recommendation}`}`);
}

/** The stuck and held bindings, as one line each. */
function stuckLines(briefing: Briefing): string[] {
  const out: string[] = [];
  for (const { escalation, from } of briefing.stuck.stuck) out.push(`${from.entityKey}: stuck — ${escalation.question}`);
  for (const { escalation, from } of briefing.stuck.stall) out.push(`${from.entityKey}: stalled — ${escalation.question}`);
  for (const b of briefing.stuck.held) out.push(`${b.entityKey}: on hold${b.hold === null ? "" : ` — ${b.hold}`}${b.holdBehind.length === 0 ? "" : ` (behind ${b.holdBehind.join(", ")})`}`);
  for (const b of briefing.stuck.noWakeSource) out.push(`${b.entityKey}: waiting with nothing the plugin tracks to wake it`);
  for (const b of briefing.stuck.datedWaits) out.push(`${b.entityKey}: waiting until ${b.requeueUntil === null ? "?" : new Date(b.requeueUntil).toISOString()}`);
  return out;
}

/** What moved, ended and was answered since, with the deviations called out. */
function doneLines(briefing: Briefing): string[] {
  const out: string[] = [];
  for (const b of briefing.done.moved) out.push(`${b.entityKey}: moved${b.status?.summary === null || b.status?.summary === undefined ? "" : ` — ${b.status.summary}`}`);
  for (const b of briefing.done.ended) out.push(`${b.entityKey}: ended${b.endReason === null ? "" : ` (${b.endReason})`}`);
  for (const q of briefing.done.answered) out.push(`answered: ${q.question}`);
  return out;
}

/** Open assumptions, called out as the approach that departed from the written playbook. */
function deviationLines(briefing: Briefing): string[] {
  return briefing.assumptions.map(({ assumption, binding }) => `${binding === null ? "project" : binding.entityKey}: assuming ${assumption.text}${assumption.context === null ? "" : ` — ${assumption.context}`}`);
}

/**
 * The session instructions: the briefing, ranked decisions first, then the
 * project steward's escalations, then what is stuck or held, then what got
 * done since, with playbook deviations called out. The model may ask follow-up
 * questions with the read tools and take or retract notes, and nothing else.
 *
 * The text is bounded twice: each section lists at most `HUDDLE_SECTION_MAX`
 * lines (then says how many it left out), and the whole text is kept under the
 * voice plugin's `realtime.open` cap. The ranking survives truncation: the
 * sections stay in order and the tail gives way first.
 */
export function buildHuddleInstructions(briefing: Briefing, projectName: string, now: number, questions: readonly HuddleOpenQuestion[] = []): string {
  const since = briefing.since === 0 ? "the beginning" : new Date(briefing.since).toISOString();
  const header = [
    `You are the voice of ${projectName}'s stewards in a huddle with the project's owner.`,
    `It is ${new Date(now).toISOString()}. You are reporting what happened since ${since}.`,
    "",
    "Lead with the things only the owner can unblock, then what is stuck, then what got done and how it was approached.",
    "You may read state with the tools you have been given, and you may take or retract notes. You cannot act on a steward, merge, resolve or change anything; the owner confirms notes after the huddle.",
    "When the owner decides something, take a note in the matching shape (resolve an escalation, a gate item, guidance for a binding, direction for the project, or a standing rule) and read it back in their words. A remark that is not a decision is a free note.",
  ];
  const sections = [
    { heading: "Decisions waiting on the owner", lines: decisionLines(briefing, questions) },
    { heading: "Escalations with the project steward", lines: projectEscalationLines(briefing) },
    { heading: "Stuck or held", lines: stuckLines(briefing) },
    { heading: "Done since", lines: doneLines(briefing) },
    { heading: "Approaches that departed from the written playbook", lines: deviationLines(briefing) },
  ];
  const capped = sections.map((section) => ({
    heading: section.heading,
    lines: section.lines.length <= HUDDLE_SECTION_MAX ? section.lines : [...section.lines.slice(0, HUDDLE_SECTION_MAX), `…and ${section.lines.length - HUDDLE_SECTION_MAX} more`],
  }));
  const render = (): string => [...header, ...capped.flatMap((section) => ["", `## ${section.heading}`, bullets(section.lines)])].join("\n");
  while (render().length > HUDDLE_MAX_INSTRUCTIONS_CHARS) {
    const last = [...capped].reverse().find((section) => section.lines.length > 0);
    if (last === undefined) break;
    last.lines.pop();
  }
  const text = render();
  return text.length <= HUDDLE_MAX_INSTRUCTIONS_CHARS ? text : `${text.slice(0, HUDDLE_MAX_INSTRUCTIONS_CHARS - 20)}\n… (truncated)`;
}
