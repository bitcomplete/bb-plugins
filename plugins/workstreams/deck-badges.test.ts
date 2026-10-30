// Key badges must read as keys on every surface they sit on (plan amendment A17 item 4): Matt saw the old badge, a hairline with muted text,
// as an empty checkbox on a primary button. This draws every place the deck and its dialogs show a badge, resolves each badge's text color
// and every background under it from their classes and BB's own color tokens, and fails on a badge with no key or with text under 4.5:1.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellDeck, inkwellInventory, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { inventoryScreen } from "./inventory-view-model.js";
import { availability, cardScreen, hintKeys, paletteItems, stripChips, type KeyContext } from "./deck-view-model.js";
import { ConfirmBody, DeckPane, HelpBody, HoldBody, Kbd, Keys, PaletteBody, type DeckPaneProps } from "./deck-screen.js";
import { PickerBody } from "./thread-effort-popover.js";

type Rgb = readonly [number, number, number];
/** sRGB, gamma-encoded, from OKLCH (lightness 0–1, chroma, hue in degrees). */
function oklch(l: number, c = 0, h = 0): Rgb {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
  const [L, M, S] = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3) as [number, number, number];
  const linear = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  return linear.map((v) => { const x = Math.min(1, Math.max(0, v)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; }) as unknown as Rgb;
}
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => alpha * v + (1 - alpha) * under[i]!) as unknown as Rgb;
const luminance = (rgb: Rgb) => { const [r, g, b] = rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

/** BB's host tokens (its app theme's .light and .dark), which the plugin's classes read, and the Tailwind colors its tones tint with. */
const THEMES = {
  light: { background: oklch(1), foreground: oklch(0.3211), "muted-foreground": oklch(0.44), popover: oklch(1) },
  dark: { background: oklch(0.195), foreground: oklch(0.81), "muted-foreground": oklch(0.78), popover: oklch(0.195) },
} as const;
type Theme = keyof typeof THEMES;
const PALETTE: Record<string, Rgb> = { "sky-500": oklch(0.685, 0.169, 237.323), "emerald-500": oklch(0.696, 0.17, 162.48), "violet-500": oklch(0.606, 0.25, 292.717),
  "amber-500": oklch(0.769, 0.188, 70.08), "rose-500": oklch(0.645, 0.246, 16.439) };
/** Text utilities that aren't a color. */
const NOT_COLOR = /^text-(?:\[|(?:left|center|right|xs|sm|base)$)/u;

/** The color and opacity a `bg-` or `text-` class sets at rest in `theme`, the dark: one winning in dark; null when none does. */
function color(classes: readonly string[], prefix: "bg" | "text", theme: Theme): [Rgb, number] | null {
  const own = classes.filter((name) => name.startsWith(`${prefix}-`) && !NOT_COLOR.test(name));
  const dark = classes.filter((name) => name.startsWith(`dark:${prefix}-`)).map((name) => name.slice(5));
  const name = (theme === "dark" && dark.length ? dark : own).at(-1);
  if (!name) return null;
  const match = /^(?:bg|text)-([a-z]+(?:-[a-z]+)*?(?:-\d{2,3})?)(?:\/(?:(\d+)|\[([\d.]+)\]))?$/u.exec(name);
  const rgb = match ? (THEMES[theme] as Record<string, Rgb>)[match[1]!] ?? PALETTE[match[1]!] : undefined;
  if (!rgb) throw new Error(`No color for ${name}: add its token here`);
  return [rgb, match![2] ? Number(match![2]) / 100 : match![3] ? Number(match![3]) : 1];
}

type Badge = { key: string; chain: string[][] };
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "col", "source", "wbr"]);
/** Every kbd in static markup with the class lists of it and each element around it, outermost first. */
function badges(html: string): Badge[] {
  const found: Badge[] = [];
  const stack: string[][] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/gu;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    const [, close, name, attrs, self] = match;
    if (close) { stack.pop(); continue; }
    const classes = /\bclass="([^"]*)"/u.exec(attrs!)?.[1]!.split(/\s+/u).filter(Boolean) ?? [];
    if (name === "kbd") found.push({ key: html.slice(tag.lastIndex, html.indexOf("</kbd>", tag.lastIndex)).trim(), chain: [...stack, classes] });
    if (!self && !VOID.has(name!)) stack.push(classes);
  }
  return found;
}

