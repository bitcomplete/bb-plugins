// BB-355: a `.bb` playbook value the running image's parser cannot parse is a
// visible "unsupported until restart" problem, not a silent last-good copy.
// The parse failure names the file and the unrecognised key or value and says
// it takes effect after the server restarts onto a newer image; bindings keep
// running under the last good copy. Every other failure keeps its wording.
import { describe, expect, it } from "vitest";
import { playbookPath } from "./config.js";
import { ROLES_FILE } from "./roles.js";
import { DEPS_ALERTS, GITHUB_PRS, LINEAR_TICKETS } from "./templates.js";
import { setup } from "./test-world.js";

/** A playbook with one front-matter field the strict schema does not know. */
const unknownField = (text: string) => text.replace("---\n", "---\nbogus-field: hello\n");

/** A playbook whose deployment carries a strategy kind no branch knows. */
const unknownStrategy = (text: string) =>
  text.replace(
    /\n---\r?\n/u,
    [
      "",
      "deployment:",
      "  source: github",
      "  repo: acme/web",
      "  environment: production",
      "  carries:",
      "    - when: { repo: acme/web }",
      "      strategy: { kind: magic }",
      "---",
      "",
    ].join("\n"),
  );

/** A playbook whose declared stage carries a kind no branch knows. */
const unknownStageKind = (text: string) =>
  text.replace(
    "source: linear\n",
    ["source: linear", "stages:", "  spec:   { kind: start }", "  design: { kind: manual }", "  build:  { kind: active }", "  review: { kind: active }", ""].join("\n"),
  );

const unsupportedLines = (problems: string[]) => problems.filter((p) => p.includes("unsupported until restart"));

describe("an unsupported playbook value (BB-355)", () => {
  it("returns the last good playbook and names the unrecognised front-matter field", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.playbooks.ticket!.version;
    expect(await t.bb.storage.kv.get<string>("good/p1/playbook/linear-tickets")).toBe(LINEAR_TICKETS);

    t.files[playbookPath("linear-tickets")] = unknownField(LINEAR_TICKETS);
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    // The binding keeps running under the last good copy.
    expect(after!.playbooks.ticket!.version).toBe(version);
    const lines = unsupportedLines(after!.problems);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/stewards\/playbooks\/linear-tickets\.md/u);
    expect(lines[0]).toContain("bogus-field");
    expect(lines[0]).toMatch(/restarts onto a newer image/u);
    // The generic fallback wording is retired for the unrecognised case.
    expect(after!.problems.some((p) => p.includes("bindings keep running under the last good linear-tickets"))).toBe(false);
  });

  it("does the same for an unrecognised strategy value", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.playbooks.ticket!.version;

    t.files[playbookPath("linear-tickets")] = unknownStrategy(LINEAR_TICKETS);
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.playbooks.ticket!.version).toBe(version);
    const lines = unsupportedLines(after!.problems);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/stewards\/playbooks\/linear-tickets\.md/u);
    expect(lines[0]).toContain("magic");
    expect(lines[0]).toContain("deployment.carries[0].strategy.kind");
    expect(lines[0]).toMatch(/restarts onto a newer image/u);
  });

  it("does the same for an unrecognised stage kind (BB-417)", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.playbooks.ticket!.version;

    t.files[playbookPath("linear-tickets")] = unknownStageKind(LINEAR_TICKETS);
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    // The binding keeps running under the last good copy; the unknown kind is
    // named as unsupported until restart, never read as a typo or silently kept.
    expect(after!.playbooks.ticket!.version).toBe(version);
    const lines = unsupportedLines(after!.problems);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/stewards\/playbooks\/linear-tickets\.md/u);
    expect(lines[0]).toContain("stages.design.kind");
    expect(lines[0]).toContain("manual");
    expect(lines[0]).toMatch(/restarts onto a newer image/u);
  });

  it("keeps the whole parse error when an ordinary failure rides along", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    await t.hooks.loadConfig("p1", true);

    // The unknown field and the bad duration fail in the same parse: the owner
    // must still see the duration error, not only the unsupported line.
    const mixed = unknownField(LINEAR_TICKETS).replace("requeue-default: 2d", "requeue-default: nope");
    t.files[playbookPath("linear-tickets")] = mixed;
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.problems.some((p) => p.includes("unsupported until restart"))).toBe(false);
    expect(after!.problems.some((p) => p.includes("requeue-default"))).toBe(true);
    expect(after!.problems.some((p) => p.includes("bindings keep running under the last good linear-tickets"))).toBe(true);
  });

  it("leaves a playbook that parses unaffected and updates the last good copy", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.playbooks.ticket!.version;

    const edited = LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: 3d");
    t.files[playbookPath("linear-tickets")] = edited;
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.problems.some((p) => p.includes("unsupported until restart"))).toBe(false);
    expect(after!.problems.some((p) => p.includes("keep running under the last good"))).toBe(false);
    expect(after!.playbooks.ticket!.version).not.toBe(version);
    expect(await t.bb.storage.kv.get<string>("good/p1/playbook/linear-tickets")).toBe(edited);
  });

  it("keeps the current wording for a non-unrecognised parse failure", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.playbooks.ticket!.version;

    t.files[playbookPath("linear-tickets")] = LINEAR_TICKETS.replace("requeue-default: 2d", "requeue-default: nope");
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.problems.some((p) => p.includes("unsupported until restart"))).toBe(false);
    expect(after!.problems.some((p) => p.includes("bindings keep running under the last good linear-tickets"))).toBe(true);
    expect(after!.playbooks.ticket!.version).toBe(version);
  });

  it("gives loadOptional the same treatment", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    t.files[playbookPath("deps-alerts")] = DEPS_ALERTS;
    t.hooks.forgetConfigs();
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.depsAlerts!.version;

    t.files[playbookPath("deps-alerts")] = unknownField(DEPS_ALERTS);
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.depsAlerts!.version).toBe(version);
    const lines = unsupportedLines(after!.problems);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/stewards\/playbooks\/deps-alerts\.md/u);
    expect(lines[0]).toContain("bogus-field");
  });

  it("names a watch playbook's unsupported value too", async () => {
    const t = await setup({ timing: { debounceMs: 1, nightlyStaggerMs: 0, configTtlMs: 0 } });
    const sync = GITHUB_PRS.replace("name: github-prs", "name: sync-prs");
    t.files[ROLES_FILE] = JSON.stringify({ version: 2, roles: { ops: { pulls: [{ repo: "acme/web", match: {}, playbook: "sync-prs" }] } }, holders: { jane: ["ops"] } });
    t.files[playbookPath("sync-prs")] = sync;
    t.hooks.forgetConfigs();
    const before = await t.hooks.loadConfig("p1", true);
    const version = before!.watchPlaybooks.get("sync-prs")!.version;

    t.files[playbookPath("sync-prs")] = unknownField(sync);
    t.hooks.forgetConfigs();
    const after = await t.hooks.loadConfig("p1", true);

    expect(after!.watchPlaybooks.get("sync-prs")!.version).toBe(version);
    const lines = unsupportedLines(after!.problems);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/stewards\/playbooks\/sync-prs\.md/u);
    expect(lines[0]).toContain("bogus-field");
  });
});
