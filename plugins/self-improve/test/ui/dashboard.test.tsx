// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Dashboard } from "../../src/ui/dashboard.js";
import type { PortabilityDeclaration } from "../../src/domain/types.js";
import type { DashboardApi, DashboardData } from "../../src/ui/types.js";
import { problem, solution, vote } from "../domain/fixtures.js";

afterEach(cleanup);
function data(): DashboardData {
  const p = problem(); p.solutionIds = ["s-active", "s-draft"];
  const active = { ...solution("s-active"), status: "proven" as const, candidateState: "built" as const };
  const draft = { ...solution("s-draft"), title: "Check retry inputs", candidateState: "eligible" as const };
  return { problems: [p], solutions: [active, draft], ranking: [], runs: [], versions: { "solutions:s-active": 4 },
    health: { enabled: true, issues: [] }, costs: { totals: [{ currency: "USD", reportedMicros: 0, estimatedMicros: 1_250_000, unknownAttempts: 2, attempts: 3 }] }, votes: [vote()], retests: [] };
}
function setup(snapshot = data(), overrides: Partial<DashboardApi> = {}, projectId: string|null = "project-1") {
  const api: DashboardApi = { dashboard: vi.fn(async () => snapshot), retest: vi.fn(async () => ({ jobId: "job-retest" })), startChat: vi.fn(async () => ({ threadId: "chat-1" })), createObjective: vi.fn(async () => ({ id: "p-new" })), performance: vi.fn(async () => ({ points: [] })), exportSolution: vi.fn(async () => ({ artifactId: "artifact-1", files: [{path:"SKILL.md",content:"# A useful solution"}], status: "draft" as const, bundleSha256: "a".repeat(64) })), publishExport: vi.fn(async () => ({status:"submitted-for-review" as const,url:"https://github.com/example/plugins/pull/1"})), ...overrides };
  render(<Dashboard api={api} projectId={projectId} refreshKey={0} renderChat={id => <div data-testid="native-chat">{id}</div>} onOpenThread={vi.fn()} />);
  return api;
}
it("shows an honest first-run state with no invented findings", async () => {
  setup({ ...data(), problems: [], solutions: [], costs: { totals: [] } });
  await screen.findByText("No problems recorded yet");
  expect(screen.getByText("No cost records yet")).toBeTruthy();
  expect(screen.queryByText("Retain request payload across retry")).toBeNull();
});
it("explores real symptom evidence and linked solutions across tabs", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: /Open problem.*Retries lose/ }));
  expect(screen.getByRole("heading", { name: "What happened" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open thread thread-a" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View solution Retain request payload across retry" }));
  expect(screen.getByRole("tab", { name: /Established/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("heading", { name: "Retain request payload across retry" })).toBeTruthy();
  expect(screen.getByText("2 unknown cost records")).toBeTruthy();
});
it("filters text and distinguishes an empty filter from an empty ledger", async () => {
  setup(); await screen.findByRole("button", { name: /Open problem/ });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search ledgers" }), { target: { value: "not present" } });
  expect(screen.getByText("No matches")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("button", { name: /Open problem/ })).toBeTruthy();
});
it("queues a re-test once with the displayed version and keeps earlier evidence", async () => {
  let resolve!: (v: {jobId:string}) => void;
  const retest = vi.fn(() => new Promise<{jobId:string}>(r => { resolve = r; }));
  const api = setup(data(), { retest });
  fireEvent.click(await screen.findByRole("tab", { name: /Established/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Retain/ }));
  fireEvent.click(screen.getByRole("button", { name: "Re-test solution" }));
  expect((screen.getByRole("button", { name: "Queuing re-test…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.retest).toHaveBeenCalledExactlyOnceWith({ solutionId: "s-active", expectedVersion: 4, reason: "Requested from the solution dashboard" });
  resolve({ jobId: "job-retest" });
  await screen.findByText("Re-test queued. Earlier results are preserved.");
  expect(screen.getAllByText("Measured improvement").length).toBeGreaterThan(0);
});
it("keeps a rejected re-test visible and refreshes stale versions", async () => {
  const api = setup(data(), { retest: vi.fn(async () => { throw new Error("Record changed; reload before editing"); }) });
  fireEvent.click(await screen.findByRole("tab", { name: /Established/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Retain/ }));
  fireEvent.click(screen.getByRole("button", { name: "Re-test solution" }));
  await screen.findByText("Record changed; reload before editing");
  expect(api.dashboard).toHaveBeenCalledTimes(2);
});
it("opens real scoped chat using the entity and project, without widening permissions", async () => {
  const api = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Open problem/ }));
  fireEvent.click(screen.getByRole("button", { name: "Explore and edit in chat" }));
  await screen.findByTestId("native-chat");
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith({ kind: "problem", id: "p-a", projectId: "project-1" });
  expect(within(screen.getByTestId("native-chat")).getByText("chat-1")).toBeTruthy();
});
it("surfaces loading errors with a working retry", async () => {
  const call = vi.fn<DashboardApi["dashboard"]>().mockRejectedValueOnce(new Error("Service unavailable")).mockResolvedValue(data());
  setup(data(), { dashboard: call });
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: /Open problem/ });
  expect(call).toHaveBeenCalledTimes(2);
});
it("does not insert an old chat into a newly selected entity", async () => {
  let resolve!: (v: {threadId:string}) => void;
  setup(data(), { startChat: vi.fn(() => new Promise<{threadId:string}>(r => { resolve = r; })) });
  fireEvent.click(await screen.findByRole("button", { name: /Open problem/ }));
  fireEvent.click(screen.getByRole("button", { name: "Explore and edit in chat" }));
  fireEvent.click(screen.getByRole("tab", { name: /Testing/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Check/ }));
  resolve({ threadId: "old-chat" });
  await waitFor(() => expect(screen.queryByTestId("native-chat")).toBeNull());
});
it("records a manually entered optimization goal with an explicit metric and priority", async () => {
  const api = setup(); await screen.findByRole("button", { name: /Open problem/ });
  fireEvent.click(screen.getByRole("button", { name: "Add problem / goal" }));
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "goal" } });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: " Faster feedback " } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Reduce time to run the targeted tests." } });
  fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "focus" } });
  fireEvent.change(screen.getByLabelText("Metric name"), { target: { value: "Feedback time in seconds" } });
  fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "seconds" } });
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to ledger" }));
  await screen.findByText("Added to the ledger. It is ready to explore.");
  expect(api.createObjective).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), kind: "goal", title: "Faster feedback", description: "Reduce time to run the targeted tests.", priority: "focus", metric: { name: "Feedback time in seconds", unit: "seconds", target: 30, direction: "lower" } });
});
it("preserves a failed objective draft for correction", async () => {
  setup(data(), { createObjective: vi.fn(async () => { throw new Error("Ledger is busy"); }) });
  fireEvent.click(await screen.findByRole("button", { name: "Add problem / goal" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep this draft" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A useful improvement" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to ledger" }));
  await screen.findByText("Ledger is busy");
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Keep this draft");
});
it("shows insufficient performance honestly and displays recorded exposures and confounders", async () => {
  const performance = vi.fn<DashboardApi["performance"]>().mockResolvedValueOnce({ points: [] }).mockResolvedValueOnce({ points: [
    { id: "baseline", solutionId: "s-active", atMs: 1000, phase: "baseline", votes: 3, sessions: 10, rate: .3, confounders: ["Provider changed"], costs: [] },
    { id: "after", solutionId: "s-active", atMs: 2000, phase: "after", votes: 0, sessions: 0, rate: null, confounders: [], costs: [{currency:"USD",reportedMicros:1_000_000,estimatedMicros:0,unknownAttempts:1}] },
  ] });
  setup(data(), { performance });
  fireEvent.click(await screen.findByRole("tab", { name: "Performance" }));
  await screen.findByText("No performance observations yet");
  fireEvent.change(screen.getByLabelText("Solution"), { target: { value: "s-active" } });
  await screen.findByText("Insufficient exposure");
  expect(screen.getByText("Provider changed")).toBeTruthy();
  expect(screen.getByText("1.0000 USD + 1 unknown")).toBeTruthy();
  expect(screen.getByText("At least two measured windows are needed to see a trend.")).toBeTruthy();
  expect(performance).toHaveBeenLastCalledWith({ solutionId: "s-active" });
});
it("exports a reviewable draft with text-safe file previews and the displayed version", async () => {
  const api = setup(data(), { exportSolution: vi.fn<DashboardApi["exportSolution"]>(async () => ({artifactId:"artifact-1",status:"draft",bundleSha256:"a".repeat(64),files:[{path:"SKILL.md",content:"<script>alert('bad')</script>"}]})) });
  fireEvent.click(await screen.findByRole("tab", { name: /Established/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Retain/ }));
  fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "plugin" } });
  fireEvent.click(screen.getByRole("button", { name: "Export solution" }));
  await screen.findByText("Draft ready · 1 file. Review the files before sharing or installing.");
  expect(api.exportSolution).toHaveBeenCalledExactlyOnceWith({ solutionId: "s-active", format: "plugin", expectedVersion: 4 });
  expect(screen.getByText("<script>alert('bad')</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
});
it("supports keyboard tab navigation without trapping focus", async () => {
  setup(); const problems = await screen.findByRole("tab", { name: /Problems/ }); problems.focus();
  fireEvent.keyDown(problems, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Performance" }));
  expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(problems);
});
it("keeps re-testing available when an adopted solution needs attention", async () => {
  const snapshot = data(); snapshot.solutions[0]!.status = "fixing";
  const api = setup(snapshot);
  fireEvent.click(await screen.findByRole("tab", { name: /Testing/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Retain/ }));
  fireEvent.click(screen.getByRole("button", { name: "Re-test solution" }));
  await screen.findByText("Re-test queued. Earlier results are preserved.");
  expect(api.retest).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Export solution" })).toBeNull();
});
it("shows an owner goal's title and target without creating observed votes", async () => {
  const snapshot = data(); snapshot.votes = [];
  snapshot.objectives = [{id:"objective-1",problemId:"p-a",kind:"goal",title:"Faster feedback",description:"Reduce the wait for targeted tests",metric:{name:"Feedback time",unit:"seconds",target:30,direction:"lower"},focus:{priority:5}}];
  setup(snapshot);
  fireEvent.change(await screen.findByRole("searchbox", { name: "Search ledgers" }), { target: { value: "Faster feedback" } });
  fireEvent.click(screen.getByRole("button", { name: "Open problem Faster feedback" }));
  expect(screen.getByText("Owner optimization goal")).toBeTruthy();
  expect(screen.getByText("Target 30 seconds · lower is better")).toBeTruthy();
  expect(screen.getByText("No vote evidence recorded for this problem.")).toBeTruthy();
});
it("opens ledger chat in the configured worker project from a projectless navigation page", async () => {
  const snapshot = data(); snapshot.health.workerProjectId="configured-worker-project";
  const api = setup(snapshot, {}, null);
  fireEvent.click(await screen.findByRole("button", { name: /Open problem/ }));
  fireEvent.click(screen.getByRole("button", { name: "Explore and edit in chat" }));
  await screen.findByTestId("native-chat");
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith({kind:"problem",id:"p-a",projectId:"configured-worker-project"});
});
it("creates a draft PR only after explicit review of an exact bundle and allowed destination", async () => {
  const snapshot=data(); snapshot.health.publicationRepositories=["example/plugins"];
  let resolve!: (result:{status:"submitted-for-review";url:string})=>void;
  const publishExport=vi.fn(()=>new Promise<{status:"submitted-for-review";url:string}>(r=>{resolve=r;}));
  const api=setup(snapshot,{publishExport});
  fireEvent.click(await screen.findByRole("tab",{name:/Established/}));
  fireEvent.click(screen.getByRole("button",{name:/Open solution Retain/}));
  fireEvent.click(screen.getByRole("button",{name:"Export solution"}));
  const publish=await screen.findByRole("button",{name:"Create draft PR"});
  expect(publish).toHaveProperty("disabled",true);
  fireEvent.change(screen.getByLabelText("New directory"),{target:{value:"plugins/retry-improvement"}});
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these files, evidence and destination."}));
  fireEvent.click(publish);
  expect(screen.getByRole("button",{name:"Creating draft PR…"})).toHaveProperty("disabled",true);
  expect(api.publishExport).toHaveBeenCalledExactlyOnceWith({artifactId:"artifact-1",repository:"example/plugins",directory:"plugins/retry-improvement",bundleSha256:"a".repeat(64),reviewed:true});
  resolve({status:"submitted-for-review",url:"https://github.com/example/plugins/pull/42"});
  const link=await screen.findByRole("link",{name:"Open draft PR"});
  expect(link.getAttribute("href")).toBe("https://github.com/example/plugins/pull/42");
});
it("keeps unconfigured publication unavailable and does not expose a custom repository input", async () => {
  const api=setup();
  fireEvent.click(await screen.findByRole("tab",{name:/Established/}));
  fireEvent.click(screen.getByRole("button",{name:/Open solution Retain/}));
  fireEvent.click(screen.getByRole("button",{name:"Export solution"}));
  await screen.findByText(/Configure an allowed publication repository/);
  expect(screen.queryByRole("button",{name:"Create draft PR"})).toBeNull();
  expect(api.publishExport).not.toHaveBeenCalled();
});
it("rejects a traversal destination and keeps a failed publication draft for retry", async () => {
  const snapshot=data(); snapshot.health.publicationRepositories=["example/plugins"];
  const api=setup(snapshot,{publishExport:vi.fn(async()=>{throw new Error("Repository destination already exists");})});
  fireEvent.click(await screen.findByRole("tab",{name:/Established/}));
  fireEvent.click(screen.getByRole("button",{name:/Open solution Retain/}));
  fireEvent.click(screen.getByRole("button",{name:"Export solution"}));
  await screen.findByRole("button",{name:"Create draft PR"});
  fireEvent.change(screen.getByLabelText("New directory"),{target:{value:"../outside"}});
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these files, evidence and destination."}));
  expect(screen.getByRole("button",{name:"Create draft PR"})).toHaveProperty("disabled",true);
  expect(api.publishExport).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("New directory"),{target:{value:"plugins/my-improvement"}});
  expect(screen.getByRole("checkbox",{name:"I reviewed these files, evidence and destination."})).toHaveProperty("checked",false);
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these files, evidence and destination."}));
  fireEvent.click(screen.getByRole("button",{name:"Create draft PR"}));
  await screen.findByText("Repository destination already exists");
  expect(screen.getByText("SKILL.md")).toBeTruthy();
});
it("does not turn an invalid publication response into an unsafe or unrelated link", async () => {
  const snapshot=data(); snapshot.health.publicationRepositories=["example/plugins"];
  setup(snapshot,{publishExport:vi.fn(async()=>({status:"submitted-for-review" as const,url:"javascript:alert(1)"}))});
  fireEvent.click(await screen.findByRole("tab",{name:/Established/}));
  fireEvent.click(screen.getByRole("button",{name:/Open solution Retain/}));
  fireEvent.click(screen.getByRole("button",{name:"Export solution"}));
  await screen.findByRole("button",{name:"Create draft PR"});
  fireEvent.click(screen.getByRole("checkbox",{name:"I reviewed these files, evidence and destination."}));
  fireEvent.click(screen.getByRole("button",{name:"Create draft PR"}));
  await screen.findByText(/review link could not be verified/);
  expect(screen.queryByRole("link",{name:"Open draft PR"})).toBeNull();
  expect(screen.getByRole("button",{name:"Submitted for review"})).toHaveProperty("disabled",true);
});
it("includes unknown infrastructure costs without labeling them as model attempts", async () => {
  const snapshot=data(); snapshot.costs.totals[0]!.unknownExternalCosts=3;
  setup(snapshot);
  await screen.findByText("5 unknown cost records");
  expect(screen.queryByText(/5 attempts/)).toBeNull();
  expect(screen.getByText(/Owner-reported charges \+ estimates/)).toBeTruthy();
});
it("shows unmetered research requests separately from monetary totals", async () => {
  const snapshot=data();snapshot.costs.unmeteredAccessRequests=3;setup(snapshot);
  await screen.findByText("3 research access requests without per-request prices");
  expect(screen.getByText("$1.25")).toBeTruthy();
  expect(screen.getByText("2 unknown cost records")).toBeTruthy();
});

it("resolves chat again when reopening so a revoked cached thread is not reused", async () => {
  const startChat = vi.fn<DashboardApi["startChat"]>().mockResolvedValueOnce({ threadId: "old-policy-chat" }).mockResolvedValueOnce({ threadId: "current-policy-chat" });
  setup(data(), { startChat });
  fireEvent.click(await screen.findByRole("button", { name: /Open problem/ }));
  fireEvent.click(screen.getByRole("button", { name: "Explore and edit in chat" }));
  await screen.findByText("old-policy-chat");
  fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Explore and edit in chat" }));
  await screen.findByText("current-policy-chat");
  expect(startChat).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("old-policy-chat")).toBeNull();
});


function portabilityDeclaration(scope = "BB retry skill"): PortabilityDeclaration {
  return {
    schemaVersion: 1, status: "unverified", scope, dependencyStatus: "declared",
    requirements: [
      { kind: "skill", identity: "retry-helper", versionConstraint: ">=2 <3", setup: "Install the declared skill and enable its retry trigger" },
      { kind: "capability", identity: "Persisted input storage", versionConstraint: null, setup: "Supply storage through the host; exact configuration unknown" },
    ],
    assumptions: ["Retry input can be serialized"],
    testProposal: { minimalEnvironment: "Use minimal supported BB plus only retry-helper and declared storage", packagedArtifact: "Install the packaged skill and exercise its retry trigger" },
    untestedConfigurations: ["Another provider", "A different storage configuration"],
  };
}
async function openPortability(snapshot: DashboardData) {
  setup(snapshot);
  fireEvent.click(await screen.findByRole("tab", { name: /Established/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Retain/ }));
  return within(screen.getByRole("region", { name: "Portability" }));
}
it("shows historical portability as unknown with no fabricated tested environment", async () => {
  const view = await openPortability(data());
  expect(view.getByText("Unknown · no declaration")).toBeTruthy();
  for (const label of ["Requires", "Tested on", "Not yet tested"]) expect(view.getByRole("heading", { name: label })).toBeTruthy();
  expect(view.getByText("Requirements are unknown. This record has no portability declaration.")).toBeTruthy();
  expect(view.getByText("No verified environment is recorded.")).toBeTruthy();
  expect(view.getByText("Untested configurations have not been specified.")).toBeTruthy();
  expect(view.queryByText("Proposed portability checks")).toBeNull();
});
it("shows the exact portability scope, dependency identity, version, setup and proposed checks", async () => {
  const snapshot = data(), declaration = portabilityDeclaration(); snapshot.solutions[0]!.portability = declaration;
  const view = await openPortability(snapshot);
  expect(view.getByText("Unverified declaration")).toBeTruthy();
  expect(view.getByText(declaration.scope)).toBeTruthy();
  for (const requirement of declaration.requirements) {
    expect(view.getByText(requirement.identity)).toBeTruthy();
    expect(view.getByText(requirement.setup)).toBeTruthy();
  }
  expect(view.getByText("Skill · Version constraint: >=2 <3")).toBeTruthy();
  expect(view.getByText("Capability · Version requirement unknown")).toBeTruthy();
  for (const configuration of declaration.untestedConfigurations) expect(view.getByText(configuration)).toBeTruthy();
  fireEvent.click(view.getByText("Proposed portability checks"));
  expect(view.getByText(declaration.testProposal.minimalEnvironment)).toBeTruthy();
  expect(view.getByText(declaration.testProposal.packagedArtifact)).toBeTruthy();
  expect(view.getByText(declaration.assumptions[0]!)).toBeTruthy();
  expect(view.getByText(/Ordinary BB, provider, user and workspace context may have been available/)).toBeTruthy();
});
it("keeps none-known portability requirements distinct from a tested independence claim", async () => {
  const snapshot = data();
  snapshot.solutions[0]!.portability = { ...portabilityDeclaration(), dependencyStatus: "none-known", requirements: [], untestedConfigurations: [], assumptions: [] };
  const view = await openPortability(snapshot);
  expect(view.getByText("No dependencies are known to the proposer. This does not establish independence.")).toBeTruthy();
  expect(view.getByText("Unverified declaration")).toBeTruthy();
  expect(view.getByText("No verified environment is recorded.")).toBeTruthy();
  expect(view.getByText("Untested configurations have not been specified.")).toBeTruthy();
  fireEvent.click(view.getByText("Proposed portability checks"));
  expect(view.getByText("No portability assumptions were declared.")).toBeTruthy();
});
it("keeps incomplete portability dependency knowledge explicit while showing declared requirements", async () => {
  const snapshot = data(); snapshot.solutions[0]!.portability = { ...portabilityDeclaration(), dependencyStatus: "unknown" };
  const view = await openPortability(snapshot);
  expect(view.getByText("Dependency information is incomplete. Any known requirements are listed below.")).toBeTruthy();
  expect(view.getByText("retry-helper")).toBeTruthy();
  expect(view.getByText("Capability · Version requirement unknown")).toBeTruthy();
});
it("does not promote recorded solution success or provider identity into portability evidence", async () => {
  const snapshot = data(), selected = snapshot.solutions[0]!;
  selected.portability = portabilityDeclaration();
  selected.builtWith = { provider: "build-provider", model: "build-model" };
  selected.validatedWith = { provider: "validation-provider", model: "validation-model" };
  selected.wiring = { location: "installed-skill", activatedAtMs: 1, executionCount: 100, undo: "Disable the skill" };
  const view = await openPortability(snapshot);
  expect(view.getByText("Unverified declaration")).toBeTruthy();
  expect(view.getByText("No verified environment is recorded.")).toBeTruthy();
  expect(view.queryByText(/build-provider|validation-provider|Measured improvement|installed-skill/)).toBeNull();
});
it("shows only the selected solution's portability declaration without combining other variants", async () => {
  const snapshot = data();
  snapshot.solutions[0]!.portability = portabilityDeclaration("Original variant scope");
  snapshot.solutions[1]!.portability = { ...portabilityDeclaration("Alternative variant scope"), requirements: [{ kind: "plugin", identity: "different-plugin", versionConstraint: "1.x", setup: "Enable different-plugin wiring" }] };
  const first = await openPortability(snapshot);
  expect(first.getByText("retry-helper")).toBeTruthy();
  expect(first.queryByText("different-plugin")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /Testing/ }));
  fireEvent.click(screen.getByRole("button", { name: /Open solution Check/ }));
  const second = within(screen.getByRole("region", { name: "Portability" }));
  expect(second.getByText("Alternative variant scope")).toBeTruthy();
  expect(second.getByText("different-plugin")).toBeTruthy();
  expect(second.getByText("Plugin · Version constraint: 1.x")).toBeTruthy();
  expect(second.getByText("Enable different-plugin wiring")).toBeTruthy();
  expect(second.queryByText("retry-helper")).toBeNull();
  expect(second.queryByText("Original variant scope")).toBeNull();
});

