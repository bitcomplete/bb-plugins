import { describe, expect, it } from "vitest";
import {
  bindingRoles,
  DEPENDENCY_BOTS,
  depsTargets,
  filingTargetProblems,
  githubStateLabels,
  isTerminal,
  k8sTargets,
  legacyOpsPresent,
  legacyRole,
  modelSpecSchema,
  opsTeam,
  parsePlaybook,
  parseProjectFile,
  parseRolesFile,
  phaseInstructions,
  phaseOf,
  playbookNameFor,
  playbookStates,
  projectStewardProblem,
  pullWatchId,
  pullWatchProblems,
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
  sentryTargets,
  usesKind,
  watchProblems,
} from "./config.js";
import { DEPS_ALERTS, DEPS_PRS, GITHUB_ISSUES, GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, projectFileTemplate } from "./templates.js";

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
  it("parses mergeDispatch, defaulting to none, and refuses a bad entry (BB-216)", () => {
    const defaults = parseProjectFile(JSON.stringify({ version: 1 }));
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.mergeDispatch).toEqual([]);
    const configured = parseProjectFile(JSON.stringify({ version: 1, mergeDispatch: [{ repo: "bitcomplete/bb-plugins", workflow: "bb-server.yaml", workflowRepo: "bitcomplete/bb-gate", ref: "main", inputs: { only_if_moved: "true" } }] }));
    if (!configured.ok) throw new Error(configured.error);
    expect(configured.value.mergeDispatch).toEqual([{ repo: "bitcomplete/bb-plugins", workflow: "bb-server.yaml", workflowRepo: "bitcomplete/bb-gate", ref: "main", inputs: { only_if_moved: "true" } }]);
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
    const r = file({ targets: [{ kind: "k8s-namespace", name: "bb-gate-production" }, { kind: "k8s-namespace", name: "devbox-production" }], team: "ops", autoAdopt: ["urgent"] });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.ops).toEqual({ targets: [{ kind: "k8s-namespace", name: "bb-gate-production" }, { kind: "k8s-namespace", name: "devbox-production" }], team: "OPS", autoAdopt: ["urgent"], sentry: { resolveOnDone: false } });
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
    expect(error({ targets: [{ kind: "k8s-namespace", name: "prod" }] }, [])).toMatch(/ops needs a Linear team/u);
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
    const shorter = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nfollow-through: 90m"), "linear-tickets");
    expect(shorter.ok && shorter.value.followThroughMs).toBe(90 * 60_000);
    const idleGrace = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nidle-grace: 5m"), "linear-tickets");
    expect(idleGrace.ok && idleGrace.value.idleGraceMs).toBe(5 * 60_000);
    expect(p.ready?.approval).toBe("project");
    expect(playbookStates(p)).toEqual(expect.arrayContaining(["Todo", "In Review", "Done", "Canceled"]));
    expect(p.version).toMatch(/^[0-9a-f]{12}$/u);
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
        `requeue-default: 2d\ndeployment:\n  source: github\n  repo: bitcomplete/bb-gate\n  environment: production\n  carries: "the pin contains the merge"\n  timeout: 6h${extra}`,
      );
    const none = parsePlaybook(withDeployment(""), "linear-tickets");
    if (!none.ok) throw new Error(none.error);
    expect(none.value.deployments[0]).toMatchObject({ repo: "bitcomplete/bb-gate", environment: "production", workflows: [] });
    const named = parsePlaybook(withDeployment("\n  workflows: [bb-server.yaml, image.yaml]"), "linear-tickets");
    if (!named.ok) throw new Error(named.error);
    expect(named.value.deployments[0]?.workflows).toEqual(["bb-server.yaml", "image.yaml"]);
  });

  it("takes a list of deployment targets with structured carries rules (BB-132)", () => {
    const structured = LINEAR_TICKETS.replace(
      "requeue-default: 2d",
      [
        "requeue-default: 2d",
        "deployment:",
        "  - name: bb-gate",
        "    source: github",
        "    repo: bitcomplete/bb-gate",
        "    environment: production",
        "    carries:",
        "      - when: { repo: bitcomplete/bb-plugins }",
        "        strategy:",
        "          kind: image-tag",
        "          manifest: kploy/production/kustomization.yaml",
        "          image: bb-server",
        "          workflow: bb-server.yaml",
        "          job: build_and_push_image",
        "          consumer: { dockerfile: docker/bb-server/Dockerfile, pinArg: BB_PLUGINS_REF, repo: bitcomplete/bb-plugins }",
        "      - when: { repo: bitcomplete/bb-gate, paths: [docker/bb-server/**] }",
        "        strategy: { kind: ref-contains-merge }",
        "  - name: devbox",
        "    source: github",
        "    repo: bitcomplete/devbox",
        "    environment: production",
        "    carries: [{ when: { repo: bitcomplete/devbox }, strategy: { kind: ref-contains-merge } }]",
      ].join("\n"),
    );
    const parsed = parsePlaybook(structured, "linear-tickets");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.deployments.map((d) => d.name)).toEqual(["bb-gate", "devbox"]);
    expect(parsed.value.deployments[0]!.carries).toHaveLength(2);
    const rules = parsed.value.deployments[0]!.carries as Array<{ strategy: { kind: string } }>;
    expect(rules[0]!.strategy.kind).toBe("image-tag");
    expect(rules[1]!.strategy.kind).toBe("ref-contains-merge");
    // A single free-text target still parses, exactly as before.
    const singleText = LINEAR_TICKETS.replace("requeue-default: 2d", 'requeue-default: 2d\ndeployment:\n  source: github\n  repo: bitcomplete/bb-gate\n  environment: production\n  carries: "the pin contains the merge"\n  timeout: 6h');
    const single = parsePlaybook(singleText, "linear-tickets");
    if (!single.ok) throw new Error(single.error);
    expect(single.value.deployments).toHaveLength(1);
    expect(single.value.deployments[0]!.carries).toBe("the pin contains the merge");
    // An unknown strategy is refused, and so is an empty rule list.
    expect(parsePlaybook(structured.replace("kind: ref-contains-merge", "kind: magic"), "linear-tickets")).toMatchObject({ ok: false });
    expect(parsePlaybook(structured.replace("carries: [{ when: { repo: bitcomplete/devbox }, strategy: { kind: ref-contains-merge } }]", "carries: []"), "linear-tickets")).toMatchObject({ ok: false });
    // Two targets cannot share a name: their watches would share a key.
    const duplicate = parsePlaybook(structured.replace("name: devbox", "name: bb-gate"), "linear-tickets");
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate.ok) expect(duplicate.error).toMatch(/bb-gate is listed twice/u);
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
    const emptyWorkflow = LINEAR_TICKETS.replace("requeue-default: 2d", 'requeue-default: 2d\ndeployment:\n  source: github\n  repo: bitcomplete/bb-gate\n  environment: production\n  carries: "x"\n  workflows: [""]');
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
    expect(parsePlaybook(OPS_WATCH.replace("source: k8s", "source: linear"), "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/an ops playbook watches k8s, sentry or github/u) });
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
    // No sub-issue handling: create-sub-issue is not in `may`, and there is no promote rule.
    expect(parsed.value.may).not.toContain("create-sub-issue");
    expect(parsed.value.promote).toBeNull();
    expect(phaseInstructions(parsed.value, "status:in-review")).toMatch(/gh issue\s+close/u);
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
    const parsed = roles({ "Jane-Doe": { projectSteward: true, ops: { k8sNamespaces: ["prod"], team: "eng", sentry: { projects: [{ org: " Acme ", project: "Web-API" }] }, dependabot: ["acme/web"] } }, Bob: {} });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.roles)).toEqual(["jane-doe", "bob"]);
    const role = parsed.value.roles["jane-doe"]!;
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ k8sNamespaces: ["prod"], team: "ENG", autoAdopt: [], sentry: { projects: [{ org: "acme", project: "web-api" }], resolveOnDone: false }, dependabot: ["acme/web"] });
    expect(parsed.value.roles["bob"]).toEqual({ projectSteward: false, ops: undefined });
    // The role getters read the entry, not the legacy project.ops.
    expect(roleK8sTargets(role)).toEqual([{ kind: "k8s-namespace", name: "prod" }]);
    expect(roleSentryTargets(role)).toEqual([{ kind: "sentry-project", org: "acme", project: "web-api" }]);
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

    const legacy = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "sentry-project", org: "acme", project: "web" }], team: "eng", context: "bc-prod", autoAdopt: ["urgent"], sentry: { resolveOnDone: true } } }));
    if (!legacy.ok) throw new Error(legacy.error);
    expect(legacyOpsPresent(legacy.value)).toBe(true);
    const role = legacyRole(legacy.value);
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ team: "ENG", context: "bc-prod", autoAdopt: ["urgent"], sentry: { projects: [{ org: "acme", project: "web" }], resolveOnDone: true }, dependabot: "all" });
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
  const v2 = (definitions: Record<string, unknown>, holders: Record<string, string[]>) => parseRolesFile(JSON.stringify({ version: 2, roles: definitions, holders }));
  const project = () => {
    const parsed = parseProjectFile(JSON.stringify({ version: 1, linear: { teams: ["ENG"] }, ops: { targets: [{ kind: "k8s-namespace", name: "web-production" }] } }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("parses named roles and holders, merges a holder's roles, and keeps the built-in projectSteward", () => {
    const parsed = v2(
      {
        ops: { k8sNamespaces: ["bb-gate-production"], team: "eng", sentry: { projects: [{ org: " Acme ", project: "Web-API" }] }, dependabot: "all" },
        deps: { dependabot: ["acme/web"], autoAdopt: ["urgent"] },
      },
      { "Jane-Doe": ["ops", "deps", "projectSteward"], Bob: ["ops"] },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.roles)).toEqual(["jane-doe", "bob"]);
    expect(parsed.value.holders["jane-doe"]).toEqual(["ops", "deps", "projectSteward"]);
    const role = parsed.value.roles["jane-doe"]!;
    expect(role.projectSteward).toBe(true);
    expect(role.ops).toMatchObject({ k8sNamespaces: ["bb-gate-production"], team: "ENG", autoAdopt: ["urgent"], sentry: { projects: [{ org: "acme", project: "web-api" }], resolveOnDone: false }, dependabot: "all" });
    // bob holds only ops: no projectSteward, and the same watches jane's ops role gives.
    expect(parsed.value.roles["bob"]!.projectSteward).toBe(false);
    expect(roleOpsTargets(parsed.value.roles["bob"]!)).toEqual(roleOpsTargets(role));
    expect(roleDepsTargets(parsed.value.roles["bob"]!, ["acme/web", "acme/other"])).toEqual(roleDepsTargets(role, ["acme/web", "acme/other"]));
  });

  it("gives the same bindings, target keys and check result as the equivalent version 1 file", () => {
    const entry = { k8sNamespaces: ["prod"], context: "bc-prod", team: "ENG", sentry: { projects: [{ org: "acme", project: "web" }] }, dependabot: ["acme/web"] };
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
    const parsed = v2({ a: { context: "bc-prod", team: "ENG" }, b: { context: "other", team: "OPS" } }, { alice: ["a", "b"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const problems = roleProblems(parsed.value);
    expect(problems).toContain("alice holds roles with conflicting context (bc-prod, other): a holder's roles must agree on one context");
    expect(problems).toContain("alice holds roles with conflicting team (ENG, OPS): a holder's roles must agree on one team");
    expect(parsed.value.roles["alice"]!.ops).toMatchObject({ context: "bc-prod", team: "ENG" });
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
    const parsed = v2({ ops: { dependabot: ["acme/web"], pulls: [{ repo: "acme/web", match: { title: "Update *", branch: "update-*", paths: ["projects/*/bc-prod.yaml"] }, playbook: "sync-prs" }] } }, { jane: ["ops"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const role = parsed.value.roles["jane"]!;
    expect(rolePulls(role)).toEqual([{ repo: "acme/web", match: { title: "Update *", branch: "update-*", paths: ["projects/*/bc-prod.yaml"] }, playbook: "sync-prs" }]);
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

  it("attributes a pull binding to the role that declared its watch", () => {
    const parsed = v2({ ops: { pulls: [{ repo: "acme/web", match: {}, playbook: "sync-prs" }] } }, { jane: ["ops"] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(bindingRoles(parsed.value, "jane", []).get("sync-prs@acme/web")).toEqual(["ops"]);
  });
});
