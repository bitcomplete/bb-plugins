import { describe, expect, it } from "vitest";
import { planGroupingRepair, repairRequestEstimate, reviewGroupingRepair, type RepairGroup } from "./grouping-repair.js";
import { unitLifecycle, type Cluster } from "./workstreams.js";
import type { RawUnit } from "./contract.js";
import type { JevClient } from "./enrich.js";
import type { ScoreResponse } from "@typesafe-ai/sdk";

function cluster(ticket: string, title: string, repo = "quill"): Cluster {
  const raw: RawUnit = {
    path: `/c/${ticket}`, dirName: ticket, repo, branch: `dev/${ticket}`, dirty: false, ahead: 0, behind: 0,
    lastCommitAt: null, defaultBranch: "main", shipped: null, changedPaths: ["src/work/item.ts"],
    pr: { number: 1, state: "OPEN", isDraft: false, reviewDecision: null, checkConclusions: [],
      url: `https://github.com/inkwell/${repo}/pull/1`, title, mergeable: null, baseRefName: "main", headRefName: ticket,
      latestReviewStates: [], mergedAt: null, mergeStateStatus: "UNKNOWN", reviewRequests: [], latestReviews: [], unresolvedReviewThreads: null, resolvedReviewThreads: null },
  };
  const lifecycle = unitLifecycle(raw);
  return { ticket, lifecycle, staleness: "fresh", surfaces: [], risk: "none", units: [{ ...raw, ticket, ticketSource: "branch", lifecycle, stack: null, staleness: "fresh", surfaces: [], risk: "none" }] };
}
const group = (id: string, members: Cluster[], mixed = false, locked = false): RepairGroup => ({ id, members, mixed, locked });
function client(scores: Record<string, number>, fallback = 0): JevClient {
  return { async ask(state, questions) {
    const items = (state as { items: { id: string }[] }).items;
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => {
      const [left, right] = key.slice(1).split("_").map(Number);
      const pair = [items[left!]!.id, items[right!]!.id].sort().join(",");
      return [key, { type: "score" as const, score: scores[pair] ?? fallback, confidence: 1 }];
    })), usage: { input_tokens: 100, output_tokens: 20 } };
  } };
}
const clinician = cluster("ABC-1", "Correct clinician matching in enrollment");
const phone = cluster("ABC-2", "Capture international phone numbers");
const eligibility = cluster("ABC-3", "Enforce eligibility coverage limits");
const schema = cluster("ABC-4", "Repair analytics schema migration");

