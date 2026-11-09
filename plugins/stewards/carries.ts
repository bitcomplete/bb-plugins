// Whether a deployment carries a merge, evaluated by the plugin from a
// playbook's structured `carries` rule (BB-132). A free-text `carries` is the
// steward's to apply and this module returns null for it; the two strategies
// here are the fixed sequence of GitHub reads the playbooks used to spell out
// in prose. Pure: every read goes through the `CarriesReader` handed in, so a
// test supplies a fake and the plugin never runs `gh` in the stewards server.
import { parse as parseYaml } from "yaml";
import type { CarriesRule, CarriesStrategy, DeploymentTarget } from "./config.js";
import { globMatches } from "./decisions.js";
import type { CompareStatus, WorkflowRunInfo } from "./source-contract.js";

/** The GitHub reads an `image-tag` or `ref-contains-merge` rule needs, through the github source. A `live-at-merge` rule needs none. */
export type CarriesReader = {
  /** A file's text at a ref; content null when it is not there, error set when the read failed. */
  fileAtRef(repo: string, path: string, ref: string): Promise<{ content: string | null; error: string | null }>;
  /** The newest commit on a branch (HEAD for the default) touching a path at or before `until`; path "" is the branch tip. */
  latestCommit(repo: string, branch: string, path: string, until: string): Promise<{ sha: string | null; error: string | null }>;
  /** The run of a workflow carrying a run number, with its head sha, start and jobs. */
  workflowRun(repo: string, workflow: string, runNumber: number): Promise<{ run: WorkflowRunInfo | null; error: string | null }>;
  /** GitHub's compare status of head against base. */
  compare(repo: string, base: string, head: string): Promise<{ status: CompareStatus | null; error: string | null }>;
};

/** What one watch contributes to the decision. */
export type CarriesContext = {
  /** The merge commit the deployment must carry, or null when the source has not told us yet. */
  merge: string | null;
  /** The merged pull request's own repo, matched against a rule's `when.repo`. */
  prRepo: string;
  /** The merged pull request's changed paths, matched against a rule's `when.paths`. */
  files: readonly string[];
  /** The deployment's ref, the manifest is read at it. */
  ref: string | null;
};

/** The plugin's verdict: settled deployed, still awaiting, or undecidable (a failed read or no matching rule). */
export type CarriesVerdict =
  | { kind: "deployed"; note: string }
  | { kind: "not-yet"; note: string }
  | { kind: "undecided"; note: string };

/** The short sha a note names. */
const short = (sha: string | null | undefined): string => (sha === null || sha === undefined || sha === "" ? "?" : sha.slice(0, 7));

/**
 * The note a missing `carries` rule leaves on a watch. A later deployment of
 * the same target must recognise it and stay quiet rather than wake the
 * steward again (BB-204).
 */
export const NO_RULE_PREFIX = "No carries rule matches";

/** Whether a watch's note is the one a missing `carries` rule leaves. */
export const noRuleNoted = (note: string | null | undefined): boolean => (note ?? "").startsWith(NO_RULE_PREFIX);

/** Whether a compare status means `head` contains `base`: identical, or ahead of it. */
export const containsStatus = (status: CompareStatus | null): boolean => status === "ahead" || status === "identical";

/**
 * Whether one changed path falls under one of a rule's `paths`. Both the
 * carries `paths` and GitHub's changed files are repo-relative, so this is a
 * direct glob match. The decide list's `touchesAny` is deliberately not used:
 * its repo-prefix stripping turns a rule like `kploy/**` into `**` and so
 * matches every path, which would make a rule swallow merges another rule
 * owns (BB-260).
 */
const fileUnder = (file: string, paths: readonly string[]): boolean => paths.some((pattern) => globMatches(pattern, file));

/**
 * GitHub's changed-files page size: the source reads at most this many paths,
 * so a list this long may be truncated and is not a complete "every file" set
 * (BB-260).
 */
