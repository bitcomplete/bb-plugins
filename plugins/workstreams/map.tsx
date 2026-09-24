// The Map: the board as one zoomable space of nested circles.
//
// Geometry is layout.ts's and depends on the grouping hierarchy alone, so
// lifecycle here only ever PAINTS — ring color, fill, halo, dimming. The view
// transform lives in a ref and reaches the DOM in a rAF; React re-renders only
// when the mounted set of circles or a discrete label decision changes, never
// per frame. Everything that moves per frame is a transform or an opacity.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Board, Prefs } from "./server";
import {
  FACES,
  FACE_LABEL,
  clusterKey,
  riskFace,
  themeFace,
  type Face,
  type MapDatum,
} from "./faces";
import {
  // "Needs you" is an encoding here, not a lens, so the map's set gets a name
  // that cannot be mistaken for the Board's sections, which are a different
  // cut of the same lifecycles (see `inboxSection`).
  ACTIONABLE as HALO_STATES,
  DAY_MS,
  LENSES,
  UNSORTED,
  displayTitle,
  isStuck,
  matchesLens,
  type Lens,
  type Lifecycle,
  type Staleness,
} from "./workstreams";
import {
  EASE_CSS,
  SETTLE,
  TURN,
  containerFade,
  distance,
  ease,
  fitBox,
  fitView,
  flatten,
  flightMix,
  flightMs,
  flyView,
  interpolateLayouts,
  labelAlpha,
  labelForm,
  massBox,
  midpoint,
  packLayout,
  placeCaptions as placeCaptionBoxes,
  pinchView,
  radiusFor,
  rimProgress,
  settle as settleShown,
  smoothstep,
  stackEdges,
  turnView,
  turnTilt,
  zoomAt,
  type Box,
  type CaptionSide,
  type Circle,
  type Insets,
  type LabelForm,
  type PackLayout,
  type Point,
  type View,
} from "./layout";
import { Icon } from "@/components/ui/icon";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { cn } from "@/lib/utils";
import { ThreadMenu } from "./threadmenu";
import { Tip } from "@/components/ui/tooltip";
import {
  LENS_LABEL,
  Notice,
  TONE,
  stackOrder,
  useTree,
  type Group,
  type Unit,
} from "./app";

type MapCircle = Circle<MapDatum>;
type ThreadLink = Group["clusters"][number]["threads"][number];

// ---- paint -----------------------------------------------------------------
//
// The budget is inverted on purpose. Done work is the quietest thing on the
// screen — no hue at all, just a faint trace of foreground. Live work carries
// ordinary saturation in one cool family. Only what the reader can act on is
// warm, and only it gets a halo. Every value is a host-theme or default-palette
// utility, so both themes and custom palettes hold.

type Paint = {
  /** Ring color, as `text-*`: the ring is an inset shadow in currentColor. */
  ring: string;
  /**
   * A leaf's tinted fill, or null for a HOLLOW leaf. Filled is Active and
   * hollow is Waiting, so the two lens groups tell apart by shape before hue:
   * two blues at 14 px are one blue to most eyes.
   */
  fill: string | null;
  /**
   * The state's own hue, for the places that name the exact state — a unit
   * dot, the hover tip, the fly-in destination. At the overview every
   * "needs you" state is one rose; the difference is a closer look's business.
   */
  dot: string;
};

const PAINT: Record<Lifecycle, Paint> = {
  blocked: { ring: "text-rose-500", fill: null, dot: "bg-rose-500" },
  "awaiting-followup": { ring: "text-rose-500", fill: null, dot: "bg-orange-500" },
  "approved-with-comments": { ring: "text-rose-500", fill: null, dot: "bg-amber-500" },
  "awaiting-merge": { ring: "text-rose-500", fill: null, dot: "bg-emerald-500" },
  "awaiting-review": { ring: "text-indigo-400", fill: null, dot: "bg-indigo-400" },
  active: { ring: "text-blue-500", fill: "bg-blue-500/30", dot: "bg-blue-500" },
  "in-progress": { ring: "text-blue-400", fill: "bg-blue-400/20", dot: "bg-blue-400" },
  unverified: { ring: "text-amber-400", fill: "bg-amber-400/15", dot: "bg-amber-400" },
  "up-next": { ring: "text-sky-300", fill: "bg-sky-300/20", dot: "bg-sky-300" },
  shipped: { ring: "text-foreground/25", fill: "bg-foreground/[0.07]", dot: "bg-foreground/30" },
  merged: { ring: "text-foreground/20", fill: "bg-foreground/[0.05]", dot: "bg-foreground/25" },
  closed: { ring: "text-foreground/15", fill: null, dot: "bg-foreground/15" },
};

/**
 * "Needs you" is ONE rose at the overview, whichever of the four states it is:
 * a green glow reads as "fine", which is the opposite of the message. `px` is
 * how far past the rim it reaches in SCREEN pixels, so it reads at every zoom.
 */
const HALO = { tone: "bg-rose-500/35", px: 8 } as const;

/**
 * A hollow leaf's neutral wash. Staleness never touches a fill: the fill and
 * ring are status alone, and only STUCK work gets a mark of its own.
 */
const HOLLOW_WASH = "bg-foreground/[0.08]";

/** What a lens excludes keeps its place and reads this loud. */
const LENS_DIM = 0.14;
/** The ring, in screen pixels. Counter-scaled by `--ws-inv`, so it never thickens. */
const RING_PX = { group: 1, leaf: 1.25 } as const;

function isHot(lifecycle: Lifecycle): boolean {
  return HALO_STATES.includes(lifecycle);
}

function lifecycleOf(datum: MapDatum): Lifecycle {
  return datum.kind === "group" ? datum.group.lifecycle : datum.cluster.lifecycle;
}

function isUnsorted(group: Group): boolean {
  return group.key === UNSORTED || group.key.endsWith(`:${UNSORTED}`);
}

const TICKET_SOURCE_LABEL: Record<NonNullable<Unit["ticketSource"]>, string> = {
  branch: "branch",
  linkback: "Linear linkback",
  title: "PR title",
  "description-url": "Linear URL in PR description",
  "description-mention": "ticket mention in PR description",
  directory: "checkout directory",
};

function ticketSources(units: readonly Unit[]): string | null {
  const sources = [...new Set(units.flatMap((unit) => unit.ticketSource === null ? [] : [unit.ticketSource]))];
  return sources.length === 0 ? null : sources.map((source) => TICKET_SOURCE_LABEL[source]).join(" · ");
}

function emptyMapMessage(board: Board | null, hasUnsorted: boolean, showUnsorted: boolean): string {
  if (board === null) return "Loading the map…";
  if (board.scanning) return "Scanning your checkouts…";
  if (board.lastScanAt === null) {
    return board.warnings.length > 0
      ? "No scan has finished. Check the scan notices above, resolve them, then select Rescan."
      : "No scan yet. Open a BB project with checkouts or set scan roots in Plugins → Workstreams, then select Rescan.";
  }
  if (hasUnsorted && !showUnsorted) {
    return "No ticketed checkouts to map. Open More map options to show Unsorted, or add a ticket ID to a branch or PR and select Rescan.";
  }
  return board.warnings.length > 0
    ? "No checkouts found. Check the scan notices above, then select Rescan."
    : "No checkouts found in the scanned locations. Open a BB project with checkouts or set scan roots in Plugins → Workstreams, then select Rescan.";
}

// ---- type ------------------------------------------------------------------
//
// One pairing, at constant screen size: the host's sans for names, its mono for
// ticket ids and counts. A label is measured once per layout, so the per-frame
// question is only "does this circle hold that block".

const TYPE = {
  root: { size: 14, weight: 600, line: 18 },
  group: { size: 12.5, weight: 600, line: 16 },
  summary: { size: 12, weight: 450, line: 15 },
  ticket: { size: 10.5, weight: 500, line: 14 },
} as const;
const UNIT_ROW = 22;
const UNIT_LIST_WIDTH = 360;
const UNIT_LIST_MAX = 12;

let measureContext: CanvasRenderingContext2D | null = null;

function fontFamilies(): { sans: string; mono: string } {
  if (typeof document === "undefined") return { sans: "sans-serif", mono: "monospace" };
  const root = getComputedStyle(document.documentElement);
  const mono = root.getPropertyValue("--font-mono").trim();
  return {
    sans: getComputedStyle(document.body).fontFamily || "sans-serif",
    mono: mono === "" ? "monospace" : mono,
  };
}

function textWidth(text: string, size: number, weight: number, family: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (measureContext === null) return text.length * size * 0.56;
  measureContext.font = `${weight} ${size}px ${family}`;
  return Math.ceil(measureContext.measureText(text).width);
}

/**
 * A name set in up to two balanced lines, broken HERE rather than by the
 * browser, so the block that was measured is the block that renders and an
 * over-long name ends in a real ellipsis ("…") instead of a clamp artifact.
 */
function wrapBlock(
  text: string,
  measure: (text: string) => number,
  line: number,
  oneLineMax: number,
  twoLineMax: number,
): { width: number; height: number; lines: string[] } {
  const total = measure(text);
  if (total <= oneLineMax) return { width: total, height: line, lines: [text] };
  const target = Math.min(twoLineMax, Math.ceil(total / 2) + 16);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((entry) => entry !== "")) {
    const next = current === "" ? word : `${current} ${word}`;
    if (current === "" || measure(next) <= target) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length > 2) {
    let last = lines[1]!;
    while (last.includes(" ") && measure(`${last}…`) > target) last = last.slice(0, last.lastIndexOf(" "));
    lines.splice(1, lines.length - 1, `${last.replace(/[\s,;:.–—-]+$/u, "")}…`);
  }
  return {
    width: Math.max(...lines.map(measure)),
    height: line * lines.length,
    lines,
  };
}

/** The first word or two, up to `limit` characters: enough to name the place. */
function shortName(name: string, limit = 12): string {
  const words = name.split(/\s+/);
  let out = words[0] ?? name;
  for (const word of words.slice(1)) {
    if ((out + " " + word).length > limit) break;
    out += ` ${word}`;
  }
  return out;
}

/**
 * Short names that tell siblings apart: two efforts that both shorten to
 * "Member" keep adding words until they differ, so a short form never names
 * two places at once.
 */
function distinctShortNames(siblings: readonly MapCircle[]): Map<string, string> {
  const groups = siblings.filter((circle) => circle.data.kind === "group");
  const names = new Map(groups.map((circle) => [circle.key, circle.label]));
  const out = new Map<string, string>();
  for (const limit of [12, 20, 30, Number.POSITIVE_INFINITY]) {
    const pending = groups.filter((circle) => !out.has(circle.key));
    const shorts = new Map(pending.map((circle) => [circle.key, shortName(names.get(circle.key)!, limit)]));
    const counts = new Map<string, number>();
    for (const short of shorts.values()) counts.set(short, (counts.get(short) ?? 0) + 1);
    for (const [key, short] of shorts) {
      if (counts.get(short) === 1 || limit === Number.POSITIVE_INFINITY) out.set(key, short);
    }
  }
  return out;
}

type Facts = {
  lifecycle: Lifecycle;
  hot: boolean;
  staleness: Staleness;
  /** A leaf expected to move that has not been touched in a month; see `isStuck`. */
  stuck: boolean;
  /** Whole days since the leaf's newest commit, or null when no date is readable. */
  untouchedDays: number | null;
  /** Hot clusters anywhere below a group: the heat a neutral ring no longer shows. */
  hotCount: number;
  /** Matches the lens: for a group, when anything inside it does. */
  included: boolean;
  full: string;
  short: string;
  block: { width: number; height: number; lines: string[] };
  need: { full: number; short: number };
  /** The scale at which a child's label (or a leaf's unit list) first shows. */
  childReveal: number;
  /** Units in reading order: each stack together, bottom to top. */
  units: Unit[];
  list: { height: number; need: number } | null;
  /**
   * A top-level circle's caption forms, longest first, for when the circle is
   * too small to hold its name: the clipped name, then the distinct short one.
   */
  caption: { text: string; width: number }[] | null;
};

const CAPTION = { size: 11, weight: 500, line: 14, gap: 3, chars: 26 } as const;
/** Linked threads listed at a fly-in destination before "+N more". */
const THREAD_LIST_MAX = 4;
/** The rose count a group's rim pill carries: its dot, gap and digits. */
function heatWidth(count: number): number {
  return count === 0 ? 0 : 6 + 4 + String(count).length * 7 + 6;
}

/** Whole words up to a couple of dozen characters: a caption, not a sentence. */
function captionText(name: string): string {
  if (name.length <= CAPTION.chars) return name;
  let out = "";
  for (const word of name.split(/\s+/)) {
    if ((out === "" ? word : `${out} ${word}`).length > CAPTION.chars - 1) break;
    out = out === "" ? word : `${out} ${word}`;
  }
  return `${out === "" ? name.slice(0, CAPTION.chars - 1) : out}…`;
}

