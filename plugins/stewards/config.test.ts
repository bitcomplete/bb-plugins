import { describe, expect, it } from "vitest";
import { isTerminal, opsTeam, usesKind, modelSpecSchema, parsePlaybook, parseProjectFile, phaseInstructions, phaseOf, playbookStates } from "./config.js";
import { GITHUB_PRS, GITHUB_REVIEWS, LINEAR_TICKETS, OPS_WATCH, projectFileTemplate } from "./templates.js";

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
  it("has no phases or terminal states, sections for what a look found, and a may list that only reads, files, comments and escalates", () => {
    const parsed = parsePlaybook(OPS_WATCH, "ops-watch");
    if (!parsed.ok) throw new Error(parsed.error);
    const p = parsed.value;
    expect(p).toMatchObject({ kind: "ops", source: "k8s", phases: {}, terminal: [], ready: null, may: ["read", "file-ticket", "comment", "escalate"], requeueDefaultMs: 3_600_000 });
    expect(phaseInstructions(p, "new")).toMatch(/File one ticket per problem/u);
    expect(phaseInstructions(p, "recurring")).toMatch(/File nothing new/u);
    expect(phaseInstructions(p, "returned")).toMatch(/reopened/u);
    expect(p.general).toMatch(/Fingerprint: `<fingerprint>`/u);
  });

  it("refuses entity state on an ops playbook, the wrong source, and a non-ops playbook with nothing terminal", () => {
    const phased = OPS_WATCH.replace("may:", "phases:\n  open: {}\nmay:");
    expect(parsePlaybook(phased, "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/an ops playbook has no phases/u) });
    expect(parsePlaybook(OPS_WATCH.replace("may:", "terminal: [Done]\nmay:"), "ops-watch")).toMatchObject({ ok: false });
    expect(parsePlaybook(OPS_WATCH.replace("source: k8s", "source: linear"), "ops-watch")).toMatchObject({ ok: false, error: expect.stringMatching(/an ops playbook reads k8s/u) });
    expect(parsePlaybook(GITHUB_PRS.replace("terminal: [merged, closed]\n", ""), "github-prs")).toMatchObject({ ok: false, error: expect.stringMatching(/terminal: name at least one state/u) });
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
