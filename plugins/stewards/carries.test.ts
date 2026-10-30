import { describe, expect, it } from "vitest";
import type { DeploymentTarget } from "./config.js";
import { evaluateCarries, imageTagFromManifest, matchCarriesRule, pinFromDockerfile, type CarriesReader } from "./carries.js";
import type { WorkflowRunInfo } from "./source-contract.js";

const MERGE = "mergecommit0";
const REF = "gatehead0";

const target = (over: Partial<DeploymentTarget> = {}): DeploymentTarget => ({
  source: "github",
  repo: "bitcomplete/bb-gate",
  environment: "production",
  carries: [],
  timeout: 3_600_000,
  workflows: [],
  ...over,
});

const bbPluginsRule = {
  when: { repo: "bitcomplete/bb-plugins" },
  strategy: {
    kind: "image-tag" as const,
    manifest: "kploy/production/kustomization.yaml",
    image: "bb-server",
    workflow: "bb-server.yaml",
    job: "build_and_push_image",
    consumer: { dockerfile: "docker/bb-server/Dockerfile", pinArg: "BB_PLUGINS_REF", repo: "bitcomplete/bb-plugins" },
  },
};

const manifest = (tag: string): string => `resources:\n  - router.yaml\nimages:\n  - name: bb-server\n    newTag: "${tag}"\n  - name: bb-gate\n    newTag: "9"\n`;
const dockerfile = (pin: string): string => `FROM node\nARG BB_PLUGINS_REF=${pin}\nARG BB_REPO=x\n`;

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

const context = (over: Partial<Parameters<typeof evaluateCarries>[1]> = {}) => ({ merge: MERGE, prRepo: "bitcomplete/bb-plugins", files: ["plugins/stewards/deploy.ts"], ref: REF, ...over });

describe("matching a carries rule", () => {
  const rules = [
    { when: { repo: "bitcomplete/bb-gate", paths: ["docker/bb-server/**"] }, strategy: { kind: "image-tag" as const, manifest: "m", image: "i", workflow: "w", job: "j" } },
    { when: { repo: "bitcomplete/bb-gate" }, strategy: { kind: "ref-contains-merge" as const } },
  ];

  it("is first-match-wins, by repo and changed paths", () => {
    expect(matchCarriesRule(rules, "bitcomplete/bb-gate", ["docker/bb-server/Dockerfile"])).toBe(rules[0]);
    expect(matchCarriesRule(rules, "bitcomplete/bb-gate", ["kploy/production/kustomization.yaml"])).toBe(rules[1]);
    expect(matchCarriesRule(rules, "bitcomplete/bb-plugins", ["x"])).toBeNull();
    expect(matchCarriesRule(rules, "BitComplete/BB-Gate", [])).toBe(rules[1]);
  });
});

describe("reading the manifest and pin", () => {
  it("takes the image's newTag, string or number, and no other image's", () => {
    expect(imageTagFromManifest(manifest("123"), "bb-server")).toBe("123");
    expect(imageTagFromManifest("images:\n  - name: bb-server\n    newTag: 456\n", "bb-server")).toBe("456");
    expect(imageTagFromManifest(manifest("123"), "bb-gate")).toBe("9");
    expect(imageTagFromManifest(manifest("123"), "other")).toBeNull();
    expect(imageTagFromManifest("not: [valid", "bb-server")).toBeNull();
  });

  it("takes the value of the named ARG", () => {
    expect(pinFromDockerfile(dockerfile("abc123"), "BB_PLUGINS_REF")).toBe("abc123");
    expect(pinFromDockerfile(dockerfile("abc123"), "BB_REF")).toBeNull();
  });
});

