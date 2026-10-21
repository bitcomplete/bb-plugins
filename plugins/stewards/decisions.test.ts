import { describe, expect, it } from "vitest";
import { defaultDecideList, parseProjectFile, type BigDecision } from "./config.js";
import { decideFor, decideForEntry, isSelfWidening, SELF_WIDENING_PATHS, touchesAny } from "./decisions.js";

const decisions: BigDecision[] = [
  { text: "Changing what a ticket's requester asked for", decide: "user", paths: [] },
  { text: "A public API change other teams depend on", decide: "user", paths: ["bb-plugins/plugins/*/source-contract.ts"] },
  { text: "A cross-repo contract other repos implement", decide: "project", paths: ["bb-gate/docs/hooks.md"] },
  { text: "A store migration", decide: "project", paths: ["bb-plugins/plugins/*/store.ts"] },
  { text: "An unmarked entry", decide: undefined as unknown as "user", paths: ["bb-plugins/plugins/linear/**"] },
  { text: "An unknown mark", decide: "maybe" as unknown as "user", paths: ["bb-plugins/plugins/github-watcher/**"] },
];

describe("the decide list fails closed", () => {
  it("marks every default big decision user", () => {
    for (const entry of defaultDecideList().filter((d) => d.text === "Granting a new credential, token or cluster access, or widening what an existing one can reach")) {
      expect(entry.decide).toBe("user");
    }
    expect(defaultDecideList().filter((d) => d.decide === "project").length).toBeGreaterThan(0);
  });

  it("treats a bare string entry as the user's, and an unknown mark as the user's", () => {
    const parsed = parseProjectFile(
      JSON.stringify({ version: 1, bigDecisions: ["A bare string", { text: "An unknown mark", decide: "perhaps" }, { text: "A project one", decide: "project" }] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.bigDecisions.map((d) => [d.text, d.decide])).toEqual([
      ["A bare string", "user"],
      ["An unknown mark", "user"],
      ["A project one", "project"],
    ]);
  });

  it("returns user for no entry, an unknown entry, an unmarked entry or an unknown mark", () => {
    expect(decideForEntry(null, decisions)).toBe("user");
    expect(decideForEntry("", decisions)).toBe("user");
    expect(decideForEntry("Not an entry at all", decisions)).toBe("user");
    expect(decideForEntry("An unmarked entry", decisions)).toBe("user");
    expect(decideForEntry("An unknown mark", decisions)).toBe("user");
    expect(decideForEntry("A cross-repo contract other repos implement", decisions)).toBe("project");
  });

  it("matches an entry case-insensitively", () => {
    expect(decideForEntry("a STORE migration", decisions)).toBe("project");
  });

  it("treats a pull request the project steward cannot classify as the user's", () => {
    expect(decideFor([], null, decisions)).toBe("user");
    expect(decideFor(["bb-plugins/plugins/linear/foo.ts"], null, decisions)).toBe("user");
  });
});

describe("no self-widening", () => {
  it("forces user for the decide list and the code that enforces it, whatever the entry says", () => {
    for (const path of SELF_WIDENING_PATHS) {
      expect(isSelfWidening([path])).toBe(true);
      expect(decideFor([path], "A cross-repo contract other repos implement", decisions)).toBe("user");
    }
    expect(decideFor([".bb/stewards/project.json"], "A store migration", decisions)).toBe("user");
  });

  it("does not fire for a change that touches none of them", () => {
    expect(isSelfWidening(["bb-plugins/plugins/linear/foo.ts"])).toBe(false);
    expect(decideFor(["bb-gate/docs/hooks.md"], "A cross-repo contract other repos implement", decisions)).toBe("project");
  });

  it("fires for a repo-relative filename as GitHub returns it (BB-30 review)", () => {
    // github.files returns repo-relative paths, the decide list is workspace-relative.
    expect(isSelfWidening(["plugins/stewards/server.ts", "plugins/stewards/store.ts"])).toBe(true);
    expect(decideFor(["plugins/stewards/decisions.ts"], "A store migration", decisions)).toBe("user");
    expect(isSelfWidening(["plugins/stewards/config.ts"])).toBe(true);
  });

  it("fails closed when the changed files could not be read", () => {
    expect(decideFor(null, "A store migration", decisions)).toBe("user");
    expect(decideFor([], "A store migration", decisions)).toBe("user");
  });

  it("requires the changed files to touch the named entry's paths", () => {
    // The store-migration entry names store.ts; a migration in another plugin matches.
    expect(decideFor(["bb-plugins/plugins/linear/store.ts"], "A store migration", decisions)).toBe("project");
    // The stewards' own store.ts is self-widening, so it is the user's whatever the entry says.
    expect(decideFor(["bb-plugins/plugins/stewards/store.ts"], "A store migration", decisions)).toBe("user");
    // A file that matches no entry path is the user's.
    expect(decideFor(["bb-plugins/plugins/linear/wake.ts"], "A store migration", decisions)).toBe("user");
  });

  it("matches a glob across path segments", () => {
    expect(touchesAny(["bb-plugins/plugins/linear/store.ts"], ["bb-plugins/plugins/*/store.ts"])).toBe(true);
    expect(touchesAny(["bb-plugins/plugins/linear/server.ts"], ["bb-plugins/plugins/*/store.ts"])).toBe(false);
    expect(touchesAny(["bb-gate/docker/bb-server/Dockerfile"], ["bb-gate/docker/bb-server/**"])).toBe(true);
  });
});
