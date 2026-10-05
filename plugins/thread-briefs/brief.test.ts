import { describe, expect, it } from "vitest";
import {
  legacyStatus,
  effectiveStage,
  effectiveStatus,
  idleFor,
  isStageOverrideStale,
  isStatusOverrideStale,
  planRename,
  resolveBrief,
  rowDecoration,
  rowSignalFor,
  summarizedAgo,
} from "./brief.js";
import {
  BRIEF_STAGES,
  PROJECT_RING_HUES,
  isLiveWorking,
  projectColorIndex,
  projectRingColor,
} from "./shared.js";
import type { StoredBrief } from "./contract.js";

const stored = (overrides: Partial<StoredBrief> = {}): StoredBrief => ({
  version: 1,
  threadId: "thr_1",
  fields: {
    goal: "Ship the briefs plugin",
    currentState: "Server and app entries written",
    nextStep: "Run the vitest suite",
    blockedOn: "",
    constraints: "",
  },
  modelStage: "implementation",
  stageOverride: null,
  stageOverrideSeq: null,
  endedWithQuestion: false,
  lastSummarizedAt: 1_000,
  lastActivitySeen: 50,
  ...overrides,
});

describe("effectiveStatus", () => {
  it("reports the status the summarizer judged", () => {
    // Done with a suggestion still standing: nextStep no longer decides.
    expect(effectiveStatus(stored({ modelStatus: "done" }))).toBe("done");
    expect(
      effectiveStatus(
        stored({ modelStatus: "waiting-on-me", fields: { ...stored().fields, nextStep: "" } }),
      ),
    ).toBe("waiting-on-me");
  });

  it("reads a brief written before status was asked for the old way", () => {
    // Not backfilled: such a brief keeps its reading until the thread is
    // next summarized.
    expect(effectiveStatus(stored())).toBe("waiting-on-me");
    expect(
      effectiveStatus(stored({ fields: { ...stored().fields, nextStep: "" } })),
    ).toBe("done");
  });

  it("lets a pin in force win over the model", () => {
    expect(
      effectiveStatus(
        stored({ modelStatus: "waiting-on-me", statusOverride: "done", statusOverrideSeq: 50 }),
      ),
    ).toBe("done");
  });
});

describe("legacyStatus", () => {
  it("reports done only when nothing is outstanding and nothing blocking", () => {
    expect(legacyStatus({ nextStep: "   ", blockedOn: "" })).toBe("done");
  });

  it("does not call a blocked thread done, whatever the next step says", () => {
    // The prompt promises a non-empty nextStep whenever anything is
    // outstanding. This is the guard for when it does not deliver one.
    expect(legacyStatus({ nextStep: "", blockedOn: "Review from Dylan" })).toBe(
      "waiting-on-other",
    );
    expect(legacyStatus({ nextStep: "  ", blockedOn: "  Upstream fix " })).toBe(
      "waiting-on-other",
    );
  });

  it("reports waiting-on-other when something is blocking", () => {
    expect(
      legacyStatus({ nextStep: "Merge it", blockedOn: "Review from Dylan" }),
    ).toBe("waiting-on-other");
  });

  it("falls back to waiting-on-me for unfinished, unblocked work", () => {
    expect(legacyStatus({ nextStep: "Pick an approach", blockedOn: "" })).toBe(
      "waiting-on-me",
    );
  });

  it("does not need a trailing question to report waiting-on-me", () => {
    // An idle thread with work left needs a human look either way, so the
    // question signal no longer changes the outcome.
    expect(legacyStatus({ nextStep: "Keep going", blockedOn: "" })).toBe(
      "waiting-on-me",
    );
  });
});

describe("legacyStatus with an actor", () => {
  it("treats an external actor as blocked even with no blockedOn text", () => {
    expect(
      legacyStatus({
        nextStep: "Land the upstream PR",
        blockedOn: "",
        nextStepActor: "other",
      }),
    ).toBe("waiting-on-other");
  });

  it("reports waiting-on-me for a step only the user can take", () => {
    expect(
      legacyStatus({
        nextStep: "Try it and say whether the glyph looks right",
        blockedOn: "",
        nextStepActor: "me",
      }),
    ).toBe("waiting-on-me");
  });

  it("reports waiting-on-me for a step the agent could take, since the nudge is ours", () => {
    expect(
      legacyStatus({
        nextStep: "Keep porting the remaining call sites",
        blockedOn: "",
        nextStepActor: "agent",
      }),
    ).toBe("waiting-on-me");
  });

  it("lets done win over any actor, so a finished thread is never a prompt", () => {
    expect(
      legacyStatus({ nextStep: "", blockedOn: "", nextStepActor: "other" }),
    ).toBe("done");
  });

  it("preserves the actor-free behaviour when the actor is absent", () => {
    // Every brief written before this field existed lands here.
    expect(legacyStatus({ nextStep: "Keep going", blockedOn: "" })).toBe(
      legacyStatus({
        nextStep: "Keep going",
        blockedOn: "",
        nextStepActor: undefined,
      }),
    );
    expect(
      legacyStatus({
        nextStep: "Keep going",
        blockedOn: "",
        nextStepActor: undefined,
      }),
    ).toBe("waiting-on-me");
  });
});

