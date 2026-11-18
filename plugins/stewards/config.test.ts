import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_BUDGETS,
  DEPENDENCY_BOTS,
  depsTargets,
  githubStateLabels,
  isTerminal,
  k8sTargets,
  labelPhaseName,
  legacyOpsPresent,
  modelSpecSchema,
  opsTeam,
  parsePlaybook,
  parseProjectFile,
  phaseInstructions,
  phaseOf,
  playbookLabels,
  playbookNameFor,
  playbookStates,
  roleBacklogTargets,
  sentryTargets,
  ticketWatchId,
  ticketWatchProblems,
  waitBudgetMs,
} from "./config.js";
import {
  bindingRoles,
  filingTargetProblems,
  legacyRole,
  parseRolesFile,
  projectStewardProblem,
  pullWatchId,
  pullWatchProblems,
  roleAlertmanagerTargets,
  roleDepsTargets,
  roleK8sTargets,
  roleOpsTargets,
  roleOpsTeam,
  roleProblems,
  rolePullWatches,
  rolePulls,
  roleSentryTargets,
  roleUsesOps,
  roleWarnings,
  usesKind,
  watchProblems,
} from "./roles.js";
import { opsTargetKey, parseOpsTargetKey } from "./ops.js";
import { DEPS_ALERTS, DEPS_PRS, GITHUB_ISSUES, GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, PLAYBOOK_TEMPLATES, projectFileTemplate, stampedTemplate, templateHashes } from "./templates.js";
import { parseTemplateStamp, templateHash, templateWarnings } from "./template-stamp.js";

describe("the project file", () => {
  it("parses the template with defaults filled in", () => {
    const parsed = parseProjectFile(projectFileTemplate(["eng", "OPS"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.linear.teams).toEqual(["ENG", "OPS"]);
    expect(parsed.value.label).toBe("bb-managed");
    expect(parsed.value.nightly).toMatchObject({ at: "01:00", timezone: "America/New_York", until: "02:45" });
    expect(parsed.value.projectSteward.model).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(parsed.value.reviews.enabled).toBe(true);
    expect(parsed.value.github.exclude).toEqual([]);
    expect(parsed.value.ops).toEqual({ targets: [], autoAdopt: [], sentry: { resolveOnDone: false } });
    expect(usesKind(parsed.value, "ops")).toBe(false);
  });

  it("writes a default decide list that names no repo the project lacks (BB-359)", () => {
    const parsed = parseProjectFile(projectFileTemplate([]));
    if (!parsed.ok) throw new Error(parsed.error);
    const projectEntries = parsed.value.bigDecisions.filter((d) => d.decide === "project");
    expect(projectEntries.length).toBeGreaterThan(0);
    // A default path names no repo: it is a bare filename (no directory), an
    // any-depth glob, or the fixed GitHub workflow directory. A literal
    // leading directory (the old `bb-gate/kploy/**`, `devbox/host/**`) fails.
    for (const entry of projectEntries) {
      expect(entry.paths.length, entry.text).toBeGreaterThan(0);
      for (const path of entry.paths) {
        expect(!path.includes("/") || path.startsWith("**/") || path.startsWith(".github/"), `${entry.text}: ${path}`).toBe(true);
      }
    }
  });

  it("fills the notifications switch on by default, and takes an explicit off (BB-253)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.notifications).toEqual({ enabled: true });
    const off = parseProjectFile(JSON.stringify({ version: 1, notifications: { enabled: false } }));
    if (!off.ok) throw new Error(off.error);
    expect(off.value.notifications.enabled).toBe(false);
    expect(parseProjectFile(JSON.stringify({ version: 1, notifications: { unknown: true } }))).toMatchObject({ ok: false });
  });

  it("still accepts a project file that sets standup.delegate, which is deprecated and ignored (BB-313)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    // Unset: the BB-312 tier keys carry their code defaults (10 closed, 3 days, one hour).
    expect(defaults.value.standup).toEqual({ closedLimit: 10, closedDays: 3, cacheTtl: 3_600 });
    // BB-307's delegate key stays parseable so an existing `.bb` is not broken,
    // but BB-313 removed the tool and nothing reads it.
    const explicit = parseProjectFile(JSON.stringify({ version: 1, standup: { delegate: "claude/claude-sonnet-5-5/medium" } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.standup.delegate).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" });
    // Strict, like every other project-file key: a typo is an error, not a silent default.
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { model: "claude/claude-haiku-5-5/low" } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { delegate: "claude//medium" } }))).toMatchObject({ ok: false });
  });

  it("takes the stand-up tier and cache keys with their defaults (BB-312)", () => {
    const explicit = parseProjectFile(JSON.stringify({ version: 1, standup: { closedLimit: 4, closedDays: 7, cacheTtl: 60 } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.standup).toMatchObject({ closedLimit: 4, closedDays: 7, cacheTtl: 60 });
    // Each key is bounded and strict.
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { closedLimit: 0 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { closedDays: -1 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { cacheTtl: -1 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, standup: { ttl: 60 } }))).toMatchObject({ ok: false });
  });

  it("names the file and the field in errors", () => {
    const bad = parseProjectFile(JSON.stringify({ version: 1, nightly: { timezone: "Mars/Olympus" } }));
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/stewards\/project\.json: nightly\.timezone/u);
    expect(parseProjectFile("{")).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 2 }))).toMatchObject({ ok: false });
    const repo = parseProjectFile(JSON.stringify({ version: 1, github: { exclude: ["https://github.com/acme/web"] } }));
    if (!repo.ok) expect(repo.error).toMatch(/github\.exclude\.0: a repo such as acme\/web/u);
    else expect.fail("a URL is not owner/repo");
  });

  it("parses the optional backlog block with its defaults, and refuses unknown keys, non-positive numbers and a bad team (BB-334)", () => {
    const absent = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!absent.ok) throw new Error(absent.error);
    expect(absent.value.backlog).toBeUndefined();

    const explicit = parseProjectFile(JSON.stringify({ version: 1, backlog: { team: " bb ", wipLimit: 3, staleDays: 21, commentsPerWeek: 2, triage: true } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.backlog).toEqual({ team: "BB", wipLimit: 3, staleDays: 21, commentsPerWeek: 2, triage: true });

    const defaults = parseProjectFile(JSON.stringify({ version: 1, backlog: {} }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.backlog).toEqual({ wipLimit: 5, staleDays: 14, commentsPerWeek: 1, triage: false });

    expect(parseProjectFile(JSON.stringify({ version: 1, backlog: { bogus: true } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, backlog: { wipLimit: 0 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, backlog: { staleDays: -1 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, backlog: { commentsPerWeek: 0 } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, backlog: { team: "bad key" } }))).toMatchObject({ ok: false });
  });

  it("reads a role's backlog team as a target, and round-trips its key (BB-334)", () => {
    expect(roleBacklogTargets({ ops: { backlog: { team: "BB" } } })).toEqual([{ kind: "backlog", team: "BB" }]);
    expect(roleBacklogTargets({ ops: {} })).toEqual([]);
    expect(roleBacklogTargets(null)).toEqual([]);
    expect(opsTargetKey({ kind: "backlog", team: "BB" })).toBe("backlog/BB");
    expect(parseOpsTargetKey("backlog/BB")).toEqual({ kind: "backlog", team: "BB" });
  });

  it("fills the dependency watch's SLA, batch and autoAdopt defaults, and takes explicit values", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.deps).toEqual({ sla: { critical: "asap", high: 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 }, batch: { medium: 7 * 86_400_000, low: 30 * 86_400_000 }, autoAdopt: ["critical", "high"] });

    const explicit = parseProjectFile(JSON.stringify({ version: 1, deps: { sla: { high: "2d" }, batch: { medium: "3d" }, autoAdopt: ["critical"] } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.deps.sla).toEqual({ critical: "asap", high: 2 * 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 });
    expect(explicit.value.deps.batch).toEqual({ medium: 3 * 86_400_000, low: 30 * 86_400_000 });
    expect(explicit.value.deps.autoAdopt).toEqual(["critical"]);

    const badSeverity = parseProjectFile(JSON.stringify({ version: 1, deps: { autoAdopt: ["catastrophic"] } }));
    expect(badSeverity).toMatchObject({ ok: false });
    if (!badSeverity.ok) expect(badSeverity.error).toMatch(/deps\.autoAdopt\.0/u);
    const badDuration = parseProjectFile(JSON.stringify({ version: 1, deps: { sla: { high: "soon" } } }));
    expect(badDuration).toMatchObject({ ok: false });
    if (!badDuration.ok) expect(badDuration.error).toMatch(/deps\.sla\.high/u);
  });

  it("fills the lesson lifecycle's defaults, and takes explicit thresholds (BB-35 step 3)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.lessons).toEqual({ trial: { max: 5, retireDays: 30 }, promote: { hits: 3, days: 14 }, promoted: { maxPerFile: 10, retireDays: 90, corrections: 2 }, decayHalfLifeDays: 30, validations: { perWeek: 1 } });

    const explicit = parseProjectFile(JSON.stringify({ version: 1, lessons: { trial: { max: 2 }, promote: { hits: 5, days: 7 }, decayHalfLifeDays: 14 } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.lessons).toEqual({ trial: { max: 2, retireDays: 30 }, promote: { hits: 5, days: 7 }, promoted: { maxPerFile: 10, retireDays: 90, corrections: 2 }, decayHalfLifeDays: 14, validations: { perWeek: 1 } });

    // The validation cap is part of the same block (BB-35 step 5): zero turns
    // the queue off, and an out-of-range cap is refused.
    const capped = parseProjectFile(JSON.stringify({ version: 1, lessons: { validations: { perWeek: 0 } } }));
    if (!capped.ok) throw new Error(capped.error);
    expect(capped.value.lessons.validations).toEqual({ perWeek: 0 });
    expect(parseProjectFile(JSON.stringify({ version: 1, lessons: { validations: { perWeek: 99 } } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, lessons: { promote: { hits: 0 } } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, lessons: { unknown: true } }))).toMatchObject({ ok: false });
  });

  it("takes the standing-rules list, and rejects an unknown key (BB-54)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.standingRules).toEqual([]);
    const withRules = parseProjectFile(JSON.stringify({ version: 1, standingRules: ["Migrations are append-only.", "No secrets in logs."] }));
    if (!withRules.ok) throw new Error(withRules.error);
    expect(withRules.value.standingRules).toEqual(["Migrations are append-only.", "No secrets in logs."]);
    expect(parseProjectFile(JSON.stringify({ version: 1, standingRule: ["typo"] }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, standingRules: [""] }))).toMatchObject({ ok: false });
  });
  it("takes a waitBudgets block, defaults every kind when absent, and rejects an unknown key (BB-351)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.waitBudgets).toEqual({});
    expect(waitBudgetMs("review", defaults.value.waitBudgets)).toBe(DEFAULT_WAIT_BUDGETS.review);
    expect(waitBudgetMs("worker", defaults.value.waitBudgets)).toBeNull();
    const explicit = parseProjectFile(JSON.stringify({ version: 1, waitBudgets: { review: "2h", person: "3d", external: null } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.value.waitBudgets).toEqual({ review: 2 * 3_600_000, person: 3 * 86_400_000, external: null });
    expect(waitBudgetMs("review", explicit.value.waitBudgets)).toBe(2 * 3_600_000);
    expect(waitBudgetMs("person", explicit.value.waitBudgets)).toBe(3 * 86_400_000);
    expect(waitBudgetMs("external", explicit.value.waitBudgets)).toBeNull();
    // An unknown kind is a load error, not a silently ignored key.
    expect(parseProjectFile(JSON.stringify({ version: 1, waitBudgets: { review: "2h", bogus: "1d" } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, waitBudgets: { review: "soon" } }))).toMatchObject({ ok: false });
  });

  it("parses mergeDispatch, defaulting to none, and refuses a bad entry (BB-216)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.mergeDispatch).toEqual([]);
    const configured = parseProjectFile(JSON.stringify({ version: 1, mergeDispatch: [{ repo: "acme/app", workflow: "build.yaml", workflowRepo: "acme/web", ref: "main", inputs: { only_if_moved: "true" } }] }));
    if (!configured.ok) throw new Error(configured.error);
    expect(configured.value.mergeDispatch).toEqual([{ repo: "acme/app", workflow: "build.yaml", workflowRepo: "acme/web", ref: "main", inputs: { only_if_moved: "true" } }]);
    // workflowRepo, ref and inputs are optional; inputs defaults to empty.
    const minimal = parseProjectFile(JSON.stringify({ version: 1, mergeDispatch: [{ repo: "acme/web", workflow: "build.yaml" }] }));
    if (!minimal.ok) throw new Error(minimal.error);
    expect(minimal.value.mergeDispatch).toEqual([{ repo: "acme/web", workflow: "build.yaml", inputs: {} }]);
    expect(parseProjectFile(JSON.stringify({ version: 1, mergeDispatch: [{ repo: "not a repo", workflow: "x.yaml" }] }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, mergeDispatch: [{ repo: "acme/web", workflow: "x.yaml", bogus: true }] }))).toMatchObject({ ok: false });
  });
});

