// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import type { BoardState, MarkerView, ViewModel } from "./board";

type Row = ViewModel["sections"][number]["groups"][number]["rows"][number];
const MONO = "parsleyhealth/parsley-monorepo";
const url = (n: number) => `https://github.com/${MONO}/pull/${n}`;
const key = (n: number) => `${MONO}#${n}`;

function row(number: number, over: Partial<Row> = {}): Row {
  return {
    key: key(number), number, url: url(number), area: "my-parsley", tone: 0, title: `Change ${number}`,
    sentence: "first review", blocked: null, depth: 0, after: null, reviewers: [],
    size: { lines: 1200, files: 14, bar: 0.7, label: "1.2k lines · 14 files" }, stack: null, action: null,
    gate_blocked: false, ...over,
  };
}

const ciRows = [1, 2, 3, 4, 5, 6].map((n) => row(600 + n, { sentence: "1 check failing", action: "fix-ci" }));
const view: ViewModel = {
  fetched_at: "2026-11-13T12:00:00+00:00",
  summary: { work: 10, ready: 1, held: 0, mine: 8, theirs: 1, drafts: 0, other: 0 },
  suggestions: [
    { id: "ready", text: "1 PR is ready to merge (#660)", action: null, keys: [] },
    { id: "fix-feedback", text: "Fix review feedback on 1 PR (#581)", action: "fix-feedback", keys: [key(581)] },
    { id: "fix-ci", text: "Fix CI on 6 PRs (#601, …)", action: "fix-ci", keys: ciRows.map((r) => r.key) },
  ],
  trains: [{ id: key(550), name: "EPD-3551 · Billing", prs: [
    { key: key(550), number: 550, url: url(550), letter: "W", state: "waiting on reviewer", title: "Change 550", sentence: "first review" },
    { key: key(582), number: 582, url: url(582), letter: "C", state: "fix CI", title: "Follow-up", sentence: "2 checks failing" },
  ] }],
  sections: [
    { id: "ready", title: "Ready to merge", count: 1, open: true, groups: [{ title: null, rows: [
      row(660, { area: "sage", sentence: "approved, checks green, no open comments", reviewers: [{ name: "Jake", state: "approved", earlier: false }] })] }] },
    { id: "mine", title: "Needs you", count: 8, open: true, groups: [
      { title: "Fix review feedback", rows: [
        row(581, { sentence: "2 issues to fix from Pedro", blocked: "Sage migration order", action: "fix-feedback",
          after: { number: 550, url: url(550) }, reviewers: [{ name: "Pedro", state: "changes", earlier: false }, { name: "Marcel", state: "approved", earlier: true }] }),
        row(582, { depth: 1, sentence: "2 checks failing", stack: key(550) })] },
      { title: "Fix CI", rows: [...ciRows, row(557, { sentence: "1 check failing", blocked: "Sage migration order", gate_blocked: true })] }] },
    { id: "theirs", title: "Waiting on a reviewer", count: 1, open: true, groups: [{ title: "Marcel", rows: [
      row(550, { area: "sage +1", stack: key(550), reviewers: [{ name: "Marcel", state: "requested", earlier: false }] })] }] },
  ],
  reviewer_load: { reviewers: [{ name: "Marcel", count: 1, first: 1, re: 0, oldest_days: 3, approx: true, keys: [key(550)] }],
    none: { count: 0, keys: [] } },
};
const state = (markers: MarkerView[] = [], over: Partial<BoardState> = {}): BoardState =>
  ({ view, lastSuccess: "2026-11-13T12:00:05Z", lastError: null, refreshing: false, markers, ...over });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  sessionStorage.clear();
});

