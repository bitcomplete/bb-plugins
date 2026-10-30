// Render the thread's effort chip and its popover (plan amendment A17.2)
// from Inkwell fixtures to static HTML for a visual check, since installing
// this build migrates the live store. It writes only
// $TMPDIR/thread-effort-preview.html, styled by the last `bb plugin build`'s
// dist/app.css over host colors and a minimal Preflight, as
// scripts/deck-preview.ts does. Each panel is one state: the popover open on
// a thread in an effort, a typed new name, the PR list, and the chip after a
// pick with its Undo, and a Move here that lists what else it takes. "#light" uses light host colors, which want the
// browser's light color scheme. Run: npx vite-node scripts/thread-effort-preview.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadEffortPicker } from "../thread-effort.js";
import { pickerItems, startHighlight, type JevAnswer, type PickerMode } from "../thread-effort-picker.js";
import { PickerBody, ThreadEffortBar } from "../thread-effort-popover.js";

const css = new URL("../dist/app.css", import.meta.url);
if (!existsSync(css)) throw new Error("Run bb plugin build first: the preview reads dist/app.css.");
const noop = () => {};
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const choice = (id: string, name: string, patch: Partial<ThreadEffortPicker["choices"][number]> = {}): ThreadEffortPicker["choices"][number] =>
  ({ key: `effort:${id}`, id, name, oneOff: false, held: false, yourTurn: 0, signal: null, score: 0, ...patch });
const picker: ThreadEffortPicker = {
  chip: { kind: "effort", effortId: "effort-shelf-order", name: "Shelf order", oneOff: false, yourTurn: 5, card: "effort-shelf-order" },
  choices: [choice("effort-shelf-order", "Shelf order", { yourTurn: 5 }), choice("effort-store-pickup", "Store pickup", { signal: "ABC-121 in the title", score: 3, yourTurn: 3 }),
    choice("effort-catalog", "Catalog pages", { signal: "Linear project “Catalog”", score: 2, yourTurn: 1 }), choice("effort-gift-cards", "Gift cards", { held: true }),
    choice("effort-one-offs", "One-offs", { oneOff: true, yourTurn: 3 }), choice("effort-reading-lists", "Reading lists")],
  linked: [{ url: url("folio", 340), ref: "folio #340", title: "ABC-360 Store shelf order", effortId: "effort-shelf-order", effortName: "Shelf order", sourceIds: ["ticket:ABC-360"],
    also: [] }, { url: url("catalog", 96), ref: "catalog #96", title: "ABC-121 Show series order", effortId: "effort-store-pickup", effortName: "Store pickup",
    sourceIds: ["ticket:ABC-121"], also: ["catalog #97", "1 checkout"] }],
  jev: false,
};
const linkable = [{ url: url("folio", 330), label: "inkwell/folio #330 · ABC-364 Keep shelf filters in the link" },
  { url: url("folio", 341), label: "inkwell/folio #341 · ABC-361 Read shelf order back" }, { url: url("atlas", 12), label: "inkwell/atlas #12 · Map the stacks" }];
const jev: JevAnswer = { state: "idle", keys: [], name: null };

function panel(title: string, state: { query?: string; mode?: PickerMode; highlight?: number; open?: boolean; flash?: { text: string; undo: boolean }; confirm?: boolean }) {
  const query = state.query ?? "", mode = state.mode ?? "effort";
  const items = pickerItems({ picker, currentKey: "effort:effort-shelf-order", query, mode, linkable, linkedUrl: linkable[0]!.url, jev });
  const bar = renderToStaticMarkup(createElement(ThreadEffortBar, { chip: picker.chip, readError: null, onRetry: noop, open: false, onOpenChange: noop, onCard: noop,
    onEscape: () => false, flash: state.flash ?? null, onUndo: noop }));
  const body = state.open === false ? "" : renderToStaticMarkup(createElement(PickerBody, { mode, query, items, highlight: state.highlight ?? startHighlight(query), busy: false,
    linked: picker.linked, current: { id: "effort-shelf-order", name: "Shelf order" }, confirm: state.confirm ? picker.linked[1]! : null, notice: null, error: null,
    listId: title.replace(/\W+/gu, "-"), onQuery: noop, onKeyDown: noop, onPick: noop, onHighlight: noop, onLinkMode: noop, onMove: noop, onConfirmMove: noop,
    onCancelMove: noop, onOpenPr: noop }));
  // The popover as Radix places it: above the chip, start-aligned, 6px off.
  return `<figure style="position:relative;height:480px;display:flex;flex-direction:column;justify-content:flex-end;padding:12px;border:1px dashed var(--border);border-radius:8px">
<figcaption style="position:absolute;top:8px;left:12px;font-size:11px;color:var(--muted-foreground)">${title}</figcaption>
${body ? `<div class="z-50 w-80 rounded-lg border border-border bg-popover text-[12px] text-popover-foreground shadow-md" style="margin-bottom:6px">${body}</div>` : ""}
${bar}<div style="height:64px;border:1px solid var(--border);border-radius:10px;color:var(--muted-foreground);padding:8px 10px;font-size:12.5px">Ask for a follow-up</div></figure>`;
}

const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Thread effort preview</title><style>
:root{color-scheme:dark;--background:#151515;--foreground:#e6e6e6;--card:#1b1b1b;--popover:#1f1f1f;--popover-foreground:#e6e6e6;--muted:#232323;
--muted-foreground:#9a9a9a;--border:#2c2c2c;--input:#333;--ring:#6b8afd;--destructive:#f07178;--state-hover:#ffffff10;--state-active:#ffffff18;--radius:6px}
:root.light{color-scheme:light;--background:#ffffff;--foreground:#1c1c1c;--card:#ffffff;--popover:#ffffff;--popover-foreground:#1c1c1c;--muted:#f4f4f4;
--muted-foreground:#6e6e6e;--border:#e4e4e4;--input:#dcdcdc;--destructive:#d23f4a;--state-hover:#0000000a;--state-active:#00000012}
@layer theme,base,utilities;@layer base{*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
button,input{font:inherit;color:inherit;background:transparent;text-align:inherit}svg{display:block}}
body{margin:0;background:var(--background);color:var(--foreground);font:13px/1.45 system-ui,-apple-system,sans-serif}
</style><style>${readFileSync(css, "utf8")}</style><script>if (location.hash.includes("light")) document.documentElement.className = "light";</script></head>
<body><main data-bb-plugin="workstreams" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:12px">
${panel("Open, ↓ once", { highlight: 0 })}${panel("Typed a new name", { query: "Shelf gaps" })}${panel("+ Link PR", { mode: "link", query: "folio", highlight: 1 })}
${panel("After a pick", { open: false, flash: { text: "In Store pickup", undo: true } })}${panel("Move here…", { confirm: true })}
</main></body></html>`;
const out = join(process.env.TMPDIR ?? tmpdir(), "thread-effort-preview.html");
writeFileSync(out, html);
console.log(out);
