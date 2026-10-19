// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { feedbackOf } from "./feedback.js";
import { fixture } from "./fixtures.js";
import type { View } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it("selects feedback and starts one explicit batch, then navigates to its thread", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels[0]; if (!panel) throw new Error("Missing inbox page");
  const prs = [fixture(), fixture(2)].map((data) => feedbackOf({ ...data, requested: [] }));
  const view: View = { rows: prs.map((pr) => ({ ...pr, dismissed: false, dispatch: { kind: "none" }, threadStatus: null })),
    project: "project-test", poll: { at: "2026-10-19T12:00:00Z", lastSuccess: "2026-10-19T12:00:00Z", login: "me", error: null } };
  const slot = renderSlot(panel, { subPath: "" }, { rpc: {
    inbox_get: () => view,
    address: () => ({ threadId: "thread-address" }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByText("Improve the editor 1");
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "address")).toEqual([]);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all actionable PRs" }));
  fireEvent.click(await slot.findByRole("button", { name: "Address 2 selected" }));
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
    inbox_get: () => ({ rows, project: "project-test", poll: null }),
    address: () => ({ threadId: "thread-address" }), dismiss: () => ({ ok: true }), clear_dispatch: () => ({ ok: true }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByRole("heading", { name: "Your turn" });
  return slot;
}
function row(number: number): View["rows"][number] {
  return { ...feedbackOf({ ...fixture(number), requested: [] }), dismissed: false, dispatch: { kind: "none" }, threadStatus: null };
}

it("groups related feedback across repositories and selects only actionable rows", async () => {
  const slot = await renderFeedback([
    { ...row(1), title: "fix(catalog): first", repo: "parsleyhealth/store" },
    { ...row(2), title: "feat(catalog): second", repo: "parsleyhealth/api" },
    { ...row(3), title: "fix(schedule): third" },
    { ...row(4), title: "fix(catalog): already started", dispatch: { kind: "linked", threadId: "thread-existing" }, threadStatus: "running" },
  ]);
  expect(slot.queryByLabelText("Selection")).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: "Select catalog" }));
  expect(slot.getByText("2 selected")).toBeTruthy();
  expect(slot.getByRole("checkbox", { name: "Select all actionable PRs" })).toHaveProperty("indeterminate", true);
  expect(slot.queryByRole("checkbox", { name: "Select example/editor#4" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Address 2 selected" }));
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

it("registers a sidebar badge that counts actionable feedback and follows realtime updates", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const useBadge = app.navPanels[0]?.experimental_useBadge;
  if (!useBadge) throw new Error("Missing My PRs sidebar badge");
  let view: View = { project: "project-test", poll: null, rows: [
    row(1), { ...row(2), dismissed: true }, { ...row(3), turn: null },
  ] };
  function BadgeProbe() { return <output aria-label="Navigation badge">{JSON.stringify(useBadge?.())}</output>; }
  const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: { inbox_get: () => view } });
  cleanups.push(() => slot.lifecycle.unmount());
  await waitFor(() => expect(JSON.parse(slot.getByLabelText("Navigation badge").textContent ?? "null")).toEqual({
    count: 1, tone: "warning", label: "1 pull request waiting for your response",
  }));
  view = { ...view, rows: [row(1), row(2), { ...row(3), turn: null }] };
  await slot.behavior.emitRealtime("inbox-changed", {});
  await waitFor(() => expect(JSON.parse(slot.getByLabelText("Navigation badge").textContent ?? "null")).toEqual({
    count: 2, tone: "warning", label: "2 pull requests waiting for your response",
  }));
  view = { ...view, rows: [] };
  await slot.behavior.emitRealtime("inbox-changed", {});
  await waitFor(() => expect(slot.getByLabelText("Navigation badge").textContent).toBe("null"));
  expect(slot.inspection.rpcCalls.every((call) => call.method === "inbox_get")).toBe(true);
});