describe("ops in the project file", () => {
  const file = (ops: unknown, teams = ["ENG", "OPS"]) => parseProjectFile(JSON.stringify({ version: 1, linear: { teams }, ops }));
  const error = (ops: unknown, teams?: string[]) => {
    const r = file(ops, teams);
    if (r.ok) expect.fail(`accepted ${JSON.stringify(ops)}`);
    return r.error;
  };

  it("takes namespace targets, a team and the priorities to adopt at once", () => {
    const r = file({ targets: [{ kind: "k8s-namespace", name: "web-production" }, { kind: "k8s-namespace", name: "db-production" }], team: "ops", autoAdopt: ["urgent"] });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.ops).toEqual({ targets: [{ kind: "k8s-namespace", name: "web-production" }, { kind: "k8s-namespace", name: "db-production" }], team: "OPS", autoAdopt: ["urgent"], sentry: { resolveOnDone: false } });
    expect(usesKind(r.value, "ops")).toBe(true);
    expect(opsTeam(r.value)).toEqual({ target: "OPS", source: "linear" });
  });

  it("files in the first Linear team when no team is named", () => {
    const r = file({ targets: [{ kind: "k8s-namespace", name: "prod" }] });
    expect(r.ok && opsTeam(r.value)).toEqual({ target: "ENG", source: "linear" });
    expect(r.ok && r.value.ops.autoAdopt).toEqual([]);
  });

  it("takes a dependabot target, and derives deps targets from the repo set when none is listed", () => {
    const r = file({ targets: [{ kind: "dependabot", repo: "acme/web" }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.ops.targets).toEqual([{ kind: "dependabot", repo: "acme/web" }]);
    expect(depsTargets(r.value, ["acme/other"])).toEqual([{ kind: "dependabot", repo: "acme/web" }]);
    expect(k8sTargets(r.value)).toEqual([]);
    // No explicit dependabot target: every repo in the set.
    const d = file({ targets: [{ kind: "k8s-namespace", name: "prod" }] });
    if (!d.ok) throw new Error(d.error);
    expect(depsTargets(d.value, ["acme/web", "acme/other"])).toEqual([{ kind: "dependabot", repo: "acme/web" }, { kind: "dependabot", repo: "acme/other" }]);
    expect(k8sTargets(d.value)).toEqual([{ kind: "k8s-namespace", name: "prod" }]);
    expect(error({ targets: [{ kind: "dependabot", repo: "not a repo" }] })).toMatch(/ops\.targets\.0\.repo/u);
  });

  it("accepts a Sentry project by organization and project slug, folded to Sentry's lower case", () => {
    const r = file({ targets: [{ kind: "sentry-project", org: " Acme ", project: "Web-API" }] });
    if (!r.ok) expect.fail(r.error);
    expect(r.value.ops.targets).toEqual([{ kind: "sentry-project", org: "acme", project: "web-api" }]);
    expect(sentryTargets(r.value)).toEqual([{ kind: "sentry-project", org: "acme", project: "web-api" }]);
    expect(k8sTargets(r.value)).toEqual([]);
    expect(usesKind(r.value, "ops")).toBe(true);
    expect(error({ targets: [{ kind: "sentry-project", org: "acme", project: "web api" }] })).toMatch(/ops\.targets\.0\.project: a Sentry slug/u);
    expect(error({ targets: [{ kind: "sentry-project", org: "acme" }] })).toMatch(/ops\.targets\.0\.project/u);
    expect(error({ targets: [{ kind: "sentry-project", org: "acme", project: "web" }, { kind: "sentry-project", org: "ACME", project: "web" }] })).toMatch(/ops\.targets\.1: sentry-project\/acme\/web is listed twice/u);
  });

  it("takes ops.sentry.resolveOnDone, off by default", () => {
    const off = file({ targets: [{ kind: "sentry-project", org: "acme", project: "web" }] });
    if (!off.ok) expect.fail(off.error);
    expect(off.value.ops.sentry.resolveOnDone).toBe(false);
    const on = file({ targets: [{ kind: "sentry-project", org: "acme", project: "web" }], sentry: { resolveOnDone: true } });
    if (!on.ok) expect.fail(on.error);
    expect(on.value.ops.sentry.resolveOnDone).toBe(true);
    expect(error({ targets: [], sentry: { resolve: true } })).toMatch(/ops\.sentry/u);
  });

  it("refuses what would watch nothing or file where nobody stewards", () => {
    expect(error({ targets: [{ kind: "k8s-namespace", name: "Prod_1" }] })).toMatch(/ops\.targets\.0\.name: a namespace name/u);
    expect(error({ targets: [{ kind: "pod", name: "prod" }] })).toMatch(/ops\.targets\.0\.kind/u);
    expect(error({ targets: [{ kind: "k8s-namespace", name: "prod" }, { kind: "k8s-namespace", name: "prod" }] })).toMatch(/ops\.targets\.1: k8s-namespace\/prod is listed twice/u);
    expect(error({ targets: [{ kind: "k8s-namespace", name: "prod" }], team: "SALES" })).toMatch(/ops\.team: SALES is not one of linear\.teams/u);
    expect(error({ targets: [{ kind: "k8s-namespace", name: "prod" }] }, [])).toMatch(/ops needs a filing target to file tickets in: set ops\.team to a Linear team key, a GitHub owner\/repo, or a local unit/u);
    expect(error({ targets: [], autoAdopt: ["critical"] })).toMatch(/ops\.autoAdopt\.0/u);
    expect(error({ targets: [], watch: true })).toMatch(/ops/u);
    // No targets, no team needed.
    expect(file({ targets: [] }, []).ok).toBe(true);
  });

  it("accepts a GitHub owner/repo filing target with no Linear teams, and rejects one outside the repo set (BB-235)", () => {
    const r = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: [] }, ops: { targets: [{ kind: "k8s-namespace", name: "prod" }], team: "acme/web" } }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.ops.team).toBe("acme/web");
    expect(opsTeam(r.value)).toEqual({ target: "acme/web", source: "github" });
    // The repo target satisfies the "needs a Linear team" check.
    expect(filingTargetProblems(r.value, null, ["acme/web", "acme/other"])).toEqual([]);
    // Not in the repo set: a problem.
    expect(filingTargetProblems(r.value, null, ["acme/other"])).toEqual([expect.stringMatching(/stewards\/project\.json ops\.team: acme\/web is not in repos\.json/u)]);
    // A Linear team key must still be one of linear.teams.
    expect(parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "k8s-namespace", name: "prod" }], team: "SALES" } }))).toMatchObject({ ok: false });
    // A role's repo target is checked against the repo set, and its team key against linear.teams.
    const roleRepo = parseRolesFile(JSON.stringify({ version: 2, roles: { ops: { team: "acme/other" } }, holders: { jane: ["ops"] } }));
    if (!roleRepo.ok) throw new Error(roleRepo.error);
    expect(filingTargetProblems(r.value, roleRepo.value, ["acme/web"])).toEqual([expect.stringMatching(/roles\.json jane's ops\.team: acme\/other is not in repos\.json/u)]);
    const roleTeam = parseRolesFile(JSON.stringify({ version: 2, roles: { ops: { team: "OPS" } }, holders: { jane: ["ops"] } }));
    if (!roleTeam.ok) throw new Error(roleTeam.error);
    expect(filingTargetProblems(r.value, roleTeam.value, ["acme/web"])).toEqual([expect.stringMatching(/roles\.json jane's ops\.team: OPS is not one of linear\.teams/u)]);
  });
});

describe("playbooks", () => {
  it("parses the four defaults", () => {
    for (const [name, text] of [["linear-tickets", LINEAR_TICKETS], ["github-prs", GITHUB_PRS], ["github-reviews", GITHUB_REVIEWS], ["ops-watch", OPS_WATCH]] as const) {
      const parsed = parsePlaybook(text, name);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    }
  });

  it("takes a reviewer model with the same syntax, and keeps the models map strict (BB-133)", () => {
    const withReviewer = LINEAR_TICKETS.replace(
      "models:\n  steward: claude/claude-sonnet-5-5/medium\n  worker: claude/claude-opus-5-5/high",
      "models:\n  steward: claude/claude-sonnet-5-5/medium\n  worker: claude/claude-opus-5-5/high\n  reviewer: pi/fireworks/accounts/fireworks/models/glm-5p3",
    );
    const parsed = parsePlaybook(withReviewer, "linear-tickets");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.models.reviewer).toMatchObject({ providerId: "pi", model: "fireworks/accounts/fireworks/models/glm-5p3", reasoningLevel: null });
    const plain = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.value.models.reviewer).toBeNull();
    // The map is still strict: a misspelled key is refused.
    expect(parsePlaybook(LINEAR_TICKETS.replace("models:\n", "models:\n  reviewers: claude/opus\n"), "linear-tickets")).toMatchObject({ ok: false });
  });

  it("tells the default playbooks to raise credentials as a secret escalation and to escalate build-time blockers", () => {
    const linear = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!linear.ok) throw new Error(linear.error);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/steward_report \{ escalate/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/resolution: "secret"/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/writeEnv/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/changes what the ticket needs/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/escalated as a `decision`/u);
    // BB-267: a by-hand configure step outside the repos is an escalation too.
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/a `configure` escalation raised in the spec turn/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/kind: "decision"/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/resolution: "done"/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/never a README line or a closing-comment follow-up/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/raise that step again/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/the user's to grant/u);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/followThrough/u);
    expect(phaseInstructions(linear.value, "In Review")).toMatch(/escalated as a `decision`/u);
    const prs = parsePlaybook(GITHUB_PRS, "github-prs");
    if (!prs.ok) throw new Error(prs.error);
    expect(phaseInstructions(prs.value, "draft")).toMatch(/escalated as a `decision`/u);
    expect(phaseInstructions(prs.value, "open")).toMatch(/escalated as a `decision`/u);
    const reviews = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!reviews.ok) throw new Error(reviews.error);
    expect(phaseInstructions(reviews.value, "open")).toMatch(/escalated as a `decision`/u);
  });

  it("tells every default playbook never to use the interactive question tool and to escalate instead (BB-199)", () => {
    const workers: [string, string][] = [
      ["linear-tickets", LINEAR_TICKETS],
      ["github-prs", GITHUB_PRS],
      ["github-reviews", GITHUB_REVIEWS],
      ["deps-prs", DEPS_PRS],
    ];
    for (const [name, raw] of workers) {
      expect(raw, name).toMatch(/interactive question tool/u);
      expect(raw, name).toMatch(/`AskUserQuestion`/u);
      expect(raw, name).toMatch(/A worker's task must say/u);
      expect(raw, name).toMatch(/bb stewards escalate/u);
      expect(raw, name).toMatch(/--context/u);
      expect(raw, name).toMatch(/--meanwhile wait/u);
    }
    const ops: [string, string][] = [
      ["ops-watch", OPS_WATCH],
      ["deps-alerts", DEPS_ALERTS],
    ];
    for (const [name, raw] of ops) {
      expect(raw, name).toMatch(/interactive question tool/u);
      expect(raw, name).toMatch(/`AskUserQuestion`/u);
      expect(raw, name).toMatch(/steward_report \{ escalate/u);
    }
    const linear = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!linear.ok) throw new Error(linear.error);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/bb stewards escalate/u);
  });

  it("tells the PR playbooks that an approval survives small follow-ups and when a human must approve", () => {
    const prs = parsePlaybook(GITHUB_PRS, "github-prs");
    if (!prs.ok) throw new Error(prs.error);
    expect(phaseInstructions(prs.value, "open")).toMatch(/small follow-up push after an approval/u);
    expect(phaseInstructions(prs.value, "open")).toMatch(/needs the owner's approval/u);
    const reviews = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!reviews.ok) throw new Error(reviews.error);
    expect(reviews.value.general).toMatch(/short check of the new commits/u);
    expect(reviews.value.general).toMatch(/owner-reviewed/u);
    expect(reviews.value.general).toMatch(/the plugin files the owner's\s+Approve item/u);
  });

  it("points the github-reviews worker at the shipped pr-reviewer skill and its marker (BB-206)", () => {
    const reviews = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!reviews.ok) throw new Error(reviews.error);
    // The playbook says the worker follows the skill, and the worker task names it.
    expect(reviews.value.general).toMatch(/follows the\s+`pr-reviewer` skill/u);
    expect(reviews.value.general).toMatch(/by following the pr-reviewer skill/u);
    // The review body opens with the round marker, and the marker's shape is stated.
    expect(reviews.value.general).toMatch(/review body opens with the round's marker\s+on its first line/u);
    expect(reviews.value.general).toMatch(/<!-- bb-review round=<N>/u);
    expect(reviews.value.general).toMatch(/approver=<owner\|project>/u);
  });

  it("parses the github-reviews substantial criteria, defaulting to empty, and rejects a blank or over-long entry (BB-207)", () => {
    const reviews = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!reviews.ok) throw new Error(reviews.error);
    expect(reviews.value.substantial).toHaveLength(5);
    expect(reviews.value.substantial[0]).toMatch(/new outbound integration/u);
    expect(reviews.value.substantial[2]).toMatch(/user-facing surface/u);
    // A playbook with no list behaves exactly as before: nothing substantial.
    const plain = parsePlaybook(GITHUB_PRS, "github-prs");
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.value.substantial).toEqual([]);
    // A blank or over-long criterion is refused, like `ready.substantial`.
    expect(parsePlaybook(GITHUB_REVIEWS.replace("substantial:\n", 'substantial:\n  - ""\n'), "github-reviews")).toMatchObject({ ok: false });
    expect(parsePlaybook(GITHUB_REVIEWS.replace("substantial:\n", `substantial:\n  - "${"x".repeat(301)}"\n`), "github-reviews")).toMatchObject({ ok: false });
  });

  it("maps states to phases and stages, ignoring case, and splits sections", () => {
    const parsed = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!parsed.ok) throw new Error(parsed.error);
    const p = parsed.value;
    expect(phaseOf(p, "in progress")).toEqual({ name: "In Progress", stage: "build", stuckMs: 2 * 86_400_000 });
    expect(phaseOf(p, "Nowhere")).toBeNull();
    expect(isTerminal(p, "done")).toBe(true);
    expect(phaseInstructions(p, "todo")).toMatch(/Specify the ticket/u);
    expect(p.general).toMatch(/You steward one Linear ticket/u);
    expect(p.requeueDefaultMs).toBe(2 * 86_400_000);
    expect(p.followThroughMs).toBe(6 * 3_600_000);
    // BB-83: the idle grace defaults to 15m and a playbook may override it.
    expect(p.idleGraceMs).toBe(15 * 60_000);
    // BB-247: the dated-wait cap defaults to 90d and a playbook may override it.
    expect(p.maxWaitMs).toBe(90 * 86_400_000);
    const maxWait = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nmax-wait: 30d"), "linear-tickets");
    expect(maxWait.ok && maxWait.value.maxWaitMs).toBe(30 * 86_400_000);
    const shorter = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nfollow-through: 90m"), "linear-tickets");
    expect(shorter.ok && shorter.value.followThroughMs).toBe(90 * 60_000);
    const idleGrace = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nidle-grace: 5m"), "linear-tickets");
    expect(idleGrace.ok && idleGrace.value.idleGraceMs).toBe(5 * 60_000);
    expect(p.ready?.approval).toBe("project");
    expect(playbookStates(p)).toEqual(expect.arrayContaining(["Todo", "In Review", "Done", "Canceled"]));
    expect(p.version).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("keys a phase on a label with `label:<name>`, keeping it out of the states (BB-248)", () => {
    const withLabel = parsePlaybook(LINEAR_TICKETS.replace("  In Progress: { stage: build, stuck: 2d }", '  In Progress: { stage: build, stuck: 2d }\n  "label:initiative:awaiting-outcome": { stage: build, stuck: 120d }'), "linear-tickets");
    if (!withLabel.ok) throw new Error(withLabel.error);
    const p = withLabel.value;
    expect(labelPhaseName("label:initiative:awaiting-outcome")).toBe("initiative:awaiting-outcome");
    expect(labelPhaseName("In Progress")).toBeNull();
    expect(playbookLabels(p)).toEqual(["initiative:awaiting-outcome"]);
    expect(playbookStates(p)).not.toContain("label:initiative:awaiting-outcome");
    expect(playbookStates(p)).toContain("In Progress");
    // phaseOf still resolves the label key itself, for a binding's stored phase.
    expect(phaseOf(p, "label:initiative:awaiting-outcome")).toMatchObject({ name: "label:initiative:awaiting-outcome", stage: "build" });
    // A `label:` key with no name is refused; a state-only playbook has no label keys.
    expect(parsePlaybook(LINEAR_TICKETS.replace("  In Progress: { stage: build, stuck: 2d }", '  In Progress: { stage: build, stuck: 2d }\n  "label:": { stage: build }'), "linear-tickets")).toMatchObject({ ok: false });
    const plain = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!plain.ok) throw new Error(plain.error);
    expect(playbookLabels(plain.value)).toEqual([]);
  });

  it("normalises the pre-rename approval alias `me` to `user` with a warning (BB-209)", () => {
    const user = parsePlaybook(LINEAR_TICKETS.replace("approval: project", "approval: user"), "linear-tickets");
    if (!user.ok) throw new Error(user.error);
    expect(user.value.ready?.approval).toBe("user");
    expect(user.value.warnings).toEqual([]);

    const alias = parsePlaybook(LINEAR_TICKETS.replace("approval: project", "approval: me"), "linear-tickets");
    if (!alias.ok) throw new Error(alias.error);
    expect(alias.value.ready?.approval).toBe("user");
    expect(alias.value.warnings).toHaveLength(1);
    expect(alias.value.warnings[0]).toMatch(/"me" is renamed to "user"/u);

    // The default is unchanged and warns about nothing.
    const plain = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.value.ready?.approval).toBe("project");
    expect(plain.value.warnings).toEqual([]);
  });

  it("accepts a source-neutral approval state and the old linear-state spelling (BB-232)", () => {
    const neutral = parsePlaybook(LINEAR_TICKETS.replace("approval: project", 'approval: { state: "Approved" }'), "linear-tickets");
    if (!neutral.ok) throw new Error(neutral.error);
    expect(neutral.value.ready?.approval).toEqual({ state: "Approved" });
    expect(playbookStates(neutral.value)).toContain("Approved");

    const legacy = parsePlaybook(LINEAR_TICKETS.replace("approval: project", 'approval: { "linear-state": "Approved" }'), "linear-tickets");
    if (!legacy.ok) throw new Error(legacy.error);
    expect(legacy.value.ready?.approval).toEqual({ state: "Approved" });
    expect(playbookStates(legacy.value)).toContain("Approved");
  });

  it("takes a deployment target's optional workflows list, defaulting to none (BB-61)", () => {
    const withDeployment = (extra: string) =>
      LINEAR_TICKETS.replace(
        "requeue-default: 2d",
        `requeue-default: 2d\ndeployment:\n  source: github\n  repo: acme/web\n  environment: production\n  carries: "the pin contains the merge"\n  timeout: 6h${extra}`,
      );
    const none = parsePlaybook(withDeployment(""), "linear-tickets");
    if (!none.ok) throw new Error(none.error);
    expect(none.value.deployments[0]).toMatchObject({ repo: "acme/web", environment: "production", workflows: [] });
    const named = parsePlaybook(withDeployment("\n  workflows: [build.yaml, image.yaml]"), "linear-tickets");
    if (!named.ok) throw new Error(named.error);
    expect(named.value.deployments[0]?.workflows).toEqual(["build.yaml", "image.yaml"]);
  });

  it("takes a list of deployment targets with structured carries rules (BB-132)", () => {
    const structured = LINEAR_TICKETS.replace(
      "requeue-default: 2d",
      [
        "requeue-default: 2d",
        "deployment:",
        "  - name: web",
        "    source: github",
        "    repo: acme/web",
        "    environment: production",
        "    carries:",
        "      - when: { repo: acme/app }",
        "        strategy:",
        "          kind: image-tag",
        "          manifest: deploy/kustomization.yaml",
        "          image: bb-server",
        "          workflow: build.yaml",
        "          job: build_and_push_image",
        "          consumer: { dockerfile: Dockerfile, pinArg: PLUGIN_REF, repo: acme/app }",
        "      - when: { repo: acme/web, paths: [docker/bb-server/**] }",
        "        strategy: { kind: ref-contains-merge }",
        "  - name: tools",
        "    source: github",
        "    repo: acme/tools",
        "    environment: production",
        "    carries: [{ when: { repo: acme/tools }, strategy: { kind: ref-contains-merge } }]",
      ].join("\n"),
    );
    const parsed = parsePlaybook(structured, "linear-tickets");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.deployments.map((d) => d.name)).toEqual(["web", "tools"]);
    expect(parsed.value.deployments[0]!.carries).toHaveLength(2);
    const rules = parsed.value.deployments[0]!.carries as Array<{ strategy: { kind: string } }>;
    expect(rules[0]!.strategy.kind).toBe("image-tag");
    expect(rules[1]!.strategy.kind).toBe("ref-contains-merge");
    // A single free-text target still parses, exactly as before.
    const singleText = LINEAR_TICKETS.replace("requeue-default: 2d", 'requeue-default: 2d\ndeployment:\n  source: github\n  repo: acme/web\n  environment: production\n  carries: "the pin contains the merge"\n  timeout: 6h');
    const single = parsePlaybook(singleText, "linear-tickets");
    if (!single.ok) throw new Error(single.error);
    expect(single.value.deployments).toHaveLength(1);
    expect(single.value.deployments[0]!.carries).toBe("the pin contains the merge");
    // An unknown strategy is refused, and so is an empty rule list.
    expect(parsePlaybook(structured.replace("kind: ref-contains-merge", "kind: magic"), "linear-tickets")).toMatchObject({ ok: false });
    expect(parsePlaybook(structured.replace("carries: [{ when: { repo: acme/tools }, strategy: { kind: ref-contains-merge } }]", "carries: []"), "linear-tickets")).toMatchObject({ ok: false });
    // Two targets cannot share a name: their watches would share a key.
    const duplicate = parsePlaybook(structured.replace("name: tools", "name: web"), "linear-tickets");
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate.ok) expect(duplicate.error).toMatch(/web is listed twice/u);
  });

  // BB-260: the third strategy, for a merge nothing builds or applies.
  it("takes a live-at-merge carries strategy and still refuses an unknown kind", () => {
    const structured = LINEAR_TICKETS.replace(
      "requeue-default: 2d",
      [
        "requeue-default: 2d",
        "deployment:",
        "  source: github",
        "  repo: acme/web",
        "  environment: production",
        "  carries:",
        "    - when: { repo: acme/web, paths: [deploy/**, config.json] }",
        "      strategy: { kind: ref-contains-merge }",
        "    - when: { repo: acme/web, paths: [.bb/**, docs/**, '**.md'] }",
        "      strategy: { kind: live-at-merge }",
        "  timeout: 90m",
      ].join("\n"),
    );
    const parsed = parsePlaybook(structured, "linear-tickets");
    if (!parsed.ok) throw new Error(parsed.error);
    const rules = parsed.value.deployments[0]!.carries as Array<{ strategy: { kind: string } }>;
    expect(rules.map((r) => r.strategy.kind)).toEqual(["ref-contains-merge", "live-at-merge"]);
    expect(parsePlaybook(structured.replace("kind: live-at-merge", "kind: magic"), "linear-tickets")).toMatchObject({ ok: false });
  });

  it("refuses what would misbehave", () => {
    expect(parsePlaybook("no front matter", "x")).toMatchObject({ ok: false });
    expect(parsePlaybook(LINEAR_TICKETS, "other-name")).toMatchObject({ ok: false });
    const wrongSource = LINEAR_TICKETS.replace("source: linear", "source: k8s");
    expect(parsePlaybook(wrongSource, "linear-tickets")).toMatchObject({ ok: false });
    const noGate = LINEAR_TICKETS.replace(/ready:[\s\S]*?approval: project\n/u, "");
    const r = parsePlaybook(noGate, "linear-tickets");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs a ready gate/u);
    const overlap = GITHUB_PRS.replace("terminal: [merged, closed]", "terminal: [merged, closed, open]");
    expect(parsePlaybook(overlap, "github-prs")).toMatchObject({ ok: false });
    const emptyWorkflow = LINEAR_TICKETS.replace("requeue-default: 2d", 'requeue-default: 2d\ndeployment:\n  source: github\n  repo: acme/web\n  environment: production\n  carries: "x"\n  workflows: [""]');
    expect(parsePlaybook(emptyWorkflow, "linear-tickets")).toMatchObject({ ok: false });
  });
});

