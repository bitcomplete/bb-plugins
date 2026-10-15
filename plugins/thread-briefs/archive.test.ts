import { describe, expect, it } from "vitest";
import {
  planArchives,
  type ArchiveBriefFacts,
  type ArchiveCandidate,
} from "./archive.js";
import { isStaleDone, idleMsSince } from "./shared.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const thread = (
  overrides: Partial<ArchiveCandidate> = {},
): ArchiveCandidate => ({
  id: "thr_1",
  latestAttentionAt: NOW - 3 * DAY,
  pinnedAt: null,
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  status: "idle",
  optedOut: false,
  ...overrides,
});

const brief = (
  overrides: Partial<ArchiveBriefFacts> = {},
): ArchiveBriefFacts => ({
  status: "done",
  autoArchivedAt: null,
  ...overrides,
});

const plan = (args: {
  threads?: ArchiveCandidate[];
  briefs?: Record<string, ArchiveBriefFacts>;
  archiveAfterMs?: number;
}) =>
  planArchives({
    threads: args.threads ?? [thread()],
    briefs: new Map(Object.entries(args.briefs ?? { thr_1: brief() })),
    now: NOW,
    archiveAfterMs: args.archiveAfterMs ?? 2 * DAY,
  });

describe("the staleness rule", () => {
  it("is the same one the grey ring draws", () => {
    // The user-facing promise is that a ring going grey is the warning for the
    // archive that follows. That only holds while both go through this.
    const stale = {
      status: "done",
      latestAttentionAt: NOW - 2 * DAY,
      now: NOW,
      afterMs: DAY,
    };
    expect(isStaleDone(stale)).toBe(true);
    expect(isStaleDone({ ...stale, afterMs: 3 * DAY })).toBe(false);
  });

  it("counts nothing for a thread that is not done", () => {
    expect(
      isStaleDone({
        status: "waiting-on-me",
        latestAttentionAt: 0,
        now: NOW,
        afterMs: DAY,
      }),
    ).toBe(false);
  });

  it("treats a threshold of 0 as off rather than as immediately", () => {
    // Both settings use 0 for off, and reading it as "stale the moment it is
    // done" would archive finished threads the same hour they finish.
    expect(
      isStaleDone({
        status: "done",
        latestAttentionAt: 0,
        now: NOW,
        afterMs: 0,
      }),
    ).toBe(false);
  });

  it("reads a cursor from the future as fresh, not ancient", () => {
    // Clock skew between the server that stamped it and whoever is reading it.
    expect(idleMsSince(NOW + DAY, NOW)).toBe(0);
  });
});

describe("planning the auto-archive", () => {
  it("takes a done thread nobody has come back to", () => {
    expect(plan({})).toEqual(["thr_1"]);
  });

  it("leaves one that finished more recently than the threshold", () => {
    expect(
      plan({ threads: [thread({ latestAttentionAt: NOW - 1 * DAY })] }),
    ).toEqual([]);
  });

  it("leaves a thread that is not done, however long it has sat", () => {
    expect(plan({ briefs: { thr_1: brief({ status: "waiting-on-me" }) } })).toEqual(
      [],
    );
  });

  it("never archives a pinned thread", () => {
    // A pin is a deliberate "keep this in front of me" and outranks anything
    // inferred. It still greys — it just never leaves.
    expect(plan({ threads: [thread({ pinnedAt: NOW - 10 * DAY })] })).toEqual([]);
  });

  it("never archives a thread its plugin exempted", () => {
    // A long-lived plugin thread reads "done" between wakes; the plugin that
    // runs it decides when it is finished.
    expect(plan({ threads: [thread({ optedOut: true })] })).toEqual([]);
  });

  it("never archives a thread we archived once and the user pulled back", () => {
    // Un-archiving is an explicit "I want this back". Without this it would be
    // an argument the user has to win again every hour.
    expect(
      plan({ briefs: { thr_1: brief({ autoArchivedAt: NOW - 5 * DAY }) } }),
    ).toEqual([]);
  });

  it("skips a thread with no brief", () => {
    // Briefs are never backfilled, so a briefless thread is one this plugin has
    // never read. It has no claim to make about whether it is finished.
    expect(plan({ briefs: {} })).toEqual([]);
  });

  it("skips hidden, deleted and already-archived threads", () => {
    for (const overrides of [
      { visibility: "hidden" },
      { deletedAt: NOW - DAY },
      { archivedAt: NOW - DAY },
    ]) {
      expect(plan({ threads: [thread(overrides)] })).toEqual([]);
    }
  });

  it("stays out of the way of a thread that is doing something", () => {
    // A stored brief can say done while a turn is already starting again.
    for (const status of ["active", "starting", "pending", "stopping"]) {
      expect(plan({ threads: [thread({ status })] })).toEqual([]);
    }
  });

  it("archives nothing at all when the setting is off", () => {
    expect(plan({ archiveAfterMs: 0 })).toEqual([]);
  });

  it("returns the eligible ones and passes over the rest in the same sweep", () => {
    const threads = [
      thread({ id: "thr_old" }),
      thread({ id: "thr_pinned", pinnedAt: NOW }),
      thread({ id: "thr_fresh", latestAttentionAt: NOW }),
      thread({ id: "thr_busy", status: "active" }),
    ];
    expect(
      plan({
        threads,
        briefs: Object.fromEntries(threads.map((t) => [t.id, brief()])),
      }),
    ).toEqual(["thr_old"]);
  });
});
