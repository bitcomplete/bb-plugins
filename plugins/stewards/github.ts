// GitHub writes the Stewards page makes as the connected user: an unsigned
// approval comment, and a squash merge. The credential is the gh login on this
// server host (read the way github-watcher/gh.ts reads it), and nothing here
// signs what it writes, so a page action counts as the user's, not a thread's.
//
// Everything goes through the GitHub API rather than the `gh` subcommands, so
// the request is exactly what the button says: POST a comment, PUT a merge.
import { execFile } from "node:child_process";

const API = "https://api.github.com";
const TOKEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class NotSignedInError extends Error {
  constructor(detail: string) {
    super(`GitHub is not signed in on this bb server${detail === "" ? "" : ` (${detail})`}. Sign in from the GitHub row of the Team setup checklist on the home page.`);
    this.name = "NotSignedInError";
  }
}

export class GithubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubApiError";
  }
}

export type TokenReader = (signal?: AbortSignal) => Promise<string>;

/** Reads the token gh holds for github.com. Throws NotSignedInError when there is none. */
export function createGhTokenReader(): TokenReader {
  return (signal) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
      execFile("gh", ["auth", "token", "--hostname", "github.com"], { env, timeout: TOKEN_TIMEOUT_MS, maxBuffer: 64 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new NotSignedInError("gh is not installed"));
          const line = String(stderr).split("\n").map((l) => l.trim()).find((l) => l !== "") ?? error.message;
          return reject(new NotSignedInError(line));
        }
        const token = String(stdout).trim();
        if (token === "") return reject(new NotSignedInError("gh printed no token"));
        resolve(token);
      });
    });
}

/** A recursive tree entry as GitHub's tree API returns it. */
export interface GithubTreeEntry {
  path: string;
  type: string;
}

/**
 * A branch's protection rule, as the survey reports it. `protected` comes from
 * the branch endpoint, which needs no admin; the two detail fields come from
 * the protection endpoint, which does, and are null when the token cannot read
 * it (the details are unknown, not false).
 */
export interface BranchProtection {
  protected: boolean;
  requiredApprovingReviewCount: number | null;
  requiresStatusChecks: boolean | null;
}