async function renderTab(board: BoardState, openUrl: (url: string) => boolean = () => true) {
  const app = await loadPluginApp(() => import("./app"));
  const tab = app.tabs.find((candidate) => candidate.id === "pr-board" && candidate.context.kind === "thread");
  if (!tab || tab.availability !== "action") throw new Error("Missing PR board thread action tab");
  // The union does not narrow on the nested context kind; the find above guarantees a thread tab.
  const component = tab.component as ComponentType<ExperimentalThreadTabProps & { params: null }>;
  const slot = renderSlot({ component }, { threadId: "thr_1", environment: null, params: null }, {
    rpc: {
      board_get: () => board,
      board_refresh: () => ({ ...board, lastError: "gh: not logged in" }),
      start: () => ({ starting: [], skipped: [] }),
    },
    openUrl,
  });
  unmounts.push(() => slot.lifecycle.unmount());
  await slot.findByText("Change 581");
  return slot;
}
const rowOf = (slot: Awaited<ReturnType<typeof renderTab>>, n: number) =>
  within(slot.getByRole("link", { name: `#${n}` }).closest("li")!);
const startCalls = (slot: Awaited<ReturnType<typeof renderTab>>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "start").map((call) => call.input);

it("renders summary, next steps, stacks, sections, sub-groups and each row's facts", async () => {
  const slot = await renderTab(state());
  expect(slot.getByText(/open Parsley PRs/).textContent).toBe("10 open Parsley PRs: 1 can merge, 8 need you, 1 wait on a reviewer, 0 are drafts.");
  expect(slot.getAllByRole("heading", { level: 2 }).map((h) => h.textContent))
    .toEqual(["Suggested next steps", "Stacks", "Ready to merge", "Needs you", "Waiting on a reviewer", "Reviewer load"]);
  expect(slot.getByText("1 PR is ready to merge (#660)")).toBeTruthy();
  const r581 = rowOf(slot, 581);
  expect(r581.getByText("my-parsley")).toBeTruthy(); // area tag
  expect(r581.getByText("Blocked by: Sage migration order")).toBeTruthy();
  expect(r581.getAllByLabelText("Pedro requested changes")[0]?.textContent).toBe("Pedro ✗");
  // An approval on an earlier commit still counts: the same ✓, with the commit only in the tooltip.
  expect(r581.getAllByLabelText("Marcel approved on an earlier commit")[0]?.textContent).toBe(", Marcel ✓");
  expect(r581.getAllByText("1.2k lines · 14 files").length).toBeGreaterThan(0);
  expect(slot.getByRole("heading", { name: "Reviewer load" }).closest("details")?.open).toBe(false); // appendix starts collapsed
});

it("opens a PR number in bb's side panel and keeps it a real link", async () => {
  const slot = await renderTab(state());
  const link = slot.getByRole("link", { name: "#581" });
  expect(link.getAttribute("href")).toBe(url(581));
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: url(581) });
  expect(click.defaultPrevented).toBe(true);
});

it("falls back to the link's own navigation when bb declines, and leaves modifier clicks alone", async () => {
  const slot = await renderTab(state(), () => false);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  slot.getByRole("link", { name: "#581" }).dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  const before = slot.inspection.navigateCalls.length;
  fireEvent.click(slot.getByRole("link", { name: "#660" }), { metaKey: true });
  expect(slot.inspection.navigateCalls).toHaveLength(before);
});

it("nests a child under its parent and points a PR at a parent shown elsewhere", async () => {
  const slot = await renderTab(state());
  const child = slot.getByRole("link", { name: "#582" }).closest("li");
  expect(child?.textContent).toContain("└");
  expect(child?.style.paddingLeft).toBe("16px");
  expect(rowOf(slot, 581).getByText(/after/).textContent).toContain("after #550");
});

