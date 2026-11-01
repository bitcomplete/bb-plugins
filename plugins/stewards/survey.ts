// The mechanical facts `bb stewards survey --json` emits, so the onboarding
// skill does not re-derive them and they are covered by tests. Pure: the
// caller gathers each repo's GitHub facts, its recursive tree, the text of the
// files the tree says are worth reading, the Linear teams and states, and what
// `.bb` already holds; this file turns that into one stable report.
//
// A read that fails is reported as `available: false` with the reason, never
// fabricated (the spec's "unavailable" path). Nothing here talks to the
// network or to bb: server.ts does the reads through the existing gh writer
// and the linear source contract.

/** A recursive tree entry as GitHub's tree API returns it. */
export type RepoTreeEntry = { path: string; type: string };

/** A value that a source either returned or could not be read. */
export type Available<T> = { available: true; value: T } | { available: false; error: string };

export type BranchProtection = {
  protected: boolean;
  /** Required approving reviews, when the branch protection rule names a number. */
  requiredApprovingReviewCount: number | null;
  /** Whether a status check is required before merging. */
  requiresStatusChecks: boolean;
};

/** One repo's raw inputs, as the caller read them. */
export type SurveyRepoInput = {
  dir: string;
  url: string;
  /** `owner/name` when the remote parses as GitHub, else null. */
  repo: string | null;
  defaultBranch: string | null;
  branchProtection: Available<BranchProtection>;
  labels: Available<string[]>;
  /** The recursive blob listing, or null when the tree could not be read. */
  tree: RepoTreeEntry[] | null;
  treeError: string | null;
  /** The text of the files worth reading, by repo-relative path; a missing key means not read. */
  contents: ReadonlyMap<string, string | null>;
  /** Every other repo in the project, for cross-repo references. */
  otherRepos: { repo: string | null; url: string }[];
};

export type SurveyRepoReference = { repo: string; files: string[] };

/** One repo's derived facts, the shape the report lists. */
export type SurveyRepo = {
  dir: string;
  url: string;
  repo: string | null;
  defaultBranch: string | null;
  branchProtection: Available<BranchProtection>;
  labels: Available<string[]>;
  /** Whether the file tree could be read; the lists below are empty when it could not. */
  files: { available: boolean; error: string | null };
  languages: string[];
  manifests: string[];
  testCommands: string[];
  typecheckCommands: string[];
  dockerfiles: string[];
  deployManifests: string[];
  references: SurveyRepoReference[];
};

export type SurveyLinearTeam = {
  key: string;
  name: string;
  /** The ticket playbook's workflow states, which the team must have. */
  expectedStates: string[];
  /** The expected states `sourceValidate` says the team does not have. */
  missingStates: string[];
};

export type SurveyLinear = Available<{
  viewer: string | null;
  teams: SurveyLinearTeam[];
}>;

/** What the project's `.bb` already holds, so adoption can diff rather than start over. */
export type SurveyBb = {
  /** A readable `.bb` definition (project.json) is present. */
  projectFile: boolean;
  roles: boolean;
  /** The login `roles.json` marks as the project steward, or null when none does. */
  projectSteward: string | null;
  /** The playbook files present, by name. */
  playbooks: string[];
  /** `repos.json` is present. */
  reposJson: boolean;
  /** Why the `.bb`/repos read failed, when it did; the flags are then all false. */
  error: string | null;
};

export type SurveyInput = {
  projectId: string;
  source: "multi-repo" | "native";
  layout: "primary" | "standalone";
  primary: { dir: string; url: string } | null;
  repos: SurveyRepoInput[];
  linear: SurveyLinear;
  bb: SurveyBb;
};

export type SurveyReport = {
  projectId: string;
  source: "multi-repo" | "native";
  layout: "primary" | "standalone";
  primary: { dir: string; url: string } | null;
  repos: SurveyRepo[];
  linear: SurveyLinear;
  bb: SurveyBb;
};

/** The most files one repo is asked for, so a survey is a bounded number of reads. */
export const MAX_SURVEY_FILES = 40;

const MANIFEST_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "composer.json",
  "mix.exs",
  "pubspec.yaml",
  "CMakeLists.txt",
  "Makefile",
  "meson.build",
]);

const basename = (path: string): string => path.split("/").at(-1) ?? path;

const isManifestPath = (path: string): boolean => {
  const name = basename(path);
  return MANIFEST_BASENAMES.has(name) || /\.(?:csproj|fsproj|vbproj|sln)$/u.test(name);
};

