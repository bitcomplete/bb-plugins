import { describe, expect, it } from "vitest";
import {
  CAPTION_SIDES,
  EASE,
  LABEL_FIT,
  PACK,
  SETTLE,
  TURN,
  containerFade,
  distance,
  boxHitsCircle,
  boxesOverlap,
  ease,
  enclose,
  fitBox,
  fitView,
  flatten,
  flightMix,
  flightMs,
  flyView,
  gapFor,
  interpolateLayouts,
  labelAlpha,
  labelForm,
  leafRadius,
  massBox,
  midpoint,
  packLayout,
  packSiblings,
  pinchView,
  placeCaptions,
  quantizeRadius,
  quantizeWeight,
  radiusFor,
  rimProgress,
  settle,
  stackEdges,
  turnTilt,
  zoomAt,
  type Box,
  type CaptionRequest,
  type Circle,
  type LayoutNode,
  type PackLayout,
} from "./layout.js";

/**
 * The layout is generic over the grouping hierarchy, so the tests build the
 * same shape app.tsx maps a board into: group → group → leaf, with `data`
 * carrying whatever the renderer needs and the layout never reads.
 */
type Datum = { kind: string; stack?: { id: string; position: number }[] };

function leaf(key: string, weight = 1, stack?: { id: string; position: number }[]): LayoutNode<Datum> {
  return { key, label: key, weight, data: { kind: "cluster", stack } };
}

function group(key: string, label: string, children: LayoutNode<Datum>[]): LayoutNode<Datum> {
  return { key, label, data: { kind: "group" }, children };
}

/** A program of two efforts, a lone effort, and a wide effort of many tickets. */
const BOARD: LayoutNode<Datum>[] = [
  group("storefront", "Storefront", [
    group("cart", "Cart", [
      leaf("ABC-101", 8),
      leaf("ABC-102", 2),
      leaf("ABC-103", 6),
      leaf("ABC-104", 12),
    ]),
    group("wishlists", "Wishlists", [leaf("OPS-3333", 5), leaf("OPS-4444", 3)]),
  ]),
  group("search", "Search tuning", [leaf("OPS-5555", 4)]),
  group("wrapping", "Gift wrapping", [
    leaf("SHOP-1", 1),
    leaf("SHOP-2", 9),
    leaf("SHOP-3", 7),
    leaf("SHOP-4", 2),
  ]),
  group("legacy", "Legacy cleanup", [leaf("WEB-9", 1)]),
];

/** Geometry only — key, depth, position, radius — for byte-level comparison. */
function geometry(layout: PackLayout<unknown>): Map<string, [number, number, number, number]> {
  return new Map(flatten(layout).map((c) => [c.key, [c.depth, c.x, c.y, c.r]]));
}

/** Replace one leaf's weight anywhere in the tree. */
function withWeight(nodes: readonly LayoutNode<Datum>[], key: string, weight: number): LayoutNode<Datum>[] {
  return nodes.map((node) =>
    node.key === key
      ? { ...node, weight }
      : node.children === undefined
        ? node
        : { ...node, children: withWeight(node.children, key, weight) },
  );
}

/** Every key in a circle's subtree. */
function subtree(circle: Circle<unknown>): Set<string> {
  const keys = new Set<string>();
  const visit = (c: Circle<unknown>) => {
    keys.add(c.key);
    c.children.forEach(visit);
  };
  visit(circle);
  return keys;
}

const EPSILON = 1e-6;

