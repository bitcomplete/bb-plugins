import { describe, expect, it } from "vitest";
import { parseProjectFile } from "./config.js";
import { decideFor, decideForEntry, decideForPull, decideForRefusal, defaultDecideList, explainDecision, formatDecisionListing, isSelfWidening, SELF_WIDENING_PATHS, touchesAny, type BigDecision } from "./decisions.js";

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
    // The gate's own files stay the user's; a non-gate stewards file is placed by the decide list (BB-153).
    expect(decideForPull(["bb-plugins/plugins/stewards/gate.ts"], decisions)).toBe("user");
    expect(decideForPull(["bb-plugins/plugins/stewards/store.ts"], decisions)).toBe("project");
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
    expect(decideForRefusal(null, "A store migration", decisions)).toMatch(/^the changed files could not be read/u);
    expect(decideForRefusal([], "A store migration", decisions)).toMatch(/^the pull request changes no files/u);
    expect(decideForRefusal(["bb-plugins/plugins/stewards/gate.ts"], "A store migration", decisions)).toMatch(/^the change touches the decide list or the code that enforces it/u);
    expect(decideForRefusal(["bb-plugins/plugins/linear/store.ts"], "A store migration", decisions)).toBeNull();
    expect(decideForRefusal(["bb-plugins/plugins/linear/wake.ts"], "A store migration", decisions)).toMatch(/do not touch/u);
    // Every refusal carries the decide-list listing (BB-135).
    expect(decideForRefusal(["bb-plugins/plugins/linear/wake.ts"], "A store migration", decisions)).toContain("Rule: a `user` entry wins");
    // A file that touches no entry still gets the no-entry text; a file that
    // touches a user entry gets the user-entry text even with no entry named
    // (BB-125, the user entry is checked before the entry-named checks).
    expect(decideForRefusal(["bb-plugins/plugins/linear/foo.ts"], null, decisions)).toMatch(/^no decide-list entry was given/u);
    expect(decideForRefusal(["bb-plugins/plugins/linear/source-contract.ts"], null, decisions)).toContain("A public API change other teams depend on");
  });
});