/** Whole days since the newest readable commit across a leaf's checkouts. */
function untouchedDays(units: readonly Unit[]): number | null {
  const newest = Math.max(
    ...units.map((unit) => (unit.lastCommitAt === null ? Number.NaN : Date.parse(unit.lastCommitAt))).filter(
      (at) => !Number.isNaN(at),
    ),
  );
  return Number.isFinite(newest) ? Math.max(0, Math.floor((Date.now() - newest) / DAY_MS)) : null;
}

function describe(
  circles: readonly MapCircle[],
  lens: Lens,
): Map<string, Facts> {
  const fonts = fontFamilies();
  const facts = new Map<string, Facts>();
  const shorts = distinctShortNames(circles.filter((circle) => circle.depth === 0));
  for (const circle of circles) {
    for (const [key, short] of distinctShortNames(circle.children)) shorts.set(key, short);
  }
  // Deepest first, so a parent can read its children's needs.
  for (const circle of [...circles].reverse()) {
    const datum = circle.data;
    const lifecycle = lifecycleOf(datum);
    if (datum.kind === "cluster") {
      const cluster = datum.cluster;
      const ticketWidth = textWidth(cluster.ticket, TYPE.ticket.size, TYPE.ticket.weight, fonts.mono);
      const summary = wrapBlock(
        cluster.summary,
        (text) => textWidth(text, TYPE.summary.size, TYPE.summary.weight, fonts.sans),
        TYPE.summary.line,
        150,
        176,
      );
      const block = {
        width: Math.max(ticketWidth, summary.width),
        height: TYPE.ticket.line + summary.height,
        lines: summary.lines,
      };
      const units = stackOrder(cluster.units);
      const rows = Math.min(units.length, UNIT_LIST_MAX) + (units.length > UNIT_LIST_MAX ? 1 : 0);
      const threadRows =
        cluster.threads.length === 0
          ? 0
          : 1 + Math.min(cluster.threads.length, THREAD_LIST_MAX) + (cluster.threads.length > THREAD_LIST_MAX ? 1 : 0);
      const listHeight = (rows + threadRows) * UNIT_ROW + 8;
      const listNeed = radiusFor(UNIT_LIST_WIDTH, listHeight + TYPE.ticket.line * 2);
      facts.set(circle.key, {
        lifecycle,
        hot: isHot(lifecycle),
        staleness: cluster.staleness,
        stuck: isStuck(cluster),
        untouchedDays: untouchedDays(cluster.units),
        hotCount: 0,
        included: matchesLens(lifecycle, lens),
        full: cluster.summary,
        short: cluster.ticket,
        block,
        need: {
          full: radiusFor(block.width, block.height),
          short: radiusFor(ticketWidth, TYPE.ticket.line),
        },
        childReveal: units.length === 0 ? Number.POSITIVE_INFINITY : listNeed / circle.r,
        units,
        list: units.length === 0 ? null : { height: listHeight, need: listNeed },
        caption: null,
      });
      continue;
    }
    const group = datum.group;
    const type = circle.depth === 0 ? TYPE.root : TYPE.group;
    const short = shorts.get(circle.key) ?? shortName(group.name);
    const kids = circle.children.map((child) => ({ child, facts: facts.get(child.key)! }));
    const hotCount = kids.reduce(
      (total, kid) => total + (kid.child.data.kind === "cluster" ? (kid.facts.hot ? 1 : 0) : kid.facts.hotCount),
      0,
    );
    const heat = heatWidth(hotCount);
    const named = wrapBlock(
      group.name,
      (text) => textWidth(text, type.size, type.weight, fonts.sans),
      type.line,
      160,
      210,
    );
    const block = { ...named, width: named.width + heat };
    facts.set(circle.key, {
      lifecycle,
      hot: isHot(lifecycle),
      staleness: group.staleness,
      stuck: false,
      untouchedDays: null,
      hotCount,
      included: kids.length === 0 ? matchesLens(lifecycle, lens) : kids.some((kid) => kid.facts.included),
      full: group.name,
      short,
      block,
      need: {
        full: radiusFor(block.width, block.height),
        short: radiusFor(textWidth(short, type.size, type.weight, fonts.sans) + heat, type.line),
      },
      childReveal: Math.min(
        Number.POSITIVE_INFINITY,
        ...kids.map((kid) => kid.facts.need.short / kid.child.r),
      ),
      units: [],
      list: null,
      caption:
        circle.depth === 0
          ? [captionText(group.name), short]
              .map((text) => ({ text, width: textWidth(text, CAPTION.size, CAPTION.weight, fonts.sans) }))
              // A short form earns its place only by being narrower.
              .filter((form, index, forms) => index === 0 || form.width < forms[0]!.width)
          : null,
    });
  }
  return facts;
}

// ---- per-frame decisions ----------------------------------------------------

type Decision = {
  form: LabelForm;
  alpha: number;
  rim: number;
  dots: number;
  list: number;
};

/** What a circle shows at one scale. Pure: a flight asks it about both ends. */
function decideAt(circle: MapCircle, facts: Facts, scale: number): Decision {
  const screenR = circle.r * scale;
  const form = labelForm(screenR, facts.need);
  const list = facts.list === null ? 0 : labelAlpha(screenR, facts.list.need);
  return {
    form,
    // One ramp from the short form's threshold: a full name REPLACES the short
    // one in place rather than fading out and back in.
    alpha: form === "none" ? 0 : labelAlpha(screenR, facts.need.short),
    // A group always shows its children, so its name always rides the rim as
    // a pill: a name centred over child rings needs a text-shadow to survive
    // and still reads as naming the child under it. Only a leaf, whose
    // children are dots, keeps its name in the middle until its list arrives.
    rim: circle.data.kind === "group" ? 1 : rimProgress(scale, facts.childReveal),
    dots: facts.units.length === 0 ? 0 : smoothstep(14, 24, screenR) * (1 - list),
    list,
  };
}

/**
 * Mid-flight: each value travels in one third of the flight. What leaves goes
 * early and what arrives comes late; a parent's move to its rim goes early and
 * its return goes late. So a parent's name has cleared the middle before a
 * child's appears, and the end state is exactly `decideAt(to)`.
 */
function decideInFlight(a: Decision, b: Decision, t: number): Decision {
  return {
    form: a.alpha > 0 && (t < 2 / 3 || b.alpha === 0) ? a.form : b.form,
    alpha: flightMix(a.alpha, b.alpha, t, b.alpha < a.alpha),
    rim: flightMix(a.rim, b.rim, t, b.rim > a.rim),
    dots: flightMix(a.dots, b.dots, t, b.dots < a.dots),
    list: flightMix(a.list, b.list, t, b.list < a.list),
  };
}

/** What each continuous value last settled on, per circle, for the hysteresis. */
type Settled = { alpha: boolean | null; rim: boolean | null; dots: boolean | null; list: boolean | null };

/**
 * A decision at rest: every value snapped to 0 or 1 through the hysteresis
 * band, remembering what it settled on so the next rest can hold it.
 */
function settleDecision(decision: Decision, previous: Settled | undefined): { decision: Decision; settled: Settled } {
  const alpha = decision.form === "none" ? false : settleShown(decision.alpha, previous?.alpha ?? null);
  const rim = settleShown(decision.rim, previous?.rim ?? null);
  const dots = settleShown(decision.dots, previous?.dots ?? null);
  const list = settleShown(decision.list, previous?.list ?? null);
  return {
    decision: { form: decision.form, alpha: alpha ? 1 : 0, rim: rim ? 1 : 0, dots: dots ? 1 : 0, list: list ? 1 : 0 },
    settled: { alpha, rim, dots, list },
  };
}

/** The discrete part of a decision: what React has to know to mount things. */
function code(decision: Decision): string {
  return `${decision.form[0]}${decision.dots > 0 ? "d" : ""}${decision.list > 0 ? "l" : ""}`;
}

/**
 * A caption outside a circle's rim: a top-level circle's name, or a hot leaf's
 * ticket. `chip` puts it on the page's own background, for a ticket that could
 * only be placed over a quiet neighbour.
 */
type ShownCaption = { side: CaptionSide; text: string; kind: "root" | "hot"; chip: boolean };

type Scene = {
  /** The layout the scene was decided on: a turn waits for the new face's first scene. */
  layout: PackLayout<MapDatum> | null;
  keys: readonly string[];
  codes: ReadonlyMap<string, string>;
  /** Top-level circles captioned outside their rim. */
  captions: ReadonlyMap<string, ShownCaption>;
  signature: string;
};

const EMPTY_SCENE: Scene = { layout: null, keys: [], codes: new Map(), captions: new Map(), signature: "" };

/**
 * What the map's chrome covers, in screen pixels. The lens and legend float
 * over the bottom edge, and a root's name rides up onto its rim as a pill that
 * stands proud of the circle, so fit-all keeps the mass clear of both.
 */
const CHROME: Insets = { top: 32, right: 24, bottom: 58, left: 24 };

/** The legend sits above the controls when both cannot fit side by side. */
function chromeInsets(width: number): Insets {
  return width < 400 ? { ...CHROME, bottom: 118 } : width < 760 ? { ...CHROME, bottom: 92 } : CHROME;
}

/**
 * The glance test at fit-all: every top-level circle should be nameable. One
 * too small to hold its name gets a caption outside its rim, on whichever
 * side collides with nothing — no circle, no visible label, no rim pill, no
 * other caption, no chrome. A shorter form is tried before giving up, and
 * giving up beats overlap: a caption over another circle names the wrong thing.
 */
function placeCaptions(
  circles: readonly MapCircle[],
  layoutIndex: ReadonlyMap<string, MapCircle>,
  roots: readonly MapCircle[],
  facts: ReadonlyMap<string, Facts>,
  decisions: ReadonlyMap<string, Decision>,
  view: View,
  size: { width: number; height: number },
): Map<string, ShownCaption> {
  const screen = (circle: MapCircle) => ({
    x: view.x + circle.x * view.scale,
    y: view.y + circle.y * view.scale,
    r: circle.r * view.scale,
  });
  const labels: Box[] = [];
  for (const circle of circles) {
    const decision = decisions.get(circle.key);
    const circleFacts = facts.get(circle.key);
    if (decision === undefined || circleFacts === undefined || decision.alpha <= 0) continue;
    const { x, y: cy, r } = screen(circle);
    const y = cy - r * decision.rim;
    const width = decision.form === "full" ? circleFacts.block.width : circleFacts.need.short * 1.6;
    const height = decision.form === "full" ? circleFacts.block.height : 16;
    labels.push({ left: x - width / 2 - 8, right: x + width / 2 + 8, top: y - height / 2 - 2, bottom: y + height / 2 + 2 });
  }
  const requests = roots.flatMap((circle) => {
    const decision = decisions.get(circle.key);
    const caption = facts.get(circle.key)?.caption;
    if (decision === undefined || caption == null || decision.alpha > 0) return [];
    return [{ key: circle.key, ...screen(circle), forms: caption.map((form) => form.width) }];
  });
  // A leaf that needs you is named whether or not it can hold its name: the
  // map answers "which ticket" for exactly those without a hover.
  const mono = fontFamilies().mono;
  const ancestors = (circle: MapCircle): string[] => {
    const out: string[] = [];
    for (let key = circle.parentKey; key !== null; key = layoutIndex.get(key)?.parentKey ?? null) out.push(key);
    return out;
  };
  const hot = circles.flatMap((circle) => {
    const decision = decisions.get(circle.key);
    if (circle.data.kind !== "cluster" || decision === undefined || decision.alpha > 0) return [];
    if (!facts.get(circle.key)?.hot) return [];
    const ticket = circle.data.cluster.ticket;
    return [
      {
        key: circle.key,
        ...screen(circle),
        forms: [textWidth(ticket, TYPE.ticket.size, TYPE.ticket.weight, mono) + 8],
        within: ancestors(circle),
      },
    ];
  });
  const mounted = circles.filter((circle) => decisions.has(circle.key));
  const bounds = { left: 4, top: 4, right: size.width - 4, bottom: size.height - chromeInsets(size.width).bottom + 12 };
  const metrics = { height: CAPTION.line, gap: CAPTION.gap, clearance: 2, pad: 3 };
  const placed = placeCaptionBoxes(
    [...requests, ...hot],
    { circles: mounted.map((circle) => ({ key: circle.key, ...screen(circle) })), boxes: labels, bounds },
    metrics,
  );
  // A hot ticket with no clear side still gets named, on a chip, over a quiet
  // neighbour — never over another hot leaf, a label or another caption.
  const unplaced = hot.filter((request) => !placed.has(request.key));
  const taken = [...labels, ...[...placed.values()].map((placement) => placement.box)];
  const chips = placeCaptionBoxes(
    unplaced,
    {
      circles: hot.map((request) => ({ key: request.key, x: request.x, y: request.y, r: request.r })),
      boxes: taken,
      bounds,
    },
    metrics,
  );
  const out = new Map<string, ShownCaption>();
  for (const [key, placement] of [...placed, ...chips]) {
    const circle = layoutIndex.get(key);
    if (circle?.data.kind === "cluster") {
      out.set(key, { side: placement.side, text: circle.data.cluster.ticket, kind: "hot", chip: chips.has(key) });
    } else {
      out.set(key, {
        side: placement.side,
        text: facts.get(key)!.caption![placement.form]!.text,
        kind: "root",
        chip: false,
      });
    }
  }
  return out;
}

