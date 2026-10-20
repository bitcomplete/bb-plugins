import { createHash } from "node:crypto";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, IncusClient, Instance, ProjectState } from "./incus.js";
import { chooseMemoryTotal, deriveUsage, parseCores, parseMemoryBytes, createDevboxProviderPlugin, defaultMachineName, KEY_CONFIG, PROVIDER_ID } from "./server.js";

const APP_URL = "https://bb.example";
const CALLBACK = "https://bb.example/api/v1/plugins/devbox-provider/http/connect/callback";

// A devbox whose tailscaled moves through the states a test scripts.
function fakeIncus(tailscale: Array<Record<string, unknown>>) {
  const instances = new Map<string, Instance>();
  const execs: Array<{ name: string; options: ExecOptions }> = [];
  let ts = 0;
  const projectState: ProjectState = {};
  const client: IncusClient = {
    ping: vi.fn(async () => {}),
    getInstance: vi.fn(async (name: string) => instances.get(name) ?? null),
    listInstances: vi.fn(async () => [...instances.values()]),
    listInstancesWithState: vi.fn(async () => [...instances.values()]),
    getProjectState: vi.fn(async () => projectState),
    createInstance: vi.fn(async (spec) => {
      instances.set(spec.name, { name: spec.name, status: "Running", config: spec.config });
    }),
    setState: vi.fn(async (name: string, action: "start" | "stop") => {
      const i = instances.get(name);
      if (i) i.status = action === "start" ? "Running" : "Stopped";
    }),
    deleteInstance: vi.fn(async (name: string) => {
      instances.delete(name);
    }),
    exec: vi.fn(async (name: string, options: ExecOptions) => {
      execs.push({ name, options });
      if (options.command[0] === "tailscale" && options.command[1] === "status") {
        const state = tailscale[Math.min(ts, tailscale.length - 1)];
        ts += 1;
        options.onOutput(JSON.stringify(state));
      }
      return { exitCode: 0 };
    }),
  };
  return { client, instances, execs, projectState };
}

const report = (): PluginMachineProviderProgress & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, step: (t) => lines.push(`# ${t}`), log: (t) => lines.push(t) };
};
const signal = () => new AbortController().signal;

