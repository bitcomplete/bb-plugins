import { describe, expect, it } from "vitest";
import { depsTargets, isTerminal, k8sTargets, opsTeam, usesKind, modelSpecSchema, parsePlaybook, parseProjectFile, phaseInstructions, phaseOf, playbookStates } from "./config.js";
import { DEPS_ALERTS, DEPS_PRS, GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, projectFileTemplate } from "./templates.js";

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
    expect(parsed.value.ops).toEqual({ targets: [], autoAdopt: [] });
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
    expect(r.value.ops).toEqual({ targets: [{ kind: "k8s-namespace", name: "bb-gate-production" }, { kind: "k8s-namespace", name: "devbox-production" }], team: "OPS", autoAdopt: ["urgent"] });
    expect(usesKind(r.value, "ops")).toBe(true);
    expect(opsTeam(r.value)).toBe("OPS");
  });

  it("files in the first Linear team when no team is named", () => {
    const r = file({ targets: [{ kind: "k8s-namespace", name: "prod" }] });
    expect(r.ok && opsTeam(r.value)).toBe("ENG");
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
});

describe("playbooks", () => {
  it("parses the four defaults", () => {
    for (const [name, text] of [["linear-tickets", LINEAR_TICKETS], ["github-prs", GITHUB_PRS], ["github-reviews", GITHUB_REVIEWS], ["ops-watch", OPS_WATCH]] as const) {
      const parsed = parsePlaybook(text, name);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    }
  });

  it("tells the default playbooks to get credentials through bb secret request and to escalate build-time blockers", () => {
    const linear = parsePlaybook(LINEAR_TICKETS, "linear-tickets");
    if (!linear.ok) throw new Error(linear.error);
    expect(phaseInstructions(linear.value, "In Progress")).toMatch(/bb secret request/u);
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

  it("tells the PR playbooks that an approval survives small follow-ups and when a human must approve", () => {
    const prs = parsePlaybook(GITHUB_PRS, "github-prs");
    if (!prs.ok) throw new Error(prs.error);
    expect(phaseInstructions(prs.value, "open")).toMatch(/small follow-up push after an approval/u);
    expect(phaseInstructions(prs.value, "open")).toMatch(/needs the owner's approval/u);
    const reviews = parsePlaybook(GITHUB_REVIEWS, "github-reviews");
    if (!reviews.ok) throw new Error(reviews.error);
    expect(reviews.value.general).toMatch(/short check of the new commits/u);
    expect(reviews.value.general).toMatch(/then a human approves/u);
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
    const shorter = parsePlaybook(LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 2d\nfollow-through: 90m"), "linear-tickets");
    expect(shorter.ok && shorter.value.followThroughMs).toBe(90 * 60_000);
    expect(p.ready?.approval).toBe("project");
    expect(playbookStates(p)).toEqual(expect.arrayContaining(["Todo", "In Review", "Done", "Canceled"]));
    expect(p.version).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("refuses what would misbehave", () => {
    expect(parsePlaybook("no front matter", "x")).toMatchObject({ ok: false });
    expect(parsePlaybook(LINEAR_TICKETS, "other-name")).toMatchObject({ ok: false });
    const wrongSource = LINEAR_TICKETS.replace("source: linear", "source: github");
    expect(parsePlaybook(wrongSource, "linear-tickets")).toMatchObject({ ok: false });
    const noGate = LINEAR_TICKETS.replace(/ready:[\s\S]*?approval: project\n/u, "");
    const r = parsePlaybook(noGate, "linear-tickets");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs a ready gate/u);
    const overlap = GITHUB_PRS.replace("terminal: [merged, closed]", "terminal: [merged, closed, open]");
    expect(parsePlaybook(overlap, "github-prs")).toMatchObject({ ok: false });
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
    expect(parsePlaybook(OPS_WATCH.replace("source: k8s", "source: linear"), "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/an ops playbook watches k8s or github/u) });
    expect(parsePlaybook(GITHUB_PRS.replace("terminal: [merged, closed]\n", ""), "github-prs")).toMatchObject({ ok: false, error: expect.stringMatching(/terminal: name at least one state/u) });
    // A ticket, pr or review playbook still needs its phases, as before ops.
    const noPhases = GITHUB_PRS.replace(/phases:\n(?: {2}.*\n)+/u, "");
    expect(noPhases).not.toMatch(/phases:/u);
    expect(parsePlaybook(noPhases, "github-prs")).toMatchObject({ ok: false, error: expect.stringMatching(/phases: map the entity's states to stages/u) });
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
    expect(prs.value.general).toMatch(/patch or minor bump whose checks are green is escalated for a\s+human merge/u);
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
