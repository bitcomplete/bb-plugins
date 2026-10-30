/**
 * `repos.json` — the repo set, and the only source of truth for it.
 *
 * The file lives in the project's `.bb` git repo. This plugin reads it, edits
 * it, and commits it; it never keeps a second copy that could disagree. Plugin
 * storage holds derived state only (cache freshness, workspace manifests, the
 * precomputed layout), all of which is rebuildable from this file.
 *
 * It sits on the critical path for every thread creation in the project, so
 * every failure here names the offending entry. A file that does not parse is
 * a failed environment with a message a person can act on, not a silently
 * empty workspace.
 *
 * Pure: schema, validation, and the edits the tools and the panel perform. No
 * filesystem, no git — the caller owns both ends.
 */
import { z } from "zod";
import { PROJECT_SOURCE_DIR, type ProjectLayout } from "./paths.js";
import { PROJECT_FILE_PATH_MAX, dirFromUrl, isSafeSegment, normalizeRemoteUrl, projectFilePathProblem } from "./names.js";

export { dirFromUrl };

export const REPOS_FILE = "repos.json";
export const REPOS_VERSION = 1;

/**
 * How many repos one workspace may hold.
 *
 * Not a technical limit — a cold start clones every one of them, and the
 * layout block the agent reads has a 4096-character ceiling. Both degrade
 * badly and quietly past a few dozen, so the file says no with a message
 * instead.
 */
export const MAX_REPOS = 32;

/**
 * One entry as it may be written on disk.
 *
 * `dir` is optional: the common case is one checkout per repo under the name
 * the repo already has, and repeating it is noise. Only a repo whose URL does
 * not end in the name you want it to have — a fork, a second checkout, a
 * `.git`-less path — needs to say so.
 */
export const repoEntryInputSchema = z
  .object({
    dir: z.string().min(1).max(100).optional(),
    url: z.string().min(1).max(2000),
    branch: z.string().min(1).max(300).optional(),
  })
  .strict();

export type RepoEntryInput = z.infer<typeof repoEntryInputSchema>;

/**
 * One entry as everything downstream of the parser sees it: `dir` resolved.
 *
 * `inferredDir` records that the file did not say it, which is what lets an
 * unrelated edit serialize the entry back the way it was written rather than
 * materializing a name the author deliberately left out.
 */
export const repoEntrySchema = repoEntryInputSchema
  .extend({
    dir: z.string().min(1).max(100),
    inferredDir: z.boolean().optional(),
  })
  .strict();

export type RepoEntry = z.infer<typeof repoEntrySchema>;

/**
 * How a committed `.bb` write is published, per project or per path.
 *
 * Accepted and preserved by this parser now so that a `repos.json` written
 * once deliverable 2 ships does not make an older server reject the whole
 * repo set. This module attaches no behaviour to the value: it only validates
 * and round-trips it.
 */
export const publishModeSchema = z.enum(["push", "pull-request"]);
export type PublishMode = z.infer<typeof publishModeSchema>;

/**
 * A `.bb`-relative path that a publish policy may be keyed by.
 *
 * A trailing slash is allowed so a directory — `skills/`, `stewards/` — can
 * name a subtree; the segment rules are the same as for any file path.
 */
const publishPathSchema = z
  .string()
  .min(1)
  .max(PROJECT_FILE_PATH_MAX)
  .superRefine((value, context) => {
    const problem = projectFilePathProblem(value.endsWith("/") ? value.slice(0, -1) : value);
    if (problem !== null) context.addIssue({ code: "custom", message: problem });
  });

/**
 * One mode for the whole project, or one per path.
 *
 * The split form lets a project push mechanical `repos.json` edits while
 * keeping `AGENTS.md` and `skills/` reviewed like code; the value is validated
 * strictly so an unknown word is a parse error, not a silently ignored key.
 */
export const publishPolicySchema = z.union([
  publishModeSchema,
  z.record(publishPathSchema, publishModeSchema),
]);

export type PublishPolicy = z.infer<typeof publishPolicySchema>;