describe("packLayout determinism", () => {
  it("returns identical geometry for the same board twice, because the map is refetched on every scan and a circle that drifts between refreshes has to be re-learned", () => {
    expect(geometry(packLayout(BOARD))).toEqual(geometry(packLayout(BOARD)));
  });

  it("ignores the order nodes arrive in at every level, so a tie the server broke the other way cannot reshuffle the picture", () => {
    const shuffle = (nodes: readonly LayoutNode<Datum>[]): LayoutNode<Datum>[] =>
      [...nodes].reverse().map((node) =>
        node.children === undefined ? node : { ...node, children: shuffle(node.children) },
      );
    expect(geometry(packLayout(shuffle(BOARD)))).toEqual(geometry(packLayout(BOARD)));
  });

  it("orders siblings by label, then key, so the packing spiral reads in a stable order a reader can learn", () => {
    expect(packLayout(BOARD).roots.map((c) => c.key)).toEqual(["wrapping", "legacy", "search", "storefront"]);
    const twins = [group("beta", "Same", [leaf("B", 1)]), group("alpha", "Same", [leaf("A", 1)])];
    expect(packLayout(twins).roots.map((c) => c.key)).toEqual(["alpha", "beta"]);
  });

  it("takes no status input at all: the node shape has no lifecycle field, so status can only ever be a lens the renderer paints", () => {
    const keys = new Set<string>();
    const visit = (node: LayoutNode<Datum>) => {
      Object.keys(node).forEach((key) => keys.add(key));
      node.children?.forEach(visit);
    };
    BOARD.forEach(visit);
    expect([...keys].sort()).toEqual(["children", "data", "key", "label", "weight"]);
  });

  it("puts an explicit `order` ahead of label order, because a severity tier is a fixed fact about a node, not a status a scan could flip", () => {
    const tiers = [
      group("low", "Low risk", [leaf("A", 1)]),
      group("high", "High risk", [leaf("B", 1)]),
      group("medium", "Medium risk", [leaf("C", 1)]),
    ].map((node, i) => ({ ...node, order: [2, 0, 1][i] }));
    expect(packLayout(tiers).roots.map((c) => c.key)).toEqual(["high", "medium", "low"]);
  });

  it("sorts nodes without `order` after every node that has one, so a mix of tiered and untiered siblings still resolves", () => {
    const nodes = [
      { ...group("z", "Z", [leaf("a", 1)]), order: undefined },
      { ...group("first", "Unrelated label", [leaf("b", 1)]), order: 0 },
    ];
    expect(packLayout(nodes).roots.map((c) => c.key)).toEqual(["first", "z"]);
  });

  it("breaks a tie in `order` by label, then key, exactly as when no order is given", () => {
    const nodes = [
      { ...group("beta", "Same", [leaf("B", 1)]), order: 1 },
      { ...group("alpha", "Same", [leaf("A", 1)]), order: 1 },
    ];
    expect(packLayout(nodes).roots.map((c) => c.key)).toEqual(["alpha", "beta"]);
  });

  it("keeps ordering by `order` deterministic under a shuffle, the same guarantee label order already gets", () => {
    const nodes = [
      { ...group("c", "Gamma", [leaf("x", 1)]), order: 2 },
      { ...group("a", "Alpha", [leaf("y", 1)]), order: 0 },
      { ...group("b", "Beta", [leaf("z", 1)]), order: 1 },
    ];
    const expected = ["a", "b", "c"];
    expect(packLayout(nodes).roots.map((c) => c.key)).toEqual(expected);
    expect(packLayout([...nodes].reverse()).roots.map((c) => c.key)).toEqual(expected);
  });

  it("returns byte-identical geometry when only `data` changes, so a lens repaint or a PR turning red can never move a circle", () => {
    const paint = (status: string) =>
      packLayout(
        BOARD.map((node) => ({ ...node, data: { kind: status } })) as LayoutNode<Datum>[],
      );
    expect(geometry(paint("blocked"))).toEqual(geometry(paint("shipped")));
  });

  it("keeps an explicit `order` fixed when `data` changes, so `order` can never become a second route for lifecycle to reach position", () => {
    const tiers = [
      { ...group("low", "Low", [leaf("a", 1)]), order: 1 },
      { ...group("high", "High", [leaf("b", 1)]), order: 0 },
    ];
    const paint = (status: string) =>
      packLayout(tiers.map((node) => ({ ...node, data: { kind: status } })) as LayoutNode<Datum>[]);
    expect(geometry(paint("blocked"))).toEqual(geometry(paint("shipped")));
    expect(packLayout(tiers).roots.map((c) => c.key)).toEqual(["high", "low"]);
  });
});