describe("isLiveWorking", () => {
  it("is true for a running or queued thread", () => {
    expect(isLiveWorking("active")).toBe(true);
    expect(isLiveWorking("starting")).toBe(true);
    expect(isLiveWorking("pending")).toBe(true);
  });

  it("is false for an idle thread, and for anything it does not know", () => {
    expect(isLiveWorking("idle")).toBe(false);
    expect(isLiveWorking("error")).toBe(false);
    expect(isLiveWorking("stopping")).toBe(false);
    expect(isLiveWorking("something-new")).toBe(false);
  });
});

describe("stage overrides", () => {
  it("uses the model's stage when nothing is overridden", () => {
    expect(effectiveStage(stored())).toBe("implementation");
  });

  it("honours an override set at the current activity cursor", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(effectiveStage(brief)).toBe("review");
    expect(isStageOverrideStale(brief)).toBe(false);
  });

  it("retires an override once the thread has real new activity", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 51,
    });
    expect(isStageOverrideStale(brief)).toBe(true);
    expect(effectiveStage(brief)).toBe("implementation");
  });

  it("hides a retired override from the stage control", () => {
    const resolved = resolveBrief(
      stored({
        stageOverride: "review",
        stageOverrideSeq: 50,
        lastActivitySeen: 51,
      }),
    );
    expect(resolved.stageOverride).toBeNull();
    expect(resolved.stage).toBe("implementation");
  });
});