describe("the ops playbook", () => {
  it("has no phases or terminal states, sections for what a look found, and a may list of read-only kubectl, filing, commenting and escalating", () => {
    const parsed = parsePlaybook(OPS_WATCH, "ops-watch");
    if (!parsed.ok) throw new Error(parsed.error);
    const p = parsed.value;
    expect(p).toMatchObject({ kind: "ops", source: "k8s", phases: {}, terminal: [], ready: null, may: ["kubectl get", "kubectl describe", "kubectl logs", "kubectl auth can-i", "file-ticket", "comment", "escalate"], requeueDefaultMs: 3_600_000 });
    expect(phaseInstructions(p, "new")).toMatch(/File one ticket per problem/u);
    expect(phaseInstructions(p, "recurring")).toMatch(/File nothing new/u);
    expect(phaseInstructions(p, "returned")).toMatch(/reopened/u);
    expect(p.general).toMatch(/Fingerprint: `<fingerprint>`/u);
  });

  it("refuses entity state on an ops playbook, the wrong source, and a non-ops playbook with nothing terminal", () => {
    const phased = OPS_WATCH.replace("may:", "phases:\n  open: {}\nmay:");
    expect(parsePlaybook(phased, "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/an ops playbook has no phases/u) });
    expect(parsePlaybook(OPS_WATCH.replace("may:", "terminal: [Done]\nmay:"), "ops-watch")).toMatchObject({ ok: false });
    // BB-334: an ops playbook may read linear too (the backlog binding); an
    // unknown source is still refused.
    expect(parsePlaybook(OPS_WATCH.replace("source: k8s", "source: linear"), "ops-watch")).toMatchObject({ ok: true });
    expect(parsePlaybook(OPS_WATCH.replace("source: k8s", "source: bogus"), "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/source: Invalid option/u) });
    expect(parsePlaybook(GITHUB_PRS.replace("terminal: [merged, closed]\n", ""), "github-prs")).toMatchObject({ ok: false, error: expect.stringMatching(/terminal: name at least one state/u) });
    // A ticket, pr or review playbook still needs its phases, as before ops.
    const noPhases = GITHUB_PRS.replace(/phases:\n(?: {2}.*\n)+/u, "");
    expect(noPhases).not.toMatch(/phases:/u);
    expect(parsePlaybook(noPhases, "github-prs")).toMatchObject({ ok: false, error: expect.stringMatching(/phases: map the entity's states to stages/u) });
  });
});

// BB-234: a project may carry both ticket playbooks, chosen by source; a
// GitHub issue's state is a status label, so only label states are validated.
describe("the GitHub issue playbook (BB-234)", () => {
  it("parses as a github ticket playbook with label phases and derived closed states", () => {
    const parsed = parsePlaybook(GITHUB_ISSUES, "github-issues");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toMatchObject({ kind: "ticket", source: "github" });
    expect(Object.keys(parsed.value.phases)).toEqual(["open", "status:todo", "status:in-progress", "status:in-review"]);
    expect(parsed.value.terminal).toEqual(["closed", "closed (completed)", "closed (not planned)", "closed (duplicate)"]);
    // GitHub sub-issues (BB-250, BB-360): create-sub-issue is in `may`, the
    // promote rule is set, and the status:todo phase files a child through the
    // source-neutral ticket_file, naming the parent.
    expect(parsed.value.may).toContain("create-sub-issue");
    expect(parsed.value.promote).toBe("A sub-issue that needs more than one pull request, its own approval, or work in a repo the parent does not touch.");
    const todo = phaseInstructions(parsed.value, "status:todo")!;
    expect(todo).toContain('ticket_file { unit, title, description, parent, assignee: "me" }');
    expect(todo).toMatch(/real sub-issue/u);
    expect(phaseInstructions(parsed.value, "status:in-review")).toMatch(/ticket_update \{ key, state \}/u);
    expect(phaseInstructions(parsed.value, "open")).toMatch(/Add `status:todo`/u);
    expect(phaseInstructions(parsed.value, "status:in-progress")).toContain("no `Fixes #N`");
  });

  it("returns only the label states to validate and create, not GitHub's derived states", () => {
    const parsed = parsePlaybook(GITHUB_ISSUES, "github-issues");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(playbookStates(parsed.value)).toContain("closed (completed)");
    expect(githubStateLabels(parsed.value)).toEqual(["status:todo", "status:in-progress", "status:in-review"]);
  });

  it("defaults a no-teams project's ticket playbook to github-issues and keeps linear-tickets otherwise", () => {
    const noTeams = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: [] } }));
    if (!noTeams.ok) throw new Error(noTeams.error);
    expect(playbookNameFor(noTeams.value, "ticket")).toBe("github-issues");
    const teams = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] } }));
    if (!teams.ok) throw new Error(teams.error);
    expect(playbookNameFor(teams.value, "ticket")).toBe("linear-tickets");
    // An explicit playbook still wins.
    const explicit = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, playbooks: { ticket: "my-tickets" } }));
    if (!explicit.ok) throw new Error(explicit.error);
    expect(playbookNameFor(explicit.value, "ticket")).toBe("my-tickets");
  });
});