/**
 * Why a publish policy is invalid, or null when it is one of the accepted
 * shapes. Kept separate from the schema so `parseReposFile` can name the
 * offending path and mode in a sentence rather than a union of zod issues.
 */
export function publishPolicyProblem(value: unknown): string | null {
  if (typeof value === "string") {
    return publishModeSchema.safeParse(value).success
      ? null
      : `publish is ${JSON.stringify(value)}; expected "push" or "pull-request".`;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `publish must be "push", "pull-request", or an object of path → mode.`;
  }
  for (const [key, mode] of Object.entries(value)) {
    const problem = projectFilePathProblem(key.endsWith("/") ? key.slice(0, -1) : key);
    if (problem !== null) return `publish[${JSON.stringify(key)}]: ${problem}`;
    if (typeof mode !== "string" || !publishModeSchema.safeParse(mode).success) {
      return `publish[${JSON.stringify(key)}] is ${JSON.stringify(mode)}; expected "push" or "pull-request".`;
    }
  }
  return null;
}

/**
 * The publish mode for one `.bb`-relative path, from the policy and layout.
 *
 * Precedence: an explicit policy value wins; a policy object's most specific
 * matching key wins; otherwise the layout default applies. The defaults are
 * the settled ones from BB-148 deliverable 2:
 *
 * - A **primary** project's `.bb/` sits on a code repo's default branch, so
 *   every path — `repos.json` included — is reviewed like code and defaults to
 *   `pull-request`; `push` is opt-in through the key.
 * - A **standalone** `.bb` repo's `repos.json` is a mechanical one-line diff
 *   and defaults to `push`; `AGENTS.md`, `skills/`, `stewards/` and anything
 *   else default to `pull-request`.
 *
 * Pure, so the defaults and the split are testable without git or a server.
 */
export function resolvePublishMode(
  policy: PublishPolicy | undefined,
  layout: ProjectLayout,
  relativePath: string,
): PublishMode {
  const target = relativePath.replace(/^\.\//u, "").replace(/^\/+/u, "");
  if (typeof policy === "string") return policy;
  if (policy !== undefined) {
    let best: { key: string; mode: PublishMode } | null = null;
    for (const [key, mode] of Object.entries(policy)) {
      if (!publishKeyMatches(key, target)) continue;
      // Longest key wins, so `stewards/playbooks/` beats `stewards/`.
      if (best === null || key.length > best.key.length) best = { key, mode };
    }
    if (best !== null) return best.mode;
  }
  if (layout === "primary") return "pull-request";
  return target === REPOS_FILE ? "push" : "pull-request";
}

/** Whether a policy key names `target`: the path itself, or a directory above it. */
function publishKeyMatches(key: string, target: string): boolean {
  if (key.endsWith("/")) return target === key.slice(0, -1) || target.startsWith(key);
  return target === key || target.startsWith(`${key}/`);
}

export const reposFileInputSchema = z
  .object({
    version: z.literal(REPOS_VERSION),
    repos: z.array(repoEntryInputSchema).max(MAX_REPOS),
    /** Optional; absent means the deliverable-2 defaults, which this PR does not implement. */
    publish: publishPolicySchema.optional(),
  })
  .strict();

export const reposFileSchema = z
  .object({
    version: z.literal(REPOS_VERSION),
    repos: z.array(repoEntrySchema).max(MAX_REPOS),
    publish: publishPolicySchema.optional(),
  })
  .strict();

export type ReposFile = z.infer<typeof reposFileSchema>;

export const EMPTY_REPOS: ReposFile = { version: REPOS_VERSION, repos: [] };

export type ParseResult =
  | { ok: true; value: ReposFile }
  | { ok: false; error: string };

/** A zod issue path rendered the way a person reads the file: `repos[0].dir`. */
function issueLocation(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text === "" ? String(segment) : `.${String(segment)}`;
  }
  return text === "" ? "(root)" : text;
}

/**
 * Parse and fully validate the file's text.
 *
 * Strict JSON on purpose: documentation lives in the seeded `AGENTS.md` and
 * the plugin panel, not in comments nobody can parse back out. The semantic
 * rules below (safe directory names, no duplicates, `.bb` reserved) are not
 * expressible in the schema and matter more than the shape does — a duplicate
 * `dir` is the one mistake that silently loses a repo.
 */