describe("explainDecision names the entries that matched and the one that decides (BB-135)", () => {
  const overlap: BigDecision[] = [
    { text: "Identity and access", decide: "user", paths: ["bb-gate/hooks/**"] },
    { text: "A cross-repo contract", decide: "project", paths: ["bb-gate/docs/hooks.md"] },
  ];

  it("lists every matched entry with its mark and files, and the deciding entry", () => {
    const files = ["bb-gate/hooks/slack.go", "bb-gate/docs/hooks.md"];
    const e = explainDecision(files, overlap);
    expect(e.matched).toEqual([
      { text: "Identity and access", decide: "user", files: ["bb-gate/hooks/slack.go"] },
      { text: "A cross-repo contract", decide: "project", files: ["bb-gate/docs/hooks.md"] },
    ]);
    expect(e.winner).toEqual({ text: "Identity and access", decide: "user", files: ["bb-gate/hooks/slack.go"] });
    expect(e.mark).toBe("user");
    expect(e.selfWidening).toBe(false);
    expect(e.unreadable).toBe(false);
    expect(e.rule).toBe("a `user` entry wins; self-widening is always the user's; no match is the user's");
    const listing = formatDecisionListing(e);
    expect(listing).toContain('"Identity and access" [user] — bb-gate/hooks/slack.go');
    expect(listing).toContain('"A cross-repo contract" [project] — bb-gate/docs/hooks.md');
    expect(listing).toContain('Deciding entry: "Identity and access" [user].');
    expect(listing).toContain("Rule: a `user` entry wins; self-widening is always the user's; no match is the user's");
  });

  it("names the project entry when only it matched", () => {
    const e = explainDecision(["bb-gate/docs/hooks.md"], overlap);
    expect(e.matched.map((m) => m.text)).toEqual(["A cross-repo contract"]);
    expect(e.winner?.text).toBe("A cross-repo contract");
    expect(e.mark).toBe("project");
    expect(formatDecisionListing(e)).toContain('Deciding entry: "A cross-repo contract" [project].');
  });

  it("reports no match as the user's", () => {
    const e = explainDecision(["bb-gate/README.md"], overlap);
    expect(e.matched).toEqual([]);
    expect(e.winner).toBeNull();
    expect(e.mark).toBe("user");
    const listing = formatDecisionListing(e);
    expect(listing).toContain("Decide list: no entry's paths matched the changed files.");
    expect(listing).toContain("Deciding entry: none (the user's).");
  });

  it("reports self-widening as the user's, with no deciding entry, and names the tripped files (BB-153)", () => {
    const e = explainDecision(["bb-plugins/plugins/stewards/decisions.ts", "bb-gate/docs/hooks.md"], overlap);
    expect(e.selfWidening).toBe(true);
    expect(e.selfWideningFiles).toEqual(["bb-plugins/plugins/stewards/decisions.ts"]);
    expect(e.winner).toBeNull();
    expect(e.mark).toBe("user");
    const listing = formatDecisionListing(e);
    expect(listing).toContain("Deciding entry: none — self-widening is always the user's.");
    expect(listing).toContain("Self-widening: bb-plugins/plugins/stewards/decisions.ts");
    expect(listing).toContain('"A cross-repo contract" [project]');
  });

  it("names every tripped file, repo-relative as GitHub reports them (BB-153)", () => {
    const e = explainDecision(["plugins/stewards/gate.ts", "plugins/stewards/approvals.ts", "plugins/stewards/server.ts"], overlap);
    expect(e.selfWideningFiles).toEqual(["plugins/stewards/gate.ts", "plugins/stewards/approvals.ts"]);
    expect(formatDecisionListing(e)).toContain("Self-widening: plugins/stewards/gate.ts, plugins/stewards/approvals.ts");
    // A non-widening change carries no such line.
    expect(formatDecisionListing(explainDecision(["plugins/stewards/server.ts"], overlap))).not.toContain("Self-widening:");
  });

  it("reports an unreadable or empty file list as the user's, and matches nothing", () => {
    for (const files of [null, undefined, [] as string[]]) {
      const e = explainDecision(files, overlap);
      expect(e.unreadable).toBe(true);
      expect(e.matched).toEqual([]);
      expect(e.mark).toBe("user");
      expect(e.reason).toMatch(/could not be read|changes no files/u);
    }
    // The listing keeps the two failed reads apart (BB-135 review round 1).
    expect(formatDecisionListing(explainDecision(null, overlap))).toContain("the changed files could not be read, so no entry was matched");
    expect(formatDecisionListing(explainDecision([], overlap))).toContain("the pull request changes no files, so no entry was matched");
  });
});

