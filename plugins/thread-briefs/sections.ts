/**
 * Which sidebar section a thread belongs in, and the moves needed to get there.
 *
 * Pure: every `bb.*` call lives in `server.ts`. The grouping is driven entirely
 * by stored briefs, so this module needs no live thread state beyond each
 * thread's current section.
 */
import { effectiveStatus } from "./brief.js";
import type { BriefStatus, StoredBrief, StoredBriefStatus } from "./contract.js";

/**
 * The status sections, top to bottom.
 *
 * There is no `working` section. `working` is live thread state and never
 * reaches a stored brief (see {@link effectiveStatus}), so a section keyed on it
 * could not have members: a running thread sits in the section its last brief
 * implies and keeps bb's own running indicator. Grouping running threads
 * separately would mean reacting to live state, which is what keeps the server
 * out of per-thread lookups.
 *
 * Each name carries a leading emoji because a section header is drawn as plain
 * text: bb has no icon on a section, so the glyph has to live in the name. That
 * is also why `formerNames` exists — a section is identified by its name, so
 * changing one has to be a rename of the existing section rather than a new
 * section beside it (see {@link planSections}).
 */
export const STATUS_SECTIONS = [
  { status: "waiting-on-me", name: "🙋 Waiting on you", formerNames: ["Waiting on you"] },
  { status: "waiting-on-other", name: "⏸️ Blocked", formerNames: ["Blocked"] },
  { status: "done", name: "✅ Done", formerNames: ["Done"] },
  // Typed against the stored statuses rather than all of them, so a section
  // cannot be keyed on `working` — which could never have members.
] as const satisfies readonly {
  status: StoredBriefStatus;
  name: string;
  formerNames: readonly string[];
}[];

/** The section names this plugin owns, top to bottom. */
export const SECTION_NAMES: readonly string[] = STATUS_SECTIONS.map(
  (entry) => entry.name,
);

/**
 * Every name this plugin has ever given a section, current and former.
 *
 * Teardown filters on this rather than {@link SECTION_NAMES}: a section still
 * under a former name is one we created, and leaving it behind because we had
 * since renamed the constant would strand it in the sidebar for good.
 */
export const OWNED_SECTION_NAMES: readonly string[] = STATUS_SECTIONS.flatMap(
  (entry) => [entry.name, ...entry.formerNames],
);

/** A section as bb hands it back: the shape {@link planSections} reads. */
export interface ExistingSection {
  id: string;
  name: string;
}

export interface SectionStep {
  name: string;
  /** null when no section exists yet and one has to be created. */
  id: string | null;
  /** The former name to rename away from, or null when nothing to rename. */
  renameFrom: string | null;
}

export interface SectionPlan {
  /** Our sections in display order. */
  steps: SectionStep[];
  /** Ids of leftovers under a former name that a current-named section covers. */
  retire: string[];
}

/**
 * What it takes to get from the sections bb has to the ones we want.
 *
 * A section is keyed on its name, so renaming the constant would otherwise
 * orphan the old section — with every thread still filed in it — and build a
 * fresh empty one alongside. Renaming in place keeps the id, and with it every
 * assignment, the sidebar's collapsed state and the user's own ordering.
 *
 * A leftover is retired rather than left alone: deleting it drops its
 * assignments, so the threads in it land back in bb's Threads group and the
 * same reconcile pass re-files them from their briefs.
 */
export function planSections(existing: readonly ExistingSection[]): SectionPlan {
  const byName = new Map(existing.map((section) => [section.name, section.id]));
  const steps: SectionStep[] = [];
  const retire: string[] = [];
  for (const entry of STATUS_SECTIONS) {
    const former = entry.formerNames.flatMap((name) => {
      const id = byName.get(name);
      return id === undefined ? [] : [{ name, id }];
    });
    const current = byName.get(entry.name);
    if (current !== undefined) {
      // Already renamed, or the user got there first: anything still under a
      // former name is a duplicate of a section we already have.
      steps.push({ name: entry.name, id: current, renameFrom: null });
      retire.push(...former.map((match) => match.id));
      continue;
    }
    const [first, ...rest] = former;
    steps.push({
      name: entry.name,
      id: first?.id ?? null,
      renameFrom: first?.name ?? null,
    });
    retire.push(...rest.map((match) => match.id));
  }
  return { steps, retire };
}

/**
 * The status a stored brief resolves to, with no live input folded in.
 *
 * Deliberately the *effective* status, so a thread pinned by hand is filed
 * where the pin says. A grouping that ignored the override would put the thread
 * straight back into the section you moved it out of — which is the only way to
 * move a thread in this sidebar, since a section assignment never feeds back
 * into a brief.
 */
