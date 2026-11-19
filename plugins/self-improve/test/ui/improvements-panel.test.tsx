// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImprovementsPanel } from "../../src/ui/improvements-panel.js";
import type { DashboardApi, DashboardData } from "../../src/ui/types.js";

afterEach(cleanup);
const data = (improvements: DashboardData["improvements"]) => ({ solutions: [{ id: "s1", title: "Keep payloads on retry" }, { id: "s2", title: "Check paths first" }], improvements } as unknown as DashboardData);
const api = () => ({ setImprovementEnabled: vi.fn(async () => ({})), applyImprovement: vi.fn(async () => ({})), setAutoApply: vi.fn(async () => ({ autoApply: false })) });

it("lists applied improvements with a Disable button, and passing fixes with Apply", async () => {
  const calls = api(), changed = vi.fn();
  render(<ImprovementsPanel data={data({ autoApply: true, scope: "all-except-worker", awaiting: ["s2"],
    applied: [{ solutionId: "s1", revision: "r1", content: "Keep the payload.", source: "automatic", enabled: true, appliedAtMs: 1, updatedAtMs: 1, waiting: false, usage: { turns: 4, lastAtMs: 2 } }] })} api={calls as unknown as DashboardApi} onChanged={changed}/>);
  expect(screen.getByText("Improvements · 1 applied · 1 waiting")).toBeTruthy();
  expect(screen.getByText(/Applied · applied automatically · added to 4 turns/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() => expect(calls.setImprovementEnabled).toHaveBeenCalledWith({ solutionId: "s1", enabled: false }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(calls.applyImprovement).toHaveBeenCalledWith({ solutionId: "s2" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Apply tested improvements automatically" }));
  await waitFor(() => expect(calls.setAutoApply).toHaveBeenCalledWith({ autoApply: false }));
  expect(changed).toHaveBeenCalledTimes(3);
});