export function parseReposFile(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `${REPOS_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = reposFileInputSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A bad `publish` is the one failure worth a sentence of its own: the
    // union that accepts it produces a list of zod issues, and the operator
    // needs to be told which value is wrong, not which shapes were tried.
    if (issue.path.length > 0 && issue.path[0] === "publish") {
      const problem = publishPolicyProblem((json as { publish?: unknown }).publish);
      if (problem !== null) return { ok: false, error: `${REPOS_FILE} ${problem}` };
    }
    return {
      ok: false,
      error: `${REPOS_FILE} is invalid at ${issueLocation(issue.path)}: ${issue.message}`,
    };
  }
  // The schema itself validates both the modes and the split-path keys, so a
  // bad `publish` fails `safeParse` above and the clearer sentence is built
  // there; nothing further is needed here.
  const repos: RepoEntry[] = [];
  for (const [index, entry] of parsed.data.repos.entries()) {
    const resolved = resolveRepoEntry(entry);
    if (resolved === null) {
      return {
        ok: false,
        error: `${REPOS_FILE} repos[${index}]: no dir, and none can be inferred from url ${JSON.stringify(entry.url)}. Add an explicit "dir".`,
      };
    }
    repos.push(resolved);
  }
  const semantic = validateRepoSet(repos);
  if (semantic !== null) return { ok: false, error: semantic };
  return {
    ok: true,
    value: {
      version: parsed.data.version,
      repos,
      ...(parsed.data.publish === undefined ? {} : { publish: parsed.data.publish }),
    },
  };
}

/** Carry `repos.json`'s non-repo keys across an edit unchanged. */
function withRepos(file: ReposFile, repos: RepoEntry[]): ReposFile {
  return {
    version: REPOS_VERSION,
    repos,
    ...(file.publish === undefined ? {} : { publish: file.publish }),
  };
}

/**
 * Fill in `dir` from the URL when the entry omits it.
 *
 * Returns null when nothing usable comes out, so the caller says so instead of
 * inventing a name — see `dirFromUrl`.
 */
export function resolveRepoEntry(entry: RepoEntryInput): RepoEntry | null {
  if (entry.dir !== undefined) return { ...entry, dir: entry.dir };
  const dir = dirFromUrl(entry.url);
  return dir === null ? null : { ...entry, dir, inferredDir: true };
}

/** The rules the schema cannot state. Returns the first failure, or null. */
export function validateRepoSet(repos: readonly RepoEntry[]): string | null {
  const seenDirs = new Set<string>();
  const seenUrls = new Map<string, string>();
  for (const [index, repo] of repos.entries()) {
    const at = `${REPOS_FILE} repos[${index}]`;
    if (repo.dir === PROJECT_SOURCE_DIR) {
      return `${at}: "${PROJECT_SOURCE_DIR}" is reserved for the project's own workspace definition.`;
    }
    if (!isSafeSegment(repo.dir)) {
      return `${at}: dir ${JSON.stringify(repo.dir)} must be a plain directory name — no separators, dot segments, or leading dots.`;
    }
    // Case-insensitively, because macOS and Windows would collapse two entries
    // that Linux keeps apart, and a repo set should mean the same thing on
    // every machine in the project.
    const dirKey = repo.dir.toLowerCase();
    if (seenDirs.has(dirKey)) return `${at}: dir ${JSON.stringify(repo.dir)} is already used by an earlier entry.`;
    seenDirs.add(dirKey);
    if (repo.url.includes("\0") || repo.url.trim() !== repo.url) {
      return `${at}: url ${JSON.stringify(repo.url)} has leading, trailing, or embedded control characters.`;
    }
    // A URL beginning with `-` would be read by git as an option rather than a
    // location. Every git call here passes arguments as an array, so nothing
    // is shell-parsed, but `git clone --upload-pack=…` is still an argument.
    if (repo.url.startsWith("-")) return `${at}: url ${JSON.stringify(repo.url)} may not start with "-".`;
    const urlKey = normalizeRemoteUrl(repo.url);
    const clash = seenUrls.get(urlKey);
    if (clash !== undefined) {
      // Not fatal in principle — two checkouts of one repo is a legal thing to
      // want — but it is far more often a copy-paste mistake, and the cost of
      // being wrong is a second full clone of the same code.
      return `${at}: url ${JSON.stringify(repo.url)} is the same repo as "${clash}". Remove one, or give them different remotes.`;
    }
    seenUrls.set(urlKey, repo.dir);
  }
  return null;
}

