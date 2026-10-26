// The Figma step's machine side: everything that touches `claude`, its
// `~/.claude.json`, and its OAuth listener. It runs in the host worker on the
// developer's machine, never on the bb server.
//
// Figma's remote MCP server takes browser OAuth only. Claude Code opens a
// loopback listener on a pinned port and prints an authorization URL; the
// browser lands on a dead `http://localhost:<port>/callback?code=...` page,
// and the developer pastes that URL back here. This entry replays it against
// the listener. Only the one-time code passes through the plugin; the PKCE
// verifier stays inside Claude Code, and the token lands in Claude Code's own
// credential store.
//
// `claude mcp login` refuses to run unless stdin is a terminal (it offers the
// paste-the-redirect-URL prompt), so the login is started under `script`,
// which gives it a pseudo-terminal. Its stdin pipe is held open for the
// login's lifetime so the prompt is not closed early.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { experimental_defineHostEntry, experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { FIGMA_CALLBACK_PORT, FIGMA_SERVER_NAME, FIGMA_SERVER_URL, figmaHostContract } from "./figma-contract.js";

export interface FigmaResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** `claude` was not found; the command never ran. */
  missing: boolean;
}

export interface FigmaProcess {
  /** Every chunk the process writes to stdout or stderr, as it arrives. */
  onOutput(listener: (chunk: string) => void): void;
  exited: Promise<FigmaResult>;
  kill(): void;
}

export interface FigmaRunner {
  /** Run `claude` and collect its output. */
  run(args: string[], timeoutMs: number): Promise<FigmaResult>;
  /** Start `claude mcp login` under a pseudo-terminal, its stdin left open. */
  startLogin(): FigmaProcess;
}

export interface FigmaHostDeps {
  runner: FigmaRunner;
  fetch: typeof fetch;
  /** How long a pending sign-in may wait for the callback before it is killed. */
  ttlMs?: number;
  startTimeoutMs?: number;
  completeTimeoutMs?: number;
  getTimeoutMs?: number;
  addTimeoutMs?: number;
}

export interface FigmaAuthorization {
  url: string;
  port: number;
  state: string;
}

export type CallbackCheck = { ok: true; search: string } | { ok: false; message: string };

// The authorization URL is printed wrapped in an OSC 8 hyperlink and again
// plain; either copy parses. Control characters end a match so the escape
// sequence around it is not swallowed.
const URL_PATTERN = /https?:\/\/[^\s\u0000-\u001f"'<>]+/u;

/** The authorization URL, callback port and state from `claude mcp login`'s output, if present. */
export function parseAuthorizationUrl(lines: readonly string[]): FigmaAuthorization | null {
  for (const line of lines) {
    const match = URL_PATTERN.exec(line);
    if (match === null) continue;
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (redirect === null || state === null || state === "") continue;
    let callback: URL;
    try {
      callback = new URL(redirect);
    } catch {
      continue;
    }
    if (callback.pathname !== "/callback") continue;
    const port = callback.port === "" ? (callback.protocol === "https:" ? 443 : 80) : Number(callback.port);
    if (!Number.isInteger(port) || port <= 0) continue;
    return { url: match[0], port, state };
  }
  return null;
}

const CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Validate the dead callback URL the developer pasted against the sign-in that is waiting. */
export function validateCallbackUrl(pasted: string, port: number, state: string): CallbackCheck {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return { ok: false, message: "That is not a URL. Paste the whole address from the browser's address bar." };
  }
  if (url.protocol !== "http:") return { ok: false, message: "The callback URL must start with http://." };
  if (!CALLBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, message: "The callback URL must point at localhost, where Claude Code is listening." };
  }
  const actualPort = url.port === "" ? "80" : url.port;
  if (actualPort !== String(port)) {
    return { ok: false, message: `The callback URL's port is ${actualPort}, but this sign-in is listening on ${port}.` };
  }
  if (url.pathname !== "/callback") return { ok: false, message: "The callback URL must be the /callback address." };
  const code = url.searchParams.get("code");
  if (code === null || code === "") return { ok: false, message: "The callback URL has no code in it." };
  const returnedState = url.searchParams.get("state");
  if (returnedState !== state) {
    return { ok: false, message: "That callback URL belongs to a different sign-in. Start again." };
  }
  return { ok: true, search: url.search };
}