export function storedStatus(stored: StoredBrief): BriefStatus {
  return effectiveStatus(stored);
}

/** The section for a stored status, or null when no section covers it. */
export function sectionNameForStatus(status: BriefStatus): string | null {
  return STATUS_SECTIONS.find((entry) => entry.status === status)?.name ?? null;
}

/**
 * `thread-list`'s top-to-bottom order: pinned first, our sections in
 * {@link STATUS_SECTIONS} order, then bb's built-in Threads group.
 *
 * Threads last is deliberate. A thread with no brief is left unassigned rather
 * than filed anywhere, so that group *is* the "no brief yet" bucket — including
 * for a thread created since the last sync, which is why it must never be
 * hidden.
 */
export function manualSectionOrder(sectionIds: readonly string[]): string[] {
  return ["pinned", ...sectionIds.map((id) => `section:${id}`), "threads"];
}

/**
 * The order to write to `thread-list`, or null to leave the stored one alone.
 *
 * A stored order that already covers the same entries is treated as correct
 * however it is arranged. Reordering sections is something you do by hand in
 * the sidebar, and a reconcile runs on every brief write — so writing
 * {@link manualSectionOrder} whenever it differed would undo the drag within
 * seconds. The canonical order therefore only decides where an entry the stored
 * order has never seen gets inserted.
 *
 * An entry the canonical order does not want is dropped, matching what a
 * straight write of the canonical order would have done.
 */
export function mergeSectionOrder(
  stored: unknown,
  sectionIds: readonly string[],
): string[] | null {
  const canonical = manualSectionOrder(sectionIds);
  if (!Array.isArray(stored) || stored.some((entry) => typeof entry !== "string")) {
    return canonical;
  }
  // Deduped, because an order we are about to splice into has to be a set for
  // the insertion points below to mean anything.
  const kept = (stored as string[]).filter(
    (entry, index) => canonical.includes(entry) && stored.indexOf(entry) === index,
  );
  // Same entries, so whatever arrangement they are in is the user's. No write.
  if (kept.length === canonical.length) return null;
  const merged = [...kept];
  for (const entry of canonical) {
    if (merged.includes(entry)) continue;
    // Dropped in after the last entry the canonical order puts above it, so a
    // newly created section lands beside its siblings rather than below bb's
    // Threads group — and still does when the entries around it have been
    // dragged out of canonical order.
    const rank = canonical.indexOf(entry);
    let after = -1;
    for (const [index, other] of merged.entries()) {
      if (canonical.indexOf(other) < rank) after = index;
    }
    merged.splice(after + 1, 0, entry);
  }
  return merged;
}

export interface SectionedThread {
  id: string;
  sectionId: string | null;
}

export interface AssignmentMove {
  threadId: string;
  /** null clears the assignment, dropping the thread into bb's Threads group. */
  sectionId: string | null;
}

export interface PlanAssignmentsArgs {
  /** The threads eligible for grouping: visible, not archived, not deleted. */
  threads: readonly SectionedThread[];
  /**
   * Target section per thread that has a brief with a section-backed status.
   * A thread absent from this map is treated as briefless.
   */
  sectionIdByThreadId: ReadonlyMap<string, string>;
  /** Every section id this plugin owns, so a stale assignment can be cleared. */
  ownedSectionIds: ReadonlySet<string>;
}

/**
 * The moves needed and nothing more.
 *
 * Idempotent by construction: a thread already in the right section produces no
 * move, so re-planning the result of a plan is empty. That is what makes the
 * sync safe to run on every brief write and on startup.
 *
 * A briefless thread is cleared only when it currently sits in a section this
 * plugin owns — a stale assignment from a brief since deleted. A thread the user
 * filed in their own section keeps it: a catch-all is not worth overwriting a
 * deliberate placement.
 */
export function planAssignments(args: PlanAssignmentsArgs): AssignmentMove[] {
  const moves: AssignmentMove[] = [];
  for (const thread of args.threads) {
    const target = args.sectionIdByThreadId.get(thread.id);
    if (target === undefined) {
      if (
        thread.sectionId !== null &&
        args.ownedSectionIds.has(thread.sectionId)
      ) {
        moves.push({ threadId: thread.id, sectionId: null });
      }
      continue;
    }
    if (thread.sectionId !== target) {
      moves.push({ threadId: thread.id, sectionId: target });
    }
  }
  return moves;
}
