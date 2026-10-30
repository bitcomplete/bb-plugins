import {
  BRIEF_STAGES,
  MAX_REFRESHER_LENGTH,
  MAX_TITLE_LENGTH,
  nextStepActorSchema,
  storedBriefStatusSchema,
  summaryResultSchema,
  type BriefStage,
  type NextStepActor,
  type RefresherProse,
  type StoredBriefStatus,
  type SummaryResult,
} from "./contract.js";
import { BLOCK_NOTE_MARKER } from "./transcript.js";

export const SYSTEM_PROMPT = `You write one-paragraph-max operating briefs for software engineering threads, so someone returning after a day away knows what the thread is for and what to do next without reading it.

Return ONLY a JSON object with exactly these keys:

  "title"         A name for this thread, 4-6 words, that someone scanning a sidebar would recognise a day later. Name the work, not the conversation: the subsystem, file, or feature plus what is being done to it. No trailing punctuation, no quotes, no "thread"/"discussion"/"chat", no leading verb like "Add" unless adding is genuinely the whole job.
  "goal"          One line: what this thread is actually trying to achieve. Not the opening prompt restated — the underlying objective, as it stands now.
  "currentState"  What exists now, including half-finished work. Name the concrete artifacts (files, branches, PRs) where the transcript names them.
  "status"        Picture the user having done everything this thread asks of them: run the command, merged or approved, checked the thing, answered the offer. Is the task then finished, with nothing left to happen in this thread? One of:
                  "done" — yes. Steps that are the user's alone, offers of extra work, and optional checks do not keep it open. Example: "Merged and deployed. Run kubectl rollout status to confirm — and want me to add a lint rule too?"
                  "waiting-on-me" — no: the user's answer, decision, or go-ahead starts more work in this thread, such as committing or shipping work the agent has made, or the task is otherwise unfinished. Example: "The diff is ready but uncommitted. Should I commit and push?"
                  "waiting-on-other" — no: the work cannot go on until the party in "blockedOn" acts. Example: "Waiting on Sam's review of PR #12 before I merge."
  "nextStep"      The most useful next action, if there is one, phrased so the reader could start it without thinking. ONE action, not a plan. A finished thread may still carry a suggestion here. Empty string if there is nothing worth doing.
  "nextStepActor" Who would take "nextStep": "me" (the user), "agent", or "other" (someone outside this thread). Omit it when "nextStep" is empty.
  "blockedOn"     The party or artifact outside this thread that the work is waiting on, named so someone could go chase it: a review, a person, an upstream fix, an access grant. Never a duration, and never something that will finish on its own. Empty string otherwise.
  "constraints"   Facts learned during the thread that would break a naive re-plan: API limits, rejected approaches, assumptions proven wrong. Empty string if none.
  "stage"         How far round the arc the work itself has got. One of: "discovery" (still establishing what is true or what is wanted), "planning" (the shape is agreed, the making has not started), "implementation" (the work is being made), "review" (the work is made, and is being checked, tried, or waited on for a verdict). Judge the work, not the conversation: a thread whose agent has finished building and described what it built is at "review", whether or not anyone has looked at it yet.
  "refresherShort" One or two sentences of plain prose, addressed to the user as "you", for someone reopening this thread after a few hours: what they were doing, how far it got, what to do next.
  "refresherFull"  The same thing for someone who has been away for days: two or three sentences, with enough named detail to stand on its own.

Rules:
- Every key above is required except "nextStepActor". Every field is a string; "nextStepActor" and "status" are one of the words listed for them. Keep each to one or two lines.
- The two "refresher" fields are prose, not labelled fields: flowing sentences, no "Goal:" / "Next:" prefixes, no bullet points, no headings. Write them as you would say them to the person over their shoulder as they sit back down.
- Write them in that order — what you were doing, how far it got, what to do next — and name things concretely: the file, the branch, the PR, the command. "You were partway through the sidebar sections" is useless; "the section sync lands but the order is not pinned yet" is the point.
- Mention what is blocking, or a constraint learned in the thread, ONLY when it changes what to do next. A blocker that has already been routed around is history, not orientation.
- When "status" is "done", the refreshers say what the thread landed, and offer "nextStep" (if any) as an option rather than as owed work.
- "refresherFull" is not "refresherShort" with adjectives. It is allowed the detail the short one had to drop: the second half of the state, the constraint that will bite, the name of the thing that is blocked.
- "title" describes what the thread turned out to be about, not what its opening message asked for. A thread that set out to fix a test and ended up rewriting the scheduler is named for the scheduler.
- Use empty strings, not "none" / "N/A" / "nothing".
- Write plainly and specifically. No preamble, no hedging, no restating these instructions.
- Base every claim on the transcript. Do not speculate about what the code or the user probably wants.`;