// ---- motion ----------------------------------------------------------------

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * First paint settles once per session — not per mount, not per refresh, not
 * per tab switch — so it lives at module scope rather than in component state.
 */
let entranceDone = false;
/** ≤ 120 ms of stagger per nesting level, per the motion brief. */
const ENTRANCE_STAGGER = 100;
const ENTRANCE_MS = 380;

const CULL_MARGIN = 48;
const MIN_SCREEN_R = 0.5;
const ZOOM_STEP = 1.3;
const PAN_STEP = 96;
/** A click flies to the shallowest circle that does not already fill this much. */
const FILLS_VIEW = 0.42;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Whether a circle is big enough to see and inside the viewport, under a view. */
function onScreen(
  circle: MapCircle,
  view: View,
  size: { width: number; height: number },
): boolean {
  const screenR = circle.r * view.scale;
  const cx = view.x + circle.x * view.scale;
  const cy = view.y + circle.y * view.scale;
  return (
    screenR >= MIN_SCREEN_R &&
    cx + screenR >= -CULL_MARGIN &&
    cy + screenR >= -CULL_MARGIN &&
    cx - screenR <= size.width + CULL_MARGIN &&
    cy - screenR <= size.height + CULL_MARGIN
  );
}

function circleTransform(circle: MapCircle): string {
  return `translate(${circle.x - circle.r}px, ${circle.y - circle.r}px)`;
}

function ringShadow(px: number): string {
  return `inset 0 0 0 calc(${px}px * var(--ws-inv, 1)) currentColor`;
}

// ---- rendering -------------------------------------------------------------

/**
 * A leaf's paint, shared by the resting map and the turn: the neutral ground,
 * then either the lifecycle tint (filled: Active) or a neutral wash (hollow:
 * Waiting), always at full strength so a colour means one thing. The outer
 * layer is the paint loop's: the color recedes as the unit list arrives, so a
 * flown-to leaf is a tinted room, not a loud disc.
 */
function LeafFill({
  facts,
  circleKey,
  register,
}: {
  facts: Facts;
  circleKey?: string;
  register?: (kind: "fill", key: string, node: HTMLElement | null) => void;
}) {
  const paint = PAINT[facts.lifecycle];
  return (
    <div
      ref={register === undefined || circleKey === undefined ? undefined : (node) => register("fill", circleKey, node)}
      aria-hidden
      className="pointer-events-none absolute inset-0"
    >
      <div
        className={cn("absolute inset-0 rounded-full", paint.fill ?? HOLLOW_WASH)}
        // What a lens excludes loses its colour but keeps its place.
        style={{ opacity: facts.included || paint.fill === null ? 1 : 0, transition: `opacity 300ms ${EASE_CSS}` }}
      />
    </div>
  );
}

/** A leaf's ring in its lifecycle's color: the status half of the encoding. */
function LeafRing({ facts }: { facts: Facts }) {
  return (
    <div
      className={cn("absolute inset-0 rounded-full", PAINT[facts.lifecycle].ring)}
      style={{
        boxShadow: ringShadow(RING_PX.leaf * (facts.hot ? 1.3 : 1)),
        opacity: facts.included ? 0.9 : 0,
        transition: `opacity 300ms ${EASE_CSS}`,
      }}
    />
  );
}

/**
 * A mark on a leaf's rim, at 45° toward (`sx`, `sy`): world space to the rim
 * point, then counter-scaled so the mark is the same few pixels at every zoom.
 * The thread mark takes the upper right and the stuck mark the lower left, so
 * the two can never collide.
 */
function rimMark(r: number, sx: 1 | -1, sy: 1 | -1): string {
  return `translate(${r + sx * r * Math.SQRT1_2}px, ${r + sy * r * Math.SQRT1_2}px) scale(var(--ws-inv, 1)) translate(-50%, -50%)`;
}

/** The thread mark's hit target, in screen pixels: the dot stays 7 px. */
const DOOR_PX = { fine: 24, coarse: 40 } as const;

type Door = {
  /** Hit target in screen pixels. */
  hit: number;
  /** Most recent first. */
  threads: readonly ThreadLink[];
  ticket: string;
  onOpenThread: (id: string) => void;
  /** "+N more": fly into the leaf, whose own list names them all. */
  onMore: () => void;
  /** Hover or focus: the leaf `T` opens the newest thread of. */
  onShow: (shown: boolean) => void;
};

/**
 * "An agent works here": a small dot on a leaf's rim when a BB thread is
 * linked to it, pulsing slowly — opacity only — while that thread is running.
 * With a `door` it is also the way in to those threads: a hit target far
 * larger than the dot, which never lets its click reach the circle's fly-to.
 */
function ThreadMark({ r, active, door }: { r: number; active: boolean; door?: Door }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!active || reducedMotion()) return;
    const animation = ref.current?.animate([{ opacity: 1 }, { opacity: 0.3 }], {
      duration: 1400,
      direction: "alternate",
      iterations: Number.POSITIVE_INFINITY,
      easing: EASE_CSS,
    });
    return () => animation?.cancel();
  }, [active]);
  const dot = (
    <span
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none size-[7px] shrink-0 rounded-full ring-[1.5px] ring-background",
        active ? "bg-foreground" : "bg-foreground/60",
      )}
    />
  );
  if (door === undefined) {
    return (
      <span aria-hidden className="pointer-events-none absolute left-0 top-0 flex origin-top-left" style={{ transform: rimMark(r, 1, -1) }}>
        {dot}
      </span>
    );
  }
  return (
    <ThreadMenu
      threads={door.threads}
      onOpenThread={door.onOpenThread}
      onMore={door.onMore}
      onHoverChange={door.onShow}
      data={{ "data-thread-mark": "" }}
      heading={
        <>
          {door.threads.length === 1 ? "1 thread" : `${door.threads.length} threads`}
          <span className="ml-1.5 font-mono font-medium">{door.ticket}</span>
        </>
      }
      footer={
        <>
          <kbd className="font-mono">T</kbd> opens the newest
        </>
      }
      className="absolute left-0 top-0 flex origin-top-left items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ transform: rimMark(r, 1, -1), width: door.hit, height: door.hit }}
    >
      {dot}
    </ThreadMenu>
  );
}

/**
 * Stuck: expected to move, untouched for a month or more. A pause glyph on a
 * chip of the page's own background, neutral in colour because colour is
 * already status: it is the SHAPE that says "stopped". Counter-scaled, so it
 * reads at fit-all and never grows up close.
 */
function StuckMark({ r }: { r: number }) {
  return (
    <span className="pointer-events-none absolute left-0 top-0 flex origin-top-left" style={{ transform: rimMark(r, -1, 1) }}>
      <Tip label="Stuck: expected to move, untouched for a month or more">
        <span role="img" aria-label="Stuck: expected to move, untouched for a month or more" className="pointer-events-auto flex">
          <StuckGlyph />
        </span>
      </Tip>
    </span>
  );
}

function StuckGlyph() {
  return (
    <span className="flex size-[11px] items-center justify-center gap-[1.5px] rounded-full bg-background ring-1 ring-foreground/45">
      <span className="h-[5px] w-[1.5px] rounded-full bg-foreground/90" />
      <span className="h-[5px] w-[1.5px] rounded-full bg-foreground/90" />
    </span>
  );
}

/** A dashed rim: Claude thought this grouping looked mixed. Theme face only. */
function DashedRim({ r }: { r: number }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible text-foreground/50" width={r * 2} height={r * 2}>
      <circle
        cx={r}
        cy={r}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeDasharray="calc(5px * var(--ws-edge, 1)) calc(4px * var(--ws-edge, 1))"
        style={{ strokeWidth: "calc(1.25px * var(--ws-edge, 1))" }}
      />
    </svg>
  );
}

function isMixed(circle: MapCircle): boolean {
  return circle.data.kind === "group" && circle.data.group.cohesion?.verdict === "mixed";
}

/**
 * One circle. Children are siblings in the DOM, not descendants, so the lens
 * can dim a group without dimming what is inside it, and paint order (parents
 * first) puts the deepest circle under the pointer. Only the ring lifts on
 * hover; the fill stays put so nesting never shimmers.
 */
const CircleView = memo(function CircleView({
  circle,
  facts,
  showDots,
  hovered,
  register,
  doorPx,
  onDoor,
  onDoorShown,
  onOpenThread,
  byRecency,
}: {
  circle: MapCircle;
  facts: Facts;
  showDots: boolean;
  hovered: boolean;
  register: (kind: "circle" | "dots" | "fill", key: string, node: HTMLElement | null) => void;
  doorPx: number;
  onDoor: (key: string) => void;
  onDoorShown: (key: string, shown: boolean) => void;
  onOpenThread: (id: string) => void;
  byRecency: (threads: readonly ThreadLink[]) => ThreadLink[];
}) {
  const leaf = circle.data.kind === "cluster";
  const size = circle.r * 2;
  const threads = circle.data.kind === "cluster" ? circle.data.cluster.threads : [];
  return (
    <div
      ref={(node) => register("circle", circle.key, node)}
      data-key={circle.key}
      // A hot leaf stands on solid ground: its halo sits behind it, and a
      // translucent fill would let the halo flood the room once flown into.
      className={cn(
        "absolute left-0 top-0 cursor-pointer rounded-full",
        leaf && facts.hot && "bg-background",
      )}
      style={{
        width: size,
        height: size,
        transform: circleTransform(circle),
        opacity: facts.included ? 1 : LENS_DIM,
        // A refresh that changes a radius step eases siblings to their new
        // places; a lens switch only fades. Neither ever animates layout.
        transition: `transform 350ms ${EASE_CSS}, opacity 300ms ${EASE_CSS}`,
      }}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-full",
          leaf ? "bg-foreground/[0.03]" : "bg-foreground/[0.035]",
        )}
      />
      {leaf ? <LeafFill facts={facts} circleKey={circle.key} register={register} /> : null}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          transform: hovered ? "scale(1.035)" : "none",
          // Leave is faster than enter.
          transition: `transform ${hovered ? 220 : 120}ms ${EASE_CSS}`,
        }}
      >
        {/* A group's ring is neutral at every depth: the biggest shapes on
            screen must not be the loudest. Heat is the rim pill's count. */}
        {isMixed(circle) ? (
          <DashedRim r={circle.r} />
        ) : (
          <div
            className={cn("absolute inset-0 rounded-full", leaf ? "text-foreground/15" : "text-foreground/20")}
            style={{ boxShadow: ringShadow(leaf ? RING_PX.leaf : RING_PX.group) }}
          />
        )}
        {leaf ? <LeafRing facts={facts} /> : null}
      </div>
      {leaf && showDots ? (
        <UnitDots circle={circle} units={facts.units} register={register} />
      ) : null}
      {leaf && facts.stuck ? <StuckMark r={circle.r} /> : null}
      {threads.length > 0 ? (
        <ThreadMark
          r={circle.r}
          active={threads.some((thread) => thread.active)}
          door={{
            hit: doorPx,
            threads: byRecency(threads),
            ticket: circle.data.kind === "cluster" ? circle.data.cluster.ticket : "",
            onOpenThread,
            onMore: () => onDoor(circle.key),
            onShow: (shown) => onDoorShown(circle.key, shown),
          }}
        />
      ) : null}
    </div>
  );
});

/**
 * A leaf's checkouts as dots on a ring, each in its lifecycle's color. A stack
 * reads as a chain: its members sit adjacent in merge order, joined by a line.
 */
function UnitDots({
  circle,
  units,
  register,
}: {
  circle: MapCircle;
  units: Unit[];
  register: (kind: "circle" | "dots" | "fill", key: string, node: HTMLElement | null) => void;
}) {
  const r = circle.r;
  const ring = r * 0.72;
  const count = units.length;
  const dot = Math.min(r * 0.13, count === 1 ? r * 0.2 : ring * Math.sin(Math.PI / count) * 0.62);
  const points = units.map((_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    return { x: r + Math.cos(angle) * ring, y: r + Math.sin(angle) * ring };
  });
  const links: { from: Point; to: Point; key: string }[] = [];
  units.forEach((unit, index) => {
    const next = units[index + 1];
    if (unit.stack !== null && next?.stack?.id === unit.stack.id) {
      links.push({ from: points[index]!, to: points[index + 1]!, key: `${unit.path}>${next.path}` });
    }
  });
  return (
    <div
      ref={(node) => register("dots", circle.key, node)}
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ opacity: 0, transition: SETTLE_FADE }}
    >
      {links.length === 0 ? null : (
        <svg className="absolute inset-0 overflow-visible text-foreground/40" width={r * 2} height={r * 2}>
          {links.map((link) => (
            <line
              key={link.key}
              x1={link.from.x}
              y1={link.from.y}
              x2={link.to.x}
              y2={link.to.y}
              stroke="currentColor"
              strokeWidth={dot * 0.35}
              strokeLinecap="round"
            />
          ))}
        </svg>
      )}
      {units.map((unit, index) => (
        <div
          key={unit.path}
          className={cn("absolute rounded-full", PAINT[unit.lifecycle].dot)}
          style={{
            width: dot * 2,
            height: dot * 2,
            transform: `translate(${points[index]!.x - dot}px, ${points[index]!.y - dot}px)`,
          }}
        />
      ))}
    </div>
  );
}

