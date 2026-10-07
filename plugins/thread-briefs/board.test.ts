import { describe, expect, it } from "vitest";
import type { BriefCard } from "./contract.js";
import {
  BOARD_COLUMNS,
  DONE_COLUMN,
  NO_STAGE_COLUMN,
  NO_FILTERS,
  actorHint,
  buildRows,
  cardRingIcon,
  columnFor,
  compareRows,
  countByStatus,
  filtersFromLine,
  groupByColumn,
  isPinnedByHand,
  isStageColumn,
  layOutColumns,
  matchesFilters,
  planDrop,
  statusRank,
  lineFromFilters,
  lineFromView,
  toggleFilterValue,
  viewFromLine,
  visibleColumns,
  type BoardRow,
  type BoardRowThread,
} from "./board.js";
import {
  STALE_DONE_RING_ICON,
  doneRingIcon,
  stageRingIcon,
} from "./brief.js";
import { projectColorIndex } from "./shared.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const card = (overrides: Partial<BriefCard> = {}): BriefCard => ({
  threadId: "thr_1",
  stage: "implementation",
  modelStage: "implementation",
  status: "waiting-on-me",
  stageOverride: null,
  statusOverride: null,
  blockReason: null,
  nextStep: "Push the branch",
  blockedOn: "",
  lastSummarizedAt: NOW - 1000,
  ...overrides,
});

const thread = (overrides: Partial<BoardRowThread> = {}): BoardRowThread => ({
  id: "thr_1",
  projectId: "proj_alpha",
  displayTitle: "Thread briefs board",
  href: "/projects/proj_alpha/threads/thr_1",
  status: "idle",
  isPinned: false,
  isHidden: false,
  latestAttentionAt: NOW - 1000,
  ...overrides,
});

const rowsFor = (
  threads: readonly BoardRowThread[],
  cards: readonly BriefCard[],
  extra: { staleAfterMs?: number; archiveAfterMs?: number } = {},
) =>
  buildRows({
    threads,
    cards,
    projects: [{ id: "proj_alpha", name: "Alpha" }],
    now: NOW,
    staleAfterMs: extra.staleAfterMs ?? DAY,
    archiveAfterMs: extra.archiveAfterMs ?? 2 * DAY,
  });

const row = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  threadId: "thr_1",
  title: "Thread briefs board",
  href: "/t/1",
  project: { id: "proj_alpha", name: "Alpha" },
  isPinned: false,
  latestAttentionAt: NOW,
  status: "waiting-on-me",
  card: card(),
  stale: null,
  column: "implementation",
  ...overrides,
});

describe("columns", () => {
  it("runs stageless, then the four stages, then done", () => {
    expect(BOARD_COLUMNS).toEqual([
      "none",
      "discovery",
      "planning",
      "implementation",
      "review",
      "done",
    ]);
  });

  it("puts a thread with no brief in its own column", () => {
    // Briefs are never backfilled, so this is the normal state for a thread
    // that was dormant when the plugin arrived — and dropping it would make the
    // board indistinguishable from one where the thread was finished.
    expect(columnFor(null, null)).toBe(NO_STAGE_COLUMN);
    expect(columnFor(null, "working")).toBe(NO_STAGE_COLUMN);
  });

  it("puts a done thread in the terminal column whatever its stage", () => {
    expect(columnFor(card({ stage: "review" }), "done")).toBe(DONE_COLUMN);
    expect(columnFor(card({ stage: "discovery" }), "done")).toBe(DONE_COLUMN);
  });

  it("puts a running thread in its stage column even with a done brief", () => {
    // The fold is the point: the brief still says done until the next summary,
    // but a card sitting in Done while its agent is mid-turn is the board
    // contradicting the sidebar.
    expect(columnFor(card({ status: "done", stage: "review" }), "working")).toBe(
      "review",
    );
  });

  it("only the stage columns count as stage columns", () => {
    expect(isStageColumn("planning")).toBe(true);
    expect(isStageColumn(DONE_COLUMN)).toBe(false);
    expect(isStageColumn(NO_STAGE_COLUMN)).toBe(false);
  });
});