const isWorkflowPath = (path: string): boolean => /^\.github\/workflows\/.+\.ya?ml$/u.test(path);

const isDockerfilePath = (path: string): boolean => {
  const name = basename(path);
  return name === "Dockerfile" || /^Dockerfile[._-]/u.test(name) || name.endsWith(".Dockerfile");
};

const isDeployManifestPath = (path: string): boolean => {
  const name = basename(path);
  if (name === "bc-prod.yaml" || name === "bc-prod.yml") return true;
  if (path === "kploy" || path.startsWith("kploy/")) return true;
  return /^docker-compose.*\.ya?ml$/u.test(name);
};

/** A file whose text may name another repo: docs and the build/deploy files. */
const isReferenceCandidatePath = (path: string): boolean => isManifestPath(path) || isWorkflowPath(path) || isDockerfilePath(path) || isDeployManifestPath(path) || /\.md$/u.test(path);

/**
 * The paths a caller should read for one repo: the manifests, CI workflows,
 * Dockerfiles and deploy manifests first (so a repo full of docs cannot push
 * them out of the cap), then the docs that may name another repo. Stable
 * order, capped at `MAX_SURVEY_FILES`.
 */
export function surveyWantedPaths(tree: readonly RepoTreeEntry[]): string[] {
  const primary: string[] = [];
  const references: string[] = [];
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (isManifestPath(entry.path) || isWorkflowPath(entry.path) || isDockerfilePath(entry.path) || isDeployManifestPath(entry.path)) primary.push(entry.path);
    else if (isReferenceCandidatePath(entry.path)) references.push(entry.path);
  }
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const path of [...primary.sort(), ...references.sort()]) {
    if (seen.has(path)) continue;
    seen.add(path);
    wanted.push(path);
    if (wanted.length >= MAX_SURVEY_FILES) break;
  }
  return wanted;
}

/** The languages a set of manifests and file paths implies, sorted. */
function languagesOf(paths: readonly string[], contents: ReadonlyMap<string, string | null>): string[] {
  const languages = new Set<string>();
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  const read = (path: string): string => contents.get(path) ?? "";
  for (const path of paths) {
    const name = basename(path);
    if (name === "package.json") {
      const text = read(path);
      const typescript = has(/^tsconfig\.json$/u) || /"typescript"/u.test(text) || has(/\.tsx?$/u);
      languages.add(typescript ? "TypeScript" : "JavaScript");
    } else if (name === "go.mod" || name === "go.sum") languages.add("Go");
    else if (name === "Cargo.toml") languages.add("Rust");
    else if (name === "pyproject.toml" || name === "setup.py" || name === "setup.cfg" || name === "requirements.txt" || name === "Pipfile") languages.add("Python");
    else if (name === "Gemfile") languages.add("Ruby");
    else if (name === "pom.xml") languages.add("Java");
    else if (name === "build.gradle.kts" || name === "settings.gradle.kts") languages.add("Kotlin");
    else if (name === "build.gradle" || name === "settings.gradle") languages.add("Java");
    else if (name === "composer.json") languages.add("PHP");
    else if (name === "mix.exs") languages.add("Elixir");
    else if (name === "pubspec.yaml") languages.add("Dart");
    else if (name === "CMakeLists.txt" || name === "meson.build") languages.add("C/C++");
    else if (/\.csproj$|\.fsproj$|\.vbproj$|\.sln$/u.test(name)) languages.add("C#");
  }
  // Extension detection supplements the manifests, so a repo without a
  // recognised manifest still gets a language.
  const extensions: Array<[RegExp, string]> = [
    [/\.tsx?$/u, "TypeScript"],
    [/\.[cm]?jsx?$/u, "JavaScript"],
    [/\.go$/u, "Go"],
    [/\.rs$/u, "Rust"],
    [/\.py$/u, "Python"],
    [/\.rb$/u, "Ruby"],
    [/\.java$/u, "Java"],
    [/\.kt$/u, "Kotlin"],
    [/\.php$/u, "PHP"],
    [/\.cs$/u, "C#"],
    [/\.ex$/u, "Elixir"],
    [/\.dart$/u, "Dart"],
    [/\.(?:c|cc|cpp|h|hpp)$/u, "C/C++"],
    [/\.sh$/u, "Shell"],
    [/\.tf$/u, "HCL"],
  ];
  for (const path of paths) {
    for (const [re, language] of extensions) {
      if (re.test(path)) languages.add(language);
    }
  }
  return [...languages].sort();
}

