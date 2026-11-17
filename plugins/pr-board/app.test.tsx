// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BoardState, CalmRow, MarkerView, ViewModel } from "./board";
import type { PrsReview, ReviewsState } from "./reviews";
import { Board, prsBadge } from "./app";
import { minePrs, sizeDiameter } from "./board-ui";
import { z } from "zod";
import {
  agentModelSchema,
  DEFAULT_AGENT_MODEL,
  type AgentModelChoice,
} from "./agent-model";
import type { rpcContract } from "./server";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}
globalThis.__UI_SDK_STRICT__ = true;
const uiAgent = createAgent();
function modelContext(
  choice: AgentModelChoice,
): z.infer<typeof rpcContract.agent_model_get.output> {
  return { choice, routing: { kind: "host", hostId: "prs-project-host" } };
}

// jsdom doesn't implement the browser top layer or layout used by UI SDK.
HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () =>
  Object.assign([], { item: () => null });
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
document.head.append(
  Object.assign(document.createElement("style"), {
    textContent: "[popover] { display: block !important }",
  }),
);

const repo = "parsleyhealth/parsley-monorepo";
const key = (number: number) => `${repo}#${number}`;
const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
function row(number: number, over: Partial<CalmRow> = {}): CalmRow {
  return {
    key: key(number),
    number,
    url: url(number),
    repo,
    area: "sage",
    tone: 0,
    title: `Change ${number}`,
    sentence: "fix CI",
    blocked: null,
    depth: 0,
    after: null,
    reviewers: [],
    size: { lines: 100, files: 2, bar: 0.3, label: "100 lines · 2 files" },
    stack: null,
    action: "fix-ci",
    gate_blocked: false,
    segment: "on-you",
    group: "small",
    move: "fix CI",
    pushed_at: ago(10),
    parent_key: null,
    stack_front: false,
    gate_links: [],
    review_summary: "No review yet",
    review_targets: [],
    waiting: [],
    checks: [
      { name: "build", state: "fail", url: null },
      { name: "test", state: "pass", url: null },
    ],
    ...over,
  };
}
function marker(number: number, over: Partial<MarkerView> = {}): MarkerView {
  return {
    key: key(number),
    status: "live",
    question: null,
    answering: false,
    answerError: null,
    threadId: `thr_${number}`,
    title: `Agent ${number}`,
    at: ago(4),
    reason: null,
    ...over,
  };
}
const question = {
  id: "next",
  prompt: "Which fixture should the agent use?",
  options: [
    {
      id: "a",
      label: "Use synthetic fixture",
      message: "Use the synthetic fixture",
    },
    {
      id: "b",
      label: "Keep current fixture",
      message: "Keep the current fixture",
    },
  ],
};
const rows = [
  row(1, { group: "one-click", action: null, review_targets: ["dev-one"] }),
  row(2),
  row(3, {
    group: "large",
    size: { lines: 2000, files: 20, bar: 0.8, label: "2k lines · 20 files" },
    action: "rebase",
  }),
  row(4, {
    group: "blocked",
    action: null,
    gate_blocked: true,
    blocked: "Migration gate",
    gate_links: [{ label: "Migration gate", cleared_by: `${repo}#701` }],
  }),
  row(5, {
    segment: "on-reviewers",
    group: null,
    action: null,
    waiting: [{ login: "dev-one", name: "Dev One", days: 4, approx: true }],
  }),
  row(6, { segment: "drafts", group: null, action: null }),
  row(7, {
    segment: "ready",
    group: null,
    action: null,
    review_summary: "Dev One approved an earlier commit; approval still counts",
  }),
  row(8, { group: "held", action: null, repo: "other/repo" }),
  row(9),
  row(10),
];
const view: ViewModel = {
  fetched_at: ago(4),
  prs: rows,
  reviewer_batches: [{ login: "dev-one", name: "Dev One", keys: [key(1)] }],
  summary: {
    work: 10,
    ready: 1,
    held: 1,
    mine: 6,
    theirs: 1,
    drafts: 1,
    other: 1,
  },
  suggestions: [],
  trains: [],
  sections: [],
  reviewer_load: { reviewers: [], none: { count: 0, keys: [] } },
};
function state(over: Partial<BoardState> = {}): BoardState {
  return {
    view,
    lastSuccess: ago(4),
    lastError: null,
    refreshing: false,
    markers: [marker(9, { status: "asking", question }), marker(10)],
    ...over,
  };
}
function review(number: number, over: Partial<PrsReview> = {}): PrsReview {
  return {
    item: {
      key: `review-requested:node_${number}:head`,
      rule: "review-requested",
      state: "queued",
      repo,
      number,
      title: `Review change ${number}`,
      author: "dev-author",
      url: url(number),
      baseBranch: "main",
      headBranch: "feature",
      headSha: "head",
      nodeId: `node_${number}`,
      reason: "Review requested",
      noticedAt: ago(60),
      updatedAt: ago(10),
    },
    segment: "on-you",
    agentState: "none",
    evidence: "Waiting for your review",
    total: { kind: "known", additions: 100, deletions: 20, files: 2 },
    delta: { kind: "not-applicable" },
    lastReview: null,
    resolution: { kind: "known", resolved: 0, unresolved: 0 },
    ...over,
  };
}
const reviewA = review(701),
  reviewB = review(702);
const reviews = (items: PrsReview[] = [reviewA, reviewB]): ReviewsState => ({
  kind: "available",
  snapshot: { version: 1, items, lastPoll: null, lastSuccessAt: ago(3) },
});
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});
async function mount(
  options: {
    board?: BoardState;
    reviews?: ReviewsState;
    path?: string;
    rpc?: Record<string, (input: unknown) => unknown>;
    openUrl?: (url: string) => boolean;
    waitFor?: string | false;
  } = {},
) {
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.navPanels[0];
  if (!panel) throw new Error("Missing PRs panel");
  const slot = renderSlot(
    panel,
    { subPath: options.path ?? "" },
    {
      rpc: {
        agent_model_get: () => modelContext(DEFAULT_AGENT_MODEL),
        agent_model_set: (input) => agentModelSchema.parse(input),
        board_get: () => options.board ?? state(),
        board_refresh: () => options.board ?? state(),
        reviews_get: () => options.reviews ?? reviews(),
        reviews_refresh: () => ({
          ok: true,
          added: 0,
          removed: 0,
          total: 2,
          changed: false,
        }),
        start: () => ({ starting: [], skipped: [] }),
        reviews_detail: (input: unknown) => {
          const { key: reviewKey } = z.object({ key: z.string() }).parse(input);
          return (
            [reviewA, reviewB].find((item) => item.item.key === reviewKey) ??
            reviewA
          );
        },
        reviews_targets: () => ({
          projectId: "p1",
          reason: "organization",
          projects: [
            { id: "p1", name: "Project one" },
            { id: "p2", name: "Project two" },
          ],
        }),
        reviews_start: () => ({
          item: { ...reviewA.item, state: "started", threadId: "thr_review" },
        }),
        reviews_batch: () => ({ threadId: "thr_batch", items: [] }),
        reviews_dismiss: () => ({
          item: { ...reviewA.item, state: "dismissed" },
        }),
        reviewers_get: () => [
          {
            key: key(1),
            candidates: [
              { login: "dev-one", owned: true, load: 2 },
              { login: "dev-two", owned: false, load: 0 },
            ],
            note: null,
          },
        ],
        reviewers_request: () => ({ sent: [key(1)], skipped: [] }),
        answer: () => ({ sent: true }),
        ...options.rpc,
      },
      openUrl: options.openUrl ?? (() => true),
    },
  );
  unmounts.push(() => slot.lifecycle.unmount());
  if (options.waitFor !== false)
    await slot.findByText(
      options.waitFor ??
        (options.path?.startsWith("to-review")
          ? "Review change 701"
          : "Change 2"),
    );
  return slot;
}
const calls = (slot: Awaited<ReturnType<typeof mount>>, method: string) =>
  slot.inspection.rpcCalls
    .filter((call) => call.method === method)
    .map((call) => call.input);
