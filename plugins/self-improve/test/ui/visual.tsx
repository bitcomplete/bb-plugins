/** Synthetic records only. This harness is not registered by the plugin. */
import { createRoot } from "react-dom/client";
import { Dashboard } from "../../src/ui/dashboard.js";
import type { PortabilityDeclaration } from "../../src/domain/types.js";
import type { DashboardApi, DashboardData } from "../../src/ui/types.js";
import { problem, solution, vote } from "../domain/fixtures.js";

const p = problem(); p.solutionIds = ["s-active", "s-draft"];
const portability: PortabilityDeclaration = {
  schemaVersion: 1, status: "unverified", scope: "Synthetic BB retry-input skill proposal", dependencyStatus: "declared",
  requirements: [{ kind: "skill", identity: "retry-input-check", versionConstraint: null, setup: "Supply the documented request schema. Required skill version has not been established." }],
  assumptions: ["Request schemas describe the retry payload."],
  testProposal: { minimalEnvironment: "Minimal supported BB with only the declared schema skill; verify missing requirements are reported as unavailable.", packagedArtifact: "Install the packaged skill and verify trigger discovery and invocation with the synthetic retry fixture." },
  untestedConfigurations: ["Other agent hosts", "Other provider and workspace configurations"],
};
const active = { ...solution("s-active"), portability, status: "active" as const, candidateState: "built" as const };
const draft = { ...solution("s-draft"), title: "Check retry inputs before dispatch", candidateState: "eligible" as const };
const data: DashboardData = {
  problems: [p, { ...problem("p-manual"), causes: [{id:"c-manual",text:"Slow feedback may delay corrective action"}], symptoms:[{id:"sym-manual",causeId:"c-manual",text:"Owner-reported goal; no independent observation yet"}], solutionIds: [], category: "owner-optimization-goal" }],
  solutions: [active, draft], votes: [vote()], ranking: [], runs: [], versions: { "solutions:s-active": 4 },
  health: {enabled: false, issues: []}, costs: {unmeteredAccessRequests:3,totals:[{currency:"USD",reportedMicros:0,estimatedMicros:1_250_000,unknownAttempts:2,attempts:3}]},
  objectives:[{id:"o-manual",problemId:"p-manual",kind:"goal",title:"Make the test feedback loop faster",description:"Reduce the wait for a targeted test result.",metric:{name:"Test feedback time",unit:"seconds",target:30,direction:"lower"},focus:{priority:5}}],
};
const api: DashboardApi = {
  dashboard: async () => data,
  startChat: async () => ({threadId:"fixture-chat"}),
  createObjective: async () => ({id:"p-manual"}),
};
createRoot(document.getElementById("root")!).render(<Dashboard api={api} projectId="fixture-project" refreshKey={0} onOpenThread={() => {}} renderChat={() => <p className="si-muted">Native ThreadChat is verified separately with the SDK harness. This isolated visual fixture does not simulate a conversation.</p>}/>);
