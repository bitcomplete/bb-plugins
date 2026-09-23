// Pure geometry for the Map view: no React, no DOM, no SDK.
//
// Two rules decide everything here.
//
// 1. The map is refetched on every scan, so positions must be a deterministic
//    function of the board. A circle that drifts between two otherwise
//    identical refreshes would have to be re-learned every ten minutes.
// 2. Position comes from the GROUPING HIERARCHY and stable weights only —
//    never from lifecycle. Status is a lens the renderer paints on top: color,
//    halo, dimming. A map whose circles reshuffle when a PR turns red is
//    unusable.
//
// The layout is written against a generic nested group, not against this
// plugin's program/effort/cluster tree: it takes `{ key, label, weight,
// children }` and nothing else, so a level appearing or collapsing away is a
// mapping change at the call site rather than a geometry change.

/** One node of the grouping hierarchy. Keys must be unique board-wide. */
export type LayoutNode<T> = {
  key: string;
  /** The ordering key: siblings pack in label order, then key. */
  label: string;
  /**
   * An explicit, static tiebreaker tried before label: siblings with an
   * `order` sort by it ascending, ahead of siblings without one. This is NOT
   * a back door for lifecycle — an `order` must be a fixed fact about what a
   * node IS (e.g. a severity tier), never a fact about a scan's current
   * status, or the "position never comes from lifecycle" rule breaks.
   */
  order?: number;
  /** Relative size of a leaf. Ignored for a group, whose size is its packing. */
  weight?: number;
  children?: readonly LayoutNode<T>[];
  /** Whatever the renderer needs to draw this node. The layout never reads it. */
  data: T;
};

/** A packed circle in ABSOLUTE world coordinates, so edges need no ancestry. */
export type Circle<T> = {
  key: string;
  label: string;
  /** 0 is a top-level group; each nesting level adds one. */
  depth: number;
  x: number;
  y: number;
  r: number;
  weight: number;
  parentKey: string | null;
  children: Circle<T>[];
  data: T;
};

export type PackLayout<T> = {
  roots: Circle<T>[];
  /** Every circle, by key — what fly-to and edges look through. */
  index: Map<string, Circle<T>>;
  /** The circle enclosing every root, centred on the world origin. */
  world: { x: number; y: number; r: number };
};

/**
 * World units: one unit is one CSS pixel at scale 1.
 *
 * Radii are QUANTIZED twice. A leaf's weight snaps up to a doubling step, so
 * one checkout joining or leaving a cluster usually changes nothing; and a
 * group's enclosing radius snaps up to a geometric step, so when a leaf does
 * cross a step the parent usually absorbs it and nothing above the parent
 * moves. That is what keeps a ten-minute refresh from rippling the map.
 */
export const PACK = {
  /** The radius of the smallest leaf — a 1- or 2-unit cluster. The floor. */
  leafRadius: 10,
  /** Leaf weights snap UP to the next of these; past the last, keep doubling. */
  weightSteps: [2, 4, 8, 16, 32] as readonly number[],
  /** A group's radius snaps up to `leafRadius * radiusStep^n`. */
  radiusStep: 1.08,
  /**
   * Air between siblings and between children and their parent's rim, per
   * level of height: leaves sit close, groups of groups get more room.
   */
  gap: 3,
} as const;

/** The step a leaf weight snaps to: the smallest step at or above it. */
export function quantizeWeight(weight: number): number {
  const w = Math.max(1, weight);
  for (const step of PACK.weightSteps) if (w <= step) return step;
  let step = PACK.weightSteps[PACK.weightSteps.length - 1]!;
  while (step < w) step *= 2;
  return step;
}

/** Area-proportional to the quantized weight, never below the floor. */
export function leafRadius(weight: number): number {
  return PACK.leafRadius * Math.sqrt(quantizeWeight(weight) / PACK.weightSteps[0]!);
}

/** Round a radius UP to the next geometric step. */
export function quantizeRadius(r: number): number {
  if (r <= PACK.leafRadius) return PACK.leafRadius;
  // The epsilon keeps a radius that already sits on a step from being pushed
  // to the next one by floating-point noise in the log.
  const n = Math.ceil(Math.log(r / PACK.leafRadius) / Math.log(PACK.radiusStep) - 1e-9);
  return PACK.leafRadius * Math.pow(PACK.radiusStep, n);
}

