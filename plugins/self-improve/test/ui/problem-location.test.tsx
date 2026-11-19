// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProblemLocationSection } from "../../src/ui/problem-location.js";
import type { DashboardApi } from "../../src/ui/types.js";
import { problem } from "../domain/fixtures.js";

afterEach(cleanup);
it("offers a report and an issue link when the cause is in a plugin", async () => {
  const problemReport = vi.fn(async () => ({ title: "Watch never fires", body: "## What happens\n- Watch never fires", issueUrl: "https://github.com/org/repo/issues/new?title=x" }));
  render(<ProblemLocationSection api={{ problemReport } as unknown as DashboardApi} problem={{ ...problem(), location: { kind: "plugin", name: "github-watcher" } }}/>);
  expect(screen.getByText("A plugin: github-watcher")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Write a report" }));
  expect(await screen.findByText(/Watch never fires/, { selector: "pre" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open an issue" }).getAttribute("href")).toBe("https://github.com/org/repo/issues/new?title=x");
  expect(problemReport).toHaveBeenCalledWith({ problemId: "p-a" });
});
it("shows the location without a report when the agent's own behaviour is the cause", () => {
  render(<ProblemLocationSection api={{ problemReport: vi.fn() } as unknown as DashboardApi} problem={{ ...problem(), location: { kind: "agent", name: null } }}/>);
  expect(screen.getByText("How the agent worked")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Write a report" })).toBeNull();
});
