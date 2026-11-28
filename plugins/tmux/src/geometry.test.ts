import { describe, expect, it } from "vitest";
import {
  findDirectionalPane,
  findNextPane,
  findPaneAcrossWindow,
  findPaneFromZoomedPane,
} from "./geometry";
import type { Direction, SplitPane } from "./types";

function pane(
  paneId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SplitPane {
  return { paneId, rect: { x, y, width, height }, threadId: null, isFocused: false };
}

function neighbour(
  panes: readonly SplitPane[],
  from: string,
  direction: Direction,
): string | null {
  return findDirectionalPane(panes, from, direction)?.paneId ?? null;
}

describe("findDirectionalPane in a 2x2 grid", () => {
  const grid = [
    pane("top-left", 0, 0, 0.5, 0.5),
    pane("bottom-left", 0, 0.5, 0.5, 0.5),
    pane("top-right", 0.5, 0, 0.5, 0.5),
    pane("bottom-right", 0.5, 0.5, 0.5, 0.5),
  ];

  it("moves to the pane that shares the edge in each direction", () => {
    expect(neighbour(grid, "top-left", "right")).toBe("top-right");
    expect(neighbour(grid, "top-left", "down")).toBe("bottom-left");
    expect(neighbour(grid, "bottom-right", "left")).toBe("bottom-left");
    expect(neighbour(grid, "bottom-right", "up")).toBe("top-right");
    expect(neighbour(grid, "top-right", "left")).toBe("top-left");
    expect(neighbour(grid, "bottom-left", "up")).toBe("top-left");
  });

  it("returns null at every outer edge, where no pane lies on that side", () => {
    expect(neighbour(grid, "top-left", "left")).toBeNull();
    expect(neighbour(grid, "top-left", "up")).toBeNull();
    expect(neighbour(grid, "bottom-left", "left")).toBeNull();
    expect(neighbour(grid, "bottom-left", "down")).toBeNull();
    expect(neighbour(grid, "top-right", "right")).toBeNull();
    expect(neighbour(grid, "top-right", "up")).toBeNull();
    expect(neighbour(grid, "bottom-right", "right")).toBeNull();
    expect(neighbour(grid, "bottom-right", "down")).toBeNull();
  });

  it("does not jump diagonally to a pane that only touches at a corner", () => {
    const corners = [
      pane("top-left", 0, 0, 0.5, 0.5),
      pane("bottom-right", 0.5, 0.5, 0.5, 0.5),
    ];
    expect(neighbour(corners, "top-left", "right")).toBeNull();
    expect(neighbour(corners, "top-left", "down")).toBeNull();
    expect(neighbour(corners, "bottom-right", "left")).toBeNull();
    expect(neighbour(corners, "bottom-right", "up")).toBeNull();
  });

  it("returns the pane object from the layout", () => {
    expect(findDirectionalPane(grid, "top-left", "right")).toBe(grid[2]);
  });
});

describe("findDirectionalPane in an L-shaped layout", () => {
  // The same layout bb's own getDirectionalPaneId test uses: a full-height
  // pane on the left, and an unequal column split on the right.
  const layout = [
    pane("left", 0, 0, 0.4, 1),
    pane("top", 0.4, 0, 0.6, 0.3),
    pane("bottom", 0.4, 0.3, 0.6, 0.7),
  ];

  it("follows geometry across nested and unequal splits", () => {
    expect(neighbour(layout, "left", "right")).toBe("bottom");
    expect(neighbour(layout, "bottom", "up")).toBe("top");
    expect(neighbour(layout, "top", "down")).toBe("bottom");
    expect(neighbour(layout, "top", "left")).toBe("left");
    expect(neighbour(layout, "bottom", "left")).toBe("left");
  });

  it("finds no pane beyond the edges of the layout", () => {
    expect(neighbour(layout, "top", "up")).toBeNull();
    expect(neighbour(layout, "bottom", "right")).toBeNull();
    expect(neighbour(layout, "bottom", "down")).toBeNull();
    expect(neighbour(layout, "left", "down")).toBeNull();
    expect(neighbour(layout, "left", "up")).toBeNull();
    expect(neighbour(layout, "left", "left")).toBeNull();
  });
});

describe("findDirectionalPane tie-breaking", () => {
  it("prefers the nearest pane over a farther one in the same direction", () => {
    const row = [
      pane("a", 0, 0, 0.25, 1),
      pane("b", 0.25, 0, 0.25, 1),
      pane("c", 0.5, 0, 0.5, 1),
    ];
    expect(neighbour(row, "a", "right")).toBe("b");
    expect(neighbour(row, "c", "left")).toBe("b");
  });

  it("picks the pane whose centre is closest when several are equally near", () => {
    const layout = [
      pane("left", 0, 0, 0.5, 1),
      pane("top", 0.5, 0, 0.5, 0.2),
      pane("middle", 0.5, 0.2, 0.5, 0.5),
      pane("bottom", 0.5, 0.7, 0.5, 0.3),
    ];
    expect(neighbour(layout, "left", "right")).toBe("middle");
  });

  it("keeps the first pane in layout order when gap and centre distance are equal", () => {
    const layout = [
      pane("left", 0, 0, 0.5, 1),
      pane("top", 0.5, 0, 0.5, 0.5),
      pane("bottom", 0.5, 0.5, 0.5, 0.5),
    ];
    expect(neighbour(layout, "left", "right")).toBe("top");
    expect(neighbour([...layout].reverse(), "left", "right")).toBe("bottom");
  });

  it("tolerates floating point error in shared edges", () => {
    const row = [
      pane("a", 0, 0, 0.1, 1),
      pane("b", 0.1, 0, 0.2, 1),
      pane("c", 0.3, 0, 0.7, 1),
    ];
    expect(0.3 - 0.1 - 0.2).toBeLessThan(0);
    expect(neighbour(row, "b", "right")).toBe("c");
    expect(neighbour(row, "c", "left")).toBe("b");
    expect(neighbour(row, "a", "right")).toBe("b");
  });
});

describe("findDirectionalPane with the panes that had the focus", () => {
  // A on the left over the full height, B top right, C bottom right.
  const layout = [
    pane("a", 0, 0, 0.5, 1),
    pane("b", 0.5, 0, 0.5, 0.5),
    pane("c", 0.5, 0.5, 0.5, 0.5),
  ];

  function neighbourAfter(
    focusOrder: readonly string[],
    from: string,
    direction: Direction,
  ): string | null {
    return findDirectionalPane(layout, from, direction, focusOrder)?.paneId ?? null;
  }

  it("goes back to the pane that had the focus last among the equally near ones, as tmux does", () => {
    expect(neighbourAfter(["a", "c", "b"], "a", "right")).toBe("c");
    expect(neighbourAfter(["a", "b", "c"], "a", "right")).toBe("b");
  });

  it("prefers a pane that had the focus over one that never had it, whatever its place", () => {
    expect(neighbourAfter(["a", "c"], "a", "right")).toBe("c");
  });

  it("falls back to the centre rule when none of the equally near panes had the focus", () => {
    expect(neighbourAfter(["a"], "a", "right")).toBe("b");
    expect(neighbourAfter([], "a", "right")).toBe("b");
  });

  it("still prefers a nearer pane over a farther one that had the focus later", () => {
    const row = [
      pane("a", 0, 0, 0.25, 1),
      pane("b", 0.25, 0, 0.25, 1),
      pane("c", 0.5, 0, 0.5, 1),
    ];

    expect(findDirectionalPane(row, "a", "right", ["a", "c", "b"])?.paneId).toBe("b");
  });
});

describe("findPaneAcrossWindow", () => {
  function across(
    panes: readonly SplitPane[],
    from: string,
    direction: Direction,
    focusOrder: readonly string[] = [],
  ): string | null {
    return findPaneAcrossWindow(panes, from, direction, focusOrder)?.paneId ?? null;
  }

  const row = [pane("left", 0, 0, 0.5, 1), pane("right", 0.5, 0, 0.5, 1)];
  const column = [pane("top", 0, 0, 1, 0.5), pane("bottom", 0, 0.5, 1, 0.5)];

  it("goes from the right edge of the window to the pane at its left edge", () => {
    expect(across(row, "right", "right")).toBe("left");
  });

  it("goes from the bottom edge to the pane at the top, and from the top edge to the one at the bottom", () => {
    expect(across(column, "bottom", "down")).toBe("top");
    expect(across(column, "top", "up")).toBe("bottom");
  });

  it("goes from the left edge to the pane at the right edge", () => {
    expect(across(row, "left", "left")).toBe("right");
  });

  it("only takes a pane that overlaps the focused pane on the other axis", () => {
    const grid = [
      pane("top-left", 0, 0, 0.5, 0.5),
      pane("bottom-left", 0, 0.5, 0.5, 0.5),
      pane("top-right", 0.5, 0, 0.5, 0.5),
      pane("bottom-right", 0.5, 0.5, 0.5, 0.5),
    ];

    expect(across(grid, "top-right", "right")).toBe("top-left");
    expect(across(grid, "bottom-right", "right")).toBe("bottom-left");
    expect(across(grid, "bottom-left", "down")).toBe("top-left");
    expect(across(grid, "top-right", "up")).toBe("bottom-right");
  });

  it("never takes the focused pane itself, so a pane as wide as the window stays", () => {
    expect(across(column, "top", "right")).toBeNull();
    expect(across(row, "left", "down")).toBeNull();
    expect(across([pane("only", 0, 0, 1, 1)], "only", "right")).toBeNull();
  });

  it("takes the pane that had the focus last among the ones at the opposite edge", () => {
    const layout = [
      pane("top-left", 0, 0, 0.5, 0.5),
      pane("bottom-left", 0, 0.5, 0.5, 0.5),
      pane("right", 0.5, 0, 0.5, 1),
    ];

    expect(across(layout, "right", "right", ["right", "bottom-left"])).toBe(
      "bottom-left",
    );
    expect(across(layout, "right", "right")).toBe("top-left");
  });

  it("tolerates floating point error at the edge of the window", () => {
    const layout = [
      pane("a", 0, 0, 0.1, 1),
      pane("b", 0.1, 0, 0.2, 1),
      pane("c", 0.1 + 0.2, 0, 0.7, 1),
    ];

    expect(across(layout, "a", "left")).toBe("c");
    expect(across(layout, "c", "right")).toBe("a");
  });

  it("returns null when the focused pane is not in the layout, and for no panes", () => {
    expect(across(row, "missing", "right")).toBeNull();
    expect(across([], "only", "right")).toBeNull();
  });
});

// tmux resolves a target such as {left-of} while the window is still zoomed:
// the zoomed pane fills the window, and the other panes are where they were
// (window_zoom in window.c, layout_fix_panes in layout.c).
describe("findPaneFromZoomedPane", () => {
  function fromZoomed(
    panes: readonly SplitPane[],
    from: string,
    direction: Direction,
    focusOrder: readonly string[] = [],
  ): string | null {
    return findPaneFromZoomedPane(panes, from, direction, focusOrder)?.paneId ?? null;
  }

  const row = [pane("left", 0, 0, 0.5, 1), pane("right", 0.5, 0, 0.5, 1)];
  const column = [pane("top", 0, 0, 1, 0.5), pane("bottom", 0, 0.5, 1, 0.5)];
  const grid = [
    pane("top-left", 0, 0, 0.5, 0.5),
    pane("bottom-left", 0, 0.5, 0.5, 0.5),
    pane("top-right", 0.5, 0, 0.5, 0.5),
    pane("bottom-right", 0.5, 0.5, 0.5, 0.5),
  ];

  it("goes around the edge of the window on every side, to a pane at the opposite edge", () => {
    expect(fromZoomed(row, "left", "left")).toBe("right");
    expect(fromZoomed(row, "right", "right")).toBe("left");
    expect(fromZoomed(column, "top", "up")).toBe("bottom");
    expect(fromZoomed(column, "bottom", "down")).toBe("top");
  });

  it("finds no pane where the zoomed pane is the only one at the opposite edge, although a pane lies on that side", () => {
    expect(fromZoomed(row, "left", "right")).toBeNull();
    expect(fromZoomed(row, "right", "left")).toBeNull();
    expect(fromZoomed(column, "top", "down")).toBeNull();
    expect(fromZoomed(column, "bottom", "up")).toBeNull();
  });

  it("takes a pane beside the zoomed one for a side on the other axis, where no pane lies without the zoom", () => {
    expect(fromZoomed(row, "left", "up")).toBe("right");
    expect(fromZoomed(row, "left", "down")).toBe("right");
    expect(fromZoomed(column, "top", "left")).toBe("bottom");
    expect(fromZoomed(column, "top", "right")).toBe("bottom");
  });

  it("takes a pane at the opposite edge that does not overlap the place of the zoomed pane", () => {
    expect(fromZoomed(grid, "top-left", "left", ["top-left", "bottom-right"])).toBe(
      "bottom-right",
    );
    expect(fromZoomed(grid, "top-left", "up", ["top-left", "bottom-right"])).toBe(
      "bottom-right",
    );
  });

  it("takes the pane that had the focus last among the ones at the opposite edge, and the first one in layout order when none had it", () => {
    expect(fromZoomed(grid, "top-left", "left", ["top-left", "top-right"])).toBe(
      "top-right",
    );
    expect(fromZoomed(grid, "top-left", "left")).toBe("top-right");
    expect(fromZoomed(grid, "top-left", "right")).toBe("bottom-left");
    expect(fromZoomed(grid, "bottom-right", "down", ["top-right", "top-left"])).toBe(
      "top-right",
    );
  });

  it("passes over the panes in the middle of a row", () => {
    const three = [
      pane("a", 0, 0, 0.25, 1),
      pane("b", 0.25, 0, 0.5, 1),
      pane("c", 0.75, 0, 0.25, 1),
    ];

    expect(fromZoomed(three, "a", "left")).toBe("c");
    expect(fromZoomed(three, "a", "right")).toBeNull();
    expect(fromZoomed(three, "b", "right")).toBe("a");
    expect(fromZoomed(three, "b", "left")).toBe("c");
  });

  it("returns null for a single pane, when the zoomed pane is not in the layout, and for no panes", () => {
    expect(fromZoomed([pane("only", 0, 0, 1, 1)], "only", "left")).toBeNull();
    expect(fromZoomed(row, "missing", "left")).toBeNull();
    expect(fromZoomed([], "only", "left")).toBeNull();
  });
});

describe("findDirectionalPane edge cases", () => {
  it("returns null when the focused pane is not in the layout", () => {
    const row = [pane("a", 0, 0, 0.5, 1), pane("b", 0.5, 0, 0.5, 1)];
    expect(neighbour(row, "missing", "right")).toBeNull();
  });

  it("returns null for a single pane and for no panes", () => {
    expect(neighbour([pane("only", 0, 0, 1, 1)], "only", "left")).toBeNull();
    expect(neighbour([], "only", "left")).toBeNull();
  });
});

describe("findNextPane", () => {
  function next(panes: readonly SplitPane[], from: string): string | null {
    return findNextPane(panes, from)?.paneId ?? null;
  }

  function round(panes: readonly SplitPane[], from: string): string[] {
    const visited: string[] = [];
    let current: string | null = from;
    for (let step = 0; step < panes.length && current !== null; step += 1) {
      current = next(panes, current);
      if (current !== null) visited.push(current);
    }
    return visited;
  }

  it("goes through the panes in the order bb lists them in, and from the last pane back to the first", () => {
    const row = [
      pane("a", 0, 0, 0.25, 1),
      pane("b", 0.25, 0, 0.25, 1),
      pane("c", 0.5, 0, 0.5, 1),
    ];
    expect(round(row, "a")).toEqual(["b", "c", "a"]);
  });

  it("goes the other way round for a step of -1, and from the first pane to the last", () => {
    const grid = [
      pane("top-left", 0, 0, 0.5, 0.5),
      pane("top-right", 0.5, 0, 0.5, 0.5),
      pane("bottom-left", 0, 0.5, 0.5, 0.5),
    ];

    expect(findNextPane(grid, "bottom-left", -1)?.paneId).toBe("top-right");
    expect(findNextPane(grid, "top-right", -1)?.paneId).toBe("top-left");
    expect(findNextPane(grid, "top-left", -1)?.paneId).toBe("bottom-left");
    expect(findNextPane(grid, "nowhere", -1)).toBeNull();
    expect(findNextPane([grid[0]], "top-left", -1)?.paneId).toBe("top-left");
  });

  it("follows the splits as the pane list of tmux does, not the place of the panes", () => {
    // A was split to the right (A, B) and then A downwards (A, C, B): the new
    // pane comes right after the pane it was split from.
    const layout = [
      pane("a", 0, 0, 0.5, 0.5),
      pane("c", 0, 0.5, 0.5, 0.5),
      pane("b", 0.5, 0, 0.5, 1),
    ];

    expect(round(layout, "a")).toEqual(["c", "b", "a"]);
    expect(findNextPane(layout, "a", -1)?.paneId).toBe("b");
  });

  it("is the pane itself when it is the only one", () => {
    expect(next([pane("only", 0, 0, 1, 1)], "only")).toBe("only");
  });

  it("returns null when the focused pane is not in the layout, and for no panes", () => {
    const row = [pane("a", 0, 0, 0.5, 1), pane("b", 0.5, 0, 0.5, 1)];
    expect(next(row, "missing")).toBeNull();
    expect(next([], "only")).toBeNull();
  });

  it("does not change the list it is given", () => {
    const layout = [pane("b", 0.5, 0, 0.5, 1), pane("a", 0, 0, 0.5, 1)];
    next(layout, "a");
    expect(layout.map((entry) => entry.paneId)).toEqual(["b", "a"]);
  });
});
