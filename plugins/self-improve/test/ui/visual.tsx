/** Synthetic records only. This harness is not registered by the plugin. */
import { createRoot } from "react-dom/client";
import { Dashboard } from "../../src/ui/dashboard.js";
import type { PublicationObservation } from "../../src/publication-state.js";
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
  health: {enabled: false, issues: [], publicationRepositories:["example/plugins"]}, costs: {unmeteredAccessRequests:3,totals:[{currency:"USD",reportedMicros:0,estimatedMicros:1_250_000,unknownAttempts:2,attempts:3}]},
  objectives:[{id:"o-manual",problemId:"p-manual",kind:"goal",title:"Make the test feedback loop faster",description:"Reduce the wait for a targeted test result.",metric:{name:"Test feedback time",unit:"seconds",target:30,direction:"lower"},focus:{priority:5}}],
};
const confirmed: PublicationObservation = {
  id: "fixture-observation-1", publicationId: "fixture-publication", draftId: "fixture-draft", solutionId: "s-active", revision: "fixture-r1", bundleSha256: "a".repeat(64),
  sequence: 1, observedAtMs: Date.UTC(2026, 10, 18, 12), releaseTag: "fixture-v1",
  review: { state: "merged", url: "https://github.com/example/plugins/pull/7", headCommit: "b".repeat(40), submittedCommitChanged: false },
  repository: { state: "available", commit: "c".repeat(40), url: `https://github.com/example/plugins/tree/${"c".repeat(40)}/plugins/retry-input-check` },
  release: { state: "released", tag: "fixture-v1", commit: "d".repeat(40), url: "https://github.com/example/plugins/releases/tag/fixture-v1", prerelease: true }, issues: [],
};
const unknown: PublicationObservation = { ...confirmed, id: "fixture-observation-2", sequence: 2, observedAtMs: Date.UTC(2026, 10, 18, 13),
  review: { state: "unknown", url: confirmed.review.url, headCommit: null, submittedCommitChanged: null },
  repository: { state: "unconfirmed", commit: null, url: null },
  release: { state: "unconfirmed", tag: "fixture-v1", commit: null, url: null, prerelease: null }, issues: ["review-or-merged-content-not-confirmed", "release-not-confirmed"],
};
const observations = [confirmed];
const api: DashboardApi = {
  dashboard: async () => data,
  retest: async () => ({jobId:"fixture-retest"}),
  startChat: async () => ({threadId:"fixture-chat"}),
  createObjective: async () => ({id:"p-manual"}),
  performance: async () => ({points:[
    {id:"fixture-baseline",solutionId:"s-active",atMs:Date.UTC(2026,10,4),phase:"baseline",votes:3,sessions:10000,rate:.0003,confounders:["Illustrative fixture; not field evidence"],costs:[{currency:"USD",reportedMicros:0,estimatedMicros:1250000,unknownAttempts:2}]},
    {id:"fixture-after",solutionId:"s-active",atMs:Date.UTC(2026,10,18),phase:"after",votes:2,sessions:10000,rate:.0002,confounders:["Illustrative fixture; not field evidence"],costs:[{currency:"USD",reportedMicros:0,estimatedMicros:1250000,unknownAttempts:2}]},
  ]}),
  publications: async input => ({ publications: input.solutionId && input.solutionId !== "s-active" ? [] : [{ id: "fixture-publication", draftId: "fixture-draft", solutionId: "s-active", revision: "fixture-r1", repository: "example/plugins", directory: "plugins/retry-input-check", submission: "submitted-for-review", url: confirmed.review.url, latest: observations.at(-1)! }] }),
  publicationHistory: async () => ({ observations: [...observations] }),
  // This intentionally changes only synthetic memory. No transport or remote API exists here.
  reconcilePublication: async () => { if (observations.length === 1) observations.push(unknown); return unknown; },
  publishExport: async () => { throw new Error("Publication is disabled in the illustrative visual fixture."); },
  exportSolution: async () => ({artifactId:"fixture-artifact",status:"draft",bundleSha256:"a".repeat(64),files:[{path:"README.md",content:"Illustrative export for UI validation only."},{path:"EVIDENCE.md",content:"Synthetic visual fixture. No real validation, measured effect or publication is claimed."}]}),
};
createRoot(document.getElementById("root")!).render(<Dashboard api={api} projectId="fixture-project" refreshKey={0} onOpenThread={() => {}} renderChat={() => <p className="si-muted">Native ThreadChat is verified separately with the SDK harness. This isolated visual fixture does not simulate a conversation.</p>}/>);
