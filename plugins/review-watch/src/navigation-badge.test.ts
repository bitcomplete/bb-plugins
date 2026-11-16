// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { queueCache } from "../app.js";
import type { QueueItem } from "./types.js";

afterEach(() => { queueCache.clear(); vi.unstubAllGlobals(); });

it("keeps the registered header's pending counts current without contributing a second nav entry", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const app = await loadPluginApp(() => import("../app.js"));
  expect(app.navPanels).toEqual([]);
  const header = app.threadHeaderActions[0];
  if (!header) throw new Error("Missing Review Watch header counts");
  const initial: QueueItem = {
    key: "review-requested:PR_1:head", rule: "review-requested", state: "queued",
    repo: "example/editor", number: 1, title: "Improve the editor", author: "alice",
    url: "https://github.com/example/editor/pull/1", baseBranch: "main", headBranch: "editor",
    headSha: "head", nodeId: "PR_1", reason: "Review requested", noticedAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:00Z",
  };
  let items: QueueItem[] = [initial,
    { ...initial, key: "followup", rule: "review-followup", state: "started" },
    { ...initial, key: "dismissed", state: "dismissed" },
    { ...initial, key: "archived", state: "archived" },
  ];
  const slot = renderSlot(header, { threadId: "thread-test", projectId: "project-test", isCompactViewport: false }, { rpc: { queue_list: () => ({ items, lastPoll: null }) } });
  try {
    const link = await slot.findByRole("link", { name: "1 initial reviews, 1 follow-up reviews" });
    expect(link.getAttribute("href")).toBe("/plugins/pr-board/pr-board/to-review");
    items = [initial];
    await slot.behavior.emitRealtime("queue-changed", {});
    await slot.findByRole("link", { name: "1 initial reviews, 0 follow-up reviews" });
    items = [];
    await slot.behavior.emitRealtime("queue-changed", {});
    await waitFor(() => expect(slot.getByRole("link", { name: "0 initial reviews, 0 follow-up reviews" })).toBeTruthy());
    expect(slot.getAllByText("0")).toHaveLength(2);
    expect(slot.inspection.rpcCalls.every((call) => call.method === "queue_list")).toBe(true);
  } finally { slot.lifecycle.unmount(); }
});