/**
 * The shell commands a GitHub Actions workflow runs, split out of `run:`
 * blocks (plain and block scalars) and split again on `&&` and `;`. Comments
 * and `uses:` steps are dropped. A command that looks like a typecheck is
 * reported once, under typechecks; everything test-like is a test command.
 */
export function workflowRunCommands(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  const raw: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/u.exec(line);
    if (m === null) continue;
    const indent = m[1]!.length;
    const value = m[2]!.trim();
    if (value === "" || value === "|" || value === ">" || value === "|-" || value === ">-" || value === "|+" || value === ">+") {
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j]!;
        if (blockLine.trim() === "") {
          raw.push("");
          continue;
        }
        const blockIndent = blockLine.length - blockLine.trimStart().length;
        if (blockIndent <= indent) break;
        raw.push(blockLine.slice(Math.min(indent + 2, blockIndent)));
        i = j;
      }
    } else {
      raw.push(value.replace(/^["']|["']$/gu, ""));
    }
  }
  const commands: string[] = [];
  for (const chunk of raw) {
    for (const piece of chunk.split(/\r?\n|&&|;/u)) {
      const command = piece.trim();
      if (command === "" || command.startsWith("#")) continue;
      commands.push(command.replace(/\s+/gu, " "));
    }
  }
  return commands;
}

const TYPECHECK_RE = /(?:typecheck|type-check|type_check|\btsc\b|\bgo vet\b|\bmypy\b|\bpyright\b|\bcargo check\b|\bgradle check\b)/iu;
const TEST_RE = /(?:^|[\s/])(?:test|tests|vitest|jest|pytest|rspec|go test|cargo test|mvn test|gradle test|make test|npm test|pnpm test|yarn test|bundle exec rspec|ctest|dotnet test|phpunit|node --test)(?:[\s:/]|$)/iu;

/** Split a workflow's commands into typechecks and tests, deduped, in first-seen order. */
function classifyCommands(commands: readonly string[]): { tests: string[]; typechecks: string[] } {
  const tests: string[] = [];
  const typechecks: string[] = [];
  for (const command of commands) {
    if (TYPECHECK_RE.test(command)) {
      if (!typechecks.includes(command)) typechecks.push(command);
    } else if (TEST_RE.test(command)) {
      if (!tests.includes(command)) tests.push(command);
    }
  }
  return { tests, typechecks };
}

/** Normalize a repo URL for reference matching: no trailing slash, no `.git`, lower case. */
const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "").toLowerCase();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A reference to `needle` in lower-cased text: bounded so `acme/web` does not
 * match `acme/webhook`. A trailing `/` is allowed (a link into the repo).
 */
const namesIn = (haystack: string, needle: string): boolean => new RegExp(`(^|[^a-z0-9_-])${escapeRe(needle)}($|[^a-z0-9_-])`, "u").test(haystack);

/** The other repos a file's text names, by `owner/name` or by URL. */
function referencesIn(contents: ReadonlyMap<string, string | null>, paths: readonly string[], others: readonly { repo: string | null; url: string }[]): SurveyRepoReference[] {
  const found = new Map<string, Set<string>>();
  for (const path of paths) {
    const text = contents.get(path);
    if (text === null || text === undefined) continue;
    const haystack = text.toLowerCase();
    for (const other of others) {
      if (other.repo === null) continue;
      const byRepo = other.repo.toLowerCase();
      const byUrl = normalizeUrl(other.url);
      if (!namesIn(haystack, byRepo) && (byUrl === "" || !namesIn(haystack, byUrl))) continue;
      const files = found.get(other.repo) ?? new Set<string>();
      files.add(path);
      found.set(other.repo, files);
    }
  }
  return [...found.entries()].map(([repo, files]) => ({ repo, files: [...files].sort() })).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** One repo's derived facts. Pure: everything it needs is in `input`. */
export function deriveRepo(input: SurveyRepoInput): SurveyRepo {
  const tree = input.tree ?? [];
  const blobs = tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
  const wanted = surveyWantedPaths(tree);
  const filesAvailable = input.tree !== null;
  const manifests = blobs.filter(isManifestPath).sort();
  const dockerfiles = blobs.filter(isDockerfilePath).sort();
  const deployManifests = blobs.filter(isDeployManifestPath).sort();
  const workflows = blobs.filter(isWorkflowPath).sort();
  const tests: string[] = [];
  const typechecks: string[] = [];
  for (const workflow of workflows) {
    const text = input.contents.get(workflow);
    if (text === null || text === undefined) continue;
    const classified = classifyCommands(workflowRunCommands(text));
    for (const command of classified.tests) if (!tests.includes(command)) tests.push(command);
    for (const command of classified.typechecks) if (!typechecks.includes(command)) typechecks.push(command);
  }
  const referencePaths = wanted.filter(isReferenceCandidatePath);
  return {
    dir: input.dir,
    url: input.url,
    repo: input.repo,
    defaultBranch: input.defaultBranch,
    branchProtection: input.branchProtection,
    labels: input.labels,
    files: { available: filesAvailable, error: input.treeError },
    languages: languagesOf(blobs, input.contents),
    manifests,
    testCommands: tests,
    typecheckCommands: typechecks,
    dockerfiles,
    deployManifests,
    references: filesAvailable ? referencesIn(input.contents, referencePaths, input.otherRepos) : [],
  };
}

/** Assemble one project's survey report. Deterministic: every list is sorted. */
export function buildSurvey(input: SurveyInput): SurveyReport {
  const repos = input.repos.map(deriveRepo).sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    projectId: input.projectId,
    source: input.source,
    layout: input.layout,
    primary: input.primary,
    repos,
    linear: input.linear,
    bb: input.bb,
  };
}

