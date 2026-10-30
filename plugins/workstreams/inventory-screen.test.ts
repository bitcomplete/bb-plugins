import { cardScreen } from "./deck-view-model.js";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellDeck, inkwellInventory, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import type { InventoryView } from "./inventory-view.js";
import { actionCall, inventoryScreen, onYourTurn, sendable, yourTurnRows, type InventoryLine } from "./inventory-view-model.js";
import { AdvanceSelectionBody, PrActionControls, InventoryPane, InventoryPending, splitInventory } from "./inventory-screen.js";
import { COLUMN, CONTENT, GROUP_CARD } from "./deck-screen.js";
import { MergePreviewBody, mergeTrigger, type MergePreview } from "./merge-preview-dialog.js";
import type { Sent } from "./your-turn.js";

const VIEW = inkwellInventory();
const SCREEN = inventoryScreen(VIEW, { now: NOW, filter: null });
const noop = () => {};
const CALLBACKS = { busyKey: null, onView: noop, onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenEffort: noop, onNudge: noop, onAsk: noop, onDismiss: noop };
function pane(view: InventoryView = VIEW) {
  return renderToStaticMarkup(createElement(InventoryPane, { screen: view === VIEW ? SCREEN : inventoryScreen(view, { now: NOW, filter: null }), error: null, ...CALLBACKS }));
}
/** The view with each row `patch` names changed. */
const patched = (patch: (row: InventoryView["groups"][number]["rows"][number]) => Partial<InventoryView["groups"][number]["rows"][number]> | null): InventoryView =>
  ({ ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, ...patch(row) })) })) });
const refs = (groups: ReturnType<typeof splitInventory>["turn"]) => groups.map((group) => [group.label, group.lines.map((line) => `${line.slug}#${line.number}`)]);
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
const line = (pr: string): InventoryLine => SCREEN.groups.flatMap((group) => group.lines).find((item) => `${item.repo} #${item.number}` === pr)!;
/** One row's markup, from its start to the next row's. */
const rowOf = (html: string, ref: string) => { const start = html.indexOf(`data-inventory-row="${ref}"`); return html.slice(start, html.indexOf("data-inventory-row=", start + 20)); };

describe("Refresh in All PRs", () => {
  const read = (prUrls: string[], outcomes: Parameters<typeof inventoryScreen>[1]["outcomes"] = new Map(), header?: () => void) =>
    renderToStaticMarkup(createElement(InventoryPane, { screen: inventoryScreen(VIEW, { now: NOW, filter: null, outcomes,
      pending: new Map(prUrls.map((prUrl) => [prUrl, "refresh" as const])) }), error: null, ...CALLBACKS, onRefresh: noop, reading: new Set(prUrls), onRefreshAll: header }));
  const ref = (prUrl: string) => prUrl.replace("https://github.com/", "").replace("/pull/", "#");

  // Every list, Your turn's and the rest, so a stale row anywhere can be read again.
  it("puts ↻ on every row, which spins in sight while GitHub reads it", () => {
    const quill = "https://github.com/inkwell/quill/pull/210", catalog = "https://github.com/inkwell/catalog/pull/96";
    const html = read([quill]);
    const rows = SCREEN.groups.flatMap((group) => group.lines);
    expect(rows.filter((item) => rowOf(html, ref(item.prUrl)).includes('data-inventory-action="refresh"'))).toHaveLength(rows.length);
    expect(rowOf(html, ref(quill))).toMatch(/data-inventory-action="refresh" disabled="" aria-busy="true" aria-label="Reading inkwell\/quill#210 from GitHub"[^>]*class="(?![^"]*opacity-0)[^"]*"><span aria-hidden="true" class="[^"]*motion-safe:animate-spin">↻/u);
    expect(rowOf(html, ref(catalog))).toMatch(/data-inventory-action="refresh" aria-label="Read catalog #96 from GitHub now" title="Read catalog #96 from GitHub now \(g\)" class="[^"]*opacity-0 group-hover:opacity-100/u);
  });

  it("says Read just now on a row its read answered, and why on a row whose read failed", () => {
    const quill = "https://github.com/inkwell/quill/pull/210", folio = "https://github.com/inkwell/folio/pull/330";
    const html = read([], new Map([[quill, { at: NOW, action: "refresh" as const, ok: true, text: "Read" }],
      [folio, { at: NOW, action: "refresh" as const, ok: false, text: "GraphQL: API rate limit exceeded" }]]));
    expect(text(rowOf(html, ref(quill)))).toContain("Read just now");
    expect(rowOf(html, ref(folio))).toMatch(/role="status" class="[^"]*text-destructive">Refresh failed 0s ago: GraphQL: API rate limit exceeded</u);
  });

  it("reads every open PR again from Last read, which takes no click while a read runs", () => {
    expect(read([], new Map(), noop)).toMatch(/<button type="button" data-ws-read="true" title="Read every open PR from GitHub again"[^>]*><span aria-hidden="true">↻<\/span><span class="truncate">Last read 25s ago<\/span>/u);
    const busy = renderToStaticMarkup(createElement(InventoryPane, { screen: inventoryScreen({ ...VIEW, refreshing: true }, { now: NOW, filter: null }), error: null, ...CALLBACKS, onRefreshAll: noop }));
    expect(busy).toMatch(/<button type="button" data-ws-read="true" disabled=""[^>]*><span class="truncate">Last read 25s ago · reading now<\/span>/u);
  });
});