describe("the dependency playbooks", () => {
  it("parses deps-alerts as an ops playbook and deps-prs as a pr playbook", () => {
    const alerts = parsePlaybook(DEPS_ALERTS, "deps-alerts");
    if (!alerts.ok) throw new Error(alerts.error);
    expect(alerts.value).toMatchObject({ kind: "ops", source: "github", phases: {}, terminal: [], ready: null });
    expect(phaseInstructions(alerts.value, "new")).toMatch(/File one ticket per problem/u);
    expect(phaseInstructions(alerts.value, "recurring")).toMatch(/File nothing new/u);
    expect(alerts.value.general).toMatch(/Fingerprint: `<repo>#<alert number>`/u);
    expect(alerts.value.general).toMatch(/batch plan/u);

    const prs = parsePlaybook(DEPS_PRS, "deps-prs");
    if (!prs.ok) throw new Error(prs.error);
    expect(prs.value).toMatchObject({ kind: "pr", source: "github", terminal: ["merged", "closed"] });
    expect(prs.value.general).toMatch(/never merge/u);
    expect(prs.value.general).toMatch(/files a \*\*Merge\*\* item for it there, and the owner presses it/u);
    expect(prs.value.general).toMatch(/steward_report \{ replacedBy: "owner\/repo#N" \}/u);
    expect(prs.value.general).toMatch(/major bump/u);
    expect(prs.value.general).toMatch(/owner-reviewed/u);
    expect(prs.value.skipAuthors).toEqual(expect.arrayContaining(["dependabot[bot]"]));
  });

  it("keeps the deps playbooks in the init templates", () => {
    expect(projectFileTemplate(["ENG"])).toContain('"deps"');
  });
});

