import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  createFigmaHostEntry,
  parseAuthorizationUrl,
  parseMcpGet,
  resolveClaude,
  validateCallbackUrl,
  type FigmaProcess,
  type FigmaResult,
  type FigmaRunner,
} from "./figma.js";

const STATE = "RV47MxJKqLavoHiTPom0DFEjLhquGV9fRHQnvWiCLVU";
const AUTH_URL = `https://www.figma.com/oauth/mcp?response_type=code&client_id=Y4y9cmA3GQ3XPOqfpEAGcp&code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A53280%2Fcallback&state=${STATE}&scope=mcp%3Aconnect&resource=https%3A%2F%2Fmcp.figma.com%2Fmcp`;

describe("parseAuthorizationUrl", () => {
  it("reads the URL, callback port and state claude prints", () => {
    expect(parseAuthorizationUrl(["Visit this URL to authorize:", `  ${AUTH_URL}`])).toEqual({ url: AUTH_URL, port: 53280, state: STATE });
  });

  it("sees through the OSC 8 hyperlink wrapper", () => {
    expect(parseAuthorizationUrl([`\u001b]8;;${AUTH_URL}\u0007${AUTH_URL}\u001b]8;;\u0007`])).toEqual({ url: AUTH_URL, port: 53280, state: STATE });
  });

  it("ignores URLs that are not this sign-in", () => {
    expect(parseAuthorizationUrl(["see https://cli.figma.com/help"])).toBeNull();
    expect(parseAuthorizationUrl([])).toBeNull();
  });
});

describe("validateCallbackUrl", () => {
  const good = `http://localhost:53280/callback?code=one-time&state=${STATE}`;

  it("accepts the dead localhost callback the browser lands on", () => {
    expect(validateCallbackUrl(good, 53280, STATE)).toEqual({ ok: true, search: `?code=one-time&state=${STATE}` });
    expect(validateCallbackUrl(good.replace("localhost", "127.0.0.1"), 53280, STATE).ok).toBe(true);
  });

  it("rejects a URL that is not a URL", () => {
    expect(validateCallbackUrl("not a url", 53280, STATE)).toMatchObject({ ok: false });
  });

  it("rejects the wrong port", () => {
    expect(validateCallbackUrl(good.replace("53280", "53281"), 53280, STATE)).toMatchObject({ ok: false, message: expect.stringContaining("port") });
  });

  it("rejects a host that is not localhost", () => {
    expect(validateCallbackUrl(good.replace("localhost", "example.com"), 53280, STATE)).toMatchObject({ ok: false, message: expect.stringContaining("localhost") });
  });

  it("rejects a missing code and a mismatched state", () => {
    expect(validateCallbackUrl(`http://localhost:53280/callback?state=${STATE}`, 53280, STATE)).toMatchObject({ ok: false, message: expect.stringContaining("code") });
    expect(validateCallbackUrl(good.replace(STATE, "other"), 53280, STATE)).toMatchObject({ ok: false, message: expect.stringContaining("different sign-in") });
  });
});

describe("parseMcpGet", () => {
  it("reads a signed-in server", () => {
    expect(parseMcpGet("figma:\n  Scope: User config\n  Status: ✓ Connected\n")).toEqual({ configured: true, authenticated: true });
  });

  it("reads a server that needs authentication, and one that is not configured", () => {
    expect(parseMcpGet("figma:\n  Status: ! Needs authentication\n")).toEqual({ configured: true, authenticated: false });
    expect(parseMcpGet('No MCP server named "figma". Configured servers: none')).toEqual({ configured: false, authenticated: false });
  });
});

interface FakeHandle {
  emit(chunk: string): void;
  resolve(result: Partial<FigmaResult>): void;
  killed: boolean;
}

interface Fake {
  runner: FigmaRunner;
  runs: Array<{ args: string[]; timeoutMs: number }>;
  started: FakeHandle[];
}

