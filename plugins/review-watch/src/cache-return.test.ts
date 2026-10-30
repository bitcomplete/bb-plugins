// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "./types.js";

it("shares the page and badge read, and shows cached reviews immediately on return", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const app = await loadPluginApp(() => import("../app.js"));
  const panel = app.navPanels[0];
  const useBadge = panel?.experimental_useBadge;
  if (!panel || !useBadge) throw new Error("Missing Reviews panel or badge");
  const Page = panel.component;
  const item: QueueItem = {
    key: "review-requested:PR_1:head", rule: "review-requested", state: "queued",
    repo: "example/editor", number: 1, title: "Keep reviews ready on return", author: "alice",
    url: "https://github.com/example/editor/pull/1", baseBranch: "main", headBranch: "editor",
    headSha: "head", nodeId: "PR_1", reason: "Review requested", noticedAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:00Z",
  };
  function Combined() {
    const badge = useBadge?.();
    return createElement(Fragment, null, createElement("output", { "aria-label": "Badge" }, badge?.count), createElement(Page, { subPath: "reviews" }));
  }
  let calls = 0;
  let delayed = false;
  const rpc = { queue_list: () => { calls++; return delayed ? new Promise<never>(() => {}) : { items: [item], lastPoll: null }; } };
  const slot = renderSlot({ component: Combined }, {}, { rpc });
  try {
    await slot.findByText(item.title);
    await waitFor(() => expect(slot.getByLabelText("Badge").textContent).toBe("1"));
    expect(calls).toBe(1);
  } finally { slot.lifecycle.unmount(); }
  delayed = true;
  const returned = renderSlot(panel, { subPath: "reviews" }, { rpc });
  try {
    expect(returned.getByText(item.title)).toBeTruthy();
    expect(returned.queryByText("Reading the queue…")).toBeNull();
    expect(calls).toBe(1);
  } finally { returned.lifecycle.unmount(); vi.unstubAllGlobals(); }
});
