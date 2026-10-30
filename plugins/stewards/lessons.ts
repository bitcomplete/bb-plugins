// The mechanical lesson lifecycle's pure half (BB-35 step 3): the anchor that
// makes a lesson's text findable in `.bb`, the age-weighted score that ranks
// lessons, and the thresholds and caps that decide which tier a lesson moves
// to. Nothing here touches the store or a plugin; server.ts applies what this
// returns. Keeping it pure is what makes every transition a unit test.
import type { LessonScope, LessonTier } from "./store.js";
import type { LessonRules } from "./config.js";

const DAY_MS = 86_400_000;

/** The HTML comment that carries a lesson's id in the file it was promoted to. */
export const lessonAnchor = (id: string): string => `<!-- lesson:${id} -->`;

/**
 * The anchor a retired lesson leaves behind. The lesson's text is removed; the
 * tombstone stays so the narrow merge can verify the right file and the same
 * lesson is never promoted again. It deliberately does not match
 * {@link lessonAnchor}, so a reader can tell a retired lesson from a live one.
 */
export const retiredLessonAnchor = (id: string): string => `<!-- lesson:${id} retired -->`;

/** The wording as it lands in `.bb`: the anchor on its own line, then the lesson. */
export const withLessonAnchor = (text: string, id: string): string => `${lessonAnchor(id)}\n${text}`;

/** Whether a file carries a lesson's anchor. */
export const hasLessonAnchor = (content: string, id: string): boolean => content.includes(lessonAnchor(id));

/**
 * Remove exactly the block a lesson's anchor opens: from the start of the
 * anchor's line to the line before the next lesson anchor (or the end of the
 * file). Everything else is returned byte for byte, so a retirement can never
 * take a neighbouring lesson or any other text with it. A file without the
 * anchor is returned unchanged.
 */
export function removeLessonAnchor(content: string, id: string): string {
  const marker = lessonAnchor(id);
  const at = content.indexOf(marker);
  if (at === -1) return content;
  const start = content.lastIndexOf("\n", at) + 1;
  const next = content.indexOf("<!-- lesson:", at + marker.length);
  const end = next === -1 ? content.length : content.lastIndexOf("\n", next) + 1;
  return content.slice(0, start) + content.slice(end);
}

/**
 * The file after a retirement: the lesson's block becomes its retired anchor.
 * The same block boundaries as {@link removeLessonAnchor}, so only the
 * lesson's own text is touched.
 */
export function retireLessonAnchor(content: string, id: string): string {
  const marker = lessonAnchor(id);
  const at = content.indexOf(marker);
  if (at === -1) return content;
  const start = content.lastIndexOf("\n", at) + 1;
  const next = content.indexOf("<!-- lesson:", at + marker.length);
  const end = next === -1 ? content.length : content.lastIndexOf("\n", next) + 1;
  return `${content.slice(0, start)}${retiredLessonAnchor(id)}\n${content.slice(end)}`;
}

/** The fields the score and the transitions read; a `Lesson` satisfies it. */
export type ScoreableLesson = {
  id: string;
  tier: LessonTier;
  file: string;
  /** `procedure` may self-merge; `boundary` always waits for the user's Merge (BB-35 step 5). */
  scope: LessonScope;
  hits: number;
  corrections: number;
  lastCitedAt: number | null;
  createdAt: number;
  /** When the tier last changed; the start of the current trial or promotion. */
  tierAt: number | null;
  /** The lesson that superseded this one, or null. */
  supersededBy: string | null;
  /** When the user answered Keep on the mixed-evidence question, or null (BB-35 step 5). */
  validatedAt: number | null;
};

/**
 * A lesson's rank: distinct-binding hits, each halved every half-life, minus
 * its corrections. An old burst of citations therefore decays away, so the
 * lowest-scoring lesson in a full file is the one displaced. A lesson never
 * cited is scored from when its tier began.
 */
export function lessonScore(lesson: Pick<ScoreableLesson, "hits" | "corrections" | "lastCitedAt" | "createdAt" | "tierAt">, now: number, halfLifeMs: number): number {
  const last = lesson.lastCitedAt ?? lesson.tierAt ?? lesson.createdAt;
  const decay = 0.5 ** (Math.max(0, now - last) / halfLifeMs);
  return lesson.hits * decay - lesson.corrections;
}

/** One tier move the nightly pass should make, with why. */
export type LessonTransition = { id: string; action: "promote" | "retire"; reason: string; displacedId?: string };

const days = (ms: number): number => Math.round(ms / DAY_MS);

/**
 * The nightly pass's decisions, as data: which lessons are promoted, which are
 * retired, and which promoted lesson is displaced when a file is full. Applied
 * in this order so a lesson retired for a correction or for age is never also
 * promoted, and so a promotion's displacement sees the file as it was before
 * the pass.
 */