describe("packLayout invariants", () => {
  const layout = packLayout(BOARD);
  const all = flatten(layout);

  it("never overlaps two siblings, and keeps the level's gap between them, because an occluded circle is work the map has hidden", () => {
    const check = (siblings: Circle<Datum>[], gap: number) => {
      for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
          const a = siblings[i]!;
          const b = siblings[j]!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r + gap - EPSILON);
        }
      }
    };
    check(layout.roots, 0);
    for (const circle of all) check(circle.children, gapFor(0));
  });

  it("contains every child inside its parent with air to the rim, because the rim is what tells you a group ended", () => {
    for (const parent of all) {
      for (const child of parent.children) {
        const reach = Math.hypot(child.x - parent.x, child.y - parent.y) + child.r;
        expect(reach).toBeLessThanOrEqual(parent.r - PACK.gap / 2 + EPSILON);
      }
    }
    for (const root of layout.roots) {
      expect(Math.hypot(root.x, root.y) + root.r).toBeLessThanOrEqual(layout.world.r + EPSILON);
    }
  });

  it("keys every circle by identity rather than position, so fly-to-a-cluster keeps working across a rescan", () => {
    expect(layout.index.get("ABC-101")!.parentKey).toBe("cart");
    expect(layout.index.get("cart")!.parentKey).toBe("storefront");
    expect(layout.index.get("ABC-101")!.depth).toBe(2);
  });

  it("gives a heavier group a bigger circle, which is the whole claim the map makes about size", () => {
    expect(layout.index.get("storefront")!.r).toBeGreaterThan(layout.index.get("search")!.r);
    expect(layout.index.get("SHOP-3")!.r).toBeGreaterThan(layout.index.get("SHOP-4")!.r);
  });

  it("packs an empty board to nothing rather than to a gap", () => {
    const empty = packLayout([]);
    expect(empty.roots).toEqual([]);
    expect(empty.world.r).toBe(0);
  });

  it("stays non-overlapping for a wide spread of sizes, because the corner cases of a front chain only appear in a mix", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const discs = Array.from({ length: 80 }, () => ({ x: 0, y: 0, r: 4 + next() * 40 }));
    const r = packSiblings(discs);
    for (let i = 0; i < discs.length; i += 1) {
      const a = discs[i]!;
      expect(Math.hypot(a.x, a.y) + a.r).toBeLessThanOrEqual(r + EPSILON);
      for (let j = i + 1; j < discs.length; j += 1) {
        const b = discs[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - EPSILON);
      }
    }
  });

  it("finds the true minimum enclosing circle, so a parent is never bigger than its children force it to be", () => {
    const e = enclose([
      { x: -10, y: 0, r: 5 },
      { x: 10, y: 0, r: 5 },
      { x: 0, y: 3, r: 1 },
    ]);
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(0, 9);
    expect(e.r).toBeCloseTo(15, 9);
  });
});

describe("radius quantization", () => {
  it("snaps leaf weights up to doubling steps, so the commonest change — a cluster gaining its second checkout — changes nothing", () => {
    expect(quantizeWeight(1)).toBe(2);
    expect(quantizeWeight(2)).toBe(2);
    expect(quantizeWeight(3)).toBe(4);
    expect(quantizeWeight(5)).toBe(8);
    expect(quantizeWeight(33)).toBe(64);
    expect(leafRadius(1)).toBe(leafRadius(2));
    expect(leafRadius(5)).toBe(leafRadius(8));
  });

  it("floors a one-checkout cluster at a visible, clickable radius rather than letting area shrink it to a speck", () => {
    expect(leafRadius(1)).toBe(PACK.leafRadius);
    expect(leafRadius(0)).toBe(PACK.leafRadius);
  });

  it("keeps leaf AREA proportional to the quantized weight, because a circle twice the area has to mean twice the work", () => {
    const ratio = (leafRadius(16) / leafRadius(4)) ** 2;
    expect(ratio).toBeCloseTo(4, 9);
  });

  it("rounds group radii up to a geometric step and is idempotent on a step, so the same packing never lands on two radii", () => {
    const r = quantizeRadius(37.3);
    expect(r).toBeGreaterThanOrEqual(37.3);
    expect(r / PACK.radiusStep).toBeLessThan(37.3);
    expect(quantizeRadius(r)).toBe(r);
    for (const circle of flatten(packLayout(BOARD))) {
      if (circle.children.length > 0) expect(quantizeRadius(circle.r)).toBe(circle.r);
    }
  });
});

