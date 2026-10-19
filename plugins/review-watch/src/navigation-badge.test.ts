// @vitest-environment jsdom
import { createElement } from "react";
import { expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "./types.js";

it("counts pending reviews, warns about follow-ups, and clears the navigation badge in realtime", async () => {
  const app = await loadPluginApp(() => import("../app.js"));
  const useBadge = app.navPanels[0]?.experimental_useBadge;
  if (!useBadge) throw new Error("Missing Reviews navigation badge");
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
  function BadgeProbe() { return createElement("output", { "aria-label": "Navigation badge" }, JSON.stringify(useBadge?.())); }
  const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: { queue_list: () => ({ items, lastPoll: null }) } });
  const badgeValue = () => JSON.parse(slot.getByLabelText("Navigation badge").textContent ?? "null");
  try {
    await waitFor(() => expect(badgeValue()).toEqual({ count: 2, tone: "warning", label: "1 initial reviews, 1 follow-up reviews" }));
    items = [initial];
    await slot.behavior.emitRealtime("queue-changed", {});
    await waitFor(() => expect(badgeValue()).toEqual({ count: 1, tone: "neutral", label: "1 initial reviews, 0 follow-up reviews" }));
    items = [];
    await slot.behavior.emitRealtime("queue-changed", {});
    await waitFor(() => expect(badgeValue()).toBeNull());
    expect(slot.inspection.rpcCalls.every((call) => call.method === "queue_list")).toBe(true);
  } finally { slot.lifecycle.unmount(); }
});
