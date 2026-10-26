// BB-35 step 6: the hand-written guidance gets the same meter as a lesson.
// Every paragraph of `.bb`'s AGENTS.md and playbooks is indexed as a
// *guidance unit* keyed by a hash of its own text, so a decision can cite the
// guidance it rested on (`cites` accepts a unit id as well as a lesson id) and
// the efficacy view can name the units nothing has cited in 90 days. This
// module is pure: it only reads text, and nothing here can write or retire a
// hand-written unit. Retirement stays lesson-only (`lessons.ts`), bounded by a
// lesson's own anchor.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** The prefix that tells a guidance unit id from a lesson id (`lsn_`). */
export const GUIDANCE_UNIT_PREFIX = "gu_";

/** How long a hand-written unit may go uncited before the efficacy view suggests removing it. */
export const GUIDANCE_UNCITED_DAYS = 90;

/** A paragraph of hand-written guidance, keyed by its content. */
export type GuidanceUnit = {
  /** The content hash: the same paragraph in two files is one unit. */
  id: string;
  /** The `.bb`-relative file it was read from. */
  file: string;
  /** The nearest heading above it, for a readable label. */
  heading: string | null;
  /** The paragraph's own text, as read. */
  text: string;
  /** The lesson whose anchored block this is, or null for hand-written text. */
  lessonId: string | null;
};

/** A guidance unit id, as `cites` names it. */
export const isGuidanceUnitId = (id: string): boolean => /^gu_[0-9a-f]{16}$/u.test(id);

/** The text a unit's hash is taken over: whitespace reflowed, so a rewrap is not a new unit. */
export const normalizeGuidanceText = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * A guidance unit's content hash: 64-bit FNV-1a over the normalised text, as
 * `gu_` plus 16 hex digits. It is stable across reorders and edits elsewhere in
 * the file, which is what lets a citation survive a paragraph moving.
 */
export function guidanceUnitId(text: string): string {
  const normalized = normalizeGuidanceText(text);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalized)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${GUIDANCE_UNIT_PREFIX}${hash.toString(16).padStart(16, "0")}`;
}

/** A playbook's YAML frontmatter is metadata, not guidance; drop it before parsing. */
function withoutFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return content;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end === -1 ? content : lines.slice(end + 1).join("\n");
}

/**
 * Split one guidance file into units: a paragraph is a run of non-blank lines,
 * and a heading starts a new one and labels what follows. An anchored lesson
 * block (`<!-- lesson:<id> -->` and the text under it) is returned with its
 * `lessonId` set, so the efficacy view can leave it to the lesson lifecycle:
 * hand-written units are the ones never auto-retired. A leading YAML
 * frontmatter block is metadata and is not a unit.
 */
export function parseGuidanceUnits(file: string, content: string): GuidanceUnit[] {
  const units: GuidanceUnit[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text === "") return;
    const lesson = /<!--\s*lesson:([A-Za-z0-9_-]+)(?:\s+retired)?\s*-->/u.exec(text);
    units.push({ id: guidanceUnitId(text), file, heading, text, lessonId: lesson === null ? null : lesson[1]! });
  };
  for (const line of withoutFrontmatter(content).split(/\r?\n/u)) {
    const headingMatch = /^(#{1,6})\s+(.*\S)\s*$/u.exec(line);
    if (headingMatch !== null) {
      flush();
      heading = headingMatch[2]!;
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return units;
}

/** A citation of a guidance unit, as the store keeps it (one row per distinct binding). */
export type GuidanceCitation = { unitId: string; lastCitedAt: number };

/** A hand-written unit the efficacy view would suggest removing: uncited for `uncitedDays`. */
export type UncitedGuidanceUnit = { unit: GuidanceUnit; lastCitedAt: number | null };

/**
 * The hand-written units nothing has cited in `uncitedDays`. A unit with no
 * citation at all is included with `lastCitedAt: null`. Lesson-backed blocks
 * are left to the lesson lifecycle and never appear here.
 */
export function uncitedGuidanceUnits(units: readonly GuidanceUnit[], citations: readonly GuidanceCitation[], now: number, uncitedDays = GUIDANCE_UNCITED_DAYS): UncitedGuidanceUnit[] {
  const last = new Map<string, number>();
  for (const c of citations) last.set(c.unitId, Math.max(last.get(c.unitId) ?? 0, c.lastCitedAt));
  const cutoff = uncitedDays * DAY_MS;
  return units
    .filter((u) => u.lessonId === null)
    .map((u) => ({ unit: u, lastCitedAt: last.get(u.id) ?? null }))
    .filter((u) => u.lastCitedAt === null || now - u.lastCitedAt >= cutoff);
}

/** One bucket of the efficacy view's escalation trend. */
export type EscalationWeek = { start: number; count: number };

/** Monday 00:00 UTC of the week a timestamp falls in. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

/**
 * Escalations reaching the user per week, oldest first, over the last `weeks`
 * weeks ending with the week that contains `now`. The caller passes the
 * creation times of the escalations that reached the user; this only buckets
 * them, so the trend is a unit test.
 */
export function escalationWeeks(createdAts: readonly number[], now: number, weeks = 12): EscalationWeek[] {
  const current = weekStart(now);
  const out: EscalationWeek[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = current - i * WEEK_MS;
    out.push({ start, count: createdAts.filter((at) => at >= start && at < start + WEEK_MS).length });
  }
  return out;
}
