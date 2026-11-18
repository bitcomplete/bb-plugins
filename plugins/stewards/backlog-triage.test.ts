import { describe, expect, it } from "vitest";
import {
  BACKLOG_TRIAGE_KINDS,
  BACKLOG_TRIAGE_SIZES,
  backlogLabelVocabulary,
  backlogTriageParamsSchema,
  commentsInWindow,
  decideTriage,
  lastQuestion,
  lastStewardPriority,
  normalizePriority,
  planIsEmpty,
  questionAnswered,
  type BacklogTriageParams,
  type BacklogWrite,
  type TriageConfig,
  type TriageTicket,
} from "./backlog-triage.js";
import { signatureLine, type SnapshotComment } from "./source-contract.js";

const NOW = Date.parse("2026-10-14T15:00:00Z");
const SIGNED = `Is the login flow meant to cover SSO?\n\n${signatureLine("thr_backlog")}`;
const DAY = 86_400_000;

const config = (over: Partial<TriageConfig> = {}): TriageConfig => ({
  triage: true,
  team: "BB",
  commentsPerWeek: 1,
  staleDays: 14,
  label: "bb-managed",
  adoptedLabels: ["bb-managed", "initiative"],
  repos: ["acme/app", "acme/tools"],
  ...over,
});

const ticket = (over: Partial<TriageTicket> = {}): TriageTicket => ({
  key: "BB-1",
  unit: "BB",
  labels: [],
  priority: null,
  state: "Backlog",
  stateType: "backlog",
  assignees: [],
  updatedAt: "2026-10-14T00:00:00Z",
  comments: [],
  ...over,
});

const params = (over: Partial<BacklogTriageParams> = {}): BacklogTriageParams => ({ key: "BB-1", ...over });

const entry = (over: Partial<BacklogWrite> = {}): BacklogWrite => ({
  id: "w1",
  projectId: "p1",
  team: "BB",
  issueId: "i1",
  issueKey: "BB-1",
  at: NOW - 1000,
  outcome: "accepted",
  kind: "triage",
  detail: {},
  reason: null,
  ...over,
});

const decide = (over: Partial<Parameters<typeof decideTriage>[0]> = {}) =>
  decideTriage({ params: params(), ticket: ticket(), config: config(), ledger: [], bound: false, now: NOW, relatedTeams: new Map(), signedComment: SIGNED, ...over });

const reason = (result: ReturnType<typeof decideTriage>): string => (result.ok ? "" : result.reason);

describe("the backlog label vocabulary (BB-341)", () => {
  it("is the fixed kinds, sizes and one repo:<name> per repo, named after the owner", () => {
    const vocab = backlogLabelVocabulary(["acme/app", "acme/tools"]);
    expect([...BACKLOG_TRIAGE_KINDS].every((k) => vocab.labels.get(k) === k)).toBe(true);
    expect([...BACKLOG_TRIAGE_SIZES].every((s) => vocab.labels.get(`size:${s}`.toLowerCase()) === `size:${s}`)).toBe(true);
    expect(vocab.labels.get("repo:app")).toBe("repo:app");
    expect(vocab.labels.has("bb-managed")).toBe(false);
    expect(vocab.labels.has("initiative")).toBe(false);
  });

  it("matches ignoring case and never grows with the configuration", () => {
    const vocab = backlogLabelVocabulary(["acme/app"]);
    expect(vocab.labels.get("size:s")).toBe("size:S");
    expect(vocab.labels.get("bug")).toBe("bug");
    // The vocabulary is fixed: no config value can add an adoption label.
    expect(vocab.labels.has("bb-managed")).toBe(false);
  });

  it("marks a repo name two repositories share as ambiguous", () => {
    const vocab = backlogLabelVocabulary(["acme/web", "beta/web"]);
    expect(vocab.ambiguous.get("repo:web")).toEqual(["acme/web", "beta/web"]);
    expect(vocab.labels.has("repo:web")).toBe(false);
    expect(reason(decide({ params: params({ addLabels: ["repo:web"] }), config: config({ repos: ["acme/web", "beta/web"] }) }))).toMatch(/ambiguous/u);
  });
});