function fakeRunner(get: Partial<FigmaResult> = {}, add: Partial<FigmaResult> = {}): Fake {
  const runs: Fake["runs"] = [];
  const started: FakeHandle[] = [];
  const runner: FigmaRunner = {
    run: vi.fn(async (args: string[], timeoutMs: number) => {
      runs.push({ args, timeoutMs });
      if (args[0] === "mcp" && args[1] === "get") return { exitCode: 0, stdout: "", stderr: "", missing: false, ...get };
      if (args[0] === "mcp" && args[1] === "add") return { exitCode: 0, stdout: "MCP server figma added", stderr: "", missing: false, ...add };
      return { exitCode: 0, stdout: "", stderr: "", missing: false };
    }),
    startLogin: vi.fn((): FigmaProcess => {
      const listeners: Array<(chunk: string) => void> = [];
      let resolveExit!: (result: FigmaResult) => void;
      const exited = new Promise<FigmaResult>((resolve) => {
        resolveExit = resolve;
      });
      const handle: FakeHandle = {
        emit: (chunk) => listeners.forEach((listener) => listener(chunk)),
        resolve: (result) => resolveExit({ exitCode: 0, stdout: "", stderr: "", missing: false, ...result }),
        killed: false,
      };
      started.push(handle);
      return {
        onOutput: (listener) => listeners.push(listener),
        exited,
        kill: () => {
          handle.killed = true;
          handle.resolve({ exitCode: 1, stderr: "killed" });
        },
      };
    }),
  };
  return { runner, runs, started };
}

function createHarness(fake: Fake, fetchImpl: typeof fetch) {
  return experimental_createHostEntryHarness(
    createFigmaHostEntry({ runner: fake.runner, fetch: fetchImpl, startTimeoutMs: 200, completeTimeoutMs: 200, getTimeoutMs: 200, addTimeoutMs: 200 }),
  );
}

/** Start a sign-in and feed it the authorization URL the CLI prints. */
async function startSignIn(fake: Fake, host: ReturnType<typeof createHarness>) {
  const started = host.experimental_call("start", null);
  await vi.waitFor(() => expect(fake.started).toHaveLength(1));
  fake.started[0].emit(`Visit this URL to authorize:\n  ${AUTH_URL}\n`);
  return started;
}