export function planLessonTransitions(lessons: readonly ScoreableLesson[], rules: LessonRules, now: number): LessonTransition[] {
  const halfLifeMs = rules.decayHalfLifeDays * DAY_MS;
  const out: LessonTransition[] = [];
  const retired = new Set<string>();

  // Superseded first: an explicit successor retires the lesson it names.
  for (const lesson of lessons) {
    if (lesson.supersededBy !== null && lesson.tier !== "retired") {
      out.push({ id: lesson.id, action: "retire", reason: `superseded by ${lesson.supersededBy}` });
      retired.add(lesson.id);
    }
  }

  // Retirement before promotion: a corrected or stale trial retires even if it
  // once met the promotion's hit count.
  for (const lesson of lessons) {
    if (retired.has(lesson.id) || lesson.tier === "retired" || lesson.tier === "candidate") continue;
    const uncited = now - (lesson.lastCitedAt ?? lesson.tierAt ?? lesson.createdAt);
    if (lesson.tier === "trial") {
      if (lesson.corrections >= 1) {
        out.push({ id: lesson.id, action: "retire", reason: "corrected" });
        retired.add(lesson.id);
      } else if (uncited >= rules.trial.retireDays * DAY_MS) {
        out.push({ id: lesson.id, action: "retire", reason: `uncited for ${days(uncited)}d` });
        retired.add(lesson.id);
      }
    } else if (lesson.tier === "promoted") {
      if (lesson.corrections >= rules.promoted.corrections) {
        out.push({ id: lesson.id, action: "retire", reason: `${lesson.corrections} corrections` });
        retired.add(lesson.id);
      } else if (uncited >= rules.promoted.retireDays * DAY_MS) {
        out.push({ id: lesson.id, action: "retire", reason: `uncited for ${days(uncited)}d` });
        retired.add(lesson.id);
      }
    }
  }

  // Promotions, best-scoring first, displacing the lowest-scoring promoted
  // lesson in a file once the cap is reached. A boundary lesson is never
  // promoted here (BB-35 step 5): it changes the escalation boundary, so it
  // waits for the user's Merge via a validation escalation and stays trial
  // until then. `planValidations` is what queues that.
  const eligible = lessons
    .filter((lesson) => lesson.tier === "trial" && lesson.scope === "procedure" && !retired.has(lesson.id) && lesson.corrections === 0)
    .filter((lesson) => lesson.hits >= rules.promote.hits && now - (lesson.tierAt ?? lesson.createdAt) >= rules.promote.days * DAY_MS)
    .sort((a, b) => lessonScore(b, now, halfLifeMs) - lessonScore(a, now, halfLifeMs));
  const byFile = new Map<string, ScoreableLesson[]>();
  for (const lesson of lessons) {
    if (lesson.tier === "promoted" && !retired.has(lesson.id)) byFile.set(lesson.file, [...(byFile.get(lesson.file) ?? []), lesson]);
  }
  for (const lesson of eligible) {
    const inFile = byFile.get(lesson.file) ?? [];
    let displacedId: string | undefined;
    if (inFile.length >= rules.promoted.maxPerFile) {
      const lowest = [...inFile].sort((a, b) => lessonScore(a, now, halfLifeMs) - lessonScore(b, now, halfLifeMs))[0]!;
      displacedId = lowest.id;
      retired.add(lowest.id);
      out.push({ id: lowest.id, action: "retire", reason: `displaced by ${lesson.id}` });
      byFile.set(lesson.file, inFile.filter((l) => l.id !== lowest.id));
    }
    byFile.set(lesson.file, [...(byFile.get(lesson.file) ?? []), lesson]);
    out.push({ id: lesson.id, action: "promote", reason: `${lesson.hits} bindings over ${days(now - (lesson.tierAt ?? lesson.createdAt))}d`, ...(displacedId === undefined ? {} : { displacedId }) });
  }
  return out;
}

/** The two rare conditions a validation escalation asks the user about (BB-35 step 5). */
export const VALIDATION_KINDS = ["boundary-promotion", "mixed-evidence"] as const;
export type ValidationKind = (typeof VALIDATION_KINDS)[number];

/** One lesson the validation queue should ask the user about, best-scoring first. */
export type ValidationRequest = {
  id: string;
  validation: ValidationKind;
  score: number;
  reason: string;
};

/**
 * The validation queue (BB-35 step 5): the rare lessons that need the user's
 * confirmation, ordered by score so the weekly cap spends its one slot on the
 * strongest case and the rest wait. There are exactly two conditions:
 *
 * - `boundary-promotion`: a boundary trial lesson that met the promotion
 *   threshold. The user's Merge is what promotes it; silence leaves it in
 *   trial, which is safe because a trial lesson never widens anything.
 * - `mixed-evidence`: a promoted lesson with citations and a correction short
 *   of the count that retires it. The user is asked once to keep or retire it;
 *   silence retires it.
 *
 * A lesson the user already kept (`validatedAt`) is never asked about again.
 * The caller enforces the weekly cap and the silence default; this is pure.
 */
export function planValidations(lessons: readonly ScoreableLesson[], rules: LessonRules, now: number): ValidationRequest[] {
  const halfLifeMs = rules.decayHalfLifeDays * DAY_MS;
  const out: ValidationRequest[] = [];
  for (const lesson of lessons) {
    if (lesson.tier === "retired" || lesson.supersededBy !== null) continue;
    if (
      lesson.scope === "boundary" &&
      lesson.tier === "trial" &&
      lesson.corrections === 0 &&
      lesson.hits >= rules.promote.hits &&
      now - (lesson.tierAt ?? lesson.createdAt) >= rules.promote.days * DAY_MS
    ) {
      out.push({ id: lesson.id, validation: "boundary-promotion", score: lessonScore(lesson, now, halfLifeMs), reason: `${lesson.hits} bindings over ${days(now - (lesson.tierAt ?? lesson.createdAt))}d` });
      continue;
    }
    if (lesson.tier === "promoted" && lesson.validatedAt === null && lesson.hits > 0 && lesson.corrections >= 1 && lesson.corrections < rules.promoted.corrections) {
      out.push({ id: lesson.id, validation: "mixed-evidence", score: lessonScore(lesson, now, halfLifeMs), reason: `${lesson.hits} bindings and ${lesson.corrections} correction${lesson.corrections === 1 ? "" : "s"}` });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