export const CARRIES_FILES_PAGE_LIMIT = 100;

/**
 * Whether a `live-at-merge` rule matches: its repo, and every changed file
 * under one of its paths. An empty or unreadable file list matches nothing
 * (an unknown change is never assumed live), nor does a list at GitHub's page
 * limit, which may be truncated and so may hide a file outside the paths. A
 * rule with no paths matches any non-empty list. A merge that also touches a
 * path outside the rule does not match, so it can fall through to the rule
 * that owns that path.
 */
export function liveAtMergeMatches(rule: CarriesRule, prRepo: string, files: readonly string[]): boolean {
  if (rule.strategy.kind !== "live-at-merge") return false;
  if (rule.when.repo.toLowerCase() !== prRepo.toLowerCase()) return false;
  if (files.length === 0 || files.length >= CARRIES_FILES_PAGE_LIMIT) return false;
  const paths = rule.when.paths;
  if (paths === undefined || paths.length === 0) return true;
  return files.every((file) => fileUnder(file, paths));
}

/**
 * The first rule whose `when` matches the merge: the pull request's repo,
 * ignoring case, and, when the rule lists paths, at least one changed path
 * under one of them. A `live-at-merge` rule is stricter: every changed file
 * must be under its paths, so a merge that also touches a path another rule
 * owns falls through to that rule (first match wins). Null when none matches.
 */
export function matchCarriesRule(rules: readonly CarriesRule[], prRepo: string, files: readonly string[]): CarriesRule | null {
  return rules.find((r) => {
    if (r.when.repo.toLowerCase() !== prRepo.toLowerCase()) return false;
    if (r.strategy.kind === "live-at-merge") return liveAtMergeMatches(r, prRepo, files);
    return r.when.paths === undefined || files.some((file) => fileUnder(file, r.when.paths!));
  }) ?? null;
}

/**
 * The verdict a `live-at-merge` rule gives without any deployment: `deployed`,
 * because nothing builds or applies the paths the rule names, so the merge is
 * live the moment it lands. Null for every other strategy, which needs a
 * deployment read. The watch-recording path applies this helper the moment it
 * records a merge, so the steward is woken with the verdict and no deployment
 * is awaited (BB-260).
 */
export function liveAtMergeVerdict(rule: CarriesRule): CarriesVerdict | null {
  if (rule.strategy.kind !== "live-at-merge") return null;
  const paths = rule.when.paths ?? [];
  const where = paths.length === 0 ? "the merge" : paths.join(", ");
  return { kind: "deployed", note: `live-at-merge: nothing deploys ${where}` };
}

/**
 * The `newTag` a kustomization applies to an image, as text, or null. The
 * manifest is kustomize's `images:` list of `{ name, newTag }`; a `newTag`
 * written as a number is read as text.
 */
export function imageTagFromManifest(content: string, image: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const images = (parsed as { images?: unknown }).images;
  if (!Array.isArray(images)) return null;
  for (const entry of images) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { name?: unknown; newTag?: unknown };
    if (e.name !== image) continue;
    if (typeof e.newTag === "string" || typeof e.newTag === "number") return String(e.newTag);
  }
  return null;
}

/** The value a Dockerfile's `ARG <pinArg>=<value>` carries, or null. */
export function pinFromDockerfile(content: string, pinArg: string): string | null {
  const escaped = pinArg.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const m = new RegExp(`^\\s*ARG\\s+${escaped}=([^\\s#]+)`, "mu").exec(content);
  return m === null ? null : m[1]!;
}

/**
 * Evaluate a structured `carries` for one watch. Returns null when the
 * target's `carries` is free text (the steward decides, exactly as before).
 * `not-yet` is a settled plugin verdict that the deployment does not carry
 * the merge yet; `undecided` is a failed read or no matching rule, which
 * wakes the steward with the note and leaves the watch as it was.
 */
