// The developer's GitHub token, from the gh login on this server host. Team
// setup signs gh in here (and bb core forwards that login to every machine),
// so the token already exists and the plugin never stores one of its own.
// `gh auth token` prints it; nothing else of gh is used.
import { execFile } from "node:child_process";

export const TOKEN_TIMEOUT_MS = 15_000;

export class NotSignedInError extends Error {
  constructor(detail: string) {
    super(`GitHub is not signed in on this bb server${detail === "" ? "" : ` (${detail})`}. Sign in from the GitHub row of the Team setup checklist on the home page.`);
    this.name = "NotSignedInError";
  }
}

/** Reads the token gh holds for github.com. Throws NotSignedInError when there is none. */
export type TokenReader = (signal?: AbortSignal) => Promise<string>;

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