describe("buildRows", () => {
  it("joins a thread to its card", () => {
    const [built] = rowsFor([thread()], [card()]);
    expect(built?.title).toBe("Thread briefs board");
    expect(built?.project).toEqual({ id: "proj_alpha", name: "Alpha" });
    expect(built?.status).toBe("waiting-on-me");
    expect(built?.column).toBe("implementation");
  });

  it("keeps a thread with no card", () => {
    const [built] = rowsFor([thread()], []);
    expect(built?.card).toBeNull();
    expect(built?.status).toBeNull();
    expect(built?.column).toBe(NO_STAGE_COLUMN);
  });

  it("drops a card with no thread beside it", () => {
    // An archived thread's brief has no row in the sidebar view, so a card for
    // it would be something on the board that clicking cannot reach.
    expect(rowsFor([], [card()])).toEqual([]);
  });

  it("drops hidden threads", () => {
    expect(rowsFor([thread({ isHidden: true })], [card()])).toEqual([]);
  });

  it("folds a running thread to working", () => {
    const [built] = rowsFor([thread({ status: "active" })], [card()]);
    expect(built?.status).toBe("working");
  });

  it("greys a done thread that has gone cold, with the archive warning", () => {
    const [built] = rowsFor(
      [thread({ latestAttentionAt: NOW - 30 * 60 * 60 * 1000 })],
      [card({ status: "done", nextStep: "" })],
    );
    expect(built?.stale).toEqual({ idleMs: 30 * 60 * 60 * 1000, archiving: true });
  });

  it("does not grey a done thread that finished this morning", () => {
    const [built] = rowsFor(
      [thread({ latestAttentionAt: NOW - 60 * 60 * 1000 })],
      [card({ status: "done", nextStep: "" })],
    );
    expect(built?.stale).toBeNull();
  });

  it("never greys a thread that is not done", () => {
    const [built] = rowsFor([thread({ latestAttentionAt: NOW - 9 * DAY })], [card()]);
    expect(built?.stale).toBeNull();
  });

  it("says nothing about archiving when the sweep is off", () => {
    const [built] = rowsFor(
      [thread({ latestAttentionAt: NOW - 9 * DAY })],
      [card({ status: "done", nextStep: "" })],
      { archiveAfterMs: 0 },
    );
    expect(built?.stale?.archiving).toBe(false);
  });

  it("colours a row from an id whose project is not in the list yet", () => {
    const [built] = rowsFor([thread({ projectId: "proj_new" })], [card()]);
    expect(built?.project).toEqual({ id: "proj_new", name: "" });
  });

  it("leaves a projectless thread with no project", () => {
    const [built] = rowsFor([thread({ projectId: "" })], [card()]);
    expect(built?.project).toBeNull();
  });
});

describe("ordering", () => {
  it("ranks waiting on you above blocked, working and done", () => {
    expect(statusRank("waiting-on-me")).toBeLessThan(
      statusRank("waiting-on-other"),
    );
    // Working ranks low on purpose: the agent has it, so it is the one row
    // making progress without you.
    expect(statusRank("waiting-on-other")).toBeLessThan(statusRank("working"));
    expect(statusRank("working")).toBeLessThan(statusRank("done"));
    expect(statusRank("done")).toBeLessThan(statusRank(null));
  });

  it("puts a pin above everything inferred", () => {
    const pinned = row({ threadId: "a", isPinned: true, status: "done" });
    const urgent = row({ threadId: "b", status: "waiting-on-me" });
    expect([urgent, pinned].sort(compareRows)[0]).toBe(pinned);
  });

  it("breaks a status tie by recency, then by id", () => {
    const older = row({ threadId: "a", latestAttentionAt: NOW - 1000 });
    const newer = row({ threadId: "b", latestAttentionAt: NOW });
    expect([older, newer].sort(compareRows)).toEqual([newer, older]);
    const same = [
      row({ threadId: "b" }),
      row({ threadId: "a" }),
    ].sort(compareRows);
    expect(same.map((entry) => entry.threadId)).toEqual(["a", "b"]);
  });

  it("groups into every requested column, empty ones included", () => {
    const grouped = groupByColumn([row({ column: "review" })], [
      "planning",
      "review",
    ]);
    expect(grouped.map((entry) => entry.column)).toEqual(["planning", "review"]);
    expect(grouped[0]?.rows).toEqual([]);
    expect(grouped[1]?.rows).toHaveLength(1);
  });

  it("drops a row whose column is not being drawn", () => {
    expect(groupByColumn([row({ column: "done" })], ["review"])[0]?.rows).toEqual(
      [],
    );
  });
});