export async function evaluateCarries(target: DeploymentTarget, context: CarriesContext, reader: CarriesReader): Promise<CarriesVerdict | null> {
  if (typeof target.carries === "string") return null;
  const rule = matchCarriesRule(target.carries, context.prRepo, context.files);
  if (context.merge === null || context.merge === "") return { kind: "not-yet", note: "The merge commit is not known yet; the next read re-resolves it" };
  if (context.ref === null || context.ref === "") return { kind: "not-yet", note: "The deployment has no ref yet" };
  const merge = context.merge;
  if (rule === null) return { kind: "undecided", note: `${NO_RULE_PREFIX} ${context.prRepo}${context.files.length === 0 ? "" : ` (${context.files.slice(0, 5).join(", ")}${context.files.length > 5 ? ", …" : ""})`}` };

  // BB-260: a live-at-merge rule needs no image read, but a deployment can
  // only settle a watch whose merge is already on the default branch. Require
  // the deployment's ref to contain the merge, exactly as ref-contains-merge
  // does: a stacked pull request's squash merge is not on main, so it stays
  // not-yet until it reaches the default branch. The record path
  // (`liveAtMergeVerdict`) settles a normal merge at merge time, so this read
  // only runs for a watch left awaiting a deployment.
  if (rule.strategy.kind === "live-at-merge") {
    const { status, error } = await reader.compare(target.repo, merge, context.ref);
    if (error !== null || status === null) return { kind: "undecided", note: `live-at-merge: could not compare ${short(merge)}...${context.ref} on ${target.repo}${error === null ? "" : `: ${error}`}` };
    return containsStatus(status)
      ? liveAtMergeVerdict(rule)!
      : { kind: "not-yet", note: `live-at-merge: ${context.ref} does not contain merge ${short(merge)} (${status})` };
  }

  if (rule.strategy.kind === "ref-contains-merge") {
    const { status, error } = await reader.compare(target.repo, merge, context.ref);
    if (error !== null || status === null) return { kind: "undecided", note: `ref-contains-merge: could not compare ${short(merge)}...${context.ref} on ${target.repo}${error === null ? "" : `: ${error}`}` };
    return containsStatus(status)
      ? { kind: "deployed", note: `ref-contains-merge: ${context.ref} contains merge ${short(merge)}` }
      : { kind: "not-yet", note: `ref-contains-merge: ${context.ref} does not contain merge ${short(merge)} (${status})` };
  }

  // The `live-at-merge` and `ref-contains-merge` kinds returned above; the
  // reads in the block before this reset the compiler's narrowing of the
  // property, so re-state it.
  const { manifest, image, workflow, job, consumer } = rule.strategy as Extract<CarriesStrategy, { kind: "image-tag" }>;
  const manifestRead = await reader.fileAtRef(target.repo, manifest, context.ref);
  if (manifestRead.error !== null) return { kind: "undecided", note: `image-tag: could not read ${manifest} at ${context.ref} on ${target.repo}: ${manifestRead.error}` };
  if (manifestRead.content === null) return { kind: "not-yet", note: `image-tag: ${manifest} has no ${image} at ${context.ref}` };
  const tag = imageTagFromManifest(manifestRead.content, image);
  if (tag === null) return { kind: "not-yet", note: `image-tag: ${manifest} applies no newTag to ${image} at ${context.ref}` };
  const runNumber = Number(tag);
  if (!Number.isInteger(runNumber) || runNumber <= 0) return { kind: "not-yet", note: `image-tag: ${image} newTag ${tag} is not a run number` };
  const runRead = await reader.workflowRun(target.repo, workflow, runNumber);
  if (runRead.error !== null) return { kind: "undecided", note: `image-tag: could not read ${workflow} run ${runNumber} on ${target.repo}: ${runRead.error}` };
  const run = runRead.run;
  if (run === null) return { kind: "not-yet", note: `image-tag: no ${workflow} run numbered ${runNumber} on ${target.repo}` };

  // The router image (no build job): the run's own head sha is what it built.
  if (job === undefined) {
    if (run.headSha === null || run.headSha === "") return { kind: "not-yet", note: `image-tag: ${workflow} run ${runNumber} has no head sha` };
    const { status, error } = await reader.compare(target.repo, merge, run.headSha);
    if (error !== null || status === null) return { kind: "undecided", note: `image-tag: could not compare ${short(merge)}...${short(run.headSha)} on ${target.repo}${error === null ? "" : `: ${error}`}` };
    return containsStatus(status)
      ? { kind: "deployed", note: `image-tag: ${workflow} run ${runNumber} head ${short(run.headSha)} contains merge ${short(merge)}` }
      : { kind: "not-yet", note: `image-tag: ${workflow} run ${runNumber} head ${short(run.headSha)} does not contain merge ${short(merge)} (${status})` };
  }

  const build = run.jobs.find((j) => j.name.toLowerCase() === job.toLowerCase());
  if (build === undefined || build.startedAt === null || build.startedAt === "") return { kind: "not-yet", note: `image-tag: ${workflow} run ${runNumber} has no started ${job} job` };

  // The commit the image was built from, read as of the build job's start.
  // With a consumer it is the commit whose Dockerfile pinned the consumer;
  // without one it is the default branch's tip then (the build checks out the
  // default branch, not the run's head).
  const asOfRead = await reader.latestCommit(target.repo, "HEAD", consumer?.dockerfile ?? "", build.startedAt);
  if (asOfRead.error !== null) return { kind: "undecided", note: `image-tag: could not find the build commit on ${target.repo} as of ${build.startedAt}: ${asOfRead.error}` };
  if (asOfRead.sha === null) return { kind: "not-yet", note: `image-tag: no build commit on ${target.repo} as of ${build.startedAt}` };

  if (consumer === undefined) {
    const { status, error } = await reader.compare(target.repo, merge, asOfRead.sha);
    if (error !== null || status === null) return { kind: "undecided", note: `image-tag: could not compare ${short(merge)}...${short(asOfRead.sha)} on ${target.repo}${error === null ? "" : `: ${error}`}` };
    return containsStatus(status)
      ? { kind: "deployed", note: `image-tag: ${workflow} run ${runNumber} built ${short(asOfRead.sha)}, which contains merge ${short(merge)}` }
      : { kind: "not-yet", note: `image-tag: ${workflow} run ${runNumber} built ${short(asOfRead.sha)}, which does not contain merge ${short(merge)} (${status})` };
  }

  const dockerfileRead = await reader.fileAtRef(target.repo, consumer.dockerfile, asOfRead.sha);
  if (dockerfileRead.error !== null) return { kind: "undecided", note: `image-tag: could not read ${consumer.dockerfile} at ${short(asOfRead.sha)}: ${dockerfileRead.error}` };
  if (dockerfileRead.content === null) return { kind: "not-yet", note: `image-tag: ${consumer.dockerfile} is not there at ${short(asOfRead.sha)}` };
  const pin = pinFromDockerfile(dockerfileRead.content, consumer.pinArg);
  if (pin === null) return { kind: "not-yet", note: `image-tag: ${consumer.dockerfile} at ${short(asOfRead.sha)} carries no ${consumer.pinArg}` };
  const { status, error } = await reader.compare(consumer.repo, merge, pin);
  if (error !== null || status === null) return { kind: "undecided", note: `image-tag: could not compare ${short(merge)}...${short(pin)} on ${consumer.repo}${error === null ? "" : `: ${error}`}` };
  return containsStatus(status)
    ? { kind: "deployed", note: `image-tag: ${workflow} run ${runNumber} pinned ${consumer.pinArg}=${short(pin)}, which contains merge ${short(merge)}` }
    : { kind: "not-yet", note: `image-tag: ${workflow} run ${runNumber} pinned ${consumer.pinArg}=${short(pin)}, which does not contain merge ${short(merge)} (${status})` };
}
