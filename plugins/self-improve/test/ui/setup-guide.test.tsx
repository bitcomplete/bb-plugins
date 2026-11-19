// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupGuide } from "../../src/ui/setup-guide.js";
import type { DashboardApi, DashboardData } from "../../src/ui/types.js";

afterEach(cleanup);
const data = (setup: Partial<NonNullable<DashboardData["setup"]>>) => ({ setup: { worker: false, model: false, mined: false, scheduled: false, testCases: false, minerQueued: false, ...setup } } as DashboardData);
const api = (findProblems = vi.fn(async () => ({ jobId: "job" }))) => ({ findProblems } as unknown as DashboardApi);

it("walks a new owner through what to set up, with Find problems disabled until a worker and model are chosen", () => {
  render(<SetupGuide data={data({})} api={api()} onQueued={() => {}}/>);
  expect(screen.getByRole("heading", { name: "Get started" })).toBeTruthy();
  for (const step of ["Choose where agent work runs", "Choose a provider and model", "Find problems", "Keep looking automatically (optional)", "Add development test cases (optional)"]) expect(screen.getByText(step)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Find problems now" }) as HTMLButtonElement).disabled).toBe(true);
});

it("starts looking for problems from the guide once set up", async () => {
  const find = vi.fn(async () => ({ jobId: "job" })), queued = vi.fn();
  render(<SetupGuide data={data({ worker: true, model: true })} api={api(find)} onQueued={queued}/>);
  fireEvent.click(screen.getByRole("button", { name: "Find problems now" }));
  await waitFor(() => expect(find).toHaveBeenCalledWith({}));
  expect(queued).toHaveBeenCalled(); expect(screen.getByRole("status").textContent).toContain("Looking through your recent threads");
});

it("folds into a quiet Find problems control after setup, and shows when a search is already running", () => {
  const { rerender } = render(<SetupGuide data={data({ worker: true, model: true, mined: true })} api={api()} onQueued={() => {}}/>);
  expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  expect((screen.getByRole("button", { name: "Find problems now" }) as HTMLButtonElement).disabled).toBe(false);
  rerender(<SetupGuide data={data({ worker: true, model: true, mined: true, minerQueued: true })} api={api()} onQueued={() => {}}/>);
  expect((screen.getByRole("button", { name: "Looking for problems…" }) as HTMLButtonElement).disabled).toBe(true);
});
