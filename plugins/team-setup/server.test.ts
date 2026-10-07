import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { GhProcess, GhResult, GhRunner } from "./gh.js";
import { ACCOUNT_POOL_ID, CHANGED, createTeamSetupPlugin, DEVBOX_ID, LINEAR_ID, LOGIN_TTL_MS } from "./server.js";

// A gh whose `auth login` the test drives: print lines, then exit.
function fakeGh(runs: Record<string, GhResult> = {}) {
  const started: Array<{ args: string[]; emit: (line: string) => void; exit: (result: Partial<GhResult>) => void; killed: boolean }> = [];
  const runner: GhRunner = {
    run: vi.fn(async (args: string[]) => runs[args.join(" ")] ?? { exitCode: 1, stdout: "", stderr: "not stubbed: gh " + args.join(" ") }),
    start: vi.fn((args: string[]): GhProcess => {
      const listeners: Array<(line: string) => void> = [];
      let resolveExit!: (r: GhResult) => void;
      const exited = new Promise<GhResult>((resolve) => {
        resolveExit = resolve;
      });
      const entry = {
        args,
        emit: (line: string) => listeners.forEach((l) => l(line)),
        exit: (result: Partial<GhResult>) => resolveExit({ exitCode: 0, stdout: "", stderr: "", ...result }),
        killed: false,
      };
      started.push(entry);
      return {
        onLine: (l) => {
          listeners.push(l);
        },
        exited,
        kill: () => {
          entry.killed = true;
          entry.exit({ exitCode: 1, stderr: "killed" });
        },
      };
    }),
  };
  return { runner, started };
}

const PROMPT = ["! First copy your one-time code: AB12-CD34", "Open this URL to continue in your web browser: https://github.com/login/device"];

interface World {
  plugins?: Array<{ id: string; enabled: boolean }>;
  builtInGit?: { status: string; statusMessage: string };
  pool?: unknown;
  devbox?: unknown;
  linear?: unknown;
  hosts?: Array<{ name: string }>;
  runs?: Record<string, GhResult>;
  settings?: Record<string, string>;
}

async function setup(world: World = {}) {
  const gh = fakeGh(world.runs);
  const { bb, harness } = createFakePluginHost({ pluginId: "team-setup", settings: world.settings ?? {} });
  harness.sdk.stub("plugins.list", async () => ({
    plugins: (world.plugins ?? [{ id: ACCOUNT_POOL_ID, enabled: true }, { id: DEVBOX_ID, enabled: true }, { id: LINEAR_ID, enabled: true }]).map((p) => ({ ...p, name: p.id })),
  }));
  harness.sdk.stub("system.machineEnvironment", async () => ({
    builtInGit: world.builtInGit ?? { status: "not logged in", statusMessage: "gh is not logged in on the server" },
    variables: [],
  }));
  harness.sdk.stub("hosts.list", async () => world.hosts ?? []);
  const rpcCalls: Array<{ pluginId: string; method: string; input: unknown }> = [];
  harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: unknown; outputSchema: { parse: (v: unknown) => unknown } }) => {
    rpcCalls.push({ pluginId: args.pluginId, method: args.method, input: args.input });
    const key = `${args.pluginId}:${args.method}`;
    const answers: Record<string, unknown> = {
      [`${ACCOUNT_POOL_ID}:status.get`]: world.pool ?? { routing: { claude: true, codex: true }, accounts: [] },
      [`${ACCOUNT_POOL_ID}:login.start`]: { sessionId: "00000000-0000-4000-8000-000000000001", authorizeUrl: "https://claude.ai/oauth/authorize?x" },
      [`${ACCOUNT_POOL_ID}:login.complete`]: { label: "me@example.com", provider: "claude" },
      [`${ACCOUNT_POOL_ID}:codexLogin.start`]: {
        sessionId: "00000000-0000-4000-8000-000000000002",
        verificationUri: "https://auth.openai.com/device",
        userCode: "WXYZ-1234",
        expiresAt: 1_700_000_000_000,
        intervalMs: 5000,
      },
      [`${ACCOUNT_POOL_ID}:codexLogin.poll`]: { status: "complete", account: { label: "codex@example.com" } },
      [`${ACCOUNT_POOL_ID}:codexLogin.cancel`]: { cancelled: true },
      [`${DEVBOX_ID}:status`]: world.devbox ?? { connected: false, project: null },
      [`${DEVBOX_ID}:connect`]: { url: "https://devbox.example/connect/authorize?state=s" },
      [`${LINEAR_ID}:status`]: world.linear ?? { connected: false, configured: true, user: null, organization: null },
      [`${LINEAR_ID}:connect`]: { url: "https://linear.example/oauth/authorize?state=s" },
    };
    if (!(key in answers)) throw new Error(`no answer for ${key}`);
    return args.outputSchema.parse(answers[key]);
  });
  let now = 1_000_000;
  await createTeamSetupPlugin({ gh: gh.runner, now: () => now })(bb);
  const status = async () => (await harness.callRpc("status", null)) as Awaited<ReturnType<typeof statusType>>;
  return { bb, harness, gh, rpcCalls, status, advance: (ms: number) => (now += ms) };
}
// Only for the inferred return type above.
declare function statusType(): Promise<{
  ai: { available: boolean; message: string | null; accounts: Array<{ label: string }> };
  github: { status: string; login: string | null; orgMember: boolean | null; pending: { code: string; url: string } | null; lastError: string | null };
  devbox: { available: boolean; connected: boolean; project: string | null; message: string | null };
  linear: { available: boolean; connected: boolean; configured: boolean; user: string | null; organization: string | null; message: string | null };
  machines: { names: string[] };
  steps: { ai: string; github: string; devbox: string; linear: string; machine: string };
  complete: boolean;
}>;