/** The `.bb` playbook files `bb stewards init` writes, plus the optional ones. */
export const KNOWN_PLAYBOOKS = ["linear-tickets", "github-prs", "github-reviews", "ops-watch", "deps-alerts", "deps-prs"] as const;

/** A short human rendering of the survey, for `bb stewards survey` without `--json`. */
export function formatSurvey(report: SurveyReport): string {
  const lines: string[] = [`Project ${report.projectId} (${report.source}, ${report.layout})`];
  if (report.primary !== null) lines.push(`primary: ${report.primary.dir} ${report.primary.url}`);
  for (const repo of report.repos) {
    lines.push("", `${repo.dir}${repo.repo === null ? "" : ` (${repo.repo})`} ${repo.url}`);
    lines.push(`  default branch: ${repo.defaultBranch ?? "unknown"}`);
    lines.push(
      repo.branchProtection.available
        ? `  branch protection: ${repo.branchProtection.value.protected ? `protected (reviews ${repo.branchProtection.value.requiredApprovingReviewCount ?? "?"}, status checks ${repo.branchProtection.value.requiresStatusChecks ? "required" : "no"})` : "none"}`
        : `  branch protection: unavailable (${repo.branchProtection.error})`,
    );
    lines.push(`  languages: ${repo.languages.join(", ") || "(none)"}`);
    lines.push(`  manifests: ${repo.manifests.join(", ") || "(none)"}`);
    lines.push(`  test commands: ${repo.testCommands.join(" | ") || "(none)"}`);
    lines.push(`  typecheck commands: ${repo.typecheckCommands.join(" | ") || "(none)"}`);
    lines.push(`  dockerfiles: ${repo.dockerfiles.join(", ") || "(none)"}`);
    lines.push(`  deploy manifests: ${repo.deployManifests.join(", ") || "(none)"}`);
    lines.push(repo.labels.available ? `  labels: ${repo.labels.value.join(", ") || "(none)"}` : `  labels: unavailable (${repo.labels.error})`);
    lines.push(`  references: ${repo.references.map((r) => `${r.repo} (${r.files.join(", ")})`).join("; ") || "(none)"}`);
    if (!repo.files.available) lines.push(`  files: unavailable (${repo.files.error ?? "unknown"})`);
  }
  lines.push("");
  if (report.linear.available) {
    lines.push(`Linear (${report.linear.value.viewer ?? "viewer unknown"}):`);
    for (const team of report.linear.value.teams) {
      lines.push(`  ${team.key} ${team.name}: expected ${team.expectedStates.join(", ") || "(none)"}${team.missingStates.length > 0 ? `; missing ${team.missingStates.join(", ")}` : ""}`);
    }
  } else {
    lines.push(`Linear: unavailable (${report.linear.error})`);
  }
  lines.push("", `Existing .bb: ${report.bb.projectFile ? "project.json" : "no project.json"}${report.bb.roles ? `, roles.json${report.bb.projectSteward === null ? " (no projectSteward)" : ` (projectSteward ${report.bb.projectSteward})`}` : ", no roles.json"}${report.bb.reposJson ? ", repos.json" : ""}${report.bb.playbooks.length > 0 ? `, playbooks ${report.bb.playbooks.join(", ")}` : ""}`);
  if (report.bb.error !== null) lines.push(`  .bb read failed: ${report.bb.error}`);
  return lines.join("\n");
}
