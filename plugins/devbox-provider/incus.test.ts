import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createIncusClient } from "./incus.js";

// Just enough of devbox-gate's API listener in front of Incus: the
// operations and exec websockets, with the bearer checked on every request.
function fakeIncus() {
  const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  const sockets = new Map<string, WebSocket>();
  let execBody: any = null;
  let stdinReceived = "";
  let stdinEnded = false;
  let exitCode = 0;
  const instances = new Map<string, { status: string; config: Record<string, string>; state?: unknown }>();
  let projectState: unknown = {};
  let lastInstancesQuery: string | null = null;

  const reply = (res: any, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const asyncOp = (id: string, metadata: unknown = null) => ({
    type: "async",
    status_code: 100,
    operation: `/1.0/operations/${id}`,
    metadata: { id, status_code: 103, metadata },
  });

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization, body });
      if (req.headers.authorization !== "Bearer dbx_test") return reply(res, 401, { type: "error", error_code: 401, error: "unauthorized" });
      if (url.searchParams.get("project") !== "dylan") return reply(res, 403, { type: "error", error_code: 403, error: "wrong project" });
      const path = url.pathname;
      if (path === "/1.0") return reply(res, 200, { type: "sync", metadata: {} });
      if (path === "/1.0/instances" && req.method === "POST") {
        instances.set(body.name, { status: "Running", config: body.config });
        return reply(res, 202, asyncOp("create"));
      }
      if (path === "/1.0/instances" && req.method === "GET") {
        lastInstancesQuery = url.searchParams.get("recursion");
        return reply(res, 200, { type: "sync", metadata: [...instances].map(([name, i]) => ({ name, ...i })) });
      }
      if (path === "/1.0/projects/dylan/state" && req.method === "GET") {
        return reply(res, 200, { type: "sync", metadata: { resources: projectState } });
      }
      const inst = path.match(/^\/1\.0\/instances\/([^/]+)(\/.*)?$/u);
      if (inst) {
        const [, name, rest] = inst;
        if (rest === "/exec") {
          execBody = body;
          return reply(res, 202, asyncOp("exec", { fds: { "0": "s0", "1": "s1", "2": "s2", control: "sc" } }));
        }
        if (!instances.has(name)) return reply(res, 404, { type: "error", error_code: 404, error: "Instance not found" });
        if (req.method === "DELETE") {
          instances.delete(name);
          return reply(res, 202, asyncOp("delete"));
        }
        return reply(res, 200, { type: "sync", metadata: { name, ...instances.get(name) } });
      }
      const wait = path.match(/^\/1\.0\/operations\/([^/]+)\/wait$/u);
      if (wait) {
        const meta = wait[1] === "exec" ? { return: exitCode } : null;
        return reply(res, 200, { type: "sync", metadata: { id: wait[1], status_code: 200, metadata: meta } });
      }
      reply(res, 404, { type: "error", error_code: 404, error: "not found" });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== "Bearer dbx_test") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const secret = url.searchParams.get("secret") ?? "";
      sockets.set(secret, ws);
      if (secret === "s0") {
        ws.on("message", (d) => (stdinReceived += d.toString()));
        ws.on("close", () => (stdinEnded = true));
      }
      // Incus runs the command once all four are connected.
      if (sockets.size === 4) {
        setTimeout(() => {
          sockets.get("s1")!.send(Buffer.from(`out:${execBody.command.join(" ")}\n`));
          sockets.get("s2")!.send(Buffer.from("err\n"));
          // Output ends after stdin has been read to EOF.
          const end = () => {
            sockets.get("s1")!.close();
            sockets.get("s2")!.close();
          };
          if (stdinEnded) end();
          else sockets.get("s0")!.on("close", end);
        }, 5);
      }
    });
  });
  return {
    server,
    seen,
    instances,
    setInstanceState(name: string, state: unknown) {
      const instance = instances.get(name);
      if (instance !== undefined) instance.state = state;
    },
    setProjectState(state: unknown) {
      projectState = state;
    },
    get execBody() {
      return execBody;
    },
    get lastInstancesQuery() {
      return lastInstancesQuery;
    },
    get stdin() {
      return { received: stdinReceived, ended: stdinEnded };
    },
    setExit(code: number) {
      exitCode = code;
    },
    async listen() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close() {
      wss.close();
      server.close();
    },
  };
}

let fake: ReturnType<typeof fakeIncus>;
afterEach(() => fake?.close());

async function client(token = "dbx_test") {
  fake = fakeIncus();
  const apiUrl = await fake.listen();
  return createIncusClient({ apiUrl, token, project: "dylan" });
}