describe("the carries strategies", () => {
  it("bb-plugins via the bb-server pin: carried when the pin contains the merge", async () => {
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
    expect(verdict?.note).toMatch(/run 123 pinned BB_PLUGINS_REF=pincomm/u);
    // The pin is read from the Dockerfile at the as-of commit, and compared
    // in the consumer repo, not against the run's head.
    expect(reads).toContain(`latest bitcomplete/bb-gate HEAD docker/bb-server/Dockerfile 2026-10-30T18:05:00Z`);
    expect(reads).toContain("compare bitcomplete/bb-plugins mergecommit0 pincommit1");
    expect(reads.some((r) => r.startsWith("compare") && r.includes("gatehead0"))).toBe(false);
  });

  it("bb-gate under docker/bb-server: carried when the default branch at the build job's start contains the merge", async () => {
    const strategy = { kind: "image-tag" as const, manifest: "kploy/production/kustomization.yaml", image: "bb-server", workflow: "bb-server.yaml", job: "build_and_push_image" };
    const reads: string[] = [];
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "bitcomplete/bb-gate", paths: ["docker/bb-server/**"] }, strategy }] }),
      context({ prRepo: "bitcomplete/bb-gate", files: ["docker/bb-server/Dockerfile"] }),
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
    expect(reads).toContain('bitcomplete/bb-gate HEAD "" 2026-10-30T18:05:00Z');
    expect(reads).toContain("compare bitcomplete/bb-gate mergecommit0 gatebuild0");
  });

  it("bb-gate router image: carried when the run's head contains the merge", async () => {
    const strategy = { kind: "image-tag" as const, manifest: "kploy/production/kustomization.yaml", image: "bb-gate", workflow: "image.yaml" };
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "bitcomplete/bb-gate" }, strategy }] }),
      context({ prRepo: "bitcomplete/bb-gate" }),
      reader({
        fileAtRef: async () => ({ content: "images:\n  - name: bb-gate\n    newTag: \"55\"\n", error: null }),
        workflowRun: async () => ({ run: run({ runNumber: 55 }), error: null }),
        compare: async (repo, base, head) => (repo === "bitcomplete/bb-gate" && base === MERGE && head === REF ? { status: "identical", error: null } : { status: null, error: "wrong compare" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "deployed" });
    expect(verdict?.note).toMatch(/head gatehea/u);
  });

  it("bb-gate no image: carried when the deployment ref contains the merge", async () => {
    const verdict = await evaluateCarries(
      target({ carries: [{ when: { repo: "bitcomplete/bb-gate" }, strategy: { kind: "ref-contains-merge" } }] }),
      context({ prRepo: "bitcomplete/bb-gate" }),
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
          { when: { repo: "bitcomplete/bb-gate" }, strategy: { kind: "ref-contains-merge" } },
          { when: { repo: "bitcomplete/bb-gate" }, strategy: { kind: "image-tag", manifest: "m", image: "i", workflow: "w", job: "j" } },
        ],
      }),
      context({ prRepo: "bitcomplete/bb-gate" }),
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
    const noMatch = await evaluateCarries(target({ carries: [bbPluginsRule] }), context({ prRepo: "bitcomplete/bb-gate", files: ["kploy/x"] }), reader());
    expect(noMatch).toMatchObject({ kind: "undecided" });
    expect(noMatch?.note).toMatch(/No carries rule matches bitcomplete\/bb-gate/u);

    const failed = await evaluateCarries(
      target({ carries: [{ when: { repo: "bitcomplete/bb-plugins" }, strategy: { kind: "ref-contains-merge" } }] }),
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
    expect(noRun?.note).toMatch(/no bb-server.yaml run numbered 123/u);

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
  // pin commit, but whose bb-server image was built from an older pin.
  it("is not-yet when the deployment ref contains the pin but the image was built from an older pin", async () => {
    const oldPin = "oldpin000";
    const verdict = await evaluateCarries(
      target({ carries: [bbPluginsRule] }),
      context(),
      reader({
        fileAtRef: async (_repo, path) => (path === bbPluginsRule.strategy.manifest ? { content: manifest("77"), error: null } : { content: dockerfile(oldPin), error: null }),
        workflowRun: async () => ({ run: run({ runNumber: 77, headSha: "newref00" }), error: null }),
        latestCommit: async () => ({ sha: "oldbuild0", error: null }),
        compare: async (repo, base, head) => (repo === "bitcomplete/bb-plugins" && head === oldPin ? { status: "behind", error: null } : { status: "ahead", error: null }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "not-yet" });
    expect(verdict?.note).toMatch(/does not contain merge mergeco \(behind\)/u);
  });
});