describe("local repack stability", () => {
  it("moves nothing at all when a checkout joins a cluster without crossing a weight step — a refresh normally repaints and never moves", () => {
    const before = geometry(packLayout(BOARD));
    // ABC-103 holds 6; a seventh stays inside the 8 step.
    const after = geometry(packLayout(withWeight(BOARD, "ABC-103", 7)));
    expect(after).toEqual(before);
  });

  it("repacks ONLY the touched parent when a cluster crosses a step: every circle outside that parent's subtree is byte-identical", () => {
    const beforeLayout = packLayout(BOARD);
    // SHOP-4 goes from 1 to 3 checkouts: 2 → 4, a real radius step.
    const afterLayout = packLayout(withWeight(BOARD, "SHOP-4", 3));
    const touched = beforeLayout.index.get("SHOP-4")!;
    const parent = beforeLayout.index.get(touched.parentKey!)!;
    expect(afterLayout.index.get("SHOP-4")!.r).toBeGreaterThan(touched.r);
    // The parent absorbed it: same radius, same place.
    expect(afterLayout.index.get(parent.key)!.r).toBe(parent.r);

    const inside = subtree(parent);
    const before = geometry(beforeLayout);
    const after = geometry(afterLayout);
    let outside = 0;
    for (const [key, value] of before) {
      if (inside.has(key) && key !== parent.key) continue;
      expect(after.get(key)).toEqual(value);
      outside += 1;
    }
    // Most of the board is outside the parent; the assertion is not vacuous.
    expect(outside).toBeGreaterThan(before.size / 2);
  });

  it("confines even a step that grows the parent to the parent's own level, so a change can climb only as far as radii actually change", () => {
    const beforeLayout = packLayout(BOARD);
    const afterLayout = packLayout(withWeight(BOARD, "ABC-102", 30));
    const cart = beforeLayout.index.get("cart")!;
    const storefront = beforeLayout.index.get("storefront")!;
    const grew = afterLayout.index.get("cart")!.r !== cart.r;
    const storefrontGrew = afterLayout.index.get("storefront")!.r !== storefront.r;
    // Whatever climbed, the other roots stay put unless `storefront` itself grew.
    if (!storefrontGrew) {
      for (const key of ["search", "wrapping", "legacy", "SHOP-3", "WEB-9"]) {
        expect(afterLayout.index.get(key)).toMatchObject({
          x: beforeLayout.index.get(key)!.x,
          y: beforeLayout.index.get(key)!.y,
          r: beforeLayout.index.get(key)!.r,
        });
      }
    }
    // And a sibling group of `cart` moves only if `cart` changed size.
    const wishlists = beforeLayout.index.get("wishlists")!;
    if (!grew) expect(afterLayout.index.get("wishlists")!.x).toBe(wishlists.x);
  });
});

describe("stackEdges", () => {
  const membersOf = (circle: Circle<Datum>) => circle.data.stack ?? [];

  const spanning = [
    group("stacked", "Stacked", [
      leaf("ABC-700", 1, [{ id: "api", position: 1 }]),
      leaf("ABC-701", 2, [
        { id: "api", position: 2 },
        { id: "api", position: 3 },
      ]),
    ]),
  ];

  it("emits an edge only where a chain leaves its leaf, because hops inside one cluster are drawn as a chain inside it", () => {
    const edges = stackEdges(packLayout(spanning), membersOf);
    expect(edges).toHaveLength(1);
    expect([edges[0]!.fromKey, edges[0]!.toKey]).toEqual(["ABC-700", "ABC-701"]);
  });

  it("points the edge from the leaf that merges first to the one waiting on it, because the direction IS the constraint", () => {
    const reversed = [
      group("stacked", "Stacked", [
        leaf("A-2", 1, [{ id: "api", position: 2 }]),
        leaf("A-1", 1, [{ id: "api", position: 1 }]),
      ]),
    ];
    expect(stackEdges(packLayout(reversed), membersOf)[0]!.fromKey).toBe("A-1");
  });

  it("starts and ends on the rims rather than the centres, so an arc never crosses the circles it connects", () => {
    const layout = packLayout(spanning);
    const edge = stackEdges(layout, membersOf)[0]!;
    const from = layout.index.get(edge.fromKey)!;
    const to = layout.index.get(edge.toKey)!;
    expect(distance(edge.from, from)).toBeCloseTo(from.r, 9);
    expect(distance(edge.to, to)).toBeCloseTo(to.r, 9);
  });
});

