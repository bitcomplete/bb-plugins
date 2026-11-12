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
import { parsePullRef } from "./github.js";
import { latestReviewMarker } from "./gate.js";
import { redactLine } from "./ops.js";

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
  /** BB-307: every `ask_a_thread` delegation, for the log on the stand-up page. */
  delegations: StandupDelegation[];
};

/** The voice plugin's own `realtime.open` instruction cap; the briefing stays under it. */
export const STANDUP_MAX_INSTRUCTIONS_CHARS = 20_000;
/** The most lines one section lists before it says how many were left out. */
export const STANDUP_SECTION_MAX = 40;
/** The most days an open item may sit before the brief calls it stale (BB-306). */
export const STANDUP_STALE_DAYS = 3;
/** BB-307: how much of a delegate's answer is kept, after `redactLine`'s credential scrub. */
export const STANDUP_DELEGATE_ANSWER_MAX_CHARS = 2_000;
/** How much of a question's context the brief carries (BB-306). */
export const STANDUP_CONTEXT_MAX_CHARS = 300;
/** The most comments `entity_snapshot` renders, newest last (BB-306). */
export const STANDUP_ENTITY_COMMENTS_MAX = 5;
/** How much of one comment body `entity_snapshot` carries (BB-306). */
export const STANDUP_ENTITY_COMMENT_MAX_CHARS = 300;
/** The most children `entity_snapshot` lists before it says how many were left out (BB-306). */
export const STANDUP_ENTITY_CHILDREN_MAX = 10;
/** How much of an entity's body `entity_snapshot` carries (BB-309). */
export const STANDUP_ENTITY_DESCRIPTION_MAX_CHARS = 1_000;
const DAY_MS = 86_400_000;

/** The only tools that write, and they write only to the stand-up record. */
export const STANDUP_WRITE_TOOLS: ReadonlySet<string> = new Set(["take_note", "retract_note"]);

/**
 * BB-307: one `ask_a_thread` delegation, as the stand-up record logs it. The
 * answer is the delegate's own words, scrubbed and capped; a timeout or an
 * error leaves it null and carries why. It is a log, not state any tool acts on.
 */
export type StandupDelegation = {
  question: string;
  /** The steward key the question was about, when one was given. */
  key: string | null;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  /** The delegate's answer, after `redactLine`'s scrub and the length cap. */
  answer: string | null;
  outcome: "success" | "timeout" | "error";
  /** The failure's message for an error, null otherwise. */
  error: string | null;
};

/**
 * What the injected `askThread` returns to the tool. `busy` means a lookup was
 * already in flight for this stand-up; it is a line, not a logged delegation.
 * The answer is raw: the tool scrubs and caps it before it is logged or read.
 */