/** A badge's text against what's under it: the page, then every background around it, then its own. */
function contrast(badge: Badge, theme: Theme): number {
  let under: Rgb = THEMES[theme].background;
  for (const classes of badge.chain) { const bg = color(classes, "bg", theme); if (bg) under = over(bg[0], bg[1], under); }
  // Its text color is the nearest one set, its own first.
  let text: [Rgb, number] = [THEMES[theme].foreground, 1];
  for (const classes of [...badge.chain].reverse()) { const own = color(classes, "text", theme); if (own) { text = own; break; } }
  return ratio(over(text[0], text[1], under), under);
}

const none = { rows: {} };
const noop = () => {};
const SHELF = INVENTORY_EFFORTS.shelf.id, ONE_OFFS = "effort-one-offs";
const LINES = new Map(inventoryScreen(inkwellInventory(), { now: NOW, filter: null }).groups.flatMap((group) => group.lines.map((line) => [line.prUrl, line] as const)));

/** A card with every move's rows open and the Address move's rows ticked, as the deck first draws it. */
function pane(cur: string, patch: Partial<DeckPaneProps> = {}, view = inkwellDeck()) {
  const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW })]));
  const card = cards.get(cur) ?? null;
  const picked = new Set(card?.moves.find((move) => move.kind === "address")?.prUrls ?? []);
  const context: KeyContext = { view: "deck", cur: card, service: null, focused: null, selected: card?.lines.filter((line) => picked.has(line.prUrl)) ?? [],
    seenAvailable: true, undo: true, held: 1, done: 1 };
  const on = availability(context);
  return renderToStaticMarkup(createElement(DeckPane, {
    chips: stripChips(view.active.map((item) => item.id), cards, cur), cur, card,
    rules: [], held: [], done: [], read: { text: "Read 25s ago", error: null }, seen: { changed: 2, available: true, note: null },
    kit: { lines: LINES, picked }, open: new Set(["chores", "progress"]), panel: null, pile: null,
    on, hints: hintKeys(context, on), flash: null, run: noop, onPalette: noop, onHelp: noop, onUndo: noop, ...patch }));
}

/**
 * Every surface the deck draws a badge on: a move's leading and toned verbs, bordered and ghost buttons, the Mark seen pill, the toggles'
 * panels, the hint bar, and dialogs, and the thread effort popover's highlighted row.
 */
function everyBadge(): { where: string; badge: Badge }[] {
  const view = inkwellDeck();
  const shelf = cardScreen(view.active.find((item) => item.id === SHELF)!, none, { now: NOW });
  const on = availability({ view: "deck", cur: shelf, focused: null, selected: [], seenAvailable: true, undo: true, held: 1, done: 1 });
  const items = paletteItems(on, [], { held: [], done: [] }, SHELF, true);
  const plan = { title: "Nudge", sub: "", verb: "Nudge", request: false, excluded: null, skipped: [],
    items: [{ prUrl: "u1", ref: "catalog #96", title: "Show series order", kind: "nudge" as const, what: "Nudge @mira-l", notes: 0 }] };
  const renders: [string, string][] = [
    ["Shelf order card", pane(SHELF)],
    ["One-offs card", pane(ONE_OFFS)],
    ["a card with held PRs and its Held panel", pane(INVENTORY_EFFORTS.pickup.id, { panel: "held" },
      inkwellDeck({}, (row) => row.number === 211 ? { hold: { reason: "Printer", heldAt: NOW } } : {}))],
    ["every move open", pane(SHELF, { open: new Set(["merge", "fix"]) })],
    ["the Notes panel", pane(SHELF, { panel: "notes" })],
    ["a service card and its suggestions", pane("service:inkwell/folio")],
    ["the hint bar's Undo", pane(SHELF, { flash: { text: "Nudged 1", undo: true } })],
    ["the confirm", renderToStaticMarkup(createElement(ConfirmBody, { plan, busy: false, error: null, reviewer: "", dirty: false, onReviewer: noop, onReplan: noop,
      onConfirm: noop, onCancel: noop }))],
    ["a dialog's buttons", renderToStaticMarkup(createElement(HoldBody, { reason: "", onReason: noop, busy: false, error: null, onHold: noop, onCancel: noop }))],
    ["⌘K", renderToStaticMarkup(createElement(PaletteBody, { query: "", items, highlight: 0, onQuery: noop, onRun: noop, onHighlight: noop }))],
    ["?", renderToStaticMarkup(createElement(HelpBody, { items }))],
    ["the thread effort popover", renderToStaticMarkup(createElement(PickerBody, { mode: "effort", query: "", highlight: 0, busy: false, current: null, notice: null,
      error: null, listId: "picker", linked: [], confirm: null, onQuery: noop, onKeyDown: noop, onPick: noop, onHighlight: noop, onLinkMode: noop, onMove: noop,
      onConfirmMove: noop, onCancelMove: noop, onOpenPr: noop,
      items: [{ kind: "effort", key: "effort:shelf", id: "shelf", name: "Shelf order", oneOff: false, held: false, yourTurn: 2, signal: "has folio #340", score: 3,
        suggested: true, current: false }, { kind: "new", name: "" }] }))],
  ];
  return renders.flatMap(([where, html]) => badges(html).map((badge) => ({ where, badge })));
}