it("includes retained aliases once in the displayed solution cost without changing original attribution", async () => {
  const snapshot=data(); snapshot.solutions[0]!.aliases=["old","old"];
  snapshot.costs.events=[
    {solutionId:"s-active",currency:"USD",amountMicros:1_000_000,basis:"reported",status:"completed"},
    {solutionId:"old",currency:"USD",amountMicros:2_000_000,basis:"estimated",status:"completed"},
    {solutionId:"old",currency:"USD",amountMicros:null,basis:"unknown",status:"failed"},
    {solutionId:"s-draft",currency:"USD",amountMicros:50_000_000,basis:"reported",status:"completed"},
  ];
  const original=structuredClone(snapshot.costs.events); setup(snapshot);
  fireEvent.click(await screen.findByRole("tab",{name:/Established/}));
  fireEvent.click(screen.getByRole("button",{name:/Open solution Retain/}));
  const section=screen.getByRole("heading",{name:"Cost of this solution"}).closest("section")!;
  expect(within(section).getByText(/Includes retained solution aliases/)).toBeTruthy();
  expect(within(section).getByText(new Intl.NumberFormat(undefined,{style:"currency",currency:"USD"}).format(3))).toBeTruthy();
  expect(within(section).getByText(/1 unknown/)).toBeTruthy();
  expect(snapshot.costs.events).toEqual(original);
});
