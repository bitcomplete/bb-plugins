// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PublicationStatus } from "../../src/ui/publication-status.js";
import { Performance } from "../../src/ui/performance.js";
import type { PublicationApi, PublicationSummary } from "../../src/publication-view.js";
import type { PublicationObservation } from "../../src/publication-state.js";
import type { DashboardApi } from "../../src/ui/types.js";
import { solution } from "../domain/fixtures.js";

afterEach(cleanup);
function observation(sequence = 1, extra: Partial<PublicationObservation> = {}): PublicationObservation {
  return { id: `observation-${sequence}`, publicationId: "publication", draftId: "draft", solutionId: "solution", revision: "r1", bundleSha256: "a".repeat(64),
    sequence, observedAtMs: Date.UTC(2026, 10, 18, 12, sequence), releaseTag: null,
    review: { state: "merged", url: "https://github.com/org/repo/pull/7", headCommit: "b".repeat(40), submittedCommitChanged: false },
    repository: { state: "available", commit: "c".repeat(40), url: `https://github.com/org/repo/tree/${"c".repeat(40)}/plugins/fix` },
    release: { state: "not-requested", tag: null, commit: null, url: null, prerelease: null }, issues: [], ...extra };
}
function publication(extra: Partial<PublicationSummary> = {}): PublicationSummary {
  return { id: "publication", solutionId: "solution", revision: "r1", draftId: "draft", repository: "org/repo", directory: "plugins/fix", submission: "submitted-for-review", url: "https://github.com/org/repo/pull/7", latest: null, ...extra };
}
function fixture(records = [publication()]) {
  return { publications: vi.fn(async (_input: { solutionId?: string }) => ({ publications: records })),
    publicationHistory: vi.fn(async (_input: { publicationId: string }) => ({ observations: records.flatMap(record => record.latest ? [record.latest] : []) })),
    reconcilePublication: vi.fn(async (_input: { publicationId: string; releaseTag?: string }) => observation()),
  } satisfies PublicationApi;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("loads saved submissions and local history without checking remote state", async () => {
  const api = fixture(); render(<PublicationStatus api={api} refreshKey={0}/>);
  await screen.findByText(/Submission: Submitted for review/);
  expect(screen.getByText(/No remote observation recorded/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open submitted PR" }).getAttribute("href")).toBe("https://github.com/org/repo/pull/7");
  expect(api.publications).toHaveBeenCalledWith({}); expect(api.reconcilePublication).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show recorded history" }));
  await screen.findByText("No recorded remote observations.");
  expect(api.publicationHistory).toHaveBeenCalledWith({ publicationId: "publication" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved records" }));
  await waitFor(() => expect(api.publications).toHaveBeenCalledTimes(2));
  expect(api.reconcilePublication).not.toHaveBeenCalled();
});
it("keeps merged review, exact repository content and an unchecked release distinct", async () => {
  const api = fixture([publication({ latest: observation() })]); render(<PublicationStatus api={api} refreshKey={0}/>);
  await screen.findByText(/Exact bundle confirmed at merge commit/);
  expect(screen.getByText(/PR merged/)).toBeTruthy(); expect(screen.getByText("Release not checked")).toBeTruthy();
  expect(screen.getByText(/Remote observation:/)).toBeTruthy(); expect(screen.getByText(/Ledger loaded:/)).toBeTruthy();
  expect(screen.queryByText(/^Published$/)).toBeNull(); expect(api.reconcilePublication).not.toHaveBeenCalled();
});
it("checks only on owner action, passes the optional tag, and prevents duplicate in-flight dispatch", async () => {
  const api = fixture(), pending = deferred<PublicationObservation>(); api.reconcilePublication.mockImplementation(() => pending.promise);
  render(<PublicationStatus api={api} refreshKey={0}/>); await screen.findByRole("button", { name: "Check publication" });
  fireEvent.change(screen.getByRole("textbox", { name: "Release tag (optional)" }), { target: { value: "v1" } });
  fireEvent.click(screen.getByRole("button", { name: "Check publication" })); fireEvent.click(screen.getByRole("button", { name: "Checking publication…" }));
  expect(api.reconcilePublication).toHaveBeenCalledTimes(1); expect(api.reconcilePublication).toHaveBeenCalledWith({ publicationId: "publication", releaseTag: "v1" });
  await act(async () => pending.resolve(observation(1, { releaseTag: "v1", release: { state: "released", tag: "v1", commit: "d".repeat(40), url: "https://github.com/org/repo/releases/tag/v1", prerelease: true } })));
  expect(screen.getByText(/Release contains exact bundle/)).toBeTruthy(); expect(screen.getByText(/Prerelease/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open release" })).toBeTruthy();
});
it("rejects invalid release tags without dispatch and omits an empty tag", async () => {
  const api = fixture(); render(<PublicationStatus api={api} refreshKey={0}/>);
  const input = await screen.findByRole("textbox", { name: "Release tag (optional)" });
  for (const value of ["bad tag", "x".repeat(201)]) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("button", { name: "Check publication" })).toHaveProperty("disabled", true);
  }
  expect(api.reconcilePublication).not.toHaveBeenCalled(); fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Check publication" }));
  await waitFor(() => expect(api.reconcilePublication).toHaveBeenCalledWith({ publicationId: "publication" }));
});
it("preserves confirmed past history when a newer remote observation is unknown", async () => {
  const prior = observation(), unknown = observation(2, { review: { state: "unknown", url: null, headCommit: null, submittedCommitChanged: null }, repository: { state: "unconfirmed", commit: null, url: null }, issues: ["review-or-merged-content-not-confirmed"] });
  const api = fixture([publication({ latest: prior })]); api.reconcilePublication.mockResolvedValue(unknown);
  render(<PublicationStatus api={api} refreshKey={0}/>); await screen.findByText(/Exact bundle confirmed at merge commit/);
  fireEvent.click(screen.getByRole("button", { name: "Check publication" })); await screen.findByText("Review not confirmed");
  expect(screen.getByText(/Past confirmations remain in recorded history/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show recorded history" }));
  const history = screen.getByRole("region", { name: "Recorded publication history" });
  await waitFor(() => expect(within(history).getByText(/Exact bundle confirmed at merge commit/)).toBeTruthy());
  expect(within(history).getByText(/Check 1/)).toBeTruthy(); expect(within(history).getByText(/Check 2/)).toBeTruthy();
  expect(api.reconcilePublication).toHaveBeenCalledTimes(1);
});
it("keeps loaded records and observations on local refresh, history, and remote-check errors", async () => {
  const api = fixture([publication({ latest: observation() })]); const view = render(<PublicationStatus api={api} refreshKey={0}/>);
  await screen.findByText(/Exact bundle confirmed at merge commit/); fireEvent.click(screen.getByRole("button", { name: "Show recorded history" }));
  await screen.findByText(/Check 1/); api.publications.mockRejectedValue(new Error("Ledger unavailable"));
  view.rerender(<PublicationStatus api={api} refreshKey={1}/>); await screen.findByText(/Showing the last loaded records/);
  api.publicationHistory.mockRejectedValue(new Error("History unavailable")); fireEvent.click(screen.getByRole("button", { name: "Refresh recorded history" }));
  await screen.findByText(/History unavailable/); expect(screen.getByText(/Check 1/)).toBeTruthy();
  api.reconcilePublication.mockRejectedValue(new Error("x".repeat(800))); fireEvent.click(screen.getByRole("button", { name: "Check publication" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check publication" })).toHaveProperty("disabled", false));
  expect(screen.getAllByText(/Exact bundle confirmed at merge commit/)).toHaveLength(2);
  expect(screen.getByText(/x{30}/).textContent!.length).toBeLessThan(550);
});
it("ignores older list responses after a solution change", async () => {
  const pending = deferred<{ publications: PublicationSummary[] }>(), api = fixture();
  api.publications.mockImplementation(input => input.solutionId === "old" ? pending.promise : Promise.resolve({ publications: [publication({ solutionId: "new", directory: "plugins/new" })] }));
  const view = render(<PublicationStatus api={api} solutionId="old" refreshKey={0}/>);
  view.rerender(<PublicationStatus api={api} solutionId="new" refreshKey={0}/>); await screen.findByText("org/repo / plugins/new");
  await act(async () => pending.resolve({ publications: [publication({ solutionId: "old", directory: "plugins/old" })] }));
  expect(screen.queryByText("org/repo / plugins/old")).toBeNull();
});
it("ignores an old selection's pending check and history responses", async () => {
  const check = deferred<PublicationObservation>(), history = deferred<{ observations: PublicationObservation[] }>(), api = fixture();
  api.publications.mockImplementation(async input => ({ publications: [publication({ solutionId: input.solutionId!, directory: `plugins/${input.solutionId}` })] }));
  api.reconcilePublication.mockImplementation(() => check.promise); api.publicationHistory.mockImplementation(() => history.promise);
  const view = render(<PublicationStatus api={api} solutionId="old" refreshKey={0}/>); await screen.findByRole("button", { name: "Check publication" });
  fireEvent.click(screen.getByRole("button", { name: "Check publication" })); fireEvent.click(screen.getByRole("button", { name: "Show recorded history" }));
  view.rerender(<PublicationStatus api={api} solutionId="new" refreshKey={0}/>); await screen.findByText("org/repo / plugins/new");
  await act(async () => { check.resolve(observation(1, { solutionId: "old" })); history.resolve({ observations: [observation(1, { solutionId: "old" })] }); });
  expect(screen.getByText(/No remote observation recorded/)).toBeTruthy(); expect(screen.queryByText(/Exact bundle confirmed/)).toBeNull();
});
it("does not replace a successful check with an older local refresh response", async () => {
  const api = fixture([publication({ latest: observation(1) })]), pending = deferred<{ publications: PublicationSummary[] }>();
  const view = render(<PublicationStatus api={api} refreshKey={0}/>); await screen.findByText(/Exact bundle confirmed at merge commit/);
  api.publications.mockImplementation(() => pending.promise); view.rerender(<PublicationStatus api={api} refreshKey={1}/>);
  api.reconcilePublication.mockResolvedValue(observation(2, { repository: { state: "content-changed", commit: "e".repeat(40), url: null } }));
  fireEvent.click(screen.getByRole("button", { name: "Check publication" })); await screen.findByText("Bundle differs at merge commit");
  await act(async () => pending.resolve({ publications: [publication({ latest: observation(1) })] }));
  expect(screen.getByText("Bundle differs at merge commit")).toBeTruthy();
});
it("rejects mismatched check and history identities", async () => {
  const api = fixture(); api.reconcilePublication.mockResolvedValue(observation(1, { publicationId: "different" }));
  api.publicationHistory.mockResolvedValue({ observations: [observation(1, { revision: "other" })] });
  render(<PublicationStatus api={api} refreshKey={0}/>); await screen.findByRole("button", { name: "Check publication" });
  fireEvent.click(screen.getByRole("button", { name: "Check publication" }));
  await screen.findByText(/response does not match/); expect(screen.getByText(/No remote observation recorded/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show recorded history" })); await screen.findByText(/history does not match/);
});
it("shows unavailable and empty states without inventing distribution success", async () => {
  const view = render(<PublicationStatus api={{}} refreshKey={0}/>); expect(screen.getByText(/unavailable in this connection/)).toBeTruthy();
  view.rerender(<PublicationStatus api={fixture([])} refreshKey={0}/>); await screen.findByText(/No publication submissions/);
});
it("wires publication tracking into Performance even without measurements and forwards its selected solution", async () => {
  const api = { ...fixture([]), performance: vi.fn(async () => ({ points: [] })) };
  const selected = { ...solution("chosen"), title: "Chosen improvement" };
  render(<Performance api={api as unknown as DashboardApi} solutions={[selected]} refreshKey={0}/>);
  await screen.findByText("No performance observations yet"); expect(screen.getByRole("region", { name: "Publication status" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Solution" }), { target: { value: "chosen" } });
  await waitFor(() => expect(api.publications).toHaveBeenLastCalledWith({ solutionId: "chosen" }));
  expect(api.reconcilePublication).not.toHaveBeenCalled();
});

it("keeps the all-solutions scope distinct from a solution with the same display-like ID", async () => {
  const api = fixture(), pending = deferred<{ publications: PublicationSummary[] }>();
  const view = render(<PublicationStatus api={api} refreshKey={0}/>); await screen.findByText("org/repo / plugins/fix");
  api.publications.mockImplementation(() => pending.promise);
  view.rerender(<PublicationStatus api={api} solutionId="all-solutions" refreshKey={0}/>);
  expect(screen.queryByText("org/repo / plugins/fix")).toBeNull();
  await act(async () => pending.resolve({ publications: [] }));
  expect(screen.getByText(/No publication submissions/)).toBeTruthy();
});
it("keeps simultaneous publication checks bound to their own records", async () => {
  const first = publication(), second = publication({ id: "second", draftId: "second-draft", directory: "plugins/second", solutionId: "second-solution" });
  const api = fixture([first, second]), one = deferred<PublicationObservation>(), two = deferred<PublicationObservation>();
  api.reconcilePublication.mockImplementation(input => input.publicationId === "publication" ? one.promise : two.promise);
  render(<PublicationStatus api={api} refreshKey={0}/>);
  const firstCard = await screen.findByRole("article", { name: "org/repo / plugins/fix" }), secondCard = screen.getByRole("article", { name: "org/repo / plugins/second" });
  fireEvent.click(within(firstCard).getByRole("button", { name: "Check publication" }));
  fireEvent.click(within(secondCard).getByRole("button", { name: "Check publication" }));
  await act(async () => two.resolve(observation(1, { publicationId: second.id, draftId: second.draftId, solutionId: second.solutionId, repository: { state: "content-changed", commit: "f".repeat(40), url: null } })));
  expect(within(secondCard).getByText("Bundle differs at merge commit")).toBeTruthy();
  expect(within(firstCard).getByRole("button", { name: "Checking publication…" })).toBeTruthy();
  await act(async () => one.resolve(observation()));
  expect(within(firstCard).getByText(/Exact bundle confirmed at merge commit/)).toBeTruthy();
  expect(within(secondCard).queryByText(/Exact bundle confirmed at merge commit/)).toBeNull();
});