describe("simple All PRs list", () => {
  // The server marks Your turn: the three change requests and the two approvals with comments. CI, conflicts, and waits stay below.
  it("puts Your turn first by effort, and shows each PR in only one list", () => {
    const parts = splitInventory(SCREEN);
    expect(refs(parts.turn)).toEqual([["Store pickup", ["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155"]],
      ["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    const turn = new Set(parts.turn.flatMap((group) => group.lines.map((line) => line.prUrl)));
    expect(parts.other.flatMap((group) => group.lines).filter((line) => turn.has(line.prUrl))).toEqual([]);
    expect(parts.other.flatMap((group) => group.lines).map((line) => line.number)).toEqual(expect.arrayContaining([305, 330, 96]));
    const html = pane();
    expect(html).toContain("Your turn");
    expect(html).not.toContain("Back to me");
    expect(html).toContain("Other open PRs");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Filter by question");
  });

  // The badge counts what the list shows, so the two never disagree.
  it("counts Your turn as the list shows it, under its heading and in the badge", () => {
    for (const view of [VIEW, patched((row) => row.number === 318 ? { yourTurn: null } : null), patched(() => ({ yourTurn: null }))]) {
      const listed = splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn.flatMap((group) => group.lines).length;
      expect(yourTurnRows(view, NOW)).toHaveLength(listed);
      expect(text(pane(view))).toContain(`Your turn ${listed} `);
    }
    expect(yourTurnRows(VIEW, NOW)).toHaveLength(5);
  });

  // One list: a person's comment puts a PR on Your turn and the badge like any other clause, with its one line of why. Dismissed, it leaves
  // both for a closed "N dismissed" toggle whose rows come back with Undismiss, and never select for Address.
  it("lists every clause in one Your turn with its why, and keeps dismissed rows under a closed toggle, out of the badge and Address", () => {
    const comment = { why: "Comment from @theo-k", since: NOW - 3_600_000, latest: NOW - 3_600_000 };
    const view = patched((row) => row.number === 96 ? { yourTurn: comment } : null);
    const parts = splitInventory(inventoryScreen(view, { now: NOW, filter: null }));
    expect(refs(parts.turn).flatMap(([, lines]) => lines)).toContain("inkwell/catalog#96");
    expect(yourTurnRows(view, NOW)).toHaveLength(6);
    const html = pane(view);
    expect(html).not.toContain("Comments only");
    expect(text(rowOf(html, "inkwell/catalog#96"))).toContain("Comment from @theo-k · 1h");
    expect(rowOf(html, "inkwell/catalog#96")).toMatch(/data-inventory-action="dismiss"[^>]*>Dismiss<\/button>/u);
    const gone = patched((row) => row.number === 96 ? { yourTurn: comment, dismissed: true } : null);
    const hidden = splitInventory(inventoryScreen(gone, { now: NOW, filter: null }));
    expect(refs(hidden.dismissed)).toEqual([["No effort", ["inkwell/catalog#96"]]]);
    expect(refs(hidden.turn).flatMap(([, lines]) => lines)).not.toContain("inkwell/catalog#96");
    expect(refs(hidden.other).flatMap(([, lines]) => lines)).not.toContain("inkwell/catalog#96");
    const line = hidden.dismissed[0]!.lines[0]!;
    expect([onYourTurn(line), sendable(line), yourTurnRows(gone, NOW).length]).toEqual([false, false, 5]);
    const shown = pane(gone);
    expect(shown).toMatch(/<details[^>]*data-inventory-dismissed="true"[^>]*>/u);
    expect(shown).not.toMatch(/<details[^>]*data-inventory-dismissed="true"[^>]*open/u);
    expect(text(shown)).toContain("1 dismissed · show");
    const row = rowOf(shown, "inkwell/catalog#96");
    expect(row).toMatch(/data-inventory-action="undismiss"[^>]*>Undismiss<\/button>/u);
    expect(row).not.toContain("Select inkwell/catalog#96");
  });

  // The deck files a PR a thread is fixing now In flight, and a held effort's PRs wait with it, so neither asks anything of you yet: the list
  // and the badge leave both out until the thread stops or you resume the effort.
  it("leaves out a PR a thread is working on and a held effort's PRs, in the list and the badge alike", () => {
    const turn = (view: InventoryView) => refs(splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn);
    const working = patched((row) => row.number === 211 ? { threads: { ...row.threads, executor: { ...row.threads.executor!, active: true } } } : null);
    expect(turn(working)).toEqual([["Store pickup", ["inkwell/quill#210", "inkwell/spine#155"]], ["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => group.effort?.id === "effort-store-pickup" ? { ...group, effort: { ...group.effort, pile: "held" } } : group) };
    expect(turn(held)).toEqual([["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    for (const view of [working, held]) expect(yourTurnRows(view, NOW)).toHaveLength(turn(view).flatMap(([, lines]) => lines).length);
  });

  // A Your turn row is its PR, its feedback, and at most one thing beside it: nothing else competes with selecting it for Address.
  it("says why it's your turn and since when, with no Open thread or Ask its thread competing on the row", () => {
    const html = pane();
    expect(text(rowOf(html, "inkwell/quill#210"))).toContain("ABC-370 Hold books at the counter Changes requested by @otto-v · 1d");
    expect(text(rowOf(html, "inkwell/folio#301"))).toContain("ABC-350 Show spine labels on shelf cards Approval comment from @mira-l · 2d");
    for (const ref of ["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155", "inkwell/folio#301", "inkwell/folio#318"]) {
      expect([ref, rowOf(html, ref).match(/Open thread|Ask its thread/u)]).toEqual([ref, null]);
    }
    expect(html).not.toContain('data-inventory-action="ask"');
    // Other open PRs lead with their state and next step, and never with Open thread.
    expect(rowOf(html, "inkwell/folio#330")).not.toContain("Open thread");
    expect(html).not.toContain(">Start<");
  });

  it("says when no feedback waits on you", () => {
    expect(text(pane(patched(() => ({ yourTurn: null }))))).toContain("Your turn 0 Nothing waits on you.");
  });

  it("offers Nudge only where the inventory action is enabled", () => {
    const html = pane();
    expect((html.match(/data-inventory-action="nudge"/gu) ?? [])).toHaveLength(1);
    expect(html).not.toContain("data-inventory-action=\"merge\"");
    expect(html).not.toContain("data-inventory-action=\"request-review\"");
  });

  // The button is the row's own action, and only off Your turn: there you answer first. An answered change request reads Re-request, so
  // the word on the button says what the click sends.
  it("draws no Nudge or Re-request on a Your turn row, and Re-request off it where you've answered", () => {
    const waiting = { why: "Approval comment from @mira-l · 5 open threads", since: null, latest: null };
    const turn = rowOf(pane(patched((row) => row.number === 96 ? { yourTurn: waiting } : null)), "inkwell/catalog#96");
    expect(turn).toContain("5 open threads");
    expect(turn).not.toContain('data-inventory-action="nudge"');
    expect(rowOf(pane(), "inkwell/catalog#96")).toMatch(/data-inventory-action="nudge"[^>]*>Nudge<\/button>/u);
    const rerequest = { question: "needs-nudge" as const, kind: "rereview-needed" as const, action: "rerequest" as const, nextStep: "Re-request review from @otto-v",
      owner: "you" as const, reviewers: ["otto-v"], since: NOW - 3_600_000, ageMs: 3_600_000, basis: "github" as const };
    expect(rowOf(pane(patched((row) => row.number === 211 ? { attention: [rerequest] } : null)), "inkwell/quill#211")).not.toContain('data-inventory-action="nudge"');
    const asked = rowOf(pane(patched((row) => row.number === 211 ? { attention: [rerequest], yourTurn: null } : null)), "inkwell/quill#211");
    expect(asked).toMatch(/data-inventory-action="nudge"[^>]*title="Re-request review from @otto-v on quill #211"[^>]*>Re-request @otto-v<\/button>/u);
  });

  it("keeps the primary read notice visible and folds many other notices without dropping their text or roles", () => {
    const notices = [{ tone: "error" as const, text: "GitHub rate limited this read." },
      ...Array.from({ length: 24 }, (_, index) => ({ tone: "info" as const, text: `Repository ${index + 1} needs a read.` }))];
    const html = renderToStaticMarkup(createElement(InventoryPane, { screen: { ...SCREEN, notices }, error: "Inventory request failed", ...CALLBACKS }));
    expect(html).toMatch(/role="alert"[^>]*>Couldn&#x27;t read the inventory: Inventory request failed/gu);
    expect(html).toMatch(/role="alert"[^>]*>GitHub rate limited this read\.<\/p><details/gu);
    expect(html).toContain("<summary");
    expect(html).toContain("24 more inventory notices");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Repository 24 needs a read.");
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("Your turn"));
  });

  it("keeps tabs and retry visible when the first inventory read fails", () => {
    const html = renderToStaticMarkup(createElement(InventoryPending, { error: "HTTP 500", onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    expect(html).toContain("All PRs");
    expect(html).toContain("Couldn&#x27;t read the inventory: HTTP 500");
    expect(html).toContain("Retry");
  });

  it("links each effort's group to its deck card, with No effort last and plain", () => {
    const html = pane();
    const heading = (label: string) => html.slice(html.indexOf(`data-inventory-group="${label}"`), html.indexOf("</h3>", html.indexOf(`data-inventory-group="${label}"`)));
    expect(heading("Shelf order")).toMatch(/<button type="button"[^>]*>Shelf order<\/button>$/u);
    expect(heading("Store pickup")).toMatch(/<button type="button"[^>]*>Store pickup<\/button>$/u);
    expect(html.indexOf('data-inventory-group="No effort"')).toBeGreaterThan(html.indexOf('data-inventory-group="Store pickup"'));
    expect(heading("No effort")).not.toContain("<button");
    // The Roster is gone, so a group's name opens its effort's card on the deck.
    expect(readFileSync(new URL("inventory-screen.tsx", import.meta.url), "utf8"))
      .toContain('onOpenEffort={(effortId) => navigate.toPluginPanel("board", { subPath: `deck/${encodeURIComponent(effortId)}` })}');
  });

  // A group reads as one thing: its title, then a card holding every row it lists, in the deck panels' look, so All PRs and the deck read alike.
  it("puts each group's rows, dismissed ones too, in a card directly under the group's title", () => {
    const surface = "rounded-[10px] border border-border/50 bg-foreground/[0.015]";
    expect(GROUP_CARD).toContain(surface);
    expect(readFileSync(new URL("deck-screen.tsx", import.meta.url), "utf8")).toContain('<div data-deck-panel={panel} className="mt-2 px-1">');
    const view = patched((row) => row.number === 96 ? { yourTurn: { why: "Comment from @theo-k", since: NOW, latest: NOW }, dismissed: true } : null);
    const html = pane(view);
    const { turn, dismissed, other } = splitInventory(inventoryScreen(view, { now: NOW, filter: null }));
    expect(dismissed).toHaveLength(1);
    const groups = [...html.matchAll(/<section data-inventory-group="[^"]+"[^>]*><h3[^>]*>.*?<\/h3><ul class="([^"]*)">(.*?)<\/ul><\/section>/gu)];
    expect(groups).toHaveLength(turn.length + dismissed.length + other.length);
    expect(groups.every(([, card]) => GROUP_CARD.split(" ").every((name) => card!.split(" ").includes(name)))).toBe(true);
    // Every row on the page sits in one of those cards.
    const inCards = groups.reduce((sum, [, , rows]) => sum + rows!.split("data-inventory-row=").length - 1, 0);
    expect(inCards).toBe(html.split("data-inventory-row=").length - 1);
  });

  it("shows each row's state word and next step with its age", () => {
    const words = text(pane());
    expect(words).toContain("catalog #96 ABC-121 Show series order on catalog pages Awaiting review · Nudge @mira-l, @theo-k · 2d Nudge");
    expect(words).toContain("folio #330 ABC-364 Keep shelf filters in the link Conflicts · Resolve the conflicts · 2d+");
    expect(words).toContain("quill #212 ABC-372 Email when a hold is ready Behind #210 · Waits on #210");
  });

  // Confirming review notes is the deck's: one PR's notes, read fresh, in its confirm. All PRs shows the wait and offers no way around it.
  it("lists an approval with comments as your turn, with no Confirm handled or Merge… here", () => {
    for (const [ref, by] of [["inkwell/folio#301", "mira-l"], ["inkwell/folio#318", "theo-k"]]) {
      const row = rowOf(pane(), ref!);
      expect(text(row)).toContain(`Approval comment from @${by} · 2d`);
      expect(row).not.toContain('data-inventory-action="confirm-handled"');
      expect(row).not.toContain('data-inventory-action="merge"');
    }
  });

  it("keeps every row's PR number outside the part that truncates, so a long repo name never hides it", () => {
    const long = "inkwell/a-repository-name-long-enough-to-truncate-in-any-pane";
    const html = pane(patched((row) => row.number === 96 || row.number === 210 ? { repo: long } : null));
    const numbers = [...html.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span><b class="shrink-0 [^"]*">#(\d+)<\/b>/gu)];
    expect(numbers).toHaveLength(17);
    for (const [, repo] of numbers) expect(repo).not.toMatch(/#\d/u);
    expect(numbers.map((match) => `${match[1]}#${match[2]}`)).toEqual(expect.arrayContaining([`${long.split("/").pop()}#96`, `${long.split("/").pop()}#210`]));
  });

  // The title gets all the width beside the PR, so the why moves under it, where a narrow pane wraps it rather than cutting it short.
  it("puts the title on a line of its own, the why on the next, and the PR in a column beside both", () => {
    const row = rowOf(pane(), "inkwell/catalog#96");
    // The PR's column closes before the title's line opens, and the title's line closes before the why's opens.
    const match = row.match(/#96<\/b><\/button><div class="[^"]*"><p class="([^"]*)" title="[^"]*">([^<]*)<\/p><div class="([^"]*)"><span class="([^"]*)" title="[^"]*">([^<]*)<\/span>/u);
    expect(match).not.toBeNull();
    const [, titleClass, title, lineClass, whyClass, why] = match!;
    expect([title, why]).toEqual(["ABC-121 Show series order on catalog pages", "Awaiting review · Nudge @mira-l, @theo-k · 2d"]);
    expect(titleClass).toContain("truncate");
    expect(lineClass).toContain("flex-wrap");
    expect(whyClass).not.toContain("truncate");
  });

  it("shows a row's last action, or the server's refusal word for word, under its next step", () => {
    const refused = "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written.";
    const view = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, lastAction: { at: NOW - 60_000, action: "nudge" as const, ok: false, detail: refused, reviewers: [] } } : row) })) };
    expect(pane(view)).toMatch(new RegExp(`<p role="status" class="[^"]*text-destructive"[^>]*>Nudge refused 1m ago: ${refused.replace(/[().]/gu, "\\$&")}</p>`, "u"));
  });

  it("shows the rate limit and a failed read as alerts naming the reset", () => {
    const html = pane({ ...VIEW, rateLimitedUntil: NOW + 5 * 60_000 });
    expect(html).toMatch(/role="alert"[^>]*>.*?GitHub&#x27;s rate limit holds reads until \d{2}:\d{2}\. Rows show the last good read\./u);
    const failed = renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, error: "HTTP 500", ...CALLBACKS }));
    expect(failed).toContain('role="alert" class="text-[12px] text-destructive">Couldn&#x27;t read the inventory: HTTP 500');
  });

  it("keeps every text size at 11px or larger, uses no amber, and animates only when motion is allowed", () => {
    const busy = { ...VIEW, refreshing: true };
    for (const html of [pane(), pane(busy)]) {
      // The shared header's key badges are the deck's own, whose contrast deck-badges.test.ts checks; All PRs' text stays 11px or larger.
      expect(html.replace(/<header data-ws-header[\s\S]*?<\/header>/u, "")).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]|text-\[0\.\d+rem\]|text-xs/u);
      expect(html).not.toMatch(/\bamber-/u);
      expect(html).not.toMatch(/(?<!motion-safe:)\banimate-/u);
      expect(html).not.toMatch(/#[0-9a-f]{6}\b/iu);
    }
    expect(pane(busy)).toContain("motion-safe:animate-spin");
  });
});

describe("All PRs beside the effort deck", () => {
  // Holding an effort holds its PRs, so a Nudge there would only be refused; a done or archived effort's rows offer none either.
  it("offers no Nudge on a held, done, or archived effort's rows, and keeps the rows in view", () => {
    const piled = (pile: "held" | "done" | "archived"): InventoryView => ({ ...VIEW, groups: VIEW.groups.map((group) => group.effort === null
      ? { ...group, effort: { id: "effort-loose", name: "Loose ends", pile } } : group) });
    expect(rowOf(pane(), "inkwell/catalog#96")).toContain('data-inventory-action="nudge"');
    for (const pile of ["held", "done", "archived"] as const) {
      const html = pane(piled(pile));
      expect(html).not.toContain('data-inventory-action="nudge"');
      expect(html).toContain('data-inventory-row="inkwell/catalog#96"');
    }
  });

  // A per-PR hold suppresses every step the row would name, so its Nudge goes too, until you release it in the deck.
  it("offers no Nudge on a held PR", () => {
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, hold: { reason: "Waiting on the catalog redesign", heldAt: NOW - 3_600_000 }, attention: [], status: "On hold" } : row) })) };
    const row = rowOf(pane(held), "inkwell/catalog#96");
    expect(text(row)).toContain("On hold");
    expect(row).not.toContain('data-inventory-action="nudge"');
  });

  it("lets j and k focus rows for the deck's keys, with the same accent ring", () => {
    const html = pane();
    const rows = [...html.matchAll(/<li data-inventory-row="[^"]+" tabindex="-1" class="([^"]+)"/gu)];
    expect(rows).toHaveLength(17);
    expect(rows.every((match) => match[1]!.includes("focus-visible:ring-sky-500"))).toBe(true);
  });
});

describe("All PRs in the deck's column", () => {
  // Switching between Efforts and All PRs keeps the content where it was: one centered column, from one constant.
  it("centers its content and selection bar in the deck's column, at the deck's width", () => {
    expect(COLUMN).toBe("mx-auto max-w-3xl");
    expect(CONTENT.split(" ")).toEqual(expect.arrayContaining(COLUMN.split(" ")));
    const picked = new Set(["https://github.com/inkwell/quill/pull/210"]);
    const html = renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, error: null, ...CALLBACKS, selected: picked, onSelect: noop, onSelectAll: noop }));
    expect(html).toContain(`<div class="${CONTENT}">`);
    expect(html).toMatch(new RegExp(`<div aria-label="Selection"[^>]*><div class="${COLUMN} `, "u"));
    const pending = renderToStaticMarkup(createElement(InventoryPending, { error: null, onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    expect(pending).toContain(`<div class="${CONTENT}">`);
    // The deck draws its content from the same constant.
    expect(readFileSync(new URL("deck-screen.tsx", import.meta.url), "utf8")).toContain("<div ref={props.viewRef} className={CONTENT}>");
  });
});

describe("the inventory before its first read", () => {
  it("keeps the shared header while it reads or when the read failed, so every other view stays one click away", () => {
    const pending = (error: string | null) => renderToStaticMarkup(createElement(InventoryPending, { error, onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    for (const html of [pending(null), pending("HTTP 500")]) {
      expect(html).toContain('data-ws-header="inventory"');
      expect([...html.matchAll(/<nav aria-label="Workstreams views"[^>]*>(.*?)<\/nav>/gu)].map((match) => text(match[1]!).trim())).toEqual(["Efforts All PRs"]);
      expect(text(html)).toContain("More ▾");
    }
    expect(text(pending(null))).toContain("Reading your open PRs…");
    const failed = pending("HTTP 500");
    expect(failed).toContain('role="alert"');
    expect(failed).toMatch(/<button type="button" class="[^"]*focus-visible:ring-2[^"]*">Retry<\/button>/u);
    expect(text(failed)).toContain("Couldn't read the inventory: HTTP 500 Retry");
  });
});

describe("selecting Your turn PRs to address together", () => {
  const selectedPane = (selected: ReadonlySet<string>, view: InventoryView = VIEW, extra: { refusal?: string; notes?: ReadonlyMap<string, string> } = {}) =>
    renderToStaticMarkup(createElement(InventoryPane, { screen: view === VIEW ? SCREEN : inventoryScreen(view, { now: NOW, filter: null }), error: null, ...CALLBACKS,
      selected, onSelect: noop, onSelectAll: noop, onAddress: noop, onClear: noop, onUndo: noop, ...extra }));
  const boxes = (html: string) => [...html.matchAll(/aria-label="Select (inkwell\/[^"]+)"/gu)].map((match) => match[1]);

  // Every open row takes a checkbox, to move it to an effort; Your turn's box takes Your turn alone, which Address can.
  it("offers a checkbox on each row and a box for all of Your turn", () => {
    const html = selectedPane(new Set());
    expect(boxes(html)).toEqual(splitInventory(SCREEN).turn.concat(splitInventory(SCREEN).other).flatMap((group) => group.lines.map((line) => `${line.slug}#${line.number}`)));
    expect(boxes(html).slice(0, 5)).toEqual(["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155", "inkwell/folio#301", "inkwell/folio#318"]);
    expect(html).toContain('aria-label="Select every Your turn PR"');
    // Nothing selected, nothing to address: the bar stays away.
    expect(html).not.toContain('data-inventory-action="address"');
    // Without the handlers, as before, the rows draw no checkbox.
    expect(boxes(pane())).toEqual([]);
  });

  it("shows the selection with Address N and its key, and Clear", () => {
    const picked = new Set(["https://github.com/inkwell/quill/pull/210", "https://github.com/inkwell/folio/pull/301"]);
    const html = selectedPane(picked);
    expect(rowOf(html, "inkwell/quill#210")).toContain('data-inventory-selected="true"');
    expect(rowOf(html, "inkwell/quill#211")).not.toContain("data-inventory-selected");
    expect(text(html)).toContain("2 selected Address 2 b Refresh (2) g Clear esc");
    expect(html).toMatch(/data-inventory-action="address" title="Starts one thread for them now, with 8 s to Undo\. Nothing merges\."/u);
    expect(html).not.toContain("data-inventory-refusal");
    // Every row selected: the list's box reads as clearing them.
    expect(selectedPane(new Set(yourTurnRows(VIEW, NOW).map((line) => line.prUrl)))).toContain('aria-label="Clear the selection"');
  });

  // A sent PR links its thread with BB's live status, Working, Needs you, or Idle, and can't be picked again while its batch or thread has it.
  // The link stays once the PR leaves Your turn, grey on Other open PRs with no box, like Reviews' started items.
  it("links each sent PR's thread with its live status, offers no box while it works, and keeps the link off Your turn", () => {
    const sent = (state: Sent["state"], detail: string | null = null, threadId: string | null = "thr-batch") => ({ state, threadId, title: "Address feedback on 5 PRs",
      detail, batchId: state === "sending" ? "b-1" : null });
    const view = patched((row) => row.number === 210 ? { addressing: { threadId: "thr-batch", title: "Address feedback on 5 PRs" }, sent: sent("working") }
      : row.number === 211 ? { sent: sent("sending", null, null) } : row.number === 155 ? { sent: sent("idle") }
        : row.number === 301 ? { sent: sent("needs-you") } : null);
    const html = selectedPane(new Set(), view);
    expect(refs(splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn)).toEqual([["Store pickup", ["inkwell/quill#210", "inkwell/quill#211",
      "inkwell/spine#155"]], ["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    const turnRefs = refs(splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn).flatMap(([, lines]) => lines);
    expect(boxes(html).filter((ref) => turnRefs.includes(ref!))).toEqual(["inkwell/spine#155", "inkwell/folio#318"]);
    const chip = (markup: string, ref: string) => { const row = rowOf(markup, ref); const at = row.indexOf("data-inventory-sent="); return text(row.slice(row.lastIndexOf("<", at), row.indexOf("</li>", at))).trim(); };
    expect(["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155", "inkwell/folio#301"].map((ref) => chip(html, ref))).toEqual(["Working ↗",
      "Sending · Undo", "Idle ↗", "Needs you ↗"]);
    for (const ref of ["inkwell/quill#210", "inkwell/spine#155", "inkwell/folio#301"]) expect(rowOf(html, ref)).toMatch(/<button type="button" data-inventory-sent="[\w-]+" title="[^"]+ · open “Address feedback on 5 PRs”"/u);
    expect(rowOf(html, "inkwell/quill#211")).toMatch(/data-inventory-sent="sending"[^>]*>Sending · <button type="button"[^>]*>Undo<\/button>/u);
    // A dispatch refusal is one line on its row.
    expect(text(rowOf(selectedPane(new Set(), patched((row) => row.number === 210 ? { sent: sent("refused", "Its effort is on hold. Nothing was started.", null) } : null)),
      "inkwell/quill#210"))).toContain("Not sent: Its effort is on hold. Nothing was started.");
    // Answered, it leaves Your turn and keeps its link, grey on Other open PRs, where its box moves it and Address won't take it.
    const left = patched((row) => row.number === 155 ? { sent: sent("idle"), yourTurn: null } : null);
    const parts = splitInventory(inventoryScreen(left, { now: NOW, filter: null }));
    expect(refs(parts.turn).flatMap(([, lines]) => lines)).not.toContain("inkwell/spine#155");
    expect(refs(parts.other).flatMap(([, lines]) => lines)).toContain("inkwell/spine#155");
    const other = selectedPane(new Set(), left);
    expect(chip(other, "inkwell/spine#155")).toBe("Idle ↗");
    expect(rowOf(other, "inkwell/spine#155")).toContain("Select inkwell/spine#155");
    expect(rowOf(selectedPane(new Set(), patched((row) => row.number === 155 ? { sent: sent("working"), yourTurn: null } : null)), "inkwell/spine#155"))
      .toMatch(/data-inventory-sent="working"[^>]*class="[^"]*text-muted-foreground/u);
  });

  // Nothing fails quietly: why nothing started shows on the selection bar, and why each PR wasn't sent, in one line on its own row.
  it("shows why nothing started on the selection bar, and each unsent PR's reason on its row", () => {
    const picked = new Set(["https://github.com/inkwell/quill/pull/210", "https://github.com/inkwell/folio/pull/301"]);
    const html = selectedPane(picked, VIEW, { refusal: "Nothing started. quill #210: An agent is already working on it.",
      notes: new Map([["https://github.com/inkwell/quill/pull/210", "An agent is already working on it."]]) });
    expect(html).toMatch(/role="alert" data-inventory-refusal[^>]*>Nothing started\. quill #210: An agent is already working on it\.</u);
    expect(rowOf(html, "inkwell/quill#210")).toMatch(/role="alert" data-inventory-sent="refused"[^>]*><span class="truncate">Not sent: An agent is already working on it\.</u);
    expect(rowOf(html, "inkwell/folio#301")).not.toContain("Not sent");
  });
});

describe("keyboard safety", () => {
  // All PRs offers no merge at all; the deck's Merge… opens the same fresh preview, whose Merge button refuses Enter and Space.
  it("never merges from All PRs, and a row's merge only opens the fresh preview, whose Merge refuses Enter", () => {
    for (const html of [pane(), pane(patched(() => ({ yourTurn: null })))]) {
      expect(html).not.toContain('data-inventory-action="merge"');
      expect(html).not.toContain("data-merge-go");
    }
    const url = "https://github.com/inkwell/folio/pull/340";
    const row = VIEW.groups.flatMap((group) => group.rows).find((entry) => entry.prUrl === url)!;
    // A row's merge action carries no head to merge: it only opens the preview.
    expect(actionCall(row, line("folio #340").actions.find((entry) => entry.id === "merge")!)).toEqual({ kind: "preview", target: url });
    // In the preview, Enter or Space on Merge arrives as a click with detail 0 and is refused; only a pointer click or ⌘↵ merges.
    expect(mergeTrigger({ kind: "click", detail: 0 })).toBe("refuse");
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: false, ctrlKey: false })).toBeNull();
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: true, ctrlKey: false })).toBe("merge");
    // The preview names an unnumbered PR by repository and number, pinned to the head it read.
    const preview: MergePreview = { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: row.head,
      stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true },
      refusals: [], warnings: [], method: "squash", deleteBranch: true };
    const html = renderToStaticMarkup(createElement(MergePreviewBody, { items: [{ n: null, target: url, repo: "folio", number: 340, title: row.title, preview, result: null }],
      selected: new Set([url]), busy: false, notice: null, onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop }));
    expect(text(html)).toContain(`folio #340 ${row.title} head ${row.head!.slice(0, 7)}`);
    expect(html).toMatch(/data-merge-go="true" title="Click, or press ⌘↵\. Merging needs ⌘↵ or a click; Enter alone doesn&#x27;t merge\."/u);
  });
});

