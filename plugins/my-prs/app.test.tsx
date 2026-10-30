// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "./server.js";
import { feedbackOf } from "./feedback.js";
import { fixture } from "./fixtures.js";
import type { View } from "./types.js";
import { prsCache } from "./app.js";

it("shares a snapshot between the page and badge and renders cached rows immediately on return", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0];
  const useBadge = panel?.experimental_useBadge;
  if (!panel || !useBadge) throw new Error("Missing My PRs panel or badge");
  const Page = panel.component;
  function Combined() { const badge = useBadge?.(); return <><output aria-label="Badge">{badge?.count}</output><Page subPath="" /></>; }
  let calls = 0;
  const rpc = { prs_get: () => { calls++; return { rows: [row(1)], project: "project-test", poll: null }; } };
  const first = renderSlot({ component: Combined }, {}, { rpc });
  await first.findByText("Improve the editor 1");
  await waitFor(() => expect(first.getByLabelText("Badge").textContent).toBe("1"));
  expect(calls).toBe(1);
  first.lifecycle.unmount();
  const returned = renderSlot(panel, { subPath: "" }, { rpc });
  cleanups.push(() => returned.lifecycle.unmount());
  expect(returned.getByText("Improve the editor 1")).toBeTruthy();
  expect(returned.queryByText("Reading the queue…")).toBeNull();
  expect(calls).toBe(1);
});

const cleanups: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); prsCache.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const targets = () => ({ projects: [{ id: "project-test", name: "Default" }, { id: "project-parsley", name: "Parsley" }], projectId: "project-test", reason: "default" });
async function confirmAddress() {
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByLabelText("Project");
  await waitFor(() => expect(dialog.getByRole("button", { name: "Address feedback" })).toHaveProperty("disabled", false));
  fireEvent.click(dialog.getByRole("button", { name: "Address feedback" }));
}
it("selects feedback and starts one explicit batch, then navigates to its thread", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs page");
  const prs = [fixture(), fixture(2)].map((data) => feedbackOf({ ...data, requested: [] }));
  const view: View = { rows: prs.map((pr) => ({ ...pr, dismissed: false, holdUntil: null, dispatch: { kind: "none" }, threadStatus: null })),
    project: "project-test", poll: { at: "2026-10-19T12:00:00Z", lastSuccess: "2026-10-19T12:00:00Z", login: "me", error: null, retryAt: null } };
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => view,
    address_targets: targets,
    address: () => ({ threadId: "thread-address" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByText("Improve the editor 1");
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "address")).toEqual([]);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all actionable PRs" }));
  fireEvent.click(await slot.findByRole("button", { name: "Address 2 selected" }));
  await confirmAddress();
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-address" }));
  const calls = slot.inspection.rpcCalls.filter((call) => call.method === "address");
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).toContain(prs[0]?.activity);
  expect(JSON.stringify(calls)).toContain(prs[1]?.activity);
});

async function renderFeedback(rows: View["rows"]) {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0];
  if (!panel) throw new Error("Missing feedback page");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => ({ rows, project: "project-test", poll: null }),
    address_targets: targets,
    address: () => ({ threadId: "thread-address" }), dismiss: () => ({ ok: true }), clear_dispatch: () => ({ ok: true }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByRole("heading", { name: "Your turn" });
  return slot;
}
function row(number: number): View["rows"][number] {
  return { ...feedbackOf({ ...fixture(number), requested: [] }), dismissed: false, holdUntil: null, dispatch: { kind: "none" }, threadStatus: null };
}