describe("label decisions", () => {
  const need = { full: 90, short: 40 };

  it("shows the full name, a short form, or nothing, from the circle's RENDERED radius alone", () => {
    expect(labelForm(120, need)).toBe("full");
    expect(labelForm(90, need)).toBe("full");
    expect(labelForm(60, need)).toBe("short");
    expect(labelForm(39, need)).toBe("none");
  });

  it("decides per circle, so a big and a small circle at the SAME zoom answer differently — a global threshold asks the wrong question", () => {
    const scale = 1.2;
    expect(labelForm(90 * scale, need)).toBe("full");
    expect(labelForm(20 * scale, need)).toBe("none");
  });

  it("requires the whole block inside the circle, inset from the rim, so a name that just fits still reads as inside its circle", () => {
    const r = radiusFor(120, 30);
    expect(Math.hypot(60, 15)).toBeCloseTo(r * LABEL_FIT.inset, 9);
    expect(radiusFor(120, 30)).toBeGreaterThan(radiusFor(100, 30));
  });

  it("fades a label in over a short ramp past its fit, rather than popping, and is fully shown by the end of it", () => {
    expect(labelAlpha(39, 40)).toBe(0);
    expect(labelAlpha(40 * LABEL_FIT.ramp, 40)).toBe(1);
    const mid = labelAlpha(40 * (1 + (LABEL_FIT.ramp - 1) / 2), 40);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("moves a parent's label to its rim BEFORE its first child's label can appear, so the two never fight for the middle", () => {
    const reveal = 2;
    expect(rimProgress(reveal * 0.79, reveal)).toBe(0);
    expect(rimProgress(reveal, reveal)).toBe(1);
    // At the scale a child label starts to show, the parent is already on the rim.
    expect(rimProgress(reveal, reveal)).toBe(1);
    expect(labelAlpha(40, 40)).toBe(0);
  });
});

describe("flight", () => {
  const viewport = { width: 1000, height: 600 };
  const from = fitView({ x: 0, y: 0, r: 300 }, viewport);
  const target = { x: 120, y: -80, r: 20 };
  const to = fitView(target, viewport);

  it("fills the viewport's shorter side with the target, centred, because fly-to means the thing you clicked becomes the whole screen", () => {
    expect(target.r * to.scale).toBeCloseTo(300 * 0.9, 9);
    expect(to.x + target.x * to.scale).toBeCloseTo(500, 9);
    expect(to.y + target.y * to.scale).toBeCloseTo(300, 9);
  });

  it("starts and lands exactly on its endpoints, so reduced motion and a full flight end in the same state", () => {
    expect(flyView(from, to, 0)).toEqual(from);
    expect(flyView(from, to, 1)).toEqual(to);
  });

  it("zooms about the one screen point both views agree on, so the target travels straight toward the centre and never swerves", () => {
    // The target's screen centre must move along the straight line between
    // where it starts and where it lands.
    const start = { x: from.x + target.x * from.scale, y: from.y + target.y * from.scale };
    const end = { x: 500, y: 300 };
    for (const t of [0.25, 0.5, 0.75]) {
      const v = flyView(from, to, t);
      const p = { x: v.x + target.x * v.scale, y: v.y + target.y * v.scale };
      const cross = (end.x - start.x) * (p.y - start.y) - (end.y - start.y) * (p.x - start.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6 * Math.hypot(end.x - start.x, end.y - start.y) * 1000);
    }
  });

  it("interpolates scale in log space, so each frame zooms by the same ratio and deep dives do not lurch at the end", () => {
    const mid = flyView(from, to, 0.5);
    expect(mid.scale).toBeCloseTo(Math.sqrt(from.scale * to.scale), 9);
  });

  it("uses one decisive ease-out with no overshoot, because a flight has to land rather than bounce", () => {
    expect(EASE).toEqual([0.2, 0, 0, 1]);
    let last = 0;
    for (let i = 1; i <= 50; i += 1) {
      const value = ease(i / 50);
      expect(value).toBeGreaterThanOrEqual(last);
      expect(value).toBeLessThanOrEqual(1);
      last = value;
    }
    expect(ease(0.5)).toBeGreaterThan(0.8);
  });

  it("keeps every flight inside 250–400 ms, so a short hop and a deep dive feel like the same material", () => {
    expect(flightMs(from, from)).toBeGreaterThanOrEqual(250);
    expect(flightMs(from, to)).toBeLessThanOrEqual(400);
  });

  it("sends leaving labels out in the first third and arriving ones in the last third, and always lands on the end value", () => {
    // A child label arriving: nothing until two thirds in.
    expect(flightMix(0, 1, 0.6, false)).toBe(0);
    expect(flightMix(0, 1, 1, false)).toBe(1);
    // A parent moving to its rim: done by one third.
    expect(flightMix(0, 1, 0.34, true)).toBe(1);
    expect(flightMix(0, 1, 0.1, true)).toBeGreaterThan(0);
    // Unchanged values never flicker mid-flight.
    expect(flightMix(0.7, 0.7, 0.5, true)).toBe(0.7);
  });
});


describe("fit-all", () => {
  const layout = packLayout(BOARD);
  const viewport = { width: 1120, height: 812 };
  const insets = { top: 32, right: 24, bottom: 58, left: 24 };
  const free = {
    x: (insets.left + viewport.width - insets.right) / 2,
    y: (insets.top + viewport.height - insets.bottom) / 2,
  };
  const view = fitBox(massBox(layout.roots), viewport, insets);
  const onScreen = massBox(
    layout.roots.map((c) => ({ x: view.x + c.x * view.scale, y: view.y + c.y * view.scale, r: c.r * view.scale })),
  );

  it("centres the drawn mass in the space the chrome leaves, not in the whole viewport, so nothing reads as pushed low or aside", () => {
    expect(Math.abs((onScreen.left + onScreen.right) / 2 - free.x)).toBeLessThan(0.5);
    expect(Math.abs((onScreen.top + onScreen.bottom) / 2 - free.y)).toBeLessThan(0.5);
  });

  it("keeps every root clear of the chrome and fills the free space along one axis, so fit-all is as large as it can be", () => {
    expect(onScreen.left).toBeGreaterThanOrEqual(insets.left - EPSILON);
    expect(onScreen.top).toBeGreaterThanOrEqual(insets.top - EPSILON);
    expect(onScreen.right).toBeLessThanOrEqual(viewport.width - insets.right + EPSILON);
    expect(onScreen.bottom).toBeLessThanOrEqual(viewport.height - insets.bottom + EPSILON);
    const fillsWidth = Math.abs(onScreen.right - onScreen.left - (viewport.width - insets.left - insets.right)) < 1e-6;
    const fillsHeight = Math.abs(onScreen.bottom - onScreen.top - (viewport.height - insets.top - insets.bottom)) < 1e-6;
    expect(fillsWidth || fillsHeight).toBe(true);
  });

  it("is never smaller than fitting the enclosing circle, which a corner-to-corner packing leaves far bigger than the mass", () => {
    const circleFit = fitView(layout.world, {
      width: viewport.width - insets.left - insets.right,
      height: viewport.height - insets.top - insets.bottom,
    }, 1);
    expect(view.scale).toBeGreaterThanOrEqual(circleFit.scale - EPSILON);
  });

  it("moves the view only: fitting reads the layout and leaves every circle where it was", () => {
    const before = geometry(layout);
    fitBox(massBox(layout.roots), viewport, insets);
    expect(geometry(layout)).toEqual(before);
  });
});

describe("captions", () => {
  const metrics = { height: 14, gap: 3, clearance: 2, pad: 3 };
  const bounds: Box = { left: 0, top: 0, right: 1000, bottom: 700 };

  function assertClear(
    placed: ReturnType<typeof placeCaptions>,
    circles: readonly { x: number; y: number; r: number }[],
    boxes: readonly Box[] = [],
  ) {
    const all = [...placed.values()];
    for (const [index, caption] of all.entries()) {
      for (const circle of circles) expect(boxHitsCircle(caption.box, circle)).toBe(false);
      for (const box of boxes) expect(boxesOverlap(caption.box, box)).toBe(false);
      for (const other of all.slice(index + 1)) expect(boxesOverlap(caption.box, other.box)).toBe(false);
      expect(caption.box.left).toBeGreaterThanOrEqual(bounds.left);
      expect(caption.box.right).toBeLessThanOrEqual(bounds.right);
      expect(caption.box.top).toBeGreaterThanOrEqual(bounds.top);
      expect(caption.box.bottom).toBeLessThanOrEqual(bounds.bottom);
    }
  }

  it("names a lone small circle under its rim, the side a reader looks for a caption on first", () => {
    const request = { key: "a", x: 500, y: 300, r: 14, forms: [120] };
    const placed = placeCaptions([request], { circles: [request], boxes: [], bounds }, metrics);
    expect(placed.get("a")?.side).toBe(CAPTION_SIDES[0]);
    expect(placed.get("a")?.form).toBe(0);
  });

  it("moves to another side before shortening, and shortens before overlapping, because a wrong or clipped name is worse than a moved one", () => {
    const a = { key: "a", x: 500, y: 300, r: 14, forms: [120, 40] };
    // A wall of circle directly below the rim: "below" is taken.
    const below = { x: 500, y: 350, r: 30 };
    const side = placeCaptions([a], { circles: [a, below], boxes: [], bounds }, metrics).get("a");
    expect(side?.side).toBe("above");
    expect(side?.form).toBe(0);
    // Neighbours on every side leave room only for the short form.
    const hemmed = [a, { x: 500, y: 355, r: 30 }, { x: 500, y: 245, r: 30 }, { x: 590, y: 300, r: 30 }, { x: 410, y: 300, r: 30 }];
    const short = placeCaptions([a], { circles: hemmed, boxes: [], bounds }, metrics).get("a");
    expect(short?.form).toBe(1);
    assertClear(new Map([["a", short!]]), hemmed);
  });

  it("places nothing rather than overlap: a name drawn over another circle names the wrong thing", () => {
    const a = { key: "a", x: 500, y: 300, r: 14, forms: [120, 40] };
    const boxedIn = [a, { x: 500, y: 334, r: 18 }, { x: 500, y: 266, r: 18 }, { x: 534, y: 300, r: 18 }, { x: 466, y: 300, r: 18 }];
    expect(placeCaptions([a], { circles: boxedIn, boxes: [], bounds }, metrics).has("a")).toBe(false);
  });

  it("never collides with a circle, a label, another caption or the edge, across a dense cluster of small roots", () => {
    const requests: CaptionRequest[] = [];
    for (let i = 0; i < 14; i += 1) {
      requests.push({ key: `k${i}`, x: 200 + (i % 5) * 70, y: 150 + Math.floor(i / 5) * 60, r: 10 + (i % 3) * 6, forms: [90 + (i % 4) * 20, 36] });
    }
    const labels: Box[] = [{ left: 250, top: 190, right: 330, bottom: 210 }];
    const placed = placeCaptions(requests, { circles: requests, boxes: labels, bounds }, metrics);
    assertClear(placed, requests, labels);
    expect(placed.size).toBeGreaterThan(0);
  });

  it("decides the same placement whatever order the circles arrive in, so a refresh never shuffles names", () => {
    const requests: CaptionRequest[] = [
      { key: "b", x: 300, y: 300, r: 14, forms: [110, 40] },
      { key: "a", x: 340, y: 300, r: 14, forms: [110, 40] },
      { key: "c", x: 320, y: 340, r: 20, forms: [140, 40] },
    ];
    const one = placeCaptions(requests, { circles: requests, boxes: [], bounds }, metrics);
    const two = placeCaptions([...requests].reverse(), { circles: [...requests].reverse(), boxes: [], bounds }, metrics);
    expect([...two.entries()].sort()).toEqual([...one.entries()].sort());
  });
});

describe("turning", () => {
  it("interpolates every circle present on both faces, keyed by id, and leaves one-face containers out", () => {
    const from = new Map([
      ["cluster:ABC-101", { x: 0, y: 0, r: 10 }],
      ["g:storefront", { x: 0, y: 0, r: 80 }],
    ]);
    const to = new Map([
      ["cluster:ABC-101", { x: 100, y: -40, r: 10 }],
      ["risk:high", { x: 5, y: 5, r: 60 }],
    ]);
    const mid = interpolateLayouts(from, to, 0.5);
    expect([...mid.keys()]).toEqual(["cluster:ABC-101"]);
    expect(mid.get("cluster:ABC-101")).toEqual({ x: 50, y: -20, r: 10 });
  });

  it("starts and lands exactly on each face's geometry, so a turn and a reduced-motion swap end identically", () => {
    const from = new Map([["k", { x: 3, y: 4, r: 10 }]]);
    const to = new Map([["k", { x: 30, y: -7, r: 10 }]]);
    expect(interpolateLayouts(from, to, 0).get("k")).toEqual({ x: 3, y: 4, r: 10 });
    expect(interpolateLayouts(from, to, 1).get("k")).toEqual({ x: 30, y: -7, r: 10 });
  });

  it("keeps a focused cluster still on screen when the view flies with it, so the reader never loses their place", () => {
    const a = { x: 40, y: 10, r: 10 };
    const b = { x: -60, y: 90, r: 10 };
    const size = { width: 800, height: 600 };
    const vFrom = fitView(a, size, 0.9);
    const vTo = fitView(b, size, 0.9);
    for (const t of [0.1, 0.35, 0.5, 0.8]) {
      const e = ease(t);
      const pose = interpolateLayouts(new Map([["k", a]]), new Map([["k", b]]), e).get("k")!;
      const view = flyView(vFrom, vTo, e);
      expect(view.x + pose.x * view.scale).toBeCloseTo(400, 6);
      expect(view.y + pose.y * view.scale).toBeCloseTo(300, 6);
    }
  });

  it("fades outgoing containers during the first half and incoming ones during the second, never both at once", () => {
    expect(containerFade(0, false)).toBe(1);
    expect(containerFade(0.5, false)).toBe(0);
    expect(containerFade(0.8, false)).toBe(0);
    expect(containerFade(0.5, true)).toBe(0);
    expect(containerFade(1, true)).toBe(1);
    for (const t of [0.1, 0.3, 0.45, 0.55, 0.7, 0.9]) {
      expect(Math.min(containerFade(t, false), containerFade(t, true))).toBe(0);
    }
  });

  it("tilts on a symmetric curve that peaks mid-turn within the limit and lands at exactly 0°", () => {
    expect(turnTilt(0)).toBe(0);
    expect(turnTilt(1)).toBe(0);
    expect(turnTilt(0.5)).toBeCloseTo(TURN.tiltDeg, 9);
    for (const t of [0.1, 0.2, 0.33, 0.4]) {
      expect(turnTilt(t)).toBeCloseTo(turnTilt(1 - t), 9);
      expect(turnTilt(t)).toBeLessThanOrEqual(TURN.tiltDeg);
    }
  });

  it("runs longer than a flight, because more is moving and the eye has to follow it", () => {
    expect(TURN.ms).toBeGreaterThanOrEqual(500);
    expect(TURN.ms).toBeLessThanOrEqual(700);
  });
});

describe("settling labels", () => {
  it("snaps a label to fully shown or fully hidden at rest, never leaving it mid-fade", () => {
    expect(settle(0.95, null)).toBe(true);
    expect(settle(0.05, null)).toBe(false);
  });

  it("holds its last settled state inside the hysteresis band, so a label near its fit threshold cannot flicker", () => {
    const inBand = (SETTLE.show + SETTLE.hide) / 2;
    expect(settle(inBand, true)).toBe(true);
    expect(settle(inBand, false)).toBe(false);
    expect(settle(SETTLE.show - 0.01, false)).toBe(false);
    expect(settle(SETTLE.hide + 0.01, true)).toBe(true);
  });

  it("crosses the band only by leaving it", () => {
    expect(settle(SETTLE.show, false)).toBe(true);
    expect(settle(SETTLE.hide, true)).toBe(false);
  });

  it("splits a never-settled label at the band's middle", () => {
    expect(settle(0.55, null)).toBe(true);
    expect(settle(0.45, null)).toBe(false);
  });
});

describe("captions inside ancestors", () => {
  it("does not treat the circles a leaf sits inside as obstacles to its own caption, but still avoids every other circle", () => {
    const parent = { key: "parent", x: 100, y: 100, r: 90 };
    const leaf = { key: "leaf", x: 100, y: 100, r: 8, forms: [40], within: ["parent"] };
    const neighbour = { key: "n", x: 100, y: 128, r: 12 };
    const bounds = { left: 0, top: 0, right: 400, bottom: 400 };
    const metrics = { height: 14, gap: 3, clearance: 2, pad: 3 };
    const placed = placeCaptions([leaf], { circles: [parent, leaf, neighbour], boxes: [], bounds }, metrics);
    expect(placed.get("leaf")?.side).toBe("above");
    const blind = placeCaptions([{ ...leaf, within: [] }], { circles: [parent, leaf, neighbour], boxes: [], bounds }, metrics);
    expect(blind.has("leaf")).toBe(false);
  });
});