// All PRs' Address selected works from its click until its start answers, and while the batch thread starts each row says so.
describe("All PRs while Address starts and sends", () => {
  const picked = new Set(["https://github.com/inkwell/quill/pull/210", "https://github.com/inkwell/folio/pull/301"]);
  const render = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, error: null, ...CALLBACKS,
    selected: picked, onSelect: noop, onSelectAll: noop, onAddress: noop, onClear: noop, ...extra }));
  const address = (html: string) => /<button type="button" data-inventory-action="address"([^>]*)>(.*?)<\/button>/u.exec(html)!;

  it("spins Address with Starting… and pulses the selected rows until the start answers", () => {
    const idle = render({});
    expect(address(idle)[1]).not.toMatch(/ disabled=""|aria-busy/u);
    expect(idle).not.toContain("data-inventory-working");
    const starting = render({ working: { kind: "address", prUrls: picked } });
    expect(address(starting)[1]).toMatch(/ disabled="" aria-busy="true"/u);
    expect(text(address(starting)[2]!).trim()).toBe("↻ Starting…");
    expect(rowOf(starting, "inkwell/quill#210")).toMatch(/data-inventory-working="true" aria-busy="true" class="[^"]*motion-safe:animate-pulse/u);
    expect(rowOf(starting, "inkwell/folio#301")).toContain('data-inventory-working="true"');
    expect(rowOf(starting, "inkwell/quill#211")).not.toContain("data-inventory-working");
  });

  it("shows each row's item as the batch moves it: queued, sending with a spinner, then sent or not sent", () => {
    const live = (a: string, b: string) => render({ live: new Map([["https://github.com/inkwell/quill/pull/210", { kind: "address", state: a }],
      ["https://github.com/inkwell/folio/pull/301", { kind: "address", state: b }]]) });
    const chip = (html: string, ref: string) => { const match = /data-inventory-live="([^"]+)"[^>]*>(.*?)<\/span>(?=<\/span><\/div><\/div><\/div><\/li>|$)/u.exec(rowOf(html, ref));
      return match && [match[1], text(match[2]!).trim()]; };
    expect([chip(live("sending", "pending"), "inkwell/quill#210"), chip(live("sending", "pending"), "inkwell/folio#301")]).toEqual([["sending", "↻ Sending…"], ["pending", "Queued"]]);
    expect([chip(live("sent", "refused"), "inkwell/quill#210"), chip(live("sent", "refused"), "inkwell/folio#301")]).toEqual([["sent", "Sent"], ["refused", "Not sent"]]);
    expect(chip(render({}), "inkwell/quill#210")).toBeNull();
  });
});