describe("filters", () => {
  it("keeps everything with no filters", () => {
    expect(matchesFilters(row(), NO_FILTERS)).toBe(true);
    expect(matchesFilters(row({ card: null, status: null }), NO_FILTERS)).toBe(
      true,
    );
  });

  it("matches a project filter on the row's project", () => {
    const filters = { projectIds: ["proj_alpha"], statuses: [] };
    expect(matchesFilters(row(), filters)).toBe(true);
    expect(
      matchesFilters(row({ project: { id: "proj_beta", name: "B" } }), filters),
    ).toBe(false);
    expect(matchesFilters(row({ project: null }), filters)).toBe(false);
  });

  it("drops a briefless row from any status filter", () => {
    // Asking for "waiting on you" is asking a question only a brief can answer.
    const filters = { projectIds: [], statuses: ["waiting-on-me" as const] };
    expect(matchesFilters(row({ card: null, status: null }), filters)).toBe(
      false,
    );
  });

  it("hides the No stage column as soon as a status is asked for", () => {
    expect(visibleColumns(NO_FILTERS)).toEqual([...BOARD_COLUMNS]);
    expect(
      visibleColumns({ projectIds: [], statuses: ["waiting-on-me"] }),
    ).toEqual(["discovery", "planning", "implementation", "review"]);
  });

  it("keeps Done only when done is asked for", () => {
    expect(visibleColumns({ projectIds: [], statuses: ["done"] })).toEqual([
      "done",
    ]);
    expect(
      visibleColumns({ projectIds: [], statuses: ["waiting-on-me", "done"] }),
    ).toEqual(["discovery", "planning", "implementation", "review", "done"]);
  });

  it("leaves every stage column standing under a status filter", () => {
    // A status says nothing about how far along a thread is, which is the whole
    // reason the two axes are separate.
    expect(
      visibleColumns({ projectIds: [], statuses: ["working"] }),
    ).toContain("discovery");
  });

  it("round-trips through the stored line", () => {
    const filters = {
      projectIds: ["proj_b", "proj_a"],
      statuses: ["done" as const, "waiting-on-me" as const],
    };
    const line = lineFromFilters(filters);
    expect(line).toBe("project:proj_a,proj_b/status:waiting-on-me,done");
    expect(filtersFromLine(line)).toEqual({
      projectIds: ["proj_a", "proj_b"],
      statuses: ["waiting-on-me", "done"],
    });
  });

  it("writes an empty line for no filters, so nothing stored is the unfiltered board", () => {
    expect(lineFromFilters(NO_FILTERS)).toBe("");
    expect(filtersFromLine("")).toEqual({ projectIds: [], statuses: [] });
  });

  it("is canonical, so the same filter always produces the same line", () => {
    expect(
      lineFromFilters({ projectIds: ["b", "a"], statuses: ["done"] }),
    ).toBe(lineFromFilters({ projectIds: ["a", "b"], statuses: ["done"] }));
  });

  it("ignores anything it does not recognise rather than failing", () => {
    // This parses storage, which outlives the build that wrote it.
    expect(filtersFromLine("status:nonsense/colour:red/nope")).toEqual({
      projectIds: [],
      statuses: [],
    });
  });

  it("escapes project ids and reads them back", () => {
    const line = lineFromFilters({
      projectIds: ["with/slash"],
      statuses: [],
    });
    expect(line).not.toContain("with/slash");
    expect(filtersFromLine(line).projectIds).toEqual(["with/slash"]);
  });

  it("de-duplicates repeated values", () => {
    expect(filtersFromLine("status:done,done/project:a,a").statuses).toEqual([
      "done",
    ]);
  });

  it("toggles a value on and off", () => {
    expect(toggleFilterValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleFilterValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("counts by status for the chips", () => {
    const counts = countByStatus([
      row({ threadId: "a", status: "waiting-on-me" }),
      row({ threadId: "b", status: "waiting-on-me" }),
      row({ threadId: "c", status: null, card: null }),
    ]);
    expect(counts["waiting-on-me"]).toBe(2);
    expect(counts.done).toBe(0);
  });
});

describe("the layout", () => {
  const layout = (
    rows: readonly BoardRow[],
    extra: Partial<Parameters<typeof layOutColumns>[0]> = {},
  ) =>
    new Map(
      layOutColumns({
        rows,
        filters: NO_FILTERS,
        expanded: [],
        ...extra,
      }).map((entry) => [entry.column, entry] as const),
    );

  it("collapses Done by default, cards and all", () => {
    // The one column whose contents are by definition not work. It keeps its
    // cards — they are just behind a rail — so nothing has left the board.
    const done = layout([row({ status: "done", column: DONE_COLUMN })]).get(
      DONE_COLUMN,
    );
    expect(done?.isCollapsed).toBe(true);
    expect(done?.rows).toHaveLength(1);
    expect(done?.canToggle).toBe(true);
  });

  it("opens Done when the URL says it is expanded", () => {
    expect(
      layout([row({ status: "done", column: DONE_COLUMN })], {
        expanded: [DONE_COLUMN],
      }).get(DONE_COLUMN)?.isCollapsed,
    ).toBe(false);
  });

  it("collapses No stage only while it is empty", () => {
    expect(layout([]).get(NO_STAGE_COLUMN)?.isCollapsed).toBe(true);
    // Once it holds something, the Summarize button on those cards is the point.
    expect(
      layout([row({ card: null, status: null, column: NO_STAGE_COLUMN })]).get(
        NO_STAGE_COLUMN,
      )?.isCollapsed,
    ).toBe(false);
  });

  it("offers no toggle on a rail with nothing behind it", () => {
    // Pressing it would open an empty column, and the count already said so.
    expect(layout([]).get(NO_STAGE_COLUMN)?.canToggle).toBe(false);
  });

  it("never collapses the only column on the board", () => {
    // `status:done` leaves Done alone; collapsing it would leave a board that is
    // one closed strip and no way to read what was asked for.
    const only = layOutColumns({
      rows: [row({ status: "done", column: DONE_COLUMN })],
      filters: { projectIds: [], statuses: ["done"] },
      expanded: [],
    });
    expect(only).toHaveLength(1);
    expect(only[0]?.isCollapsed).toBe(false);
    expect(only[0]?.canToggle).toBe(false);
  });

  it("never collapses a stage column", () => {
    for (const stage of ["discovery", "planning", "implementation", "review"]) {
      const entry = layout([]).get(stage as never);
      expect(entry?.isCollapsed).toBe(false);
      expect(entry?.canToggle).toBe(false);
    }
  });

  it("keeps the cards sorted inside a collapsed column", () => {
    // Collapsing is a width, not a different grouping: expanding must not
    // reshuffle what was already computed.
    const pinned = row({ threadId: "a", isPinned: true, column: DONE_COLUMN, status: "done" });
    const other = row({ threadId: "b", column: DONE_COLUMN, status: "done" });
    expect(
      layout([other, pinned]).get(DONE_COLUMN)?.rows.map((entry) => entry.threadId),
    ).toEqual(["a", "b"]);
  });
});

describe("the stored view", () => {
  it("round-trips filters and expansion together", () => {
    const line = lineFromView({
      filters: { projectIds: ["proj_a"], statuses: ["done"] },
      expanded: [DONE_COLUMN],
    });
    expect(line).toBe("project:proj_a/status:done/expand:done");
    expect(viewFromLine(line)).toEqual({
      filters: { projectIds: ["proj_a"], statuses: ["done"] },
      expanded: [DONE_COLUMN],
    });
  });

  it("writes an empty line for the default view", () => {
    expect(lineFromView({ filters: NO_FILTERS, expanded: [] })).toBe("");
    expect(viewFromLine("")).toEqual({
      filters: { projectIds: [], statuses: [] },
      expanded: [],
    });
  });

  it("is additive, so a line stored before this existed still parses", () => {
    expect(viewFromLine("status:done")).toEqual({
      filters: { projectIds: [], statuses: ["done"] },
      expanded: [],
    });
    // And the filters alone still read out of a line that carries an expansion.
    expect(filtersFromLine("status:done/expand:done").statuses).toEqual([
      "done",
    ]);
  });

  it("ignores a column that cannot collapse anyway", () => {
    expect(viewFromLine("expand:review,nonsense").expanded).toEqual([]);
  });

  it("is canonical, so one view is always one string", () => {
    expect(
      lineFromView({
        filters: NO_FILTERS,
        expanded: [DONE_COLUMN, NO_STAGE_COLUMN],
      }),
    ).toBe(
      lineFromView({
        filters: NO_FILTERS,
        expanded: [NO_STAGE_COLUMN, DONE_COLUMN],
      }),
    );
  });
});

describe("planDrop", () => {
  it("pins the stage you dropped on", () => {
    expect(planDrop(row(), "review")).toEqual([
      { kind: "stage", stage: "review" },
    ]);
  });

  it("clears the pin when you drop on the stage the summarizer chose", () => {
    // Dragging a card back to where it would sit by itself is a statement that
    // the model was right; pinning it there would leave a pin doing nothing.
    const pinned = row({
      card: card({ stage: "review", modelStage: "planning", stageOverride: "review" }),
      column: "review",
    });
    expect(planDrop(pinned, "planning")).toEqual([
      { kind: "stage", stage: null },
    ]);
  });

  it("does nothing when the card is already where you dropped it", () => {
    expect(planDrop(row(), "implementation")).toEqual([]);
    expect(planDrop(row({ column: DONE_COLUMN, status: "done" }), DONE_COLUMN)).toEqual(
      [],
    );
  });

  it("pins done when you drop on the terminal column", () => {
    expect(planDrop(row(), DONE_COLUMN)).toEqual([
      { kind: "status", status: "done" },
    ]);
  });

  it("pins waiting-on-me when you drag out of Done", () => {
    // Clearing the pin instead would hand the card back to a derivation that may
    // still say done, and it would snap straight back into the column you just
    // dragged it out of.
    const done = row({
      status: "done",
      column: DONE_COLUMN,
      card: card({ status: "done", nextStep: "", stage: "review", modelStage: "review" }),
    });
    expect(planDrop(done, "review")).toEqual([
      { kind: "status", status: "waiting-on-me" },
    ]);
  });

  it("writes the status before the stage when a drag out of Done changes both", () => {
    const done = row({
      status: "done",
      column: DONE_COLUMN,
      card: card({ status: "done", nextStep: "", stage: "review", modelStage: "review" }),
    });
    expect(planDrop(done, "planning")).toEqual([
      { kind: "status", status: "waiting-on-me" },
      { kind: "stage", stage: "planning" },
    ]);
  });

  it("refuses the No stage column in both directions", () => {
    expect(planDrop(row(), NO_STAGE_COLUMN)).toEqual([]);
    expect(
      planDrop(row({ card: null, status: null, column: NO_STAGE_COLUMN }), "review"),
    ).toEqual([]);
  });
});

describe("card presentation", () => {
  it("draws the stage ring in the project's colour", () => {
    expect(cardRingIcon(row())).toBe(
      stageRingIcon("implementation", projectColorIndex("proj_alpha")),
    );
  });

  it("draws the closed ring for done and the grey one once cold", () => {
    const done = row({ status: "done", column: DONE_COLUMN });
    expect(cardRingIcon(done)).toBe(
      doneRingIcon(projectColorIndex("proj_alpha")),
    );
    expect(
      cardRingIcon({ ...done, stale: { idleMs: 2 * DAY, archiving: true } }),
    ).toBe(STALE_DONE_RING_ICON);
  });

  it("still draws the brief's ring for a working card", () => {
    // Unlike the sidebar row, where bb has a live glyph of its own to put there.
    expect(cardRingIcon(row({ status: "working" }))).toBe(
      stageRingIcon("implementation", projectColorIndex("proj_alpha")),
    );
  });

  it("draws no ring for a briefless card", () => {
    expect(cardRingIcon(row({ card: null, status: null }))).toBeNull();
  });

  it("marks a card with either pin in force", () => {
    expect(isPinnedByHand(card())).toBe(false);
    expect(isPinnedByHand(card({ stageOverride: "review" }))).toBe(true);
    expect(isPinnedByHand(card({ statusOverride: "done" }))).toBe(true);
    expect(isPinnedByHand(null)).toBe(false);
  });

  it("says when the agent could carry on by itself", () => {
    // `deriveStatus` collapses an agent-owned next step into waiting-on-me, so
    // two "Waiting on you" cards can want very different amounts of work.
    expect(actorHint(card({ nextStepActor: "agent" }), "waiting-on-me")).toBe(
      "agent can continue",
    );
    expect(actorHint(card({ nextStepActor: "me" }), "waiting-on-me")).toBeNull();
    expect(actorHint(card({ nextStepActor: "agent" }), "done")).toBeNull();
    expect(actorHint(null, "waiting-on-me")).toBeNull();
  });
});