it("a suggestion's Start opens a confirmation; the chosen PRs and stopping point reach the start RPC", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: "Start (1)" }));
  const confirm = within(slot.getByRole("group", { name: "Start agents" }));
  expect(confirm.getByText(/No agent merges/)).toBeTruthy();
  expect(confirm.queryByText(/merge/i, { selector: "label" })).toBeNull(); // no merge stopping point
  expect((confirm.getByRole("radio", { name: /Publish/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(confirm.getByRole("radio", { name: /Prepare/ }));
  expect(confirm.getByText(/nothing is pushed or posted/)).toBeTruthy();
  fireEvent.click(confirm.getByRole("button", { name: "Start 1" }));
  expect(startCalls(slot)).toEqual([{ items: [{ key: key(581), action: "fix-feedback" }], stop: "prepare" }]);
});

it("unchecked PRs stay out, and more than five selected start only the first five", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: "Start (5)" }));
  const confirm = within(slot.getByRole("group", { name: "Start agents" }));
  expect(confirm.getByText(/6 selected; the first 5 will start/)).toBeTruthy();
  fireEvent.click(confirm.getByRole("checkbox", { name: /#602/ }));
  fireEvent.click(confirm.getByRole("button", { name: "Start 5" }));
  expect(startCalls(slot)).toEqual([{ items: [601, 603, 604, 605, 606].map((n) => ({ key: key(n), action: "fix-ci" })), stop: "publish" }]);
});

it("a row's own Start starts just that PR, and Cancel starts nothing", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: "Start an agent on #603" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Start agents" })).getByRole("button", { name: "Cancel" }));
  expect(startCalls(slot)).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "Start an agent on #603" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Start agents" })).getByRole("button", { name: "Start 1" }));
  expect(startCalls(slot)).toEqual([{ items: [{ key: key(603), action: "fix-ci" }], stop: "publish" }]);
});

it("a PR being worked on links to its thread instead of offering Start; a finished one says when", async () => {
  const slot = await renderTab(state([
    { key: key(581), status: "live", threadId: "thr_9", title: "Fix feedback PR 581 Change 581", at: "2026-11-13T12:00:00Z", reason: null },
    { key: key(601), status: "done", threadId: "thr_8", title: "Fix CI PR 601", at: new Date(Date.now() - 2 * 3600_000).toISOString(), reason: null },
    { key: key(602), status: "refused", threadId: null, title: null, at: "2026-11-13T12:00:00Z", reason: "its next move changed to Rebase" },
  ]));
  const r581 = rowOf(slot, 581);
  expect(r581.queryByRole("button", { name: /Start an agent/ })).toBeNull();
  fireEvent.click(r581.getByRole("button", { name: "Fix feedback PR 581 Change 581" }));
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "thr_9" }));
  expect(rowOf(slot, 601).getByText(/worked on 2 h ago/)).toBeTruthy();
  expect(rowOf(slot, 602).getByText("not started: its next move changed to Rebase")).toBeTruthy();
  expect(rowOf(slot, 602).getByRole("button", { name: /Start an agent/ })).toBeTruthy(); // a refusal can be retried
});

it("clicking a stack filters the list to it; clicking again or Clear shows everything", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: /EPD-3551 · Billing/ }));
  expect(slot.getByText("Showing stack EPD-3551 · Billing")).toBeTruthy();
  expect(slot.queryByText("Change 581")).toBeNull();
  expect(slot.getAllByText("Change 550").length).toBeGreaterThan(0);
  fireEvent.focus(slot.getByRole("button", { name: /#582 Follow-up: fix CI/ }));
  expect(slot.getByText("#582 Follow-up")).toBeTruthy(); // hover/focus line under the train
  fireEvent.click(slot.getByRole("button", { name: "Clear" }));
  expect(slot.getByText("Change 581")).toBeTruthy();
});

it("clicking a reviewer's bar filters the list to the PRs waiting on them", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: /Marcel.*oldest ~3 d/ }));
  expect(slot.getByText("Showing PRs waiting on Marcel")).toBeTruthy();
  expect(slot.queryByText("Change 581")).toBeNull();
});

it("refreshes on request and shows the last error in one line, keeping the board", async () => {
  const slot = await renderTab(state());
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await slot.findByText("Last refresh failed: gh: not logged in");
  expect(slot.getByText("Change 581")).toBeTruthy();
});

it("a gate-blocked row offers no Start and says why", async () => {
  const slot = await renderTab(state());
  const r557 = rowOf(slot, 557);
  expect(r557.queryByRole("button", { name: /Start an agent/ })).toBeNull();
  expect(r557.getByText("blocked by a gate")).toBeTruthy();
});

it("is also a sidebar page, for use outside a thread", async () => {
  const app = await loadPluginApp(() => import("./app"));
  expect(app.navPanels.map((panel) => [panel.title, panel.path])).toEqual([["PR board", "pr-board"]]);
});