describe("bounded outcome membership review", () => {
  it("accepts Jev's fractional expected score with its probability distribution, without rounding a weak fit up", async () => {
    const jobs = planGroupingRepair({ groups: [group("mixed", [clinician, phone], true)] }).jobs;
    const response = {
      type: "score", score: 3.72, confidence: 0.93,
      legend: { 0: "Unrelated", 1: "Shared area", 2: "Possible", 3: "Good", 4: "Certain" },
      probabilities: { 0: 0, 1: 0.01, 2: 0.03, 3: 0.19, 4: 0.77 },
    } as const satisfies ScoreResponse<readonly ["Unrelated", "Shared area", "Possible", "Good", "Certain"]>;
    const jev: JevClient = { async ask() { return { answers: { p0_1: response }, usage: { input_tokens: 100, output_tokens: 10 } }; } };
    const accepted = await reviewGroupingRepair({ jobs, jev });
    expect(accepted.warnings).toEqual([]);
    expect(accepted.partitions[0]?.members).toEqual([["ABC-1", "ABC-2"]]);
    const uncertain = await reviewGroupingRepair({ jobs, jev: client({}, 2.99) });
    expect(uncertain.warnings).toEqual([]);
    expect(uncertain.partitions[0]?.members).toEqual([["ABC-1"], ["ABC-2"]]);
  });

  it("splits unrelated clinician/phone and eligibility/schema work instead of giving broad groups better names", async () => {
    const plan = planGroupingRepair({ groups: [group("enrollment", [clinician, phone], true), group("backend", [eligibility, schema], true)] });
    const result = await reviewGroupingRepair({ jobs: plan.jobs, jev: client({}) });
    expect(result.partitions.flatMap((part) => part.members).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([["ABC-1"], ["ABC-2"], ["ABC-3"], ["ABC-4"]]);
  });

  it("joins cross-repository CI work from a focused thread only after semantic judgment agrees", async () => {
    const web = cluster("CI-1", "Migrate web checks to Node 24", "reader-web");
    const api = cluster("CI-2", "Update API pipeline runtime to Node 24", "reader-api");
    const groups = [group("web", [web]), group("api", [api])];
    const context = { threads: new Map([["CI-1", new Map([["thread-ci", 1]])], ["CI-2", new Map([["thread-ci", 1]])]]) };
    const plan = planGroupingRepair({ groups, context });
    expect(plan.jobs).toHaveLength(1);
    expect((await reviewGroupingRepair({ jobs: plan.jobs, jev: client({ "CI-1,CI-2": 4 }) })).partitions[0]?.members).toEqual([["CI-1", "CI-2"]]);
    expect((await reviewGroupingRepair({ jobs: plan.jobs, jev: client({}) })).partitions[0]?.members).toEqual([["CI-1"], ["CI-2"]]);
  });

  it("uses focused path links as a discovery hint, and excludes broad or irrelevant thread subjects", () => {
    const ci = [cluster("CI-1", "Repair runtime checks", "web"), cluster("CI-2", "Migrate runtime executor", "api")];
    const groups = ci.map((one) => group(one.ticket, [one]));
    const paths = { id: "paths-ci", title: "Runtime compatibility across repositories", clusters: ci.map((one) => one.ticket) };
    expect(planGroupingRepair({ groups }).jobs).toHaveLength(0);
    expect(planGroupingRepair({ groups, pathThreads: [paths] }).jobs).toHaveLength(1);
    expect(planGroupingRepair({ groups, pathThreads: [{ ...paths, title: "Weekly cleanup overview" }] }).jobs).toHaveLength(0);
    const broad = [ci[0]!, ci[1]!, ...Array.from({ length: 7 }, (_, index) => cluster(`CI-${index + 3}`, `Runtime adjustment item${index}`))];
    const broadGroups = broad.map((one, index) => group(one.ticket, [one], false, index >= 2));
    expect(planGroupingRepair({ groups: broadGroups, pathThreads: [{ ...paths, clusters: broad.map((one) => one.ticket) }] }).jobs).toHaveLength(0);
  });

  it("finds CI cache work from a focused CI title without letting shared checkout naming glue other work to it", () => {
    const cache = [
      cluster("CI-1", "chore(ci): warm trusted dependency caches for PR checks", "web"),
      cluster("CI-2", "chore(ci): cache dependencies and overlap preview test setup", "marketing"),
      cluster("CI-3", "chore(ci): warm dependency downloads without serial PR setup", "member"),
      cluster("CI-4", "fix(ci): restore test caching and cancel superseded checks", "api"),
    ];
    const others = [clinician, phone].map((one) => ({ ...one, units: one.units.map((unit) => ({ ...unit, branch: "developer/common-prefix-ci-cache-work" })) }));
    const groups = [...cache, ...others].map((one) => group(one.ticket, [one]));
    const plan = planGroupingRepair({ groups, pathThreads: [{ id: "thread-cache", title: "Speed up CI across projects", clusters: cache.map((one) => one.ticket) }] });
    expect(plan.jobs.map((job) => job.items.map((item) => item.id))).toEqual([["CI-1", "CI-2", "CI-3", "CI-4"]]);
  });

  it("preserves an exact ticket spanning OTA implementations as one atomic member", () => {
    const ota = cluster("OTA-42", "Deliver signed OTA update manifests", "device-api");
    ota.units.push(...cluster("OTA-42", "Verify OTA manifests before install", "device-client").units);
    const plan = planGroupingRepair({ groups: [group("ota", [ota])] });
    expect(plan.jobs).toEqual([]);
  });

  it("cannot chain unrelated outcomes through a bridge member", async () => {
    const plan = planGroupingRepair({ groups: [group("mixed", [clinician, phone, eligibility], true)] });
    const result = await reviewGroupingRepair({ jobs: plan.jobs, jev: client({ "ABC-1,ABC-2": 4, "ABC-2,ABC-3": 4 }) });
    expect(result.partitions[0]?.members).toEqual([["ABC-1", "ABC-2"], ["ABC-3"]]);
    expect(result.partitions[0]?.members.flat().sort()).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
  });

  it("keeps a coordinated cache campaign together while separating an unrelated change in the same CI area", async () => {
    const web = cluster("CI-1", "Warm dependency caches for browser PR checks", "web");
    const api = cluster("CI-2", "Restore dependency caching in server checks", "api");
    const signing = cluster("CI-3", "Rotate release signing certificate in CI", "api");
    const context = { threads: new Map(["CI-1", "CI-2", "CI-3"].map((id) => [id, new Map([["ci-maintenance", 0.5]])])) };
    const plan = planGroupingRepair({ groups: [group("mixed-ci", [web, api, signing], true)], context });
    const result = await reviewGroupingRepair({ jobs: plan.jobs, jev: client({ "CI-1,CI-2": 3.6, "CI-1,CI-3": 1.2, "CI-2,CI-3": 1.4 }) });
    expect(result.partitions[0]?.members).toEqual([["CI-1", "CI-2"], ["CI-3"]]);
  });

  it("makes status-only rescans and the accepted split zero-call, while changed evidence is reviewed", async () => {
    const groups = [group("mixed", [clinician, phone], true)];
    const plan = planGroupingRepair({ groups });
    const repaired = await reviewGroupingRepair({ jobs: plan.jobs, jev: client({}) });
    const reviewed = new Map(Object.entries(repaired.partitions[0]!.evidence));
    const status = { ...clinician, lifecycle: "merged" as const, units: clinician.units.map((unit) => ({ ...unit, dirty: true, ahead: 2, pr: { ...unit.pr!, state: "MERGED" as const } })) };
    expect(planGroupingRepair({ groups: [group("renamed", [status, phone], true)], reviewed }).jobs).toEqual([]);
    expect(planGroupingRepair({ groups: [group("one", [clinician]), group("two", [phone])], reviewed }).jobs).toEqual([]);
    const changed = { ...clinician, units: clinician.units.map((unit) => ({ ...unit, changedPaths: ["src/matching/provider.ts"] })) };
    expect(planGroupingRepair({ groups: [group("mixed", [changed, phone], true)], reviewed }).jobs).toHaveLength(1);
  });

  it("does not review established or manual effort members", () => {
    expect(planGroupingRepair({ groups: [group("user-selected", [clinician, phone], true, true)] }).jobs).toEqual([]);
  });

  it("retains exact prior membership on missing, invalid or failed judgments", async () => {
    const jobs = planGroupingRepair({ groups: [group("mixed", [clinician, phone], true)] }).jobs;
    const invalid: JevClient[] = [client({}, 5), client({}, NaN), { async ask() { return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; } }, { async ask() { throw new Error("offline"); } }];
    for (const jev of invalid) {
      const result = await reviewGroupingRepair({ jobs, jev });
      expect(result.partitions).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it("bounds requests and exposes exact context size and question count before a call", () => {
    const groups = Array.from({ length: 6 }, (_, index) => group(`g${index}`, [cluster(`A-${index}`, `First outcome ${index}`), cluster(`B-${index}`, `Second topic ${index}`)], true));
    const plan = planGroupingRepair({ groups });
    expect(plan.jobs).toHaveLength(4);
    expect(plan.warnings).toHaveLength(1);
    expect(repairRequestEstimate(plan.jobs)).toEqual({ calls: 4, scoreQuestions: 4, contextBytes: expect.any(Number), requestJsonBytes: expect.any(Number) });
    const oversized = group("oversized", Array.from({ length: 13 }, (_, index) => cluster(`A-${index}`, `Outcome ${index}`)), true);
    const deferred = planGroupingRepair({ groups: [oversized] });
    expect(deferred.jobs).toEqual([]);
    expect(deferred.warnings[0]).toContain("13 items");
  });

  it("defers a large related component explicitly instead of caching unseen pairs as reviewed", () => {
    const groups = Array.from({ length: 13 }, (_, index) => group(`g${index}`, [cluster(`CI-${index}`, "Improve dependency caching for CI checks")]));
    const plan = planGroupingRepair({ groups });
    expect(plan.jobs).toEqual([]);
    expect(plan.warnings).toEqual(["Membership review deferred a 13-item neighborhood; no partial review was marked complete."]);
  });

  it("schedules open work before completed history without changing evidence identity", () => {
    const historical = Array.from({ length: 4 }, (_, index) => group(`a${index}`, [cluster(`A-${index}`, `Historical alpha ${index}`), cluster(`B-${index}`, `Historical beta ${index}`)].map((one) => ({ ...one, units: one.units.map((unit) => ({ ...unit, pr: { ...unit.pr!, state: "MERGED" as const } })) })), true));
    const current = group("z-current", [clinician, phone], true);
    const plan = planGroupingRepair({ groups: [...historical, current] });
    expect(plan.jobs[0]?.items.map((item) => item.id)).toEqual(["ABC-1", "ABC-2"]);
  });
});
