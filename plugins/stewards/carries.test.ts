import { describe, expect, it } from "vitest";
import type { DeploymentTarget } from "./config.js";
import { CARRIES_FILES_PAGE_LIMIT, evaluateCarries, imageTagFromManifest, liveAtMergeMatches, liveAtMergeVerdict, matchCarriesRule, pinFromDockerfile, type CarriesReader } from "./carries.js";
import type { WorkflowRunInfo } from "./source-contract.js";

const MERGE = "mergecommit0";
const REF = "gatehead0";

const target = (over: Partial<DeploymentTarget> = {}): DeploymentTarget => ({
  source: "github",
  repo: "acme/web",
  environment: "production",
  carries: [],
  timeout: 3_600_000,
  workflows: [],
  ...over,
});

const bbPluginsRule = {
  when: { repo: "acme/app" },
  strategy: {
    kind: "image-tag" as const,
    manifest: "deploy/kustomization.yaml",
    image: "app",
    workflow: "build.yaml",
    job: "build_and_push_image",
    consumer: { dockerfile: "docker/app/Dockerfile", pinArg: "PLUGIN_REF", repo: "acme/app" },
  },
};

const manifest = (tag: string): string => `resources:\n  - router.yaml\nimages:\n  - name: app\n    newTag: "${tag}"\n  - name: web\n    newTag: "9"\n`;
const dockerfile = (pin: string): string => `FROM node\nARG PLUGIN_REF=${pin}\nARG BB_REPO=x\n`;