describe("status overrides", () => {
  it("derives the status when nothing is overridden", () => {
    expect(effectiveStatus(stored())).toBe("waiting-on-me");
  });

  it("reads a brief written before the field existed as underived", () => {
    // The field is optional precisely so an older row still parses; absent must
    // behave as "no override" rather than throwing or pinning to undefined.
    const { statusOverride, statusOverrideSeq, ...legacy } = stored();
    expect(statusOverride).toBeUndefined();
    expect(statusOverrideSeq).toBeUndefined();
    expect(effectiveStatus(legacy as StoredBrief)).toBe("waiting-on-me");
    expect(isStatusOverrideStale(legacy as StoredBrief)).toBe(false);
  });

  it("pins a thread done over a next step the transcript will never retire", () => {
    // The case the override exists for: the next step was carried out somewhere
    // no summary can see, so the derivation says waiting-on-me forever.
    const brief = stored({
      fields: {
        ...stored().fields,
        nextStep: "Reload a client and confirm the panel tab opens",
      },
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(legacyStatus(brief.fields)).toBe("waiting-on-me");
    expect(effectiveStatus(brief)).toBe("done");
    expect(isStatusOverrideStale(brief)).toBe(false);
  });

  it("outranks a blockedOn, which the derivation treats as final", () => {
    const brief = stored({
      fields: { ...stored().fields, blockedOn: "A review that has since landed" },
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(effectiveStatus(brief)).toBe("done");
  });

  it("retires the override once the thread has real new activity", () => {
    const brief = stored({
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 51,
    });
    expect(isStatusOverrideStale(brief)).toBe(true);
    expect(effectiveStatus(brief)).toBe("waiting-on-me");
  });

  it("hides a retired override from the status control", () => {
    const resolved = resolveBrief(
      stored({
        statusOverride: "done",
        statusOverrideSeq: 50,
        lastActivitySeen: 51,
      }),
    );
    expect(resolved.statusOverride).toBeNull();
    expect(resolved.status).toBe("waiting-on-me");
  });

  it("reports a live override to the status control", () => {
    const resolved = resolveBrief(
      stored({
        statusOverride: "done",
        statusOverrideSeq: 50,
        lastActivitySeen: 50,
      }),
    );
    expect(resolved.statusOverride).toBe("done");
    expect(resolved.status).toBe("done");
  });

  it("does not touch the stored prose, which the next summary is fed", () => {
    // The pin sits in front of the derivation rather than blanking nextStep,
    // because `renderTranscript` hands the previous brief to the summarizer: a
    // blanked field would simply be written back.
    const brief = stored({
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(resolveBrief(brief).nextStep).toBe("Run the vitest suite");
  });

  it("draws the done ring on a row pinned done, as the panel does", () => {
    const pinned = stored({
      statusOverride: "done",
      statusOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    const decoration = rowDecoration(rowSignalFor(resolveBrief(pinned)), false);
    expect(decoration?.icon).toBe("thread-briefs/done");
  });
});

describe("rowDecoration", () => {
  const signalFor = (brief: StoredBrief) => rowSignalFor(resolveBrief(brief));

  const blocked = stored({
    fields: { ...stored().fields, blockedOn: "Waiting on CI" },
  });
  const done = stored({
    fields: { ...stored().fields, nextStep: "", blockedOn: "" },
  });

  it("draws the stage ring, not the status", () => {
    const decoration = rowDecoration(signalFor(stored()), false);
    expect(decoration?.icon).toBe("thread-briefs/stage-implementation");
    expect(decoration?.tone).toBe("default");
  });

  it("leads the label with the stage the ring draws, and still names the status", () => {
    // The ring is the only thing on the row, so the label is the only place
    // either word appears — and with grouping off, the only place at all.
    expect(rowDecoration(signalFor(stored()), false)?.label).toBe(
      "Implementation — Waiting on you",
    );
    expect(rowDecoration(signalFor(blocked), false)?.label).toBe(
      "Implementation — Blocked",
    );
  });

  it("gives every stage its own ring, in order", () => {
    expect(
      BRIEF_STAGES.map(
        (stage) =>
          rowDecoration(signalFor(stored({ modelStage: stage })), false)?.icon,
      ),
    ).toEqual([
      "thread-briefs/stage-discovery",
      "thread-briefs/stage-planning",
      "thread-briefs/stage-implementation",
      "thread-briefs/stage-review",
    ]);
  });

  it("follows a manual stage override, since that is what the panel shows", () => {
    const overridden = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(rowDecoration(signalFor(overridden), false)?.icon).toBe(
      "thread-briefs/stage-review",
    );
  });

  it("draws the same ring for waiting-on-me and blocked", () => {
    // Status is what the sidebar's own grouping puts in the section header, so
    // the glyph spends its one slot on the stage instead. The label separates
    // them; so does the section.
    expect(rowDecoration(signalFor(blocked), false)?.icon).toBe(
      rowDecoration(signalFor(stored()), false)?.icon,
    );
  });

  it("closes the ring for a finished thread, whatever stage it ended in", () => {
    // `done` is a status, not a fifth stage: the arc is over.
    const decoration = rowDecoration(signalFor(done), false);
    expect(decoration?.icon).toBe("thread-briefs/done");
    expect(
      rowDecoration(
        signalFor(
          stored({ modelStage: "discovery", fields: { ...done.fields } }),
        ),
        false,
      )?.icon,
    ).toBe("thread-briefs/done");
  });

  it("draws nothing while the agent is running, whatever the brief says", () => {
    // Live working outranks the stored status. bb hides a plugin row status for
    // a running thread anyway, and would let one displace its plan-mode or goal
    // glyph, which says more than a stored stage can.
    expect(rowDecoration(signalFor(blocked), true)).toBeNull();
    expect(rowDecoration(signalFor(done), true)).toBeNull();
    expect(rowDecoration(signalFor(stored()), true)).toBeNull();
  });

  it("restores the stored glyph once the thread goes idle again", () => {
    expect(rowDecoration(signalFor(blocked), false)?.icon).toBe(
      "thread-briefs/stage-implementation",
    );
  });

  describe("with a project", () => {
    const alpha = { id: "proj_alpha", name: "Alpha" };

    it("keeps the stage on the ring and puts the project in its colour", () => {
      // The suffix is the only difference: same stage, same artwork, repainted.
      const plain = rowDecoration(signalFor(stored()), false);
      const colored = rowDecoration(signalFor(stored()), false, alpha);
      expect(colored?.icon).toBe(
        `${plain?.icon}-c${projectColorIndex(alpha.id)}`,
      );
    });

    it("colours the closed ring too, and gives up the done green for it", () => {
      // Nothing is lost: `done` still has its own artwork and its own section
      // heading, where the project has neither.
      const decoration = rowDecoration(signalFor(done), false, alpha);
      expect(decoration?.icon).toBe(
        `thread-briefs/done-c${projectColorIndex(alpha.id)}`,
      );
    });

    it("never asks for the success tone, project or not", () => {
      // The colour channel means "project" on every row. A green surviving on
      // the rows that happen to reach here without a project would be a second
      // rule for the same channel, and an invisible one.
      expect(rowDecoration(signalFor(done), false, alpha)?.tone).toBe("default");
      expect(rowDecoration(signalFor(done), false)?.tone).toBe("default");
    });

    it("names the project in the label, since a hue cannot name itself", () => {
      expect(rowDecoration(signalFor(stored()), false, alpha)?.label).toBe(
        "Implementation — Waiting on you (Alpha)",
      );
    });

    it("still colours by id when the project's name has not loaded", () => {
      // The sidebar can hold a thread whose project is not in the list yet. The
      // colour comes from the id, so only the label's suffix waits.
      const decoration = rowDecoration(signalFor(stored()), false, {
        id: alpha.id,
        name: "",
      });
      expect(decoration?.icon).toBe(
        `thread-briefs/stage-implementation-c${projectColorIndex(alpha.id)}`,
      );
      expect(decoration?.label).toBe("Implementation — Waiting on you");
    });

    it("gives two projects different rings for the same stage", () => {
      const beta = { id: "proj_beta", name: "Beta" };
      expect(rowDecoration(signalFor(stored()), false, alpha)?.icon).not.toBe(
        rowDecoration(signalFor(stored()), false, beta)?.icon,
      );
    });

    it("draws nothing while the agent is running, project or not", () => {
      expect(rowDecoration(signalFor(stored()), true, alpha)).toBeNull();
    });
  });

  describe("gone cold", () => {
    const alpha = { id: "proj_alpha", name: "Alpha" };
    const stale = { idleMs: 2 * 24 * 60 * 60 * 1000, archiving: true };

    it("swaps the project's colour for the grey ring", () => {
      // The row has one channel. A thread on its way out of the sidebar has no
      // use for the colour that says whose project it is, so the grey takes it
      // rather than trying to share it.
      const decoration = rowDecoration(signalFor(done), false, alpha, stale);
      expect(decoration?.icon).toBe("thread-briefs/done-stale");
      expect(decoration?.tone).toBe("default");
    });

    it("says how long, and that it is on its way out", () => {
      // The shape still says done; nothing but the label says why the colour
      // has drained out of it or what happens next.
      expect(rowDecoration(signalFor(done), false, alpha, stale)?.label).toBe(
        "Implementation — Done · idle 2 days, archiving soon (Alpha)",
      );
    });

    it("does not promise an archiving that is switched off", () => {
      expect(
        rowDecoration(signalFor(done), false, alpha, {
          ...stale,
          archiving: false,
        })?.label,
      ).toBe("Implementation — Done · idle 2 days (Alpha)");
    });

    it("ignores staleness on a row that is not done", () => {
      // Only a finished thread can be finished-and-forgotten. A caller that
      // passed one anyway must not get the done ring drawn for it.
      const decoration = rowDecoration(signalFor(blocked), false, alpha, stale);
      expect(decoration?.icon).toBe(
        `thread-briefs/stage-implementation-c${projectColorIndex(alpha.id)}`,
      );
      expect(decoration?.label).toBe("Implementation — Blocked (Alpha)");
    });

    it("still draws nothing while the agent is running", () => {
      expect(rowDecoration(signalFor(done), true, alpha, stale)).toBeNull();
    });
  });
});

describe("idleFor", () => {
  const HOUR = 60 * 60 * 1000;

  it("is coarse, because it is recomputed on a timer", () => {
    // A phrase that changed every minute would rewrite every stale row's
    // status a thousand times a day to say the same thing.
    expect(idleFor(HOUR)).toBe("1 hour");
    expect(idleFor(5 * HOUR + 59 * 60 * 1000)).toBe("5 hours");
    expect(idleFor(24 * HOUR)).toBe("1 day");
    expect(idleFor(70 * HOUR)).toBe("2 days");
  });
});

describe("projectColorIndex", () => {
  it("is stable, so a project keeps its colour with nothing stored", () => {
    expect(projectColorIndex("proj_mdanshc55w")).toBe(
      projectColorIndex("proj_mdanshc55w"),
    );
  });

  it("always lands in the palette", () => {
    for (const id of ["", "a", "proj_vqkcc8yinn", "x".repeat(200)]) {
      const index = projectColorIndex(id);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PROJECT_RING_HUES.length);
    }
  });

  it("spreads a handful of real project ids over the palette", () => {
    // Not a guarantee — a hash may collide — but a palette that sent every id
    // to one slot would pass every other test here while being useless.
    const ids = Array.from({ length: 8 }, (_, i) => `proj_${i}abcdefghij`);
    expect(new Set(ids.map(projectColorIndex)).size).toBeGreaterThan(1);
  });
});

describe("projectRingColor", () => {
  it("gives each hue a light and a dark lightness", () => {
    // One lightness cannot serve both sidebars, and bb sets `color-scheme` on
    // both its themes, so `light-dark()` resolves without a re-render.
    const color = projectRingColor(0);
    expect(color).toMatch(/^light-dark\(oklch\(.+\), oklch\(.+\)\)$/);
    expect(color).toContain(`${PROJECT_RING_HUES[0]}`);
  });

  it("wraps, so an out-of-range slot cannot draw a colourless ring", () => {
    expect(projectRingColor(PROJECT_RING_HUES.length)).toBe(
      projectRingColor(0),
    );
  });
});

describe("planRename", () => {
  it("takes over bb's opening-prompt title the first time", () => {
    // `applied: null` is "we have never written one", so whatever is there is
    // bb's guess and replacing it is the whole point.
    expect(
      planRename({
        current: "The thread brief plugin generates some useful or...",
        desired: "Thread brief thread titles",
        applied: null,
      }),
    ).toBe("Thread brief thread titles");
  });

  it("titles a thread that never got one", () => {
    expect(
      planRename({ current: null, desired: "Kploy image tracking", applied: null }),
    ).toBe("Kploy image tracking");
  });

  it("updates a title it wrote itself", () => {
    expect(
      planRename({
        current: "Sidebar status grouping",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBe("Sidebar grouping teardown");
  });

  it("writes nothing when the thread already shows the name", () => {
    expect(
      planRename({
        current: "Sidebar status grouping",
        desired: "Sidebar status grouping",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("stops renaming once someone renames the thread by hand", () => {
    expect(
      planRename({
        current: "DO NOT TOUCH — release cut",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("stays stopped, because the caller leaves `applied` where it was", () => {
    // The next summary proposes something new again. Nothing was recorded when
    // the rename was skipped, so the mismatch is still there and still wins —
    // which is what makes the stop permanent without a flag to store.
    expect(
      planRename({
        current: "DO NOT TOUCH — release cut",
        desired: "A third suggestion entirely",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("backs off when the title moved while the summary was running", () => {
    // The first rename has no `applied` to compare against, so this is the
    // only thing standing between a mid-summary rename and being overwritten.
    expect(
      planRename({
        current: "Renamed mid-flight",
        observed: "Build me a thing that does...",
        desired: "Sidebar grouping teardown",
        applied: null,
      }),
    ).toBeNull();
  });

  it("proceeds when the title held still for the whole summary", () => {
    expect(
      planRename({
        current: "Build me a thing that does...",
        observed: "Build me a thing that does...",
        desired: "Sidebar grouping teardown",
        applied: null,
      }),
    ).toBe("Sidebar grouping teardown");
  });

  it("leaves the title alone when the model proposed nothing usable", () => {
    expect(
      planRename({ current: "Sidebar grouping", desired: undefined, applied: null }),
    ).toBeNull();
    expect(
      planRename({ current: "Sidebar grouping", desired: "   ", applied: null }),
    ).toBeNull();
  });

  it("does not count whitespace as a hand-rename", () => {
    expect(
      planRename({
        current: "  Sidebar status grouping  ",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBe("Sidebar grouping teardown");
  });
});

describe("summarizedAgo", () => {
  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const ago = (delta: number) => summarizedAgo(10 * DAY - delta, 10 * DAY);

  it("collapses the first minute into 'just now'", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * SECOND)).toBe("just now");
  });

  it("steps up a unit at a time, singular at one", () => {
    expect(ago(MINUTE)).toBe("1 minute ago");
    expect(ago(59 * MINUTE)).toBe("59 minutes ago");
    expect(ago(HOUR)).toBe("1 hour ago");
    expect(ago(23 * HOUR)).toBe("23 hours ago");
    expect(ago(DAY)).toBe("1 day ago");
    expect(ago(9 * DAY)).toBe("9 days ago");
  });

  it("does not count into the future when the clocks disagree", () => {
    // The timestamp is the server's and `now` is the browser's, so a brief can
    // legitimately read as written a few seconds from now.
    expect(summarizedAgo(10 * DAY + 30 * SECOND, 10 * DAY)).toBe("just now");
  });
});
