import { describe, expect, it } from "vitest";
import { defaultDecideList, parseProjectFile, type BigDecision } from "./config.js";
import { decideFor, decideForEntry, decideForPull, decideForRefusal, isSelfWidening, SELF_WIDENING_PATHS, touchesAny } from "./decisions.js";

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

  it("places a pull request by matching its files to a project entry (BB-51)", () => {
    // A file under a project entry's paths is the project steward's.
    expect(decideForPull(["bb-plugins/plugins/linear/store.ts"], decisions)).toBe("project");
    // A user entry, no matching entry, an empty or unreadable file list, and a
    // self-widening change are all the user's.
    expect(decideForPull(["bb-plugins/plugins/linear/source-contract.ts"], decisions)).toBe("user");
    expect(decideForPull(["bb-plugins/plugins/linear/wake.ts"], decisions)).toBe("user");
    expect(decideForPull([], decisions)).toBe("user");
    expect(decideForPull(null, decisions)).toBe("user");
    expect(decideForPull(["bb-plugins/plugins/stewards/store.ts"], decisions)).toBe("user");
    // An identity path no project entry names is already the user's, whether or
    // not a `user` entry lists it (BB-77).
    const identity: BigDecision[] = [
      { text: "Identity and access", decide: "user", paths: ["bb-gate/router/**"] },
      { text: "A cross-repo contract", decide: "project", paths: ["bb-gate/docs/hooks.md"] },
    ];
    expect(decideForPull(["bb-gate/router/routes.go"], identity)).toBe("user");
    expect(decideForPull(["bb-gate/docs/hooks.md"], identity)).toBe("project");
  });

  it("gives the failed files fetch its own refusal text, not the self-widening one (BB-51)", () => {
    expect(decideForRefusal(null, "A store migration", decisions)).toBe("the changed files could not be read");
    expect(decideForRefusal([], "A store migration", decisions)).toBe("the pull request changes no files");
    expect(decideForRefusal(["bb-plugins/plugins/stewards/store.ts"], "A store migration", decisions)).toBe("the change touches the decide list or the code that enforces it");
    expect(decideForRefusal(["bb-plugins/plugins/linear/store.ts"], "A store migration", decisions)).toBeNull();
    expect(decideForRefusal(["bb-plugins/plugins/linear/wake.ts"], "A store migration", decisions)).toMatch(/do not touch/u);
    // A file that touches no entry still gets the no-entry text; a file that
    // touches a user entry gets the user-entry text even with no entry named
    // (BB-125, the user entry is checked before the entry-named checks).
    expect(decideForRefusal(["bb-plugins/plugins/linear/foo.ts"], null, decisions)).toBe("no decide-list entry was given");
    expect(decideForRefusal(["bb-plugins/plugins/linear/source-contract.ts"], null, decisions)).toContain("A public API change other teams depend on");
  });
});

describe("a user entry wins over a project entry (BB-125)", () => {
  const overlap: BigDecision[] = [
    { text: "Identity and access", decide: "user", paths: ["bb-gate/hooks/**"] },
    { text: "A cross-repo contract", decide: "project", paths: ["bb-gate/docs/hooks.md"] },
  ];

  it("keeps a files-matching-only-a-project-entry pull request with the project steward", () => {
    expect(decideForPull(["bb-gate/docs/hooks.md"], overlap)).toBe("project");
    expect(decideFor(["bb-gate/docs/hooks.md"], "A cross-repo contract", overlap)).toBe("project");
    expect(decideForRefusal(["bb-gate/docs/hooks.md"], "A cross-repo contract", overlap)).toBeNull();
  });

  it("makes the pull request the user's when the files also touch a user entry's paths", () => {
    const files = ["bb-gate/hooks/slack.go", "bb-gate/docs/hooks.md"];
    expect(decideForPull(files, overlap)).toBe("user");
    // decideFor with the project entry named still yields the user's, because
    // the files touch the user entry's paths too.
    expect(decideFor(files, "A cross-repo contract", overlap)).toBe("user");
    expect(decideForRefusal(files, "A cross-repo contract", overlap)).toContain("Identity and access");
  });

  it("places bb-gate#50's file list as the user's", () => {
    const entries: BigDecision[] = [
      {
        text: "Identity and access changes (a credential, a token, cluster access, the bb-gate router, the verifier sidecar, devbox-gate auth, the bb-gate hooks adapter, or Tailscale admission)",
        decide: "user",
        paths: ["bb-gate/hooks/**"],
      },
      {
        text: "A cross-repo contract (source-contract.ts and its copies, hooks.md, the devbox connect API, clients.json, the devbox-provider defaults)",
        decide: "project",
        paths: ["bb-gate/docs/hooks.md"],
      },
    ];
    // GitHub returns repo-relative filenames; the entries are workspace-relative.
    const files = ["hooks/slack.go", "hooks/server.go", "docs/hooks.md"];
    expect(decideForPull(files, entries)).toBe("user");
    expect(decideForRefusal(files, entries[1].text, entries)).toContain("Identity and access changes");
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