async function setup(options: { token?: string; tailscale?: Array<Record<string, unknown>>; fetch?: typeof fetch } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "devbox-provider",
    appUrl: APP_URL,
    settings: options.token === undefined ? {} : { token: options.token },
  });
  harness.sdk.stub("hosts.list", async () => [
    { id: "host_box", name: "box", machineProviderId: "devbox", lifecycle: { phase: "creating" }, status: "disconnected" },
    { id: "host_other", name: "laptop", machineProviderId: null, lifecycle: { phase: "active" }, status: "connected" },
  ]);
  const created: unknown[] = [];
  harness.sdk.stub("hosts.experimental_create", async (args: unknown) => {
    created.push(args);
    return { id: "host_new" };
  });
  const renamed: unknown[] = [];
  harness.sdk.stub("hosts.update", async (args: unknown) => {
    renamed.push(args);
    return {};
  });
  const bootstrap = vi.fn(async () => ({ hostId: "host_devbox" }));
  Object.assign(bb.experimental_machines, { bootstrap });
  const incus = fakeIncus(options.tailscale ?? [{ BackendState: "Running", Self: { DNSName: "box.ts.net." } }]);
  const incusFactory = vi.fn(() => incus.client);
  const fetchImpl =
    options.fetch ??
    (vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/1.0/projects")) {
        return Response.json({ type: "sync", metadata: ["/1.0/projects/dylan"] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch);
  await createDevboxProviderPlugin({
    incusFactory,
    fetch: fetchImpl,
    now: () => Date.now(),
    sleep: async () => {},
  })(bb);
  const provider = harness.registrations.machineProviders.get(PROVIDER_ID)!;
  const route = harness.registrations.httpRoutes.find((r) => r.path === "/connect/callback")!;
  const app = new Hono().get("/cb", route.handler);
  const callback = (query: Record<string, string>) => app.request(`/cb?${new URLSearchParams(query)}`);
  return { bb, harness, provider, incus, incusFactory, bootstrap, callback, route, fetchImpl, created, renamed };
}

describe("connect", () => {
  it("sends the browser to devbox with PKCE and this server's callback", async () => {
    const { harness } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://devbox.boreray-eel.ts.net/connect/authorize");
    expect(u.searchParams.get("client_id")).toBe("bb");
    expect(u.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("exchanges the code with the verifier and stores the token", async () => {
    let exchanged: URLSearchParams | null = null;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/connect/token")) {
        exchanged = new URLSearchParams(String(init?.body));
        return Response.json({ access_token: "dbx_abc", token_type: "Bearer", project: "dylan" });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const sent = new URL(url).searchParams;

    const res = await callback({ code: "the-code", state: sent.get("state")! });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dylan");
    expect(exchanged!.get("code")).toBe("the-code");
    expect(exchanged!.get("redirect_uri")).toBe(CALLBACK);
    expect(exchanged!.get("client_id")).toBe("bb");
    const verifier = exchanged!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(sent.get("code_challenge"));

    expect(await harness.callRpc("status", null)).toMatchObject({ connected: true, project: "dylan" });

    // The state is single-use.
    expect((await callback({ code: "again", state: sent.get("state")! })).status).toBe(400);
  });

  it("refuses a callback whose state it never issued", async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const { callback } = await setup({ fetch: fetchImpl });
    for (const state of ["", "short", "x".repeat(43)]) {
      expect((await callback({ code: "c", state })).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not exchange anything when the developer denied", async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const res = await callback({ error: "access_denied", state: new URL(url).searchParams.get("state")! });
    expect(res.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escapes what it echoes", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "<script>x</script>" }, { status: 400 }),
    ) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const res = await callback({ code: "c", state: new URL(url).searchParams.get("state")! });
    const body = await res.text();
    expect(body).not.toContain("<script>");
  });
});

describe("machines", () => {
  it("lists only devbox machines and creates one standalone", async () => {
    const { harness, created, renamed } = await setup({ token: "dbx_abc" });
    expect(await harness.callRpc("status", null)).toMatchObject({
      machines: [{ hostId: "host_box", name: "box", phase: "creating", status: "disconnected" }],
    });
    expect(await harness.callRpc("createMachine", { name: "mybox" })).toEqual({ hostId: "host_new" });
    expect(await harness.callRpc("createMachine", {})).toEqual({ hostId: "host_new" });
    expect(created[0]).toEqual({ machineProviderId: "devbox", inputs: { name: "mybox" }, wait: false });
    // Unnamed: the plugin picks the name, so bb and Incus agree from the start.
    const picked = (created[1] as { inputs: { name: string } }).inputs.name;
    expect(picked).toMatch(/^devbox-[0-9a-z]{6}$/u);
    expect(renamed).toEqual([
      { hostId: "host_new", name: "mybox" },
      { hostId: "host_new", name: picked },
    ]);
    await expect(harness.callRpc("createMachine", { name: "Bad Name" })).rejects.toThrow();
  });

  it("needs a connection first", async () => {
    const { provider } = await setup();
    expect(await provider.availability!()).toMatchObject({ status: "setup-required" });
    expect(await provider.validate!({ inputs: {} } as never)).toMatchObject({ action: "refuse" });
  });

  it("reports a slow devbox as available and a refusal as unavailable", async () => {
    const { provider, incus } = await setup({ token: "dbx_abc" });
    expect(await provider.availability!()).toEqual({ status: "available" });

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      vi.mocked(incus.client.ping).mockImplementationOnce(
        (signal: AbortSignal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      );
      const slow = provider.availability!();
      await vi.advanceTimersByTimeAsync(8000);
      expect(await slow).toEqual({ status: "available" });
    } finally {
      vi.useRealTimers();
    }

    vi.mocked(incus.client.ping).mockRejectedValueOnce(new Error("devbox refused the connection token"));
    expect(await provider.availability!()).toMatchObject({ status: "unavailable", message: expect.stringContaining("refused") });
  });

  it("creates, asks for the Tailscale sign-in, and bootstraps as dev", async () => {
    const { provider, incus, bootstrap, harness, bb } = await setup({
      token: "dbx_abc",
      tailscale: [
        { BackendState: "NeedsLogin", AuthURL: "" },
        { BackendState: "NeedsLogin", AuthURL: "" },
        { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" },
        { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" },
        { BackendState: "Running", Self: { DNSName: "box.boreray-eel.ts.net." } },
      ],
    });
    const r = report();
    const checkpoint = vi.fn(async () => {});
    let seenSignIn: unknown = null;
    const realtime = vi.spyOn(bb.realtime, "publish").mockImplementation(async () => {
      seenSignIn = seenSignIn ?? (await harness.callRpc("status", null));
    });

    const result = await provider.create({ inputs: { name: "box" }, key: "key-1", attempt: 1, checkpoint, report: r, signal: signal() } as never);
    expect(result).toEqual({ status: "created", name: "box", resource: { name: "box", key: "key-1", project: "dylan" } });
    expect(incus.instances.get("box")?.config[KEY_CONFIG]).toBe("key-1");
    expect(checkpoint).toHaveBeenCalledWith({ name: "box", key: "key-1", project: "dylan" });
    expect(r.lines.join("")).toContain("https://login.tailscale.com/a/abc");
    // The server is reached from inside the machine before bootstrap.
    const reach = incus.execs.find((e) => e.options.command.includes("bb-reach-server"));
    expect(reach?.options.command.at(-1)).toBe("https://bb.example/health");
    expect(seenSignIn).toMatchObject({ signIns: [{ machine: "box", url: "https://login.tailscale.com/a/abc" }] });
    expect(await harness.callRpc("status", null)).toMatchObject({ signIns: [] });
    expect(realtime).toHaveBeenCalled();

    // Prepared and logged in as root; bootstrapped as dev with the creation key.
    const roots = incus.execs.filter((e) => e.options.user === 0).map((e) => e.options.command.join(" "));
    expect(roots.some((c) => c.includes("loginctl enable-linger dev"))).toBe(true);
    expect(roots.some((c) => c.includes("tailscale up --ssh"))).toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    const call = (bootstrap.mock.calls[0] as unknown[])[0] as { key: string; executor: { exec: Function } };
    expect(call.key).toBe("key-1");
    await call.executor.exec({ command: ["id"], stdin: "bundle", timeoutMs: 1000, signal: signal(), onOutput: () => {} });
    const devExec = incus.execs.at(-1)!.options;
    expect(devExec).toMatchObject({ user: 1000, group: 1000, cwd: "/home/dev", stdin: "bundle" });
    expect(devExec.environment.PATH).toContain("/home/dev/.local/share/mise/shims");
  });

  it("reuses its own instance on retry and refuses someone else's name", async () => {
    const { provider, incus } = await setup({ token: "dbx_abc" });
    const ctx = (key: string) => ({ inputs: { name: "box" }, key, attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() }) as never;
    expect(await provider.create(ctx("key-1"))).toMatchObject({ status: "created" });
    expect(await provider.create(ctx("key-1"))).toMatchObject({ status: "created" });
    expect(incus.client.createInstance).toHaveBeenCalledTimes(1);
    expect(await provider.create(ctx("key-2"))).toMatchObject({ status: "failed", message: expect.stringContaining("already exists") });
  });

  it("names a machine from its key when none is given", async () => {
    const { provider } = await setup({ token: "dbx_abc" });
    const result = await provider.create({ inputs: {}, key: "key-9", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    expect(result).toMatchObject({ status: "created", name: defaultMachineName("key-9") });
    expect(defaultMachineName("key-9")).toMatch(/^bb-[0-9a-f]{6}$/u);
  });

  it("rides out a failed status read while waiting for sign-in", async () => {
    const { provider, incus, bootstrap } = await setup({
      token: "dbx_abc",
      tailscale: [
        { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" },
        { BackendState: "Running", Self: { DNSName: "box.ts.net." } },
      ],
    });
    const exec = vi.mocked(incus.client.exec);
    const real = exec.getMockImplementation()!;
    let statusReads = 0;
    exec.mockImplementation(async (name, options) => {
      if (options.command[0] === "tailscale" && options.command[1] === "status") {
        statusReads += 1;
        if (statusReads === 2) throw new Error("Unexpected server response: 500");
      }
      return real(name, options);
    });
    const r = report();
    const result = await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: r, signal: signal() } as never);
    expect(result).toMatchObject({ status: "created" });
    expect(r.lines.join("")).toContain("failed (Unexpected server response: 500); retrying");
    expect(bootstrap).toHaveBeenCalled();
  });

  it("refuses a machine that joined the tailnet as a tag", async () => {
    const { provider, bootstrap } = await setup({
      token: "dbx_abc",
      tailscale: [{ BackendState: "Running", Self: { DNSName: "box.ts.net.", Tags: ["tag:server"] } }],
    });
    const result = await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("tag:server") });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("removes the instance, and cleanup finds strays by key", async () => {
    const { provider, incus } = await setup({ token: "dbx_abc" });
    await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    incus.instances.set("stray", { name: "stray", status: "Stopped", config: { [KEY_CONFIG]: "lost" } });
    incus.instances.set("mine", { name: "mine", status: "Running", config: {} });

    expect(await provider.reconcileCleanup({ key: "lost", report: report(), signal: signal() })).toEqual({ status: "removed" });
    expect(incus.instances.has("stray")).toBe(false);
    expect(incus.instances.has("mine")).toBe(true);

    expect(await provider.remove({ resource: { name: "box", key: "k", project: "dylan" }, hostId: "h", report: report(), signal: signal() } as never)).toEqual({ status: "removed" });
    expect(incus.instances.has("box")).toBe(false);
    expect(incus.execs.some((e) => e.options.command.join(" ").includes("tailscale logout"))).toBe(true);
  });

  it("suspends by stopping and resumes with the same key", async () => {
    const { provider, incus, bootstrap } = await setup({ token: "dbx_abc" });
    const resource = { name: "box", key: "k", project: "dylan" };
    await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    await provider.suspend!({ resource, hostId: "h", checkpoint: async () => {}, report: report(), signal: signal() });
    expect(incus.instances.get("box")?.status).toBe("Stopped");
    await provider.resume!({ resource, hostId: "h", checkpoint: async () => {}, report: report(), signal: signal() });
    expect(incus.instances.get("box")?.status).toBe("Running");
    expect((bootstrap.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ key: "k" });
  });
});

describe("usage derivation", () => {
  const instance = (over: Partial<Instance> = {}): Instance => ({
    name: "box",
    status: "Running",
    config: { "limits.cpu": "4" },
    ...over,
  });
  const running = (cpuUsage: number): Instance =>
    instance({
      state: {
        status: "Running",
        cpu: { usage: cpuUsage },
        memory: { usage: 1_000, total: 2_000 },
        disk: { root: { usage: 10, total: 100 } },
        network: { eth0: { counters: { bytes_received: 5, bytes_sent: 7 } } },
        processes: 3,
        started_at: "2026-10-20T17:00:00.000Z",
      },
    });

  it("parses cores from a count, a cpuset or a list", () => {
    expect(parseCores("4")).toBe(4);
    expect(parseCores("0-3")).toBe(4);
    expect(parseCores("0,2,3")).toBe(3);
    expect(parseCores(undefined)).toBe(4);
    expect(parseCores("junk")).toBe(4);
  });

  it("parses the memory quantities Incus accepts", () => {
    expect(parseMemoryBytes("16GiB")).toBe(16 * 1024 ** 3);
    expect(parseMemoryBytes("512MiB")).toBe(512 * 1024 ** 2);
    expect(parseMemoryBytes("1073741824")).toBe(1_073_741_824);
    expect(parseMemoryBytes("nonsense")).toBeNull();
    expect(parseMemoryBytes(undefined)).toBeNull();
  });

  it("derives CPU percent from the delta over wall time and cores", () => {
    const samples = new Map<string, { usage: number; at: number }>();
    // First sample: no percent yet.
    expect(deriveUsage([running(1_000_000_000)], new Set(), samples, 1_000_000)[0].cpuPercent).toBeNull();
    // +2 CPU-seconds over 1 wall second across 4 cores = 50%.
    const second = deriveUsage([running(3_000_000_000)], new Set(), samples, 1_001_000)[0];
    expect(second.cpuPercent).toBeCloseTo(50);
    expect(second.cores).toBe(4);
  });

  it("reports no percent on a counter reset rather than a negative one", () => {
    const samples = new Map<string, { usage: number; at: number }>();
    deriveUsage([running(5_000_000_000)], new Set(), samples, 1_000_000);
    const reset = deriveUsage([running(1_000)], new Set(), samples, 1_001_000)[0];
    expect(reset.cpuPercent).toBeNull();
  });

  it("falls back to limits.memory when memory.total looks like host memory", () => {
    const withTotal = (total: number, limits: string) =>
      deriveUsage(
        [instance({ config: { "limits.cpu": "4", "limits.memory": limits }, state: { status: "Running", memory: { usage: 100, total } } })],
        new Set(),
        new Map(),
        1_000_000,
      )[0];
    const hostLooking = withTotal(64 * 1024 ** 3, "16GiB");
    expect(hostLooking.memoryTotal).toBe(16 * 1024 ** 3);
    expect(hostLooking.memoryTotalSource).toBe("limit");
    const within = withTotal(8 * 1024 ** 3, "16GiB");
    expect(within.memoryTotal).toBe(8 * 1024 ** 3);
    expect(within.memoryTotalSource).toBe("state");
    expect(chooseMemoryTotal(null, 1024)).toEqual({ total: 1024, source: "limit" });
    expect(chooseMemoryTotal(null, null)).toEqual({ total: null, source: null });
  });

  it("gives a stopped instance disk only", () => {
    const stopped = instance({
      status: "Stopped",
      state: { status: "Stopped", disk: { root: { usage: 40, total: 100 } } },
    });
    const row = deriveUsage([stopped], new Set(), new Map(), 1_000_000)[0];
    expect(row.status).toBe("Stopped");
    expect(row.cpuPercent).toBeNull();
    expect(row.memoryUsed).toBeNull();
    expect(row.memoryTotal).toBeNull();
    expect(row.networkIn).toBe(0);
    expect(row.networkOut).toBe(0);
    expect(row.uptimeSeconds).toBeNull();
    expect(row.diskUsed).toBe(40);
    expect(row.diskTotal).toBe(100);
  });

  it("marks bb machines by key or by the host list", () => {
    const byKey = instance({ name: "mine", config: { [KEY_CONFIG]: "k" } });
    const byHost = instance({ name: "box", config: {} });
    const foreign = instance({ name: "cli", config: {} });
    const rows = deriveUsage([byKey, byHost, foreign], new Set(["box"]), new Map(), 1_000_000);
    expect(rows.map((row) => row.bb)).toEqual([true, true, false]);
  });

  it("prunes samples for instances that left the listing", () => {
    const samples = new Map([["gone", { usage: 1, at: 1 }]]);
    deriveUsage([instance({ name: "kept" })], new Set(), samples, 2);
    expect(samples.has("gone")).toBe(false);
  });
});

describe("usage rpc", () => {
  it("reports not connected when there is no token", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("usage", null)).toEqual({ connected: false, project: null, instances: [], totals: null });
  });

  it("returns one row per instance, bb marking, and allocated totals", async () => {
    const { harness, incus } = await setup({ token: "dbx_abc" });
    incus.instances.set("mine", {
      name: "mine",
      status: "Running",
      config: { [KEY_CONFIG]: "k" },
      state: {
        status: "Running",
        cpu: { usage: 1_000_000_000 },
        memory: { usage: 1_000, total: 2_000 },
        disk: { root: { usage: 10, total: 100 } },
        network: { eth0: { counters: { bytes_received: 5, bytes_sent: 7 } } },
        processes: 3,
      },
    });
    // A CLI-created instance is listed too, and marked via the host list.
    incus.instances.set("box", { name: "box", status: "Stopped", config: {}, state: { status: "Stopped", disk: { root: { usage: 1, total: 2 } } } });
    Object.assign(incus.projectState, {
      cpu: { limit: 12, usage: 4 },
      memory: { limit: 48 * 1024 ** 3, usage: 16 * 1024 ** 3 },
      disk: { limit: 250 * 1024 ** 3, usage: 40 * 1024 ** 3 },
      instances: { limit: 6, usage: 2 },
    } satisfies ProjectState);

    const result = (await harness.callRpc("usage", null)) as {
      connected: boolean;
      project: string;
      instances: Array<{ name: string; bb: boolean; status: string; cpuPercent: number | null }>;
      totals: unknown;
    };
    expect(result.connected).toBe(true);
    expect(result.project).toBe("dylan");
    expect(result.instances.map((row) => row.name).sort()).toEqual(["box", "mine"]);
    expect(result.instances.find((row) => row.name === "mine")!.bb).toBe(true);
    expect(result.instances.find((row) => row.name === "box")!.bb).toBe(true);
    // The first sample has no CPU percent.
    expect(result.instances.find((row) => row.name === "mine")!.cpuPercent).toBeNull();
    expect(result.totals).toEqual({
      cpu: { limit: 12, usage: 4 },
      memory: { limit: 48 * 1024 ** 3, usage: 16 * 1024 ** 3 },
      disk: { limit: 250 * 1024 ** 3, usage: 40 * 1024 ** 3 },
      instances: { limit: 6, usage: 2 },
    });
  });

  it("still returns the rows when the project state read fails", async () => {
    const { harness, incus } = await setup({ token: "dbx_abc" });
    incus.instances.set("mine", {
      name: "mine",
      status: "Running",
      config: { [KEY_CONFIG]: "k" },
      state: { status: "Running", disk: { root: { usage: 1, total: 2 } } },
    });
    vi.mocked(incus.client.getProjectState).mockRejectedValueOnce(new Error("forbidden"));
    const result = (await harness.callRpc("usage", null)) as { instances: unknown[]; totals: unknown };
    expect(result.instances).toHaveLength(1);
    expect(result.totals).toBeNull();
  });
});
