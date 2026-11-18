// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DashboardData } from "../../src/ui/types.js";
import { problem, vote } from "../domain/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const snapshot = (): DashboardData => ({ problems: [problem()], solutions: [], ranking: [], runs: [], versions: {}, health: { enabled: false, issues: [] }, costs: { totals: [] }, votes: [vote()] });
async function page(context = { projectId: "project-1" as string | null }) {
  const app = await loadPluginApp(() => import("../../app.js"));
  const panel = app.navPanels.find(p => p.id === "self-improve");
  if (!panel) throw new Error("Missing Self improve navigation panel");
  const slot = renderSlot(panel, { subPath: "" }, { context, rpc: {
    getExecution: () => ({revision:"config-v1",projectId:"project-1",environmentId:"worker-env",selection:{providerId:"codex",model:"selected",reasoningLevel:"high"},permissionMode:"accept-edits"}),
    dashboard: snapshot, startChat: () => ({ threadId: "scoped-chat" }), performance: () => ({ points: [] }),
  } });
  cleanups.push(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: /Open problem/ });
  return slot;
}
it("registers a host page that renders native ThreadChat with inherited permissions", async () => {
  const slot = await page();
  fireEvent.click(slot.getByRole("button", { name: /Open problem/ }));
  fireEvent.click(slot.getByRole("button", { name: "Explore and edit in chat" }));
  const chat = await slot.findByTestId("bb-thread-chat");
  expect(chat.getAttribute("data-thread-id")).toBe("scoped-chat");
  expect(chat.getAttribute("data-permission-policy")).toBe("inherit");
  expect(chat.getAttribute("data-layout")).toBe("contained");
  expect(slot.inspection.rpcCalls.find(c => c.method === "startChat")?.input).toEqual({kind:"problem",id:"p-a",projectId:"project-1"});
  fireEvent.click(slot.getByRole("button", { name: "Open thread thread-a" }));
  expect(slot.inspection.navigateCalls).toContainEqual({method:"toThread",threadId:"thread-a"});
});
it("reconciles durable state after change events and reconnects", async () => {
  const slot = await page();
  const loads = () => slot.inspection.rpcCalls.filter(c => c.method === "dashboard").length;
  expect(loads()).toBe(1);
  await slot.behavior.emitRealtime("self-improve:changed", {});
  await waitFor(() => expect(loads()).toBe(2));
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(loads()).toBe(3));
});
it("requires explicit project context before creating a chat", async () => {
  const slot = await page({projectId:null});
  fireEvent.click(slot.getByRole("button", { name: /Open problem/ }));
  expect(slot.getByRole("button", { name: "Explore and edit in chat" })).toHaveProperty("disabled",true);
  expect(slot.inspection.rpcCalls.some(c => c.method === "startChat")).toBe(false);
});

it("routes the shared provider/model and permission pickers to the worker environment",async()=>{
  const slot=await page();
  const picker=await slot.findByTestId("bb-provider-model-picker");
  await waitFor(()=>expect(picker.getAttribute("data-routing-id")).toBe("worker-env"));
  expect(picker.getAttribute("data-routing-kind")).toBe("environment");
  const permission=slot.getByTestId("bb-permission-mode-picker");
  expect(permission.getAttribute("data-routing-id")).toBe("worker-env");
  expect(permission.getAttribute("data-provider-id")).toBe("codex");
  expect(slot.getByRole("button",{name:"Save execution",hidden:true})).toHaveProperty("disabled",true);
});