describe("PR workbench advancement", () => {
  it("puts eligible actions on the actual PR row and keeps stack merge gates disabled", () => {
    const cards = inkwellDeck().active.map((c) => cardScreen(c, { rows: {} }, { now: NOW }));
    const sources = new Map(cards.flatMap((c) => c.lines.map((l) => [l.prUrl, c] as const)));
    const html = renderToStaticMarkup(createElement(InventoryPane, { ...CALLBACKS, screen: SCREEN, error: null,
      renderActions: (line) => createElement(PrActionControls, { source: sources.get(line.prUrl)!, line, context: {}, onAction: noop }) }));
    expect(rowOf(html, "inkwell/folio#340")).toContain('data-inventory-pr-action="merge"');
    expect(rowOf(html, "inkwell/folio#341")).toMatch(/data-inventory-pr-action="merge" disabled/u);
    expect(rowOf(html, "inkwell/quill#210")).toContain('data-inventory-pr-action="address"');
    expect(rowOf(html, "inkwell/catalog#96")).toContain('data-inventory-pr-action="nudge"');
  });
  it("offers Plan Advance All regardless of selection and disables duplicate clicks while planning", () => {
    const html = (busy: boolean, error: string | null = null) => renderToStaticMarkup(createElement(InventoryPane, { ...CALLBACKS, screen: SCREEN, error: null,
      selected: new Set([line("quill #210").prUrl]), planner: { busy, error, onPlan: noop } }));
    expect(html(false)).toMatch(/data-inventory-plan-all[^>]*>Plan Advance All/u);
    expect(html(true)).toMatch(/data-inventory-plan-all="true" disabled="" aria-busy="true"/u);
    expect(html(false, "Cannot start the planning thread")).toContain('role="alert"');
    expect(text(html(false))).toContain("Plan Advance All");
  });
});