describe("the Figma host entry", () => {
  it("reports claude missing", async () => {
    const fake = fakeRunner({ missing: true, exitCode: 127 });
    const host = createHarness(fake, vi.fn());
    expect(await host.experimental_call("state", null)).toEqual({ claude: false, configured: false, authenticated: false, pending: false, url: null, message: "claude is not installed on this machine." });
    await host.experimental_dispose();
  });

  it("reads the signed-in state from claude mcp get", async () => {
    const fake = fakeRunner({ stdout: "figma:\n  Scope: User config\n  Status: ✓ Connected\n" });
    const host = createHarness(fake, vi.fn());
    expect(await host.experimental_call("state", null)).toMatchObject({ claude: true, configured: true, authenticated: true, pending: false });
    expect(fake.runs[0].args).toEqual(["mcp", "get", "figma"]);
    await host.experimental_dispose();
  });

  it("treats 'No MCP server named' on stderr as not configured, without a warning", async () => {
    const fake = fakeRunner({ exitCode: 1, stderr: 'No MCP server named "figma". Run `claude mcp add` to add one.' });
    const host = createHarness(fake, vi.fn());
    expect(await host.experimental_call("state", null)).toMatchObject({ configured: false, authenticated: false, message: null });
    await host.experimental_dispose();
  });

  it("starts the sign-in, holds the worker, and is idempotent", async () => {
    const fake = fakeRunner();
    const host = createHarness(fake, vi.fn());
    expect(await startSignIn(fake, host)).toEqual({ url: AUTH_URL, port: 53280 });
    expect(fake.runs.find((run) => run.args[1] === "add")?.args).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "--callback-port", "53280", "figma", "https://mcp.figma.com/mcp"]);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    expect(await host.experimental_call("start", null)).toEqual({ url: AUTH_URL, port: 53280 });
    expect(fake.started).toHaveLength(1);
    expect(await host.experimental_call("state", null)).toMatchObject({ pending: true, url: AUTH_URL });
    await host.experimental_dispose();
  });

  it("reuses an existing Figma server instead of re-adding it", async () => {
    const fake = fakeRunner({ stdout: "figma:\n  Scope: User config\n  Status: ! Needs authentication\n  URL: https://mcp.figma.com/mcp\n" });
    const host = createHarness(fake, vi.fn());
    await startSignIn(fake, host);
    expect(fake.runs.some((run) => run.args[1] === "add")).toBe(false);
    expect(fake.runs.some((run) => run.args[1] === "remove")).toBe(false);
    await host.experimental_dispose();
  });

  it("replaces a figma server configured at another URL", async () => {
    const fake = fakeRunner({ stdout: "figma:\n  Scope: User config\n  Status: ! Needs authentication\n  URL: https://example.com/mcp\n" });
    const host = createHarness(fake, vi.fn());
    await startSignIn(fake, host);
    expect(fake.runs.find((run) => run.args[1] === "remove")?.args).toEqual(["mcp", "remove", "figma", "-s", "user"]);
    expect(fake.runs.some((run) => run.args[1] === "add")).toBe(true);
    await host.experimental_dispose();
  });

  it("tolerates an add that reports the server already exists", async () => {
    const fake = fakeRunner({}, { exitCode: 1, stderr: "MCP server figma already exists in user config" });
    const host = createHarness(fake, vi.fn());
    expect(await startSignIn(fake, host)).toEqual({ url: AUTH_URL, port: 53280 });
    await host.experimental_dispose();
  });

  it("rejects a start whose login exits before printing a URL", async () => {
    const fake = fakeRunner();
    const host = createHarness(fake, vi.fn());
    const started = host.experimental_call("start", null);
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    fake.started[0].resolve({ exitCode: 1, stderr: "no TTY" });
    await expect(started).rejects.toThrow(/no TTY/u);
    await host.experimental_dispose();
  });

  it("validates the pasted URL, replays it, and waits for the login to finish", async () => {
    const fake = fakeRunner();
    const fetchImpl = vi.fn(async () => {
      fake.started[0].resolve({ exitCode: 0, stdout: "Authenticated with figma" });
      return new Response("ok");
    });
    const host = createHarness(fake, fetchImpl as unknown as typeof fetch);
    await startSignIn(fake, host);
    expect(await host.experimental_call("complete", { url: `http://localhost:53280/callback?code=one-time&state=${STATE}` })).toEqual({ ok: true, message: null });
    expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:53280/callback?code=one-time&state=${STATE}`);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await host.experimental_dispose();
  });

  it("rejects a wrong-port URL without replaying anything", async () => {
    const fake = fakeRunner();
    const fetchImpl = vi.fn();
    const host = createHarness(fake, fetchImpl as unknown as typeof fetch);
    await startSignIn(fake, host);
    expect(await host.experimental_call("complete", { url: `http://localhost:53281/callback?code=one-time&state=${STATE}` })).toMatchObject({ ok: false, message: expect.stringContaining("port") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
  });

  it("reports the login's own failure", async () => {
    const fake = fakeRunner();
    const fetchImpl = vi.fn(async () => {
      fake.started[0].resolve({ exitCode: 1, stderr: "Issuer mismatch in authorization response" });
      return new Response("ok");
    });
    const host = createHarness(fake, fetchImpl as unknown as typeof fetch);
    await startSignIn(fake, host);
    expect(await host.experimental_call("complete", { url: `http://localhost:53280/callback?code=one-time&state=${STATE}` })).toMatchObject({ ok: false, message: expect.stringContaining("Issuer mismatch") });
    await host.experimental_dispose();
  });

  it("completes with no sign-in in progress", async () => {
    const fake = fakeRunner();
    const host = createHarness(fake, vi.fn());
    expect(await host.experimental_call("complete", { url: `http://localhost:53280/callback?code=x&state=${STATE}` })).toMatchObject({ ok: false, message: expect.stringContaining("No Figma sign-in") });
    await host.experimental_dispose();
  });

  it("cancels a waiting sign-in and releases the worker", async () => {
    const fake = fakeRunner();
    const host = createHarness(fake, vi.fn());
    await startSignIn(fake, host);
    expect(await host.experimental_call("cancel", null)).toEqual({ ok: true });
    expect(fake.started[0].killed).toBe(true);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await host.experimental_dispose();
  });
});

describe("resolveClaude", () => {
  it("finds claude on PATH and returns null when it is nowhere", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-claude-"));
    const file = join(dir, "claude");
    try {
      await writeFile(file, "#!/bin/sh\n", { mode: 0o755 });
      expect(resolveClaude({ PATH: dir }, "/home/nobody")).toBe(file);
      expect(resolveClaude({ PATH: "/nonexistent-bin" }, "/home/nobody")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