describe("model specs", () => {
  it("takes a model id with slashes, and the level only when the last part names one", () => {
    const parse = (text: string) => modelSpecSchema.parse(text);
    expect(parse("claude/claude-opus-5-5/high")).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(parse("pi")).toMatchObject({ providerId: "pi", model: null, reasoningLevel: null });
    expect(parse("pi/fireworks/accounts/fireworks/models/deepseek-v4p1-flash")).toMatchObject({ providerId: "pi", model: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash", reasoningLevel: null });
    expect(parse("pi/fireworks/accounts/fireworks/models/deepseek-v4p1-flash/low")).toMatchObject({ model: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash", reasoningLevel: "low" });
    // "high" alone after the provider is a model, as before.
    expect(parse("claude/high")).toMatchObject({ model: "high", reasoningLevel: null });
    for (const bad of ["/x", "claude/", "claude//high", "pi/a//b"]) expect(modelSpecSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("roles.json (BB-105)", () => {
  const roles = (entries: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseRolesFile(JSON.stringify({ version: 1, roles: entries, ...extra }));

  it("parses roles, folds logins to lower case and fills the defaults", () => {
    const parsed = roles({ "Jane-Doe": { projectSteward: true, ops: { k8sNamespaces: ["prod"], team: "eng", sentry: { projects: [{ org: " Acme ", project: "Web-API" }] }, alertmanager: { namespaces: ["web-production"] }, dependabot: ["acme/web"] } }, Bob: {} });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.roles)).toEqual(["jane-doe", "bob"]);
    const role = parsed.value.roles["jane-doe"]!;
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ k8sNamespaces: ["prod"], team: "ENG", autoAdopt: [], sentry: { projects: [{ org: "acme", project: "web-api" }], resolveOnDone: false }, alertmanager: { namespaces: ["web-production"] }, dependabot: ["acme/web"] });
    expect(parsed.value.roles["bob"]).toEqual({ projectSteward: false, ops: undefined });
    // The role getters read the entry, not the legacy project.ops.
    expect(roleK8sTargets(role)).toEqual([{ kind: "k8s-namespace", name: "prod" }]);
    expect(roleSentryTargets(role)).toEqual([{ kind: "sentry-project", org: "acme", project: "web-api" }]);
    expect(roleAlertmanagerTargets(role)).toEqual([{ kind: "alertmanager", namespace: "web-production" }]);
    expect(roleDepsTargets(role, ["acme/web", "acme/other"])).toEqual([{ kind: "dependabot", repo: "acme/web" }]);
    expect(roleDepsTargets(parsed.value.roles["bob"]!, ["acme/web"])).toEqual([]);
    expect(roleUsesOps(role)).toBe(true);
    expect(roleUsesOps(parsed.value.roles["bob"]!)).toBe(false);
  });

  it("takes dependabot: all, and names the file in a parse error", () => {
    const parsed = roles({ jane: { ops: { dependabot: "all" } } });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(roleDepsTargets(parsed.value.roles["jane"]!, ["acme/web", "acme/other"])).toEqual([{ kind: "dependabot", repo: "acme/web" }, { kind: "dependabot", repo: "acme/other" }]);
    const bad = roles({ jane: { ops: { k8sNamespaces: ["Prod_1"] } } });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/stewards\/roles\.json: roles\.jane\.ops\.k8sNamespaces\.0: a namespace name/u);
    // The Alertmanager opt-in is strict too: a bad namespace is refused, and an
    // unknown key under it is refused (the restart-that-knows-it rule).
    expect(roles({ jane: { ops: { alertmanager: { namespaces: ["Bad_Name"] } } } })).toMatchObject({ ok: false, error: expect.stringMatching(/roles\.jane\.ops\.alertmanager\.namespaces\.0: a namespace name/u) });
    expect(roles({ jane: { ops: { alertmanager: { projects: [] } } } })).toMatchObject({ ok: false });
  });

  it("parses an optional slack handle per holder, and still refuses an unknown key beside it (BB-354)", () => {
    const parsed = roles({ jane: { projectSteward: true, slack: "jane-doe" }, bob: {} });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.roles["jane"]!.slack).toBe("jane-doe");
    expect(parsed.value.roles["bob"]!.slack).toBeUndefined();
    expect(roles({ jane: { slack: "jane", unknown: true } })).toMatchObject({ ok: false });
  });

  it("rejects unknown keys, a bad version, and two keys naming one login ignoring case", () => {
    expect(roles({ jane: { projectSteward: true } }, { extra: true })).toMatchObject({ ok: false });
    expect(roles({ jane: { unknown: true } })).toMatchObject({ ok: false });
    expect(parseRolesFile(JSON.stringify({ version: 2, roles: {} }))).toMatchObject({ ok: false });
    expect(roles({ Jane: {}, jane: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/same login as another entry/u) });
    expect(parseRolesFile("{")).toMatchObject({ ok: false });
  });

  it("keeps the project file strict, so an unknown key is still refused", () => {
    expect(parseProjectFile(JSON.stringify({ version: 1, ops: { targets: [], watch: true } }))).toMatchObject({ ok: false });
    expect(parseProjectFile(JSON.stringify({ version: 1, roles: {} }))).toMatchObject({ ok: false });
  });

  it("builds a legacy role from project.ops, and flags only non-empty ops as migration", () => {
    const empty = parseProjectFile(JSON.stringify({ version: 1, ops: { targets: [], autoAdopt: [] } }));
    if (!empty.ok) throw new Error(empty.error);
    expect(legacyOpsPresent(empty.value)).toBe(false);

    const legacy = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "sentry-project", org: "acme", project: "web" }, { kind: "alertmanager", namespace: "web-production" }], team: "eng", context: "prod", autoAdopt: ["urgent"], sentry: { resolveOnDone: true } } }));
    if (!legacy.ok) throw new Error(legacy.error);
    expect(legacyOpsPresent(legacy.value)).toBe(true);
    const role = legacyRole(legacy.value);
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ team: "ENG", context: "prod", autoAdopt: ["urgent"], sentry: { projects: [{ org: "acme", project: "web" }], resolveOnDone: true }, alertmanager: { namespaces: ["web-production"] }, dependabot: "all" });
    expect(roleOpsTeam(role, legacy.value)).toEqual({ target: "ENG", source: "linear" });
    expect(usesKind(legacy.value, "ops", role)).toBe(true);
  });

  it("reports an unowned or doubly owned watch, and no problem for two project stewards", () => {
    const project = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "k8s-namespace", name: "web-production" }, { kind: "sentry-project", org: "acme", project: "web" }] } }));
    if (!project.ok) throw new Error(project.error);
    const none = roles({ jane: {}, bob: {} });
    if (!none.ok) throw new Error(none.error);
    expect(projectStewardProblem(none.value)).toMatch(/no one is the project steward/u);

    // Two or more holders is normal (BB-230): each server runs only its own
    // login's roles, so no problem is reported for them.
    const two = roles({ jane: { projectSteward: true }, bob: { projectSteward: true } });
    if (!two.ok) throw new Error(two.error);
    expect(projectStewardProblem(two.value)).toBeNull();

    const doubled = roles({ jane: { projectSteward: true, ops: { k8sNamespaces: ["web-production"] } }, bob: { ops: { k8sNamespaces: ["web-production"] } } });
    if (!doubled.ok) throw new Error(doubled.error);
    // No explicit dependabot target: the default (every repo) is expected.
    const problems = watchProblems(project.value, doubled.value, ["acme/web", "acme/other"], true);
    expect(problems).toContain("two people run the web-production watch: jane, bob");
    expect(problems).toContain("nobody runs the Sentry watch for acme/web");
    expect(problems).toContain("nobody runs the Dependabot watch for acme/web");
    expect(problems).toContain("nobody runs the Dependabot watch for acme/other");
  });
});