const run = (over: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo => ({
  id: 1,
  runNumber: 123,
  headSha: REF,
  startedAt: "2026-10-30T18:00:00Z",
  jobs: [{ name: "build_and_push_image", startedAt: "2026-10-30T18:05:00Z", conclusion: "success" }],
  ...over,
});

/** A reader whose every read is overridable; the defaults answer "nothing there". */
const reader = (over: Partial<CarriesReader> = {}): CarriesReader => ({
  fileAtRef: async () => ({ content: null, error: null }),
  latestCommit: async () => ({ sha: null, error: null }),
  workflowRun: async () => ({ run: null, error: null }),
  compare: async () => ({ status: null, error: null }),
  ...over,
});

const context = (over: Partial<Parameters<typeof evaluateCarries>[1]> = {}) => ({ merge: MERGE, prRepo: "acme/app", files: ["plugins/stewards/deploy.ts"], ref: REF, ...over });

describe("matching a carries rule", () => {
  const rules = [
    { when: { repo: "acme/web", paths: ["docker/app/**"] }, strategy: { kind: "image-tag" as const, manifest: "m", image: "i", workflow: "w", job: "j" } },
    { when: { repo: "acme/web" }, strategy: { kind: "ref-contains-merge" as const } },
  ];

  it("is first-match-wins, by repo and changed paths", () => {
    expect(matchCarriesRule(rules, "acme/web", ["docker/app/Dockerfile"])).toBe(rules[0]);
    expect(matchCarriesRule(rules, "acme/web", ["deploy/kustomization.yaml"])).toBe(rules[1]);
    expect(matchCarriesRule(rules, "acme/app", ["x"])).toBeNull();
    expect(matchCarriesRule(rules, "acme/web", [])).toBe(rules[1]);
  });

  // BB-260: carries paths are matched directly. `touchesAny` would strip the
  // leading segment of a rule like `deploy/**`, turning it into `**`, so a
  // single-segment rule matched every file and swallowed the rules after it.
  it("does not let a single-segment rule swallow another rule's files", () => {
    const deploy = { when: { repo: "acme/web", paths: ["deploy/**"] }, strategy: { kind: "ref-contains-merge" as const } };
    const router = { when: { repo: "acme/web" }, strategy: { kind: "image-tag" as const, manifest: "m", image: "web", workflow: "image.yaml" } };
    expect(matchCarriesRule([deploy, router], "acme/web", ["cmd/router/main.go"])).toBe(router);
    expect(matchCarriesRule([deploy, router], "acme/web", ["deploy/kustomization.yaml"])).toBe(deploy);
  });

  // BB-260: a live-at-merge rule matches only when every changed file is
  // under its paths, so a mixed merge falls through to the rule that owns the
  // other path. The other kinds keep any-file matching.
  describe("a live-at-merge rule", () => {
    const live = { when: { repo: "acme/web", paths: [".bb/**", "docs/**", "**.md"] }, strategy: { kind: "live-at-merge" as const } };
    const deploy = { when: { repo: "acme/web", paths: ["deploy/**", "backend.json"] }, strategy: { kind: "ref-contains-merge" as const } };
    const router = { when: { repo: "acme/web" }, strategy: { kind: "image-tag" as const, manifest: "m", image: "web", workflow: "image.yaml" } };

    it("matches every changed file under its paths, including '**.md'", () => {
      const rules = [live, router];
      expect(matchCarriesRule(rules, "acme/web", [".bb/stewards/project.json"])).toBe(live);
      expect(matchCarriesRule(rules, "acme/web", ["docs/design.md"])).toBe(live);
      expect(matchCarriesRule(rules, "acme/web", ["README.md"])).toBe(live);
      expect(liveAtMergeMatches(live, "acme/web", ["docs/a.md"])).toBe(true);
    });

    // BB-292: the web#106 file list (a `.bb`-only guidance change) matches
    // the live-at-merge rule and gives a deployed verdict with no deployment
    // read.
    it("pins web#106: a .bb/AGENTS.md plus playbook merge is live at merge", () => {
      const rules = [deploy, live, router];
      const files = [".bb/AGENTS.md", ".bb/stewards/playbooks/linear-tickets.md"];
      expect(matchCarriesRule(rules, "acme/web", files)).toBe(live);
      expect(liveAtMergeMatches(live, "acme/web", files)).toBe(true);
      expect(liveAtMergeVerdict(live)).toEqual({ kind: "deployed", note: "live-at-merge: nothing deploys .bb/**, docs/**, **.md" });
    });

    it("falls through to an earlier rule on a mixed merge", () => {
      // The deploy rule is first and matches any of its files.
      expect(matchCarriesRule([deploy, live], "acme/web", ["deploy/kustomization.yaml", ".bb/stewards/project.json"])).toBe(deploy);
      // With the live rule first, the mixed merge does not match it and falls
      // through to the deploy rule.
      expect(matchCarriesRule([live, deploy], "acme/web", ["deploy/kustomization.yaml", ".bb/stewards/project.json"])).toBe(deploy);
    });

    it("reaches the catch-all image-tag rule for .bb plus router code", () => {
      expect(matchCarriesRule([deploy, live, router], "acme/web", [".bb/stewards/project.json", "cmd/router/main.go"])).toBe(router);
      expect(matchCarriesRule([deploy, live, router], "acme/web", ["internal/gate/server.go"])).toBe(router);
    });

    it("never matches an empty or unreadable file list", () => {
      expect(matchCarriesRule([live], "acme/web", [])).toBeNull();
      expect(liveAtMergeMatches(live, "acme/web", [])).toBe(false);
    });

    // BB-260: the source reads at most GitHub's first 100 changed paths, so a
    // list that long may hide a file outside the paths and must not match.
    it("never matches at GitHub's changed-files page limit", () => {
      const atLimit = Array.from({ length: CARRIES_FILES_PAGE_LIMIT }, (_, i) => `docs/${i}.md`);
      expect(liveAtMergeMatches(live, "acme/web", atLimit)).toBe(false);
      expect(liveAtMergeMatches(live, "acme/web", atLimit.slice(0, CARRIES_FILES_PAGE_LIMIT - 1))).toBe(true);
    });

    it("gives a deployed verdict without any deployment read, and null for other kinds", () => {
      expect(liveAtMergeVerdict(live)).toEqual({ kind: "deployed", note: "live-at-merge: nothing deploys .bb/**, docs/**, **.md" });
      expect(liveAtMergeVerdict(deploy)).toBeNull();
    });
  });
});

describe("reading the manifest and pin", () => {
  it("takes the image's newTag, string or number, and no other image's", () => {
    expect(imageTagFromManifest(manifest("123"), "app")).toBe("123");
    expect(imageTagFromManifest("images:\n  - name: app\n    newTag: 456\n", "app")).toBe("456");
    expect(imageTagFromManifest(manifest("123"), "web")).toBe("9");
    expect(imageTagFromManifest(manifest("123"), "other")).toBeNull();
    expect(imageTagFromManifest("not: [valid", "app")).toBeNull();
  });

  it("takes the value of the named ARG", () => {
    expect(pinFromDockerfile(dockerfile("abc123"), "PLUGIN_REF")).toBe("abc123");
    expect(pinFromDockerfile(dockerfile("abc123"), "BB_REF")).toBeNull();
  });
});

describe("the carries strategies", () => {
  it("bb-plugins via the image pin: carried when the pin contains the merge", async () => {
    const pin = "pincommit1";
    const reads: string[] = [];
    const verdict = await evaluateCarries(
      target({ carries: [bbPluginsRule] }),
      context(),
      reader({
        fileAtRef: async (_repo, path, ref) => {
          reads.push(`${path}@${ref}`);
          if (path === bbPluginsRule.strategy.manifest) return { content: manifest("123"), error: null };
          if (path === bbPluginsRule.strategy.consumer.dockerfile) return { content: dockerfile(pin), error: null };
          return { content: null, error: null };
        },
        workflowRun: async () => ({ run: run(), error: null }),
        latestCommit: async (repo, branch, path, until) => {
          reads.push(`latest ${repo} ${branch} ${path} ${until}`);
          return { sha: "asofcommit", error: null };
        },
        compare: async (repo, base, head) => {
          reads.push(`compare ${repo} ${base} ${head}`);
          return { status: "ahead", error: null };
        },
      }),
    );
    expect(verdict).toMatchObject({ kind: "deployed" });
    expect(verdict?.note).toMatch(/run 123 pinned PLUGIN_REF=pincomm/u);
    // The pin is read from the Dockerfile at the as-of commit, and compared
    // in the consumer repo, not against the run's head.
    expect(reads).toContain(`latest acme/web HEAD docker/app/Dockerfile 2026-10-30T18:05:00Z`);
    expect(reads).toContain("compare acme/app mergecommit0 pincommit1");
    expect(reads.some((r) => r.startsWith("compare") && r.includes("gatehead0"))).toBe(false);
  });

  it("web under docker/app: carried when the default branch at the build job's start contains the merge", async () => {
    const strategy = { kind: "image-tag" as const, manifest: "deploy/kustomization.yaml", image: "app", workflow: "build.yaml", job: "build_and_push_image" };
    const reads: string[] = [];
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "acme/web", paths: ["docker/app/**"] }, strategy }] }),
      context({ prRepo: "acme/web", files: ["docker/app/Dockerfile"] }),
      reader({
        fileAtRef: async () => ({ content: manifest("123"), error: null }),
        workflowRun: async () => ({ run: run(), error: null }),
        latestCommit: async (repo, branch, path, until) => {
          reads.push(`${repo} ${branch} ${JSON.stringify(path)} ${until}`);
          return { sha: "gatebuild0", error: null };
        },
        compare: async (repo, base, head) => {
          reads.push(`compare ${repo} ${base} ${head}`);
          return { status: "ahead", error: null };
        },
      }),
    );
    expect(verdict).toMatchObject({ kind: "deployed" });
    expect(reads).toContain('acme/web HEAD "" 2026-10-30T18:05:00Z');
    expect(reads).toContain("compare acme/web mergecommit0 gatebuild0");
  });

  it("web router image: carried when the run's head contains the merge", async () => {
    const strategy = { kind: "image-tag" as const, manifest: "deploy/kustomization.yaml", image: "web", workflow: "image.yaml" };
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "acme/web" }, strategy }] }),
      context({ prRepo: "acme/web" }),
      reader({
        fileAtRef: async () => ({ content: "images:\n  - name: web\n    newTag: \"55\"\n", error: null }),
        workflowRun: async () => ({ run: run({ runNumber: 55 }), error: null }),
        compare: async (repo, base, head) => (repo === "acme/web" && base === MERGE && head === REF ? { status: "identical", error: null } : { status: null, error: "wrong compare" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "deployed" });
    expect(verdict?.note).toMatch(/head gatehea/u);
  });

  // BB-260: a live-at-merge rule needs no image read, but a deployment can
  // only settle a watch whose merge is already on the default branch, so the
  // evaluate path compares the ref. A stacked merge is not on main and stays
  // not-yet until the BB-215 override re-points the watch.
  it("a live-at-merge rule settles a deployment only when the ref contains the merge", async () => {
    const rule = { when: { repo: "acme/web", paths: [".bb/**", "docs/**", "**.md"] }, strategy: { kind: "live-at-merge" as const } };
    const calls: string[] = [];
    const verdict = await evaluateCarries(
      target({ carries: [rule] }),
      context({ prRepo: "acme/web", files: [".bb/stewards/project.json"] }),
      reader({
        compare: async (_repo, base, head) => {
          calls.push(`compare ${base} ${head}`);
          return { status: "identical", error: null };
        },
        fileAtRef: async () => { calls.push("fileAtRef"); return { content: null, error: null }; },
      }),
    );
    expect(verdict).toEqual({ kind: "deployed", note: "live-at-merge: nothing deploys .bb/**, docs/**, **.md" });
    // Only the ref compare runs: no manifest, run or file read.
    expect(calls).toEqual([`compare ${MERGE} ${REF}`]);

    const behind = await evaluateCarries(
      target({ carries: [rule] }),
      context({ prRepo: "acme/web", files: [".bb/stewards/project.json"] }),
      reader({ compare: async () => ({ status: "behind", error: null }) }),
    );
    expect(behind).toMatchObject({ kind: "not-yet", note: expect.stringMatching(/live-at-merge: gatehead0 does not contain merge/u) });
  });

  it("a mixed PR follows an earlier deploy rule rather than live-at-merge", async () => {
    const calls: string[] = [];
    const verdict = await evaluateCarries(
      target({
        carries: [
          { when: { repo: "acme/web", paths: ["deploy/**", "backend.json"] }, strategy: { kind: "ref-contains-merge" } },
          { when: { repo: "acme/web", paths: [".bb/**", "docs/**", "**.md"] }, strategy: { kind: "live-at-merge" } },
        ],
      }),
      context({ prRepo: "acme/web", files: ["deploy/kustomization.yaml", ".bb/stewards/project.json"] }),
      reader({ compare: async () => { calls.push("compare"); return { status: "identical", error: null }; } }),
    );
    expect(verdict).toMatchObject({ kind: "deployed", note: expect.stringMatching(/ref-contains-merge/u) });
    expect(calls).toEqual(["compare"]);
  });

  it("web no image: carried when the deployment ref contains the merge", async () => {
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "acme/web" }, strategy: { kind: "ref-contains-merge" } }] }),
      context({ prRepo: "acme/web" }),
      reader({ compare: async () => ({ status: "identical", error: null }) }),
    );
    expect(verdict).toMatchObject({ kind: "deployed" });
    expect(verdict?.note).toMatch(/ref-contains-merge: gatehead0 contains merge mergeco/u);
  });

  it("returns null for a free-text carries, so the steward still decides", async () => {
    expect(await evaluateCarries(target({ carries: "the pin contains the merge" }), context(), reader())).toBeNull();
  });

  it("first matching rule wins", async () => {
    const calls: string[] = [];
    const verdict = await evaluateCarries(
      target({
        carries: [
          { when: { repo: "acme/web" }, strategy: { kind: "ref-contains-merge" } },
          { when: { repo: "acme/web" }, strategy: { kind: "image-tag", manifest: "m", image: "i", workflow: "w", job: "j" } },
        ],
      }),
      context({ prRepo: "acme/web" }),
      reader({
        compare: async () => {
          calls.push("compare");
          return { status: "behind", error: null };
        },
        fileAtRef: async () => {
          calls.push("fileAtRef");
          return { content: null, error: null };
        },
      }),
    );
    expect(verdict).toMatchObject({ kind: "not-yet" });
    expect(verdict?.note).toMatch(/ref-contains-merge/);
    expect(calls).toEqual(["compare"]);
  });

  it("wakes the steward (undecided) on no matching rule and on a failed read", async () => {
    const noMatch = await evaluateCarries(target({ carries: [bbPluginsRule] }), context({ prRepo: "acme/web", files: ["deploy/x"] }), reader());
    expect(noMatch).toMatchObject({ kind: "undecided" });
    expect(noMatch?.note).toMatch(/No carries rule matches acme\/web/u);

    const failed = await evaluateCarries(
      target({ carries: [{ when: { repo: "acme/app" }, strategy: { kind: "ref-contains-merge" } }] }),
      context(),
      reader({ compare: async () => ({ status: null, error: "HTTP 500" }) }),
    );
    expect(failed).toMatchObject({ kind: "undecided" });
    expect(failed?.note).toMatch(/HTTP 500/u);
  });

  it("is not-yet for a missing run, a job with no start, and an unknown merge", async () => {
    const base = target({ carries: [bbPluginsRule] });
    const noRun = await evaluateCarries(base, context(), reader({ fileAtRef: async () => ({ content: manifest("123"), error: null }), workflowRun: async () => ({ run: null, error: null }) }));
    expect(noRun).toMatchObject({ kind: "not-yet" });
    expect(noRun?.note).toMatch(/no build.yaml run numbered 123/u);

    const noJobStart = await evaluateCarries(
      base,
      context(),
      reader({
        fileAtRef: async () => ({ content: manifest("123"), error: null }),
        workflowRun: async () => ({ run: run({ jobs: [{ name: "build_and_push_image", startedAt: null, conclusion: null }] }), error: null }),
      }),
    );
    expect(noJobStart).toMatchObject({ kind: "not-yet" });
    expect(noJobStart?.note).toMatch(/no started build_and_push_image job/u);

    const noMerge = await evaluateCarries(base, context({ merge: null }), reader());
    expect(noMerge).toMatchObject({ kind: "not-yet" });
  });

  // The 2026-10-25 incident: a hooks-only deployment whose ref contains the
  // pin commit, but whose app image was built from an older pin.
  it("is not-yet when the deployment ref contains the pin but the image was built from an older pin", async () => {
    const oldPin = "oldpin000";
    const verdict = await evaluateCarries(
      target({ carries: [bbPluginsRule] }),
      context(),
      reader({
        fileAtRef: async (_repo, path) => (path === bbPluginsRule.strategy.manifest ? { content: manifest("77"), error: null } : { content: dockerfile(oldPin), error: null }),
        workflowRun: async () => ({ run: run({ runNumber: 77, headSha: "newref00" }), error: null }),
        latestCommit: async () => ({ sha: "oldbuild0", error: null }),
        compare: async (repo, base, head) => (repo === "acme/app" && head === oldPin ? { status: "behind", error: null } : { status: "ahead", error: null }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "not-yet" });
    expect(verdict?.note).toMatch(/does not contain merge mergeco \(behind\)/u);
  });
});