const signedIn = {
  "api --hostname github.com user --jq .login": { exitCode: 0, stdout: "octocat\n", stderr: "" },
  "api --hostname github.com user/memberships/orgs/bitcomplete --jq .state": { exitCode: 0, stdout: "active\n", stderr: "" },
};

describe("status", () => {
  it("starts with everything to do", async () => {
    const { status } = await setup();
    const s = await status();
    expect(s.steps).toEqual({ ai: "todo", github: "todo", devbox: "todo", linear: "todo", machine: "todo" });
    expect(s.complete).toBe(false);
    expect(s.github.login).toBeNull();
  });

  it("is complete when every step is done", async () => {
    const { status, gh } = await setup({
      builtInGit: { status: "logged in", statusMessage: "ok" },
      pool: { routing: { claude: true, codex: false }, accounts: [{ id: "a", provider: "claude", label: "me", enabled: true, status: "ready" }] },
      devbox: { connected: true, project: "dylan" },
      linear: { connected: true, configured: true, user: { id: "u1", name: "jane", email: null }, organization: { name: "Acme", urlKey: "acme" } },
      hosts: [{ name: "box" }],
      runs: signedIn,
    });
    const s = await status();
    expect(s.steps).toEqual({ ai: "done", github: "done", devbox: "done", linear: "done", machine: "done" });
    expect(s.complete).toBe(true);
    expect(s.linear).toMatchObject({ connected: true, user: "jane", organization: "Acme" });
    expect(s.github.login).toBe("octocat");
    expect(s.github.orgMember).toBe(true);
    // Identity is cached between status calls.
    await status();
    expect(gh.runner.run).toHaveBeenCalledTimes(2);
  });

  it("does not count an account whose provider routing is off", async () => {
    const { status } = await setup({
      pool: { routing: { claude: false, codex: true }, accounts: [{ id: "a", provider: "claude", label: "me", enabled: true, status: "ready" }] },
    });
    expect((await status()).steps.ai).toBe("todo");
  });

  it("marks a step unavailable when its plugin is off, and that does not block completion", async () => {
    const { status } = await setup({
      plugins: [{ id: ACCOUNT_POOL_ID, enabled: true }, { id: DEVBOX_ID, enabled: false }],
      builtInGit: { status: "overridden", statusMessage: "" },
      pool: { routing: { claude: true, codex: true }, accounts: [{ id: "a", provider: "codex", label: "me", enabled: true, status: "ready" }] },
      hosts: [{ name: "laptop" }],
    });
    const s = await status();
    expect(s.devbox.available).toBe(false);
    expect(s.devbox.message).toContain("turned off");
    expect(s.steps).toEqual({ ai: "done", github: "done", devbox: "unavailable", linear: "unavailable", machine: "done" });
    expect(s.complete).toBe(true);
  });

  it("does not ask the developer to connect Linear while the server has no OAuth client ID", async () => {
    const { status } = await setup({ linear: { connected: false, configured: false, user: null, organization: null } });
    const s = await status();
    expect(s.steps.linear).toBe("unavailable");
    expect(s.linear).toMatchObject({ available: true, configured: false });
  });

  it("warns about an account outside the organization", async () => {
    const { status } = await setup({
      builtInGit: { status: "logged in", statusMessage: "ok" },
      runs: { ...signedIn, "api --hostname github.com user/memberships/orgs/bitcomplete --jq .state": { exitCode: 1, stdout: "", stderr: "404" } },
    });
    expect((await status()).github.orgMember).toBe(false);
  });

  it("skips the organization check when the setting is empty", async () => {
    const { status, gh } = await setup({ builtInGit: { status: "logged in", statusMessage: "ok" }, runs: signedIn, settings: { githubOrg: "" } });
    expect((await status()).github.orgMember).toBeNull();
    expect(gh.runner.run).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub sign-in", () => {
  it("starts gh headless and hands back the code it prints", async () => {
    const { harness, gh, status } = await setup();
    const pending = harness.callRpc("githubSignIn", null);
    await vi.waitFor(() => expect(gh.started).toHaveLength(1));
    expect(gh.started[0].args).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"]);
    for (const line of PROMPT) gh.started[0].emit(line);
    expect(await pending).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device", expiresAt: 1_000_000 + LOGIN_TTL_MS });
    expect((await status()).github.pending).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device", expiresAt: 1_000_000 + LOGIN_TTL_MS });

    // A second click returns the same code rather than a second gh.
    expect(await harness.callRpc("githubSignIn", null)).toMatchObject({ code: "AB12-CD34" });
    expect(gh.started).toHaveLength(1);

    gh.started[0].emit("✓ Logged in as octocat");
    gh.started[0].exit({ exitCode: 0 });
    await vi.waitFor(() => expect(harness.realtimeSignals.map((s) => s.channel)).toContain(CHANGED));
    const s = await status();
    expect(s.github.pending).toBeNull();
    expect(s.github.lastError).toBeNull();
  });

  it("reports why gh gave up", async () => {
    const { harness, gh, status } = await setup();
    const pending = harness.callRpc("githubSignIn", null);
    await vi.waitFor(() => expect(gh.started).toHaveLength(1));
    for (const line of PROMPT) gh.started[0].emit(line);
    await pending;
    gh.started[0].exit({ exitCode: 1, stderr: "error: The device code has expired\n" });
    await vi.waitFor(async () => expect((await status()).github.lastError).toBe("error: The device code has expired"));
    expect((await status()).github.pending).toBeNull();
  });

  it("fails the call when gh exits before printing a code", async () => {
    const { harness, gh } = await setup();
    const pending = harness.callRpc("githubSignIn", null);
    await vi.waitFor(() => expect(gh.started).toHaveLength(1));
    gh.started[0].exit({ exitCode: 1, stderr: "The value of the GH_TOKEN environment variable is being used for authentication.\n" });
    await expect(pending).rejects.toThrow(/GH_TOKEN environment variable/u);
  });

  it("cancel kills the waiting gh", async () => {
    const { harness, gh, status } = await setup();
    const pending = harness.callRpc("githubSignIn", null);
    await vi.waitFor(() => expect(gh.started).toHaveLength(1));
    for (const line of PROMPT) gh.started[0].emit(line);
    await pending;
    await harness.callRpc("githubCancel", null);
    expect(gh.started[0].killed).toBe(true);
    const s = await status();
    expect(s.github.pending).toBeNull();
    expect(s.github.lastError).toBeNull();
  });

  it("sign out runs gh auth logout and forgets the identity", async () => {
    const { harness, gh, status } = await setup({
      builtInGit: { status: "logged in", statusMessage: "ok" },
      runs: { ...signedIn, "auth logout --hostname github.com": { exitCode: 0, stdout: "", stderr: "" } },
    });
    expect((await status()).github.login).toBe("octocat");
    await harness.callRpc("githubSignOut", null);
    expect(gh.runner.run).toHaveBeenCalledWith(["auth", "logout", "--hostname", "github.com"], expect.any(Number));
    expect(harness.realtimeSignals.map((s) => s.channel)).toContain(CHANGED);
  });
});

describe("Account Pool and devbox flows", () => {
  it("proxies the Claude sign-in", async () => {
    const { harness, rpcCalls } = await setup();
    expect(await harness.callRpc("claudeSignIn", null)).toEqual({
      sessionId: "00000000-0000-4000-8000-000000000001",
      url: "https://claude.ai/oauth/authorize?x",
    });
    expect(await harness.callRpc("claudeComplete", { sessionId: "00000000-0000-4000-8000-000000000001", pasted: "code#state" })).toEqual({
      label: "me@example.com",
    });
    expect(rpcCalls.map((c) => `${c.pluginId}:${c.method}`)).toEqual([`${ACCOUNT_POOL_ID}:login.start`, `${ACCOUNT_POOL_ID}:login.complete`]);
    expect(rpcCalls[1].input).toEqual({ sessionId: "00000000-0000-4000-8000-000000000001", pasted: "code#state" });
  });

  it("proxies the Codex device flow", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("codexSignIn", null)).toEqual({
      sessionId: "00000000-0000-4000-8000-000000000002",
      url: "https://auth.openai.com/device",
      code: "WXYZ-1234",
      expiresAt: 1_700_000_000_000,
      intervalMs: 5000,
    });
    expect(await harness.callRpc("codexPoll", { sessionId: "00000000-0000-4000-8000-000000000002" })).toEqual({
      status: "complete",
      label: "codex@example.com",
    });
    expect(await harness.callRpc("codexCancel", { sessionId: "00000000-0000-4000-8000-000000000002" })).toEqual({ ok: true });
  });

  it("starts devbox's connect", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("devboxConnect", null)).toEqual({ url: "https://devbox.example/connect/authorize?state=s" });
  });

  it("starts Linear's connect", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("linearConnect", null)).toEqual({ url: "https://linear.example/oauth/authorize?state=s" });
  });

  it("reports a plugin that does not answer", async () => {
    const { harness, status } = await setup();
    harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("boom");
    });
    const s = await status();
    expect(s.ai.available).toBe(false);
    expect(s.ai.message).toContain("boom");
    expect(s.devbox.available).toBe(false);
    expect(s.linear.available).toBe(false);
  });
});
