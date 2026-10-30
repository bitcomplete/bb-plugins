// The Incus API, as devbox-gate serves it to a connected client.
//
// devbox-gate's API listener takes a bearer token and forwards each request
// to Incus with the developer's own restricted certificate, so this client
// speaks plain Incus REST and WebSocket and never holds an Incus credential.
// Incus confines every call to the developer's project; `project` is passed
// anyway because Incus otherwise assumes `default`.
import WebSocket from "ws";

export interface IncusConfig {
  // devbox-gate's API listener, e.g. http://devbox-gate.devbox-production.svc.cluster.local:8081
  apiUrl: string;
  token: string;
  project: string;
}

export interface Instance {
  name: string;
  status: string; // "Running", "Stopped", ...
  config: Record<string, string>;
  // Present only on the recursion=2 listing, which embeds each instance's
  // live state alongside its config.
  state?: InstanceState;
}

// The subset of Incus's instance state this plugin reads. Every field is
// optional because the shape varies with the instance's status and with the
// Incus version behind devbox-gate.
export interface InstanceState {
  status?: string;
  status_code?: number;
  cpu?: { usage?: number };
  memory?: { usage?: number; usage_peak?: number; total?: number; swap_usage?: number };
  disk?: Record<string, { usage?: number; total?: number }>;
  network?: Record<string, { counters?: { bytes_received?: number; bytes_sent?: number } }>;
  processes?: number;
  started_at?: string;
}

// A project resource cap as Incus reports it: the sum of the instances'
// configured limits ("allocated"), not their live usage.
export interface ProjectResource {
  limit?: number;
  usage?: number;
}

export interface ProjectState {
  cpu?: ProjectResource;
  memory?: ProjectResource;
  disk?: ProjectResource;
  instances?: ProjectResource;
}

export interface CreateInstance {
  name: string;
  image: string;
  profiles: string[];
  config: Record<string, string>;
}

export interface ExecOptions {
  command: string[];
  environment: Record<string, string>;
  user: number;
  group: number;
  cwd: string;
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput: (chunk: string) => void;
}

export class IncusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Envelope {
  type?: string;
  status_code?: number;
  error_code?: number;
  error?: string;
  operation?: string;
  metadata?: unknown;
}

interface Operation {
  id: string;
  status_code: number;
  err?: string;
  metadata?: Record<string, unknown> | null;
}

export interface IncusClient {
  ping(signal: AbortSignal): Promise<void>;
  getInstance(name: string, signal: AbortSignal): Promise<Instance | null>;
  listInstances(signal: AbortSignal): Promise<Instance[]>;
  // One call that also embeds each instance's live state (recursion=2).
  listInstancesWithState(signal: AbortSignal): Promise<Instance[]>;
  // The project's allocated resources: resources.{cpu,memory,disk,instances}.{limit,usage}.
  getProjectState(signal: AbortSignal): Promise<ProjectState>;
  createInstance(spec: CreateInstance, signal: AbortSignal): Promise<void>;
  setState(name: string, action: "start" | "stop", signal: AbortSignal): Promise<void>;
  deleteInstance(name: string, signal: AbortSignal): Promise<void>;
  exec(name: string, options: ExecOptions): Promise<{ exitCode: number }>;
}

const OPERATION_WAIT_SECONDS = 600;