/** Whether `claude mcp get figma` reports the server configured and signed in. */
export function parseMcpGet(stdout: string): { configured: boolean; authenticated: boolean } {
  if (/No MCP server named/iu.test(stdout)) return { configured: false, authenticated: false };
  const status = /^[ \t]*Status:\s*(.+)$/mu.exec(stdout)?.[1]?.trim() ?? "";
  if (status === "") return { configured: false, authenticated: false };
  // A server with no stored credentials reports "Needs authentication"
  // without connecting. Anything else — connected, or a connection error —
  // means Claude Code holds a credential for it.
  const authenticated = !/Needs authentication/iu.test(status) && !/Not configured/iu.test(status);
  return { configured: true, authenticated };
}

function tail(text: string, lines = 3): string {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join(" ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Find the `claude` the provider would run, on PATH first and then where it installs. */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  for (const candidate of [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function claudeEnvironment(): NodeJS.ProcessEnv {
  const env = experimental_sanitizeInheritedChildProcessEnv({ env: process.env });
  env.TERM = "xterm-256color";
  env.NO_COLOR = "1";
  return env;
}

function collect(child: ChildProcess): FigmaProcess {
  const listeners: Array<(chunk: string) => void> = [];
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    for (const listener of listeners) listener(chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    for (const listener of listeners) listener(chunk);
  });
  const exited = new Promise<FigmaResult>((resolve) => {
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ exitCode: 1, stdout, stderr, missing: false });
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr, missing: false }));
  });
  return { onOutput: (listener) => listeners.push(listener), exited, kill: () => child.kill("SIGTERM") };
}

export function createFigmaRunner(): FigmaRunner {
  return {
    run(args, timeoutMs) {
      const command = resolveClaude();
      if (command === null) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "claude: not found", missing: true });
      return new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: claudeEnvironment(), windowsHide: true },
          (error, stdout, stderr) => {
            const failure = error as (Omit<NodeJS.ErrnoException, "code"> & { code?: string | number; killed?: boolean }) | null;
            if (failure?.code === "ENOENT") return resolve({ exitCode: 127, stdout: "", stderr: "claude: not found", missing: true });
            const exitCode = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
            resolve({
              exitCode,
              stdout: String(stdout),
              stderr: failure !== null && failure.killed ? `claude did not finish in ${timeoutMs / 1000}s` : String(stderr),
              missing: false,
            });
          },
        );
      });
    },
    startLogin() {
      const command = resolveClaude();
      if (command === null) throw new Error("claude is not installed on this machine.");
      // util-linux `script -qec <command> /dev/null`; the BSD/macOS form passes
      // the command as arguments after the typescript file.
      const args =
        process.platform === "darwin"
          ? ["-q", "/dev/null", command, "mcp", "login", "--no-browser", FIGMA_SERVER_NAME]
          : ["-qec", `${shellQuote(command)} mcp login --no-browser ${FIGMA_SERVER_NAME}`, "/dev/null"];
      const child = spawn("script", args, { env: claudeEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      // The stdin pipe is deliberately never ended: ending it closes the PTY,
      // which makes Claude Code abort the sign-in.
      return collect(child);
    },
  };
}

function waitForAuthorization(process: FigmaProcess, timeoutMs: number): Promise<FigmaAuthorization> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.kill();
      reject(new Error("claude printed no authorization URL; is Claude Code up to date?"));
    }, timeoutMs);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    process.onOutput((chunk) => {
      if (settled) return;
      buffer += chunk;
      const parsed = parseAuthorizationUrl(buffer.split(/\r?\n/u));
      if (parsed !== null) finish(() => resolve(parsed));
    });
    void process.exited.then((result) => {
      finish(() => reject(new Error(tail(result.stderr || result.stdout) || `claude mcp login exited with ${result.exitCode}`)));
    });
  });
}

