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
