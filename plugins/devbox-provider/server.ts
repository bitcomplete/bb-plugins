// Devbox machines: create a devbox in the developer's Incus project on
// bertha, put it on the tailnet as theirs, and enroll it as a bb machine.
//
// Access to the project comes from connecting devbox once (connect.ts), which
// leaves a bearer token in the `token` secret setting. Every Incus call goes
// through devbox-gate with that token (incus.ts). Core installs and enrolls
// the daemon through the exec transport here, as it does for any machine.
import { createHash, randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import type { Context } from "hono";
import { z } from "zod";
import {
  authorizeUrl,
  exchangeCode,
  newPendingConnect,
  PENDING_TTL_MS,
  revokeToken,
  type PendingConnect,
} from "./connect.js";
import { createIncusClient, type IncusClient, type IncusConfig, type Instance, type ProjectState } from "./incus.js";
import {
  LOGOUT_COMMAND,
  parseTailscaleStatus,
  PREPARE_SCRIPT,
  REACH_SERVER_SCRIPT,
  START_LOGIN_SCRIPT,
  STATUS_COMMAND,
  type TailscaleStatus,
} from "./tailnet.js";

export const PROVIDER_ID = "devbox";
export const CALLBACK_PATH = "/connect/callback";
export const KEY_CONFIG = "user.bb.key";

// Incus instance names are hostnames; keep to the lowercase subset.
export const MACHINE_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const machineInputsSchema = z
  .object({
    name: z.string().regex(MACHINE_NAME_PATTERN, "lowercase letters, digits and dashes, starting with a letter").optional(),
    // An image alias visible to the project; the setting's image otherwise.
    image: z.string().min(1).optional(),
  })
  .strict();

export const resourceSchema = z.object({ name: z.string().min(1), key: z.string().min(1), project: z.string().min(1) }).strict();
export type MachineResource = z.infer<typeof resourceSchema>;

const signInSchema = z.object({ machine: z.string(), url: z.string(), since: z.number() });
export type SignIn = z.infer<typeof signInSchema>;

const machineSummarySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  phase: z.string(),
  status: z.string(),
});

// The devbox profile caps a machine at four cores unless it says otherwise.
const DEFAULT_CORES = 4;
const USAGE_TIMEOUT_MS = 10_000;

const projectResourceSchema = z.object({ limit: z.number(), usage: z.number() });