export type StandupAskOutcome = {
  outcome: "success" | "timeout" | "error" | "busy";
  answer: string | null;
  startedAt: number;
  finishedAt: number;
  error: string | null;
};

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
    description: "The ticket or pull request itself, through the source snapshot the stewards already read: title, state, labels, author, body, the last few comments with their dates, linked pull requests and children.",
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
    name: "ask_a_thread",
    description:
      "Hand one question to a hidden, read-only delegate thread and read its answer back. Use it only for a fact the brief and the other read tools cannot give you, such as whether a build or run is still failing, a ticket that has no steward, or what a file or recent history says. Try steward_status, escalation, entity_snapshot and playbook_paragraph first. The lookup takes up to a minute or two and the owner waits in silence, so ask only when it is warranted.",
    parameters: {
      type: "object",
      properties: {
        question: stringParam("The question to put to the delegate, in full."),
        key: stringParam("The ticket or pull-request key the question is about, when there is one; its steward status is prepended for the delegate."),
      },
      required: ["question"],
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
  /**
   * BB-307: hand a question to the stand-up's delegate and resolve with its
   * answer, a timeout or an error. The one tool that reaches outside the
   * record besides `end_standup`; it is injected so the tool set stays
   * testable without a server, a thread or a network.
   */
  askThread: (question: string, key: string | null) => Promise<StandupAskOutcome>;
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
  // BB-309: a pull-request key resolves to the ticket binding that holds its
  // gate need. Render that pull's own snapshot from what the binding already
  // holds, never the ticket's snapshot or a "No steward" line. The binding's
  // own key is the entity even when it parses as a pull reference (a GitHub
  // issue key has the same shape).
  const linked = key === b.entityKey ? null : pullFromKey(b, key);
  const entity = linked ?? (await ctx.snapshot(b).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
  if (entity === null) return `No snapshot is available for ${key}.`;
  const lines = [`${entity.key}: ${entity.title ?? "(no title)"}`];
  lines.push(`State: ${entity.state ?? "unknown"}${entity.labels.length === 0 ? "" : ` · labels: ${entity.labels.join(", ")}`}`);
  if (entity.author !== null) lines.push(`Author: ${entity.author}`);
  // BB-309: a pull request's body is clipped for the spoken answer; a ticket's
  // body is rendered as written, as before.
  if (entity.description !== null && entity.description.trim() !== "") lines.push(entity.kind === "pull" ? clipBlock(entity.description, STANDUP_ENTITY_DESCRIPTION_MAX_CHARS) : entity.description.trim());
  // BB-306: the snapshot already fetched these; render them so the model does
  // not have to spend a lookup on what the tool already has.
  const comments = entity.comments.slice(-STANDUP_ENTITY_COMMENTS_MAX);
  if (comments.length > 0) {
    lines.push(`Comments (last ${comments.length} of ${entity.comments.length}):`);
    for (const c of comments) lines.push(`  ${c.createdAt} ${c.author} ${c.did}: ${clipText(c.body, STANDUP_ENTITY_COMMENT_MAX_CHARS)}`);
  }
  if (entity.linkedPulls.length > 0) {
    // BB-309: a ticket's linked pull requests render with the title and state
    // the binding already read for them, not the key alone.
    lines.push(
      `Linked pull requests: ${entity.linkedPulls
        .map((p) => {
          const linkKey = p.key ?? p.url;
          const pull = linkedPullFor(b, p);
          return pull === null ? linkKey : `${linkKey} ${pull.title ?? "(no title)"} (${pull.state ?? "unknown"})`;
        })
        .join(", ")}`,
    );
  }
  if (entity.children.length > 0) {
    const shown = entity.children.slice(0, STANDUP_ENTITY_CHILDREN_MAX);
    const more = (entity.childrenTotal ?? entity.children.length) - shown.length;
    lines.push(`Children: ${shown.map((c) => `${c.key} ${c.title ?? "(no title)"} (${c.state ?? "unknown"})`).join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
  }
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
    // BB-309: the brief names a gate item by its pull request key
    // (`owner/repo#N`); match it against the need's URL too, not only the id,
    // the exact URL or the description.
    const match = candidates.find((n) => n.id === wanted || n.url === wanted || n.what === wanted || samePullRef(n.url, wanted));
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
  // BB-309: the binding may be a pull-request key the brief shows. Record the
  // resolved binding's own key so the confirmation path's `store.find` finds
  // it later, and use the pull key to pick the exact item when the caller did
  // not name one.
  let bindingValue = bindingKey;
  if (type === "gate") {
    if (bindingKey === null) throw new Error("a gate note needs a binding");
    const binding = ctx.binding(bindingKey);
    if (binding === null) throw new Error(`No steward for ${bindingKey}`);
    bindingValue = binding.entityKey;
    const explicit = optionalString(args, "need");
    const wanted = explicit ?? (bindingKey !== binding.entityKey && parsePullRef(bindingKey) !== null ? bindingKey : null);
    const item = gateNeed(ctx, binding, action, wanted);
    need = item.id;
    needLabel = item.what;
  }
  const note: StandupNote = {
    id: `note_${crypto.randomUUID()}`,
    type: type as StandupNoteType,
    text,
    binding: bindingValue,
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
    case "ask_a_thread":
      return askThreadTool(ctx, args);
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
 * BB-307: hand one question to the injected delegate and log the delegation.
 * The answer is scrubbed with `redactLine`'s SECRET pattern and capped before
 * it is written to the record or returned to the model, so a token in the
 * delegate's words reaches neither OpenAI nor the durable log. A lookup already
 * in flight for this stand-up is refused with a line and logs nothing; a
 * timeout returns the "did not finish" line, and the server logs a late answer
 * on the record without delivering it.
 */
async function askThreadTool(ctx: StandupToolContext, args: Record<string, unknown>): Promise<string> {
  const question = requireString(args, "question");
  const key = optionalString(args, "key");
  const result = await ctx.askThread(question, key);
  if (result.outcome === "busy") return "A lookup is already running for this stand-up; wait for it to finish before asking again.";
  // BB-309: the answer is read aloud, so strip the Markdown a model reaches
  // for anyway; `redactLine` scrubs credentials and caps the length first.
  const answer = result.answer === null ? null : stripMarkdown(redactLine(result.answer, STANDUP_DELEGATE_ANSWER_MAX_CHARS));
  ctx.record.delegations.push({
    question,
    key,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    elapsedMs: Math.max(0, result.finishedAt - result.startedAt),
    answer,
    outcome: result.outcome,
    error: result.error,
  });
  if (result.outcome === "success" && answer !== null) return answer;
  if (result.outcome === "timeout") return "The lookup did not finish in time; the answer will be logged if it arrives, but it is not available now.";
  return `The lookup failed: ${result.error ?? "unknown error"}`;
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

/**
 * BB-306: "open since <date>" for one open item, plus a stale marker once the
 * item is older than `STANDUP_STALE_DAYS`, or null when the record carries no
 * usable `createdAt`. The age is measured from the record's own creation, so a
 * claim raised in present tense is read with its age attached.
 */
function openSince(now: number, createdAt: number | null | undefined): string | null {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  const since = `open since ${new Date(createdAt).toISOString()}`;
  const ageMs = Math.max(0, now - createdAt);
  if (ageMs <= STANDUP_STALE_DAYS * DAY_MS) return since;
  return `${since} — open ${Math.floor(ageMs / DAY_MS)} days; a claim this old may be out of date — verify before repeating it`;
}

/** One line with its age appended, or the line alone when there is no date to show. */
function withAge(line: string, now: number, createdAt: number | null | undefined): string {
  const age = openSince(now, createdAt);
  return age === null ? line : `${line} (${age})`;
}

/** Collapse and clip long text so one record cannot crowd the brief. */
function clipText(text: string, max: number): string {
  const one = text.replace(/\s+/gu, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** Cap a multi-line body without flattening its line breaks, so it reads as written. */
function clipBlock(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * BB-309: whether two strings name the same pull request, whatever their
 * spelling (`owner/repo#N` or a GitHub pull URL). The stand-up's key reader
 * and its gate-need matcher both use it, so the key the brief shows resolves.
 */
export function samePullRef(a: string, b: string): boolean {
  const x = parsePullRef(a);
  const y = parsePullRef(b);
  return x !== null && y !== null && x.repo === y.repo && x.number === y.number;
}

/** The binding's snapshot of the pull a requested key names, when the key is a pull reference. */
function pullFromKey(binding: Binding, key: string): EntitySnapshot | null {
  if (parsePullRef(key) === null) return null;
  return (binding.lastSnapshot?.pulls ?? []).find((p) => samePullRef(p.key, key) || (p.url !== null && samePullRef(p.url, key))) ?? null;
}

/** The binding's snapshot of a linked pull, by its link key or url, or null when it was not read. */
function linkedPullFor(binding: Binding, link: { url: string; key: string | null }): EntitySnapshot | null {
  return (binding.lastSnapshot?.pulls ?? []).find((p) => (link.key !== null && samePullRef(p.key, link.key)) || samePullRef(p.url ?? "", link.url)) ?? null;
}

/**
 * BB-309: the facts a gate need's brief line carries, read only from what the
 * binding already holds: the pull's title, the steward's status summary and
 * the last `bb-review` verdict with its lane and approver. No source call.
 */
function gateNeedFacts(binding: Binding, need: Need): string[] {
  const facts: string[] = [];
  const pull = pullFromKey(binding, need.url);
  if (pull !== null && pull.title !== null && pull.title.trim() !== "") facts.push(`"${pull.title.trim()}"`);
  const summary = binding.status?.summary;
  if (summary !== null && summary !== undefined && summary.trim() !== "") facts.push(clipText(summary, STANDUP_CONTEXT_MAX_CHARS));
  if (pull !== null) {
    const marker = latestReviewMarker(pull.comments);
    if (marker !== null) {
      const lane = marker.lane === null ? "" : `, lane ${marker.lane}`;
      const approver = marker.approver === undefined ? "" : `, approver ${marker.approver}`;
      facts.push(`review ${marker.verdict}${lane}${approver}`);
    }
  }
  return facts;
}

/**
 * BB-309: strip the Markdown a delegate reaches for even when asked for plain
 * prose, so the spoken answer carries no markers. Headings, bullets, numbered
 * lists, blockquotes, bold, strikethrough, code fences and inline code all keep
 * their words and lose their punctuation. Single `*`/`_` emphasis is left
 * alone: it is not a marker a voice model reads, and stripping it would mangle
 * `snake_case` identifiers and arithmetic.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^```[^\n]*$/gmu, "")
    .replace(/^~~~[^\n]*$/gmu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}[-*+]\s+/gmu, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/\*\*\*(.+?)\*\*\*/gsu, "$1")
    .replace(/\*\*(.+?)\*\*/gsu, "$1")
    .replace(/~~(.+?)~~/gsu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1");
}

/** An open question put to the owner, with the binding it attaches to resolved to a key. */
export type StandupOpenQuestion = { key: string | null; question: string; choices: string[]; createdAt: number; context: string | null };

/** The owner's decisions, as one line each: needs, forwarded escalations and open questions. */
function decisionLines(briefing: Briefing, questions: readonly StandupOpenQuestion[], now: number): string[] {
  const out: string[] = [];
  for (const { need, binding } of briefing.decisions.needs) {
    const base = `${binding.entityKey}: ${need.what} (${need.kind})`;
    // BB-309: a gate item's line carries the pull's substance from what the
    // binding already holds, so describing it needs no lookup.
    const facts = need.kind === "approve-pr" || need.kind === "merge" ? gateNeedFacts(binding, need) : [];
    out.push(withAge(facts.length === 0 ? base : `${base} — ${facts.join(" · ")}`, now, need.createdAt));
  }
  for (const { escalation, from } of briefing.decisions.withUser) out.push(withAge(`${from.entityKey}: ${escalation.question}${escalation.recommendation === null ? "" : ` — recommendation: ${escalation.recommendation}`}`, now, escalation.createdAt));
  // The briefing's `withUser` leaves questions to the digest's own section
  // (slice 1); the stand-up is exactly where the owner answers them, so they are
  // added here as decisions rather than dropped. A question's context renders
  // indented under its line, clipped, so the model can say what it is about
  // without a lookup (BB-306).
  for (const q of questions) {
    const line = withAge(`${q.key ?? "the project"}: ${q.question}${q.choices.length === 0 ? "" : ` (choices: ${q.choices.join(" / ")})`}`, now, q.createdAt);
    out.push(q.context === null || q.context.trim() === "" ? line : `${line}\n  ${clipText(q.context, STANDUP_CONTEXT_MAX_CHARS)}`);
  }
  return out;
}

/** The project steward's escalations, as one line each. */
function projectEscalationLines(briefing: Briefing, now: number): string[] {
  return briefing.escalations.map(({ escalation, from }) => withAge(`${from.entityKey}: ${escalation.question}${escalation.recommendation === null ? "" : ` — recommendation: ${escalation.recommendation}`}`, now, escalation.createdAt));
}

/** The stuck and held bindings, as one line each. A hold, a no-wake-source wait
 * and a dated wait are properties of a binding, not records with their own
 * `createdAt`, so they carry no age: `Binding.createdAt` is when the steward was
 * bound, not when the wait started (BB-306). */
function stuckLines(briefing: Briefing, now: number): string[] {
  const out: string[] = [];
  for (const { escalation, from } of briefing.stuck.stuck) out.push(withAge(`${from.entityKey}: stuck — ${escalation.question}`, now, escalation.createdAt));
  for (const { escalation, from } of briefing.stuck.stall) out.push(withAge(`${from.entityKey}: stalled — ${escalation.question}`, now, escalation.createdAt));
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
 * A scoped stand-up (BB-303) passes the binding key as `scope`: the header says
 * "This stand-up is about <key> only" so the model does not wander, and the
 * project-wide "Done since" and playbook-deviation sections are left out, since
 * the briefing is one binding and the stand-up does not advance the window.
 *
 * The text is bounded twice: each section lists at most `STANDUP_SECTION_MAX`
 * lines (then says how many it left out), and the whole text is kept under the
 * voice plugin's `realtime.open` cap. The ranking survives truncation: the
 * sections stay in order and the tail gives way first.
 */
export function buildStandupInstructions(briefing: Briefing, projectName: string, now: number, questions: readonly StandupOpenQuestion[] = [], scope: string | null = null): string {
  const since = briefing.since === 0 ? "the beginning" : new Date(briefing.since).toISOString();
  const header = [
    scope === null
      ? `You are the voice of ${projectName}'s stewards in a stand-up with the project's owner.`
      : `You are the voice of ${projectName}'s stewards in a stand-up with the project's owner about ${scope} only.`,
    scope === null ? `It is ${new Date(now).toISOString()}. You are reporting what happened since ${since}.` : `It is ${new Date(now).toISOString()}. This stand-up is about ${scope} only; stay on that steward and do not range over the project or the other stewards.`,
    briefing.previous === null ? "The project steward has not filed a digest yet." : `The project steward's last digest was ${new Date(briefing.previous.at).toISOString()}.`,
    "",
    "Greet the owner briefly and begin immediately; do not wait for them to speak first.",
    scope === null
      ? "Lead with the things only the owner can unblock, then what is stuck, then what got done and how it was approached. If nothing is waiting on the owner and nothing is stuck, say so plainly and ask what is on their mind."
      : "Lead with the things only the owner can unblock for this steward, then what is stuck or held. If nothing is waiting on the owner and nothing is stuck, say so plainly and ask what is on their mind.",
    "You may read state with the tools you have been given, and you may take or retract notes. You cannot act on a steward, merge, resolve or change anything; the owner confirms notes after the stand-up.",
    "When the owner decides something, take a note in the matching shape (resolve an escalation, a gate item, guidance for a binding, direction for the project, or a standing rule) and read it back in their words. A remark that is not a decision is a free note.",
    "For a gate note, the binding is the ticket key before the colon on the brief line, and need is the pull request named on it (for example owner/repo#34).",
    "For a gate note on a pull request, binding may also be the pull request key itself (owner/repo#34) when the brief names it that way.",
    "To close: call readback and read every line aloud in the server's own words, then ask the owner to confirm. Retract any note they reject, read the changed list back again, and only then call end_standup with the ids they clearly agreed to. Never end without a readback, and treat anything short of a clear yes as no confirmation.",
    "A merge gate item is never applied by end_standup: read it aloud on its own and tell the owner it stays for the page's Confirm button.",
    "An item's text is what was true when it was raised, not what is true now; its age says how much to trust it, so verify a stale claim before repeating it.",
    "When the owner questions a claim in the brief, or a claim is more than a few days old, treat that as not having the information: verify it with ask_a_thread rather than repeating it.",
  ];
  const allSections = [
    { heading: "Decisions waiting on the owner", lines: decisionLines(briefing, questions, now) },
    { heading: "Escalations with the project steward", lines: projectEscalationLines(briefing, now) },
    { heading: "Stuck or held", lines: stuckLines(briefing, now) },
    { heading: "Done since", lines: doneLines(briefing) },
    { heading: "Approaches that departed from the written playbook", lines: deviationLines(briefing) },
  ];
  // A scoped stand-up ranks only the first three sections; the sweep and the
  // playbook deviations are project-wide and do not belong to one binding.
  const sections = scope === null ? allSections : allSections.slice(0, 3);
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