/**
 * What to tell the model about a status the user has pinned by hand.
 *
 * Addressed to the two refresher fields and nothing else. The pin deliberately
 * sits *in front of* the derivation rather than editing the fields it reads
 * (see `effectiveStatus`): a `nextStep` blanked to satisfy a pin would be fed
 * back as the previous brief and written into storage, where a pin is a
 * separate fact the summarizer never sees and cannot undo. So the five fields
 * keep describing the work, and only the prose — the part that speaks to the
 * user about what to do — is told to agree with the pin.
 */
const PINNED_STATUS_GUIDANCE: Record<StoredBriefStatus, string> = {
  "waiting-on-me":
    "the user has marked this thread as waiting on them. The refreshers should read as a thread parked for them to pick up, whatever the transcript's own sign-off suggested.",
  "waiting-on-other":
    "the user has marked this thread as blocked. The refreshers must not tell them to carry on with the work; say what it is waiting on and leave it there.",
  done: "the user has marked this thread as finished — the outstanding step was carried out somewhere the transcript cannot see. The refreshers must not hand out a next action; say what it landed and stop.",
};

/**
 * What to tell the model about a block reason the user recorded.
 *
 * Unlike the pinned-status guidance, this is addressed to the fields. The
 * reason is a fact the transcript does not contain — the user typed it into
 * the panel, not the thread — and the honest way to get it into the brief is
 * to hand it over as a fact and let the model write `blockedOn` and `status`
 * from it, in its own words, as it would from a message. The note is placed
 * in the conversation at the point it was made so the model can read what
 * came after it; that is what "unless resolved since" means.
 */
const BLOCK_REASON_GUIDANCE = `The conversation contains a line marked "${BLOCK_NOTE_MARKER}": the user recorded, outside the thread, why this thread is blocked. Treat it as true unless the conversation after that line shows the block resolved or the user resuming the work. While it holds, "blockedOn" names what the note says the thread is waiting on, in your words, and "status" is "waiting-on-other". The refreshers should say the thread was parked and why, and what picking it back up would involve, rather than telling the user to carry on.`;

export function buildUserPrompt(args: {
  transcript: string;
  fixedStage: BriefStage | null;
  /** A status the user pinned by hand, or null for the ordinary derivation. */
  pinnedStatus?: StoredBriefStatus | null;
  /** Whether the transcript carries a block note to be read as guidance. */
  hasBlockReason?: boolean;
}): string {
  const stageLine =
    args.fixedStage === null
      ? `Judge "stage" from the transcript.`
      : `"stage" is fixed to ${JSON.stringify(
          args.fixedStage,
        )} by the user — return exactly that value regardless of what the transcript suggests.`;

  const pinned = args.pinnedStatus ?? null;
  const statusLine =
    pinned === null
      ? ""
      : `\n\nFor "refresherShort" and "refresherFull" only: ${PINNED_STATUS_GUIDANCE[pinned]} The other fields still describe the work as the transcript leaves it.`;

  const reasonLine = args.hasBlockReason ? `\n\n${BLOCK_REASON_GUIDANCE}` : "";

  return `${stageLine}${statusLine}${reasonLine}

Thread transcript follows.

---
${args.transcript}
---

Return the JSON object now.`;
}