const usageRowSchema = z.object({
  name: z.string(),
  bb: z.boolean(),
  status: z.string(),
  // null until a second sample exists, or after a restart/counter reset.
  cpuPercent: z.number().nullable(),
  cores: z.number(),
  memoryUsed: z.number().nullable(),
  memoryTotal: z.number().nullable(),
  // "state" when Incus reported it, "limit" when limits.memory stood in.
  memoryTotalSource: z.enum(["state", "limit"]).nullable(),
  diskUsed: z.number().nullable(),
  diskTotal: z.number().nullable(),
  networkIn: z.number(),
  networkOut: z.number(),
  uptimeSeconds: z.number().nullable(),
  processes: z.number().nullable(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

const usageTotalsSchema = z.object({
  cpu: projectResourceSchema.nullable(),
  memory: projectResourceSchema.nullable(),
  disk: projectResourceSchema.nullable(),
  instances: projectResourceSchema.nullable(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export interface UsageResult {
  connected: boolean;
  project: string | null;
  instances: UsageRow[];
  totals: UsageTotals | null;
}

export interface CpuSample {
  usage: number;
  at: number;
}

// limits.cpu is a count ("4"), a cpuset ("0-3") or a list ("0,2,3").
export function parseCores(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (/^\d+$/u.test(text)) {
    const count = Number(text);
    return count > 0 ? count : DEFAULT_CORES;
  }
  let count = 0;
  for (const part of text.split(",")) {
    const range = /^(\d+)-(\d+)$/u.exec(part.trim());
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from) count += to - from + 1;
    } else if (/^\d+$/u.test(part.trim())) {
      count += 1;
    }
  }
  return count > 0 ? count : DEFAULT_CORES;
}

const MEMORY_UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

// Parses the byte quantities Incus accepts for limits.memory ("16GiB", "512MB",
// or a plain byte count). Returns null for anything else.
export function parseMemoryBytes(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/u.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toUpperCase();
  const factor = MEMORY_UNITS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || factor === undefined) return null;
  return Math.round(amount * factor);
}

// Incus can report the host's memory in state.memory.total when the instance
// limit is a soft cap (the profile sets limits.memory: 16GiB). When the
// reported total exceeds the configured limit, the limit is the truth.
export function chooseMemoryTotal(
  stateTotal: number | null,
  limitBytes: number | null,
): { total: number | null; source: "state" | "limit" | null } {
  if (limitBytes !== null && (stateTotal === null || stateTotal > limitBytes)) return { total: limitBytes, source: "limit" };
  if (stateTotal !== null) return { total: stateTotal, source: "state" };
  return { total: null, source: null };
}

function toResource(resource: { limit?: number; usage?: number } | undefined): z.infer<typeof projectResourceSchema> | null {
  if (resource === undefined || typeof resource.limit !== "number" || typeof resource.usage !== "number") return null;
  return { limit: resource.limit, usage: resource.usage };
}

// Turns the project state into the four rows the page shows, labelled
// "allocated": Incus sums the instances' configured limits here, not live use.
export function projectTotals(state: ProjectState) {
  return {
    cpu: toResource(state.cpu),
    memory: toResource(state.memory),
    disk: toResource(state.disk),
    instances: toResource(state.instances),
  };
}

// Derives one row per instance from a state listing. CPU percent is the CPU
// time used between the previous sample and this one, over wall-clock time and
// the instance's core count; it is null on the first sample and when the
// counter goes backwards (a restart). Stopped instances contribute disk only.
// `samples` is the in-memory previous sample per instance and is updated here.
export function deriveUsage(
  instances: Instance[],
  bbNames: ReadonlySet<string>,
  samples: Map<string, CpuSample>,
  now: number,
): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const instance of instances) {
    const state = instance.state;
    const status = state?.status ?? instance.status;
    const running = status === "Running";
    const cores = parseCores(instance.config["limits.cpu"]);
    const disk = state?.disk?.root;
    let cpuPercent: number | null = null;
    let memoryUsed: number | null = null;
    let memoryTotal: number | null = null;
    let memoryTotalSource: "state" | "limit" | null = null;
    let networkIn = 0;
    let networkOut = 0;
    let uptimeSeconds: number | null = null;
    let processes: number | null = null;

    if (running) {
      const usage = state?.cpu?.usage;
      if (typeof usage === "number" && Number.isFinite(usage)) {
        const previous = samples.get(instance.name);
        if (previous !== undefined && usage >= previous.usage && now > previous.at) {
          const cpuSeconds = (usage - previous.usage) / 1e9;
          const wallSeconds = (now - previous.at) / 1000;
          // Capped at 100% of the allocated cores; a lower clamp guards a
          // counter that advanced while wall time did not.
          cpuPercent = Math.max(0, Math.min(100, (cpuSeconds / wallSeconds / cores) * 100));
        }
        samples.set(instance.name, { usage, at: now });
      } else {
        samples.delete(instance.name);
      }

      const memory = state?.memory;
      const stateTotal = typeof memory?.total === "number" && Number.isFinite(memory.total) ? memory.total : null;
      const chosen = chooseMemoryTotal(stateTotal, parseMemoryBytes(instance.config["limits.memory"]));
      memoryTotal = chosen.total;
      memoryTotalSource = chosen.source;
      memoryUsed = typeof memory?.usage === "number" && Number.isFinite(memory.usage) ? memory.usage : null;

      for (const iface of Object.values(state?.network ?? {})) {
        if (typeof iface?.counters?.bytes_received === "number") networkIn += iface.counters.bytes_received;
        if (typeof iface?.counters?.bytes_sent === "number") networkOut += iface.counters.bytes_sent;
      }
      if (typeof state?.processes === "number") processes = state.processes;
      if (typeof state?.started_at === "string") {
        const started = Date.parse(state.started_at);
        if (Number.isFinite(started) && started <= now) uptimeSeconds = Math.round((now - started) / 1000);
      }
    } else {
      samples.delete(instance.name);
    }

    rows.push({
      name: instance.name,
      bb: instance.config[KEY_CONFIG] !== undefined || bbNames.has(instance.name),
      status,
      cpuPercent,
      cores,
      memoryUsed,
      memoryTotal,
      memoryTotalSource,
      diskUsed: typeof disk?.usage === "number" ? disk.usage : null,
      diskTotal: typeof disk?.total === "number" ? disk.total : null,
      networkIn,
      networkOut,
      uptimeSeconds,
      processes,
    });
  }
  return rows;
}

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      project: z.string().nullable(),
      devboxUrl: z.string(),
      signIns: z.array(signInSchema),
      machines: z.array(machineSummarySchema),
    }),
  },
  // bb's Settings → Machines offers only manual setup for adding a machine,
  // so the plugin's settings section starts a standalone create itself,
  // exactly as `bb machine create --provider devbox` does.
  createMachine: {
    input: z.object({ name: machineInputsSchema.shape.name }).strict(),
    output: z.object({ hostId: z.string() }),
  },
  connect: {
    input: z.null(),
    output: z.object({ url: z.string() }),
  },
  disconnect: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }),
  },
  // Live usage for every instance in the project, plus the project's
  // allocated caps. Read-only; the page polls it while open.
  usage: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      project: z.string().nullable(),
      instances: z.array(usageRowSchema),
      totals: usageTotalsSchema.nullable(),
    }),
  },
});

