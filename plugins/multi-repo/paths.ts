/**
 * Path safety for every name this plugin takes from outside itself.
 *
 * Three different untrusted strings end up as path segments: a `dir` from
 * `repos.json` (which a user edits by hand and an agent edits through a tool),
 * a `pathKey` from core, and a cache key derived from a repo URL. All three are
 * joined onto a directory this plugin owns, so all three are checked here
 * rather than at each call site — a single `..` that slipped through would let
 * a repo entry write outside the workspace root.
 *
 * Pure: no `node:fs`, so the server bundle and the tests can import it too.
 */
import { createHash } from "node:crypto";

export class MultiRepoPathError extends Error {}

export { isSafeSegment, normalizeRemoteUrl } from "./names.js";
import { isSafeSegment, normalizeRemoteUrl } from "./names.js";

export function assertSafeSegment(value: string, what: string): string {
  if (!isSafeSegment(value)) {
    throw new MultiRepoPathError(
      `${what} must be a plain directory name without separators or dot segments: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The `.bb` directory name, which is the one segment a repo may not claim:
 * bb itself reads `<workspace>/.bb/AGENTS.md` and `<workspace>/.bb/skills`, so
 * a repo cloned there would replace the project's own guidance.
 *
 * `isSafeSegment` already rejects it for leading-dot reasons; the constant
 * exists so the error message can say why rather than describing dots.
 */
export const PROJECT_SOURCE_DIR = ".bb";

/**
 * A stable cache directory name for a repo URL.
 *
 * The readable prefix is for a human reading `ls` on the cache; the hash is
 * what makes it unique. Two repos with the same basename (`you/bb` and
 * `them/bb`) must not share an object store, and a URL is not itself a legal
 * directory name, so neither half works alone.
 */
export function cacheKeyForUrl(url: string): string {
  const digest = createHash("sha256").update(normalizeRemoteUrl(url)).digest("hex").slice(0, 12);
  const slug = (url.replace(/\.git$/u, "").split(/[/:]/u).pop() ?? "repo")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 40);
  return `${slug.length > 0 ? slug : "repo"}-${digest}`;
}
