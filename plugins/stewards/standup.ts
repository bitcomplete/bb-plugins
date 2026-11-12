// BB-300 slice 3: the stand-up's brain. A stand-up is a spoken stand-up between
// the owner and one project's stewards. This module builds the model's
// instructions from a `Briefing`, declares the fixed tool set the model may
// call, and runs a tool call. It is deliberately pure where it can be: the
// readers are injected, so the whole tool surface can be tested without a
// store, a network or OpenAI.
//
// "Nothing is acted on while you talk" holds by construction, not by prompt:
// every tool here reads state, and the only two that write append to or remove
// from the stand-up's own note record. No tool touches a binding, a need, an
// escalation, a merge or a resolution. The page applies confirmed notes in a
// later slice (the fan-out), through the paths it already uses.
import type { Briefing } from "./nightly.js";
import type { Binding, Escalation, Lesson, Need } from "./store.js";
import type { EntitySnapshot } from "./source-contract.js";
import type { GuidanceUnit } from "./guidance.js";

/** One function tool, shaped the way the Realtime API's `realtime.open` expects. */
export type StandupTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * What a tool returns: the text the model reads, or a reply that also says the
 * model's response to it is its last, so the overlay stops after the goodbye.
 */
export type StandupToolReply = { output: string; last?: boolean };

/**
 * The result of an `end_standup` call, for the server and the tests: what was
 * applied, and what was skipped with why (a note that is not a typed note of
 * this stand-up, a free note, an already-confirmed note, or a merge the
 * blanket yes must not carry).
 */
export type StandupEndOutcome = {
  output: string;
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  /**
   * False when the model should retry (another confirm is already running), so
   * the overlay must not close. Default true.
   */
  last?: boolean;
};

/** The fixed shapes a typed note may take, plus a free note (BB-300). */
export const STANDUP_NOTE_TYPES = ["resolve-escalation", "gate", "guidance", "direction", "standing-rule", "free"] as const;
export type StandupNoteType = (typeof STANDUP_NOTE_TYPES)[number];

/** What one note in the stand-up record is: an action item in a typed shape, or a free note. */
export type StandupNote = {
  id: string;
  type: StandupNoteType;
  /** The note in the owner's words. */
  text: string;
  /** The binding key the note is about, for a gate item or per-binding guidance. */
  binding: string | null;
  /** The escalation id the note resolves, for `resolve-escalation`. */
  escalation: string | null;
  /** The gate action, for a `gate` note. */
  action: "approve" | "decline" | "merge" | null;
  /**
   * The one need a `gate` note acts on (BB-300 slice 4). Bound when the note is
   * taken, so a binding with several open gate items never applies the wrong
   * one, and confirmed only while that need is still open.
   */
  need: string | null;
  /** The bound need's own description, for the readback line. */
  needLabel: string | null;
  createdAt: number;
};

/** The stand-up's in-memory record. Slice 4 makes it durable and reads it back. */
export type StandupRecord = {
  projectId: string;
  startedAt: number;
  notes: StandupNote[];
  /** True once the overlay has connected and the model has called a tool. */
  connected: boolean;
};

/** The voice plugin's own `realtime.open` instruction cap; the briefing stays under it. */
export const STANDUP_MAX_INSTRUCTIONS_CHARS = 20_000;
/** The most lines one section lists before it says how many were left out. */
export const STANDUP_SECTION_MAX = 40;

/** The only tools that write, and they write only to the stand-up record. */
export const STANDUP_WRITE_TOOLS: ReadonlySet<string> = new Set(["take_note", "retract_note"]);

const stringParam = (description: string): Record<string, unknown> => ({ type: "string", description });

/**
 * The fixed, small tool set the stand-up opens with. The names are the contract
 * the tests enumerate; the readers behind them are in `runStandupTool`.
 */