function mineRow(slot: Awaited<ReturnType<typeof mount>>, title: string) {
  const item = slot.getByRole("button", { name: title }).closest("li");
  if (!item) throw new Error("Missing PR row");
  return within(item);
}
function modelInput(slot: Awaited<ReturnType<typeof mount>>, name: string) {
  const input = slot.getByLabelText(name);
  if (!(input instanceof HTMLInputElement))
    throw new Error("Missing model picker input");
  return input;
}
const acmeRow = row(20, {
  repo: "acme/app",
  key: "acme/app#20",
  url: "https://github.com/acme/app/pull/20",
});
const acmeReview = review(703, {
  item: {
    ...review(703).item,
    repo: "acme/app",
    url: "https://github.com/acme/app/pull/703",
  },
});
async function chooseOrganization(
  slot: Awaited<ReturnType<typeof mount>>,
  name: string,
) {
  const user = userEvent.setup();
  await user.click(slot.getByRole("combobox", { name: "Organization" }));
  await user.click(await slot.findByRole("option", { name }));
}

it("filters both tabs, counters, and unit bars using owners from both complete queues", async () => {
  const slot = await mount({
    board: state({ view: { ...view, prs: [row(2), acmeRow] }, markers: [] }),
    reviews: reviews([reviewA, acmeReview]),
  });
  await chooseOrganization(slot, "acme");
  expect(slot.getByRole("tab", { name: "Mine 1" })).toBeTruthy();
  expect(slot.getByRole("tab", { name: "To review 1" })).toBeTruthy();
  expect(slot.getByRole("radio", { name: "1 on you" })).toBeTruthy();
  expect(
    slot
      .getByLabelText("1 pull requests by status")
      .querySelectorAll(".calm-unit-cell"),
  ).toHaveLength(1);
  expect(slot.queryByRole("button", { name: "Change 2" })).toBeNull();
  expect(slot.getByRole("button", { name: "Change 20" })).toBeTruthy();
  fireEvent.click(slot.getByRole("tab", { name: "To review 1" }));
  expect(slot.getByRole("button", { name: "Review change 703" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Review change 701" })).toBeNull();
  expect(slot.getByRole("radio", { name: "1 on you" })).toBeTruthy();
  await chooseOrganization(slot, "All organizations");
  expect(slot.getByRole("tab", { name: "Mine 2" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Review change 701" })).toBeTruthy();
  expect(calls(slot, "board_refresh")).toEqual([]);
  expect(calls(slot, "reviews_refresh")).toEqual([]);
});
it("clears both selections when the organization changes and starts only visible bulk rows", async () => {
  const slot = await mount({
    board: state({ view: { ...view, prs: [row(2), acmeRow] }, markers: [] }),
    reviews: reviews([reviewA, acmeReview]),
  });
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Change 2 #2" }));
  expect(
    slot.getByRole("group", { name: "Start selected agents" }),
  ).toBeTruthy();
  await chooseOrganization(slot, "acme");
  expect(
    slot.queryByRole("group", { name: "Start selected agents" }),
  ).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() =>
    expect(calls(slot, "start")).toEqual([
      {
        items: [{ key: acmeRow.key, action: "fix-ci" }],
        stop: "publish",
        agentModel: DEFAULT_AGENT_MODEL,
      },
    ]),
  );
  fireEvent.click(slot.getByRole("tab", { name: /To review/ }));
  fireEvent.click(
    slot.getByRole("checkbox", { name: "Select Review change 703 #703" }),
  );
  expect(
    slot.getByRole("group", { name: "Review selected pull requests" }),
  ).toBeTruthy();
  await chooseOrganization(slot, "parsleyhealth");
  expect(
    slot.queryByRole("group", { name: "Review selected pull requests" }),
  ).toBeNull();
  fireEvent.click(
    slot.getByRole("checkbox", { name: "Select Review change 701 #701" }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Review 1" }));
  const dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
  await waitFor(() =>
    expect(calls(slot, "reviews_start")).toEqual([
      {
        key: reviewA.item.key,
        projectId: "p1",
        agentModel: DEFAULT_AGENT_MODEL,
      },
    ]),
  );
});
it("keeps the organization pinned across healthy empty queues and remounts, and validates stored preferences", async () => {
  const settings = {
    board: state({ view: { ...view, prs: [row(2), acmeRow] }, markers: [] }),
    reviews: {
      kind: "available",
      snapshot: {
        version: 1,
        items: [reviewA, acmeReview],
        lastSuccessAt: ago(3),
        lastPoll: { at: ago(1), ok: true, added: 0, total: 2 },
      },
    } satisfies ReviewsState,
  };
  const slot = await mount(settings);
  await chooseOrganization(slot, "acme");
  expect(localStorage.getItem("test-plugin:calm-organization")).toBe('"acme"');
  slot.lifecycle.unmount();
  const restored = await mount({ ...settings, waitFor: "Change 20" });
  expect(
    restored.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("acme");
  expect(restored.queryByRole("button", { name: "Change 2" })).toBeNull();
  restored.lifecycle.unmount();
  const emptySettings = {
    board: state({ view: { ...view, prs: [row(2)] }, markers: [] }),
    reviews: {
      ...settings.reviews,
      snapshot: { ...settings.reviews.snapshot, items: [reviewA] },
    },
  };
  const empty = await mount({ ...emptySettings, waitFor: false });
  await empty.findByText("acme (no pull requests)");
  expect(empty.getByRole("tab", { name: "Mine 0" })).toBeTruthy();
  expect(empty.getByRole("tab", { name: "To review 0" })).toBeTruthy();
  expect(empty.queryByRole("button", { name: "Change 2" })).toBeNull();
  expect(localStorage.getItem("test-plugin:calm-organization")).toBe('"acme"');
  empty.lifecycle.unmount();
  const pinned = await mount({ ...emptySettings, waitFor: false });
  await pinned.findByText("acme (no pull requests)");
  expect(localStorage.getItem("test-plugin:calm-organization")).toBe('"acme"');
  await chooseOrganization(pinned, "All organizations");
  expect(pinned.getByRole("tab", { name: "Mine 1" })).toBeTruthy();
  expect(pinned.getByRole("button", { name: "Change 2" })).toBeTruthy();
  pinned.lifecycle.unmount();
  localStorage.setItem("test-plugin:calm-organization", '{"invalid":true}');
  const invalid = await mount(settings);
  expect(
    invalid.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("All organizations");
});
it.each([
  {
    name: "a failed first review poll",
    board: {},
    lastSuccessAt: null,
    lastPoll: {
      at: ago(1),
      ok: false,
      added: 0,
      total: 0,
      error: "GitHub unavailable",
    },
  },
  {
    name: "a failed review refresh after success",
    board: {},
    lastSuccessAt: ago(3),
    lastPoll: {
      at: ago(1),
      ok: false,
      added: 0,
      total: 0,
      error: "GitHub unavailable",
    },
  },
  {
    name: "reviews without a completed poll",
    board: {},
    lastSuccessAt: ago(3),
    lastPoll: null,
  },
  {
    name: "a failed Mine refresh with cached rows",
    board: { lastError: "GitHub unavailable" },
    lastSuccessAt: ago(3),
    lastPoll: { at: ago(1), ok: true, added: 0, total: 0 },
  },
  {
    name: "Mine without a successful refresh",
    board: { lastSuccess: null },
    lastSuccessAt: ago(3),
    lastPoll: { at: ago(1), ok: true, added: 0, total: 0 },
  },
])(
  "preserves the saved organization through $name until you explicitly choose All",
  async ({ board, lastSuccessAt, lastPoll }) => {
    localStorage.setItem("test-plugin:calm-organization", '"acme"');
    const slot = await mount({
      board: state({ view: { ...view, prs: [row(2)] }, markers: [], ...board }),
      reviews: {
        kind: "available",
        snapshot: { version: 1, items: [], lastSuccessAt, lastPoll },
      },
      waitFor: false,
    });
    await slot.behavior.emitRealtime("board-changed", null);
    expect(localStorage.getItem("test-plugin:calm-organization")).toBe(
      '"acme"',
    );
    expect(
      slot.getByRole("combobox", { name: "Organization" }).textContent,
    ).toContain("acme (unavailable)");
    expect(slot.queryByRole("button", { name: "Change 2" })).toBeNull();
    expect(slot.getByRole("tab", { name: "Mine 0" })).toBeTruthy();
    expect(calls(slot, "start")).toEqual([]);
    await chooseOrganization(slot, "All organizations");
    expect(slot.getByRole("button", { name: "Change 2" })).toBeTruthy();
  },
);
it("keeps a saved owner during loading or partial failure and offers All when no options are available", async () => {
  localStorage.setItem("test-plugin:calm-organization", '"acme"');
  let finish = () => {};
  const pending = new Promise((resolve) => {
    finish = () =>
      resolve({ kind: "unavailable", reason: "Review Watch offline" });
  });
  const slot = await mount({
    reviews: undefined,
    rpc: { reviews_get: () => pending },
    waitFor: false,
  });
  await slot.findByRole("tab", { name: "Mine 0" });
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("acme (loading…)");
  await act(async () => finish());
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("acme (unavailable)");
  expect(localStorage.getItem("test-plugin:calm-organization")).toBe('"acme"');
  await chooseOrganization(slot, "All organizations");
  expect(slot.getByRole("button", { name: "Change 2" })).toBeTruthy();
  slot.lifecycle.unmount();
  const empty = await mount({
    board: state({ view: { ...view, prs: [] }, markers: [] }),
    reviews: reviews([]),
    waitFor: false,
  });
  await empty.findByText("Nothing needs you. No open pull requests.");
  expect(
    empty
      .getByRole("combobox", { name: "Organization" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("keeps cross-organization dependency context and follows an explicit review link into its organization once", async () => {
  const gated = row(2, {
    group: "blocked",
    action: null,
    gate_blocked: true,
    gate_links: [
      { label: "External prerequisite", cleared_by: "acme/app#703" },
    ],
  });
  const slot = await mount({
    board: state({ view: { ...view, prs: [gated, acmeRow] }, markers: [] }),
    reviews: reviews([reviewA, acmeReview]),
    rpc: { reviews_detail: () => acmeReview },
    waitFor: "Change 20",
  });
  await chooseOrganization(slot, "parsleyhealth");
  fireEvent.click(slot.getByRole("button", { name: /Blocked upstream/ }));
  fireEvent.click(slot.getByRole("button", { name: "Change 2" }));
  expect(slot.getByText(/External prerequisite/)).toBeTruthy();
  fireEvent.click(
    mineRow(slot, "Change 2").getByRole("button", { name: "Review #703 →" }),
  );
  await slot.findByRole("region", {
    name: "Review context for Review change 703",
  });
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("acme");
  fireEvent.click(slot.getByRole("button", { name: "Review change 703" }));
  await slot.behavior.emitRealtime("board-changed", null);
  expect(
    slot.queryByRole("region", {
      name: "Review context for Review change 703",
    }),
  ).toBeNull();
  await chooseOrganization(slot, "parsleyhealth");
  await slot.behavior.emitRealtime("board-changed", null);
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("parsleyhealth");
});
it("opens an explicit cross-organization URL target and lets a later filter change cancel it", async () => {
  localStorage.setItem("test-plugin:calm-organization", '"parsleyhealth"');
  const slot = await mount({
    path: "to-review/acme/app%23703",
    board: state({ view: { ...view, prs: [row(2), acmeRow] }, markers: [] }),
    reviews: reviews([reviewA, acmeReview]),
    rpc: { reviews_detail: () => acmeReview },
    waitFor: "Review change 703",
  });
  await slot.findByRole("region", {
    name: "Review context for Review change 703",
  });
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("acme");
  await chooseOrganization(slot, "parsleyhealth");
  await slot.behavior.emitRealtime("board-changed", null);
  expect(slot.queryByRole("button", { name: "Review change 703" })).toBeNull();
  expect(slot.getByRole("button", { name: "Review change 701" })).toBeTruthy();
  slot.lifecycle.rerender(<Board subPath="to-review" />);
  expect(
    slot.getByRole("combobox", { name: "Organization" }).textContent,
  ).toContain("parsleyhealth");
});

it("registers one PRs panel and partitions each real PR once despite marker overrides", async () => {
  const app = await loadPluginApp(() => import("./app"));
  expect(app.navPanels.map((panel) => [panel.title, panel.path])).toEqual([
    ["PRs", "pr-board"],
  ]);
  const prs = minePrs(view, state().markers);
  expect(prs).toHaveLength(10);
  expect(new Set(prs.map((pr) => pr.row.key)).size).toBe(10);
  expect(prs.find((pr) => pr.row.number === 10)?.segment).toBe("agent");
  expect(prs.find((pr) => pr.row.number === 9)?.segment).toBe("on-you");
  const slot = await mount();
  expect(
    slot.getByRole("tab", { name: "Mine 10" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(slot.getByRole("radio", { name: "6 on you" })).toBeTruthy();
  expect(
    slot.getByRole("heading", { name: "Answer to unblock agents" }),
  ).toBeTruthy();
  expect(calls(slot, "start")).toEqual([]);
  expect(calls(slot, "reviewers_request")).toEqual([]);
});
it("loads the actual saved agent model before enabling starts", async () => {
  let finish = () => {};
  const saved = {
    providerId: "codex",
    model: "gpt-6.1-terra",
    reasoningLevel: "high",
    serviceTier: "fast",
  };
  const pending = new Promise((resolve) => {
    finish = () => resolve(modelContext(saved));
  });
  const slot = await mount({ rpc: { agent_model_get: () => pending } });
  expect(slot.queryByLabelText("Model")).toBeNull();
  const start = slot.getByRole("button", { name: "Start 1" });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(calls(slot, "start")).toEqual([]);
  await act(async () => finish());
  expect(modelInput(slot, "Model").value).toBe(saved.model);
  expect(modelInput(slot, "Reasoning level").value).toBe("high");
  fireEvent.click(start);
  await waitFor(() =>
    expect(calls(slot, "start")).toEqual([
      {
        items: [{ key: key(2), action: "fix-ci" }],
        stop: "publish",
        agentModel: saved,
      },
    ]),
  );
});
it("defaults to Sol6.1 xhigh and remembers one chosen execution selection for fixes and reviews", async () => {
  let saved = DEFAULT_AGENT_MODEL;
  const slot = await mount({
    rpc: {
      agent_model_get: () => modelContext(saved),
      agent_model_set: (input) => (saved = agentModelSchema.parse(input)),
    },
  });
  expect(saved).toEqual({
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "xhigh",
  });
  expect(modelInput(slot, "Model").value).toBe("gpt-6.1-sol");
  fireEvent.change(slot.getByLabelText("Model"), {
    target: { value: "gpt-6.1-terra" },
  });
  fireEvent.change(slot.getByLabelText("Reasoning level"), {
    target: { value: "high" },
  });
  fireEvent.change(slot.getByLabelText("Service tier"), {
    target: { value: "fast" },
  });
  fireEvent.click(
    slot.getByRole("button", { name: "Apply execution selection" }),
  );
  await waitFor(() =>
    expect(calls(slot, "agent_model_set")).toEqual([
      {
        providerId: "codex",
        model: "gpt-6.1-terra",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
    ]),
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Start 1" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(calls(slot, "start")[0]).toMatchObject({ agentModel: saved });
  fireEvent.click(slot.getByRole("tab", { name: /To review/ }));
  fireEvent.click(
    mineRow(slot, "Review change 701").getByRole("button", { name: "Start" }),
  );
  const dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
  await waitFor(() =>
    expect(calls(slot, "reviews_start")).toEqual([
      { key: reviewA.item.key, projectId: "p1", agentModel: saved },
    ]),
  );
  slot.lifecycle.unmount();
  const restored = await mount({
    rpc: { agent_model_get: () => modelContext(saved) },
  });
  expect(modelInput(restored, "Model").value).toBe(saved.model);
});
it("routes discovery to the project checkout host and uses the confirmed default service tier", async () => {
  const confirmed = { ...DEFAULT_AGENT_MODEL, serviceTier: "standard" };
  const slot = await mount({ rpc: { agent_model_set: () => confirmed } });
  const picker = slot.getByTestId("bb-provider-model-picker");
  expect(picker.getAttribute("data-routing-kind")).toBe("host");
  expect(picker.getAttribute("data-routing-id")).toBe("prs-project-host");
  fireEvent.change(slot.getByLabelText("Service tier"), {
    target: { value: "default" },
  });
  fireEvent.click(
    slot.getByRole("button", { name: "Apply execution selection" }),
  );
  await waitFor(() =>
    expect(calls(slot, "agent_model_set")).toEqual([
      { ...DEFAULT_AGENT_MODEL, serviceTier: "default" },
    ]),
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Start 1" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() =>
    expect(calls(slot, "start")[0]).toMatchObject({ agentModel: confirmed }),
  );
});
it("retains the confirmed agent choice after save failure and blocks starts while saving", async () => {
  let fail = () => {};
  const pending = new Promise((_, reject) => {
    fail = () => reject(new Error("catalog unavailable"));
  });
  const slot = await mount({ rpc: { agent_model_set: () => pending } });
  fireEvent.change(slot.getByLabelText("Model"), {
    target: { value: "gpt-6.1-terra" },
  });
  fireEvent.click(
    slot.getByRole("button", { name: "Apply execution selection" }),
  );
  expect(
    slot.getByRole("button", { name: "Start 1" }).hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => fail());
  await slot.findByText("Could not save the agent model: catalog unavailable");
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() =>
    expect(calls(slot, "start")[0]).toMatchObject({
      agentModel: DEFAULT_AGENT_MODEL,
    }),
  );
});
it("presents absent reasoning without inventing an effort in saved choices or starts", async () => {
  const choice = {
    providerId: "synthetic-provider",
    model: "synthetic-no-effort",
  };
  const slot = await mount({
    rpc: { agent_model_get: () => modelContext(choice) },
  });
  expect(modelInput(slot, "Reasoning level").value).toBe("");
  fireEvent.click(
    slot.getByRole("button", { name: "Apply execution selection" }),
  );
  await waitFor(() => expect(calls(slot, "agent_model_set")).toEqual([choice]));
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Start 1" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() =>
    expect(calls(slot, "start")[0]).toMatchObject({ agentModel: choice }),
  );
});
it("retries a failed preference load and refuses an older response after another panel changes it", async () => {
  let reads = 0;
  let finishOld = () => {};
  const old = new Promise((resolve) => {
    finishOld = () => resolve(modelContext(DEFAULT_AGENT_MODEL));
  });
  const current = { ...DEFAULT_AGENT_MODEL, model: "gpt-6.1-terra" };
  const slot = await mount({
    rpc: {
      agent_model_get: () => {
        reads++;
        if (reads === 1) throw new Error("settings unavailable");
        return reads === 2 ? old : modelContext(current);
      },
    },
  });
  await slot.findByText("Could not load the agent model: settings unavailable");
  expect(
    slot.getByRole("button", { name: "Start 1" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.behavior.emitRealtime("agent-model-changed", {});
  await slot.findByLabelText("Model");
  expect(modelInput(slot, "Model").value).toBe(current.model);
  await act(async () => finishOld());
  expect(modelInput(slot, "Model").value).toBe(current.model);
  fireEvent.click(slot.getByRole("button", { name: "Start 1" }));
  await waitFor(() =>
    expect(calls(slot, "start")[0]).toMatchObject({ agentModel: current }),
  );
});
it("uses one tab stop and links each keyboard-selected tab to its panel", async () => {
  const slot = await mount();
  const user = userEvent.setup();
  const tabs = within(slot.getByRole("tablist", { name: "Pull request view" }));
  const mine = tabs.getByRole("tab", { name: /Mine/ });
  const review = tabs.getByRole("tab", { name: /To review/ });
  expect(mine.tabIndex).toBe(0);
  expect(review.tabIndex).toBe(-1);
  mine.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(review);
  expect(review.getAttribute("aria-selected")).toBe("true");
  const panel = slot.getByRole("tabpanel", { name: /To review/ });
  expect(review.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(review.id);
  expect(mine.tabIndex).toBe(-1);
  expect(review.tabIndex).toBe(0);
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(mine);
  expect(
    slot.getByRole("heading", { name: "Small fixes for an agent" }),
  ).toBeTruthy();
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(review);
  expect(calls(slot, "start")).toEqual([]);
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "pr-board",
    options: { subPath: "to-review" },
  });
});
it("shares the status value between arrow navigation and bar shortcuts while skipping empty statuses", async () => {
  const slot = await mount({
    board: state({
      view: {
        ...view,
        prs: [
          row(2),
          row(6, { segment: "drafts", group: null, action: null }),
          row(7, { segment: "ready", group: null, action: null }),
        ],
      },
      markers: [],
    }),
  });
  const user = userEvent.setup();
  const filters = within(
    slot.getByRole("radiogroup", { name: "Pull request status" }),
  );
  const mine = filters.getByRole("radio", { name: "1 on you" });
  const draft = filters.getByRole("radio", { name: "1 drafts" });
  expect(
    filters
      .getAllByRole("radio")
      .filter((item) => item.tabIndex === 0 && !item.hasAttribute("disabled")),
  ).toEqual([mine]);
  expect(
    filters
      .getByRole("radio", { name: "0 agent" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  mine.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(draft);
  expect(draft.getAttribute("aria-checked")).toBe("true");
  expect(slot.getByRole("heading", { name: "Drafts" })).toBeTruthy();
  expect(
    slot
      .getByRole("button", { name: "Show 1 drafts" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Show 1 on you" }));
  expect(mine.getAttribute("aria-checked")).toBe("true");
  expect(draft.tabIndex).toBe(-1);
  draft.focus();
  await user.keyboard(" ");
  expect(draft.getAttribute("aria-checked")).toBe("true");
});
it("connects effort, row, and reviewer disclosures to their panels and preserves keyboard focus", async () => {
  const slot = await mount();
  const user = userEvent.setup();
  const fold = slot.getByRole("button", { name: /Large fixes/ });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  fold.focus();
  await user.keyboard(" ");
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(
    document
      .getElementById(fold.getAttribute("aria-controls") ?? "")
      ?.contains(slot.getByRole("button", { name: "Change 3" })),
  ).toBe(true);
  const title = slot.getByRole("button", { name: "Change 3" });
  title.focus();
  await user.keyboard("{Enter}");
  const context = slot.getByRole("region", { name: "Context for Change 3" });
  expect(
    document
      .getElementById(title.getAttribute("aria-controls") ?? "")
      ?.contains(context),
  ).toBe(true);
  await user.keyboard(" ");
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(
    slot.queryByRole("region", { name: "Context for Change 3" }),
  ).toBeNull();
  expect(document.activeElement).toBe(title);
  fireEvent.click(slot.getByRole("radio", { name: "1 on reviewers" }));
  const person = slot.getByRole("button", { name: /Dev One/ });
  person.focus();
  await user.keyboard(" ");
  expect(person.getAttribute("aria-expanded")).toBe("true");
  expect(
    document
      .getElementById(person.getAttribute("aria-controls") ?? "")
      ?.contains(slot.getByRole("button", { name: "Change 5" })),
  ).toBe(true);
});
it("keeps keyboard-selected PRs after a failure and removes only successful starts", async () => {
  let fail = true;
  const slot = await mount({
    rpc: {
      start: () => {
        if (fail) throw new Error("start unavailable");
        return {
          starting: [key(2)],
          skipped: [{ key: key(3), reason: "already starting" }],
        };
      },
    },
  });
  const user = userEvent.setup();
  fireEvent.click(slot.getByRole("button", { name: /Large fixes/ }));
  const small = slot.getByRole("checkbox", { name: "Select Change 2 #2" });
  const large = slot.getByRole("checkbox", { name: "Select Change 3 #3" });
  for (const checkbox of [small, large]) {
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  }
  let selection = within(
    slot.getByRole("group", { name: "Start selected agents" }),
  );
  fireEvent.click(selection.getByRole("button", { name: "Start 2" }));
  await slot.findByText("Could not start: start unavailable");
  expect(small.getAttribute("aria-checked")).toBe("true");
  expect(large.getAttribute("aria-checked")).toBe("true");
  await user.click(slot.getByRole("tab", { name: /To review/ }));
  await user.click(slot.getByRole("tab", { name: /Mine/ }));
  expect(
    slot
      .getByRole("checkbox", { name: "Select Change 2 #2" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fail = false;
  selection = within(
    slot.getByRole("group", { name: "Start selected agents" }),
  );
  fireEvent.click(selection.getByRole("button", { name: "Start 2" }));
  await slot.findByText(/1 PR queued for one thread/);
  expect(
    slot
      .getByRole("checkbox", { name: "Select Change 2 #2" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    slot
      .getByRole("checkbox", { name: "Select Change 3 #3" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});
it("selects each review with Space and clears the same controlled group", async () => {
  const slot = await mount({ path: "to-review" });
  const user = userEvent.setup();
  for (const checkbox of slot.getAllByRole("checkbox")) {
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  }
  expect(slot.getByRole("button", { name: "Review 2" })).toBeTruthy();
  await user.click(slot.getByRole("button", { name: "Clear" }));
  for (const checkbox of slot.getAllByRole("checkbox"))
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  expect(
    slot.queryByRole("group", { name: "Review selected pull requests" }),
  ).toBeNull();
  expect(calls(slot, "reviews_batch")).toEqual([]);
});
it("names the migrated components and exposes status changes through the SDK API", async () => {
  const slot = await mount();
  const components = uiAgent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more");
  for (const entry of components)
    expect(
      entry.label,
      `${entry.component} ${entry.ref} has no name`,
    ).toBeTruthy();
  const labels = components.map((entry) => entry.label);
  for (const label of [
    "Pull request view",
    "Pull request status",
    "Select pull requests for agents",
  ])
    expect(labels).toContain(label);
  const result = await act(() =>
    uiAgent.act({
      steps: [
        { ref: "Pull request status", action: "setValue", args: ["drafts"] },
      ],
    }),
  );
  expect(result.ok, result.error?.message).toBe(true);
  expect(slot.getByRole("heading", { name: "Drafts" })).toBeTruthy();
  expect(
    slot.getByRole("radio", { name: "1 drafts" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(calls(slot, "start")).toEqual([]);
});
it("traps dialog keyboard focus and refuses dismissal until a review start settles", async () => {
  let finish = () => {};
  const pending = new Promise((resolve) => {
    finish = () =>
      resolve({
        item: { ...reviewA.item, state: "started", threadId: "thr_review" },
      });
  });
  const slot = await mount({
    path: "to-review",
    rpc: { reviews_start: () => pending },
  });
  const user = userEvent.setup();
  fireEvent.click(
    mineRow(slot, "Review change 701").getByRole("button", { name: "Start" }),
  );
  const dialog = within(
    await slot.findByRole("dialog", { name: "Start review" }),
  );
  await dialog.findByText("Preselected from your organization mappings.");
  const start = dialog.getByRole("button", { name: "Start review" });
  start.focus();
  await user.tab();
  expect(document.activeElement).toBe(
    dialog.getByRole("combobox", { name: "Project" }),
  );
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(start);
  await user.click(start);
  expect(
    dialog.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.keyboard("{Escape}");
  await user.click(document.body);
  expect(slot.getByRole("dialog", { name: "Start review" })).toBeTruthy();
  await act(async () => finish());
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_review",
  });
});
it("sizes dots logarithmically and bounds zero and large diffs", () => {
  expect(sizeDiameter(10)).toBe(6);
  expect(sizeDiameter(1000)).toBeCloseTo(16.67, 1);
  expect(sizeDiameter(0)).toBe(6);
  expect(sizeDiameter(20000)).toBe(22);
});
it("uses native badge dots with count thresholds, exact counts, and urgent reasons", () => {
  const badge = (count: number, agentsAsking = 0, overdueReviews = 0) =>
    prsBadge({ onYou: count, toReview: 0, agentsAsking, overdueReviews });
  expect(badge(0)).toBeNull();
  expect(badge(1)).toEqual({
    tone: "neutral",
    label: "Across all organizations · 1 on you · 0 to review",
  });
  expect(badge(4)?.tone).toBe("neutral");
  expect(badge(5)?.tone).toBe("warning");
  expect(badge(14)?.tone).toBe("warning");
  expect(badge(15)).toEqual({
    tone: "critical",
    label:
      "Across all organizations · 15 on you · 0 to review · high pending count",
  });
  expect(badge(1, 1)?.label).toContain("1 agent waiting");
  expect(badge(1, 0, 1)?.tone).toBe("critical");
  expect(badge(1, 0, 1)?.label).toContain("queued 2+ days");
  expect(badge(15)).not.toHaveProperty("count");
  expect(badge(15)).not.toHaveProperty("text");
});
it("hides Later groups, remembers their folds, and offers no gate or manual agent actions", async () => {
  const slot = await mount();
  expect(slot.queryByRole("button", { name: "Change 3" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Large fixes/ }));
  expect(
    mineRow(slot, "Change 3").getByRole("button", { name: /Prepare agent/ }),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /Blocked upstream/ }));
  expect(mineRow(slot, "Change 4").queryByRole("checkbox")).toBeNull();
  expect(
    mineRow(slot, "Change 4").queryByRole("button", { name: /agent for/ }),
  ).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Needs a manual look/ }));
  expect(mineRow(slot, "Change 8").queryByRole("checkbox")).toBeNull();
  slot.lifecycle.unmount();
  const again = await mount();
  expect(again.getByRole("button", { name: "Change 3" })).toBeTruthy();
});
it("small group starts at Publish, large group at Prepare, and exposes actual skipped rows", async () => {
  const slot = await mount({
    rpc: {
      start: () => ({
        starting: [key(2)],
        skipped: [{ key: key(3), reason: "already running" }],
      }),
    },
  });
  fireEvent.click(
    within(
      slot.getByRole("region", { name: "Small fixes for an agent" }),
    ).getByRole("button", { name: "Start 1" }),
  );
  await slot.findByText(/1 PR queued for one thread.*already running/);
  expect(calls(slot, "start")[0]).toEqual({
    items: [{ key: key(2), action: "fix-ci" }],
    stop: "publish",
    agentModel: DEFAULT_AGENT_MODEL,
  });
  fireEvent.click(slot.getByRole("button", { name: "Prepare 1" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(2));
  expect(calls(slot, "start")[1]).toEqual({
    items: [{ key: key(3), action: "rebase" }],
    stop: "prepare",
    agentModel: DEFAULT_AGENT_MODEL,
  });
});
it("sends mixed selected actions with the explicit stop policy and no confirmation dialog", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("button", { name: /Large fixes/ }));
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Change 2 #2" }));
  let bar = within(slot.getByRole("group", { name: "Start selected agents" }));
  expect(bar.getByRole("combobox").getAttribute("aria-label")).toBe("Stop at");
  expect((bar.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "publish",
  );
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Change 3 #3" }));
  bar = within(slot.getByRole("group", { name: "Start selected agents" }));
  expect((bar.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "prepare",
  );
  fireEvent.change(bar.getByRole("combobox"), { target: { value: "publish" } });
  fireEvent.click(bar.getByRole("button", { name: "Start 2" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(calls(slot, "start")[0]).toEqual({
    items: [
      { key: key(2), action: "fix-ci" },
      { key: key(3), action: "rebase" },
    ],
    stop: "publish",
    agentModel: DEFAULT_AGENT_MODEL,
  });
  expect(slot.queryByRole("dialog")).toBeNull();
});
it("queues all selected rows for one coordinator thread", async () => {
  const many = Array.from({ length: 6 }, (_, index) => row(index + 20));
  const slot = await mount({
    board: state({ view: { ...view, prs: [row(2), ...many] }, markers: [] }),
    rpc: {
      start: () => ({
        starting: [row(2), ...many].map((pr) => pr.key),
        skipped: [],
      }),
    },
  });
  for (const candidate of [row(2), ...many])
    fireEvent.click(
      slot.getByRole("checkbox", {
        name: `Select ${candidate.title} #${candidate.number}`,
      }),
    );
  fireEvent.click(
    within(
      slot.getByRole("group", { name: "Start selected agents" }),
    ).getByRole("button", { name: "Start 7" }),
  );
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(
    z.object({ items: z.array(z.unknown()) }).parse(calls(slot, "start")[0])
      .items,
  ).toHaveLength(7);
  await slot.findByText("7 PRs queued for one thread.");
});
it("renders one shared question across all row contexts and keeps followers linked to its coordinator", async () => {
  const sharedRows = [
    row(2),
    row(3, { group: "large" }),
    row(4, { group: "blocked", gate_blocked: true }),
    acmeRow,
  ];
  const sharedMarkers = sharedRows.map((pr) => ({
    ...marker(pr.number, {
      status: "asking",
      question,
      threadId: "thr_coordinator",
    }),
    key: pr.key,
  }));
  let current = state({
    view: { ...view, prs: [...sharedRows, row(10)] },
    markers: [...sharedMarkers, marker(10)],
  });
  const slot = await mount({
    rpc: {
      board_get: () => current,
      answer: () => {
        current = {
          ...current,
          markers: [
            ...sharedMarkers.map<MarkerView>((item) => ({
              ...item,
              status: "live",
              question: null,
            })),
            marker(10),
          ],
        };
        return { sent: true };
      },
    },
    waitFor: question.prompt,
  });
  expect(
    slot.getAllByRole("button", { name: "Use synthetic fixture" }),
  ).toHaveLength(1);
  expect(slot.getByText("4 linked PRs · agent thread")).toBeTruthy();
  expect(slot.getAllByText("Waiting on shared agent question")).toHaveLength(3);
  expect(slot.queryByRole("heading", { name: "Large fixes" })).toBeNull();
  expect(slot.queryByRole("heading", { name: "Blocked upstream" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Change 3" }));
  expect(
    slot.getAllByRole("button", { name: "Use synthetic fixture" }),
  ).toHaveLength(1);
  fireEvent.click(
    mineRow(slot, "Change 3").getByRole("button", { name: "Open thread" }),
  );
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_coordinator",
  });
  fireEvent.click(slot.getByRole("radio", { name: "1 agent" }));
  expect(
    slot.getAllByRole("button", { name: "Use synthetic fixture" }),
  ).toHaveLength(1);
  expect(slot.getByText("4 linked PRs · agent thread")).toBeTruthy();
  await chooseOrganization(slot, "parsleyhealth");
  expect(slot.getByText("4 PRs in shared thread · 3 shown")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Change 20" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Use synthetic fixture" }));
  await waitFor(() => expect(slot.queryByText(question.prompt)).toBeNull());
  expect(calls(slot, "answer")).toEqual([
    { key: key(2), questionId: question.id, optionId: "a" },
  ]);
  await chooseOrganization(slot, "All organizations");
  expect(slot.getByRole("radio", { name: "5 agent" })).toBeTruthy();
  expect(
    slot.queryByRole("button", { name: "Use synthetic fixture" }),
  ).toBeNull();
});
it("counts shared questions once in the global badge while retaining per-PR counts", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const useBadge = app.navPanels[0]?.experimental_useBadge;
  if (!useBadge) throw new Error("Missing PRs badge");
  const asking = [2, 3, 4].map((number) =>
    marker(number, { status: "asking", question, threadId: "thr_shared" }),
  );
  const slot = renderSlot(
    { component: () => <span>{useBadge()?.label}</span> },
    {},
    {
      rpc: {
        board_get: () =>
          state({
            view: { ...view, prs: [row(2), row(3), row(4)] },
            markers: asking,
          }),
        reviews_get: () => reviews([]),
      },
    },
  );
  unmounts.push(() => slot.lifecycle.unmount());
  await slot.findByText(
    "Across all organizations · 3 on you · 0 to review · 1 agent waiting",
  );
});
it("expands one context with actual check counts and keeps historical approval wording", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("button", { name: "Change 2" }));
  expect(slot.getByText("1 of 2 failing")).toBeTruthy();
  expect(slot.getAllByLabelText(/build: fail|test: pass/)).toHaveLength(2);
  fireEvent.click(slot.getByRole("button", { name: "Change 7" }));
  expect(
    slot.queryByRole("region", { name: "Context for Change 2" }),
  ).toBeNull();
  expect(slot.getByText(/approval still counts/)).toBeTruthy();
  fireEvent.click(slot.getByRole("link", { name: "Open PR" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "openUrl",
    url: url(7),
  });
});
it("keeps a failed answer visible and makes an ambiguous delivery claim non-replayable", async () => {
  const slot = await mount({
    rpc: {
      answer: () => {
        throw new Error("follow-up unavailable");
      },
    },
  });
  fireEvent.click(slot.getByRole("button", { name: "Use synthetic fixture" }));
  await slot.findByText(/Answer not confirmed: follow-up unavailable/);
  expect(slot.getByText(question.prompt)).toBeTruthy();
  slot.lifecycle.unmount();
  const ambiguous = await mount({
    board: state({
      markers: [
        marker(9, {
          status: "asking",
          question,
          answering: true,
          answerError: "Delivery is uncertain. Check the thread.",
        }),
      ],
    }),
  });
  expect(
    ambiguous.getByText("Delivery is uncertain. Check the thread."),
  ).toBeTruthy();
  expect(
    ambiguous
      .getByRole("button", { name: "Use synthetic fixture" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("never invents asking status for old finished threads and opens live agents", async () => {
  const slot = await mount({
    board: state({ markers: [marker(10), marker(9, { status: "done" })] }),
  });
  expect(slot.queryByText(question.prompt)).toBeNull();
  fireEvent.click(slot.getByRole("radio", { name: "1 agent" }));
  fireEvent.click(
    within(slot.getByRole("region", { name: "Working" })).getByRole("button", {
      name: "Open conversation →",
    }),
  );
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_10");
  fireEvent.click(slot.getByRole("button", { name: "Open in full thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_10",
  });
  expect(
    slot.getByRole("heading", { name: "PRs with finished threads" }),
  ).toBeTruthy();
});
it("loads actual reviewer candidates and writes only after the explicit Send click", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("button", { name: "Send all" }));
  const dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("dev-two");
  expect(calls(slot, "reviewers_request")).toHaveLength(0);
  fireEvent.click(dialog.getByRole("checkbox", { name: /dev-two/ }));
  fireEvent.click(dialog.getByRole("button", { name: "Send 1" }));
  await dialog.findByText("1 review request sent.");
  expect(calls(slot, "reviewers_request")).toEqual([
    { requests: [{ key: key(1), reviewers: ["dev-one", "dev-two"] }] },
  ]);
});
it("keeps last successful Mine data after refresh failure and marks old timestamps", async () => {
  const slot = await mount({
    board: state({ lastSuccess: ago(20) }),
    rpc: {
      board_refresh: () => {
        throw new Error("GitHub unavailable");
      },
    },
  });
  expect(slot.container.querySelector("time")?.className).toContain(
    "text-amber",
  );
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await slot.findByText(/Last refresh failed: GitHub unavailable/);
  expect(slot.getByText("Change 2")).toBeTruthy();
});
it("navigates from a configured gate to the matching review context", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("button", { name: /Blocked upstream/ }));
  fireEvent.click(
    mineRow(slot, "Change 4").getByRole("button", { name: "Review #701 →" }),
  );
  await slot.findByRole("region", {
    name: "Review context for Review change 701",
  });
  expect(slot.getByText("♧ Unblocks your #4")).toBeTruthy();
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      path: "pr-board",
      options: { subPath: `to-review/${repo}#701` },
    }),
  );
});
it("keeps Mine available when Review Watch is unavailable", async () => {
  const slot = await mount({
    reviews: { kind: "unavailable", reason: "Review Watch disabled" },
  });
  expect(slot.getByText("Change 2")).toBeTruthy();
  fireEvent.click(slot.getByRole("tab", { name: "To review 0" }));
  await slot.findByText("To review is unavailable: Review Watch disabled");
});
it("advances Open in order through quick reads without starting a thread", async () => {
  const slot = await mount({ path: "to-review" });
  fireEvent.click(slot.getByRole("button", { name: "Open in order" }));
  await slot.findByRole("region", {
    name: "Review context for Review change 701",
  });
  fireEvent.click(slot.getByRole("button", { name: "Open in order" }));
  await slot.findByRole("region", {
    name: "Review context for Review change 702",
  });
  expect(calls(slot, "reviews_start")).toEqual([]);
});
it("preselects organization project, cancels without starting, then forwards a chosen single project", async () => {
  const slot = await mount({ path: "to-review" });
  fireEvent.click(
    mineRow(slot, "Review change 701").getByRole("button", { name: "Start" }),
  );
  let dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  expect((dialog.getByRole("combobox") as HTMLSelectElement).value).toBe("p1");
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(calls(slot, "reviews_start")).toEqual([]);
  fireEvent.click(
    mineRow(slot, "Review change 701").getByRole("button", { name: "Start" }),
  );
  dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  fireEvent.change(dialog.getByRole("combobox"), { target: { value: "p2" } });
  fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
  await waitFor(() =>
    expect(calls(slot, "reviews_start")).toEqual([
      {
        key: reviewA.item.key,
        projectId: "p2",
        agentModel: DEFAULT_AGENT_MODEL,
      },
    ]),
  );
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_review",
  });
});
it("requires a mixed-batch project choice and preserves selection after failed start", async () => {
  const slot = await mount({
    path: "to-review",
    rpc: {
      reviews_targets: () => ({
        projectId: null,
        reason: "mixed",
        projects: [{ id: "p2", name: "Project two" }],
      }),
      reviews_batch: () => {
        throw new Error("spawn failed");
      },
    },
  });
  fireEvent.click(
    slot.getByRole("checkbox", { name: "Select Review change 701 #701" }),
  );
  fireEvent.click(
    slot.getByRole("checkbox", { name: "Select Review change 702 #702" }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Review 2" }));
  const dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText(
    "These PRs map to different projects. Choose one for this batch.",
  );
  expect(
    dialog
      .getByRole("button", { name: "Start review" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(dialog.getByRole("combobox"), { target: { value: "p2" } });
  fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
  await dialog.findByText("spawn failed");
  expect(calls(slot, "reviews_batch")).toEqual([
    {
      keys: [reviewA.item.key, reviewB.item.key],
      projectId: "p2",
      agentModel: DEFAULT_AGENT_MODEL,
    },
  ]);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(slot.getByText("2 selected")).toBeTruthy();
});
it("shows real delta files and resolution while unknown follow-up size stays explicit", async () => {
  const changed = review(701, {
    item: { ...reviewA.item, rule: "review-followup" },
    delta: {
      kind: "known",
      baseSha: "base",
      headSha: "head",
      additions: 14,
      deletions: 2,
      files: [{ path: "src/change.ts", additions: 14, deletions: 2 }],
    },
    lastReview: {
      state: "CHANGES_REQUESTED",
      submittedAt: ago(1440),
      commitSha: "base",
    },
    resolution: { kind: "known", resolved: 2, unresolved: 1 },
  });
  const unknown = review(702, {
    item: { ...reviewB.item, rule: "review-followup" },
    delta: { kind: "unknown", reason: "No baseline commit" },
  });
  const slot = await mount({
    path: "to-review",
    reviews: reviews([changed, unknown]),
    rpc: { reviews_detail: () => changed },
  });
  fireEvent.click(slot.getByRole("button", { name: "Review change 701" }));
  await slot.findByText("src/change.ts");
  expect(slot.getByText("+14 −2 since your review")).toBeTruthy();
  expect(
    slot.getByText("2 resolved · 1 unresolved review threads"),
  ).toBeTruthy();
  expect(
    slot.getByRole("link", { name: "Delta only" }).getAttribute("href"),
  ).toBe(`https://github.com/${repo}/compare/base...head`);
  expect(slot.getByText("Delta unknown")).toBeTruthy();
});
it("keeps stopped legacy review threads distinct from draft-ready evidence and dismisses explicitly", async () => {
  const stopped = review(701, {
    item: { ...reviewA.item, state: "started", threadId: "thr_old" },
    agentState: "stopped",
    evidence: "Stopped without draft evidence",
  });
  const slot = await mount({
    path: "to-review",
    reviews: reviews([stopped, reviewB]),
  });
  expect(slot.queryByText("draft ready")).toBeNull();
  expect(calls(slot, "reviews_dismiss")).toEqual([]);
  fireEvent.click(
    slot.getByRole("button", { name: "Dismiss Review change 702 #702" }),
  );
  await waitFor(() =>
    expect(calls(slot, "reviews_dismiss")).toEqual([{ key: reviewB.item.key }]),
  );
});

it("uses proportional segments when narrow panels cannot fit every minimum-width cell", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 304, 22),
  );
  const many = Array.from({ length: 90 }, (_, index) => row(index + 20));
  const slot = await mount({
    board: state({ view: { ...view, prs: [row(2), ...many] }, markers: [] }),
  });
  expect(
    slot
      .getByLabelText("91 pull requests by status")
      .classList.contains("proportional"),
  ).toBe(true);
  expect(slot.getByRole("radio", { name: "91 on you" })).toBeTruthy();
  expect(
    slot
      .getByLabelText("91 pull requests by status")
      .querySelectorAll(".calm-unit-cell"),
  ).toHaveLength(1);
});

it("removes a question after confirmed answer delivery and retains approximate reviewer age", async () => {
  let current = state();
  const slot = await mount({
    rpc: {
      board_get: () => current,
      answer: () => {
        current = state({ markers: [marker(9), marker(10)] });
        return { sent: true };
      },
    },
  });
  fireEvent.click(slot.getByRole("button", { name: "Use synthetic fixture" }));
  await waitFor(() => expect(slot.queryByText(question.prompt)).toBeNull());
  expect(calls(slot, "answer")).toEqual([
    { key: key(9), questionId: "next", optionId: "a" },
  ]);
  fireEvent.click(slot.getByRole("radio", { name: "1 on reviewers" }));
  expect(slot.getByText("oldest ~4d")).toBeTruthy();
});

it("starts fresh candidates after completed Prepare rows and keeps finished threads accessible", async () => {
  const done = Array.from({ length: 5 }, (_, index) =>
    row(index + 60, { group: "large", pushed_at: ago(1000) }),
  );
  const fresh = Array.from({ length: 7 }, (_, index) =>
    row(index + 70, { group: "large" }),
  );
  const slot = await mount({
    board: state({
      view: { ...view, prs: [row(2), ...done, ...fresh] },
      markers: done.map((pr) => marker(pr.number, { status: "done" })),
    }),
  });
  fireEvent.click(slot.getByRole("button", { name: /Large fixes/ }));
  const completed = mineRow(slot, "Change 60");
  expect(completed.queryByRole("checkbox")).toBeNull();
  expect(completed.queryByRole("button", { name: /agent for/ })).toBeNull();
  fireEvent.click(completed.getByRole("button", { name: "Change 60" }));
  expect(completed.queryByRole("button", { name: "Prepare fix" })).toBeNull();
  fireEvent.click(completed.getByRole("button", { name: "Open conversation" }));
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_60");
  fireEvent.click(slot.getByRole("button", { name: "Open in full thread" }));
  fireEvent.click(slot.getByRole("button", { name: "Close conversation" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_60",
  });
  fireEvent.click(slot.getByRole("button", { name: "Prepare 7" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(calls(slot, "start")[0]).toEqual({
    items: fresh.map((pr) => ({ key: pr.key, action: "fix-ci" })),
    stop: "prepare",
    agentModel: DEFAULT_AGENT_MODEL,
  });
});
it("drops an existing selection when a non-refused marker arrives", async () => {
  let current = state({ markers: [] });
  const slot = await mount({ rpc: { board_get: () => current } });
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Change 2 #2" }));
  expect(
    slot.getByRole("group", { name: "Start selected agents" }),
  ).toBeTruthy();
  current = state({ markers: [marker(2, { status: "done" })] });
  await slot.behavior.emitRealtime("board-changed", null);
  await waitFor(() =>
    expect(
      slot.queryByRole("group", { name: "Start selected agents" }),
    ).toBeNull(),
  );
  expect(mineRow(slot, "Change 2").queryByRole("checkbox")).toBeNull();
});
it("applies a review deep link once so polls respect a closed context", async () => {
  const slot = await mount({ path: `to-review/${repo}%23701` });
  await slot.findByRole("region", {
    name: "Review context for Review change 701",
  });
  fireEvent.click(slot.getByRole("button", { name: "Review change 701" }));
  expect(
    slot.queryByRole("region", {
      name: "Review context for Review change 701",
    }),
  ).toBeNull();
  await slot.behavior.emitRealtime("board-changed", null);
  await waitFor(() => expect(calls(slot, "reviews_get")).toHaveLength(2));
  expect(
    slot.queryByRole("region", {
      name: "Review context for Review change 701",
    }),
  ).toBeNull();
  slot.lifecycle.rerender(<Board subPath="to-review" />);
  slot.lifecycle.rerender(<Board subPath={`to-review/${repo}%23701`} />);
  await slot.findByRole("region", {
    name: "Review context for Review change 701",
  });
});
it("clears an unavailable deep-link target when navigating to the review root", async () => {
  const slot = await mount({ path: `to-review/${repo}%23999` });
  await slot.findByText(`${repo}#999 is not in your review queue.`);
  slot.lifecycle.rerender(<Board subPath="to-review" />);
  await waitFor(() =>
    expect(
      slot.queryByText(`${repo}#999 is not in your review queue.`),
    ).toBeNull(),
  );
});
it("dismisses drafted reviews and author history explicitly, retaining rows after a failed dismiss", async () => {
  const drafted = review(701, {
    item: { ...reviewA.item, state: "started", threadId: "thr_draft" },
    agentState: "draft-ready",
  });
  const author = review(703, {
    item: { ...review(703).item, state: "archived" },
    segment: "with-authors",
    evidence: "Reviewed this head; no later author push",
  });
  let currentItems = [drafted, author, reviewB];
  let failAuthor = true;
  const slot = await mount({
    path: "to-review",
    rpc: {
      reviews_get: () => reviews(currentItems),
      reviews_dismiss: (input) => {
        const { key: dismissed } = z.object({ key: z.string() }).parse(input);
        const entry = currentItems.find(
          (candidate) => candidate.item.key === dismissed,
        );
        if (!entry) throw new Error("Missing item");
        if (dismissed === author.item.key && failAuthor)
          throw new Error("Dismiss unavailable");
        currentItems = currentItems.filter(
          (candidate) => candidate.item.key !== dismissed,
        );
        return { item: { ...entry.item, state: "dismissed" } };
      },
    },
  });
  expect(calls(slot, "reviews_dismiss")).toEqual([]);
  fireEvent.click(
    slot.getByRole("button", { name: "Dismiss Review change 701 #701" }),
  );
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: "Review change 701" }),
    ).toBeNull(),
  );
  fireEvent.click(slot.getByRole("button", { name: /Back with authors/ }));
  fireEvent.click(
    slot.getByRole("button", { name: "Dismiss Review change 703 #703" }),
  );
  await slot.findByText("Dismiss unavailable");
  expect(slot.getByRole("button", { name: "Review change 703" })).toBeTruthy();
  expect(calls(slot, "reviews_dismiss")).toEqual([
    { key: drafted.item.key },
    { key: author.item.key },
  ]);
  failAuthor = false;
  fireEvent.click(
    slot.getByRole("button", { name: "Dismiss Review change 703 #703" }),
  );
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: "Review change 703" }),
    ).toBeNull(),
  );
});

it.each(["Cancel", "Escape"])(
  "returns dialog focus to Draft first after %s",
  async (close) => {
    const long = review(701, {
      total: { kind: "known", additions: 500, deletions: 20, files: 8 },
    });
    const slot = await mount({ path: "to-review", reviews: reviews([long]) });
    const opener = slot.getByRole("button", { name: "Draft first" });
    Object.defineProperty(opener, "checkVisibility", { value: () => true });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await slot.findByRole("dialog");
    await within(dialog).findByText(
      "Preselected from your organization mappings.",
    );
    if (close === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  },
);
it("does not restore dialog focus to a hidden opener or after successful review navigation", async () => {
  const long = review(701, {
    total: { kind: "known", additions: 500, deletions: 20, files: 8 },
  });
  const slot = await mount({ path: "to-review", reviews: reviews([long]) });
  const opener = slot.getByRole("button", { name: "Draft first" });
  let visible = false;
  Object.defineProperty(opener, "checkVisibility", { value: () => visible });
  opener.focus();
  fireEvent.click(opener);
  let dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).not.toBe(opener);
  visible = true;
  opener.focus();
  fireEvent.click(opener);
  dialog = within(await slot.findByRole("dialog"));
  await dialog.findByText("Preselected from your organization mappings.");
  fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).not.toBe(opener);
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_review",
  });
});


it("shows marker reports and pending input, opens a filtered shared roster, and restores focus on close", async () => {
  const members = [row(2), acmeRow];
  const markers = members.map((pr) => ({ ...marker(pr.number, { status: "done", threadId: "thr_shared" }), key: pr.key }));
  markers[0] = { ...markers[0], report: { kind: "progress", summary: "Reading the failing check", receivedAt: ago(1) } };
  const slot = await mount({ board: state({ view: { ...view, prs: members }, markers, needsInput: { thr_shared: true } }) });
  await chooseOrganization(slot, "parsleyhealth");
  const item = mineRow(slot, "Change 2");
  expect(item.getByText("Agent needs your input")).toBeTruthy();
  expect(item.getByText("Reading the failing check")).toBeTruthy();
  expect(item.queryByRole("button", { name: /agent for/ })).toBeNull();
  const opener = item.getByRole("button", { name: "Open conversation →" });
  opener.focus();
  fireEvent.click(opener);
  const panel = slot.getByRole("complementary", { name: "Agent conversation" });
  expect(panel.hasAttribute("data-agent-hidden")).toBe(true);
  expect(panel.closest("[data-prs-agent-panel]")).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(within(panel).getByRole("heading"));
  const chat = within(panel).getByTestId("bb-thread-chat");
  expect(chat.getAttribute("data-thread-id")).toBe("thr_shared");
  expect(chat.getAttribute("data-variant")).toBe("compact");
  expect(chat.getAttribute("data-layout")).toBe("contained");
  expect(chat.getAttribute("data-permission-policy")).toBe("inherit");
  fireEvent.click(within(panel).getByRole("button", { name: "2 PRs in shared conversation · 1 shown" }));
  expect(within(panel).getByRole("link", { name: "acme/app #20 · Change 20" })).toBeTruthy();
  fireEvent.keyDown(chat, { key: "Escape" });
  expect(slot.getByRole("complementary")).toBe(panel);
  fireEvent.keyDown(within(panel).getByRole("heading"), { key: "Escape" });
  expect(slot.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(opener);
  await chooseOrganization(slot, "All organizations");
  fireEvent.click(mineRow(slot, "Change 20").getByRole("button", { name: "Open conversation →" }));
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_shared");
  fireEvent.click(slot.getByRole("button", { name: "Open in full thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_shared" });
  expect(calls(slot, "answer")).toEqual([]);
  expect(calls(slot, "answer_interaction")).toEqual([]);
  expect(calls(slot, "conversation_get")).toEqual([]);
});

it("opens review conversations using every queue item in the shared thread, including filtered organizations", async () => {
  const items = [reviewA, acmeReview].map((review) => ({ ...review, segment: "agent" as const, item: { ...review.item, state: "started" as const, threadId: "thr_review_shared" } }));
  const slot = await mount({ path: "to-review", reviews: { kind: "available", snapshot: { version: 1, items, lastPoll: null, lastSuccessAt: null }, needsInput: { thr_review_shared: true } } });
  await chooseOrganization(slot, "parsleyhealth");
  expect(slot.getByText("Agent needs your input")).toBeTruthy();
  const opener = slot.getByRole("button", { name: "Open conversation" });
  opener.focus();
  fireEvent.click(opener);
  const panel = slot.getByRole("complementary", { name: "Agent conversation" });
  fireEvent.click(within(panel).getByRole("button", { name: "2 PRs in shared conversation · 1 shown" }));
  expect(within(panel).getByRole("link", { name: "acme/app #703 · Review change 703" })).toBeTruthy();
  expect(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_review_shared");
  fireEvent.click(within(panel).getByRole("button", { name: "Close conversation" }));
  expect(document.activeElement).toBe(opener);
});

it("counts pending BB interactions once per agent thread across fixes and reviews", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const useBadge = app.navPanels[0]?.experimental_useBadge;
  if (!useBadge) throw new Error("Missing PRs badge");
  const slot = renderSlot({ component: () => <span>{useBadge()?.label}</span> }, {}, {
    rpc: {
      board_get: () => state({ view: { ...view, prs: [row(2), row(3)] }, markers: [2, 3].map((number) => marker(number, { threadId: "thr_fix" })), needsInput: { thr_fix: true } }),
      reviews_get: () => ({ ...reviews([reviewA, reviewB].map((review) => ({ ...review, segment: "agent", item: { ...review.item, state: "started", threadId: "thr_review" } }))), needsInput: { thr_review: true } }),
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  await slot.findByText("Across all organizations · 2 on you · 2 to review · 2 agents waiting");
});