/** Text that stays legible over any fill: a halo of the page's own background. */
const LEGIBLE = "[text-shadow:0_0_3px_var(--background),0_0_1px_var(--background)]";

/** The settle snap, in a CSS transition: zero while the view moves, short at rest. */
const SETTLE_FADE = `opacity var(--ws-fade, 0ms) ${EASE_CSS}`;

/** Lines broken by `wrapBlock`, each on its own row so the render matches the measure. */
function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className="block whitespace-nowrap">
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * A circle's name, at constant screen size wherever the circle is. Placed at
 * the circle's centre in world space and counter-scaled by `--ws-inv`; the
 * paint loop writes only its opacity and `--rim`, the screen-pixel offset that
 * slides it up onto the rim. A group's name always rides the rim as a pill,
 * with a rose count of what inside it needs you.
 */
const LabelView = memo(function LabelView({
  circle,
  facts,
  form,
  register,
}: {
  circle: MapCircle;
  facts: Facts;
  form: LabelForm;
  register: (kind: "label", key: string, node: HTMLElement | null) => void;
}) {
  const leaf = circle.data.kind === "cluster";
  const done = !facts.hot && ["shipped", "merged", "closed"].includes(facts.lifecycle);
  return (
    <div
      ref={(node) => register("label", circle.key, node)}
      // `w-max`: inside a zero-width stage, shrink-to-fit would otherwise
      // resolve to min-content and break a name at every opportunity.
      className="pointer-events-none absolute left-0 top-0 w-max origin-top-left"
      style={{
        transform: `translate(${circle.x}px, ${circle.y}px) scale(var(--ws-inv, 1)) translateY(var(--rim, 0px)) translate(-50%, -50%)`,
        opacity: 0,
        // At rest a label snaps shown or hidden — and a leaf's name to or off
        // its rim — through this; in motion it is instant and the ramp rules.
        transition: `${SETTLE_FADE}, transform var(--ws-fade, 0ms) ${EASE_CSS}`,
      }}
    >
      <div
        className="relative flex flex-col items-center text-center"
        style={{ opacity: facts.included ? 1 : 0.45, transition: `opacity 300ms ${EASE_CSS}` }}
      >
        {/* The rim pill: invisible while a leaf's name sits in the middle,
            solid by the time it straddles the ring line it would be cut by. */}
        <span
          aria-hidden
          className="absolute -inset-x-2 -inset-y-0.5 rounded-full border border-border/70 bg-background"
          style={{ opacity: "var(--rim-bg, 0)" }}
        />
        {leaf ? (
          <>
            <span
              className={cn(
                "relative whitespace-nowrap font-mono tracking-tight",
                LEGIBLE,
                form === "short" ? "text-foreground/80" : "text-muted-foreground",
              )}
              style={{ fontSize: TYPE.ticket.size, lineHeight: `${TYPE.ticket.line}px`, fontWeight: TYPE.ticket.weight }}
            >
              {circle.data.kind === "cluster" ? circle.data.cluster.ticket : ""}
            </span>
            {form === "full" && facts.full !== facts.short ? (
              <span
                className={cn("relative", LEGIBLE, done ? "text-muted-foreground" : "text-foreground")}
                style={{
                  fontSize: TYPE.summary.size,
                  lineHeight: `${TYPE.summary.line}px`,
                  fontWeight: TYPE.summary.weight,
                }}
              >
                <Lines lines={facts.block.lines} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="relative flex items-center gap-1.5">
            <span
              className={cn("tracking-tight", done ? "text-muted-foreground" : "text-foreground")}
              style={{
                fontSize: circle.depth === 0 ? TYPE.root.size : TYPE.group.size,
                lineHeight: `${circle.depth === 0 ? TYPE.root.line : TYPE.group.line}px`,
                fontWeight: TYPE.group.weight,
              }}
            >
              {form === "full" ? <Lines lines={facts.block.lines} /> : <span className="whitespace-nowrap">{facts.short}</span>}
            </span>
            {facts.hotCount === 0 ? null : (
              <span
                className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-medium text-rose-500"
                title={`${facts.hotCount} need you`}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-rose-500" />
                {facts.hotCount}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * Where a caption hangs off its circle: a rim point in world space, then a
 * screen-pixel offset after the counter-scale, so the gap never scales. Must
 * agree with layout.ts's `captionBox`, which decided the placement.
 */
const CAPTION_ANCHOR: Record<CaptionSide, { dx: number; dy: number; shift: string }> = {
  below: { dx: 0, dy: 1, shift: `translate(-50%, ${CAPTION.gap}px)` },
  above: { dx: 0, dy: -1, shift: `translate(-50%, calc(-100% - ${CAPTION.gap}px))` },
  right: { dx: 1, dy: 0, shift: `translate(${CAPTION.gap}px, -50%)` },
  left: { dx: -1, dy: 0, shift: `translate(calc(-100% - ${CAPTION.gap}px), -50%)` },
};

/**
 * A name set outside its circle's rim: a top-level circle too small to hold
 * its own, or a hot leaf's ticket, in mono, so the map says which ticket needs
 * you without a hover.
 */
function Caption({ circle, caption }: { circle: MapCircle; caption: ShownCaption }) {
  const anchor = CAPTION_ANCHOR[caption.side];
  const hot = caption.kind === "hot";
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-0 top-0 origin-top-left whitespace-nowrap transition-opacity duration-200 starting:opacity-0",
        hot ? "px-1 font-mono text-foreground/85" : "text-muted-foreground",
        caption.chip ? "rounded-full border border-border/70 bg-background/90" : LEGIBLE,
      )}
      style={{
        transform: `translate(${circle.x + anchor.dx * circle.r}px, ${circle.y + anchor.dy * circle.r}px) scale(var(--ws-inv, 1)) ${anchor.shift}`,
        fontSize: hot ? TYPE.ticket.size : CAPTION.size,
        lineHeight: `${CAPTION.line}px`,
        fontWeight: CAPTION.weight,
      }}
    >
      {caption.text}
    </div>
  );
}

/**
 * A leaf's checkouts as a short list, once the leaf is big enough to hold one:
 * repo, lifecycle, PR link and its cleaned title, with each stack drawn as a
 * chain in merge order. Selectable text; links work; clicks here never fly.
 */
const TIER_LABEL = { started: "started here", environment: "runs here", ticket: "names it", paths: "worked here" } as const;

const UnitList = memo(function UnitList({
  circle,
  facts,
  register,
  onOpenThread,
}: {
  circle: MapCircle;
  facts: Facts;
  register: (kind: "list", key: string, node: HTMLElement | null) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const shown = facts.units.slice(0, UNIT_LIST_MAX);
  const hidden = facts.units.length - shown.length;
  const threads = circle.data.kind === "cluster" ? circle.data.cluster.threads : [];
  const shownThreads = threads.slice(0, THREAD_LIST_MAX);
  return (
    <div
      ref={(node) => register("list", circle.key, node)}
      data-units
      className="absolute left-0 top-0 origin-top-left cursor-auto select-text"
      style={{
        width: UNIT_LIST_WIDTH,
        transform: `translate(${circle.x}px, ${circle.y}px) scale(var(--ws-inv, 1)) translate(-50%, -50%)`,
        opacity: 0,
        pointerEvents: "none",
        transition: SETTLE_FADE,
      }}
    >
      {/* The destination pays off the halo: what state this is, in words. */}
      <p
        className={cn("mb-1.5 flex items-center gap-1.5 pl-1 text-[12px] font-semibold", LEGIBLE)}
      >
        <span className={cn("size-2 rounded-full", PAINT[facts.lifecycle].dot)} aria-hidden />
        <span className={facts.hot ? PAINT[facts.lifecycle].ring : "text-foreground"}>
          {TONE[facts.lifecycle].label}
        </span>
        <span className="font-normal text-muted-foreground">
          · {facts.units.length} {facts.units.length === 1 ? "checkout" : "checkouts"}
        </span>
      </p>
      <ul className="flex flex-col">
        {shown.map((unit, index) => {
          const stack = unit.stack;
          const above = shown[index - 1];
          const below = shown[index + 1];
          const linkUp = stack !== null && above?.stack?.id === stack.id;
          const linkDown = stack !== null && below?.stack?.id === stack.id;
          const title = unit.pr === null ? (unit.branch ?? unit.path) : displayTitle(unit.pr.title);
          return (
            <li
              key={unit.path}
              className={cn("relative flex items-center gap-2 pl-5 text-[11.5px]", LEGIBLE)}
              style={{ height: UNIT_ROW }}
              title={unit.ticketSource === null ? undefined : `Ticket found in ${TICKET_SOURCE_LABEL[unit.ticketSource]}`}
            >
              {linkUp || linkDown ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-[6.5px] w-px bg-foreground/30",
                    linkUp && linkDown ? "inset-y-0" : linkUp ? "top-0 bottom-1/2" : "top-1/2 bottom-0",
                  )}
                />
              ) : null}
              <span
                role="img"
                aria-label={TONE[unit.lifecycle].label}
                title={TONE[unit.lifecycle].label}
                className={cn(
                  "absolute left-1 top-1/2 size-[7px] -translate-y-1/2 rounded-full",
                  PAINT[unit.lifecycle].dot,
                )}
              />
              <span className="flex shrink-0 items-center gap-1">
                <span className="w-[5.5rem] shrink-0 truncate font-semibold text-foreground">
                  {unit.repo ?? unit.dirName}
                </span>
                {unit.pr === null ? (
                  <span className="shrink-0 font-mono text-[10.5px] font-medium text-muted-foreground" title={unit.observed?.pr === false ? "GitHub status unavailable; rescan to check for a pull request" : undefined}>{unit.observed?.pr === false ? "PR ?" : "no PR"}</span>
                ) : (
                  <UrlLink
                    href={unit.pr.url}
                    className="shrink-0 font-mono text-[11px] font-semibold text-foreground underline-offset-2 hover:underline"
                  >
                    #{unit.pr.number}
                  </UrlLink>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={title}>
                {title}
              </span>
              {isHot(unit.lifecycle) ? (
                <span className={cn("shrink-0 text-[10.5px] font-medium", PAINT[unit.lifecycle].ring)}>
                  {TONE[unit.lifecycle].label}
                </span>
              ) : null}
              {stack === null ? null : (
                <span
                  className="shrink-0 font-mono text-[10px] text-muted-foreground/80"
                  title={
                    stack.blockedBelow === null
                      ? `Bottom of a stack of ${stack.size}`
                      : `Cannot merge until #${stack.blockedBelow} below it merges`
                  }
                >
                  {stack.position}/{stack.size}
                </span>
              )}
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="pl-5 text-[11px] text-muted-foreground" style={{ height: UNIT_ROW }}>
            +{hidden} more on the Board
          </li>
        ) : null}
      </ul>
      {/* The threads working this ticket. Read-only: a click opens one in BB
          through the host's own navigation, and nothing here writes to it. */}
      {threads.length === 0 ? null : (
        <ul className="flex flex-col">
          <li
            className={cn("flex items-end pl-1 text-[11px] font-semibold text-muted-foreground", LEGIBLE)}
            style={{ height: UNIT_ROW }}
          >
            {threads.length === 1 ? "1 thread" : `${threads.length} threads`}
          </li>
          {shownThreads.map((thread) => (
            <li key={thread.id} style={{ height: UNIT_ROW }}>
              <button
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className={cn(
                  "relative flex h-full w-full min-w-0 items-center gap-2 rounded pl-5 pr-1 text-left text-[11.5px] hover:bg-foreground/[0.05]",
                  LEGIBLE,
                )}
                title={`Open this thread in BB. Linked because it ${TIER_LABEL[thread.tier]}.`}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-1 top-1/2 size-[7px] -translate-y-1/2 rounded-full",
                    thread.active ? "bg-foreground" : "bg-foreground/40",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
                <span className="shrink-0 text-[10.5px] text-muted-foreground">
                  {thread.active ? "running · " : ""}
                  {TIER_LABEL[thread.tier]}
                </span>
              </button>
            </li>
          ))}
          {threads.length > THREAD_LIST_MAX ? (
            <li className="pl-5 text-[11px] text-muted-foreground" style={{ height: UNIT_ROW }}>
              +{threads.length - THREAD_LIST_MAX} more on the Board
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
});

/**
 * Merge dependencies that leave their cluster: the one structure no flat list
 * can show. Quiet at the overview, legible up close — the paint loop owns the
 * layer's opacity.
 */
const EdgeLayer = memo(function EdgeLayer({
  edges,
  layerRef,
}: {
  edges: ReturnType<typeof stackEdges<MapDatum>>;
  layerRef: React.RefObject<SVGSVGElement | null>;
}) {
  if (edges.length === 0) return null;
  return (
    <svg
      ref={layerRef}
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible text-foreground/60"
      width={1}
      height={1}
      style={{ opacity: 0 }}
    >
      {edges.map((edge) => (
        <path
          key={`${edge.id}\u0000${edge.fromKey}\u0000${edge.toKey}`}
          d={`M ${edge.from.x} ${edge.from.y} Q ${edge.control.x} ${edge.control.y} ${edge.to.x} ${edge.to.y}`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray="calc(4px * var(--ws-edge, 1)) calc(3px * var(--ws-edge, 1))"
          style={{ strokeWidth: "calc(1.25px * var(--ws-edge, 1))" }}
        />
      ))}
    </svg>
  );
});

/** The segmented lens: the three lifecycle groups plus All. Dims; never moves. */
function LensToggle({ lens, onChange }: { lens: Lens; onChange: (lens: Lens) => void }) {
  return (
    <div role="group" aria-label="Status lens" className="flex items-center">
      {LENSES.map((entry) => (
        <button
          key={entry}
          type="button"
          aria-pressed={lens === entry}
          onClick={() => onChange(entry)}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11.5px] transition-colors duration-150",
            lens === entry
              ? "bg-foreground/[0.08] font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LENS_LABEL[entry]}
        </button>
      ))}
    </div>
  );
}

/** The one menu: things a reader wants rarely enough that they need not show. */
function Overflow({
  unsorted,
  showUnsorted,
  onShowUnsorted,
}: {
  unsorted: Group | null;
  showUnsorted: boolean;
  onShowUnsorted: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div ref={rootRef} className="relative">
      <Tip label="More map options">
        <button
          type="button"
          aria-label="More map options"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </Tip>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-9 left-0 w-64 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
        >
          {unsorted === null ? null : (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={showUnsorted}
              onClick={() => onShowUnsorted(!showUnsorted)}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.05]"
            >
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                {showUnsorted ? <Icon name="Check" className="size-3.5" /> : null}
              </span>
              <span className="min-w-0">
                Show {unsorted.total} unsorted {unsorted.total === 1 ? "checkout" : "checkouts"}
                <span className="block text-[11px] text-muted-foreground">
                  Ticketless clones. Hidden by default — they are not work.
                </span>
              </span>
            </button>
          )}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Click a circle to fly in, the background to back out.{" "}
            <kbd className="font-mono">Esc</kbd> fits all · <kbd className="font-mono">V</kbd>{" "}
            switches to the Board.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The key, in the map's own marks and the lens's own words. Always shown: the
 * four things every circle is — filled is Active, hollow is Waiting, faint is
 * Done, and the rose halo is what only you can move. The modifiers layered on
 * top wait behind a `?` that opens on hover or focus and floats above the
 * legend, so opening it never moves the map.
 */
function Swatch({ ring, fill, px = 1.25 }: { ring: string; fill?: string; px?: number }) {
  return (
    <span className={cn("relative size-2.5 shrink-0 rounded-full", ring)} style={{ boxShadow: `inset 0 0 0 ${px}px currentColor` }}>
      {fill === undefined ? null : <span className={cn("absolute inset-0 rounded-full", fill)} />}
    </span>
  );
}

function Legend() {
  const item = "flex items-center gap-1.5";
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className={item}>
        <Swatch ring="text-blue-500" fill={PAINT.active.fill!} />
        {LENS_LABEL.active}
      </span>
      <span className={item}>
        <Swatch ring="text-indigo-400" />
        {LENS_LABEL.waiting}
      </span>
      <span className={item}>
        <Swatch ring="text-foreground/25" fill="bg-foreground/[0.07]" px={1} />
        {LENS_LABEL.done}
      </span>
      <span className={item}>
        <span className="relative flex size-3 items-center justify-center">
          <span className="absolute -inset-0.5 rounded-full bg-rose-500/35" />
          <span className="relative flex">
            <Swatch ring="text-rose-500" fill="bg-background" px={1.5} />
          </span>
        </span>
        Needs you
      </span>
    </div>
  );
}

/** Theme · Risk. The same clusters, grouped by a different dimension; `[` and `]` turn. */
function FaceToggle({ face, onTurn }: { face: Face; onTurn: (face: Face) => void }) {
  return (
    <div role="group" aria-label="Map face" className="flex items-center">
      {FACES.map((entry) => (
        <Tip key={entry} label={`Show the ${FACE_LABEL[entry]} face ([ and ] turn the map)`}>
          <button
            type="button"
            aria-pressed={face === entry}
            aria-label={`Show the ${FACE_LABEL[entry]} face ([ and ] turn the map)`}
            onClick={() => onTurn(entry)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11.5px] transition-colors duration-150",
              face === entry
                ? "bg-foreground/[0.08] font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FACE_LABEL[entry]}
          </button>
        </Tip>
      ))}
    </div>
  );
}

/** A container's name during a turn: a rim pill, fading with its container. */
function TurnPill({ circle, facts, form }: { circle: MapCircle; facts: Facts; form: LabelForm }) {
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 w-max origin-top-left"
      style={{
        transform: `translate(${circle.x}px, ${circle.y - circle.r}px) scale(var(--ws-inv, 1)) translate(-50%, -50%)`,
      }}
    >
      <span className="flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 py-0.5 text-center">
        <span
          className="tracking-tight text-foreground"
          style={{
            fontSize: circle.depth === 0 ? TYPE.root.size : TYPE.group.size,
            lineHeight: `${circle.depth === 0 ? TYPE.root.line : TYPE.group.line}px`,
            fontWeight: TYPE.group.weight,
          }}
        >
          {form === "full" ? <Lines lines={facts.block.lines} /> : <span className="whitespace-nowrap">{facts.short}</span>}
        </span>
        {facts.hotCount === 0 ? null : (
          <span className="flex items-center gap-1 font-mono text-[11px] font-medium text-rose-500">
            <span aria-hidden className="size-1.5 rounded-full bg-rose-500" />
            {facts.hotCount}
          </span>
        )}
      </span>
    </div>
  );
}

/** The containers of one face, in one wrapper whose opacity the turn fades. */
function TurnContainers({
  layout,
  facts,
  view,
  size,
  incoming,
  wrapperRef,
}: {
  layout: PackLayout<MapDatum>;
  facts: ReadonlyMap<string, Facts>;
  view: View;
  size: { width: number; height: number };
  incoming: boolean;
  wrapperRef: (node: HTMLElement | null) => void;
}) {
  const groups = flatten(layout).filter(
    (circle) => circle.data.kind === "group" && onScreen(circle, view, size),
  );
  return (
    <div ref={wrapperRef} className="pointer-events-none" style={{ opacity: incoming ? 0 : 1 }}>
      {groups.map((circle) => (
        <div
          key={circle.key}
          className="absolute left-0 top-0 rounded-full"
          style={{ width: circle.r * 2, height: circle.r * 2, transform: circleTransform(circle) }}
        >
          <div className="absolute inset-0 rounded-full bg-foreground/[0.035]" />
          {isMixed(circle) ? (
            <DashedRim r={circle.r} />
          ) : (
            <div className="absolute inset-0 rounded-full text-foreground/20" style={{ boxShadow: ringShadow(RING_PX.group) }} />
          )}
        </div>
      ))}
      {groups.map((circle) => {
        const circleFacts = facts.get(circle.key);
        if (circleFacts === undefined) return null;
        const decision = decideAt(circle, circleFacts, view.scale);
        if (decision.form === "none" || decision.alpha < 0.5) return null;
        return <TurnPill key={`pill:${circle.key}`} circle={circle} facts={circleFacts} form={decision.form} />;
      })}
    </div>
  );
}

/**
 * Everything a turn shows, mounted ONCE when it starts: the outgoing face's
 * containers, the incoming face's, and every cluster as one node that travels
 * from its old place to its new one. The frames then write only transforms and
 * opacities, so nothing lays out until the turn lands.
 */
const TurnLayer = memo(function TurnLayer({
  turn,
  fromFacts,
  toFacts,
  leafFacts,
  selected,
  size,
  nodesRef,
}: {
  turn: Turn;
  fromFacts: ReadonlyMap<string, Facts>;
  toFacts: ReadonlyMap<string, Facts>;
  leafFacts: ReadonlyMap<string, Facts>;
  selected: string | null;
  size: { width: number; height: number };
  nodesRef: React.RefObject<{
    leaves: Map<string, HTMLElement>;
    outgoing: HTMLElement | null;
    incoming: HTMLElement | null;
  }>;
}) {
  const leaves = flatten(turn.fromLayout).filter((circle) => {
    if (circle.data.kind !== "cluster") return false;
    const landed = turn.toLayout.index.get(circle.key);
    return onScreen(circle, turn.vFrom, size) || (landed !== undefined && onScreen(landed, turn.vTo, size));
  });
  return (
    <>
      <TurnContainers
        layout={turn.fromLayout}
        facts={fromFacts}
        view={turn.vFrom}
        size={size}
        incoming={false}
        wrapperRef={(node) => {
          nodesRef.current.outgoing = node;
        }}
      />
      <TurnContainers
        layout={turn.toLayout}
        facts={toFacts}
        view={turn.vTo}
        size={size}
        incoming
        wrapperRef={(node) => {
          nodesRef.current.incoming = node;
        }}
      />
      {leaves.map((circle) => {
        const facts = leafFacts.get(circle.key);
        if (facts === undefined || circle.data.kind !== "cluster") return null;
        const cluster = circle.data.cluster;
        // The clusters a reader is most likely following carry their ticket
        // through the turn: the one in focus, the selection, and every one
        // that needs you, which is named at the overview on both faces.
        const named = facts.hot || circle.key === turn.focus || cluster.ticket === selected;
        return (
          <div
            key={circle.key}
            ref={(node) => {
              if (node === null) nodesRef.current.leaves.delete(circle.key);
              else nodesRef.current.leaves.set(circle.key, node);
            }}
            className="pointer-events-none absolute left-0 top-0"
            style={{
              width: circle.r * 2,
              height: circle.r * 2,
              transform: circleTransform(circle),
              opacity: facts.included ? 1 : LENS_DIM,
            }}
          >
            {facts.hot ? (
              <div
                className={cn("absolute inset-0 rounded-full", HALO.tone)}
                style={{ transform: `scale(calc(1 + var(--ws-inv, 1) * ${HALO.px / circle.r}))` }}
              />
            ) : null}
            <div className={cn("absolute inset-0 rounded-full", facts.hot ? "bg-background" : "bg-foreground/[0.03]")} />
            <LeafFill facts={facts} />
            <div className="absolute inset-0 rounded-full text-foreground/15" style={{ boxShadow: ringShadow(RING_PX.leaf) }} />
            <LeafRing facts={facts} />
            {facts.stuck ? <StuckMark r={circle.r} /> : null}
            {cluster.threads.length > 0 ? (
              <ThreadMark r={circle.r} active={cluster.threads.some((thread) => thread.active)} />
            ) : null}
            {named ? (
              <span
                className="absolute left-0 top-0 origin-top-left whitespace-nowrap rounded-full border border-border/70 bg-background/90 px-1 font-mono text-foreground"
                style={{
                  transform: `translate(${circle.r}px, ${circle.r}px) scale(var(--ws-inv, 1)) translate(-50%, -50%)`,
                  fontSize: TYPE.ticket.size,
                  lineHeight: `${TYPE.ticket.line}px`,
                  fontWeight: TYPE.ticket.weight,
                }}
              >
                {cluster.ticket}
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
});

const STALE_WORDS: Record<Staleness, string> = {
  fresh: "this week",
  recent: "this month",
  cold: "1–3 months ago",
  dead: "over 3 months ago",
};

function untouchedWords(days: number | null): string {
  if (days === null) return "no readable commit date";
  return `no commits in ${days} ${days === 1 ? "day" : "days"}`;
}

function threadSummary(threads: readonly { active: boolean }[]): string {
  const running = threads.filter((thread) => thread.active).length;
  const count = `${threads.length} BB ${threads.length === 1 ? "thread" : "threads"}`;
  return running === 0 ? count : `${count} · ${running} running now`;
}

// ---- the view --------------------------------------------------------------

type Flight = { from: View; to: View; started: number; ms: number };

/** A turn in progress: both faces' geometry, the two views, and where it lands. */
type Turn = {
  to: Face;
  fromLayout: PackLayout<MapDatum>;
  toLayout: PackLayout<MapDatum>;
  vFrom: View;
  vTo: View;
  /** The cluster the reader was focused on, landed on again on the other face. */
  focus: string | null;
};

export function MapView({
  board,
  prefs,
  onPrefs,
  selected,
  onSelect,
}: {
  board: Board | null;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** The cluster ticket shared with the Board, so a tab switch keeps its place. */
  selected: string | null;
  onSelect: (ticket: string | null) => void;
}) {
  // A scan that lands mid-gesture must not yank the space out from under the
  // hand: hold it until the gesture or flight ends.
  const [shownBoard, setShownBoard] = useState(board);
  const pendingBoardRef = useRef<Board | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    if (busyRef.current) pendingBoardRef.current = board;
    else setShownBoard(board);
  }, [board]);
  const settle = useCallback(() => {
    busyRef.current = false;
    const pending = pendingBoardRef.current;
    if (pending !== null) {
      pendingBoardRef.current = null;
      setShownBoard(pending);
    }
  }, []);

  // Unsorted is every ticketless parked clone the scan found. On the Map it
  // is a large circle that represents no work, and it shrinks every real
  // group, so it is off by default and folded into the overflow menu.
  const [showUnsorted, setShowUnsorted] = useState(false);
  const { roots, childrenOf } = useTree(shownBoard);
  const unsorted = useMemo(() => roots.find(isUnsorted) ?? null, [roots]);
  const shownRoots = useMemo(
    () => (showUnsorted ? roots : roots.filter((group) => !isUnsorted(group))),
    [roots, showUnsorted],
  );
  // Both faces are laid out up front: a turn needs the geometry of the face it
  // is turning to before it starts, and packing is a pure function of the board.
  const layouts = useMemo(() => {
    const clusters = shownRoots.flatMap(function under(group: Group): Group["clusters"] {
      const children = childrenOf(group.key);
      return children.length === 0 ? group.clusters : children.flatMap(under);
    });
    return {
      theme: packLayout(themeFace(shownRoots, childrenOf)),
      risk: packLayout(riskFace(clusters)),
    } satisfies Record<Face, PackLayout<MapDatum>>;
  }, [shownRoots, childrenOf]);
  const face: Face = prefs.face;
  const otherFace: Face = face === "theme" ? "risk" : "theme";
  const layout = layouts[face];
  const circles = useMemo(() => flatten(layout), [layout]);
  // The map honors the lens only. The Board's staleness and surface filters
  // have no control here, and an invisible filter is worse than none.
  const facts = useMemo(() => describe(circles, prefs.lens), [circles, prefs.lens]);
  // The face a turn would land on, described ahead of time so a turn starts
  // on its first frame rather than after a measuring pass.
  const otherFacts = useMemo(
    () => describe(flatten(layouts[otherFace]), prefs.lens),
    [layouts, otherFace, prefs.lens],
  );
  const edges = useMemo(
    () =>
      stackEdges(layout, (leaf) =>
        leaf.data.kind === "cluster"
          ? leaf.data.cluster.units.flatMap((unit) =>
              unit.stack === null ? [] : [{ id: unit.stack.id, position: unit.stack.position }],
            )
          : [],
      ),
    [layout],
  );
  const hot = useMemo(
    () => circles.filter((circle) => circle.data.kind === "cluster" && facts.get(circle.key)?.hot),
    [circles, facts],
  );

  const navigate = useBbNavigate();
  // Threads open through the host's own navigation, never a hand-built URL.
  const openThread = useCallback((threadId: string) => navigate.toThread(threadId), [navigate]);
  const doorPx = usePointerCoarse() ? DOOR_PX.coarse : DOOR_PX.fine;
  // When each thread last moved, from the host's own sidebar cache: no extra
  // request, and nothing added to the board's wire shape.
  const sidebarThreads = experimental_useSidebarThreads().threads;
  const threadUpdatedAt = useMemo(
    () => new Map(sidebarThreads.map((thread) => [thread.id, thread.updatedAt])),
    [sidebarThreads],
  );
  /** Most recent first: running before idle, then by when the host last saw each move. */
  const byRecency = useCallback(
    (threads: readonly ThreadLink[]) =>
      [...threads].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          (threadUpdatedAt.get(b.id) ?? 0) - (threadUpdatedAt.get(a.id) ?? 0),
      ),
    [threadUpdatedAt],
  );
  /** The leaf whose thread mark is hovered or focused: its popover is up. */
  const [door, setDoor] = useState<string | null>(null);
  const doorRef = useRef<string | null>(null);
  doorRef.current = door;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** The last time the view moved for any reason: labels settle this long after. */
  const lastMotionRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRef = useRef(new Map<string, Settled>());
  const turnRef = useRef<Turn | null>(null);
  const [turning, setTurning] = useState<Turn | null>(null);
  const edgeRef = useRef<SVGSVGElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const [compactHud, setCompactHud] = useState(false);
  const frameRef = useRef<number | null>(null);
  const flightRef = useRef<Flight | null>(null);
  const flightFrameRef = useRef<number | null>(null);
  const focusRef = useRef<string | null>(null);
  const fittedRef = useRef(false);
  const restoredRef = useRef(false);
  const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<{ view: View; center: Point; span: number } | null>(null);
  const suppressClickRef = useRef(false);
  /**
   * What was under the pointer when it went down. Pointer capture retargets
   * the click to the viewport, so the click has to be resolved against this.
   */
  const downTargetRef = useRef<HTMLElement | null>(null);
  const decisionsRef = useRef(new Map<string, Decision>());
  const nodesRef = useRef({
    circle: new Map<string, HTMLElement>(),
    dots: new Map<string, HTMLElement>(),
    fill: new Map<string, HTMLElement>(),
    label: new Map<string, HTMLElement>(),
    list: new Map<string, HTMLElement>(),
  });

  const [scene, setScene] = useState<Scene>(EMPTY_SCENE);
  const [hover, setHover] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hover;

  const register = useCallback(
    (kind: "circle" | "dots" | "fill" | "label" | "list", key: string, node: HTMLElement | null) => {
      const nodes = nodesRef.current[kind];
      if (node === null) nodes.delete(key);
      else nodes.set(key, node);
    },
    [],
  );

  // Fit the drawn mass, not the circle around it, into what the chrome leaves.
  const fitAllView = useCallback(
    () => fitBox(massBox(layout.roots), sizeRef.current, chromeInsets(sizeRef.current.width)),
    [layout],
  );

  /** The zoom range: out to half of fit-all, in until the smallest leaf is roomy. */
  const bounds = useCallback((forLayout = layout) => {
    const size = sizeRef.current;
    if (forLayout.world.r === 0 || size.width === 0) return { min: 0.05, max: 40 };
    const fit = forLayout === layout
      ? fitAllView().scale
      : fitBox(massBox(forLayout.roots), size, chromeInsets(size.width)).scale;
    const smallest = Math.min(...(forLayout === layout ? circles : flatten(forLayout)).map((circle) => circle.r));
    return { min: fit * 0.5, max: Math.max(fit * 2, fitView({ x: 0, y: 0, r: smallest }, size).scale * 1.6) };
  }, [layout, circles, fitAllView]);

  /** The world may drift off-centre, never off-screen: getting lost is the failure. */
  const clampView = useCallback(
    (next: View, forLayout = layout): View => {
      const size = sizeRef.current;
      const { min, max } = bounds(forLayout);
      const scale = clamp(next.scale, min, max);
      const r = forLayout.world.r * scale;
      const margin = Math.min(96, r);
      return {
        scale,
        x: clamp(next.x, -r + margin, size.width + r - margin),
        y: clamp(next.y, -r + margin, size.height + r - margin),
      };
    },
    [bounds, layout],
  );

  /** Write every continuous decision straight to the DOM: no React involved. */
  const applyDecisions = useCallback(() => {
    const nodes = nodesRef.current;
    const scale = viewRef.current.scale;
    for (const [key, decision] of decisionsRef.current) {
      const circle = layout.index.get(key);
      if (circle === undefined) continue;
      const label = nodes.label.get(key);
      if (label !== undefined) {
        label.style.opacity = String(decision.alpha);
        label.style.setProperty("--rim", `${-circle.r * scale * decision.rim}px`);
        label.style.setProperty("--rim-bg", String(smoothstep(0.35, 0.9, decision.rim)));
      }
      const fill = nodes.fill.get(key);
      if (fill !== undefined) fill.style.opacity = String(1 - 0.85 * decision.list);
      const dots = nodes.dots.get(key);
      if (dots !== undefined) dots.style.opacity = String(decision.dots);
      const list = nodes.list.get(key);
      if (list !== undefined) {
        list.style.opacity = String(decision.list);
        list.style.pointerEvents = decision.list > 0.6 ? "auto" : "none";
      }
    }
  }, [layout]);

  const placeTip = useCallback(() => {
    const view = viewRef.current;
    const tip = tipRef.current;
    const key = hoverRef.current;
    if (tip === null) return;
    const circle = key === null ? undefined : layout.index.get(key);
    if (circle === undefined) return;
    const x = view.x + circle.x * view.scale;
    const y = view.y + (circle.y - circle.r) * view.scale;
    tip.style.transform = `translate(${x}px, ${Math.max(y - 10, 36)}px) translate(-50%, -100%)`;
  }, [layout]);

  /**
   * The only place the view reaches the DOM. Decides every mounted circle's
   * label, rim and unit reveal from its RENDERED radius; tells React only when
   * the mounted set or a discrete decision actually changed.
   */
  /** The view's transform, written to the stage. Shared by paint and the turn. */
  const writeStage = useCallback((view: View) => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    stage.style.setProperty("--ws-inv", String(1 / view.scale));
    // SVG strokes relayout their root on every style change, so the edges and
    // dashed rims get their own counter-scale, stepped by quarter-octaves: it
    // changes a few times per flight instead of every frame.
    const edgeInv = String(2 ** (-Math.round(Math.log2(view.scale) * 4) / 4));
    if (stage.style.getPropertyValue("--ws-edge") !== edgeInv) {
      stage.style.setProperty("--ws-edge", edgeInv);
    }
  }, []);

  /**
   * The only place the view reaches the DOM at rest and in flight. Decides
   * every mounted circle's label, rim and unit reveal from its RENDERED
   * radius; tells React only when the mounted set or a discrete decision
   * actually changed. Once the view has been still for `SETTLE.restMs`, every
   * value snaps to shown or hidden through the hysteresis band.
   */
  const paint = useCallback(() => {
    frameRef.current = null;
    // A turn drives its own frames and owns the stage while it runs.
    if (turnRef.current !== null) return;
    const view = viewRef.current;
    const stage = stageRef.current;
    const size = sizeRef.current;
    if (stage === null) return;
    writeStage(view);

    const flight = flightRef.current;
    const now = performance.now();
    const moving =
      flight !== null || pointersRef.current.size > 0 || now - lastMotionRef.current < SETTLE.restMs;
    const fade = moving ? "0ms" : `${SETTLE.fadeMs}ms`;
    if (stage.style.getPropertyValue("--ws-fade") !== fade) stage.style.setProperty("--ws-fade", fade);
    if (moving && settleTimerRef.current === null) {
      // Come back once the view has been still long enough to settle.
      // Through a ref: this closure may outlive the layout it was made for.
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => paintRef.current());
      }, SETTLE.restMs + 20);
    }

    const t = flight === null ? 1 : clamp((now - flight.started) / flight.ms, 0, 1);
    const decisions = new Map<string, Decision>();
    const keys: string[] = [];
    const codes = new Map<string, string>();
    let signature = "";
    // A flight zooms about one fixed screen point, so everything visible
    // mid-flight is visible at one of its two ends. Mounting that union for the
    // whole flight means nothing mounts or unmounts per frame — each insertion
    // would be a layout.
    const ends = flight === null ? [view] : [flight.from, flight.to];
    for (const circle of circles) {
      if (!ends.some((end) => onScreen(circle, end, size))) continue;
      const circleFacts = facts.get(circle.key);
      if (circleFacts === undefined) continue;
      let decision =
        flight === null
          ? decideAt(circle, circleFacts, view.scale)
          : decideInFlight(
              decideAt(circle, circleFacts, flight.from.scale),
              decideAt(circle, circleFacts, flight.to.scale),
              t,
            );
      if (!moving) {
        const settled = settleDecision(decision, settledRef.current.get(circle.key));
        settledRef.current.set(circle.key, settled.settled);
        decision = settled.decision;
      }
      keys.push(circle.key);
      decisions.set(circle.key, decision);
      const discrete = code(decision);
      codes.set(circle.key, discrete);
      signature += `${circle.key}\u0000${discrete}\u0001`;
    }
    decisionsRef.current = decisions;
    // Captions are an overview affordance: they stay out of the way mid-flight.
    const captions =
      flight === null
        ? placeCaptions(circles, layout.index, layout.roots, facts, decisions, view, size)
        : new Map<string, ShownCaption>();
    for (const [key, caption] of captions) {
      signature += `${key}\u0000caption:${caption.side}:${caption.text}:${caption.chip}\u0001`;
    }
    setScene((current) =>
      current.signature === signature && current.layout === layout
        ? current
        : { layout, keys, codes, captions, signature },
    );
    applyDecisions();
    placeTip();
    const edgeLayer = edgeRef.current;
    if (edgeLayer !== null) {
      // Hidden at the overview, where they are noise; legible from mid depth.
      const fit = fitAllView().scale;
      edgeLayer.style.opacity = String(0.8 * smoothstep(fit * 1.6, fit * 3, view.scale));
    }
  }, [applyDecisions, circles, facts, fitAllView, layout, placeTip, writeStage]);

  const paintRef = useRef(paint);
  paintRef.current = paint;

  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  const cancelFlight = useCallback(() => {
    if (flightFrameRef.current !== null) cancelAnimationFrame(flightFrameRef.current);
    flightFrameRef.current = null;
    flightRef.current = null;
  }, []);

  const commit = useCallback(
    (next: View) => {
      viewRef.current = clampView(next);
      lastMotionRef.current = performance.now();
      schedule();
    },
    [clampView, schedule],
  );

  /**
   * Fly the VIEW, never the circles. Reduced motion jumps straight to the goal,
   * and because every label value is a function of the view, the end state is
   * the same either way.
   */
  const flyTo = useCallback(
    (target: View, immediate = false) => {
      cancelFlight();
      const goal = clampView(target);
      if (immediate || reducedMotion()) {
        commit(goal);
        settle();
        return;
      }
      const from = { ...viewRef.current };
      const flight: Flight = { from, to: goal, started: performance.now(), ms: flightMs(from, goal) };
      flightRef.current = flight;
      busyRef.current = true;
      const step = (now: number) => {
        const t = clamp((now - flight.started) / flight.ms, 0, 1);
        viewRef.current = flyView(from, goal, ease(t));
        lastMotionRef.current = now;
        if (t >= 1) {
          flightRef.current = null;
          flightFrameRef.current = null;
          viewRef.current = goal;
          schedule();
          settle();
          return;
        }
        schedule();
        flightFrameRef.current = requestAnimationFrame(step);
      };
      flightFrameRef.current = requestAnimationFrame(step);
    },
    [cancelFlight, clampView, commit, schedule, settle],
  );

  const fitAll = useCallback(
    (immediate = false) => {
      focusRef.current = null;
      onSelect(null);
      flyTo(fitAllView(), immediate);
    },
    [fitAllView, flyTo, onSelect],
  );

  /**
   * The automatic fit on mount and after the world changes size. Unlike the
   * reader's own fit it keeps the shared selection, which is what lets a
   * return from the Board fly back to the cluster that was in focus.
   */
  const settleView = useCallback(() => {
    focusRef.current = null;
    flyTo(fitAllView(), true);
  }, [fitAllView, flyTo]);

  const flyToKey = useCallback(
    (key: string, immediate = false) => {
      const circle = layout.index.get(key);
      if (circle === undefined) return;
      focusRef.current = key;
      onSelect(circle.data.kind === "cluster" ? circle.data.cluster.ticket : null);
      flyTo(fitView(circle, sizeRef.current, 0.9), immediate);
    },
    [flyTo, layout, onSelect],
  );

  /** Back out one level: to the focus's parent, or to the whole map. */
  const flyOut = useCallback(() => {
    const focus = focusRef.current === null ? undefined : layout.index.get(focusRef.current);
    if (focus?.parentKey != null) flyToKey(focus.parentKey);
    else fitAll();
  }, [fitAll, flyToKey, layout]);

  /**
   * A circle you can read is a circle you meant: it is flown to directly.
   * Otherwise a click goes one step deeper than where you are — to the
   * shallowest circle on the way to what you clicked that does not already
   * fill the view — so a level that collapsed to one child is skipped.
   */
  const flyToward = useCallback(
    (key: string) => {
      if (key === focusRef.current) {
        flyOut();
        return;
      }
      if ((decisionsRef.current.get(key)?.alpha ?? 0) >= 0.5) {
        flyToKey(key);
        return;
      }
      const chain: MapCircle[] = [];
      for (let circle = layout.index.get(key); circle !== undefined; ) {
        chain.unshift(circle);
        circle = circle.parentKey === null ? undefined : layout.index.get(circle.parentKey);
      }
      const focus = focusRef.current;
      const below = focus !== null && chain.some((circle) => circle.key === focus)
        ? chain.slice(chain.findIndex((circle) => circle.key === focus) + 1)
        : chain;
      const size = sizeRef.current;
      const roomy = Math.min(size.width, size.height) * FILLS_VIEW;
      const target =
        below.find((circle) => circle.r * viewRef.current.scale < roomy) ?? below[below.length - 1];
      if (target !== undefined) flyToKey(target.key);
    },
    [flyOut, flyToKey, layout],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const size = sizeRef.current;
      flyTo(zoomAt(viewRef.current, { x: size.width / 2, y: size.height / 2 }, factor, bounds()));
    },
    [bounds, flyTo],
  );

  /**
   * Turn the map to another face. The plane tilts while every cluster flies
   * from its place on this face to its place on the next, then untilts; the
   * groups, which exist on one face only, fade. A reader focused on a cluster
   * lands focused on the same cluster, so turning never loses their place.
   * Reduced motion swaps straight to the identical end state.
   */
  const turnTo = useCallback(
    (next: Face) => {
      if (next === face || turnRef.current !== null) return;
      cancelFlight();
      const toLayout = layouts[next];
      const size = sizeRef.current;
      const focused = focusRef.current;
      const target = focused === null ? undefined : toLayout.index.get(focused);
      const focus = target?.data.kind === "cluster" ? target.key : null;
      const source = focus === null || focused === null ? undefined : layout.index.get(focused);
      const fromBox = massBox(layout.roots);
      const toBox = massBox(toLayout.roots);
      const fromFit = source === undefined ? fitAllView() : fitView(source, size, 0.9);
      const toFit = target !== undefined && focus !== null
        ? fitView(target, size, 0.9)
        : fitBox(toBox, size, chromeInsets(size.width));
      const fromAnchor = source ?? { x: (fromBox.left + fromBox.right) / 2, y: (fromBox.top + fromBox.bottom) / 2 };
      const toAnchor = target !== undefined && focus !== null
        ? target
        : { x: (toBox.left + toBox.right) / 2, y: (toBox.top + toBox.bottom) / 2 };
      const vTo = clampView(turnView(viewRef.current, fromFit, toFit, fromAnchor, toAnchor, bounds(toLayout)), toLayout);
      if (focus === null) {
        focusRef.current = null;
        onSelect(null);
      }
      if (reducedMotion() || size.width === 0) {
        focusRef.current = focus;
        viewRef.current = vTo;
        onPrefs({ face: next });
        return;
      }
      const turn: Turn = { to: next, fromLayout: layout, toLayout, vFrom: { ...viewRef.current }, vTo, focus };
      turnRef.current = turn;
      busyRef.current = true;
      setHover(null);
      setTurning(turn);
    },
    [bounds, cancelFlight, clampView, face, fitAllView, layout, layouts, onPrefs, onSelect],
  );

  // The turn's frames: transform and opacity only, on nodes mounted once at
  // its start. Nothing mounts, unmounts or lays out until it lands.
  const turnNodesRef = useRef({
    leaves: new Map<string, HTMLElement>(),
    outgoing: null as HTMLElement | null,
    incoming: null as HTMLElement | null,
  });
  useLayoutEffect(() => {
    const turn = turning;
    if (turn === null || turnRef.current !== turn) return;
    const from = new Map([...turn.fromLayout.index].filter(([, c]) => c.data.kind === "cluster"));
    const to = new Map([...turn.toLayout.index].filter(([, c]) => c.data.kind === "cluster"));
    const nodes = turnNodesRef.current;
    const plane = planeRef.current;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = clamp((now - started) / TURN.ms, 0, 1);
      const e = ease(t);
      const view = flyView(turn.vFrom, turn.vTo, e);
      viewRef.current = view;
      lastMotionRef.current = now;
      writeStage(view);
      if (plane !== null) plane.style.transform = t >= 1 ? "none" : `rotateY(${turnTilt(t)}deg)`;
      for (const [key, pose] of interpolateLayouts(from, to, e)) {
        const node = nodes.leaves.get(key);
        if (node !== undefined) node.style.transform = `translate(${pose.x - pose.r}px, ${pose.y - pose.r}px)`;
      }
      if (nodes.outgoing !== null) nodes.outgoing.style.opacity = String(containerFade(t, false));
      if (nodes.incoming !== null) nodes.incoming.style.opacity = String(containerFade(t, true));
      if (t < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      // Landed. Hand the stage back: switch faces, and let the turn layer
      // stay up until the new face's first scene is ready to replace it.
      viewRef.current = turn.vTo;
      focusRef.current = turn.focus;
      turnRef.current = null;
      onPrefs({ face: turn.to });
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [onPrefs, turning, writeStage]);

  // The new face's first scene replaces the turn layer in one commit.
  useLayoutEffect(() => {
    if (turning === null || turnRef.current !== null || scene.layout !== layout) return;
    setTurning(null);
    settle();
  }, [layout, scene, settle, turning]);

  // `[` and `]` turn the map from anywhere on the page, like `V` switches views.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" && event.key !== "]") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null)
      ) {
        return;
      }
      event.preventDefault();
      const index = FACES.indexOf(face);
      const step = event.key === "]" ? 1 : FACES.length - 1;
      turnTo(FACES[(index + step) % FACES.length]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [face, turnTo]);

  // Track the viewport. Preserve a reader's zoom, but keep a fitted view fitted
  // when a BB sidebar or help panel changes the available width.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      const previous = sizeRef.current;
      if (rect.width === previous.width && rect.height === previous.height) return;
      const priorFit = previous.width > 0 ? fitBox(massBox(layout.roots), previous, chromeInsets(previous.width)) : null;
      const focus = focusRef.current === null ? undefined : layout.index.get(focusRef.current);
      const priorFocus = focus === undefined || previous.width === 0 ? null : fitView(focus, previous, 0.9);
      const near = (target: View | null) => target !== null &&
        Math.abs(viewRef.current.scale / target.scale - 1) < 0.01 &&
        Math.abs(viewRef.current.x - target.x) < 2 &&
        Math.abs(viewRef.current.y - target.y) < 2;
      sizeRef.current = { width: rect.width, height: rect.height };
      setCompactHud(rect.width < 760);
      if (!fittedRef.current && rect.width > 0 && layout.world.r > 0) {
        fittedRef.current = true;
        settleView();
      } else if (near(priorFocus) && focus !== undefined) {
        flyTo(fitView(focus, sizeRef.current, 0.9), true);
      } else if (near(priorFit)) {
        settleView();
      } else {
        commit({
          ...viewRef.current,
          x: viewRef.current.x + (rect.width - previous.width) / 2,
          y: viewRef.current.y + (rect.height - previous.height) / 2,
        });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [commit, flyTo, layout, settleView]);

  // A rescan or the Unsorted toggle can change the world under a valid view.
  useEffect(() => {
    if (!fittedRef.current && sizeRef.current.width > 0 && layout.world.r > 0) {
      fittedRef.current = true;
      settleView();
      return;
    }
    commit(viewRef.current);
  }, [commit, layout, settleView]);

  // Coming back from the Board flies to the cluster that was in focus there.
  useEffect(() => {
    // Once per mount, right after the first fit: later selections are the
    // map's own, and flying to them again would restart a flight mid-air.
    if (restoredRef.current || !fittedRef.current) return;
    restoredRef.current = true;
    const key = selected === null ? "" : clusterKey(selected);
    if (selected !== null && layout.index.has(key)) flyToKey(key);
  }, [flyToKey, layout, scene, selected]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      cancelFlight();
    },
    [cancelFlight],
  );

  // Wheel has to be non-passive to cancel the page's own scroll.
  useEffect(() => {
    const node = viewportRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (turnRef.current !== null) return;
      cancelFlight();
      const rect = node.getBoundingClientRect();
      // A trackpad pinch arrives as ctrl+wheel with small deltas and a mouse
      // wheel in big notches; one exponential handles both smoothly.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0022));
      commit(
        zoomAt(
          viewRef.current,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          factor,
          bounds(),
        ),
      );
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [bounds, cancelFlight, commit]);

  // A circle that mounts between frames gets its decision before it is seen.
  useLayoutEffect(applyDecisions, [applyDecisions, scene, hover]);
  useLayoutEffect(placeTip, [placeTip, hover, door]);

  // First paint: circles settle in once per session, children rising from
  // their parent's centre, one short beat per level. Labels follow the last
  // level in. Transform and opacity only; reduced motion skips it outright.
  useLayoutEffect(() => {
    if (entranceDone || scene.keys.length === 0) return;
    entranceDone = true;
    if (reducedMotion()) return;
    const nodes = nodesRef.current;
    let deepest = 0;
    for (const key of scene.keys) {
      const circle = layout.index.get(key);
      const node = nodes.circle.get(key);
      if (circle === undefined || node === undefined) continue;
      deepest = Math.max(deepest, circle.depth);
      const parent = circle.parentKey === null ? null : layout.index.get(circle.parentKey);
      const origin = parent ?? circle;
      node.animate(
        [
          {
            transform: `translate(${origin.x - circle.r}px, ${origin.y - circle.r}px) scale(0)`,
            opacity: 0,
          },
          { transform: circleTransform(circle), opacity: node.style.opacity || "1" },
        ],
        {
          duration: ENTRANCE_MS,
          delay: circle.depth * ENTRANCE_STAGGER,
          easing: EASE_CSS,
          fill: "backwards",
        },
      );
    }
    const labels = stageRef.current?.querySelector<HTMLElement>("[data-layer='labels']");
    labels?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 260,
      delay: deepest * ENTRANCE_STAGGER + ENTRANCE_MS * 0.6,
      easing: EASE_CSS,
      fill: "backwards",
    });
  }, [layout, scene]);

  const localPoint = useCallback((event: React.PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (turnRef.current !== null) return;
      if ((event.target as HTMLElement).closest("a, [data-hud], [data-units], [data-thread-mark]") !== null) return;
      const pointers = pointersRef.current;
      pointers.set(event.pointerId, localPoint(event));
      downTargetRef.current = event.target as HTMLElement;
      event.currentTarget.setPointerCapture(event.pointerId);
      busyRef.current = true;
      if (pointers.size === 2) {
        // The second finger converts a drag into a pinch, measured from this
        // instant so a long gesture cannot accumulate drift.
        const [first, second] = [...pointers.values()];
        cancelFlight();
        dragRef.current = null;
        pinchRef.current = {
          view: { ...viewRef.current },
          center: midpoint(first!, second!),
          span: distance(first!, second!),
        };
        return;
      }
      pinchRef.current = null;
      dragRef.current =
        pointers.size === 1
          ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
          : null;
    },
    [cancelFlight, localPoint],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      if (pointers.size === 0) {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-key]");
        const key = target?.dataset.key ?? null;
        if (key !== hoverRef.current) setHover(key);
        return;
      }
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, localPoint(event));
      const pinch = pinchRef.current;
      if (pinch !== null && pointers.size === 2) {
        const [first, second] = [...pointers.values()];
        commit(
          pinchView(
            pinch,
            { center: midpoint(first!, second!), span: distance(first!, second!) },
            bounds(),
          ),
        );
        suppressClickRef.current = true;
        return;
      }
      const drag = dragRef.current;
      if (drag === null || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) {
        cancelFlight();
        setHover(null);
      }
      drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const view = viewRef.current;
      commit({ scale: view.scale, x: view.x + dx, y: view.y + dy });
    },
    [bounds, cancelFlight, commit, localPoint],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      pointers.delete(event.pointerId);
      if (pointers.size === 0 && flightRef.current === null) settle();
      if (pinchRef.current !== null) {
        // Lifting one finger ends the gesture rather than handing the remaining
        // one a drag it never started.
        pinchRef.current = null;
        dragRef.current = null;
        suppressClickRef.current = true;
        return;
      }
      const drag = dragRef.current;
      if (drag === null || drag.id !== event.pointerId) return;
      dragRef.current = null;
      // A drag that moved must not also register as a click.
      suppressClickRef.current = drag.moved;
    },
    [settle],
  );

  /** Click and double-click are one interaction: fly toward what is under the pointer. */
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (event.detail > 1 || turnRef.current !== null) return;
      const target = downTargetRef.current ?? (event.target as HTMLElement);
      downTargetRef.current = null;
      if (target.closest("a, [data-hud], [data-units], [data-thread-mark]") !== null) return;
      const circle = target.closest<HTMLElement>("[data-key]");
      if (circle?.dataset.key !== undefined) flyToward(circle.dataset.key);
      else flyOut();
    },
    [flyOut, flyToward],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (turnRef.current !== null) return;
      const view = viewRef.current;
      switch (event.key) {
        case "+":
        case "=":
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          zoomBy(1 / ZOOM_STEP);
          break;
        case "0":
        case "Escape":
          fitAll();
          break;
        case "Backspace":
          flyOut();
          break;
        case "t":
        case "T": {
          // The focused leaf's most recent thread: the one whose mark has
          // focus, else the leaf flown to. No thread, no action.
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          const key = doorRef.current ?? focusRef.current;
          const circle = key === null ? undefined : layout.index.get(key);
          const newest = circle?.data.kind === "cluster" ? byRecency(circle.data.cluster.threads)[0] : undefined;
          if (newest === undefined) return;
          openThread(newest.id);
          break;
        }
        case "ArrowLeft":
          commit({ ...view, x: view.x + PAN_STEP });
          break;
        case "ArrowRight":
          commit({ ...view, x: view.x - PAN_STEP });
          break;
        case "ArrowUp":
          commit({ ...view, y: view.y + PAN_STEP });
          break;
        case "ArrowDown":
          commit({ ...view, y: view.y - PAN_STEP });
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [byRecency, commit, fitAll, flyOut, layout, openThread, zoomBy],
  );

  const mounted = useMemo(
    () =>
      turning !== null
        ? []
        : scene.keys.map((key) => layout.index.get(key)).filter((circle) => circle !== undefined),
    [layout, scene, turning],
  );
  const mountedSet = useMemo(() => new Set(scene.keys), [scene]);
  /** The thread menu's "+N more": fly to the leaf, whose own list names them all. */
  const onDoor = useCallback((key: string) => flyToKey(key), [flyToKey]);
  const onDoorShown = useCallback((key: string, shown: boolean) => {
    setDoor((current) => (shown ? key : current === key ? null : current));
  }, []);
  const hoverCircle = hover === null ? undefined : layout.index.get(hover);
  const hoverFacts = hover === null ? undefined : facts.get(hover);
  const hoverCode = hover === null ? undefined : scene.codes.get(hover);
  const hoverTicketSources = hoverCircle?.data.kind === "cluster"
    ? ticketSources(hoverCircle.data.cluster.units)
    : null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={viewportRef}
        tabIndex={0}
        role="application"
        aria-label="Workstreams map. Click a circle to fly into it and the background to back out; wheel or pinch to zoom, drag to pan, Escape to see everything, T to open a focused cluster's newest thread. The Board view lists the same data."
        // touch-none hands pan and pinch to this element instead of the page.
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ perspective: 1400 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (pointersRef.current.size === 0) setHover(null);
        }}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {/* The plane a turn tilts. Flat at rest; perspective lives on the
            viewport, so the tilt reads as turning an object, not skewing it. */}
        <div ref={planeRef} className="absolute inset-0" style={{ transformOrigin: "50% 50%" }}>
        <div ref={stageRef} className="absolute left-0 top-0 origin-top-left">
          {turning === null ? null : (
            <TurnLayer
              turn={turning}
              fromFacts={turning.fromLayout === layout ? facts : otherFacts}
              toFacts={turning.toLayout === layout ? facts : otherFacts}
              leafFacts={facts}
              selected={selected}
              size={sizeRef.current}
              nodesRef={turnNodesRef}
            />
          )}
          {/* Halos sit under every circle and outside the lens: "needs you" is
              an encoding that shows in every lens, at every zoom. */}
          <div data-layer="halos" aria-hidden className="pointer-events-none">
            {turning !== null
              ? null
              : hot.map((circle) => {
                  if (!mountedSet.has(circle.key)) return null;
                  return (
                    <div
                      key={circle.key}
                      className={cn("absolute left-0 top-0 rounded-full", HALO.tone)}
                      style={{
                        width: circle.r * 2,
                        height: circle.r * 2,
                        transform: `${circleTransform(circle)} scale(calc(1 + var(--ws-inv, 1) * ${HALO.px / circle.r}))`,
                        transition: `transform 350ms ${EASE_CSS}`,
                      }}
                    />
                  );
                })}
          </div>
          {mounted.map((circle) => (
            <CircleView
              key={circle.key}
              circle={circle}
              facts={facts.get(circle.key)!}
              showDots={scene.codes.get(circle.key)?.includes("d") === true}
              hovered={hover === circle.key}
              register={register}
              doorPx={doorPx}
              onDoor={onDoor}
              onDoorShown={onDoorShown}
              onOpenThread={openThread}
              byRecency={byRecency}
            />
          ))}
          {turning === null ? <EdgeLayer edges={edges} layerRef={edgeRef} /> : null}
          <div data-layer="labels">
            {mounted.map((circle) => {
              const discrete = scene.codes.get(circle.key) ?? "n";
              const form: LabelForm =
                discrete[0] === "f" ? "full" : discrete[0] === "s" ? "short" : "none";
              return (
                <Fragment key={circle.key}>
                  {form === "none" ? null : (
                    <LabelView
                      circle={circle}
                      facts={facts.get(circle.key)!}
                      form={form}
                      register={register}
                    />
                  )}
                  {scene.captions.has(circle.key) ? (
                    <Caption circle={circle} caption={scene.captions.get(circle.key)!} />
                  ) : null}
                  {discrete.includes("l") ? (
                    <UnitList
                      circle={circle}
                      facts={facts.get(circle.key)!}
                      register={register}
                      onOpenThread={openThread}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </div>
        </div>

        {/* Hover names what the zoom cannot: the full label, even when the
            circle is too small to hold it. Screen-space, so it never scales. */}
        <div
          ref={tipRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 max-w-72 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-sm"
          style={{
            opacity:
              door === null && hoverCircle !== undefined && hoverFacts !== undefined && (hoverCode?.[0] !== "f" || hoverTicketSources !== null) ? 1 : 0,
            transition: `opacity ${hoverCircle === undefined ? 80 : 160}ms ${EASE_CSS}`,
          }}
        >
          {hoverCircle === undefined || hoverFacts === undefined ? null : (
            <>
              <p className="text-[12.5px] font-semibold leading-snug tracking-tight">
                {hoverCircle.data.kind === "cluster" ? (
                  <span className="mr-1.5 font-mono text-[11px] font-medium text-muted-foreground">
                    {hoverCircle.data.cluster.ticket}
                  </span>
                ) : null}
                {hoverFacts.full}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", PAINT[hoverFacts.lifecycle].dot)} />
                {hoverCircle.data.kind === "group"
                  ? `${hoverFacts.hotCount === 0 ? "Nothing needs you" : `${hoverFacts.hotCount} ${hoverFacts.hotCount === 1 ? "needs" : "need"} you`} · ${hoverCircle.data.group.total} checkouts`
                  : `${TONE[hoverFacts.lifecycle].label} · ${hoverCircle.data.cluster.units.length} ${hoverCircle.data.cluster.units.length === 1 ? "checkout" : "checkouts"}${hoverFacts.stuck ? "" : ` · last commit ${STALE_WORDS[hoverFacts.staleness]}`}`}
              </p>
              {hoverTicketSources === null ? null : (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Ticket found in {hoverTicketSources}
                </p>
              )}
              {hoverFacts.stuck ? (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <StuckGlyph />
                  Stuck · {untouchedWords(hoverFacts.untouchedDays)}
                </p>
              ) : null}
              {hoverCircle.data.kind === "cluster" && hoverCircle.data.cluster.threads.length > 0 ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {threadSummary(hoverCircle.data.cluster.threads)}
                </p>
              ) : null}
              {hoverCircle.data.kind === "group" && hoverCircle.data.group.cohesion?.verdict === "mixed" ? (
                <p className="mt-1 border-t border-border/70 pt-1 text-[11px] leading-snug text-muted-foreground">
                  Claude thought this grouping looked mixed
                  {hoverCircle.data.group.cohesion.reason === null ? "." : `: ${hoverCircle.data.group.cohesion.reason}`}
                </p>
              ) : null}
            </>
          )}
        </div>

        {layout.roots.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <Notice>{emptyMapMessage(shownBoard, unsorted !== null, showUnsorted)}</Notice>
          </div>
        ) : null}
      </div>

      {/* The legend moves above the controls when the plugin panel narrows. */}
      <div className={cn("pointer-events-none absolute inset-x-3 bottom-3 flex", compactHud ? "flex-col-reverse items-start gap-2" : "items-end justify-between gap-3")}>
      <div
        data-hud
        className="pointer-events-auto flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border/70 bg-background/90 p-0.5 shadow-sm"
      >
        <Tip label="Fit everything (Esc)">
          <button
            type="button"
            aria-label="Fit everything (Esc)"
            onClick={() => fitAll()}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Icon name="Target" className="size-4" />
          </button>
        </Tip>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <FaceToggle face={face} onTurn={turnTo} />
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <LensToggle lens={prefs.lens} onChange={(lens) => onPrefs({ lens })} />
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <Overflow
          unsorted={unsorted}
          showUnsorted={showUnsorted}
          onShowUnsorted={(next) => {
            // The world changes size completely; refit rather than leave the
            // reader looking at where the map used to be.
            fittedRef.current = false;
            setShowUnsorted(next);
          }}
        />
      </div>
      <div data-hud className="pointer-events-auto">
        <Legend />
      </div>
      </div>
    </div>
  );
}
