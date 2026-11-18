/** Synthetic records only. This harness is not registered by the plugin. */
import { createRoot } from "react-dom/client";
import { Dashboard } from "../../src/ui/dashboard.js";
import type { DashboardApi, DashboardData } from "../../src/ui/types.js";
import { problem, solution, vote } from "../domain/fixtures.js";

const p = problem(); p.solutionIds = ["s-active", "s-draft"];
const active = { ...solution("s-active"), status: "active" as const, candidateState: "built" as const };
const draft = { ...solution("s-draft"), title: "Check retry inputs before dispatch", candidateState: "eligible" as const };
const data: DashboardData = {
  problems: [p, { ...problem("p-manual"), causes: [{id:"c-manual",text:"Slow feedback may delay corrective action"}], symptoms:[{id:"sym-manual",causeId:"c-manual",text:"Owner-reported goal; no independent observation yet"}], solutionIds: [], category: "owner-optimization-goal" }],
  solutions: [active, draft], votes: [vote()], ranking: [], runs: [], versions: { "solutions:s-active": 4 },
  health: {enabled: false, issues: [], publicationRepositories:["example/plugins"]}, costs: {unmeteredAccessRequests:3,totals:[{currency:"USD",reportedMicros:0,estimatedMicros:1_250_000,unknownAttempts:2,attempts:3}]},
  objectives:[{id:"o-manual",problemId:"p-manual",kind:"goal",title:"Make the test feedback loop faster",description:"Reduce the wait for a targeted test result.",metric:{name:"Test feedback time",unit:"seconds",target:30,direction:"lower"},focus:{priority:5}}],
};
const api: DashboardApi = {
  dashboard: async () => data,
  retest: async () => ({jobId:"fixture-retest"}),
  startChat: async () => ({threadId:"fixture-chat"}),
  createObjective: async () => ({id:"p-manual"}),
  performance: async () => ({points:[
    {id:"fixture-baseline",solutionId:"s-active",atMs:Date.UTC(2026,10,4),phase:"baseline",votes:3,sessions:10000,rate:.0003,confounders:["Illustrative fixture; not field evidence"],costs:[{currency:"USD",reportedMicros:0,estimatedMicros:1250000,unknownAttempts:2}]},
    {id:"fixture-after",solutionId:"s-active",atMs:Date.UTC(2026,10,18),phase:"after",votes:2,sessions:10000,rate:.0002,confounders:["Illustrative fixture; not field evidence"],costs:[{currency:"USD",reportedMicros:0,estimatedMicros:1250000,unknownAttempts:2}]},
  ]}),
  publishExport: async () => { throw new Error("Publication is disabled in the illustrative visual fixture."); },
  exportSolution: async () => ({artifactId:"fixture-artifact",status:"draft",bundleSha256:"a".repeat(64),files:[{path:"README.md",content:"Illustrative export for UI validation only."},{path:"EVIDENCE.md",content:"Synthetic visual fixture. No real validation, measured effect or publication is claimed."}]}),
};
createRoot(document.getElementById("root")!).render(<Dashboard api={api} projectId="fixture-project" refreshKey={0} onOpenThread={() => {}} renderChat={() => <p className="si-muted">Native ThreadChat is verified separately with the SDK harness. This isolated visual fixture does not simulate a conversation.</p>}/>);