export const SETTING_DESCRIPTORS = {
  devboxUrl: {
    type: "string",
    label: "devbox address",
    description: "Where your browser approves the connection.",
    default: "https://devbox.boreray-eel.ts.net",
  },
  apiUrl: {
    type: "string",
    label: "devbox API",
    description: "devbox-gate's API listener as this server reaches it, in-cluster.",
    default: "http://devbox-gate.devbox-production.svc.cluster.local:8081",
  },
  clientId: {
    type: "string",
    label: "Client ID",
    description: "This server's client ID in devbox's client registry.",
    default: "bb",
  },
  token: {
    type: "string",
    secret: true,
    label: "Connection token",
    description: "Filled in by Connect devbox below. Paste one only if you got it another way.",
  },
  image: {
    type: "string",
    label: "Image",
    description: "Image alias new machines start from.",
    default: "devbox",
  },
  profiles: {
    type: "string",
    label: "Profiles",
    description: "Comma-separated Incus profiles for new machines, applied in order.",
    default: "default,devbox",
  },
  signInTimeoutMinutes: {
    type: "number",
    label: "Tailscale sign-in timeout (minutes)",
    description: "How long machine creation waits for you to sign the machine in to Tailscale.",
    default: 20,
  },
} as const;

export const SIGNINS_CHANGED = "signins-changed";
export const CONNECTION_CHANGED = "connection-changed";
export const MACHINES_CHANGED = "machines-changed";

const ROOT_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
};
// Incus exec runs no login shell, so nothing reads /etc/environment or the
// profile: the mise shims (Node for bb's installer) and the user bus are
// spelled out here.
const DEV_ENV = {
  HOME: "/home/dev",
  USER: "dev",
  LOGNAME: "dev",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  PATH: "/home/dev/.local/share/mise/shims:/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
};
const DEV_UID = 1000;

const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const SHORT_EXEC_TIMEOUT_MS = 60 * 1000;
const AUTH_URL_TIMEOUT_MS = 2 * 60 * 1000;
const RECONNECT_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_MS = 3000;
const AVAILABILITY_TIMEOUT_MS = 7000;
const STATUS_ATTEMPTS = 5;
const REACH_TIMEOUT_MS = 4 * 60 * 1000;
const PREPARE_ATTEMPTS = 3;

