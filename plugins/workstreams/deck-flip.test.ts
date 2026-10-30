import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { behind, flip, flipFrames, flipMotion, flipper, focusNamesCard, layerTransform, QUICK_MS, REPEAT_MS, type FlipFrames } from "./deck-flip.js";

const IDS = ["shelf", "pickup", "one-offs", "unc"];
const RING = IDS.map((id) => ({ id }));
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
/** Presses at the given times from `cur`, through the deck's own flipper: each lands before the next, whatever its motion is doing. */
function presses(cur: string, steps: readonly [number, 1 | -1][], reduced = false) {
  const flips = flipper();
  const trail: string[] = [];
  for (const [now, step] of steps) {
    const next = flips(IDS, cur, { step }, now, reduced)!;
    cur = next.id;
    trail.push(`${cur} ${next.motion.kind} ${next.motion.ms}`);
  }
  return trail;
}
/** A held ]: one press, then the key repeats `every` ms after 400 ms. */
const held = (every: number, repeats: number) => presses("shelf", [[0, 1], ...Array.from({ length: repeats + 1 }, (_, index) => [400 + every * index, 1] as [number, 1])]);

describe("the deck as a stack", () => {
  // What lies behind the top card is what ] reaches next, so the stack never shows a card a flip forward wouldn't land on.
  it("puts the next three cards behind the one shown, in the order ] reaches them, wrapping past the last card to the first", () => {
    expect(ids(behind(RING, "shelf"))).toEqual(["pickup", "one-offs", "unc"]);
    expect(ids(behind(RING, "one-offs"))).toEqual(["unc", "shelf", "pickup"]);
    expect(ids(behind(RING, "unc"))).toEqual(["shelf", "pickup", "one-offs"]);
  });

  it("never puts the card shown behind itself, so a short pile shows fewer cards behind, and nothing before the first read", () => {
    expect(ids(behind(RING.slice(0, 2), "pickup"))).toEqual(["shelf"]);
    expect(behind([{ id: "unc" }], "unc")).toEqual([]);
    expect(behind(RING, null)).toEqual([]);
  });
});

describe("the stack's direction", () => {
  // ] and → move right through the ring, so the cards they reach wait to the right of the card shown, and the one a flip forward takes away
  // leaves to the left; a stack that peeked below, or a card that left to the right, would move against the arrows.
  const shift = (transform: string | undefined) => {
    const at = /translate(X|Y)?\((-?[\d.]+)px(?:, (-?[\d.]+)px)?\)/u.exec(transform ?? "");
    if (!at) return { x: 0, y: 0 };
    const [, axis, a, b] = at;
    return axis === "Y" ? { x: 0, y: Number(a) } : { x: Number(a), y: Number(b ?? 0) };
  };
  it("sets each deeper card further right and never lower, and a flip forward sends the top card left as the next comes in from the right", () => {
    const depths = [1, 2, 3, 4].map((depth) => shift(layerTransform(depth)));
    expect(depths.map((at) => at.y)).toEqual([0, 0, 0, 0]);
    expect(depths[0]!.x).toBeGreaterThan(0);
    for (let depth = 1; depth < depths.length; depth++) expect(depths[depth]!.x).toBeGreaterThan(depths[depth - 1]!.x);
    const forward = flipFrames(1, "slide"), back = flipFrames(-1, "slide");
    expect(shift(forward.ghost.at(-1)!.transform as string).x).toBeLessThan(0);
    expect(shift(forward.top[0]!.transform as string).x).toBeGreaterThan(0);
    // Back retraces it: the previous card returns from the left, and the card on top sinks back to the right.
    expect(shift(back.top[0]!.transform as string).x).toBeLessThan(0);
    expect(shift(back.ghost.at(-1)!.transform as string).x).toBeGreaterThan(0);
  });
});

