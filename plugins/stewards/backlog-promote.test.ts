import { describe, expect, it } from "vitest";
import {
  backlogPromoteParamsSchema,
  candidateEligible,
  decidePromote,
  hasOpenBlocker,
  isAdopted,
  isBacklogState,
  isReadyLooking,
  isTodoOrInProgress,
  orderedCandidates,
  promoteAcceptedDetail,
  promotePlan,
  promoteRefusedDetail,
  wipCount,
  type BacklogPromoteIssue,
  type PromoteConfig,
  type PromoteDetail,
} from "./backlog-promote.js";

const config = (over: Partial<PromoteConfig> = {}): PromoteConfig => ({
  promote: true,
  team: "BB",
  wipLimit: 5,
  label: "bb-managed",
  adoptedLabels: ["bb-managed", "initiative"],
  ...over,
});

const issue = (over: Partial<BacklogPromoteIssue> = {}): BacklogPromoteIssue => ({
  id: "uuid-1",
  key: "BB-1",
  unit: "BB",
  title: "Fix login",
  state: "Backlog",
  stateType: "backlog",
  labels: [],
  assignees: [],
  priority: null,
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

const detail = (over: Partial<PromoteDetail> = {}): PromoteDetail => ({ description: "Users cannot log in.", blockedBy: [], ...over });

const detailsOf = (entries: Array<[string, Partial<PromoteDetail>]>): Map<string, PromoteDetail> => new Map(entries.map(([key, over]) => [key, detail(over)]));

const decide = (over: Partial<Parameters<typeof decidePromote>[0]> = {}) => decidePromote({ params: {}, issues: [issue()], details: detailsOf([["BB-1", {}]]), config: config(), ...over });

const reason = (result: ReturnType<typeof decidePromote>): string => (result.ok ? "" : result.reason);

describe("the promotion opt-in and authority limits (BB-385)", () => {
  it("refuses everything while backlog.promote is off", () => {
    expect(reason(decide({ config: config({ promote: false }) }))).toMatch(/promote is off/u);
  });

  it("refuses a call carrying a description, state, assignee, cancel, close, label, priority or relation", () => {
    for (const field of ["description", "state", "assignee", "cancel", "close", "addLabels", "priority", "relations"]) {
      const raw = { key: "BB-1", [field]: "x" } as unknown as Parameters<typeof decidePromote>[0]["params"];
      expect(reason(decide({ params: raw }))).toMatch(new RegExp(`may not carry ${field}`, "u"));
    }
    // The tool's own schema is strict, so the same call never parses.
    expect(backlogPromoteParamsSchema.safeParse({ key: "BB-1", state: "Todo" }).success).toBe(false);
    expect(backlogPromoteParamsSchema.safeParse({ key: "BB-1" }).success).toBe(true);
    expect(backlogPromoteParamsSchema.safeParse({}).success).toBe(true);
  });

  it("plans exactly Todo, the adoption label and this server's own login", () => {
    const result = decide();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).toEqual({ key: "BB-1", state: "Todo", addLabels: ["bb-managed"], assignee: "me" });
      expect(result.candidate.key).toBe("BB-1");
    }
    expect(promotePlan(issue({ key: "BB-2" }), config())).toEqual({ key: "BB-2", state: "Todo", addLabels: ["bb-managed"], assignee: "me" });
  });
});

describe("the WIP limit (BB-385)", () => {
  const todo = (over: Partial<BacklogPromoteIssue> = {}) => issue({ key: `BB-${Math.random()}`, state: "Todo", stateType: "unstarted", ...over });
  const inProgress = (over: Partial<BacklogPromoteIssue> = {}) => issue({ key: `BB-${Math.random()}`, state: "In Progress", stateType: "started", ...over });

  it("counts Todo and In Progress by state type or name, not Backlog or Done", () => {
    const issues = [todo(), inProgress(), issue({ state: "Backlog", stateType: "backlog" }), issue({ state: "Done", stateType: "completed" })];
    expect(wipCount(issues, config())).toBe(2);
    // A renamed state still counts by type, and a null type still counts by name.
    expect(isTodoOrInProgress(issue({ state: "Ready", stateType: "unstarted" }))).toBe(true);
    expect(isTodoOrInProgress(issue({ state: "Doing", stateType: "started" }))).toBe(true);
    expect(isTodoOrInProgress(issue({ state: "Todo", stateType: null }))).toBe(true);
    expect(isTodoOrInProgress(issue({ state: "In Progress", stateType: null }))).toBe(true);
    expect(isTodoOrInProgress(issue({ state: "Backlog", stateType: "backlog" }))).toBe(false);
  });

  it("refuses at the ceiling and promotes below it", () => {
    const atLimit = [todo(), inProgress(), todo(), inProgress(), todo()];
    expect(reason(decide({ issues: atLimit, details: detailsOf([]), config: config({ wipLimit: 5 }) }))).toMatch(/WIP full/u);
    const below = [todo(), inProgress(), todo(), inProgress()];
    expect(decide({ issues: below, details: detailsOf([]), config: config({ wipLimit: 5 }) }).ok).toBe(false);
    // Below the ceiling but with no candidate, the refusal is "no eligible candidate".
    expect(reason(decide({ issues: below, details: detailsOf([]), config: config({ wipLimit: 5 }) }))).toBe("no eligible candidate");
  });

  it("counts only the watched team", () => {
    expect(wipCount([todo({ unit: "OPS" }), todo({ unit: "BB" })], config())).toBe(1);
  });
});