it("filters from the legend and bar without refetching, including dismissed and held PRs", async () => {
  const slot = await renderFeedback([
    row(1), { ...row(2), turn: null },
    { ...row(3), dismissed: true, status: { reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS" } },
    { ...row(4), holdUntil: "2099-01-01T12:00:00Z" },
  ]);
  const calls = slot.inspection.rpcCalls.length;
  fireEvent.click(slot.getByLabelText("Select example/editor#1"));
  fireEvent.click(within(slot.getByRole("list", { name: "PR status counts" })).getByRole("button", { name: "Approved: 1" }));
  expect(slot.queryByLabelText("Selection")).toBeNull();
  expect(slot.getByText("Improve the editor 3").closest("details")).toBeNull();
  expect(slot.queryByText("Improve the editor 1")).toBeNull();
  expect(slot.getByRole("button", { name: "Restore example/editor#3" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Filter Held: 1" }));
  expect(slot.getByRole("button", { name: "Resume example/editor#4" })).toBeTruthy();
  expect(slot.queryByText("Improve the editor 3")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Filter Held: 1" }));
  expect(slot.getByRole("heading", { name: "Your turn" })).toBeTruthy();
  expect(slot.getByText("Improve the editor 2")).toBeTruthy();
  expect(slot.inspection.rpcCalls).toHaveLength(calls);
});

it("restores the filter and cached results immediately on return and can clear an empty filter", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs page");
  let rows: View["rows"] = [row(1), { ...row(2), turn: null }];
  const rpc = { prs_get: () => ({ rows, project: "project-test", poll: null }) };
  const first = renderSlot(panel, { subPath: "" }, { rpc });
  await first.findByText("Improve the editor 2");
  fireEvent.click(first.getByRole("button", { name: "Filter Waiting on reviewer: 1" }));
  first.lifecycle.unmount();
  const returned = renderSlot(panel, { subPath: "" }, { rpc });
  cleanups.push(() => returned.lifecycle.unmount());
  expect(returned.queryByText("Improve the editor 1")).toBeNull();
  expect(returned.getByText("Improve the editor 2")).toBeTruthy();
  expect(returned.getByRole("button", { name: "Filter Waiting on reviewer: 1" })).toHaveProperty("ariaPressed", "true");
  expect(returned.inspection.rpcCalls).toHaveLength(0);
  rows = [row(1)];
  await returned.behavior.emitRealtime("prs-changed", {});
  await returned.findByText("No PRs in this state.");
  fireEvent.click(returned.getByRole("button", { name: "Show all PRs" }));
  expect(returned.getByText("Improve the editor 1")).toBeTruthy();
});

it("groups related feedback across repositories and selects only actionable rows", async () => {
  const slot = await renderFeedback([
    { ...row(1), title: "fix(catalog): first", repo: "parsleyhealth/store" },
    { ...row(2), title: "feat(catalog): second", repo: "parsleyhealth/api" },
    { ...row(3), title: "fix(schedule): third" },
    { ...row(4), title: "fix(catalog): already started", dispatch: { kind: "linked", threadId: "thread-existing" }, threadStatus: "running" },
  ]);
  expect(slot.queryByLabelText("Selection")).toBeNull();
  fireEvent.click(slot.getByLabelText("Select parsleyhealth/store#1"));
  fireEvent.click(slot.getByLabelText("Select parsleyhealth/api#2"), { shiftKey: true });
  expect(slot.getByText("2 selected")).toBeTruthy();
  expect(slot.getByRole("checkbox", { name: "Select all actionable PRs" })).toHaveProperty("indeterminate", true);
  expect(slot.queryByRole("checkbox", { name: "Select example/editor#4" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Address 2 selected" }));
  await confirmAddress();
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-address" }));
  const call = JSON.stringify(slot.inspection.rpcCalls.find((call) => call.method === "address"));
  expect(call).toContain('"id":"PR_1"'); expect(call).toContain('"id":"PR_2"'); expect(call).not.toContain('"id":"PR_4"');
});

it("supports shift selection, Escape to clear, and b to address without acting while typing", async () => {
  const slot = await renderFeedback([row(1), row(2), row(3)]);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select example/editor#1" }));
  fireEvent.click(slot.getByRole("checkbox", { name: "Select example/editor#3" }), { shiftKey: true });
  expect(slot.getByText("3 selected")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(slot.queryByLabelText("Selection")).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: "Select example/editor#2" }));
  const input = document.createElement("input"); document.body.append(input); input.focus();
  fireEvent.keyDown(input, { key: "b" });
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "address")).toHaveLength(0);
  input.remove(); fireEvent.keyDown(window, { key: "b" });
  await confirmAddress();
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "address")).toHaveLength(1));
  expect(JSON.stringify(slot.inspection.rpcCalls.find((call) => call.method === "address"))).toContain('"id":"PR_2"');
});

it("keeps thread, clear-attempt, dismissal, and restore actions available in compact rows", async () => {
  const slot = await renderFeedback([
    { ...row(1), dispatch: { kind: "linked", threadId: "thread-existing" }, threadStatus: "idle" },
    { ...row(2), dismissed: true }, row(3),
  ]);
  fireEvent.click(slot.getByRole("button", { name: /Open/ }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-existing" });
  fireEvent.click(slot.getByRole("button", { name: "Clear attempt" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "clear_dispatch")).toBe(true));
  fireEvent.click(slot.getByRole("button", { name: "Dismiss example/editor#3" }));
  await waitFor(() => expect(JSON.stringify(slot.inspection.rpcCalls)).toContain('"dismissed":true'));
  fireEvent.click(slot.getByText("1 dismissed · show"));
  fireEvent.click(slot.getByRole("button", { name: "Restore example/editor#2" }));
  await waitFor(() => expect(JSON.stringify(slot.inspection.rpcCalls)).toContain('"dismissed":false'));
});

it("shows separate open PR sections and keeps dismissed and held rows out of their counts", async () => {
  const slot = await renderFeedback([
    row(1), { ...row(2), turn: null }, { ...row(3), dismissed: true },
    { ...row(4), holdUntil: "2099-01-01T12:00:00Z" },
  ]);
  const turn = within(slot.getByRole("region", { name: "Your turn" }));
  const other = within(slot.getByRole("region", { name: "Other open PRs" }));
  const held = within(slot.getByRole("region", { name: "On hold" }));
  expect(turn.getByText("Improve the editor 1")).toBeTruthy();
  expect(turn.getByRole("heading", { name: "Your turn" }).parentElement?.textContent).toBe("Your turn1");
  expect(turn.queryByText("Improve the editor 2")).toBeNull();
  expect(turn.queryByText("Improve the editor 4")).toBeNull();
  expect(other.getByText("Improve the editor 2")).toBeTruthy();
  expect(other.getByText("Improve the editor 2").closest("details")).toBeNull();
  expect(other.queryByRole("checkbox")).toBeNull();
  expect(held.getByText("Improve the editor 4")).toBeTruthy();
  fireEvent.click(turn.getByText("1 dismissed · show"));
  expect(turn.getByText("Improve the editor 3")).toBeTruthy();
  expect(turn.getAllByRole("listitem")).toHaveLength(2);
  expect(other.getAllByRole("listitem")).toHaveLength(1);
  expect(held.getAllByRole("listitem")).toHaveLength(1);
});

it("shows both empty sections when no PRs are open", async () => {
  const slot = await renderFeedback([]);
  expect(within(slot.getByRole("region", { name: "Your turn" })).getByText("Nothing waiting on you.")).toBeTruthy();
  expect(within(slot.getByRole("region", { name: "Other open PRs" })).getByText("No other open PRs.")).toBeTruthy();
});

it("keeps the linked thread visible when feedback clears and moves a row to Other open PRs", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs");
  let rows: View["rows"] = [row(1), { ...row(2), dispatch: { kind: "linked", threadId: "thread-existing" }, threadStatus: "active" }];
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => ({ rows, project: "project-test", poll: null }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByLabelText("Select example/editor#1"));
  expect(await slot.findByRole("button", { name: "Open feedback thread for example/editor#2" })).toHaveProperty("textContent", "Working↗");
  rows = rows.map((item) => ({ ...item, turn: null }));
  await slot.behavior.emitRealtime("prs-changed", {});
  await waitFor(() => expect(slot.queryByLabelText("Selection")).toBeNull());
  const other = within(slot.getByRole("region", { name: "Other open PRs" }));
  expect(other.getByText("Improve the editor 1")).toBeTruthy();
  fireEvent.click(other.getByRole("button", { name: "Open feedback thread for example/editor#2" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-existing" });
});

it("dates waiting feedback from when it arrived and labels the linked thread's current status", async () => {
  const slot = await renderFeedback([
    { ...row(1), updatedAt: new Date().toISOString(), turn: { why: "Comment from @reviewer", since: Date.now() - 7_200_000, latest: Date.now() - 7_200_000 },
      dispatch: { kind: "linked", threadId: "thread-existing" }, threadStatus: "error" },
  ]);
  expect(slot.getByText("Comment from @reviewer · 2h ago")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open feedback thread for example/editor#1" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-existing" });
  expect(slot.getByText("Failed")).toBeTruthy();
});

it("registers a sidebar badge that counts actionable feedback and follows realtime updates", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const useBadge = app.navPanels[0]?.experimental_useBadge;
  if (!useBadge) throw new Error("Missing My PRs sidebar badge");
  let view: View = { project: "project-test", poll: null, rows: [
    row(1), { ...row(2), dismissed: true }, { ...row(3), turn: null }, { ...row(4), holdUntil: "2099-01-01T12:00:00Z" },
  ] };
  function BadgeProbe() { return <output aria-label="Navigation badge">{JSON.stringify(useBadge?.())}</output>; }
  const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: { prs_get: () => view } });
  cleanups.push(() => slot.lifecycle.unmount());
  await waitFor(() => expect(JSON.parse(slot.getByLabelText("Navigation badge").textContent ?? "null")).toEqual({
    count: 1, tone: "warning", label: "1 pull request waiting for your response",
  }));
  view = { ...view, rows: [row(1), row(2), { ...row(3), turn: null }] };
  await slot.behavior.emitRealtime("prs-changed", {});
  await waitFor(() => expect(JSON.parse(slot.getByLabelText("Navigation badge").textContent ?? "null")).toEqual({
    count: 2, tone: "warning", label: "2 pull requests waiting for your response",
  }));
  view = { ...view, rows: [] };
  await slot.behavior.emitRealtime("prs-changed", {});
  await waitFor(() => expect(slot.getByLabelText("Navigation badge").textContent).toBe("null"));
  expect(slot.inspection.rpcCalls.every((call) => call.method === "prs_get")).toBe(true);
});

it("keeps the same area in different organizations separate with only row and select-all checkboxes", async () => {
  const slot = await renderFeedback([
    { ...row(1), title: "fix(catalog): parsley", repo: "parsleyhealth/store" },
    { ...row(2), title: "fix(catalog): bit", repo: "bitcomplete/store" },
  ]);
  const parsley = within(slot.getByRole("region", { name: "parsleyhealth your turn" }));
  expect(parsley.getByText("fix(catalog): parsley")).toBeTruthy();
  expect(parsley.queryByText("fix(catalog): bit")).toBeNull();
  expect(slot.getAllByRole("checkbox")).toHaveLength(3);
  expect(parsley.getAllByRole("checkbox")).toHaveLength(1);
  expect(parsley.queryByLabelText("Select organization parsleyhealth")).toBeNull();
  fireEvent.click(slot.getByLabelText("Select parsleyhealth/store#1"));
  expect(slot.getByLabelText("Select parsleyhealth/store#1")).toHaveProperty("checked", true);
  expect(slot.getByLabelText("Select bitcomplete/store#2")).toHaveProperty("checked", false);
  fireEvent.click(slot.getByRole("button", { name: "Address 1 selected" }));
  await confirmAddress();
  await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "address")).toMatchObject({
    input: { items: [{ id: "PR_1", activity: row(1).activity }] },
  }));
});

