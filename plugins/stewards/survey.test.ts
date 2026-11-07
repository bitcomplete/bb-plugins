import { describe, expect, it } from "vitest";
import { buildSurvey, deriveRepo, formatSurvey, surveyWantedPaths, workflowRunCommands, type SurveyRepoInput } from "./survey.js";

const tree = (...paths: string[]) => paths.map((path) => ({ path, type: "blob" }));

const repo = (over: Partial<SurveyRepoInput> = {}): SurveyRepoInput => ({
  dir: "web",
  url: "https://github.com/acme/web",
  repo: "acme/web",
  defaultBranch: "main",
  branchProtection: { available: true, value: { protected: false, requiredApprovingReviewCount: null, requiresStatusChecks: null } },
  labels: { available: true, value: ["bb-managed", "bug"] },
  tree: tree("package.json", "tsconfig.json", "src/index.ts", ".github/workflows/ci.yaml", "Dockerfile", "kploy/deployment.yaml", "bc-prod.yaml", "README.md"),
  treeError: null,
  contents: new Map(),
  otherRepos: [],
  ...over,
});

describe("the onboarding survey's per-repo derivation", () => {
  it("reports the default branch, branch protection and labels", () => {
    const derived = deriveRepo(
      repo({
        branchProtection: { available: true, value: { protected: true, requiredApprovingReviewCount: 2, requiresStatusChecks: true } },
      }),
    );
    expect(derived.defaultBranch).toBe("main");
    expect(derived.branchProtection).toEqual({ available: true, value: { protected: true, requiredApprovingReviewCount: 2, requiresStatusChecks: true } });
    expect(derived.labels).toEqual({ available: true, value: ["bb-managed", "bug"] });
  });

  it("reports an unprotected branch as a fact and a failed read as unavailable", () => {
    const unprotected = deriveRepo(repo());
    expect(unprotected.branchProtection).toEqual({ available: true, value: { protected: false, requiredApprovingReviewCount: null, requiresStatusChecks: null } });
    const failed = deriveRepo(repo({ branchProtection: { available: false, error: "gh is not signed in" }, labels: { available: false, error: "gh is not signed in" } }));
    expect(failed.branchProtection).toEqual({ available: false, error: "gh is not signed in" });
    expect(failed.labels).toEqual({ available: false, error: "gh is not signed in" });
  });

  it("derives languages, manifests, Dockerfiles and deploy manifests from the tree", () => {
    const derived = deriveRepo(repo({ tree: tree("go.mod", "cmd/main.go", "Dockerfile", "docker/web.Dockerfile", "kploy/prod.yaml", "bc-prod.yaml", "docker-compose.yml") }));
    expect(derived.languages).toEqual(["Go"]);
    expect(derived.manifests).toEqual(["go.mod"]);
    expect(derived.dockerfiles).toEqual(["Dockerfile", "docker/web.Dockerfile"]);
    expect(derived.deployManifests).toEqual(["bc-prod.yaml", "docker-compose.yml", "kploy/prod.yaml"]);
  });

  it("distinguishes TypeScript from JavaScript and lists every language", () => {
    const ts = deriveRepo(repo({ tree: tree("package.json", "tsconfig.json", "src/index.ts") }));
    expect(ts.languages).toEqual(["TypeScript"]);
    const js = deriveRepo(repo({ tree: tree("package.json", "src/index.js"), contents: new Map([["package.json", "{}"]]) }));
    expect(js.languages).toEqual(["JavaScript"]);
    const many = deriveRepo(repo({ tree: tree("Cargo.toml", "main.rs", "scripts/run.sh", "infra/main.tf") }));
    expect(many.languages).toEqual(["HCL", "Rust", "Shell"]);
  });

  it("reads the test and typecheck commands out of the CI workflows", () => {
    const workflow = ["name: CI", "on: [push]", "jobs:", "  build:", "    steps:", "      - uses: actions/checkout@v4", "      - run: npm ci", "      - run: npm run typecheck", "      - run: npm test", "      - run: |", "          go test ./...", "          go vet ./..."].join("\n");
    const derived = deriveRepo(repo({ tree: tree(".github/workflows/ci.yaml", ".github/workflows/release.yml"), contents: new Map([[".github/workflows/ci.yaml", workflow]]) }));
    expect(derived.typecheckCommands).toEqual(["npm run typecheck", "go vet ./..."]);
    expect(derived.testCommands).toEqual(["npm test", "go test ./..."]);
  });

  it("finds cross-repo references by name and URL, and never itself", () => {
    const derived = deriveRepo(
      repo({
        tree: tree("README.md", "package.json"),
        contents: new Map([
          ["README.md", "Depends on acme/api and https://github.com/acme/other."],
          ["package.json", "{}"],
        ]),
        otherRepos: [
          { repo: "acme/api", url: "https://github.com/acme/api" },
          { repo: "acme/other", url: "https://github.com/acme/other.git" },
          { repo: "acme/unrelated", url: "https://github.com/acme/unrelated" },
        ],
      }),
    );
    expect(derived.references).toEqual([
      { repo: "acme/api", files: ["README.md"] },
      { repo: "acme/other", files: ["README.md"] },
    ]);
  });

  it("does not read a longer repo name as a reference to a shorter one", () => {
    const derived = deriveRepo(
      repo({
        repo: "acme/app",
        url: "https://github.com/acme/app",
        tree: tree("README.md"),
        contents: new Map([["README.md", "See acme/webhook only."]]),
        otherRepos: [
          { repo: "acme/web", url: "https://github.com/acme/web" },
          { repo: "acme/webhook", url: "https://github.com/acme/webhook" },
        ],
      }),
    );
    // `acme/webhook` matches itself; `acme/web` must not match inside it.
    expect(derived.references).toEqual([{ repo: "acme/webhook", files: ["README.md"] }]);
  });

  it("reports an unreadable tree as unavailable with empty lists, never a fabrication", () => {
    const derived = deriveRepo(repo({ tree: null, treeError: "GitHub rate limited the tree read" }));
    expect(derived.files).toEqual({ available: false, error: "GitHub rate limited the tree read" });
    expect(derived.languages).toEqual([]);
    expect(derived.manifests).toEqual([]);
    expect(derived.testCommands).toEqual([]);
    expect(derived.references).toEqual([]);
  });
});

