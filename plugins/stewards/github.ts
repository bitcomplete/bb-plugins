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

export interface GithubWriter {
  /**
   * Post a comment as the connected user and return GitHub's node id for it.
   * The id ties the plugin's own approval record to the marker it posted, so a
   * hand-typed lookalike never satisfies the lane gate.
   */
  comment(repo: string, number: number, body: string): Promise<string>;
  /** Squash-merge the pull request, with the given commit title and message. */
  squashMerge(repo: string, number: number, title: string, body: string): Promise<void>;
  /**
   * The repo-relative paths a pull request changes, for the decide list. When
   * absent, or when the read fails, the plugin cannot classify the pull
   * request and treats it as the user's (fail closed).
   */
  files?(repo: string, number: number): Promise<string[]>;
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
    async squashMerge(repo, number, title, body) {
      await request("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: "squash", commit_title: title, commit_message: body });
    },
    async files(repo, number) {
      const response = await request("GET", `/repos/${repo}/pulls/${number}/files?per_page=100`, undefined);
      const body = (await response.json().catch(() => null)) as unknown;
      if (!Array.isArray(body)) return [];
      return body.map((f) => (f !== null && typeof f === "object" && "filename" in f ? String((f as { filename: unknown }).filename) : "")).filter((f) => f !== "");
    },
  };
}