describe("the triage allowlist and adoption check (BB-341)", () => {
  it("refuses everything while backlog.triage is off", () => {
    expect(reason(decide({ config: config({ triage: false }), params: params({ addLabels: ["bug"] }) }))).toMatch(/triage is off/u);
  });

  it("refuses a call carrying description, state, assignee, cancel or close", () => {
    for (const field of ["description", "state", "assignee", "cancel", "close"]) {
      const raw = { key: "BB-1", addLabels: ["bug"], [field]: "x" } as unknown as BacklogTriageParams;
      expect(reason(decide({ params: raw }))).toMatch(new RegExp(`may not carry ${field}`, "u"));
    }
    // The tool's own schema is strict, so the same call never parses.
    expect(backlogTriageParamsSchema.safeParse({ key: "BB-1", description: "x" }).success).toBe(false);
  });

  it("refuses a ticket outside the watched team, before anything else", () => {
    expect(reason(decide({ ticket: ticket({ unit: "OPS" }), params: params({ addLabels: ["bug"] }) }))).toMatch(/not the watched team/u);
    // The related end is checked against the watched team too.
    const relatedTeams = new Map([["ops-9", "OPS"]]);
    expect(reason(decide({ ticket: ticket({ unit: "OPS" }), params: params({ relations: [{ type: "related", issue: "OPS-9" }] }), relatedTeams }))).toMatch(/not the watched team/u);
  });

  it("refuses a bound ticket, an adopted state, and a bb-managed assigned ticket", () => {
    expect(reason(decide({ bound: true }))).toMatch(/already bound/u);
    for (const stateType of ["started", "completed", "canceled"]) {
      expect(reason(decide({ ticket: ticket({ stateType }) }))).toMatch(/un-adopted/u);
    }
    expect(reason(decide({ ticket: ticket({ labels: ["bb-managed"], assignees: ["jane"] }) }))).toMatch(/adopted/u);
    // bb-managed with no assignee is still un-adopted and triaged.
    expect(decide({ ticket: ticket({ labels: ["bb-managed"] }), params: params({ addLabels: ["bug"] }) }).ok).toBe(true);
  });

  it("accepts only the fixed label vocabulary, add-only", () => {
    expect(decide({ params: params({ addLabels: ["bug", "feature", "chore", "size:S", "size:M", "size:L", "repo:app"] }) }).ok).toBe(true);
    expect(reason(decide({ params: params({ addLabels: ["size:XL"] }) }))).toMatch(/not in the triage vocabulary/u);
    expect(reason(decide({ params: params({ addLabels: ["repo:acme/nope"] }) }))).toMatch(/not in the triage vocabulary/u);
    expect(reason(decide({ params: params({ addLabels: ["bb-managed"] }) }))).toMatch(/adoption label/u);
    expect(reason(decide({ params: params({ addLabels: ["initiative"] }) }))).toMatch(/adoption label/u);
    // A label a playbook adopts on is refused even when the vocabulary would not carry it.
    expect(reason(decide({ config: config({ adoptedLabels: ["bb-managed", "initiative", "needs-design"] }), params: params({ addLabels: ["needs-design"] }) }))).toMatch(/adoption label/u);
  });

  it("refuses a forbidden relation kind and relates only within the team, add-only", () => {
    // `blocks` is not one of the three the contract accepts.
    expect(backlogTriageParamsSchema.safeParse({ key: "BB-1", relations: [{ type: "blocks", issue: "BB-2" }] }).success).toBe(false);
    const relatedTeams = new Map([["bb-2", "BB"], ["ops-9", "OPS"]]);
    expect(decide({ params: params({ relations: [{ type: "duplicate", issue: "BB-2" }, { type: "blockedBy", issue: "BB-2" }, { type: "related", issue: "BB-2" }] }), relatedTeams }).ok).toBe(true);
    expect(reason(decide({ params: params({ relations: [{ type: "related", issue: "OPS-9" }] }), relatedTeams }))).toMatch(/both ends must be in the team/u);
    expect(reason(decide({ params: params({ relations: [{ type: "related", issue: "BB-3" }] }), relatedTeams }))).toMatch(/could not be checked/u);
    expect(reason(decide({ params: params({ relations: [{ type: "related", issue: "BB-1" }] }), relatedTeams }))).toMatch(/itself/u);
  });
});

describe("the priority rule (BB-341)", () => {
  it("reads Linear's priority labels", () => {
    expect(normalizePriority("Urgent")).toBe("urgent");
    expect(normalizePriority("No priority")).toBeNull();
    expect(normalizePriority(null)).toBeNull();
  });

  it("carries a `none` clear in the plan, so it is not swallowed as an empty plan", () => {
    const stewardSet = [entry({ kind: "priority", detail: { priority: "high" }, at: NOW - DAY })];
    const result = decide({ params: params({ priority: "none" }), ticket: ticket({ priority: "High" }), ledger: stewardSet });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.priority).toBe("none");
      expect(planIsEmpty(result.plan)).toBe(false);
    }
  });

  it("sets a priority only when it is unset or last set by the steward", () => {
    expect(decide({ params: params({ priority: "high" }), ticket: ticket({ priority: null }) }).ok).toBe(true);
    // A priority the ledger did not write is hand-set and never changed.
    expect(reason(decide({ params: params({ priority: "high" }), ticket: ticket({ priority: "Medium" }) }))).toMatch(/hand-set/u);
    // The steward set Medium last, so it may change it.
    const stewardSet = [entry({ kind: "priority", detail: { priority: "medium" }, at: NOW - DAY })];
    expect(decide({ params: params({ priority: "high" }), ticket: ticket({ priority: "Medium" }), ledger: stewardSet }).ok).toBe(true);
    // A human moved it since: the ledger's last write no longer matches.
    expect(reason(decide({ params: params({ priority: "urgent" }), ticket: ticket({ priority: "High" }), ledger: stewardSet }))).toMatch(/hand-set/u);
    // An unparseable value is hand-set.
    expect(reason(decide({ params: params({ priority: "high" }), ticket: ticket({ priority: "P0-ish" }) }))).toMatch(/did not set/u);
  });

  it("reads the last priority the steward wrote", () => {
    expect(lastStewardPriority([])).toBeNull();
    expect(lastStewardPriority([entry({ kind: "priority", detail: { priority: "low" } }), entry({ kind: "priority", detail: { priority: "high" } })])).toBe("high");
    expect(lastStewardPriority([entry({ kind: "priority", detail: { priority: "high" }, outcome: "refused" })])).toBeNull();
  });
});

