// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupGuide, searchStatus } from "../../src/ui/setup-guide.js";
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
  expect(queued).toHaveBeenCalled();
});

it("folds into a quiet Find problems control after setup, and shows when a search is already running", () => {
  const { rerender } = render(<SetupGuide data={data({ worker: true, model: true, mined: true })} api={api()} onQueued={() => {}}/>);
  expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  expect((screen.getByRole("button", { name: "Find problems now" }) as HTMLButtonElement).disabled).toBe(false);
  rerender(<SetupGuide data={data({ worker: true, model: true, mined: true, minerQueued: true })} api={api()} onQueued={() => {}}/>);
  expect((screen.getByRole("button", { name: "Looking for problems…" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows the execution settings inside the guide only until a worker and model are chosen", () => {
  const settings = <div>Execution settings</div>;
  const { rerender } = render(<SetupGuide data={data({ worker: true })} api={api()} onQueued={() => {}} settings={settings}/>);
  expect(screen.getByText("Execution settings")).toBeTruthy();
  rerender(<SetupGuide data={data({ worker: true, model: true })} api={api()} onQueued={() => {}} settings={settings}/>);
  expect(screen.queryByText("Execution settings")).toBeNull();
});

it("says whether a search is running or how the last one ended", () => {
  const now = 10 * 60_000, at = now - 5 * 60_000, base = data({ worker: true, model: true, mined: true }).setup!;
  expect(searchStatus({ ...base, minerQueued: true }, now)).toBe("Looking for problems in your recent threads…");
  expect(searchStatus({ ...base, lastSearch: { status: "succeeded", endedAtMs: at, sessions: 2, problems: 0, votes: 0, error: null } }, now)).toBe("Last search 5 min ago: looked at 2 conversations and found nothing new.");
  expect(searchStatus({ ...base, lastSearch: { status: "succeeded", endedAtMs: at, sessions: 9, problems: 3, votes: 4, error: null } }, now)).toBe("Last search 5 min ago: looked at 9 conversations and found 3 new problems.");
  expect(searchStatus({ ...base, lastSearch: { status: "failed", endedAtMs: at, sessions: 0, problems: 0, votes: 0, error: "invalid-model-json" } }, now)).toBe("Last search failed 5 min ago: the model's answer couldn't be read. Try again.");
  expect(searchStatus(base, now)).toBeNull();
});