function waitForExit(promise: Promise<FigmaResult>, timeoutMs: number): Promise<FigmaResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

interface Pending {
  process: FigmaProcess;
  url: string;
  port: number;
  state: string;
  lease: { dispose(): void };
  timer: ReturnType<typeof setTimeout>;
}

export function createFigmaHostEntry(deps: FigmaHostDeps) {
  const ttlMs = deps.ttlMs ?? 15 * 60 * 1000;
  const startTimeoutMs = deps.startTimeoutMs ?? 20_000;
  const completeTimeoutMs = deps.completeTimeoutMs ?? 30_000;
  const getTimeoutMs = deps.getTimeoutMs ?? 10_000;
  const addTimeoutMs = deps.addTimeoutMs ?? 20_000;
  let pending: Pending | null = null;

  function clearPending(kill: boolean): void {
    if (pending === null) return;
    const entry = pending;
    pending = null;
    clearTimeout(entry.timer);
    if (kill) entry.process.kill();
    entry.lease.dispose();
  }

  return experimental_defineHostEntry({
    contract: figmaHostContract,
    handlers: {
      async state() {
        if (pending !== null) {
          return { claude: true, configured: true, authenticated: false, pending: true, url: pending.url, message: null };
        }
        const result = await deps.runner.run(["mcp", "get", FIGMA_SERVER_NAME], getTimeoutMs);
        if (result.missing) return { claude: false, configured: false, authenticated: false, pending: false, url: null, message: "claude is not installed on this machine." };
        // `mcp get` puts "No MCP server named …" on stderr when no servers are
        // configured at all, and on stdout when others are; parse both.
        const parsed = parseMcpGet(`${result.stdout}\n${result.stderr}`);
        return { claude: true, ...parsed, pending: false, url: null, message: parsed.configured && result.exitCode !== 0 ? tail(result.stderr) || null : null };
      },

      async start(_input, context) {
        if (pending !== null) return { url: pending.url, port: pending.port };
        const added = await deps.runner.run(
          ["mcp", "add", "--transport", "http", "--scope", "user", "--callback-port", String(FIGMA_CALLBACK_PORT), FIGMA_SERVER_NAME, FIGMA_SERVER_URL],
          addTimeoutMs,
        );
        if (added.missing) throw new Error("claude is not installed on this machine.");
        if (added.exitCode !== 0) throw new Error(tail(added.stderr) || `claude mcp add exited with ${added.exitCode}`);
        const process = deps.runner.startLogin();
        const authorization = await waitForAuthorization(process, startTimeoutMs);
        const entry: Pending = {
          process,
          url: authorization.url,
          port: authorization.port,
          state: authorization.state,
          lease: context.experimental_retainWorker(),
          timer: setTimeout(() => clearPending(true), ttlMs),
        };
        pending = entry;
        void process.exited.then(() => {
          if (pending === entry) clearPending(false);
        });
        return { url: authorization.url, port: authorization.port };
      },

      async complete({ url }) {
        if (pending === null) return { ok: false, message: "No Figma sign-in is in progress. Start it again." };
        const entry = pending;
        const checked = validateCallbackUrl(url, entry.port, entry.state);
        if (!checked.ok) return { ok: false, message: checked.message };
        try {
          const response = await deps.fetch(`http://127.0.0.1:${entry.port}/callback${checked.search}`);
          await response.text();
        } catch (error) {
          return { ok: false, message: `Could not reach the sign-in listener on this machine: ${errorMessage(error)}` };
        }
        const result = await waitForExit(entry.process.exited, completeTimeoutMs);
        if (pending === entry) clearPending(false);
        if (result === null) return { ok: false, message: "The sign-in did not finish in time. Start it again." };
        if (result.exitCode === 0) return { ok: true, message: null };
        return { ok: false, message: tail(result.stderr || result.stdout) || `claude mcp login exited with ${result.exitCode}` };
      },

      async cancel() {
        clearPending(true);
        return { ok: true };
      },
    },
    dispose() {
      clearPending(true);
    },
  });
}