describe("exec", () => {
  it("streams output, delivers stdin with EOF, and returns the exit code", async () => {
    const incus = await client();
    fake.setExit(3);
    let output = "";
    const result = await incus.exec("box", {
      command: ["echo", "hi"],
      environment: { HOME: "/home/dev" },
      user: 1000,
      group: 1000,
      cwd: "/home/dev",
      stdin: '{"bundle":true}',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onOutput: (c) => (output += c),
    });
    expect(result.exitCode).toBe(3);
    expect(output).toContain("out:echo hi\n");
    expect(output).toContain("err\n");
    expect(fake.stdin).toEqual({ received: '{"bundle":true}', ended: true });
    expect(fake.execBody).toMatchObject({
      command: ["echo", "hi"],
      user: 1000,
      group: 1000,
      cwd: "/home/dev",
      interactive: false,
      "wait-for-websocket": true,
      environment: { HOME: "/home/dev" },
    });
  });

  it("refuses to start under an aborted signal", async () => {
    const incus = await client();
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(
      incus.exec("box", {
        command: ["true"],
        environment: {},
        user: 0,
        group: 0,
        cwd: "/",
        stdin: "",
        timeoutMs: 5000,
        signal: ac.signal,
        onOutput: () => {},
      }),
    ).rejects.toThrow("stop");
  });
});

describe("instances", () => {
  it("creates, reads, lists and deletes in the project, with the bearer", async () => {
    const incus = await client();
    const signal = new AbortController().signal;
    await incus.createInstance({ name: "box", image: "devbox", profiles: ["default", "devbox"], config: { "user.bb.key": "k" } }, signal);
    const create = fake.seen.find((s) => s.method === "POST" && s.path === "/1.0/instances");
    expect(create?.body).toMatchObject({
      name: "box",
      type: "container",
      source: { type: "image", alias: "devbox" },
      profiles: ["default", "devbox"],
      start: true,
    });
    expect((await incus.getInstance("box", signal))?.config["user.bb.key"]).toBe("k");
    expect(await incus.listInstances(signal)).toHaveLength(1);
    await incus.deleteInstance("box", signal);
    expect(await incus.getInstance("box", signal)).toBeNull();
    // Deleting what is gone is not an error.
    await incus.deleteInstance("box", signal);
    expect(fake.seen.every((s) => s.auth === "Bearer dbx_test")).toBe(true);
  });

  it("says to reconnect when devbox refuses the token", async () => {
    const incus = await client("dbx_wrong");
    await expect(incus.ping(new AbortController().signal)).rejects.toThrow(/unauthorized|connect devbox again/u);
  });

  it("lists instances with their live state and reads the project state", async () => {
    const incus = await client();
    const signal = new AbortController().signal;
    await incus.createInstance({ name: "box", image: "devbox", profiles: [], config: {} }, signal);
    fake.setInstanceState("box", {
      status: "Running",
      cpu: { usage: 1_000_000_000 },
      memory: { usage: 512, total: 1024 },
      disk: { root: { usage: 10, total: 100 } },
      network: { eth0: { counters: { bytes_received: 5, bytes_sent: 7 } } },
      processes: 9,
      started_at: "2026-10-20T17:00:00Z",
    });
    fake.setProjectState({
      cpu: { limit: 12, usage: 4 },
      memory: { limit: 48 * 1024 ** 3, usage: 16 * 1024 ** 3 },
      disk: { limit: 250 * 1024 ** 3, usage: 40 * 1024 ** 3 },
      instances: { limit: 6, usage: 2 },
    });

    const listed = await incus.listInstancesWithState(signal);
    expect(listed).toHaveLength(1);
    expect(listed[0].state).toMatchObject({ cpu: { usage: 1_000_000_000 }, processes: 9 });
    expect(fake.seen.find((s) => s.method === "GET" && s.path === "/1.0/instances")?.path).toBe("/1.0/instances");
    // recursion=2 is what asks Incus to embed the state.
    expect(fake.lastInstancesQuery).toBe("2");

    expect(await incus.getProjectState(signal)).toEqual({
      cpu: { limit: 12, usage: 4 },
      memory: { limit: 48 * 1024 ** 3, usage: 16 * 1024 ** 3 },
      disk: { limit: 250 * 1024 ** 3, usage: 40 * 1024 ** 3 },
      instances: { limit: 6, usage: 2 },
    });
    expect(fake.seen.some((s) => s.path === "/1.0/projects/dylan/state")).toBe(true);
  });
});
