// The three plain parts of a needs-you item (BB-345): the need line, the
// context that aids the decision, and why it reached the user instead of
// being decided, with the raw material one click away in `details`. Every
// plugin-composed item text is built here so the page, the sidebar, the CLI
// and the readability test read the same strings and cannot drift.
import type { DecisionExplanation } from "./decisions.js";

/** The longest a need line may be, in characters (BB-345). */
export const NEED_LINE_MAX = 120;
/** The longest a context may be, in words (BB-345). */
export const CONTEXT_MAX_WORDS = 80;

/** The one-line why for a routine escalation the guidance did not settle. */
export const ROUTINE_FORWARD_WHY = "No guidance covers this; your answer is saved as a lesson.";

/** The gate rule the user is asked to approve a spec under. */
export const APPROVE_SPEC_WHY = "Your approval is the ready gate: the spec must be approved before a worker starts.";

/** The gate rule the user is asked to merge a pull request under. */
export const MERGE_WHY = "The lane gate is met and no worker is running; the plugin merges unless merges are paused or the pull request is not based on the default branch.";

/** Why an unadopted Dependabot ticket reached the user. */
export const ADOPTION_WHY = "Dependabot adoption is your decision; your answer is saved as a lesson.";

/** Strip backticks, thread ids and binding ids from text shown to a person. */
export function cleanInline(text: string): string {
  return text
    .replace(/`/gu, "")
    .replace(/\b(?:thr|bnd)_[A-Za-z0-9]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Collapse whitespace and trim `text` to at most `max` characters on a word
 * boundary, appending an ellipsis when it was cut. The need line is the one
 * line the sidebar shows, so it never wraps on a stray token.
 */
export function clampNeedLine(text: string, max = NEED_LINE_MAX): string {
  const one = cleanInline(text);
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The number of words in `text`, counting whitespace-separated runs. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/** The number of sentences in `text`, by terminal punctuation. */
export function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return (trimmed.match(/[.!?]+(?:\s|$)/gu) ?? []).length || 1;
}

/**
 * Why a decide-list placement reached the user, in one sentence: the matched
 * entry's text, the self-widening rule, or the routine-forward line.
 */
export function decisionWhy(explanation: DecisionExplanation): string {
  if (explanation.selfWidening) return "Self-widening changes are always yours to decide.";
  if (explanation.winner !== null) return `The decide list marks this the user's: ${explanation.winner.text}.`;
  return ROUTINE_FORWARD_WHY;
}

/** Why a forwarded escalation reached the user: the named entry, or the routine line. */
export function forwardWhy(entry: string | null): string {
  const wanted = cleanInline(entry ?? "");
  return wanted === "" ? ROUTINE_FORWARD_WHY : `The decide list marks this the user's: ${wanted}.`;
}

/**
 * The shown parts of a forwarded question: the steward's question and context
 * exactly as written, with the plugin's `why`. The origin, meanwhile and
 * recommendation stay separate fields the page places (BB-345); the old
 * "A <kind> escalation from …" / "Meanwhile:" / "Recommendation:" glue is
 * never folded into the context.
 */
export function forwardedQuestionParts(input: { question: string; context: string | null; why: string }): { question: string; context: string | null; why: string } {
  return { question: input.question, context: input.context, why: input.why };
}

/** The one line, context, why and details of an approve-pr item. */
export function approvePrNeedParts(input: { key: string; title: string | null; shortSha: string; verdict: string | null; foreign: boolean; product: boolean; why: string; listing: string | null }): { what: string; how: string; why: string; details: string } {
  const title = cleanInline(input.title ?? "");
  const what = clampNeedLine(`Approve ${input.key}${title === "" ? "" : `: ${title}`}`);
  const context = [
    title === "" ? null : `What it changes: ${title}.`,
    input.verdict === null || input.verdict === "" ? null : `Reviewer's verdict: ${input.verdict}.`,
    input.foreign ? "Submit an APPROVED review as you from the Stewards page; until you do, the pull request waits." : "Approve from the Stewards page; until you do, the pull request waits.",
  ].filter((x): x is string => x !== null);
  const mechanics = input.foreign
    ? "Submit an APPROVED review as you from the Stewards page; that is what counts as your approval."
    : `Post the unsigned comment "Approved ${input.shortSha} from the Stewards page" as you; that is what counts as your approval.`;
  const details = [mechanics, input.product ? "This pull request is substantial and references no ticket with an approved spec: read the **Product** section of the review before you approve." : null, input.listing]
    .filter((x): x is string => x !== null)
    .join("\n\n");
  return { what, how: context.join(" "), why: input.why, details };
}

/** The one line, context, why and details of an approve-spec item. */
export function approveSpecNeedParts(input: { what: string; covered: string[] }): { what: string; how: string; why: string; details: string } {
  const what = clampNeedLine(input.what);
  const how = "The ready checklist is met and the ticket is substantial. Approve records the approval on the gate; Decline remembers this spec as declined until it changes.";
  const details = input.covered.length === 0 ? "" : `It covers ${input.covered.length} open assumption${input.covered.length === 1 ? "" : "s"}:\n\n${input.covered.map((c) => `- ${c}`).join("\n")}`;
  return { what, how, why: APPROVE_SPEC_WHY, details };
}

/** The one line, context, why and details of a merge item. */
export function mergeNeedParts(input: { key: string; lane: string | null; note?: string | null }): { what: string; how: string; why: string; details: string } {
  const what = clampNeedLine(`Merge ${input.key}`);
  const base = `The lane gate is met${input.lane === null ? "" : ` (${input.lane})`}. Merge squash-merges through the server's gh login and posts the merge comment. Until then, it waits.`;
  const how = input.note === undefined || input.note === null || input.note === "" ? base : `${base} ${input.note}`;
  return { what, how, why: MERGE_WHY, details: how };
}

/** The one-line ask of a Dependabot adoption decision, short enough for the sidebar. */
export function adoptionNeedLine(ticketKey: string, repo: string, severities: readonly string[]): string {
  const severity = severities.length === 0 ? "" : `${severities.join("/")} `;
  return clampNeedLine(`Adopt ${ticketKey}? ${severity}Dependabot alerts on ${repo}`);
}

/** One problem with a shown part, or null when it is readable. */
export function needLineProblem(line: string): string | null {
  if (line.length > NEED_LINE_MAX) return `need line is ${line.length} characters (max ${NEED_LINE_MAX})`;
  return shownTokenProblem(line);
}

/** One problem with a context line, or null when it is readable. */
export function contextProblem(text: string): string | null {
  if (wordCount(text) > CONTEXT_MAX_WORDS) return `context is ${wordCount(text)} words (max ${CONTEXT_MAX_WORDS})`;
  return shownTokenProblem(text);
}

/** One problem with a why line, or null when it is readable. */
export function whyProblem(text: string): string | null {
  if (sentenceCount(text) > 2) return `why is ${sentenceCount(text)} sentences (max 2)`;
  return shownTokenProblem(text);
}

/** The forbidden tokens a shown part must never carry. */
function shownTokenProblem(text: string): string | null {
  if (/`/u.test(text)) return "shown part carries a backtick";
  if (/\bthr_[A-Za-z0-9]+/u.test(text)) return "shown part carries a thread id";
  if (/\bbnd_[A-Za-z0-9]+/u.test(text)) return "shown part carries a binding id";
  if (/Meanwhile:/u.test(text)) return "shown part carries forwarding glue (Meanwhile:)";
  if (/escalation from/u.test(text)) return "shown part carries forwarding glue (escalation from)";
  return null;
}

/** Every readability problem across a shown need/context/why set. */
export function readabilityProblems(parts: { need?: string | null; context?: string | null; why?: string | null }): string[] {
  const out: string[] = [];
  if (parts.need !== null && parts.need !== undefined) {
    const p = needLineProblem(parts.need);
    if (p !== null) out.push(p);
  }
  if (parts.context !== null && parts.context !== undefined) {
    const p = contextProblem(parts.context);
    if (p !== null) out.push(p);
  }
  if (parts.why !== null && parts.why !== undefined) {
    const p = whyProblem(parts.why);
    if (p !== null) out.push(p);
  }
  return out;
}