describe("the candidate rules (BB-385)", () => {
  it("never picks a ticket that is not in Backlog", () => {
    expect(isBacklogState(issue({ state: "Backlog", stateType: "backlog" }))).toBe(true);
    expect(isBacklogState(issue({ state: "Backlog", stateType: null }))).toBe(true);
    expect(isBacklogState(issue({ state: "Todo", stateType: "unstarted" }))).toBe(false);
    // A non-Backlog ticket is not a candidate even when it is the only one.
    expect(reason(decide({ issues: [issue({ state: "Todo", stateType: "unstarted" })], details: detailsOf([]) }))).toBe("no eligible candidate");
  });

  it("never picks an adopted ticket: an adoption label, an initiative or any assignee", () => {
    expect(isAdopted(issue({ labels: ["bb-managed"] }), config())).toBe(true);
    expect(isAdopted(issue({ labels: ["initiative"] }), config())).toBe(true);
    expect(isAdopted(issue({ assignees: ["jane"] }), config())).toBe(true);
    expect(isAdopted(issue(), config())).toBe(false);
    expect(orderedCandidates([issue({ labels: ["bb-managed"] }), issue({ key: "BB-2", assignees: ["jane"] }), issue({ key: "BB-3" })], config()).map((i) => i.key)).toEqual(["BB-3"]);
  });

  it("never picks a ticket with an open blocker", () => {
    expect(hasOpenBlocker(detail({ blockedBy: ["BB-9"] }))).toBe(true);
    expect(hasOpenBlocker(detail({ blockedBy: [] }))).toBe(false);
    // The only candidate is blocked, so nothing is promoted.
    expect(reason(decide({ details: detailsOf([["BB-1", { blockedBy: ["BB-9"] }]]) }))).toBe("no eligible candidate");
    // A blocked top ticket is skipped for the next ready-looking one.
    const result = decide({
      issues: [issue({ key: "BB-1" }), issue({ key: "BB-2" })],
      details: detailsOf([
        ["BB-1", { blockedBy: ["BB-9"] }],
        ["BB-2", {}],
      ]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.key).toBe("BB-2");
  });

  it("requires a non-empty title and description, and skips a ticket that lacks one", () => {
    expect(isReadyLooking(issue(), detail())).toBe(true);
    expect(isReadyLooking(issue({ title: "  " }), detail())).toBe(false);
    expect(isReadyLooking(issue(), detail({ description: "  " }))).toBe(false);
    expect(isReadyLooking(issue(), detail({ description: null }))).toBe(false);
    expect(candidateEligible(issue(), detail())).toBe(true);
    // The top ticket is empty, so the next ready-looking one is promoted.
    const result = decide({
      issues: [issue({ key: "BB-1" }), issue({ key: "BB-2" })],
      details: detailsOf([
        ["BB-1", { description: "  " }],
        ["BB-2", {}],
      ]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.key).toBe("BB-2");
  });

  it("skips a candidate whose detail was not read, but promotes a later read one", () => {
    const result = decide({
      issues: [issue({ key: "BB-1" }), issue({ key: "BB-2" })],
      details: detailsOf([["BB-2", {}]]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.key).toBe("BB-2");
  });
});

describe("the ordering (BB-385)", () => {
  it("orders by the owner's priority, then the source's own order, and never changes priority", () => {
    const issues = [
      issue({ key: "BB-1", priority: "Low" }),
      issue({ key: "BB-2", priority: "Urgent" }),
      issue({ key: "BB-3", priority: null }),
      issue({ key: "BB-4", priority: "High" }),
      issue({ key: "BB-5", priority: "Medium" }),
      // Two tickets of the same priority keep the source's order.
      issue({ key: "BB-6", priority: "High" }),
    ];
    expect(orderedCandidates(issues, config()).map((i) => i.key)).toEqual(["BB-2", "BB-4", "BB-6", "BB-5", "BB-1", "BB-3"]);
    // The plan carries no priority, so a promotion never writes one.
    const result = decide({ issues, details: detailsOf(issues.map((i) => [i.key, {}])) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan).toEqual({ key: "BB-2", state: "Todo", addLabels: ["bb-managed"], assignee: "me" });
  });

  it("treats an unknown priority as unset rather than ranking above a hand-set one", () => {
    const issues = [issue({ key: "BB-1", priority: "P0-ish" }), issue({ key: "BB-2", priority: "low" })];
    expect(orderedCandidates(issues, config()).map((i) => i.key)).toEqual(["BB-2", "BB-1"]);
  });
});

describe("the key hint (BB-385)", () => {
  it("ignores a key that is not the top-ordered eligible ticket", () => {
    const issues = [issue({ key: "BB-1", priority: "Urgent" }), issue({ key: "BB-2", priority: "Low" })];
    const details = detailsOf([
      ["BB-1", {}],
      ["BB-2", {}],
    ]);
    const result = decide({ params: { key: "BB-2" }, issues, details });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.key).toBe("BB-1");
  });
});

describe("the ledger entries (BB-385)", () => {
  it("names the promoted ticket, the state, the label and the assignee", () => {
    expect(promoteAcceptedDetail(issue({ key: "BB-1" }), { key: "BB-1" }, config())).toEqual({ state: "Todo", addLabels: ["bb-managed"], assignee: "me", requestedKey: "BB-1", promoted: "BB-1" });
    expect(promoteRefusedDetail({ key: "BB-2" })).toEqual({ requestedKey: "BB-2" });
    expect(promoteRefusedDetail({})).toEqual({ requestedKey: null });
  });
});
