// The effort deck as a stack of cards: what lies behind the card shown,
// where each card behind it sits, and how a flip moves them. The ring is the
// strip's order, Overview, the efforts, and then the service cards, so the
// card behind the top one is the one ] flips to.
//
// A flip lands at once: where it lands never waits on its motion, so holding
// ] or clicking fast always ends on the card the presses reach. The motion
// only decorates the landing, with transform and opacity alone, and a flip
// that starts while another plays cuts that one short and plays shorter, or
// not at all, so nothing queues. This module imports nothing, so the browser
// bundle and the preview script can both use it.

/**
 * Each depth's offset and scale about its right edge: 0 is the card on top, and 1–3 peek out to its right, each further right and smaller, the
 * way → and ] flip. The first edge is wide enough for the next card's name; the deepest's offset is the gutter the stack keeps on its right.
 */
export const LAYERS = [{ x: 0, scale: 1 }, { x: 14, scale: 0.98 }, { x: 18, scale: 0.96 }, { x: 22, scale: 0.94 }] as const;
/** Depth 4 and deeper is where a card enters the stack from, out of sight beyond the deepest edge. */
export const layerTransform = (depth: number) => {
  const at = depth < LAYERS.length ? LAYERS[depth]! : { x: 26, scale: 0.92 };
  return depth ? `translateX(${at.x}px) scale(${at.scale})` : "none";
};

/** The cards behind `cur`, in the order a flip forward reaches them, wrapping, at most three and never `cur` itself. */
export function behind<T extends { id: string }>(ring: readonly T[], cur: string | null, max = LAYERS.length - 1): T[] {
  const at = ring.findIndex((item) => item.id === cur);
  if (at < 0) return [];
  return Array.from({ length: Math.min(max, ring.length - 1) }, (_, index) => ring[(at + index + 1) % ring.length]!);
}

export const FLIP_MS = 200;
/**
 * A flip that starts while the last one would still be playing plays this long, and one within REPEAT_MS of the last doesn't play: a held key
 * repeats every 30 or 90 ms at macOS's two fastest settings, and those swap cleanly rather than stacking cut-short slides.
 */
export const QUICK_MS = 110;
export const REPEAT_MS = 150;
/** Reduced motion's cross-fade. */
export const FADE_MS = 120;
export const EASE = "cubic-bezier(.2,.8,.2,1)";
/** Where a flip forward sends the card on top, and where a flip back brings the previous card from: to the left, away from the stack. */
const AWAY = "translateX(-24px) rotate(-1.5deg)";
const ID = "deck-flip";

export type FlipMotion = { kind: "slide" | "fade" | "none"; ms: number };
const STILL: FlipMotion = { kind: "none", ms: 0 };

/** How a flip `since` ms after the last one plays; `since` is null for the first. Reduced motion cross-fades, and skips it in a burst. */
export function flipMotion(reduced: boolean, since: number | null): FlipMotion {
  const burst = since !== null && since < FLIP_MS;
  if (reduced) return burst ? STILL : { kind: "fade", ms: FADE_MS };
  return !burst ? { kind: "slide", ms: FLIP_MS } : since < REPEAT_MS ? STILL : { kind: "slide", ms: QUICK_MS };
}

/**
 * One flip from `cur`: the card it lands on, which way the deck moves, and how it plays. A step goes to the next or previous card,
 * wrapping; an id jumps and moves toward where that card sits in the ring. Null when it wouldn't move.
 */
export function flip(ring: readonly string[], cur: string, to: { step: 1 | -1 } | { id: string }, at: { now: number; last: number | null; reduced: boolean }):
  { id: string; direction: 1 | -1; motion: FlipMotion } | null {
  const from = ring.indexOf(cur);
  const index = "step" in to ? (from + to.step + ring.length) % ring.length : ring.indexOf(to.id);
  if (from < 0 || index < 0 || index === from) return null;
  return { id: ring[index]!, direction: "step" in to ? to.step : index > from ? 1 : -1, motion: flipMotion(at.reduced, at.last === null ? null : at.now - at.last) };
}

/** The deck's flips as they come: each lands where flip() says, and remembers when it started, so the next knows whether it's in a burst. */
export function flipper() {
  let last: number | null = null;
  return (ring: readonly string[], cur: string, to: { step: 1 | -1 } | { id: string }, now: number, reduced: boolean) => {
    const next = flip(ring, cur, to, { now, last, reduced });
    if (next) last = now;
    return next;
  };
}

