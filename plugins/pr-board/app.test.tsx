// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BoardState, CalmRow, MarkerView, ViewModel } from "./board";
import type { PrsReview, ReviewsState } from "./reviews";
import { Board, prsBadge } from "./app";
import { minePrs, sizeDiameter } from "./board-ui";
import { z } from "zod";

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
  vi.restoreAllMocks();
});
async function mount(
  options: {
    board?: BoardState;
    reviews?: ReviewsState;
    path?: string;
    rpc?: Record<string, (input: unknown) => unknown>;
    openUrl?: (url: string) => boolean;
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
  await slot.findByText(
    options.path?.startsWith("to-review") ? "Review change 701" : "Change 2",
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
    slot.getByRole("button", { name: "Mine 10" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(slot.getByRole("button", { name: "6 on you" })).toBeTruthy();
  expect(
    slot.getByRole("heading", { name: "Answer to unblock agents" }),
  ).toBeTruthy();
  expect(calls(slot, "start")).toEqual([]);
  expect(calls(slot, "reviewers_request")).toEqual([]);
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
    label: "1 on you · 0 to review",
  });
  expect(badge(4)?.tone).toBe("neutral");
  expect(badge(5)?.tone).toBe("warning");
  expect(badge(14)?.tone).toBe("warning");
  expect(badge(15)).toEqual({
    tone: "critical",
    label: "15 on you · 0 to review · high pending count",
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
  await slot.findByText(/1 agent starting.*already running/);
  expect(calls(slot, "start")[0]).toEqual({
    items: [{ key: key(2), action: "fix-ci" }],
    stop: "publish",
  });
  fireEvent.click(slot.getByRole("button", { name: "Prepare 1" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(2));
  expect(calls(slot, "start")[1]).toEqual({
    items: [{ key: key(3), action: "rebase" }],
    stop: "prepare",
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
  });
  expect(slot.queryByRole("dialog")).toBeNull();
});
it("sends all selected rows so the server can report the five-thread cap honestly", async () => {
  const many = Array.from({ length: 6 }, (_, index) => row(index + 20));
  const slot = await mount({
    board: state({ view: { ...view, prs: [row(2), ...many] }, markers: [] }),
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
    ).getByRole("button", { name: "Start 5" }),
  );
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(
    z.object({ items: z.array(z.unknown()) }).parse(calls(slot, "start")[0])
      .items,
  ).toHaveLength(7);
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
  fireEvent.click(slot.getByRole("button", { name: "1 agent" }));
  fireEvent.click(
    within(slot.getByRole("region", { name: "Working" })).getByRole("button", {
      name: "Open thread →",
    }),
  );
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_10",
  });
  expect(slot.getByRole("heading", { name: "Finished threads" })).toBeTruthy();
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
  fireEvent.click(slot.getByRole("button", { name: "To review 0" }));
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
      { key: reviewA.item.key, projectId: "p2" },
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
    { keys: [reviewA.item.key, reviewB.item.key], projectId: "p2" },
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
  expect(slot.getByRole("button", { name: "91 on you" })).toBeTruthy();
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
  fireEvent.click(slot.getByRole("button", { name: "1 on reviewers" }));
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
  fireEvent.click(completed.getByRole("button", { name: "Open thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thr_60",
  });
  fireEvent.click(slot.getByRole("button", { name: "Prepare 5" }));
  await waitFor(() => expect(calls(slot, "start")).toHaveLength(1));
  expect(calls(slot, "start")[0]).toEqual({
    items: fresh.slice(0, 5).map((pr) => ({ key: pr.key, action: "fix-ci" })),
    stop: "prepare",
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