export function createIncusClient(cfg: IncusConfig, fetchImpl: typeof fetch = fetch): IncusClient {
  const base = cfg.apiUrl.replace(/\/+$/u, "");
  const auth = { authorization: `Bearer ${cfg.token}` };

  function url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(base + path);
    u.searchParams.set("project", cfg.project);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function call(
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<Envelope> {
    const response = await fetchImpl(url(path, query), {
      method,
      headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      if (response.status === 401) {
        throw new IncusError("devbox refused the connection token; connect devbox again in the plugin settings", 401);
      }
      throw new IncusError(`devbox answered ${response.status}: ${text.trim().slice(0, 200)}`, response.status);
    }
    if (!response.ok || env.type === "error") {
      const status = env.error_code ?? response.status;
      throw new IncusError(`incus: ${env.error ?? "request failed"} (${status})`, status);
    }
    return env;
  }

  // Waits for an async operation and returns its final state. A failed
  // operation throws with Incus's own message.
  async function wait(env: Envelope, signal: AbortSignal): Promise<Operation> {
    const opPath = env.operation;
    if (typeof opPath !== "string" || opPath === "") {
      throw new IncusError("incus returned no operation for an async request", 500);
    }
    const id = opPath.split("/").pop() ?? "";
    for (;;) {
      const done = await call("GET", `/1.0/operations/${encodeURIComponent(id)}/wait`, signal, undefined, {
        timeout: String(OPERATION_WAIT_SECONDS),
      });
      const op = done.metadata as Operation;
      // 103 Running, 105 Pending: the wait timed out with work left.
      if (op.status_code === 103 || op.status_code === 105) continue;
      if (op.status_code !== 200) {
        throw new IncusError(`incus: ${op.err || `operation ended with status ${op.status_code}`}`, op.status_code);
      }
      return op;
    }
  }

  return {
    async ping(signal) {
      await call("GET", "/1.0", signal);
    },
    async getInstance(name, signal) {
      try {
        const env = await call("GET", `/1.0/instances/${encodeURIComponent(name)}`, signal);
        return toInstance(env.metadata);
      } catch (error) {
        if (error instanceof IncusError && error.status === 404) return null;
        throw error;
      }
    },
    async listInstances(signal) {
      const env = await call("GET", "/1.0/instances", signal, undefined, { recursion: "1" });
      return Array.isArray(env.metadata) ? env.metadata.map(toInstance) : [];
    },
    async listInstancesWithState(signal) {
      const env = await call("GET", "/1.0/instances", signal, undefined, { recursion: "2" });
      return Array.isArray(env.metadata) ? env.metadata.map(toInstance) : [];
    },
    async getProjectState(signal) {
      const env = await call("GET", `/1.0/projects/${encodeURIComponent(cfg.project)}/state`, signal);
      const metadata = (env.metadata ?? {}) as { resources?: ProjectState };
      return metadata.resources ?? {};
    },
    async createInstance(spec, signal) {
      const env = await call("POST", "/1.0/instances", signal, {
        name: spec.name,
        type: "container",
        source: { type: "image", alias: spec.image },
        profiles: spec.profiles,
        config: spec.config,
        start: true,
      });
      await wait(env, signal);
    },
    async setState(name, action, signal) {
      const env = await call("PUT", `/1.0/instances/${encodeURIComponent(name)}/state`, signal, {
        action,
        timeout: 30,
        force: action === "stop",
      });
      await wait(env, signal);
    },
    async deleteInstance(name, signal) {
      try {
        const env = await call("DELETE", `/1.0/instances/${encodeURIComponent(name)}`, signal);
        await wait(env, signal);
      } catch (error) {
        if (error instanceof IncusError && error.status === 404) return;
        throw error;
      }
    },
    async exec(name, options) {
      options.signal.throwIfAborted();
      const env = await call("POST", `/1.0/instances/${encodeURIComponent(name)}/exec`, options.signal, {
        command: options.command,
        environment: options.environment,
        "wait-for-websocket": true,
        interactive: false,
        user: options.user,
        group: options.group,
        cwd: options.cwd,
      });
      const op = env.metadata as Operation;
      const fds = (op.metadata?.fds ?? {}) as Record<string, string>;
      if (!fds["0"] || !fds["1"] || !fds["2"] || !fds.control) {
        throw new IncusError("incus returned no exec websockets", 500);
      }
      const wsUrl = (secret: string) => {
        const u = new URL(url(`/1.0/operations/${encodeURIComponent(op.id)}/websocket`, { secret }));
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        return u.toString();
      };
      await streamExec(
        { stdin: wsUrl(fds["0"]), stdout: wsUrl(fds["1"]), stderr: wsUrl(fds["2"]), control: wsUrl(fds.control) },
        auth,
        options,
      );
      const done = await wait(env, options.signal);
      const ret = done.metadata?.return;
      if (typeof ret !== "number") throw new IncusError("incus reported no exit code", 500);
      return { exitCode: ret };
    },
  };
}

function toInstance(raw: unknown): Instance {
  const m = (raw ?? {}) as {
    name?: string;
    status?: string;
    config?: Record<string, string>;
    state?: InstanceState;
  };
  const instance: Instance = { name: m.name ?? "", status: m.status ?? "", config: m.config ?? {} };
  if (m.state !== undefined) instance.state = m.state;
  return instance;
}

// Runs the four exec websockets until stdout and stderr have both closed,
// which Incus does when the command's output ends. Incus starts the command
// only once every socket is connected. Stdin is written whole and then
// closed, which Incus turns into EOF: bb's bootstrap reads its enrollment
// bundle from stdin until EOF.
function streamExec(
  urls: { stdin: string; stdout: string; stderr: string; control: string },
  headers: Record<string, string>,
  options: ExecOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const open = (u: string) => new WebSocket(u, { headers, perMessageDeflate: false });
    const sockets = {
      control: open(urls.control),
      stdin: open(urls.stdin),
      stdout: open(urls.stdout),
      stderr: open(urls.stderr),
    };
    const all = Object.values(sockets);
    let outputsOpen = 2;
    let settled = false;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      for (const s of all) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.terminate();
      }
      if (error) {
        // Core redacts executor failures; leave the real reason in the log.
        options.onOutput(`[devbox-provider] exec failed: ${error.message}\n`);
        reject(error);
      } else resolve();
    };
    const onAbort = () =>
      finish(options.signal.reason instanceof Error ? options.signal.reason : new Error("exec aborted"));
    const timer = setTimeout(() => finish(new Error(`exec timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });

    for (const s of all) s.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));

    sockets.stdin.on("open", () => {
      if (options.stdin.length > 0) sockets.stdin.send(Buffer.from(options.stdin, "utf8"), { binary: true });
      sockets.stdin.close(1000);
    });
    for (const name of ["stdout", "stderr"] as const) {
      sockets[name].on("message", (raw) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        const text = decoders[name].decode(chunk, { stream: true });
        if (text.length > 0) options.onOutput(text);
      });
      sockets[name].on("close", () => {
        const tail = decoders[name].decode();
        if (tail.length > 0) options.onOutput(tail);
        outputsOpen -= 1;
        if (outputsOpen === 0) finish();
      });
    }
  });
}