describe("roles.json version 2 (BB-163)", () => {
  const v2 = (definitions: Record<string, unknown>, holders: Record<string, unknown>) => parseRolesFile(JSON.stringify({ version: 2, roles: definitions, holders }));
  const project = () => {
    const parsed = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "k8s-namespace", name: "web-production" }] } }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("parses named roles and holders, merges a holder's roles, and keeps the built-in projectSteward", () => {
    const parsed = v2(
      {
        ops: { k8sNamespaces: ["web-production"], team: "eng", sentry: { projects: [{ org: " Acme ", project: "Web-API" }] }, dependabot: "all" },
        deps: { dependabot: ["acme/web"], autoAdopt: ["urgent"] },
      },
      { "Jane-Doe": ["ops", "deps", "projectSteward"], Bob: ["ops"] },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.roles)).toEqual(["jane-doe", "bob"]);
    expect(parsed.value.holders["jane-doe"]).toEqual(["ops", "deps", "projectSteward"]);
    const role = parsed.value.roles["jane-doe"]!;
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ k8sNamespaces: ["web-production"], team: "ENG", autoAdopt: ["urgent"], sentry: { projects: [{ org: "acme", project: "web-api" }], resolveOnDone: false }, dependabot: "all" });
    // bob holds only ops: no projectSteward, and the same watches jane's ops role gives.
    expect(parsed.value.roles["bob"]!.projectSteward).toBe(false);
    expect(roleOpsTargets(parsed.value.roles["bob"]!)).toEqual(roleOpsTargets(role));
    expect(roleDepsTargets(parsed.value.roles["bob"]!, ["acme/web", "acme/other"])).toEqual(roleDepsTargets(role, ["acme/web", "acme/other"]));
  });

  it("parses a holder's slack field in the object form, keeps the array form, and refuses an unknown key beside it (BB-354)", () => {
    const parsed = v2({ ops: {} }, { jane: { roles: ["ops", "projectSteward"], slack: "jane-doe" } });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.holders["jane"]).toEqual(["ops", "projectSteward"]);
    expect(parsed.value.roles["jane"]!.slack).toBe("jane-doe");
    // The array form still parses, with no slack.
    const array = v2({ ops: {} }, { jane: ["ops"] });
    if (!array.ok) throw new Error(array.error);
    expect(array.value.roles["jane"]!.slack).toBeUndefined();
    // Strict: an unknown key beside roles/slack is refused.
    expect(v2({ ops: {} }, { jane: { roles: ["ops"], handle: "jane" } })).toMatchObject({ ok: false });
  });

  it("gives the same bindings, target keys and check result as the equivalent version 1 file", () => {
    const entry = { k8sNamespaces: ["prod"], context: "prod", team: "ENG", sentry: { projects: [{ org: "acme", project: "web" }] }, dependabot: ["acme/web"] };
    const v1 = parseRolesFile(JSON.stringify({ version: 1, roles: { jane: { projectSteward: true, ops: entry } } }));
    const modern = v2({ ops: entry }, { jane: ["ops", "projectSteward"] });
    if (!v1.ok || !modern.ok) throw new Error("parse failed");
    expect(modern.value.roles["jane"]).toEqual(v1.value.roles["jane"]);
    expect(roleOpsTargets(modern.value.roles["jane"]!)).toEqual(roleOpsTargets(v1.value.roles["jane"]!));
    expect(roleDepsTargets(modern.value.roles["jane"]!, ["acme/web", "acme/other"])).toEqual(roleDepsTargets(v1.value.roles["jane"]!, ["acme/web", "acme/other"]));
    expect(roleOpsTeam(modern.value.roles["jane"]!, project())).toEqual(roleOpsTeam(v1.value.roles["jane"]!, project()));
    expect(projectStewardProblem(modern.value)).toBeNull();
    expect(watchProblems(project(), modern.value, [], false)).toEqual(watchProblems(project(), v1.value, [], false));
  });

  it("reports two holders of overlapping targets, and keeps both running unchanged", () => {
    const parsed = v2({ web: { k8sNamespaces: ["web-production"] }, db: { k8sNamespaces: ["web-production"] } }, { alice: ["web"], bob: ["db"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(watchProblems(project(), parsed.value, [], false)).toContain("two people run the web-production watch: alice, bob");
    // Both roles still resolve to their own holder: nothing is dropped or merged at runtime.
    expect(roleK8sTargets(parsed.value.roles["alice"]!)).toEqual([{ kind: "k8s-namespace", name: "web-production" }]);
    expect(roleK8sTargets(parsed.value.roles["bob"]!)).toEqual([{ kind: "k8s-namespace", name: "web-production" }]);
  });

  it("reports zero project stewards, and none for two", () => {
    const none = v2({ ops: {} }, { alice: ["ops"] });
    if (!none.ok) throw new Error(none.error);
    expect(projectStewardProblem(none.value)).toMatch(/no one holds projectSteward/u);
    const two = v2({ ops: {} }, { alice: ["ops", "projectSteward"], bob: ["projectSteward"] });
    if (!two.ok) throw new Error(two.error);
    expect(projectStewardProblem(two.value)).toBeNull();
  });

  it("reports an unknown role name, and ignores it at runtime", () => {
    const parsed = v2({ ops: { k8sNamespaces: ["prod"] } }, { alice: ["ops", "bogus"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(roleProblems(parsed.value)).toEqual(['alice holds an unknown role "bogus": define it under roles, or use projectSteward']);
    expect(roleOpsTargets(parsed.value.roles["alice"]!)).toEqual([{ kind: "k8s-namespace", name: "prod" }]);
  });

  it("reports a conflicting context or team on merge, and takes the first at runtime", () => {
    const parsed = v2({ a: { context: "prod", team: "ENG" }, b: { context: "other", team: "OPS" } }, { alice: ["a", "b"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const problems = roleProblems(parsed.value);
    expect(problems).toContain("alice holds roles with conflicting context (prod, other): a holder's roles must agree on one context");
    expect(problems).toContain("alice holds roles with conflicting team (ENG, OPS): a holder's roles must agree on one team");
    expect(parsed.value.roles["alice"]!.ops).toMatchObject({ context: "prod", team: "ENG" });
  });

  it("warns about a role no holder names", () => {
    const parsed = v2({ ops: { k8sNamespaces: ["prod"] }, unused: {} }, { alice: ["ops"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(roleWarnings(parsed.value)).toEqual(['role "unused" has no holder']);
  });

  it("attributes each target key to the role whose definition owns it", () => {
    const parsed = v2({ web: { k8sNamespaces: ["web-production"] }, db: { k8sNamespaces: ["db-production"] } }, { alice: ["web", "db"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const map = bindingRoles(parsed.value, "alice", []);
    expect(map.get("k8s-namespace/web-production")).toEqual(["web"]);
    expect(map.get("k8s-namespace/db-production")).toEqual(["db"]);
  });

  it("refuses a definition for the built-in projectSteward role, a missing holders map, and an empty holder list", () => {
    expect(parseRolesFile(JSON.stringify({ version: 2, roles: { projectSteward: {} }, holders: { alice: ["projectSteward"] } }))).toMatchObject({ ok: false });
    expect(parseRolesFile(JSON.stringify({ version: 2, roles: {} }))).toMatchObject({ ok: false });
    expect(parseRolesFile(JSON.stringify({ version: 2, roles: {}, holders: { alice: [] } }))).toMatchObject({ ok: false });
    expect(parseRolesFile(JSON.stringify({ version: 2, roles: { ops: {} }, holders: { Jane: ["ops"], jane: ["ops"] } }))).toMatchObject({ ok: false, error: expect.stringMatching(/same login as another entry/u) });
  });
});

describe("roles.json backlog role (BB-332)", () => {
  const backlog = (role: Record<string, unknown>) => parseRolesFile(JSON.stringify({ version: 2, roles: { backlog: role }, holders: { trotterdylan: ["backlog"] } }));

  it("parses a backlog role's team, folded to upper case, on the definition and the effective role", () => {
    const parsed = backlog({ backlog: { team: " bb " } });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.definitions.backlog).toMatchObject({ backlog: { team: "BB" } });
    expect(parsed.value.roles["trotterdylan"]!.ops?.backlog).toEqual({ team: "BB" });
    // The example entry the design must accept, through the roles file schema.
    const example = parseRolesFile(JSON.stringify({ version: 2, roles: { backlog: { backlog: { team: "BB" } } }, holders: { trotterdylan: ["backlog"] } }));
    if (!example.ok) throw new Error(example.error);
    expect(example.value.roles["trotterdylan"]!.ops?.backlog).toEqual({ team: "BB" });
  });

  it("rejects an empty backlog, a missing or bad team, and an unknown key inside it", () => {
    expect(backlog({ backlog: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/roles\.backlog\.backlog\.team/u) });
    expect(backlog({ backlog: { team: "" } })).toMatchObject({ ok: false });
    expect(backlog({ backlog: { team: "Bad Key" } })).toMatchObject({ ok: false });
    expect(backlog({ backlog: { team: "BB", bogus: true } })).toMatchObject({ ok: false });
  });

  it("leaves a role without backlog exactly as before", () => {
    const parsed = backlog({ k8sNamespaces: ["prod"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.definitions.backlog).toStrictEqual({ k8sNamespaces: ["prod"], autoAdopt: [], sentry: { projects: [], resolveOnDone: false }, alertmanager: { namespaces: [] }, pulls: [] });
    expect(parsed.value.roles["trotterdylan"]!.ops).toStrictEqual({ k8sNamespaces: ["prod"], autoAdopt: [], sentry: { projects: [], resolveOnDone: false }, alertmanager: { namespaces: [] }, pulls: [] });
  });
});

describe("role pull watches (BB-164)", () => {
  const v2 = (definitions: Record<string, unknown>, holders: Record<string, string[]>) => parseRolesFile(JSON.stringify({ version: 2, roles: definitions, holders }));
  const playbooks = () => {
    const prs = parsePlaybook(GITHUB_PRS, "github-prs");
    const deps = parsePlaybook(DEPS_PRS, "deps-prs");
    const tickets = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!prs.ok || !deps.ok || !tickets.ok) throw new Error("playbook parse failed");
    return new Map([
      ["github-prs", prs.value],
      ["deps-prs", deps.value],
      ["linear-tickets", tickets.value],
    ]);
  };

  it("parses a role's pull watches and compiles the Dependabot watch first", () => {
    const parsed = v2({ ops: { dependabot: ["acme/web"], pulls: [{ repo: "acme/web", match: { title: "Update *", branch: "update-*", paths: ["projects/*/prod.yaml"] }, playbook: "sync-prs" }] } }, { jane: ["ops"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const role = parsed.value.roles["jane"]!;
    expect(rolePulls(role)).toEqual([{ repo: "acme/web", match: { title: "Update *", branch: "update-*", paths: ["projects/*/prod.yaml"] }, playbook: "sync-prs" }]);
    const watches = rolePullWatches(role, ["acme/web", "acme/other"], "deps-prs");
    expect(watches.map((w) => pullWatchId(w))).toEqual(["deps-prs@acme/web", "sync-prs@acme/web"]);
    expect(watches[0]!.match.author).toEqual([...DEPENDENCY_BOTS]);
  });

  it("merges a holder's roles' watches without duplicating an identical one", () => {
    const watch = { repo: "acme/web", match: { title: "Update *" }, playbook: "sync-prs" };
    const parsed = v2({ a: { pulls: [watch] }, b: { pulls: [watch, { repo: "acme/other", match: {}, playbook: "sync-prs" }] } }, { jane: ["a", "b"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(rolePulls(parsed.value.roles["jane"]!)).toHaveLength(2);
  });

  it("reports a watch on a repo outside repos.json or in github.exclude, a bad playbook, a bad glob, and two roles on one repo", () => {
    const parsed = v2(
      {
        a: { pulls: [{ repo: "acme/gone", match: {}, playbook: "sync-prs" }, { repo: "acme/web", match: { title: "x\\y" }, playbook: "linear-tickets" }] },
        b: { pulls: [{ repo: "acme/web", match: {}, playbook: "sync-prs" }] },
      },
      { jane: ["a"], sam: ["b"] },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const problems = pullWatchProblems(parsed.value, ["acme/web"], ["acme/web"], playbooks());
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/acme\/gone.*the repo is not in repos\.json/),
        expect.stringMatching(/acme\/web.*the repo is in github\.exclude/),
        expect.stringMatching(/the playbook "linear-tickets" is a ticket playbook, not a pr playbook/),
        expect.stringMatching(/match\.title is not a glob: .*backslash/),
        expect.stringMatching(/two roles with holders declare pull watches on acme\/web: jane, sam/),
      ]),
    );
  });

  it("warns when a declared match.author ends in [bot], which the plugin strips, and not for a bare or human login (BB-342)", () => {
    const withAuthor = (author: unknown) => {
      const parsed = v2({ a: { pulls: [{ repo: "acme/web", match: { author }, playbook: "sync-prs" }] } }, { jane: ["a"] });
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const bot = pullWatchProblems(withAuthor("app[bot]"), ["acme/web"], [], playbooks());
    expect(bot.some((p) => /match\.author "app\[bot\]" ends in \[bot\].*GraphQL login.*suffix is ignored/u.test(p))).toBe(true);
    // A pattern that is only a wildcard plus the suffix is kept as is, so it
    // matches no author; the check says that rather than "suffix ignored".
    const wildcard = pullWatchProblems(withAuthor("*[bot]"), ["acme/web"], [], playbooks());
    expect(wildcard.some((p) => /match\.author "\*\[bot\]" names only the \[bot\] suffix, so it matches no author/u.test(p))).toBe(true);
    // The array form is defended too (the parser accepts only a string today).
    const array = withAuthor("app");
    (array.roles["jane"]!.ops!.pulls[0]!.match as { author?: string | string[] }).author = ["app[bot]", "alice"];
    expect(pullWatchProblems(array, ["acme/web"], [], playbooks()).some((p) => /match\.author "app\[bot\]" ends in \[bot\]/u.test(p))).toBe(true);
    for (const author of ["app", "alice"]) {
      expect(pullWatchProblems(withAuthor(author), ["acme/web"], [], playbooks()).some((p) => /\[bot\]/u.test(p))).toBe(false);
    }
  });

  it("attributes a pull binding to the role that declared its watch", () => {
    const parsed = v2({ ops: { pulls: [{ repo: "acme/web", match: {}, playbook: "sync-prs" }] } }, { jane: ["ops"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(bindingRoles(parsed.value, "jane", []).get("sync-prs@acme/web")).toEqual(["ops"]);
  });
});

describe("project-level ticket watches (BB-246)", () => {
  const file = (tickets: unknown) => parseProjectFile(JSON.stringify({ version: 1, tickets }));
  const playbooks = () => {
    const tickets = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    const initiative = parsePlaybook(LINEAR_TICKETS.replace("name: linear-tickets", "name: initiative"), "initiative");
    const prs = parsePlaybook(GITHUB_PRS, "github-prs");
    if (!tickets.ok || !initiative.ok || !prs.ok) throw new Error("playbook parse failed");
    return new Map([
      ["linear-tickets", tickets.value],
      ["initiative", initiative.value],
      ["github-prs", prs.value],
    ]);
  };

  it("parses a tickets list, defaulting match, and refuses a bad shape", () => {
    const parsed = file([{ match: { labels: ["docs"], title: "Docs: *" }, playbook: "initiative" }, { playbook: "linear-tickets" }]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.tickets).toEqual([
      { match: { labels: ["docs"], title: "Docs: *" }, playbook: "initiative" },
      { match: {}, playbook: "linear-tickets" },
    ]);
    const empty = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.value.tickets).toEqual([]);
    expect(file([{ match: { labels: [] }, playbook: "initiative" }])).toMatchObject({ ok: false });
    expect(file([{ match: { labels: ["docs"] } }])).toMatchObject({ ok: false });
    expect(file([{ match: { bogus: true }, playbook: "initiative" }])).toMatchObject({ ok: false });
    // A near-miss key is still refused by the strict project file.
    expect(parseProjectFile(JSON.stringify({ version: 1, ticket: [] }))).toMatchObject({ ok: false });
  });

  it("reports a ticket watch naming a missing or non-ticket playbook, and a bad title glob", () => {
    const parsed = file([{ match: { title: "x\\y" }, playbook: "github-prs" }, { playbook: "gone" }]);
    if (!parsed.ok) throw new Error(parsed.error);
    const problems = ticketWatchProblems(parsed.value, playbooks());
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tickets\[0\].*"github-prs" is a pr playbook, not a ticket playbook/),
        expect.stringMatching(/tickets\[1\].*"gone" does not exist/),
        expect.stringMatching(/tickets\[0\].*match\.title is not a glob: .*backslash/),
      ]),
    );
  });

  it("reports a ticket watch playbook that did not parse from the loader's error, once", () => {
    const parsed = file([{ playbook: "initiative" }]);
    if (!parsed.ok) throw new Error(parsed.error);
    const problems = ticketWatchProblems(parsed.value, new Map(), new Map([["initiative", "stewards/playbooks/initiative.md: the front matter is not YAML"]]));
    expect(problems).toEqual([expect.stringMatching(/tickets\[0\].*"initiative".*not YAML/u)]);
  });

  it("names a ticket watch by its playbook", () => {
    const parsed = file([{ playbook: "initiative" }]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.tickets.map((w) => ticketWatchId(w))).toEqual(["initiative@ticket"]);
  });
});

// BB-328: a playbook copied from a shipped template carries a
// `template: <name>@<hash>` stamp. The parser tolerates it (with or without
// one, a playbook parses and runs exactly as before), and `check` turns a
// stamp into a lag warning rather than a problem.
describe("template stamps (BB-328)", () => {
  it("parses a playbook with or without a stamp the same way", () => {
    const hash = templateHash(LINEAR_TICKETS);
    const stamped = parsePlaybook(stampedTemplate("linear-tickets", LINEAR_TICKETS), "linear-tickets");
    const plain = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!stamped.ok) throw new Error(stamped.error);
    if (!plain.ok) throw new Error(plain.error);
    expect(stamped.value.template).toEqual({ name: "linear-tickets", hash });
    expect(plain.value.template).toBeNull();
    // Everything but the stamp (and the text hash it changes) is identical.
    expect({ ...stamped.value, template: null, version: plain.value.version }).toEqual(plain.value);
  });

  it("refuses a stamp that is not <name>@<hash>", () => {
    expect(parsePlaybook(LINEAR_TICKETS.replace("name: linear-tickets", "name: linear-tickets\ntemplate: not-a-stamp"), "linear-tickets")).toMatchObject({ ok: false });
  });

  it("writes a stamp whose hash is of the shipped template, unchanged by edits to the copy", () => {
    const stamped = stampedTemplate("ops-watch", OPS_WATCH);
    const hash = templateHash(OPS_WATCH);
    expect(stamped).toContain(`template: ops-watch@${hash}\n`);
    // The hash is of the shipped text, never the project copy: editing the
    // copy leaves the stamp's hash exactly where it was.
    const edited = stamped.replace("# You watch one production target", "# edited by the project");
    expect(parseTemplateStamp(/template: (\S+)/u.exec(edited)![1]!)).toEqual({ name: "ops-watch", hash });
  });

  it("warns on lag, unknown origin and a template that no longer exists, once per playbook", () => {
    const hashes = new Map([["ops-watch", "aaaa"]]);
    const p = (name: string, template: { name: string; hash: string } | null) => ({ name, template });
    expect(templateWarnings([p("ops-watch", { name: "ops-watch", hash: "bbbb" })], hashes)).toEqual(["ops-watch was copied from template bbbb; current is aaaa."]);
    expect(templateWarnings([p("ops-watch", null)], hashes)).toEqual(["ops-watch has no template stamp, so its origin is unknown"]);
    expect(templateWarnings([p("ops-watch", { name: "gone", hash: "aaaa" })], hashes)).toEqual(["ops-watch was copied from template gone, which no longer exists"]);
    expect(templateWarnings([p("ops-watch", null), p("ops-watch", null)], hashes)).toHaveLength(1);
  });

  it("has a current hash for every shipped template", () => {
    const hashes = templateHashes();
    expect([...hashes.keys()].sort()).toEqual(Object.keys(PLAYBOOK_TEMPLATES).sort());
    for (const [name, hash] of hashes) expect(parseTemplateStamp(`${name}@${hash}`)).toEqual({ name, hash });
  });
});

// BB-362: the project file and the shipped templates a no-Linear project
// reads must not assume Linear.
describe("no-Linear project content (BB-362)", () => {
  it("omits the default label from a project file with no Linear team, and keeps it when one is named", () => {
    expect(projectFileTemplate(["ENG"])).toContain('"label": "bb-managed"');
    expect(projectFileTemplate([])).not.toContain("bb-managed");
    // The parsed value still takes the default, so a label-based source works.
    const parsed = parseProjectFile(projectFileTemplate([]));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.label).toBe("bb-managed");
  });

  it("names no source-specific tool in a shipped playbook template", () => {
    for (const [name, text] of Object.entries(PLAYBOOK_TEMPLATES)) {
      expect(text, name).not.toMatch(/linear_[a-z_]+/u);
      expect(text, name).not.toMatch(/gh issue create/u);
    }
  });
});