describe("nothing the old decide-list code left to the user moves to the project steward (BB-135)", () => {
  // The pre-BB-125 code, kept here as the frozen behaviour the listing must not
  // regress: a matching `project` entry won outright, with no user-entry check.
  const oldDecideForPull = (files: readonly string[] | null | undefined, list: readonly BigDecision[]): "user" | "project" => {
    if (files === null || files === undefined || files.length === 0) return "user";
    if (isSelfWidening(files)) return "user";
    const match = list.find((d) => d.decide === "project" && d.paths.length > 0 && touchesAny(files, d.paths));
    return match === undefined ? "user" : "project";
  };
  const oldDecideFor = (files: readonly string[] | null | undefined, entry: string | null, list: readonly BigDecision[]): "user" | "project" => {
    if (files === null || files === undefined || files.length === 0) return "user";
    if (isSelfWidening(files)) return "user";
    const wanted = (entry ?? "").trim();
    const found = list.find((d) => d.text.toLowerCase() === wanted.toLowerCase());
    if (found === undefined) return "user";
    if (found.paths.length > 0 && !touchesAny(files, found.paths)) return "user";
    return found.decide === "project" ? "project" : "user";
  };

  const cases: Array<{ name: string; files: string[] | null; entry: string | null }> = [
    { name: "the changed files could not be read", files: null, entry: "A store migration" },
    { name: "the pull request changes no files", files: [], entry: "A store migration" },
    { name: "the change is self-widening", files: ["bb-plugins/plugins/stewards/gate.ts"], entry: "A cross-repo contract other repos implement" },
    { name: "only a user entry's paths matched", files: ["bb-plugins/plugins/linear/source-contract.ts"], entry: "A store migration" },
    { name: "no entry's paths matched", files: ["bb-plugins/plugins/linear/wake.ts"], entry: "A store migration" },
    { name: "the named entry is not marked project", files: ["bb-plugins/plugins/linear/wake.ts"], entry: "An unmarked entry" },
  ];

  it.each(cases)("$name stays the user's", ({ files, entry }) => {
    expect(oldDecideForPull(files, decisions)).toBe("user");
    expect(decideForPull(files, decisions)).toBe("user");
    expect(oldDecideFor(files, entry, decisions)).toBe("user");
    expect(decideFor(files, entry, decisions)).toBe("user");
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
    expect(isSelfWidening(["plugins/stewards/gate.ts", "plugins/stewards/approvals.ts"])).toBe(true);
    expect(decideFor(["plugins/stewards/decisions.ts"], "A store migration", decisions)).toBe("user");
    // The files that used to widen the gate no longer do (BB-153).
    expect(isSelfWidening(["plugins/stewards/config.ts"])).toBe(false);
    expect(isSelfWidening(["plugins/stewards/server.ts", "plugins/stewards/store.ts"])).toBe(false);
    expect(isSelfWidening(["plugins/stewards/reconcile.ts"])).toBe(false);
  });

  it("names exactly the gate's own files, so widening it back is a visible diff (BB-153)", () => {
    expect([...SELF_WIDENING_PATHS]).toEqual([
      ".bb/stewards/project.json",
      "bb-plugins/plugins/stewards/decisions.ts",
      "bb-plugins/plugins/stewards/gate.ts",
      "bb-plugins/plugins/stewards/approvals.ts",
      "bb-plugins/plugins/stewards/approvals-store.ts",
    ]);
  });

  it("places a stewards pull request that does not touch the gate by the decide list (BB-153)", () => {
    const list: BigDecision[] = [
      { text: "A store migration", decide: "project", paths: ["bb-plugins/plugins/*/store.ts"] },
      { text: "A cross-repo contract other repos implement", decide: "project", paths: ["bb-plugins/plugins/*/source-contract.ts"] },
    ];
    // The gate's own files stay the user's, whatever entry matches.
    for (const path of ["bb-plugins/plugins/stewards/gate.ts", "bb-plugins/plugins/stewards/approvals.ts", "bb-plugins/plugins/stewards/approvals-store.ts", "bb-plugins/plugins/stewards/decisions.ts"]) {
      expect(decideForPull([path], list)).toBe("user");
    }
    expect(decideForPull([".bb/stewards/project.json"], list)).toBe("user");
    // A migration in the stewards' own store.ts now wins its `project` entry.
    expect(decideForPull(["bb-plugins/plugins/stewards/store.ts"], list)).toBe("project");
    // Non-gate stewards code is placed by the decide list: no match is the user's.
    expect(decideForPull(["bb-plugins/plugins/stewards/server.ts", "bb-plugins/plugins/stewards/reconcile.ts", "bb-plugins/plugins/stewards/config.ts"], list)).toBe("user");
  });

  it("fails closed when the changed files could not be read", () => {
    expect(decideFor(null, "A store migration", decisions)).toBe("user");
    expect(decideFor([], "A store migration", decisions)).toBe("user");
  });

  it("requires the changed files to touch the named entry's paths", () => {
    // The store-migration entry names store.ts; a migration in another plugin matches.
    expect(decideFor(["bb-plugins/plugins/linear/store.ts"], "A store migration", decisions)).toBe("project");
    // The stewards' own store.ts is not self-widening, so the migration entry wins (BB-153).
    expect(decideFor(["bb-plugins/plugins/stewards/store.ts"], "A store migration", decisions)).toBe("project");
    // A file that matches no entry path is the user's.
    expect(decideFor(["bb-plugins/plugins/linear/wake.ts"], "A store migration", decisions)).toBe("user");
  });

  it("matches a glob across path segments", () => {
    expect(touchesAny(["bb-plugins/plugins/linear/store.ts"], ["bb-plugins/plugins/*/store.ts"])).toBe(true);
    expect(touchesAny(["bb-plugins/plugins/linear/server.ts"], ["bb-plugins/plugins/*/store.ts"])).toBe(false);
    expect(touchesAny(["bb-gate/docker/bb-server/Dockerfile"], ["bb-gate/docker/bb-server/**"])).toBe(true);
  });
});