// ---- sibling packing -------------------------------------------------------
//
// The front-chain packer from d3-hierarchy's `packSiblings` (Wang et al.,
// "Visualization of large hierarchical data by circle packing"): each circle is
// placed tangent to two neighbours on the current front chain, starting from
// the pair whose weighted centre is closest to the origin. Every comparison is
// strict, so a tie keeps the earlier chain position — and the chain is built
// in input order, which is label then key. Nothing random, nothing lifecycle.

type Disc = { x: number; y: number; r: number };
type ChainNode = { disc: Disc; next: ChainNode; previous: ChainNode };

function place(b: Disc, a: Disc, c: Disc): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) {
    c.x = a.x + c.r;
    c.y = a.y;
    return;
  }
  const a2 = (a.r + c.r) ** 2;
  const b2 = (b.r + c.r) ** 2;
  if (a2 > b2) {
    const x = (d2 + b2 - a2) / (2 * d2);
    const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
    c.x = b.x - x * dx - y * dy;
    c.y = b.y - x * dy + y * dx;
  } else {
    const x = (d2 + a2 - b2) / (2 * d2);
    const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
    c.x = a.x + x * dx - y * dy;
    c.y = a.y + x * dy + y * dx;
  }
}

function intersects(a: Disc, b: Disc): boolean {
  const dr = a.r + b.r - 1e-6;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

function score(node: ChainNode): number {
  const a = node.disc;
  const b = node.next.disc;
  const ab = a.r + b.r;
  const dx = (a.x * b.r + b.x * a.r) / ab;
  const dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

function chainNode(disc: Disc): ChainNode {
  const node = { disc } as ChainNode;
  node.next = node;
  node.previous = node;
  return node;
}

/**
 * Pack discs (in the given order) so none overlap, then centre the enclosing
 * circle on the origin. Mutates `x`/`y`; returns the enclosing radius.
 */
export function packSiblings(discs: Disc[]): number {
  const n = discs.length;
  if (n === 0) return 0;
  const first = discs[0]!;
  first.x = 0;
  first.y = 0;
  if (n === 1) return first.r;
  const second = discs[1]!;
  first.x = -second.r;
  second.x = first.r;
  second.y = 0;
  if (n === 2) {
    const e = enclose(discs);
    for (const disc of discs) {
      disc.x -= e.x;
      disc.y -= e.y;
    }
    return e.r;
  }
  place(second, first, discs[2]!);

  let a = chainNode(first);
  let b = chainNode(second);
  let c = chainNode(discs[2]!);
  a.next = c.previous = b;
  b.next = a.previous = c;
  c.next = b.previous = a;

  pack: for (let i = 3; i < n; i += 1) {
    const disc = discs[i]!;
    place(a.disc, b.disc, disc);
    c = chainNode(disc);
    // The closest intersecting circle along the chain, ahead or behind.
    let j = b.next;
    let k = a.previous;
    let sj = b.disc.r;
    let sk = a.disc.r;
    do {
      if (sj <= sk) {
        if (intersects(j.disc, c.disc)) {
          b = j;
          a.next = b;
          b.previous = a;
          i -= 1;
          continue pack;
        }
        sj += j.disc.r;
        j = j.next;
      } else {
        if (intersects(k.disc, c.disc)) {
          a = k;
          a.next = b;
          b.previous = a;
          i -= 1;
          continue pack;
        }
        sk += k.disc.r;
        k = k.previous;
      }
    } while (j !== k.next);

    c.previous = a;
    c.next = b;
    a.next = b.previous = b = c;

    // The pair closest to the origin becomes the next place to grow from.
    let best = score(a);
    while ((c = c.next) !== b) {
      const candidate = score(c);
      if (candidate < best) {
        a = c;
        best = candidate;
      }
    }
    b = a.next;
  }

  const chain: Disc[] = [b.disc];
  for (let node = b.next; node !== b; node = node.next) chain.push(node.disc);
  const e = enclose(chain);
  for (const disc of discs) {
    disc.x -= e.x;
    disc.y -= e.y;
  }
  return e.r;
}

// ---- minimum enclosing circle ---------------------------------------------
//
// Welzl's move-to-front algorithm, iterative, as in d3's `packEnclose` but
// WITHOUT the shuffle: the restart-from-zero loop is correct for any order,
// and a fixed order is what makes the result a pure function of the input.

function enclosesNot(a: Disc, b: Disc): boolean {
  const dr = a.r - b.r;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr < 0 || dr * dr < dx * dx + dy * dy;
}

function enclosesWeak(a: Disc, b: Disc): boolean {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

function enclosesWeakAll(a: Disc, basis: readonly Disc[]): boolean {
  return basis.every((b) => enclosesWeak(a, b));
}

function encloseBasis2(a: Disc, b: Disc): Disc {
  const x21 = b.x - a.x;
  const y21 = b.y - a.y;
  const r21 = b.r - a.r;
  const l = Math.sqrt(x21 * x21 + y21 * y21);
  return {
    x: (a.x + b.x + (x21 / l) * r21) / 2,
    y: (a.y + b.y + (y21 / l) * r21) / 2,
    r: (l + a.r + b.r) / 2,
  };
}

function encloseBasis3(a: Disc, b: Disc, c: Disc): Disc {
  const { x: x1, y: y1, r: r1 } = a;
  const { x: x2, y: y2, r: r2 } = b;
  const { x: x3, y: y3, r: r3 } = c;
  const a2 = x1 - x2;
  const a3 = x1 - x3;
  const b2 = y1 - y2;
  const b3 = y1 - y3;
  const c2 = r2 - r1;
  const c3 = r3 - r1;
  const d1 = x1 * x1 + y1 * y1 - r1 * r1;
  const d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2;
  const d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3;
  const ab = a3 * b2 - a2 * b3;
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1;
  const xb = (b3 * c2 - b2 * c3) / ab;
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1;
  const yb = (a2 * c3 - a3 * c2) / ab;
  const A = xb * xb + yb * yb - 1;
  const B = 2 * (r1 + xa * xb + ya * yb);
  const C = xa * xa + ya * ya - r1 * r1;
  const r = -(Math.abs(A) > 1e-6 ? (B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) : C / B);
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r };
}

function encloseBasis(basis: readonly Disc[]): Disc {
  if (basis.length === 1) return { x: basis[0]!.x, y: basis[0]!.y, r: basis[0]!.r };
  if (basis.length === 2) return encloseBasis2(basis[0]!, basis[1]!);
  return encloseBasis3(basis[0]!, basis[1]!, basis[2]!);
}

function extendBasis(basis: readonly Disc[], p: Disc): Disc[] {
  if (enclosesWeakAll(p, basis)) return [p];
  for (const b of basis) {
    if (enclosesNot(p, b) && enclosesWeakAll(encloseBasis2(b, p), basis)) return [b, p];
  }
  for (let i = 0; i < basis.length - 1; i += 1) {
    for (let j = i + 1; j < basis.length; j += 1) {
      const bi = basis[i]!;
      const bj = basis[j]!;
      if (
        enclosesNot(encloseBasis2(bi, bj), p) &&
        enclosesNot(encloseBasis2(bi, p), bj) &&
        enclosesNot(encloseBasis2(bj, p), bi) &&
        enclosesWeakAll(encloseBasis3(bi, bj, p), basis)
      ) {
        return [bi, bj, p];
      }
    }
  }
  // Unreachable for finite input; degrade to a circle around `p` rather than throw.
  return [p];
}

/** The smallest circle enclosing every disc. */
export function enclose(discs: readonly Disc[]): Disc {
  let basis: Disc[] = [];
  let e: Disc | null = null;
  let i = 0;
  while (i < discs.length) {
    const p = discs[i]!;
    if (e !== null && enclosesWeak(e, p)) {
      i += 1;
    } else {
      basis = extendBasis(basis, p);
      e = encloseBasis(basis);
      i = 0;
    }
  }
  return e ?? { x: 0, y: 0, r: 0 };
}

// ---- the hierarchy ---------------------------------------------------------

// An explicit, static `order` is allowed to decide position because it is a
// fixed fact about the node, not a fact about the current scan — it can't
// drift the way a lifecycle-derived order would. Nodes without one fall back
// to label, then key, exactly as before.
function ordered<T>(nodes: readonly LayoutNode<T>[]): LayoutNode<T>[] {
  return [...nodes].sort(
    (a, b) =>
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );
}

/** A subtree packed about its own centre: relative coordinates, final radius. */
type Local<T> = {
  node: LayoutNode<T>;
  r: number;
  weight: number;
  height: number;
  children: { local: Local<T>; x: number; y: number }[];
};

/** The gap a set of siblings keeps, from how tall the tallest of them is. */
export function gapFor(height: number): number {
  return PACK.gap * (1 + height);
}

/**
 * Pack bottom-up. A parent's packing reads ONLY its children's radii and their
 * order, so a change inside one child can reach the parent's siblings only by
 * changing the parent's quantized radius — which is the whole stability story.
 */
function packLocal<T>(node: LayoutNode<T>): Local<T> {
  const kids = ordered(node.children ?? []);
  if (kids.length === 0) {
    const weight = Math.max(1, node.weight ?? 1);
    return { node, r: leafRadius(weight), weight, height: 0, children: [] };
  }
  const locals = kids.map(packLocal);
  const height = 1 + Math.max(...locals.map((local) => local.height));
  const gap = gapFor(height - 1);
  // Inflate by half the gap so tangent discs keep a full gap between them.
  const discs = locals.map((local) => ({ x: 0, y: 0, r: local.r + gap / 2 }));
  const enclosing = packSiblings(discs);
  return {
    node,
    r: quantizeRadius(enclosing + gap / 2),
    weight: locals.reduce((total, local) => total + local.weight, 0),
    height,
    children: locals.map((local, index) => ({ local, x: discs[index]!.x, y: discs[index]!.y })),
  };
}

function absolute<T>(
  local: Local<T>,
  x: number,
  y: number,
  depth: number,
  parentKey: string | null,
  index: Map<string, Circle<T>>,
): Circle<T> {
  const circle: Circle<T> = {
    key: local.node.key,
    label: local.node.label,
    depth,
    x,
    y,
    r: local.r,
    weight: local.weight,
    parentKey,
    children: [],
    data: local.node.data,
  };
  index.set(circle.key, circle);
  circle.children = local.children.map((child) =>
    absolute(child.local, x + child.x, y + child.y, depth + 1, circle.key, index),
  );
  return circle;
}

/** Lay out the whole board. Ordering is order, then label, then key — never status. */
export function packLayout<T>(nodes: readonly LayoutNode<T>[]): PackLayout<T> {
  const index = new Map<string, Circle<T>>();
  const locals = ordered(nodes).map(packLocal);
  if (locals.length === 0) return { roots: [], index, world: { x: 0, y: 0, r: 0 } };
  const gap = gapFor(Math.max(...locals.map((local) => local.height)));
  const discs = locals.map((local) => ({ x: 0, y: 0, r: local.r + gap / 2 }));
  const r = packSiblings(discs) + gap / 2;
  const roots = locals.map((local, position) =>
    absolute(local, discs[position]!.x, discs[position]!.y, 0, null, index),
  );
  return { roots, index, world: { x: 0, y: 0, r } };
}

/** Walk a laid-out tree depth-first, parents before their children. */
export function walk<T>(circle: Circle<T>, visit: (circle: Circle<T>) => void): void {
  visit(circle);
  for (const child of circle.children) walk(child, visit);
}

/** Every circle, parents before children — the paint order. */
export function flatten<T>(layout: PackLayout<T>): Circle<T>[] {
  const out: Circle<T>[] = [];
  for (const root of layout.roots) walk(root, (circle) => out.push(circle));
  return out;
}

// ---- stack edges -----------------------------------------------------------

/**
 * A merge dependency that leaves its leaf. A stack is a repo-level chain, so
 * it neither respects nor needs the grouping hierarchy — and a chain that
 * spans two circles is the one structure a flat list cannot show.
 */
export type StackEdge = {
  id: string;
  /** The leaf that must merge first, and the leaf waiting on it. */
  fromKey: string;
  toKey: string;
  /** Rim points facing each other, and a control point bowing the arc aside. */
  from: Point;
  to: Point;
  control: Point;
};

/**
 * Derive stack edges between leaves. Chain membership is read through an
 * accessor, so the layout stays free of this plugin's PR vocabulary. Hops
 * inside one leaf are the renderer's business (it draws them as a chain).
 */
export function stackEdges<T>(
  layout: PackLayout<T>,
  membersOf: (leaf: Circle<T>) => readonly { id: string; position: number }[],
): StackEdge[] {
  type Member = { leaf: Circle<T>; position: number };
  const chains = new Map<string, Member[]>();
  for (const circle of flatten(layout)) {
    if (circle.children.length > 0) continue;
    for (const member of membersOf(circle)) {
      const chain = chains.get(member.id) ?? [];
      chain.push({ leaf: circle, position: member.position });
      chains.set(member.id, chain);
    }
  }
  const edges: StackEdge[] = [];
  for (const [id, members] of [...chains].sort((a, b) => a[0].localeCompare(b[0]))) {
    members.sort((a, b) => a.position - b.position || a.leaf.key.localeCompare(b.leaf.key));
    for (let position = 1; position < members.length; position += 1) {
      const below = members[position - 1]!.leaf;
      const above = members[position]!.leaf;
      if (below.key === above.key) continue;
      const dx = above.x - below.x;
      const dy = above.y - below.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const from = { x: below.x + ux * below.r, y: below.y + uy * below.r };
      const to = { x: above.x - ux * above.r, y: above.y - uy * above.r };
      // Bow to the left of travel, by a share of the span: an arc, not a rule.
      const bow = Math.hypot(to.x - from.x, to.y - from.y) * 0.22;
      edges.push({
        id,
        fromKey: below.key,
        toKey: above.key,
        from,
        to,
        control: { x: (from.x + to.x) / 2 - uy * bow, y: (from.y + to.y) / 2 + ux * bow },
      });
    }
  }
  return edges;
}

// ---- labels ----------------------------------------------------------------

/**
 * Labels are decided per circle from its RENDERED radius, in screen pixels —
 * the only unit a reader experiences. Text is drawn at a constant screen size,
 * so the question is simply whether the block fits inside the circle.
 */
export const LABEL_FIT = {
  /** The share of the radius a label block may reach: keeps text off the rim. */
  inset: 0.88,
  /** Ramp from invisible to fully shown over this much growth past the fit. */
  ramp: 1.14,
} as const;

/** The smallest screen radius whose circle holds a `width × height` block. */
export function radiusFor(width: number, height: number): number {
  return Math.hypot(width, height) / 2 / LABEL_FIT.inset;
}

export type LabelForm = "full" | "short" | "none";

/** Full name when the circle can hold it, short form when it can hold that, else nothing. */
export function labelForm(screenR: number, need: { full: number; short: number }): LabelForm {
  if (screenR >= need.full) return "full";
  if (screenR >= need.short) return "short";
  return "none";
}

/** Hermite smoothstep, clamped: 0 at or below `edge0`, 1 at or above `edge1`. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** How visible a label is: fades in as the circle grows past what it needs. */
export function labelAlpha(screenR: number, need: number): number {
  return smoothstep(need, need * LABEL_FIT.ramp, screenR);
}

/**
 * How far a parent's label has moved to its rim, from the SCALE at which its
 * first child's label would appear. It finishes before that point, so the
 * parent's name and a child's name never share the middle of the circle.
 */
export function rimProgress(scale: number, childRevealScale: number): number {
  return smoothstep(childRevealScale * 0.8, childRevealScale, scale);
}

// ---- the view --------------------------------------------------------------

/** The map's transform: screen = world × scale + (x, y). */
export type View = { scale: number; x: number; y: number };
export type Point = { x: number; y: number };
/** The zoom range the viewport currently allows. */
export type ScaleBounds = { min: number; max: number };

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Zoom about a fixed screen point: whatever was under `at` stays under `at`.
 * Wheel, pinch and fly-to all owe the reader this, so they all go through here.
 */
export function zoomAt(view: View, at: Point, factor: number, bounds: ScaleBounds): View {
  const scale = Math.min(Math.max(view.scale * factor, bounds.min), bounds.max);
  const ratio = scale / view.scale;
  return {
    scale,
    x: at.x - (at.x - view.x) * ratio,
    y: at.y - (at.y - view.y) * ratio,
  };
}

/**
 * The view two fingers are asking for, relative to where the gesture started.
 * The distance ratio sets the scale and the midpoint's travel the translation;
 * deriving from the START keeps a long pinch free of accumulated drift.
 */
export function pinchView(
  start: { view: View; center: Point; span: number },
  current: { center: Point; span: number },
  bounds: ScaleBounds,
): View {
  const factor = start.span > 0 && current.span > 0 ? current.span / start.span : 1;
  const zoomed = zoomAt(start.view, start.center, factor, bounds);
  return {
    scale: zoomed.scale,
    x: zoomed.x + (current.center.x - start.center.x),
    y: zoomed.y + (current.center.y - start.center.y),
  };
}

/** The view that makes a circle fill `fill` of the viewport's shorter side. */
export function fitView(
  circle: { x: number; y: number; r: number },
  viewport: { width: number; height: number },
  fill = 0.9,
): View {
  const radius = Math.max(circle.r, 1e-6);
  const scale = (Math.min(viewport.width, viewport.height) / 2 / radius) * fill;
  return {
    scale,
    x: viewport.width / 2 - circle.x * scale,
    y: viewport.height / 2 - circle.y * scale,
  };
}

/** An axis-aligned rectangle, in whichever space its caller works in. */
export type Box = { left: number; top: number; right: number; bottom: number };
/** Screen pixels the chrome covers along each edge of the viewport. */
export type Insets = { top: number; right: number; bottom: number; left: number };

/**
 * The bounding box of the top-level circles: the mass a reader actually sees.
 * The enclosing circle is set by whichever two roots sit furthest apart, so a
 * packing that runs corner to corner leaves it far larger than what is drawn.
 */
export function massBox(roots: readonly { x: number; y: number; r: number }[]): Box {
  if (roots.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Math.min(...roots.map((c) => c.x - c.r)),
    top: Math.min(...roots.map((c) => c.y - c.r)),
    right: Math.max(...roots.map((c) => c.x + c.r)),
    bottom: Math.max(...roots.map((c) => c.y + c.r)),
  };
}

/**
 * The view that centres a world box in what the chrome leaves free, as large
 * as fits. Fit-all goes through here: the view moves, the geometry does not.
 */
export function fitBox(
  box: Box,
  viewport: { width: number; height: number },
  insets: Insets,
  fill = 1,
): View {
  const width = Math.max(box.right - box.left, 1e-6);
  const height = Math.max(box.bottom - box.top, 1e-6);
  const freeWidth = Math.max(viewport.width - insets.left - insets.right, 1);
  const freeHeight = Math.max(viewport.height - insets.top - insets.bottom, 1);
  const scale = Math.min(freeWidth / width, freeHeight / height) * fill;
  return {
    scale,
    x: insets.left + freeWidth / 2 - ((box.left + box.right) / 2) * scale,
    y: insets.top + freeHeight / 2 - ((box.top + box.bottom) / 2) * scale,
  };
}

// ---- captions --------------------------------------------------------------
//
// A top-level circle too small to hold its name gets a caption OUTSIDE it.
// Placement is screen-space and a pure function of its inputs: the same view
// always yields the same captions.

export type CaptionSide = "below" | "above" | "right" | "left";
/** The order sides are tried in: under the rim reads most like a caption. */
export const CAPTION_SIDES: readonly CaptionSide[] = ["below", "above", "right", "left"];

export type CaptionRequest = {
  key: string;
  /** The circle, in screen pixels. */
  x: number;
  y: number;
  r: number;
  /** Rendered widths of the caption's forms, preferred (longest) first. */
  forms: readonly number[];
  /**
   * Keys of the circles this one sits INSIDE. A leaf's caption necessarily
   * lies within its ancestors, so they are not obstacles to it; every other
   * circle still is.
   */
  within?: readonly string[];
};

export type CaptionPlacement = { key: string; side: CaptionSide; form: number; box: Box };

/** Where a `width`-wide caption sits on one side of a circle, `gap` px off its rim. */
export function captionBox(
  circle: { x: number; y: number; r: number },
  width: number,
  height: number,
  gap: number,
  side: CaptionSide,
): Box {
  const { x, y, r } = circle;
  switch (side) {
    case "below":
      return { left: x - width / 2, right: x + width / 2, top: y + r + gap, bottom: y + r + gap + height };
    case "above":
      return { left: x - width / 2, right: x + width / 2, top: y - r - gap - height, bottom: y - r - gap };
    case "right":
      return { left: x + r + gap, right: x + r + gap + width, top: y - height / 2, bottom: y + height / 2 };
    case "left":
      return { left: x - r - gap - width, right: x - r - gap, top: y - height / 2, bottom: y + height / 2 };
  }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function boxHitsCircle(box: Box, circle: { x: number; y: number; r: number }): boolean {
  const x = Math.min(Math.max(circle.x, box.left), box.right);
  const y = Math.min(Math.max(circle.y, box.top), box.bottom);
  return Math.hypot(x - circle.x, y - circle.y) < circle.r;
}

/**
 * Give each request the first caption that collides with nothing: no circle
 * (with `clearance` of air), no obstacle box, no earlier caption, nothing
 * outside `bounds`. Every side is tried at the full form before any side at a
 * shorter one — a shorter name beats overlap, and no name beats overlap.
 * Larger circles claim space first; ties go by key, so the order is total.
 */
export function placeCaptions(
  requests: readonly CaptionRequest[],
  obstacles: {
    circles: readonly { x: number; y: number; r: number; key?: string }[];
    boxes: readonly Box[];
    bounds: Box;
  },
  metrics: { height: number; gap: number; clearance: number; pad: number },
): Map<string, CaptionPlacement> {
  const { bounds } = obstacles;
  const circles = obstacles.circles.map((c) => ({ key: c.key, x: c.x, y: c.y, r: c.r + metrics.clearance }));
  const taken: Box[] = [...obstacles.boxes];
  const placed = new Map<string, CaptionPlacement>();
  const order = [...requests].sort((a, b) => b.r - a.r || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const request of order) {
    search: for (let form = 0; form < request.forms.length; form += 1) {
      for (const side of CAPTION_SIDES) {
        const box = captionBox(request, request.forms[form]!, metrics.height, metrics.gap, side);
        const padded = {
          left: box.left - metrics.pad,
          right: box.right + metrics.pad,
          top: box.top - metrics.pad,
          bottom: box.bottom + metrics.pad,
        };
        if (
          box.left < bounds.left ||
          box.top < bounds.top ||
          box.right > bounds.right ||
          box.bottom > bounds.bottom ||
          circles.some(
            (circle) =>
              !(circle.key !== undefined && request.within?.includes(circle.key)) &&
              boxHitsCircle(box, circle),
          ) ||
          taken.some((other) => boxesOverlap(padded, other))
        ) {
          continue;
        }
        placed.set(request.key, { key: request.key, side, form, box });
        taken.push(padded);
        break search;
      }
    }
  }
  return placed;
}

/**
 * The view part-way through a flight. The circles never move; only the view
 * does. Scale is interpolated in LOG space about the one screen point both
 * views agree on, so a zoom reads as travel toward a place rather than as a
 * slide plus a swell — the target never drifts sideways on the way in.
 */
export function flyView(from: View, to: View, t: number): View {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const ratio = to.scale / from.scale;
  if (Math.abs(ratio - 1) < 1e-4) {
    return {
      scale: from.scale + (to.scale - from.scale) * t,
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    };
  }
  // The fixed point p satisfies p = from.x + from.scale·w = to.x + to.scale·w.
  const wx = (from.x - to.x) / (to.scale - from.scale);
  const wy = (from.y - to.y) / (to.scale - from.scale);
  const at = { x: from.x + from.scale * wx, y: from.y + from.scale * wy };
  const factor = Math.pow(ratio, t);
  return zoomAt(from, at, factor, { min: 0, max: Number.POSITIVE_INFINITY });
}

/**
 * The map's one easing family, cubic-bezier(0.2, 0, 0, 1): a decisive ease-out
 * with no overshoot. The same curve is written into CSS for the DOM
 * transitions, so a flight and a crossfade decelerate identically.
 */
export const EASE = [0.2, 0, 0, 1] as const;
export const EASE_CSS = `cubic-bezier(${EASE.join(", ")})`;

export function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = EASE;
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u: number) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  // Bisection on x(u) = t: monotone for this curve, and exact enough in 24 steps.
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 24; step += 1) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/**
 * How a label value travels during a flight, from its value at the start view
 * to its value at the end view, in one third of the flight: the FIRST third
 * when `early`, the LAST third otherwise.
 *
 * Label visibility leaves early and arrives late; a parent's move to its rim
 * goes early and its return goes late. So a parent's name has reached its rim
 * before a child's name starts to appear, and the two never share the middle
 * of a circle mid-flight. The end value is exactly `to`, which is why a
 * reduced-motion jump lands on the same state.
 */
export function flightMix(from: number, to: number, t: number, early: boolean): number {
  if (to === from) return to;
  const local = early ? t * 3 : (t - 2 / 3) * 3;
  return from + (to - from) * ease(Math.min(1, Math.max(0, local)));
}

/** A flight's duration: longer for a deeper zoom, always inside 250–400 ms. */
export function flightMs(from: View, to: View): number {
  const octaves = Math.abs(Math.log2(to.scale / from.scale));
  return Math.round(Math.min(400, 260 + octaves * 36));
}

// ---- settling --------------------------------------------------------------
//
// A fade ramp is right DURING motion and wrong AT REST: a label resting at 0.05
// opacity is ghost text over the circles under it. So once the view has been
// still for `SETTLE.restMs`, every label snaps — through a short opacity
// transition, never a jump — to fully shown or fully hidden.

export const SETTLE = {
  /** No flight, turn, pinch, drag or wheel for this long means the view is at rest. */
  restMs: 150,
  /** The snap itself: short, and on the map's one easing. */
  fadeMs: 160,
  /**
   * The hysteresis band, in the ramp's own 0–1 units. Shown above `show`,
   * hidden below `hide`, and in between a label keeps what it last settled
   * on — so one that rests near its fit threshold cannot flicker as the view
   * settles by a pixel either way.
   */
  show: 0.6,
  hide: 0.4,
} as const;

/**
 * Settle a ramp value to shown or hidden. `previous` is what this label last
 * settled on, or null for one that has never settled, which splits at the
 * middle of the band.
 */
export function settle(value: number, previous: boolean | null): boolean {
  if (value >= SETTLE.show) return true;
  if (value <= SETTLE.hide) return false;
  return previous ?? value >= (SETTLE.show + SETTLE.hide) / 2;
}

// ---- turning ---------------------------------------------------------------
//
// A turn regroups the same clusters by another dimension. It is NOT a cube
// flip: a face swinging away takes every circle out of sight at once, which
// destroys the one thing a turn has to preserve — being able to follow a
// cluster from where it was to where it went. Instead the plane tilts a little
// while every cluster flies straight from its old place to its new one, and the
// plane untilts. Clusters travel; the containers, which exist on one face only,
// fade: the old ones out in the first half, the new ones in during the second.

export const TURN = {
  /** Longer than a flight: more is moving, and the eye has to follow it. */
  ms: 620,
  /** The most the plane leans, at the middle of the turn. */
  tiltDeg: 26,
} as const;

/**
 * The plane's lean at raw time `t`: sin², so it leaves and lands with zero
 * velocity, peaks at the middle, is symmetric about it, and is EXACTLY zero at
 * both ends — a turn never lands on a plane that is still a hair off.
 */
export function turnTilt(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return TURN.tiltDeg * Math.sin(Math.PI * t) ** 2;
}

/** A container's opacity at raw time `t`: outgoing ones leave in the first half, incoming arrive in the second. */
export function containerFade(t: number, incoming: boolean): number {
  if (incoming) return ease(Math.min(1, Math.max(0, (t - 0.5) * 2)));
  return 1 - ease(Math.min(1, Math.max(0, t * 2)));
}

/**
 * Where every circle present on BOTH faces is at eased progress `e`, keyed by
 * its key. Straight-line travel in world space; with the view flying on the
 * same easing, a cluster the reader is focused on stays put on screen while
 * the map rearranges around it. Circles on one face only are containers, and
 * they fade rather than travel, so they are not in the result.
 */
export function interpolateLayouts(
  from: ReadonlyMap<string, { x: number; y: number; r: number }>,
  to: ReadonlyMap<string, { x: number; y: number; r: number }>,
  e: number,
): Map<string, { x: number; y: number; r: number }> {
  const out = new Map<string, { x: number; y: number; r: number }>();
  for (const [key, a] of from) {
    const b = to.get(key);
    if (b === undefined) continue;
    out.set(key, {
      x: a.x + (b.x - a.x) * e,
      y: a.y + (b.y - a.y) * e,
      r: a.r + (b.r - a.r) * e,
    });
  }
  return out;
}
