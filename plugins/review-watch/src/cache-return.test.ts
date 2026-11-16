// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { queueCache } from "../app.js";
import type { QueueItem } from "./types.js";

afterEach(() => { queueCache.clear(); vi.unstubAllGlobals(); });

it("shares split-header reads and shows cached counts immediately on return", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const app = await loadPluginApp(() => import("../app.js"));
  const header = app.threadHeaderActions[0];
  if (!header) throw new Error("Missing Review Watch header counts");
  const Header = header.component;
  const item: QueueItem = {
    key: "review-requested:PR_1:head", rule: "review-requested", state: "queued",
    repo: "example/editor", number: 1, title: "Keep reviews ready on return", author: "alice",
    url: "https://github.com/example/editor/pull/1", baseBranch: "main", headBranch: "editor",
    headSha: "head", nodeId: "PR_1", reason: "Review requested", noticedAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:00Z",
  };
  const props = { threadId: "thread-one", projectId: "project-test", isCompactViewport: false };
  function Combined() {
    return createElement(Fragment, null, createElement(Header, props), createElement(Header, { ...props, threadId: "thread-two" }));
  }
  let calls = 0;
  let delayed = false;
  const rpc = { queue_list: () => { calls++; return delayed ? new Promise<never>(() => {}) : { items: [item], lastPoll: null }; } };
  const slot = renderSlot({ component: Combined }, {}, { rpc });
  try {
    expect(await slot.findAllByRole("link", { name: "1 initial reviews, 0 follow-up reviews" })).toHaveLength(2);
    expect(calls).toBe(1);
  } finally { slot.lifecycle.unmount(); }
  delayed = true;
  const returned = renderSlot(header, props, { rpc });
  try {
    expect(returned.getByRole("link", { name: "1 initial reviews, 0 follow-up reviews" })).toBeTruthy();
    expect(calls).toBe(1);
  } finally { returned.lifecycle.unmount(); }
});
