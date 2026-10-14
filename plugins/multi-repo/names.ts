/**
 * Name and URL helpers with no runtime dependencies at all.
 *
 * Split out of `paths.ts` and `repos.ts` so the frontend bundle can import
 * them: `paths.ts` needs `node:crypto` for cache keys and `repos.ts` needs
 * zod, and the Repos panel needs neither — it only wants to show the directory
 * a URL will get before the server is asked, and to tell a duplicate from a
 * new entry while a project is still being assembled. Both halves must agree,
 * so there is one copy and the server re-exports it.
 */

/**
 * A single path segment, safe on every platform bb runs on.
 *
 * Rejects separators in both directions (a `\` is a separator on Windows and
 * an ordinary character on Linux, so a name carrying one is never intended),
 * the two dot segments, leading dots (which would shadow `.bb` or `.git`),
 * NUL, and anything long enough to be a filesystem argument rather than a
 * name.
 */
export function isSafeSegment(value: string): boolean {
  if (value.length === 0 || value.length > 100) return false;
  if (value === "." || value === "..") return false;
  if (value.startsWith(".")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  // A trailing dot or space is silently trimmed by Windows, so two entries
  // that differ only there would collide on one machine and not another.
  if (value !== value.trim() || value.endsWith(".")) return false;
  return true;
}

/**
 * The directory name a repo gets when the caller did not pick one: the URL's
 * last component, minus `.git`.
 *
 * Returns null rather than a fallback when nothing usable comes out, so
 * `workspace_add_repo` asks for an explicit `dir` instead of inventing
 * `repo-1` and leaving the agent to discover what it got.
 */
export function dirFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "");
  const candidate = trimmed.split(/[/:\\]/u).pop() ?? "";
  return isSafeSegment(candidate) ? candidate : null;
}

/**
 * The comparison form of a remote URL, for "is this checkout a mirror of that
 * repo" and for keying the cache.
 *
 * Git accepts the same GitHub repo as `git@github.com:you/r.git`,
 * `ssh://git@github.com/you/r`, and `https://github.com/you/r/` — treating
 * those as three repos would mean three cache entries and a missed local
 * mirror, so they are folded to one. Nothing here rewrites the URL that is
 * actually handed to git; this form is only ever compared.
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim().replace(/\/+$/u, "");
  value = value.replace(/\.git$/u, "");
  // scp-style `user@host:path` → `ssh://user@host/path`, so one parse covers both.
  const scp = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/u.exec(value);
  if (scp !== null && !value.includes("://")) {
    value = `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  }
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(.+)$/iu.exec(value);
  if (withScheme !== null) {
    // The scheme and any credentials are transport, not identity: the same
    // repo over ssh and https is the same repo.
    return withScheme[2].toLowerCase();
  }
  return value;
}

/**
 * A directory-safe slug for a project name: `My Project!` → `my-project`.
 * Used for the default location of a new project's `.bb` checkout.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "project";
}

/** The longest repo-relative path `readProjectFiles` accepts. */
export const PROJECT_FILE_PATH_MAX = 300;

/**
 * Why a path is not a file inside the `.bb` repo, or null when it is one.
 *
 * Checked in the RPC schema and again host-side, because the host is the side
 * that hands the path to git. A relative POSIX path with no `..`, no `.` and
 * no empty segment names exactly one entry in a commit's tree; anything else
 * either escapes the repo or means something to git beyond a path.
 */
export function projectFilePathProblem(value: string): string | null {
  if (value.length === 0) return "A path is required.";
  if (value.length > PROJECT_FILE_PATH_MAX) return `A path may be at most ${PROJECT_FILE_PATH_MAX} characters.`;
  if (value.startsWith("/")) return `${JSON.stringify(value)} is absolute; paths are relative to the repo.`;
  if (value.includes("\\")) return `${JSON.stringify(value)} contains a backslash; paths use \`/\`.`;
  if (value.includes("\0")) return `${JSON.stringify(value)} contains NUL.`;
  for (const segment of value.split("/")) {
    if (segment === "..") return `${JSON.stringify(value)} has a \`..\` segment.`;
    if (segment === "." || segment.length === 0) {
      return `${JSON.stringify(value)} has an empty or \`.\` segment.`;
    }
  }
  return null;
}
