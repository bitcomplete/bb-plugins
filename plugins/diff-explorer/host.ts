import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals, type Location } from "./contract";

const TS = ["npx", "--yes", "-p", "typescript", "-p", "typescript-language-server", "typescript-language-server", "--stdio"];

// [command, { extension: LSP languageId }]
const SERVER_GROUPS: [string[], Record<string, string>][] = [
  [TS, { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact" }],
  [TS, { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" }],
  [["gopls"], { ".go": "go" }],
  [["rust-analyzer"], { ".rs": "rust" }],
  [["pyright-langserver", "--stdio"], { ".py": "python", ".pyi": "python" }],
  [["clangd"], { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp" }],
  [["sourcekit-lsp"], { ".swift": "swift" }],
];
const SERVERS = Object.fromEntries(
  SERVER_GROUPS.flatMap(([cmd, exts]) => Object.entries(exts).map(([ext, languageId]) => [ext, { cmd, languageId }])),
);

const REQUEST_TIMEOUT_MS = 60_000;

type Message = { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message: string } };

class LanguageServer {
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private documents = new Map<string, { version: number; text: string }>();
  readonly ready: Promise<unknown>;
  exited = false;

  constructor(cmd: string[], root: string) {
    this.child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", () => this.fail(new Error(`${cmd[0]} exited`)));
    this.child.on("error", (error) => this.fail(error));
    const rootUri = pathToFileURL(root).href;
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: {
        textDocument: { definition: { linkSupport: true }, synchronization: {} },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
    }).then(() => this.notify("initialized", {}));
  }

  async open(file: string, languageId: string) {
    await this.ready;
    const uri = pathToFileURL(file).href;
    const text = await readFile(file, "utf8");
    const open = this.documents.get(uri);
    if (open === undefined) {
      this.documents.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    } else if (open.text !== text) {
      open.version += 1;
      open.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: open.version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  async definition(file: string, line: number, column: number, languageId: string): Promise<Location[]> {
    const uri = await this.open(file, languageId);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    });
    const items = result === null ? [] : Array.isArray(result) ? result : [result];
    return items
      .map((item: any) => ({ uri: item.targetUri ?? item.uri, range: item.targetSelectionRange ?? item.range }))
      .filter((item) => item.uri.startsWith("file:"))
      .map((item) => ({
        path: fileURLToPath(item.uri),
        line: item.range.start.line + 1,
        column: item.range.start.character + 1,
      }));
  }

  dispose() {
    this.child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: object) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin!.write(body);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())![1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const message: Message = JSON.parse(this.buffer.subarray(start, start + length).toString("utf8"));
      this.buffer = this.buffer.subarray(start + length);
      this.onMessage(message);
    }
  }

  private onMessage(message: Message) {
    if (message.method !== undefined) {
      if (message.id === undefined) return;
      const result = message.method === "workspace/configuration" ? message.params.items.map(() => null) : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (pending === undefined) return;
    this.pending.delete(message.id as number);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result ?? null);
  }

  private fail(error: Error) {
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

// ponytail: servers live as long as the host worker (idle-stopped after 5 min); add a retainWorker lease if cold starts hurt
const servers = new Map<string, LanguageServer>();

function serverFor(root: string, cmd: string[]) {
  const key = `${root}\0${cmd.join(" ")}`;
  let server = servers.get(key);
  if (server === undefined || server.exited) {
    server = new LanguageServer(cmd, root);
    servers.set(key, server);
  }
  return server;
}

// ponytail: one watcher per workspace root for the worker's lifetime; dispose idle roots if watcher count matters
const watches = new Map<string, Promise<{ dispose(): Promise<void> }>>();

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async watch({ root }, context) {
      if (!watches.has(root)) {
        const watch = context.experimental_watch(
          { rootPath: root, ignoredPaths: ["node_modules", ".git/objects"], debounceMs: 500, maxWaitMs: 2000 },
          (event) => (event.kind === "watch-error" ? undefined : context.experimental_emitSignal("changed", { root })),
        );
        watches.set(root, watch);
        watch.catch(() => watches.delete(root));
      }
      await watches.get(root);
      return null;
    },
    async definition({ root, path: file, line, column }) {
      const spec = SERVERS[path.extname(file).toLowerCase()];
      if (spec === undefined) return { locations: [] };
      const locations = await serverFor(root, spec.cmd).definition(file, line, column, spec.languageId);
      return { locations };
    },
    // Opens one file per language server so it indexes the project before the first click.
    async warm({ root, paths }) {
      const first = new Map<string[], [string, string]>();
      for (const file of paths) {
        const spec = SERVERS[path.extname(file).toLowerCase()];
        if (spec !== undefined && !first.has(spec.cmd)) first.set(spec.cmd, [file, spec.languageId]);
      }
      await Promise.all([...first].map(([cmd, [file, languageId]]) => serverFor(root, cmd).open(file, languageId)));
      return null;
    },
    async read({ path: file }) {
      return { content: await readFile(file, "utf8") };
    },
  },
  async dispose() {
    for (const server of servers.values()) server.dispose();
    servers.clear();
    await Promise.all([...watches.values()].map((watch) => watch.then((w) => w.dispose(), () => undefined)));
    watches.clear();
  },
});