describe("surveyWantedPaths and workflowRunCommands", () => {
  it("asks only for the files the derivation uses, in a stable order", () => {
    // The build files come first, so a repo full of docs cannot push them out of the cap.
    expect(surveyWantedPaths(tree("src/index.ts", "package.json", ".github/workflows/ci.yaml", "Dockerfile", "bc-prod.yaml", "README.md", "LICENSE"))).toEqual([
      ".github/workflows/ci.yaml",
      "Dockerfile",
      "bc-prod.yaml",
      "package.json",
      "README.md",
    ]);
  });

  it("splits run blocks, drops uses and comments, and keeps order", () => {
    const workflow = ["steps:", "  - uses: actions/checkout@v4", "  - run: npm ci && npm run build", "  - run: |", "      # a comment", "      pytest -q", "      npm test"].join("\n");
    expect(workflowRunCommands(workflow)).toEqual(["npm ci", "npm run build", "pytest -q", "npm test"]);
  });
});

describe("buildSurvey", () => {
  const linear = { available: true as const, value: { viewer: "Jane", teams: [{ key: "ENG", name: "Engineering", expectedStates: ["Todo", "In Progress"], missingStates: ["In Progress"] }] } };
  const bb = { projectFile: true, roles: true, projectSteward: "jane", playbooks: ["linear-tickets"], reposJson: true, error: null };

  it("assembles the report and sorts repos, and carries the .bb diff inputs", () => {
    const report = buildSurvey({
      projectId: "p1",
      source: "multi-repo",
      layout: "primary",
      primary: { dir: "bb", url: "https://github.com/acme/bb" },
      repos: [repo({ dir: "web" }), repo({ dir: "api", repo: "acme/api", url: "https://github.com/acme/api" })],
      linear,
      bb,
    });
    expect(report.repos.map((r) => r.dir)).toEqual(["api", "web"]);
    expect(report.linear).toEqual(linear);
    expect(report.bb).toEqual(bb);
    expect(report.primary).toEqual({ dir: "bb", url: "https://github.com/acme/bb" });
  });

  it("carries an unavailable Linear read through, and a partial .bb", () => {
    const report = buildSurvey({
      projectId: "p1",
      source: "native",
      layout: "directory",
      primary: null,
      repos: [repo()],
      linear: { available: false, error: "linear is not connected" },
      bb: { projectFile: false, roles: true, projectSteward: null, playbooks: [], reposJson: true, error: null },
    });
    expect(report.linear).toEqual({ available: false, error: "linear is not connected" });
    expect(report.bb.projectFile).toBe(false);
    expect(report.bb.projectSteward).toBeNull();
  });
});

describe("formatSurvey", () => {
  it("renders the facts, including the unavailable paths, as text", () => {
    const report = buildSurvey({
      projectId: "p1",
      source: "multi-repo",
      layout: "primary",
      primary: null,
      repos: [repo({ branchProtection: { available: false, error: "no token" }, labels: { available: false, error: "no token" } })],
      linear: { available: false, error: "linear is not connected" },
      bb: { projectFile: false, roles: false, projectSteward: null, playbooks: [], reposJson: false, error: null },
    });
    const text = formatSurvey(report);
    expect(text).toContain("branch protection: unavailable (no token)");
    expect(text).toContain("labels: unavailable (no token)");
    expect(text).toContain("Linear: unavailable (linear is not connected)");
    expect(text).toContain("Existing .bb: no project.json, no roles.json");
  });
});