describe("key badges", () => {
  it("name their key and read at 4.5:1 or better on every surface, in light and dark", () => {
    const all = everyBadge();
    const weak = all.flatMap(({ where, badge }) => (["light", "dark"] as const).flatMap((theme) => {
      const value = contrast(badge, theme);
      const surface = [...badge.chain].reverse().find((classes) => classes.some((name) => name.startsWith("bg-")))?.join(" ") ?? "the page";
      return !badge.key || value < 4.5 ? [`${where}: "${badge.key}" ${theme} ${value.toFixed(2)}:1 on ${surface}`] : [];
    }));
    expect(weak).toEqual([]);
    // It covers the badges that sit on a primary button: the leading move's, Address's and Merge's here, and every ⌘↵.
    const inverted = all.filter(({ badge }) => badge.chain.some((classes) => classes.includes("bg-foreground")));
    expect(new Set(inverted.map(({ badge }) => badge.key))).toEqual(new Set(["⌘↵"]));
    expect([...new Set(inverted.map(({ where }) => where))]).toEqual(expect.arrayContaining(["the confirm", "a dialog's buttons"]));
    expect(all.length).toBeGreaterThan(100);
  });

  // The failure Matt saw: the old hairline badge on a primary button. The check has to catch it, or it proves nothing.
  it("catch a hairline badge with muted text on a primary button", () => {
    const [old] = badges('<button class="bg-foreground text-background"><kbd class="border border-border text-muted-foreground">a</kbd></button>');
    expect(contrast(old!, "light")).toBeLessThan(2);
    expect(contrast(old!, "dark")).toBeLessThan(1.2);
  });

  it("fill in on a primary button rather than draw an outline, and draw nothing without a key", () => {
    const [primary] = badges(renderToStaticMarkup(createElement("button", { className: "bg-foreground text-background" }, createElement(Kbd, { inverted: true }, "a"))));
    expect(primary!.chain.at(-1)).toEqual(expect.arrayContaining(["bg-background/20", "text-background", "border-transparent"]));
    const [plain] = badges(renderToStaticMarkup(createElement(Kbd, null, "h")));
    expect(plain!.chain.at(-1)).toEqual(expect.arrayContaining(["border", "border-border", "text-muted-foreground"]));
    for (const empty of [createElement(Kbd, null), createElement(Kbd, null, ""), createElement(Kbd, null, " "), createElement(Keys, { keys: "" })])
      expect(renderToStaticMarkup(empty)).toBe("");
    expect(badges(renderToStaticMarkup(createElement(Keys, { keys: "] →" }))).map((badge) => badge.key)).toEqual(["]", "→"]);
  });
});