export const STANDUP_TOOLS: StandupTool[] = [
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
    name: "readback",
    description: "Read the current stand-up notes back in the server's own mechanical words, one line each with its note id. Read-only: it writes nothing and acts on nothing. Call it before asking the owner to confirm.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "take_note",
    description: "Record an action item for the owner to confirm after the stand-up, or a free note. This writes only to the stand-up record; it never acts on a steward, merges or resolves anything.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...STANDUP_NOTE_TYPES], description: "resolve-escalation, gate, guidance, direction, standing-rule, or free." },
        text: stringParam("The note, in the owner's words."),
        binding: stringParam("The ticket or pull-request key a gate or guidance note is about."),
        escalationId: stringParam("The escalation id a resolve-escalation note answers."),
        action: { type: "string", enum: ["approve", "decline", "merge"], description: "For a gate note: the action the owner wants taken." },
        need: stringParam("For a gate note: the need id or the pull request URL of the exact item to act on. Required when the binding has more than one open item of that kind."),
      },
      required: ["type", "text"],
    },
  },
  {
    name: "retract_note",
    description: "Remove a note the stand-up recorded, by its id. This writes only to the stand-up record.",
    parameters: {
      type: "object",
      properties: { id: stringParam("The note id (note_…) to remove.") },
      required: ["id"],
    },
  },
  {
    name: "end_standup",
    description: "End the stand-up after the owner has clearly confirmed the notes. Give the ids of the typed notes they agreed to; the server applies each through the same path the page's Confirm button uses, wakes the project steward, records the confirmation as confirmed by voice, and closes the voice session. Only call it after a readback and a clear yes. Merge items are never applied here; they stay for the page's Confirm button.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "The note ids (note_…) the owner clearly confirmed.",
        },
      },
      required: ["ids"],
    },
  },
];

/** The tool names, in declaration order. */
export const STANDUP_TOOL_NAMES: readonly string[] = STANDUP_TOOLS.map((tool) => tool.name);

/** The reader and record a tool call runs against; the server injects the real ones. */
export type StandupToolContext = {
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
  /** A binding's open "needs you" items, so a gate note binds to exactly one (BB-300 slice 4). */
  needs: (bindingId: string) => Need[];
  /** The note ids the owner has already confirmed; a confirmed note cannot be retracted. */
  confirmed: readonly string[];
  /**
   * Apply the ids the owner confirmed through the same paths the page's
   * Confirm uses, then end the stand-up. The only tool that acts outside the
   * record; it is injected so the tool set stays testable without a store.
   */
  endStandup: (ids: string[]) => Promise<StandupEndOutcome>;
  /** The stand-up's note record. Only `take_note` and `retract_note` touch it. */
  record: StandupRecord;
};

/** One line for a note's kind, so a note reads back unambiguously. */
const NOTE_LABEL: Record<StandupNoteType, string> = {
  "resolve-escalation": "resolve an escalation",
  gate: "approve or decline a gate item",
  guidance: "guidance for a binding",
  direction: "direction for the project",
  "standing-rule": "a standing rule",
  free: "a note",
};

/**
 * BB-300 slice 4: one typed note as a mechanical readback line. The page
 * renders these from the stored notes; the model only reads them aloud, it
 * does not compose them. A free note reads back as a plain note so it is never
 * mistaken for a typed action item.
 */
export function readbackLine(note: StandupNote): string {
  const where = note.binding === null ? "" : ` ${note.binding}`;
  switch (note.type) {
    case "resolve-escalation":
      return `Resolve escalation ${note.escalation ?? "(none)"} with: ${note.text}`;
    case "gate": {
      const action = note.action === "merge" ? "Merge" : note.action === "decline" ? "Decline" : "Approve";
      return `${action}${where}${note.needLabel === null ? "" : ` (${note.needLabel})`}: ${note.text}`;
    }
    case "guidance":
      return `Guidance for${where}: ${note.text}`;
    case "direction":
      return `Project direction: ${note.text}`;
    case "standing-rule":
      return `Standing rule: ${note.text}`;
    default:
      return `Note: ${note.text}`;
  }
}