describe("the comment budget and rules (BB-341)", () => {
  it("requires the bb thread signature line", () => {
    expect(reason(decide({ params: params({ comment: "A question?" }), signedComment: null }))).toMatch(/signature line/u);
    expect(reason(decide({ params: params({ comment: "A question?" }), signedComment: "A question?" }))).toMatch(/signature line/u);
    expect(decide({ params: params({ comment: "A question?" }), signedComment: SIGNED }).ok).toBe(true);
  });

  it("enforces the rolling comment budget from the ledger", () => {
    const recent = entry({ kind: "comment", detail: { kind: "question" }, at: NOW - DAY });
    expect(reason(decide({ params: params({ comment: "Again?" }), ledger: [recent] }))).toMatch(/budget/u);
    // Outside the window, the budget is clear (a stale proposal is not an
    // open question, so the budget is the only rule in play).
    const old = entry({ kind: "comment", detail: { kind: "stale" }, at: NOW - 8 * DAY });
    expect(decide({ params: params({ comment: "Again?" }), ledger: [old] }).ok).toBe(true);
    expect(commentsInWindow([recent, old], NOW)).toHaveLength(1);
  });

  it("allows one open question per ticket until the requester replies", () => {
    const question = entry({ kind: "comment", detail: { kind: "question" }, at: NOW - DAY });
    // The budget is raised here so the open-question rule is the one tested.
    expect(reason(decide({ params: params({ comment: "Second?" }), ledger: [question], config: config({ commentsPerWeek: 2 }) }))).toMatch(/open question/u);
    const reply: SnapshotComment = { id: "c2", author: "Sam", did: "commented", body: "Yes", createdAt: new Date(NOW - 1000).toISOString(), url: null, signedBy: null };
    expect(decide({ params: params({ comment: "Second?" }), ledger: [question], config: config({ commentsPerWeek: 2 }), ticket: ticket({ comments: [reply] }) }).ok).toBe(true);
    // A comment signed by a bb thread is the plugin's own and never answers.
    const own: SnapshotComment = { ...reply, signedBy: "thr_other" };
    expect(reason(decide({ params: params({ comment: "Second?" }), ledger: [question], config: config({ commentsPerWeek: 2 }), ticket: ticket({ comments: [own] }) }))).toMatch(/open question/u);
    expect(questionAnswered(question, [reply])).toBe(true);
    expect(lastQuestion([question])?.id).toBe("w1");
  });

  it("proposes a stale cancel only when the ticket is untouched for staleDays", () => {
    const stale = ticket({ updatedAt: new Date(NOW - 20 * DAY).toISOString() });
    expect(decide({ params: params({ comment: "Propose closing this.", proposeCancel: true }), ticket: stale }).ok).toBe(true);
    expect(reason(decide({ params: params({ comment: "Propose closing this.", proposeCancel: true }), ticket: ticket({ updatedAt: new Date(NOW - 2 * DAY).toISOString() }) }))).toMatch(/not stale/u);
    // The stale proposal counts against the same budget.
    const used = entry({ kind: "comment", detail: { kind: "stale" }, at: NOW - DAY });
    expect(reason(decide({ params: params({ comment: "Propose closing this.", proposeCancel: true }), ticket: stale, ledger: [used] }))).toMatch(/budget/u);
  });

  it("treats a comment as a proposal only: it plans no state change", () => {
    const result = decide({ params: params({ comment: "A question?" }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.comment).toEqual({ body: SIGNED, kind: "question" });
  });
});

describe("the plan (BB-341)", () => {
  it("is empty when nothing was asked for, but a priority clear is not nothing", () => {
    expect(planIsEmpty({ addLabels: [], relations: [], priority: null, comment: null })).toBe(true);
    expect(planIsEmpty({ addLabels: ["bug"], relations: [], priority: null, comment: null })).toBe(false);
    expect(planIsEmpty({ addLabels: [], relations: [], priority: "none", comment: null })).toBe(false);
  });
});