/**
 * Serialize for committing.
 *
 * Two spaces and a trailing newline, always in the same key order, so the
 * plugin's own edits produce a one-line diff a person can review rather than
 * reformatting the whole file underneath them.
 */
export function serializeReposFile(file: ReposFile): string {
  // An inferred `dir` is written back out as the absence it was: an unrelated
  // add or remove should be a one-line diff, not a pass that names every repo
  // whose author left the name to the URL.
  const repos = file.repos.map((repo) => ({
    ...(repo.inferredDir === true ? {} : { dir: repo.dir }),
    url: repo.url,
    ...(repo.branch === undefined ? {} : { branch: repo.branch }),
  }));
  return `${JSON.stringify(
    {
      version: REPOS_VERSION,
      repos,
      ...(file.publish === undefined ? {} : { publish: file.publish }),
    },
    null,
    2,
  )}\n`;
}

export type EditResult =
  | { ok: true; value: ReposFile }
  | { ok: false; error: string };

export function addRepo(file: ReposFile, entry: RepoEntryInput): EditResult {
  if (file.repos.length >= MAX_REPOS) {
    return { ok: false, error: `A workspace may hold at most ${MAX_REPOS} repos.` };
  }
  const resolved = resolveRepoEntry(entry);
  if (resolved === null) {
    return { ok: false, error: `Could not derive a directory name from ${JSON.stringify(entry.url)}.` };
  }
  const next = withRepos(file, [...file.repos, resolved]);
  const problem = validateRepoSet(next.repos);
  return problem === null ? { ok: true, value: next } : { ok: false, error: problem };
}

export function removeRepo(file: ReposFile, dir: string): EditResult {
  const repos = file.repos.filter((repo) => repo.dir !== dir);
  if (repos.length === file.repos.length) {
    return { ok: false, error: `No repo named ${JSON.stringify(dir)} is in ${REPOS_FILE}.` };
  }
  return { ok: true, value: withRepos(file, repos) };
}

/**
 * Change one repo's base branch in place; `null` returns it to the default.
 *
 * The entry keeps its position and its inferred-`dir` flag, so the commit is
 * the one-line diff a branch change should be.
 */
export function setRepoBranch(file: ReposFile, dir: string, branch: string | null): EditResult {
  const index = file.repos.findIndex((repo) => repo.dir === dir);
  if (index === -1) {
    return { ok: false, error: `No repo named ${JSON.stringify(dir)} is in ${REPOS_FILE}.` };
  }
  const trimmed = branch?.trim() ?? "";
  if (trimmed.length > 300 || trimmed.startsWith("-")) {
    return { ok: false, error: `${JSON.stringify(trimmed)} is not a usable branch name.` };
  }
  const { branch: _previous, ...rest } = file.repos[index];
  const next = trimmed.length === 0 ? rest : { ...rest, branch: trimmed };
  const repos = [...file.repos];
  repos[index] = next;
  return { ok: true, value: withRepos(file, repos) };
}

/** Whether a repo with this directory name — or this remote — is already in the set. */
export function findRepo(file: ReposFile, entry: { dir?: string; url?: string }): RepoEntry | null {
  const url = entry.url === undefined ? null : normalizeRemoteUrl(entry.url);
  return (
    file.repos.find(
      (repo) =>
        (entry.dir !== undefined && repo.dir === entry.dir) ||
        (url !== null && normalizeRemoteUrl(repo.url) === url),
    ) ?? null
  );
}