/** The readback lines for a record's notes, in the order they were taken. */
export function readbackLines(notes: readonly StandupNote[]): string[] {
  return notes.map(readbackLine);
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A list of non-empty strings, each trimmed, or an error naming the field. */
function requireStringArray(args: Record<string, unknown>, field: string): string[] {
  const value = args[field];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of note ids`);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") throw new Error(`${field} must contain note ids`);
    return item.trim();
  });
}

/** The steward's own status line, or a clear "no such steward" the model can read aloud. */
function stewardStatus(ctx: StandupToolContext, key: string): string {
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
function escalationTool(ctx: StandupToolContext, args: Record<string, unknown>): string {
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
async function entityTool(ctx: StandupToolContext, key: string): Promise<string> {
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
function rationaleTool(ctx: StandupToolContext, key: string): string {
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
async function playbookTool(ctx: StandupToolContext, args: Record<string, unknown>): Promise<string> {
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

/** The gate kinds a note's action applies to, so a gate note binds to one open need. */
function gateKinds(action: string | null): string[] {
  if (action === "merge") return ["merge"];
  return ["approve-spec", "approve-pr"];
}

/**
 * Resolve the one open need a gate note acts on. The caller may name it by id,
 * URL or description; otherwise it must be unambiguous. Throws with the
 * candidates when it is not, so the model can ask the owner which one.
 */
function gateNeed(ctx: StandupToolContext, binding: Binding, action: string | null, wanted: string | null): Need {
  const candidates = ctx.needs(binding.id).filter((n) => gateKinds(action).includes(n.kind));
  if (candidates.length === 0) throw new Error(`No open ${action ?? "gate"} item on ${binding.entityKey}`);
  if (wanted !== null) {
    const match = candidates.find((n) => n.id === wanted || n.url === wanted || n.what === wanted);
    if (match === undefined) throw new Error(`No open gate item on ${binding.entityKey} matches ${JSON.stringify(wanted)}`);
    return match;
  }
  if (candidates.length > 1) throw new Error(`${binding.entityKey} has several open gate items; name the exact one: ${candidates.map((n) => `${n.id} (${n.what})`).join(", ")}`);
  return candidates[0]!;
}

/** Append a typed or free note to the record; the only write in the read tool set. */
function takeNote(ctx: StandupToolContext, args: Record<string, unknown>): string {
  const type = requireString(args, "type");
  if (!(STANDUP_NOTE_TYPES as readonly string[]).includes(type)) throw new Error(`type must be one of ${STANDUP_NOTE_TYPES.join(", ")}`);
  const text = requireString(args, "text");
  const action = optionalString(args, "action");
  if (action !== null && !["approve", "decline", "merge"].includes(action)) throw new Error("action must be approve, decline or merge");
  const bindingKey = optionalString(args, "binding");
  // A gate note is bound to exactly one open need when it is taken, so a
  // binding with several open items can never apply the wrong one later.
  let need: string | null = null;
  let needLabel: string | null = null;
  if (type === "gate") {
    if (bindingKey === null) throw new Error("a gate note needs a binding");
    const binding = ctx.binding(bindingKey);
    if (binding === null) throw new Error(`No steward for ${bindingKey}`);
    const item = gateNeed(ctx, binding, action, optionalString(args, "need"));
    need = item.id;
    needLabel = item.what;
  }
  const note: StandupNote = {
    id: `note_${crypto.randomUUID()}`,
    type: type as StandupNoteType,
    text,
    binding: bindingKey,
    escalation: optionalString(args, "escalationId"),
    action: action as StandupNote["action"],
    need,
    needLabel,
    createdAt: ctx.now(),
  };
  ctx.record.notes.push(note);
  return `Noted (${NOTE_LABEL[note.type]}, ${note.id}): ${note.text}`;
}

/** Remove a note from the record; the second and last write. A confirmed note stays. */
function retractNote(ctx: StandupToolContext, args: Record<string, unknown>): string {
  const id = requireString(args, "id");
  if (ctx.confirmed.includes(id)) return `Note ${id} has already been applied and cannot be retracted.`;
  const index = ctx.record.notes.findIndex((n) => n.id === id);
  if (index === -1) return `No note ${id} in this stand-up.`;
  const [removed] = ctx.record.notes.splice(index, 1);
  return `Retracted ${id}: ${removed!.text}`;
}

/**
 * Run one model tool call against the injected readers. A read tool returns
 * text and never writes; `take_note` and `retract_note` return text and touch
 * only `ctx.record.notes`; `end_standup` is the one tool that applies the
 * confirmed notes and ends the stand-up, through its injected callback.
 */
export async function runStandupTool(name: string, args: Record<string, unknown>, ctx: StandupToolContext): Promise<string | StandupToolReply> {
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
    case "readback":
      return readbackTool(ctx);
    case "take_note":
      return takeNote(ctx, args);
    case "retract_note":
      return retractNote(ctx, args);
    case "end_standup": {
      const outcome = await ctx.endStandup(requireStringArray(args, "ids"));
      // The opener's reply carries `last`, so the overlay lets the model's
      // goodbye finish and then closes the session itself. A busy retry says
      // `last: false` so the model can try again instead of the session ending.
      return { output: outcome.output, last: outcome.last ?? true };
    }
    default:
      throw new Error(`No stand-up tool named ${name}`);
  }
}

/** The mechanical readback lines, each with its note id so the model can confirm it. */
function readbackTool(ctx: StandupToolContext): string {
  if (ctx.record.notes.length === 0) return "No notes have been taken in this stand-up yet.";
  return ctx.record.notes.map((note) => `${readbackLine(note)} (id ${note.id})`).join("\n");
}

/**
 * One "- " bullet per item. An empty section says "(none)" only when it was
 * empty to begin with; one the length loop emptied says so instead, so a
 * section that had items never reads as if there were none.
 */
function bullets(lines: readonly string[], truncated = false): string {
  if (lines.length === 0) return truncated ? "- (omitted to fit the briefing limit)" : "- (none)";
  return lines.map((line) => `- ${line}`).join("\n");
}

/** An open question put to the owner, with the binding it attaches to resolved to a key. */
export type StandupOpenQuestion = { key: string | null; question: string; choices: string[] };

/** The owner's decisions, as one line each: needs, forwarded escalations and open questions. */
function decisionLines(briefing: Briefing, questions: readonly StandupOpenQuestion[]): string[] {
  const out: string[] = [];
  for (const { need, binding } of briefing.decisions.needs) out.push(`${binding.entityKey}: ${need.what} (${need.kind})`);
  for (const { escalation, from } of briefing.decisions.withUser) out.push(`${from.entityKey}: ${escalation.question}${escalation.recommendation === null ? "" : ` — recommendation: ${escalation.recommendation}`}`);
  // The briefing's `withUser` leaves questions to the digest's own section
  // (slice 1); the stand-up is exactly where the owner answers them, so they are
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
 * The text is bounded twice: each section lists at most `STANDUP_SECTION_MAX`
 * lines (then says how many it left out), and the whole text is kept under the
 * voice plugin's `realtime.open` cap. The ranking survives truncation: the
 * sections stay in order and the tail gives way first.
 */
export function buildStandupInstructions(briefing: Briefing, projectName: string, now: number, questions: readonly StandupOpenQuestion[] = []): string {
  const since = briefing.since === 0 ? "the beginning" : new Date(briefing.since).toISOString();
  const header = [
    `You are the voice of ${projectName}'s stewards in a stand-up with the project's owner.`,
    `It is ${new Date(now).toISOString()}. You are reporting what happened since ${since}.`,
    "",
    "Greet the owner briefly and begin immediately; do not wait for them to speak first.",
    "Lead with the things only the owner can unblock, then what is stuck, then what got done and how it was approached. If nothing is waiting on the owner and nothing is stuck, say so plainly and ask what is on their mind.",
    "You may read state with the tools you have been given, and you may take or retract notes. You cannot act on a steward, merge, resolve or change anything; the owner confirms notes after the stand-up.",
    "When the owner decides something, take a note in the matching shape (resolve an escalation, a gate item, guidance for a binding, direction for the project, or a standing rule) and read it back in their words. A remark that is not a decision is a free note.",
    "To close: call readback and read every line aloud in the server's own words, then ask the owner to confirm. Retract any note they reject, read the changed list back again, and only then call end_standup with the ids they clearly agreed to. Never end without a readback, and treat anything short of a clear yes as no confirmation.",
    "A merge gate item is never applied by end_standup: read it aloud on its own and tell the owner it stays for the page's Confirm button.",
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
    lines: section.lines.length <= STANDUP_SECTION_MAX ? section.lines : [...section.lines.slice(0, STANDUP_SECTION_MAX), `…and ${section.lines.length - STANDUP_SECTION_MAX} more`],
    truncated: section.lines.length > STANDUP_SECTION_MAX,
  }));
  const render = (): string => [...header, ...capped.flatMap((section) => ["", `## ${section.heading}`, bullets(section.lines, section.truncated)])].join("\n");
  while (render().length > STANDUP_MAX_INSTRUCTIONS_CHARS) {
    const last = [...capped].reverse().find((section) => section.lines.length > 0);
    if (last === undefined) break;
    last.lines.pop();
    last.truncated = true;
  }
  const text = render();
  return text.length <= STANDUP_MAX_INSTRUCTIONS_CHARS ? text : `${text.slice(0, STANDUP_MAX_INSTRUCTIONS_CHARS - 20)}\n… (truncated)`;
}
