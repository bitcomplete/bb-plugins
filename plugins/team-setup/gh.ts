// gh on the server host. bb core turns the login gh holds here into GH_TOKEN,
// a credential helper and a commit identity on every machine, so signing gh
// in is the whole GitHub step. Nothing in this plugin reads the token.
import { execFile, spawn } from "node:child_process";

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GhProcess {
  /** Every line gh writes to stderr, which is where its prompts go. */
  onLine(listener: (line: string) => void): void;
  exited: Promise<GhResult>;
  kill(): void;
}

export interface GhRunner {
  run(args: string[], timeoutMs: number): Promise<GhResult>;
  start(args: string[]): GhProcess;
}

// --web is the device flow, the one login that needs no terminal: gh prints
// a code and a URL, then polls GitHub until the code is approved.
// --insecure-storage because the container has no keyring; the file lands
// in GH_CONFIG_DIR, on the data volume.
export const LOGIN_ARGS = [
  "auth",
  "login",
  "--hostname",
  "github.com",
  "--git-protocol",
  "https",
  "--web",
  "--insecure-storage",
];
export const LOGOUT_ARGS = ["auth", "logout", "--hostname", "github.com"];

export interface LoginPrompt {
  code: string;
  url: string;
}

const CODE_PATTERN = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/iu;
const URL_PATTERN = /(https:\/\/\S+)/u;
const LOGGED_IN_PATTERN = /logged in as\s+(\S+)/iu;

/** The device code and URL from gh's prompt, once both have been printed. */
export function parseLoginPrompt(lines: readonly string[]): LoginPrompt | null {
  let code: string | null = null;
  let url: string | null = null;
  for (const line of lines) {
    const c = CODE_PATTERN.exec(line);
    if (c !== null) code = c[1].toUpperCase();
    if (/open this url/iu.test(line)) {
      const u = URL_PATTERN.exec(line);
      if (u !== null) url = u[1];
    }
  }
  return code !== null && url !== null ? { code, url } : null;
}

/** The login gh reports after a successful sign-in, if it said. */
export function parseLoggedInAs(lines: readonly string[]): string | null {
  for (const line of lines) {
    const m = LOGGED_IN_PATTERN.exec(line);
    if (m !== null) return m[1];
  }
  return null;
}

// A token in the server's own environment makes gh refuse to log in ("GH_TOKEN
// is being used"), and would be what `gh auth token` reports afterwards. The
// child never sees one. Prompts and colour are off so the output is parseable.
function ghEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  return env;
}

export function createGhRunner(): GhRunner {
  return {
    run(args, timeoutMs) {
      return new Promise((resolve) => {
        execFile(
          "gh",
          args,
          { env: ghEnvironment(), timeout: timeoutMs, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
            resolve({ exitCode: code, stdout: String(stdout), stderr: error !== null && stderr === "" ? error.message : String(stderr) });
          },
        );
      });
    },
    start(args) {
      const child = spawn("gh", args, { env: ghEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      const listeners: Array<(line: string) => void> = [];
      let stdout = "";
      let stderr = "";
      let partial = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) for (const l of listeners) l(line);
      });
      const exited = new Promise<GhResult>((resolve) => {
        child.on("error", (error) => {
          stderr += error.message;
          resolve({ exitCode: 1, stdout, stderr });
        });
        child.on("close", (code) => {
          if (partial !== "") for (const l of listeners) l(partial);
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      });
      return {
        onLine: (listener) => {
          listeners.push(listener);
        },
        exited,
        kill: () => {
          child.kill("SIGTERM");
        },
      };
    },
  };
}
