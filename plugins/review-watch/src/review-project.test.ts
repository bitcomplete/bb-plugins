// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "./types.js";
import { queueCache } from "../app.js";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { queueCache.clear(); vi.unstubAllGlobals(); });

const first: QueueItem = {
  key: "review-requested:one:sha", rule: "review-requested", state: "queued", repo: "parsleyhealth/sage",
  number: 1, title: "fix(catalog): improve the editor", author: "alice", url: "https://github.com/parsleyhealth/sage/pull/1",
  baseBranch: "main", headBranch: "editor", headSha: "sha", nodeId: "one", reason: "Review requested",
  noticedAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:00Z",
};
const second = { ...first, key: "review-requested:two:sha", repo: "bitcomplete/hiringloop", number: 2, nodeId: "two" };

async function setup(mixed = false, failStart = false) {
  const app = await loadPluginApp(() => import("../app.js"));
  const panel = app.navPanels[0];
  if (!panel) throw new Error("Missing Reviews page");
  return renderSlot(panel, { subPath: "reviews" }, { rpc: {
    queue_list: () => ({ items: [first, second], lastPoll: null }),
    review_targets: () => ({
      projects: [{ id: "parsley", name: "Parsley" }, { id: "bitcomplete", name: "Bit Complete" }],
      projectId: mixed ? null : "parsley", reason: mixed ? "mixed" : "organization",
    }),
    item_batch_start: () => {
      if (failStart) throw new Error("Selected machine is offline");
      return { threadId: "batch-thread", items: [first, second] };
    },
    item_start: () => ({ item: { ...first, threadId: "single-thread", state: "started" } }),
  } });
}

it("preselects the mapped project, lets a batch override it, and sends the chosen project", async () => {
  const slot = await setup();
  try {
    fireEvent.click(await slot.findByLabelText("Select parsleyhealth/sage#1"));
    fireEvent.click(slot.getByLabelText("Select bitcomplete/hiringloop#2"));
    fireEvent.click(slot.getByRole("button", { name: /Review 2/ }));
    const dialog = within(await screen.findByRole("dialog"));
    const project = await dialog.findByLabelText("Project");
    await waitFor(() => expect(project).toHaveProperty("value", "parsley"));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "item_batch_start")).toBe(false);
    fireEvent.change(project, { target: { value: "bitcomplete" } });
    fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "batch-thread" }));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "item_batch_start")).toMatchObject({
      input: { keys: expect.arrayContaining([first.key, second.key]), projectId: "bitcomplete" },
    });
  } finally { slot.lifecycle.unmount(); }
});

it("requires a project for a mixed batch and keeps the selection after a failed start", async () => {
  const slot = await setup(true, true);
  try {
    fireEvent.click(await slot.findByLabelText("Select parsleyhealth/sage#1"));
    fireEvent.click(slot.getByLabelText("Select bitcomplete/hiringloop#2"));
    fireEvent.click(slot.getByRole("button", { name: /Review 2/ }));
    const dialog = within(await screen.findByRole("dialog"));
    const project = await dialog.findByLabelText("Project");
    const start = dialog.getByRole("button", { name: "Start review" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.change(project, { target: { value: "parsley" } });
    fireEvent.click(start);
    expect(await dialog.findByRole("alert")).toHaveProperty("textContent", "Selected machine is offline");
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(slot.getByLabelText("Select parsleyhealth/sage#1")).toHaveProperty("checked", true);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "item_batch_start")).toHaveLength(1);
  } finally { slot.lifecycle.unmount(); }
});

it("opens the same project picker for an individual review and cancel starts nothing", async () => {
  const slot = await setup();
  try {
    const starts = await slot.findAllByRole("button", { name: "Start" });
    fireEvent.click(starts[0]!);
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByLabelText("Project");
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "item_start")).toBe(false);
  } finally { slot.lifecycle.unmount(); }
});

it("starts an individual review in the project selected in the dialog", async () => {
  const slot = await setup();
  try {
    const row = await slot.findByLabelText("Select parsleyhealth/sage#1");
    fireEvent.click(within(row.closest("li")!).getByRole("button", { name: "Start" }));
    const dialog = within(await screen.findByRole("dialog"));
    const project = await dialog.findByLabelText("Project");
    fireEvent.change(project, { target: { value: "bitcomplete" } });
    fireEvent.click(dialog.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "single-thread" }));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "item_start")).toMatchObject({
      input: { key: first.key, projectId: "bitcomplete" },
    });
  } finally { slot.lifecycle.unmount(); }
});

it("groups reviews by organization and keeps selection controls on rows and the select-all header", async () => {
  const slot = await setup();
  try {
    const parsley = within(await slot.findByRole("region", { name: "parsleyhealth reviews" }));
    expect(parsley.getByRole("heading", { level: 4 })).toHaveProperty("textContent", expect.stringContaining("catalog"));
    expect(slot.getAllByRole("checkbox")).toHaveLength(3);
    expect(parsley.getAllByRole("checkbox")).toHaveLength(1);
    expect(parsley.queryByLabelText("Select bitcomplete/hiringloop#2")).toBeNull();
    fireEvent.click(parsley.getByLabelText("Select parsleyhealth/sage#1"));
    expect(slot.getByLabelText("Select parsleyhealth/sage#1")).toHaveProperty("checked", true);
    expect(slot.getByLabelText("Select bitcomplete/hiringloop#2")).toHaveProperty("checked", false);
    expect(slot.getByRole("button", { name: /Review 1/ })).toBeTruthy();
    fireEvent.click(parsley.getByLabelText("Select parsleyhealth/sage#1"));
    expect(slot.queryByLabelText("Selection")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