it("moves a selected PR to the faded hold section, excludes it from selection, and resumes it", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs");
  let held: string | null = null;
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => ({ rows: [{ ...row(1), holdUntil: held }, row(2)], project: "project-test", poll: null }),
    hold: (input) => { held = rpcContract.hold.input.parse(input).until; return { ok: true }; },
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByLabelText("Select example/editor#1"));
  fireEvent.change(slot.getByLabelText("Hold example/editor#1"), { target: { value: "1" } });
  const section = within(await slot.findByRole("region", { name: "On hold" }));
  expect(section.getByText("Improve the editor 1")).toBeTruthy();
  expect(slot.queryByLabelText("Select example/editor#1")).toBeNull();
  expect(slot.queryByLabelText("Selection")).toBeNull();
  fireEvent.click(slot.getByLabelText("Select all actionable PRs"));
  expect(slot.getByText("1 selected")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Resume example/editor#1" }));
  await slot.findByLabelText("Select example/editor#1");
  expect(slot.queryByRole("region", { name: "On hold" })).toBeNull();
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "hold")).toMatchObject([
    { input: { id: "PR_1", until: expect.any(String) } }, { input: { id: "PR_1", until: null } },
  ]);
});

it("preselects the mapped project and lets a batch choose another project", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => ({ rows: [row(1), row(2)], project: "project-test", poll: null }),
    address_targets: () => ({ ...targets(), projectId: "project-parsley", reason: "organization" }),
    address: () => ({ threadId: "thread-picked" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByLabelText("Select all actionable PRs"));
  fireEvent.click(slot.getByRole("button", { name: "Address 2 selected" }));
  const dialog = within(await screen.findByRole("dialog"));
  const project = await dialog.findByLabelText("Project");
  expect(project).toHaveProperty("value", "project-parsley");
  expect(slot.inspection.rpcCalls.some((call) => call.method === "address")).toBe(false);
  fireEvent.change(project, { target: { value: "project-test" } });
  fireEvent.click(dialog.getByRole("button", { name: "Address feedback" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "address")).toMatchObject({
    input: { projectId: "project-test", items: expect.arrayContaining([{ id: "PR_1", activity: row(1).activity }, { id: "PR_2", activity: row(2).activity }]) },
  }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-picked" }));
});

it("requires a choice for mixed projects, preserves selection on failure, and cancels without work", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing My PRs");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    prs_get: () => ({ rows: [row(1), row(2)], project: null, poll: null }),
    address_targets: () => ({ ...targets(), projectId: null, reason: "mixed" }),
    address: () => { throw new Error("Selected machine is offline"); },
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByLabelText("Select all actionable PRs"));
  fireEvent.click(slot.getByRole("button", { name: "Address 2 selected" }));
  const dialog = within(await screen.findByRole("dialog"));
  const project = await dialog.findByLabelText("Project");
  const start = dialog.getByRole("button", { name: "Address feedback" });
  expect(start).toHaveProperty("disabled", true);
  fireEvent.change(project, { target: { value: "project-parsley" } });
  fireEvent.click(start);
  expect(await dialog.findByRole("alert")).toHaveProperty("textContent", "Selected machine is offline");
  expect(slot.getByText("2 selected")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  const item = slot.getByLabelText("Select example/editor#1").closest("li"); if (!item) throw new Error("Missing row");
  fireEvent.click(within(item).getByRole("button", { name: "Address comments on example/editor#1" }));
  const single = within(await screen.findByRole("dialog", { name: "Address feedback" }));
  await single.findByLabelText("Project");
  fireEvent.click(single.getByRole("button", { name: "Cancel" }));
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "address")).toHaveLength(1);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});
