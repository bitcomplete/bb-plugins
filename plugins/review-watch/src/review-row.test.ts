import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AreaSection, ReviewRow } from "../app.js";
import { itemKey, type QueueItem } from "./types.js";

// The page needs BB's host; a row needs only its link and the thread navigator.
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  UrlLink: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
  useBbNavigate: () => ({ toThread: () => undefined }),
  useRealtime: () => undefined,
  useRpc: () => ({}),
}));

const item: QueueItem = {
  key: itemKey("review-requested", "PR_node7", "sha-head"),
  rule: "review-requested",
  state: "queued",
  repo: "inkwell/folio",
  number: 7,
  title: "ABC-12 Keep the reading list sort when a reader switches shelves",
  author: "alice",
  url: "https://github.com/inkwell/folio/pull/7",
  baseBranch: "main",
  headBranch: "alice/work",
  headSha: "sha-head",
  nodeId: "PR_node7",
  reason: "@alice requested your review",
  noticedAt: "2026-09-22T12:00:00Z",
  updatedAt: "2026-09-22T12:00:00Z",
};
const noop = () => undefined;

describe("a review's row", () => {
  // The title gets all the width beside the PR, so who and when move under it, where a narrow pane wraps them rather than cutting them short.
  it("puts the title on a line of its own, who and when on the next, and the PR in a column beside both", () => {
    const html = renderToStaticMarkup(createElement(ReviewRow, { item, now: Date.parse("2026-09-24T12:00:00Z"), busy: false, onPick: noop, onStart: noop, onDismiss: noop }));
    // The PR's column closes before the title's line opens, and the title's line closes before the who-and-when line opens.
    const match = html.match(/#7<\/b><\/a><div class="[^"]*"><p class="([^"]*)" title="[^"]*">([^<]*)<\/p><div class="([^"]*)"><span class="([^"]*)" title="[^"]*">([^<]*)<\/span>/u);
    expect(match).not.toBeNull();
    const [, titleClass, title, lineClass, whyClass, why] = match!;
    expect([title, why]).toEqual([item.title, "alice · 2d ago"]);
    expect(titleClass).toContain("truncate");
    expect(lineClass).toContain("flex-wrap");
    expect(whyClass).not.toContain("truncate");
  });
});

describe("an area", () => {
  // An area reads as one thing: its title, then a card holding its rows, in the same tile look as Workstreams' All PRs groups.
  it("puts its rows in a card directly under its title", () => {
    const next: QueueItem = { ...item, key: itemKey("review-requested", "PR_node8", "sha-8"), number: 8, nodeId: "PR_node8", url: "https://github.com/inkwell/folio/pull/8" };
    const area = { key: "repo:inkwell/folio", label: "folio", repos: ["folio"], items: [item, next] };
    const now = Date.parse("2026-09-24T12:00:00Z");
    const children = area.items.map((entry) => createElement(ReviewRow, { key: entry.key, item: entry, now, busy: false, onPick: noop, onStart: noop, onDismiss: noop }));
    const html = renderToStaticMarkup(createElement(AreaSection, { area, children }));
    // The title closes, the card opens, and every row sits in it.
    const card = html.match(/<\/h4><ul class="([^"]*)">(.*)<\/ul><\/section>$/u);
    expect(card).not.toBeNull();
    expect(card![1]!.split(" ")).toEqual(expect.arrayContaining("rounded-[10px] border border-border/50 bg-foreground/[0.015] px-2 py-1".split(" ")));
    expect(card![2]!.match(/<li /gu)).toHaveLength(2);
  });
});
