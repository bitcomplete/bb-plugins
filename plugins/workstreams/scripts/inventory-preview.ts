// Render the PR inventory's acceptance fixture to static HTML for a visual
// check, since installing this build migrates the live store: Address's
// states on Your turn, a PR it left out, and the selection bar's refusal; and
// routing at 1100 and 420 px (#routing-1100, #routing-420), with suggestions,
// a selection Address can't take, and Move to effort…'s picker open over its
// button as the popover places it (#routing-new-1100 has a new effort typed).
// It writes only $TMPDIR/inventory-preview.html, styled by the last `bb plugin
// build`'s dist/app.css over dark host colors and a minimal Preflight, both of
// which the host supplies. Run: npx vite-node scripts/inventory-preview.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inkwellInventory, inkwellInventorySuggestions, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "../inkwell-fixtures.js";
import type { InventoryView } from "../inventory-view.js";
import { inventoryScreen, rowSuggestions } from "../inventory-view-model.js";
import { InventoryPane } from "../inventory-screen.js";
import { moveItems } from "../inventory-routing.js";
import { PickerBody } from "../thread-effort-popover.js";
import { availability, hintKeys, type KeyContext } from "../deck-view-model.js";
import { HintBar } from "../deck-screen.js";
import type { Sent } from "../your-turn.js";

const css = new URL("../dist/app.css", import.meta.url);
if (!existsSync(css)) throw new Error("Run bb plugin build first: the preview reads dist/app.css.");
const noop = () => {};
const base = inkwellInventory();
// One held row, one failed read, and a rate limit, so each notice and mark shows.
const view: InventoryView = { ...base, rateLimitedUntil: NOW + 4 * 60_000, groups: base.groups.map((group) => ({ ...group, rows: group.rows.map((row) =>
  row.number === 318 ? { ...row, hold: { reason: "Wait for the store launch", heldAt: NOW - 3 * 3_600_000 }, attention: [], status: "On hold" }
    : row.number === 97 ? { ...row, failure: { at: new Date(NOW - 90_000).toISOString(), error: "HTTP 502" } }
      : row.number === 96 ? { ...row, lastAction: { at: NOW - 120_000, action: "nudge" as const, ok: false, reviewers: [],
        detail: "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written." } } : row) })) };
/** Address's states: each sent PR's thread link and status, a PR the last Address didn't send, and why it started nothing. */
const sent = (state: Sent["state"], detail: string | null = null, threadId: string | null = "thr_batch") =>
  ({ state, threadId, title: "Address feedback on 4 PRs", detail, batchId: state === "sending" ? "b-1" : null });
const states = (by: Record<number, Sent>) => ({ ...base, groups: base.groups.map((group) => ({ ...group, rows: group.rows.map((row) => by[row.number]
  ? { ...row, sent: by[row.number]!, addressing: by[row.number]!.state === "working" || by[row.number]!.state === "needs-you" ? { threadId: "thr_batch", title: null } : null }
  : row) })) });
const tracked = states({ 210: sent("working"), 211: sent("needs-you"), 155: sent("idle"), 301: sent("idle") });
const starting = states({ 210: sent("sending", null, null), 211: sent("refused", "On hold. Release it first.", null) });
const left = new Map([["https://github.com/inkwell/spine/pull/155", "An agent is working in its checkout."]]);
const pane = (shown: InventoryView, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(InventoryPane, {
  screen: inventoryScreen(shown, { now: NOW, filter: null }), busyKey: null, error: null,
  onView: noop, onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenEffort: noop, onNudge: noop,
  selected: new Set<string>(), onSelect: noop, onSelectAll: noop, onAddress: noop, onClear: noop, onUndo: noop, ...extra }));
const frame = (width: number, body: string, { id, height = 1100 }: { id?: string; height?: number } = {}) =>
  `<section${id ? ` id="${id}"` : ""} style="width:${width}px;height:${height}px;border:1px solid #2a2a2a;flex:none;display:flex;position:relative" data-bb-plugin="workstreams">${body}</section>`;
/** Routing: each suggestion on its row, a selection with one row off Your turn, and the picker over Move to effort…, with the hint bar's keys. */
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const efforts = Object.values(INVENTORY_EFFORTS);
const picked = new Set([url("folio", 301), url("catalog", 96), url("atlas", 410)]);
const keys: KeyContext = { view: "prs", cur: null, focused: null, selected: [], seenAvailable: false, undo: false, held: 0, done: 0,
  prs: { row: true, thread: false, moves: new Set(), selectable: true, turn: 5, picked: picked.size, addressable: false } };
const routing = (query: string) => `${pane(base, { selected: picked, suggestions: rowSuggestions(inkwellInventorySuggestions(), {}), onAccept: noop, onDismissSuggestion: noop,
  move: { open: false, onOpenChange: noop, efforts, busy: false, onMove: async () => null },
  footer: createElement(HintBar, { hints: hintKeys(keys, availability(keys)), flash: null, onPalette: noop, onHelp: noop, onUndo: noop }) })
}<div data-picker-panel style="position:absolute" class="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover text-[12px] text-popover-foreground shadow-md">${
  renderToStaticMarkup(createElement(PickerBody, { mode: "effort", query, items: moveItems(efforts, query), highlight: query ? moveItems(efforts, query).length - 1 : -1,
    busy: false, current: null, confirm: null, notice: null, error: null, listId: "move", onQuery: noop, onKeyDown: noop, onPick: noop, onHighlight: noop }))}</div>`;
/** Where the popover puts the picker: above its button, aligned to its start, kept 8 px inside the frame. */
const place = `<script>for (const frame of document.querySelectorAll("section")) { const panel = frame.querySelector("[data-picker-panel]");
  const button = frame.querySelector('[data-inventory-action="move"]'); if (!panel || !button) continue;
  const f = frame.getBoundingClientRect(), b = button.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(b.left - f.left, f.width - panel.offsetWidth - 8)) + "px"; panel.style.top = (b.top - f.top - panel.offsetHeight - 6) + "px"; }</script>`;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Inventory preview</title><style>
:root{color-scheme:dark;--background:#151515;--foreground:#e6e6e6;--card:#1b1b1b;--popover:#1f1f1f;--popover-foreground:#e6e6e6;--muted:#232323;
--muted-foreground:#9a9a9a;--border:#2c2c2c;--input:#333;--ring:#6b8afd;--destructive:#f07178;--state-hover:#ffffff10;--state-active:#ffffff18;--radius:6px}
@layer theme,base,utilities;@layer base{*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
button,input{font:inherit;color:inherit;background:transparent;text-align:inherit}h1,h2{font-size:inherit;font-weight:inherit}svg{display:block}
table{border-collapse:collapse}}
body{margin:0;padding:16px;background:#101010;color:var(--foreground);font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
</style><style>${readFileSync(css, "utf8")}</style></head><body>${frame(1100, routing(""), { id: "routing-1100", height: 1320 })}${
  frame(420, routing(""), { id: "routing-420", height: 1640 })}${frame(1100, routing("Delivery windows"), { id: "routing-new-1100", height: 1320 })}${frame(1280, pane(tracked))}${frame(560, pane(starting, { notes: left,
  selected: new Set(["https://github.com/inkwell/spine/pull/155", "https://github.com/inkwell/folio/pull/301"]),
  refusal: "Nothing started. spine #155: An agent is working in its checkout." }))}${frame(420, pane(view))}${place}</body></html>`;
const out = join(process.env.TMPDIR ?? tmpdir(), "inventory-preview.html");
writeFileSync(out, html);
console.log(out);