/**
 * Pull a JSON object out of a model reply. Small models wrap JSON in prose or
 * fences often enough that strict parsing would be the main source of failures.
 */
export function extractJson(reply: string): unknown {
  const trimmed = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter(
    (value): value is string => typeof value === "string",
  );

  for (const candidate of candidates) {
    const text = candidate.trim();
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to brace-slicing below.
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error("model reply contained no JSON object");
}

const EMPTY_SYNONYMS = new Set([
  "",
  "none",
  "n/a",
  "na",
  "nothing",
  "unknown",
  "not applicable",
  "no next step",
  "-",
]);

/** The model is told to use empty strings; this catches it when it doesn't. */
function normalizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return EMPTY_SYNONYMS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

/**
 * The actor, or `undefined` when there is no usable one: the model omitted it,
 * sent a word we do not recognise, or named an actor for a next step that does
 * not exist.
 *
 * Undefined is a first-class value rather than a failure — every brief written
 * before this field existed has none either — so an unrecognised actor drops
 * back to the actor-free derivation instead of costing the whole brief.
 */
function normalizeActor(
  value: unknown,
  nextStep: string,
): NextStepActor | undefined {
  if (nextStep === "" || typeof value !== "string") return undefined;
  const parsed = nextStepActorSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

const stripTrailingPunctuation = (text: string) =>
  text.replace(/[.,;:]+$/u, "").trim();

/**
 * A title the plugin is willing to put on a thread, or `undefined` when the
 * model gave nothing usable.
 *
 * Stricter than the prose fields because this one is written back into bb: a
 * title is the thread's name everywhere — sidebar, header, command palette,
 * `bb thread list` — and it replaces something the reader may have learned to
 * recognise, so a malformed one costs more than a malformed `constraints`.
 *
 * The cleanup is the small set of things models reliably do to a field asked
 * for as a name: wrap it in quotes, end it with a period, or write a sentence
 * where a label was wanted. Over-length is truncated at a word boundary rather
 * than rejected — a good name with a trailing clause is still a good name.
 */
export function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  // Punctuation is stripped on both sides of the unquote because models put a
  // trailing period on either side of the closing quote: `"A name".` needs the
  // first pass to expose the quotes, `"A name."` needs the second.
  const bare = stripTrailingPunctuation(collapsed);
  const unquoted = /^(["'`])(.+)\1$/u.exec(bare)?.[2]?.trim() ?? bare;
  const trimmed = stripTrailingPunctuation(unquoted);
  if (trimmed === "" || EMPTY_SYNONYMS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;

  const cut = trimmed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // Fall back to the hard cut for a single word longer than the cap, which is
  // some identifier the reader would rather see truncated than dropped.
  const clamped = stripTrailingPunctuation(lastSpace > 0 ? cut.slice(0, lastSpace) : cut);
  return clamped === "" ? undefined : clamped;
}

/**
 * Prose cut to a length, on a sentence boundary where there is one.
 *
 * Over-length is clamped rather than rejected because the failure it guards is
 * a model that answered the brief well and the word count badly — throwing that
 * away would cost the whole refresher over a matter of style. The cut prefers
 * the last sentence end inside the cap, so what survives is whole sentences
 * rather than a clause ending in an ellipsis; a single unbroken sentence longer
 * than the cap falls back to a word boundary and takes the ellipsis, which at
 * least reads as truncation rather than as a thought the model abandoned.
 */
export function clampProse(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= limit) return collapsed;

  const cut = collapsed.slice(0, limit);
  const sentenceEnd = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  // A sentence boundary in the first fifth of the budget is not a clamp, it is
  // a one-line answer to a three-line question; keep cutting instead.
  if (sentenceEnd > limit / 5) return cut.slice(0, sentenceEnd + 1);

  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The two reorientation variants, or null when neither survived.
 *
 * Null is an ordinary answer, not a failure: a model that ignored the two new
 * keys still wrote a perfectly good brief, and the only consequence is that
 * this thread never shows a refresher. Failing the parse instead would cost the
 * five fields, the ring and the sidebar section over a paragraph.
 *
 * One empty variant is kept rather than dropped — {@link chooseRefresher} falls
 * back to whichever one exists, so a model that answered only the short form
 * still reorients someone returning after a week.
 */
export function normalizeRefresher(record: {
  short: unknown;
  full: unknown;
}): RefresherProse | null {
  const short = clampProse(
    normalizeField(record.short),
    MAX_REFRESHER_LENGTH.short,
  );
  const full = clampProse(
    normalizeField(record.full),
    MAX_REFRESHER_LENGTH.full,
  );
  return short === "" && full === "" ? null : { short, full };
}

/**
 * The status a summary reports, or `waiting-on-me` when the model gave none we
 * recognise.
 *
 * `waiting-on-me` is the fallback because it is the reading whose error is
 * cheap: a thread wrongly left waiting is noise in the sidebar, where one
 * wrongly called done goes grey and is archived two days later.
 *
 * The one rule applied on top of the model is true whatever the model thinks: a
 * thread that names something it is waiting on is not finished. It reads the
 * model's own `blockedOn` rather than any judgement about it, so it is a hard
 * invariant, not a tie-break between two answers.
 */
export function normalizeStatus(
  value: unknown,
  blockedOn: string,
): StoredBriefStatus {
  const parsed = storedBriefStatusSchema.safeParse(
    typeof value === "string" ? value.trim().toLowerCase() : value,
  );
  const status = parsed.success ? parsed.data : "waiting-on-me";
  return status === "done" && blockedOn !== "" ? "waiting-on-other" : status;
}

export function parseSummary(
  reply: string,
  fixedStage: BriefStage | null,
): SummaryResult {
  const raw = extractJson(reply);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("model reply was not a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const nextStep = normalizeField(record.nextStep);
  const blockedOn = normalizeField(record.blockedOn);

  // A pinned stage short-circuits the fallback: the prompt promises the user's
  // pick is returned whatever the transcript says, and a pin overruled here
  // would be a pin that silently did not hold.
  const rawStage = typeof record.stage === "string" ? record.stage.trim() : "";
  const stage: BriefStage =
    fixedStage ??
    (BRIEF_STAGES.includes(rawStage as BriefStage)
      ? (rawStage as BriefStage)
      : // An unrecognized stage is not worth failing the whole brief over;
        // implementation is the safest neutral guess.
        "implementation");

  return summaryResultSchema.parse({
    title: normalizeTitle(record.title),
    goal: normalizeField(record.goal),
    currentState: normalizeField(record.currentState),
    nextStep,
    nextStepActor: normalizeActor(record.nextStepActor, nextStep),
    blockedOn,
    constraints: normalizeField(record.constraints),
    stage,
    status: normalizeStatus(record.status, blockedOn),
    refresher: normalizeRefresher({
      short: record.refresherShort,
      full: record.refresherFull,
    }),
  });
}

export interface CompletionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
}

/**
 * Accept either the API root or the full chat-completions endpoint.
 *
 * Providers document the full URL — Fireworks publishes
 * `https://api.fireworks.ai/inference/v1/chat/completions`, OpenAI the same
 * shape — so pasting that into a setting labelled "base URL" is the natural
 * mistake, and appending blindly produced
 * `/v1/chat/completions/chat/completions` and a 404. Trailing slashes are the
 * other common way to mistype it.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return /\/chat\/completions$/u.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export async function requestSummary(
  config: CompletionConfig,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `summarizer HTTP ${response.status}${
        detail === "" ? "" : `: ${detail.slice(0, 400)}`
      }`,
    );
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("summarizer returned an empty reply");
  }
  return content;
}