describe("flipping through the deck", () => {
  // Where a flip lands never waits on its motion, so a burst can't lose or queue a press, and the motion never trails the key.
  it("ends a held ] on the card its presses reach, playing the first press and skipping the repeats rather than queueing them", () => {
    // Seven presses from Shelf order around a ring of four end on the last card.
    const trail = held(33, 5);
    expect(trail.at(-1)).toBe("unc none 0");
    expect(trail.slice(0, 3)).toEqual(["pickup slide 200", "one-offs slide 200", "unc none 0"]);
  });

  // macOS repeats a held key every 30 or 90 ms at its two fastest settings. A 110 ms slide cut off every 90 ms double-exposes the cards, so
  // those repeats swap cleanly; at 180 ms each plays a short slide, which is over before the next press.
  it("swaps a held ] cleanly at a 90 ms repeat, and plays a short flip at a 180 ms one, never one a press cuts off", () => {
    expect(held(90, 4)).toEqual(["pickup slide 200", "one-offs slide 200", "unc none 0", "shelf none 0", "pickup none 0", "one-offs none 0"]);
    expect(held(180, 4).slice(2)).toEqual(["unc slide 110", "shelf slide 110", "pickup slide 110", "one-offs slide 110"]);
    expect(QUICK_MS).toBeLessThan(REPEAT_MS);
  });

  it("shortens a flip that starts while the last one would still play, and a burst of clicks either way ends where they add up to", () => {
    expect(presses("pickup", [[0, 1], [170, 1], [340, 1], [510, -1], [1_000, -1]]))
      .toEqual(["one-offs slide 200", "unc slide 110", "shelf slide 110", "unc slide 110", "one-offs slide 200"]);
  });

  it("moves forward on ] and back on [, wrapping either way, and a jump moves toward where its card sits", () => {
    const at = { now: 0, last: null, reduced: false };
    // Past the last card, ] still reads as forward: the first effort rises out of the stack.
    expect(flip(IDS, "unc", { step: 1 }, at)).toMatchObject({ id: "shelf", direction: 1 });
    expect(flip(IDS, "shelf", { step: -1 }, at)).toMatchObject({ id: "unc", direction: -1 });
    expect(flip(IDS, "shelf", { id: "one-offs" }, at)).toMatchObject({ id: "one-offs", direction: 1 });
    expect(flip(IDS, "unc", { id: "pickup" }, at)).toMatchObject({ id: "pickup", direction: -1 });
    expect(flip(IDS, "shelf", { id: "shelf" }, at)).toBeNull();
    expect(flip(IDS, "shelf", { id: "effort-gone" }, at)).toBeNull();
  });

  it("cross-fades under reduced motion, without moving anything, and not at all in a burst", () => {
    expect(presses("shelf", [[0, 1], [150, 1], [600, -1]], true)).toEqual(["pickup fade 120", "one-offs none 0", "pickup fade 120"]);
    expect(flipMotion(true, null)).toEqual({ kind: "fade", ms: 120 });
    const frames = flipFrames(1, "fade");
    expect(new Set([frames.top, frames.ghost, frames.rows].flat().flatMap(Object.keys))).toEqual(new Set(["opacity"]));
    expect(frames.layer(1, 3)).toBeNull();
  });

  it("moves only transform and opacity, so a flip never lays the page out again, and a flip back retraces a flip forward", () => {
    const forward = flipFrames(1, "slide"), back = flipFrames(-1, "slide");
    const props = (frames: FlipFrames) => [frames.top, frames.ghost, frames.rows, frames.layer(1, 3)!, frames.layer(3, 3)!].flat().flatMap(Object.keys);
    expect(new Set([...props(forward), ...props(back)])).toEqual(new Set(["transform", "opacity"]));
    // Forward, the card on top leaves for where back brings the previous card from, over the next one, which rises from the first edge;
    // back, the card on top sinks to that edge, under the previous one.
    expect(forward.ghost.at(-1)).toEqual({ transform: "translateX(-24px) rotate(-1.5deg)", opacity: 0 });
    expect(back.top[0]).toEqual({ ...forward.ghost.at(-1) });
    expect(forward.top[0]).toEqual({ transform: layerTransform(1) });
    expect(back.ghost.at(-1)).toEqual({ transform: layerTransform(1), opacity: 0 });
    expect([forward.ghostOver, back.ghostOver]).toEqual([true, false]);
    expect([forward.top.at(-1)!.transform, back.top.at(-1)!.transform]).toEqual(["none", "none"]);
    // Each card behind moves one place, up forward, where the deepest arrives unseen, and down back, where the first comes from under the top.
    expect([forward.layer(1, 3)![0], forward.layer(3, 3)![0]]).toEqual([{ transform: layerTransform(2), opacity: 1 }, { transform: layerTransform(4), opacity: 0 }]);
    expect(back.layer(1, 3)![0]).toEqual({ transform: "none", opacity: 1 });
    expect(forward.layer(2, 3)!.at(-1)).toEqual({ transform: layerTransform(2), opacity: 1 });
  });
});

describe("landing a flip in the deck", () => {
  // A heading or chip that focus moves onto is read out with the card's name; one focus stays on is not, and a flip between two effort cards
  // keeps the same heading and changes only its text, so the status line has to say it then.
  it("leaves the status line to name the card unless focus moved onto its heading or chip", () => {
    const element = (kind: string) => ({ closest: (selector: string) => (selector.includes(kind) ? element(kind) : null) }) as unknown as Element;
    const heading = element("[data-deck-focus=heading]"), chip = element("[data-deck-chip]"), row = element("[data-deck-row]");
    expect(focusNamesCard(heading, heading)).toBe(false);
    expect(focusNamesCard(row, heading)).toBe(true);
    expect(focusNamesCard(null, chip)).toBe(true);
    expect(focusNamesCard(heading, row)).toBe(false);
    expect(focusNamesCard(heading, null)).toBe(false);
  });

  // The deck's flip effect needs the host to render, so its order is read from source: a place saved or focus landed mid-motion would be
  // where the flip draws the card, not where it sits, and a flipper made per press would never see a burst.
  it("ends a flip still playing before it restores the card's place and focus, then plays, then decides what screen readers hear", () => {
    const source = readFileSync(new URL("./deck-nav-view.tsx", import.meta.url), "utf8");
    const start = source.indexOf("if (!view || !cur || shown.current === cur) return;");
    const effect = source.slice(start, source.indexOf("\n  });\n", start));
    const steps = ["settleFlip(viewRef.current)", "restoreAnchor(saved.anchor)", "const before = document.activeElement", "landFocus(saved)",
      "playFlip(viewRef.current, flipped)", "focusNamesCard(before, document.activeElement)", "said ? null : window.setTimeout("];
    expect(steps.filter((step) => !effect.includes(step))).toEqual([]);
    expect([...steps].sort((a, b) => effect.indexOf(a) - effect.indexOf(b))).toEqual(steps);
    expect(source).toContain("const [flips] = useState(flipper);");
  });
});