/**
 * Whether landing focus after a flip already names its card: focus moved onto the card's heading or its strip chip. Focus left where it was says
 * nothing, as on the heading two effort cards share, since a flip between them only changes its text.
 */
export const focusNamesCard = (before: Element | null, after: Element | null) => !!after && after !== before && !!after.closest("[data-deck-focus=heading], [data-deck-chip]");

/** The keyframes of a flip: the card now on top, the ghost of the one it took away and whether it's drawn over the top one, the cards behind, and the rows. */
export type FlipFrames = { top: Keyframe[]; ghost: Keyframe[]; ghostOver: boolean; rows: Keyframe[]; layer(depth: number, count: number): Keyframe[] | null };
export function flipFrames(direction: 1 | -1, kind: "slide" | "fade"): FlipFrames {
  const rows = [{ opacity: 0.4 }, { opacity: 1 }];
  if (kind === "fade") return { top: [{ opacity: 0 }, { opacity: 1 }], ghost: [{ opacity: 1 }, { opacity: 0 }], ghostOver: true, rows, layer: () => null };
  const forward = direction > 0;
  return {
    // Forward, the card on top slides and tilts away to the left as the next one rises out of the stack on its right. Back reverses it: the
    // previous card returns from the left, where forward sent it, over the one on top, which sinks back into the stack on the right.
    top: forward ? [{ transform: layerTransform(1) }, { transform: "none" }] : [{ transform: AWAY, opacity: 0 }, { transform: "none", opacity: 1 }],
    ghost: [{ transform: "none", opacity: 1 }, { transform: forward ? AWAY : layerTransform(1), opacity: 0 }],
    ghostOver: forward, rows,
    // Each card behind moves a place left forward, or right back; forward, the deepest arrives from out of sight.
    layer: (depth, count) => [{ transform: layerTransform(depth + direction), opacity: forward && depth === count ? 0 : 1 }, { transform: layerTransform(depth), opacity: 1 }],
  };
}

/** A copy of the card on top of `root`'s stack for a flip to take away: inert, hidden from screen readers, and with no deck hooks, so no lookup finds it. */
export function ghostOf(root: Element): HTMLElement | null {
  const top = root.querySelector("[data-deck-top]");
  if (!top) return null;
  const ghost = top.cloneNode(true) as HTMLElement;
  for (const element of [ghost, ...Array.from(ghost.querySelectorAll("*"))]) {
    for (const name of element.getAttributeNames()) if (name.startsWith("data-deck-") || name === "id") element.removeAttribute(name);
  }
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  return ghost;
}

/** Ends any flip playing in `root` where it was going: every card at its place, and no ghost. */
export function settleFlip(root: Element): void {
  for (const animation of root.getAnimations({ subtree: true })) if (animation.id === ID) animation.cancel();
  root.querySelector("[data-deck-ghost]")?.replaceChildren();
}

/**
 * Plays a flip in `root`, which already draws the card it landed on; `ghost` is the card it took away, from ghostOf() before the swap.
 * A flip still playing settles first, so flips never queue.
 */
export function playFlip(root: Element, flip: { direction: 1 | -1; motion: FlipMotion; ghost: HTMLElement | null }): void {
  settleFlip(root);
  const host = root.querySelector<HTMLElement>("[data-deck-ghost]");
  if (flip.motion.kind === "none") return;
  const frames = flipFrames(flip.direction, flip.motion.kind);
  const timing: KeyframeAnimationOptions = { id: ID, duration: flip.motion.ms, easing: EASE };
  const ghost = flip.ghost;
  if (host && ghost) {
    host.style.zIndex = frames.ghostOver ? "6" : "4";
    host.append(ghost);
    const gone = () => ghost.remove();
    ghost.animate(frames.ghost, { ...timing, fill: "forwards" }).finished.then(gone, gone);
  }
  root.querySelector("[data-deck-top]")?.animate(frames.top, timing);
  const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-deck-layer]"));
  for (const layer of layers) { const keyframes = frames.layer(Number(layer.dataset.deckLayer), layers.length); if (keyframes) layer.animate(keyframes, timing); }
  root.querySelector("[data-deck-rows]")?.animate(frames.rows, timing);
}
