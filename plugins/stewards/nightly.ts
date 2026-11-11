// When the nightly pass runs, and what it is written from. The project file
// names a local time and a time zone; bb's schedules run on the server's
// clock, so a schedule fires every few minutes and asks this whether a
// project's night has come and not yet been passed. Pure: the clock is an
// argument.
//
// `briefing(project, since)` generalises the nightly digest (BB-300). It
// returns the four things a briefing reports, in rank order: decisions
// waiting on the owner, escalations with the project steward, stuck or held
// bindings and what they wait on, and what merged or deployed since. The
// nightly pass is its first caller (`since` is the previous digest); a stand-up
// calls it on demand with "since the last stand-up". `toDigestRecords` keeps
// the nightly's rendering byte-identical while the briefing carries the four
// sections the stand-up needs.
import type { Assumption, Binding, Escalation, Need, Question, Store } from "./store.js";
import type { DigestRecords } from "./wake.js";

const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
};

/** The calendar date and minute of the day at `now` in a time zone. */
export function localParts(now: number, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * The night `now` falls in, named by the date its window opened, or null
 * outside the window. A window that crosses midnight (23:00 to 02:00) belongs
 * to the evening it started.
 */
export function nightOf(now: number, nightly: { at: string; until: string; timezone: string }): string | null {
  const at = minutesOf(nightly.at);
  const until = minutesOf(nightly.until);
  const here = localParts(now, nightly.timezone);
  if (at < until) return here.minutes >= at && here.minutes < until ? here.date : null;
  if (here.minutes >= at) return here.date;
  if (here.minutes < until) return localParts(now - 86_400_000, nightly.timezone).date;
  return null;
}

/** Whether a pass is due: inside tonight's window and tonight not yet passed. */
export function nightlyDue(now: number, nightly: { at: string; until: string; timezone: string }, lastNight: string | null): string | null {
  const night = nightOf(now, nightly);
  return night !== null && night !== lastNight ? night : null;
}

/** Whether there is still time tonight to start another turn. */
export const stillNight = (now: number, nightly: { at: string; until: string; timezone: string }, night: string): boolean => nightOf(now, nightly) === night;

/**
 * What a briefing reports, since a moment: the four sections, in the order the
 * stand-up ranks them. Read from the store's tables, never from the project
 * steward's memory. `previous` and `notes` are the nightly's own memory and
 * ride along so the digest renders from one value; a stand-up ignores them.
 */
export type Briefing = {
  /** The window's start: the previous digest, or the last stand-up. */
  since: number;
  /** The last digest kept, and when; null before the first. */
  previous: { text: string; at: number } | null;
  /** Silent notes queued for this briefing (a hold that lifted on finished work), one line each. */
  notes: string[];
  /** 1. Decisions waiting on the owner: open `needs` and escalations routed `user`. */
  decisions: {
    needs: Array<{ need: Need; binding: Binding }>;
    withUser: Array<{ escalation: Escalation; from: Binding }>;
  };
  /** 2. Escalations with the project steward. */
  escalations: Array<{ escalation: Escalation; from: Binding }>;
  /** 3. Stuck or held bindings and what they wait on. */
  stuck: {
    stuck: Array<{ escalation: Escalation; from: Binding }>;
    held: Binding[];
    noWakeSource: Binding[];
    stall: Array<{ escalation: Escalation; from: Binding }>;
    datedWaits: Binding[];
  };
  /** 4. What merged or deployed since, and the questions answered in the window. */
  done: {
    moved: Binding[];
    ended: Binding[];
    answered: Question[];
  };
  /** Open recorded assumptions (BB-251), one `Assuming:` line each; binding is null for a project-level one. */
  assumptions: Array<{ assumption: Assumption; binding: Binding | null }>;
};

/**
 * Build the briefing reader for one server. `store` and `now` are injected so
 * the digest and the stand-up share one reader, and tests a fixed clock. The
 * returned `briefing(project, since)` is the on-demand entry point: the
 * nightly pass passes the previous digest, a stand-up the stored last stand-up.
 */
export function createBriefing(store: Store, now: () => number): (projectId: string, since: number) => Briefing {
  return function briefing(projectId: string, since: number): Briefing {
    const row = store.project(projectId);
    const all = store.all(projectId);
    const open = all.filter((b) => b.endedAt === null);
    // Every open escalation once, in binding then creation order, so the four
    // sections partition one read rather than repeating it.
    const allEscalations = open.flatMap((b) => store.openEscalations(b.id).map((escalation) => ({ escalation, from: b })));
    const openWith = (pick: (x: Escalation) => boolean) => allEscalations.filter((x) => pick(x.escalation));
    const coveredInDigest = new Set(store.openQuestionEscalationIds(projectId));
    return {
      since,
      previous: row.digest === null ? null : { text: row.digest, at: row.digestAt ?? 0 },
      notes: store.peekProjectNotes(projectId),
      decisions: {
        needs: open.flatMap((b) => store.openNeeds(b.id).map((need) => ({ need, binding: b }))),
        // The digest's predicate, verbatim: a user-routed question escalation
        // is left out here (the questions section covers it), as is a
        // resolution-kind one. That is right for the digest; a stand-up ranking
        // "decisions waiting on the owner" may want the broader set, and
        // slice 3 decides.
        withUser: openWith((x) => x.route === "user" && x.resolutionKind === null && !x.isQuestion && !coveredInDigest.has(x.id)),
      },
      escalations: openWith((x) => x.route === "project"),
      stuck: {
        stuck: openWith((x) => x.kind === "stuck"),
        held: open.filter((b) => b.hold !== null),
        noWakeSource: open.filter((b) => b.noWakeSource),
        stall: openWith((x) => x.kind === "stall"),
        // BB-247: the dated waits still ahead, listed separately from stalls.
        datedWaits: open.filter((b) => b.requeueUntil !== null && b.requeueUntil > now()),
      },
      done: {
        moved: open.filter((b) => b.advancedAt !== null && b.advancedAt >= since),
        ended: all.filter((b) => b.endedAt !== null && b.endedAt >= since),
        answered: store.answeredSince(projectId, since),
      },
      assumptions: store.openAssumptionsForProject(projectId).map((assumption) => ({ assumption, binding: assumption.bindingId === null ? null : (store.binding(assumption.bindingId) ?? null) })),
    };
  };
}

/**
 * Flatten a briefing back to the shape `formatRecords` has always rendered, so
 * the nightly digest text is unchanged by the extraction. The four sections
 * are the stand-up's, not the renderer's; `escalations` is not part of the
 * digest record and is dropped here.
 */
export function toDigestRecords(briefing: Briefing): DigestRecords {
  return {
    previous: briefing.previous,
    since: briefing.since,
    notes: briefing.notes,
    moved: briefing.done.moved,
    ended: briefing.done.ended,
    answered: briefing.done.answered,
    withUser: briefing.decisions.withUser,
    needs: briefing.decisions.needs,
    assumptions: briefing.assumptions,
    stuck: briefing.stuck.stuck,
    noWakeSource: briefing.stuck.noWakeSource,
    stall: briefing.stuck.stall,
    datedWaits: briefing.stuck.datedWaits,
    held: briefing.stuck.held,
  };
}