describe("advancing an Other or mixed PR selection", () => {
  const other = splitInventory(SCREEN).other.flatMap((g) => g.lines);
  const render = (lines: InventoryLine[]) => renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, error: null, ...CALLBACKS,
    selected: new Set(lines.map((l) => l.prUrl)), onSelect: noop, onSelectAll: noop, onSelectOther: noop, onAddress: noop, onAdvance: noop, onClear: noop }));

  it("offers group selection and Advance selected for Other PRs and selections crossing both lists", () => {
    for (const lines of [other, [other[0]!, splitInventory(SCREEN).turn[0]!.lines[0]!]]) {
      const html = render(lines);
      expect(html).toContain('data-inventory-action="advance-selected"');
      expect(html).not.toContain('data-inventory-action="address"');
      expect(html).not.toContain("Address takes Your turn rows only.");
      for (const l of lines) expect(rowOf(html, `${l.slug}#${l.number}`)).toContain('data-inventory-selected="true"');
    }
    expect(render([])).toContain('aria-label="Select every Other open PR"');
    expect(render(other)).toContain('aria-label="Clear Other open PRs selection"');
  });

  it("previews exactly the selected PRs, marks holds as excluded, and blocks confirmation while starting", () => {
    const lines = [other[0]!, { ...other[1]!, hold: { reason: "Waiting for migration" } } as InventoryLine];
    const body = (busy: boolean) => renderToStaticMarkup(createElement(AdvanceSelectionBody, { lines, busy, error: null, onConfirm: noop, onCancel: noop }));
    const html = body(false);
    for (const l of lines) expect(text(html)).toContain(`${l.repo} #${l.number}`);
    expect(text(html)).toContain("Excluded: on hold — Waiting for migration");
    expect(text(html)).toContain("Advance 1 in one thread");
    expect(text(html)).toContain("Nothing merges");
    expect(text(html)).not.toContain(`${other[2]!.repo} #${other[2]!.number}`);
    expect(body(true)).toMatch(/<button type="button" disabled=""[^>]*>[\s\S]*Starting…/u);
  });
});