export interface DevboxProviderDeps {
  incusFactory: (cfg: IncusConfig) => IncusClient;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A retried create must find the instance its first attempt made, so the
// default name is a function of the creation key.
export function defaultMachineName(key: string): string {
  return `bb-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

function resultPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}main{max-width:32rem;padding:2rem;text-align:center}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

export function createDevboxProviderPlugin(deps: DevboxProviderDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);

    // Previous CPU counter per instance, for the delta between polls. In
    // memory only: a restart resets it, which just costs one sample.
    const cpuSamples = new Map<string, CpuSample>();

    // ---- the connection ---------------------------------------------------

    const pendingKey = (state: string) => `connect/pending/${state}`;
    const CONNECTION_KEY = "connection";
    const connectionRecord = z.object({ tokenFingerprint: z.string(), project: z.string() });

    function redirectUri(): string {
      const appUrl = bb.server.experimental_appUrl;
      if (appUrl === null) {
        throw new Error("This bb server has no public address (BB_APP_URL), so devbox cannot send you back to it.");
      }
      return new URL(`/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`, appUrl).toString();
    }

    // The project the token opens. Recorded at connect; a token pasted by
    // hand is asked, since its certificate sees exactly one project.
    async function projectFor(token: string, apiUrl: string, signal: AbortSignal): Promise<string> {
      const fp = tokenFingerprint(token);
      const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
      if (stored.success && stored.data.tokenFingerprint === fp) return stored.data.project;
      const response = await deps.fetch(new URL("/1.0/projects", apiUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as { metadata?: unknown };
      const projects = Array.isArray(body.metadata) ? body.metadata.filter((p): p is string => typeof p === "string") : [];
      if (!response.ok || projects.length !== 1) {
        throw new Error("The connection token does not open exactly one devbox project; connect devbox again.");
      }
      const project = projects[0].split("/").pop() ?? "";
      await bb.storage.kv.set(CONNECTION_KEY, { tokenFingerprint: fp, project });
      return project;
    }

    async function connection(signal: AbortSignal): Promise<{ incus: IncusClient; project: string; cfg: Awaited<ReturnType<typeof settings.get>> }> {
      const cfg = await settings.get();
      const token = cfg.token?.trim() ?? "";
      if (token === "") {
        throw new Error("devbox is not connected. Open Settings → Plugins → Devbox machines and choose Connect devbox.");
      }
      const project = await projectFor(token, cfg.apiUrl, signal);
      return { incus: deps.incusFactory({ apiUrl: cfg.apiUrl, token, project }), project, cfg };
    }

    async function prunePending(): Promise<void> {
      const now = deps.now();
      for (const key of await bb.storage.kv.list("connect/pending/")) {
        const p = await bb.storage.kv.get<PendingConnect>(key);
        if (p === undefined || now - p.createdAt > PENDING_TTL_MS) await bb.storage.kv.delete(key);
      }
    }

    async function signIns(): Promise<SignIn[]> {
      const out: SignIn[] = [];
      for (const key of await bb.storage.kv.list("signin/")) {
        const parsed = signInSchema.safeParse(await bb.storage.kv.get(key));
        if (parsed.success) out.push(parsed.data);
      }
      return out.sort((a, b) => a.since - b.since);
    }

    bb.rpc.register(rpcContract, {
      async status() {
        const cfg = await settings.get();
        const token = cfg.token?.trim() ?? "";
        let project: string | null = null;
        if (token !== "") {
          const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
          project = stored.success && stored.data.tokenFingerprint === tokenFingerprint(token) ? stored.data.project : null;
        }
        const hosts = await bb.sdk.hosts.list();
        const machines = hosts
          .filter((h) => h.machineProviderId === PROVIDER_ID)
          .map((h) => ({ hostId: h.id, name: h.name, phase: h.lifecycle.phase, status: h.status }));
        return { connected: token !== "", project, devboxUrl: cfg.devboxUrl, signIns: await signIns(), machines };
      },
      async createMachine({ name }) {
        // Name the container here rather than leaving it to create, and give
        // bb's machine the same name now: core labels a machine
        // "<provider> <host id>" until create returns, which matched nothing
        // in Incus or on the tailnet.
        const machineName = name ?? `devbox-${randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(-6)}`;
        const host = await bb.sdk.hosts.experimental_create({
          machineProviderId: PROVIDER_ID,
          inputs: { name: machineName },
          wait: false,
        });
        try {
          await bb.sdk.hosts.update({ hostId: host.id, name: machineName });
        } catch (error) {
          bb.log.warn(`could not name machine ${host.id} ${machineName}: ${errorMessage(error)}`);
        }
        bb.realtime.publish(MACHINES_CHANGED, { hostId: host.id });
        return { hostId: host.id };
      },
      async connect() {
        const cfg = await settings.get();
        await prunePending();
        const pending = newPendingConnect(redirectUri(), deps.now());
        await bb.storage.kv.set(pendingKey(pending.state), pending);
        return { url: authorizeUrl(cfg.devboxUrl, cfg.clientId, pending) };
      },
      async disconnect() {
        const cfg = await settings.get();
        const token = cfg.token?.trim() ?? "";
        if (token !== "") {
          try {
            await revokeToken(cfg.apiUrl, token, deps.fetch, AbortSignal.timeout(10_000));
          } catch (error) {
            bb.log.warn(`could not revoke the devbox token: ${errorMessage(error)}`);
          }
        }
        await settings.experimental_set({ token: null });
        await bb.storage.kv.delete(CONNECTION_KEY);
        cpuSamples.clear();
        bb.realtime.publish(CONNECTION_CHANGED, { connected: false });
        return { ok: true };
      },
      async usage() {
        const cfg = await settings.get();
        if ((cfg.token?.trim() ?? "") === "") {
          return { connected: false, project: null, instances: [], totals: null };
        }
        const signal = AbortSignal.timeout(USAGE_TIMEOUT_MS);
        const { incus, project } = await connection(signal);
        const [instances, projectState, hosts] = await Promise.all([
          incus.listInstancesWithState(signal),
          incus.getProjectState(signal),
          bb.sdk.hosts.list(),
        ]);
        const bbNames = new Set(
          hosts.filter((host) => host.machineProviderId === PROVIDER_ID).map((host) => host.name),
        );
        return {
          connected: true,
          project,
          instances: deriveUsage(instances, bbNames, cpuSamples, deps.now()),
          totals: projectTotals(projectState),
        };
      },
    });

    // devbox sends the browser here after approval. "none" because the
    // request is a top-level navigation from devbox's origin; the state is
    // the credential: 256 random bits, single-use, and minted for this
    // server, so a forged or replayed callback finds nothing.
    bb.http.route(
      "GET",
      CALLBACK_PATH,
      async (c: Context) => {
        const state = c.req.query("state") ?? "";
        const pending = /^[A-Za-z0-9_-]{43}$/u.test(state)
          ? await bb.storage.kv.get<PendingConnect>(pendingKey(state))
          : undefined;
        if (pending === undefined || deps.now() - pending.createdAt > PENDING_TTL_MS) {
          return resultPage("This link has expired", "Start again from Connect devbox in bb's settings.", 400);
        }
        await bb.storage.kv.delete(pendingKey(state));
        if (c.req.query("error") !== undefined) {
          return resultPage("Not connected", "devbox was not connected. You can close this tab.", 200);
        }
        const code = c.req.query("code") ?? "";
        const cfg = await settings.get();
        try {
          const conn = await exchangeCode(cfg.apiUrl, cfg.clientId, pending, code, deps.fetch, AbortSignal.timeout(15_000));
          await settings.experimental_set({ token: conn.token });
          await bb.storage.kv.set(CONNECTION_KEY, { tokenFingerprint: tokenFingerprint(conn.token), project: conn.project });
          bb.realtime.publish(CONNECTION_CHANGED, { connected: true });
          bb.log.info(`connected to devbox project ${conn.project}`);
          return resultPage(
            "devbox connected",
            `bb can now create machines in your devbox project ${conn.project}. You can close this tab.`,
            200,
          );
        } catch (error) {
          bb.log.warn(`devbox connect failed: ${errorMessage(error)}`);
          return resultPage("Not connected", `${errorMessage(error)}. Start again from bb's settings.`, 502);
        }
      },
      { auth: "none" },
    );

    // ---- running things in a machine -------------------------------------

    function asRoot(incus: IncusClient, name: string) {
      return async (
        command: string[],
        signal: AbortSignal,
        timeoutMs = SHORT_EXEC_TIMEOUT_MS,
        onOutput?: (chunk: string) => void,
      ): Promise<{ exitCode: number; output: string }> => {
        let output = "";
        const { exitCode } = await incus.exec(name, {
          command,
          environment: ROOT_ENV,
          user: 0,
          group: 0,
          cwd: "/root",
          stdin: "",
          timeoutMs,
          signal,
          onOutput: (chunk) => {
            output += chunk;
            onOutput?.(chunk);
          },
        });
        return { exitCode, output };
      };
    }

    function devExecutor(incus: IncusClient, name: string): MachineExecutor {
      return {
        exec: ({ command, stdin, timeoutMs, signal, onOutput }) =>
          incus.exec(name, {
            command,
            environment: DEV_ENV,
            user: DEV_UID,
            group: DEV_UID,
            cwd: DEV_ENV.HOME,
            stdin,
            timeoutMs,
            signal,
            onOutput,
          }),
      };
    }

    async function prepare(incus: IncusClient, name: string, report: PluginMachineProviderProgress, signal: AbortSignal) {
      report.step("Waiting for the machine to boot");
      const { exitCode } = await retrying("preparing the machine", PREPARE_ATTEMPTS, report, signal, () =>
        asRoot(incus, name)(["sh", "-c", PREPARE_SCRIPT], signal, PREPARE_TIMEOUT_MS, (c) => report.log(c)),
      );
      if (exitCode !== 0) throw new Error(`machine ${name} did not finish booting (exit ${exitCode})`);
    }

    // Runs an idempotent step again when it fails for a reason other than
    // being cancelled. One blip in a reverse proxy or an Incus websocket
    // must not end a twenty-minute wait for someone to sign in.
    async function retrying<T>(
      what: string,
      attempts: number,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
      step: () => Promise<T>,
    ): Promise<T> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await step();
        } catch (error) {
          signal.throwIfAborted();
          if (attempt >= attempts) throw error;
          report.log(`${what} failed (${errorMessage(error)}); retrying\n`);
          await deps.sleep(POLL_MS, signal);
        }
      }
    }

    async function tailscaleStatus(
      incus: IncusClient,
      name: string,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<TailscaleStatus> {
      return retrying("reading tailscale status", STATUS_ATTEMPTS, report, signal, () => readTailscaleStatus(incus, name, signal));
    }

    async function readTailscaleStatus(incus: IncusClient, name: string, signal: AbortSignal): Promise<TailscaleStatus> {
      const { exitCode, output } = await asRoot(incus, name)(STATUS_COMMAND, signal);
      try {
        return parseTailscaleStatus(output);
      } catch {
        throw new Error(`tailscale status failed in ${name} (exit ${exitCode}): ${output.trim().slice(0, 300)}`);
      }
    }

    async function setSignIn(name: string, url: string | null) {
      if (url === null) await bb.storage.kv.delete(`signin/${name}`);
      else await bb.storage.kv.set(`signin/${name}`, { machine: name, url, since: deps.now() });
      bb.realtime.publish(SIGNINS_CHANGED, { machine: name });
    }

    // Brings the machine onto the tailnet as the developer's own node,
    // asking them to sign in when tailscaled has no login.
    async function joinTailnet(
      incus: IncusClient,
      name: string,
      timeoutMinutes: number,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<void> {
      report.step("Joining the tailnet");
      let status = await tailscaleStatus(incus, name, report, signal);
      if (status.backendState !== "Running") {
        // A machine that was signed in before needs a moment to reconnect.
        const settleBy = deps.now() + RECONNECT_TIMEOUT_MS;
        while (status.backendState === "Starting" && deps.now() < settleBy) {
          await deps.sleep(POLL_MS, signal);
          status = await tailscaleStatus(incus, name, report, signal);
        }
      }
      if (status.backendState !== "Running") {
        const started = await asRoot(incus, name)(["sh", "-c", START_LOGIN_SCRIPT], signal);
        if (started.exitCode !== 0) throw new Error(`could not start tailscale in ${name}: ${started.output.trim()}`);
        let shown = "";
        const urlBy = deps.now() + AUTH_URL_TIMEOUT_MS;
        const doneBy = deps.now() + timeoutMinutes * 60 * 1000;
        try {
          for (;;) {
            status = await tailscaleStatus(incus, name, report, signal);
            if (status.backendState === "Running") break;
            if (status.authUrl !== "" && status.authUrl !== shown) {
              shown = status.authUrl;
              report.step("Sign in to Tailscale");
              report.log(
                `\nSign ${name} in to Tailscale as yourself:\n\n  ${shown}\n\n` +
                  `The link is also under Settings → Plugins → Devbox machines. Waiting up to ${timeoutMinutes} minutes.\n`,
              );
              await setSignIn(name, shown);
            }
            if (shown === "" && deps.now() > urlBy) throw new Error(`tailscale in ${name} offered no sign-in link`);
            if (deps.now() > doneBy) throw new Error(`nobody signed ${name} in to Tailscale within ${timeoutMinutes} minutes`);
            await deps.sleep(POLL_MS, signal);
          }
        } finally {
          if (shown !== "") await setSignIn(name, null);
        }
      }
      if (status.tags.length > 0) {
        throw new Error(
          `${name} joined the tailnet as ${status.tags.join(", ")}; bb-gate only admits machines signed in as a person. Sign it in as yourself.`,
        );
      }
      report.log(`on the tailnet as ${status.dnsName || name}\n`);
    }

    async function waitForServer(incus: IncusClient, name: string, report: PluginMachineProviderProgress, signal: AbortSignal) {
      const appUrl = bb.server.experimental_appUrl;
      if (appUrl === null) return;
      report.step("Reaching bb over the tailnet");
      const target = new URL("/health", appUrl).toString();
      const { exitCode, output } = await asRoot(incus, name)(
        ["sh", "-c", REACH_SERVER_SCRIPT, "bb-reach-server", target],
        signal,
        REACH_TIMEOUT_MS,
      );
      if (exitCode !== 0) {
        throw new Error(output.trim().split("\n").pop() || `${name} cannot reach ${target}`);
      }
    }

    async function bootstrap(incus: IncusClient, resource: MachineResource, report: PluginMachineProviderProgress, signal: AbortSignal) {
      report.step("Installing the bb daemon");
      const startedAt = deps.now();
      await bb.experimental_machines.bootstrap({ key: resource.key, executor: devExecutor(incus, resource.name), report, signal });
      report.log(`daemon connected in ${Math.round((deps.now() - startedAt) / 1000)} s\n`);
    }

    async function stopAndDelete(incus: IncusClient, name: string, signal: AbortSignal) {
      const instance = await incus.getInstance(name, signal);
      if (instance === null) return;
      if (instance.status === "Running") {
        try {
          await asRoot(incus, name)(LOGOUT_COMMAND, signal, 30_000);
        } catch (error) {
          bb.log.warn(`tailscale logout in ${name} failed: ${errorMessage(error)}`);
        }
        await incus.setState(name, "stop", signal);
      }
      await incus.deleteInstance(name, signal);
    }

    // ---- the machine provider --------------------------------------------

    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "Devbox",
      description: "A devbox in your Incus project on bertha, on your tailnet. You sign it in to Tailscale once.",
      icon: "Server",
      ephemeral: false,
      inputs: machineInputsSchema,
      async availability() {
        const cfg = await settings.get();
        if ((cfg.token?.trim() ?? "") === "") {
          return { status: "setup-required", message: "Connect devbox in Settings → Plugins → Devbox machines." };
        }
        // Core gives this check 10 s and refuses a create on anything but
        // available. A slow answer is not a no: a cold connection, or the
        // first request after devbox-gate restarts (which trusts a fresh
        // certificate into Incus), can take seconds. Only a definite refusal
        // reports unavailable; a create that then cannot reach devbox fails
        // with the real error in its log.
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new Error("timed out")), AVAILABILITY_TIMEOUT_MS);
        const signal = deadline.signal;
        try {
          const { incus } = await connection(signal);
          await incus.ping(signal);
          return { status: "available" };
        } catch (error) {
          if (signal.aborted) {
            bb.log.warn(`devbox did not answer the availability check within ${AVAILABILITY_TIMEOUT_MS} ms`);
            return { status: "available" };
          }
          return { status: "unavailable", message: errorMessage(error) };
        } finally {
          clearTimeout(timer);
        }
      },
      async validate() {
        const cfg = await settings.get();
        if ((cfg.token?.trim() ?? "") === "") {
          return { action: "refuse", message: "Connect devbox in Settings → Plugins → Devbox machines first." };
        }
        return { action: "accept" };
      },
      async create({ inputs, key, checkpoint, report, signal }) {
        try {
          const { incus, project, cfg } = await connection(signal);
          const name = inputs.name ?? defaultMachineName(key);
          report.step("Creating the devbox");
          const existing = await incus.getInstance(name, signal);
          if (existing !== null) {
            if (existing.config[KEY_CONFIG] !== key) {
              return { status: "failed", message: `A machine named ${name} already exists in project ${project}.` };
            }
            report.log(`reusing ${name}\n`);
            if (existing.status !== "Running") await incus.setState(name, "start", signal);
          } else {
            const image = inputs.image ?? cfg.image;
            const profiles = cfg.profiles.split(",").map((p) => p.trim()).filter((p) => p !== "");
            await incus.createInstance(
              { name, image, profiles, config: { [KEY_CONFIG]: key, "user.bb.managed-by": bb.pluginId } },
              signal,
            );
            report.log(`created ${name} from ${image} in project ${project}\n`);
          }
          const resource: MachineResource = { name, key, project };
          await checkpoint(resource);
          await prepare(incus, name, report, signal);
          await joinTailnet(incus, name, cfg.signInTimeoutMinutes, report, signal);
          await waitForServer(incus, name, report, signal);
          await bootstrap(incus, resource, report, signal);
          return { status: "created", name, resource };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        } finally {
          bb.realtime.publish(MACHINES_CHANGED, { key });
        }
      },
      async reconcileCleanup({ key, signal }) {
        try {
          const { incus } = await connection(signal);
          for (const instance of await incus.listInstances(signal)) {
            if (instance.config[KEY_CONFIG] === key) await stopAndDelete(incus, instance.name, signal);
          }
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
      async suspend({ resource, checkpoint, report, signal }) {
        const owned = resourceSchema.parse(resource);
        const { incus } = await connection(signal);
        await checkpoint(owned);
        const instance = await incus.getInstance(owned.name, signal);
        if (instance !== null && instance.status === "Running") {
          report.step("Stopping the devbox");
          await incus.setState(owned.name, "stop", signal);
        }
        return { resource: owned };
      },
      async resume({ resource, checkpoint, report, signal }) {
        const owned = resourceSchema.parse(resource);
        const { incus, cfg } = await connection(signal);
        const instance = await incus.getInstance(owned.name, signal);
        if (instance === null) throw new Error(`${owned.name} no longer exists; remove this machine and create another`);
        if (instance.status !== "Running") {
          report.step("Starting the devbox");
          await incus.setState(owned.name, "start", signal);
        }
        await checkpoint(owned);
        await prepare(incus, owned.name, report, signal);
        await joinTailnet(incus, owned.name, cfg.signInTimeoutMinutes, report, signal);
        await waitForServer(incus, owned.name, report, signal);
        await bootstrap(incus, owned, report, signal);
        return { resource: owned };
      },
      async remove({ resource, report, signal }) {
        try {
          const owned = resourceSchema.parse(resource as PluginMachineProviderResource);
          const { incus } = await connection(signal);
          await stopAndDelete(incus, owned.name, signal);
          await bb.storage.kv.delete(`signin/${owned.name}`);
          report.log(`deleted ${owned.name}\n`);
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
    });
  };
}

export default createDevboxProviderPlugin({
  incusFactory: (cfg) => createIncusClient(cfg),
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: defaultSleep,
});