export interface GithubWriter {
  /**
   * Post a comment as the connected user and return GitHub's node id for it.
   * The id ties the plugin's own approval record to the marker it posted, so a
   * hand-typed lookalike never satisfies the lane gate.
   */
  comment(repo: string, number: number, body: string): Promise<string>;
  /**
   * Submit a pull request review as the connected user (BB-118). The body is
   * unsigned: a teammate's pull request can carry a real APPROVED or
   * changes-requested review, where the owner's own pull request cannot.
   */
  review(repo: string, number: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body: string): Promise<void>;
  /** Squash-merge the pull request, with the given commit title and message; returns the merge commit sha when GitHub reports one. */
  squashMerge(repo: string, number: number, title: string, body: string): Promise<{ sha: string | null }>;
  /**
   * A pull request's title and body, for the squash merge commit (BB-193).
   * Null when GitHub has no readable title, or when the read fails; the caller
   * then falls back to its own placeholder title.
   */
  pullDetails(repo: string, number: number): Promise<{ title: string; body: string } | null>;
  /**
   * The repo-relative paths a pull request changes, for the decide list. When
   * absent, or when the read fails, the plugin cannot classify the pull
   * request and treats it as the user's (fail closed).
   */
  files?(repo: string, number: number): Promise<string[]>;
  /** A repository's default branch, for the base of a lesson's pull request (BB-108). */
  defaultBranch(repo: string): Promise<string | null>;
  /** Open a pull request and return its URL and number (BB-108). */
  createPull(repo: string, args: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  /** Close a pull request without merging it (BB-108 Drop). */
  closePull(repo: string, number: number): Promise<void>;
  /**
   * One file's UTF-8 content at a ref, or null when it is not there. Used to
   * check a lesson's anchored block is really in the pull request before a
   * procedure merge (BB-108).
   */
  fileContent?(repo: string, path: string, ref: string): Promise<string | null>;
  /** A repository's recursive tree at a ref, for the onboarding survey. */
  tree?(repo: string, ref: string): Promise<GithubTreeEntry[]>;
  /** A branch's protection rule, or null when the branch is not protected, for the survey. */
  branchProtection?(repo: string, branch: string): Promise<BranchProtection | null>;
  /** A repository's label names, for the survey. */
  labels?(repo: string): Promise<string[]>;
}

/** "owner/repo#12" or "https://github.com/owner/repo/pull/12" → { repo, number }. */
export function parsePullRef(ref: string): { repo: string; number: number } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#|\/pull\/)(\d+)\/?$/u.exec(ref.trim());
  return m === null ? null : { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** The default writer: the server's gh token against the GitHub REST API. */
export function createGhWriter(token: TokenReader = createGhTokenReader(), doFetch: typeof fetch = fetch): GithubWriter {
  const request = async (method: string, path: string, body: unknown): Promise<Response> => {
    const value = await token();
    const response = await doFetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "bb-stewards",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GithubApiError(`${method} ${path} failed: ${response.status} ${detail.replace(/\s+/gu, " ").trim().slice(0, 500)}`);
    }
    return response;
  };
  return {
    async comment(repo, number, body) {
      const response = await request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
      const created = (await response.json().catch(() => null)) as { node_id?: unknown; id?: unknown } | null;
      const nodeId = created?.node_id ?? created?.id;
      if (nodeId === undefined || nodeId === null || String(nodeId) === "") throw new GithubApiError("GitHub created the comment but returned no id, so the approval marker cannot be recorded.");
      return String(nodeId);
    },
    async review(repo, number, event, body) {
      await request("POST", `/repos/${repo}/pulls/${number}/reviews`, { event, body });
    },
    async squashMerge(repo, number, title, body) {
      const response = await request("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: "squash", commit_title: title, commit_message: body });
      const merged = (await response.json().catch(() => null)) as { sha?: unknown } | null;
      const sha = merged?.sha;
      return { sha: typeof sha === "string" && sha !== "" ? sha : null };
    },
    async pullDetails(repo, number) {
      const response = await request("GET", `/repos/${repo}/pulls/${number}`, undefined);
      const body = (await response.json().catch(() => null)) as { title?: unknown; body?: unknown } | null;
      if (body === null || typeof body.title !== "string" || body.title.trim() === "") return null;
      return { title: body.title, body: typeof body.body === "string" ? body.body : "" };
    },
    async files(repo, number) {
      const response = await request("GET", `/repos/${repo}/pulls/${number}/files?per_page=100`, undefined);
      const body = (await response.json().catch(() => null)) as unknown;
      if (!Array.isArray(body)) return [];
      return body.map((f) => (f !== null && typeof f === "object" && "filename" in f ? String((f as { filename: unknown }).filename) : "")).filter((f) => f !== "");
    },
    async defaultBranch(repo) {
      const response = await request("GET", `/repos/${repo}`, undefined);
      const body = (await response.json().catch(() => null)) as { default_branch?: unknown } | null;
      return typeof body?.default_branch === "string" && body.default_branch !== "" ? body.default_branch : null;
    },
    async createPull(repo, args) {
      const response = await request("POST", `/repos/${repo}/pulls`, { head: args.head, base: args.base, title: args.title, body: args.body });
      const body = (await response.json().catch(() => null)) as { html_url?: unknown; number?: unknown } | null;
      if (typeof body?.html_url !== "string" || typeof body.number !== "number") throw new GithubApiError("GitHub created the pull request but returned no URL or number.");
      return { url: body.html_url, number: body.number };
    },
    async closePull(repo, number) {
      await request("PATCH", `/repos/${repo}/pulls/${number}`, { state: "closed" });
    },
    async fileContent(repo, path, ref) {
      try {
        const response = await request("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, undefined);
        const body = (await response.json().catch(() => null)) as { content?: unknown; encoding?: unknown } | null;
        if (body === null || typeof body.content !== "string") return null;
        return body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
      } catch (error) {
        if (error instanceof GithubApiError && / 404 /u.test(error.message)) return null;
        throw error;
      }
    },
    async tree(repo, ref) {
      const response = await request("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, undefined);
      const body = (await response.json().catch(() => null)) as { tree?: unknown } | null;
      if (body === null || !Array.isArray(body.tree)) return [];
      return body.tree.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const e = entry as { path?: unknown; type?: unknown };
        return typeof e.path === "string" && e.path !== "" ? [{ path: e.path, type: typeof e.type === "string" ? e.type : "blob" }] : [];
      });
    },
    async branchProtection(repo, branch) {
      // The branch endpoint works with plain read access and reports
      // `protected`; the protection endpoint needs admin, so a 404 there must
      // not be read as "unprotected".
      const branchResponse = await request("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`, undefined);
      const branchBody = (await branchResponse.json().catch(() => null)) as { protected?: unknown } | null;
      if (branchBody?.protected !== true) return null;
      try {
        const response = await request("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, undefined);
        const body = (await response.json().catch(() => null)) as { required_pull_request_reviews?: { required_approving_review_count?: unknown } | null; required_status_checks?: unknown } | null;
        const count = body?.required_pull_request_reviews?.required_approving_review_count;
        return {
          protected: true,
          requiredApprovingReviewCount: typeof count === "number" ? count : null,
          requiresStatusChecks: body?.required_status_checks !== null && body?.required_status_checks !== undefined,
        };
      } catch (error) {
        // Protected, but this token cannot read the rule's details: report the
        // fact we have and leave the details unknown rather than guessing.
        if (error instanceof GithubApiError && / 404 /u.test(error.message)) return { protected: true, requiredApprovingReviewCount: null, requiresStatusChecks: null };
        throw error;
      }
    },
    async labels(repo) {
      const names: string[] = [];
      // GitHub paginates labels; follow the `Link: rel="next"` header, capped.
      for (let page = 1; page <= 10; page += 1) {
        const response = await request("GET", `/repos/${repo}/labels?per_page=100&page=${page}`, undefined);
        const body = (await response.json().catch(() => null)) as unknown;
        if (!Array.isArray(body)) break;
        names.push(...body.flatMap((label) => (label !== null && typeof label === "object" && typeof (label as { name?: unknown }).name === "string" ? [(label as { name: string }).name] : [])));
        const link = response.headers.get("link") ?? "";
        if (body.length === 0 || !/rel="next"/u.test(link)) break;
      }
      return names.sort((a, b) => a.localeCompare(b));
    },
  };
}
