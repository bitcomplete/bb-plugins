import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals, type Location } from "./contract";
import { reviewCommit, finishCommit } from "./commit";

const TS = ["npx", "--yes", "--ignore-scripts", "-p", "typescript@5.9.3", "-p", "typescript-language-server@5.1.3", "typescript-language-server", "--stdio"];

// [command, { extension: LSP languageId }]
const SERVER_GROUPS: [string[], Record<string, string>][] = [
  [TS, { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" }],
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
    return this.synchronize(file, languageId, await readFile(file, "utf8"));
  }

  private synchronize(file: string, languageId: string, text: string) {
    const uri = pathToFileURL(file).href;
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

  async definition(file: string, line: number, column: number, languageId: string, content: string): Promise<Location[]> {
    await this.ready;
    // Keep synchronization and the request together so concurrent panels query their own text.
    const uri = this.synchronize(file, languageId, content);
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

// ponytail: serializes this worker's saves only; external writers need a shared locking protocol.
const writes = new Map<string, Promise<null>>();

async function mutateFile(key: string, mutate: () => Promise<null>) {
  const saving = (writes.get(key) ?? Promise.resolve(null)).catch(() => null).then(mutate);
  writes.set(key, saving);
  try {
    return await saving;
  } finally {
    if (writes.get(key) === saving) writes.delete(key);
  }
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the workspace or is its root`);
  }
  return relative;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async reviewCommit({ root, paths, snapshot }) { return reviewCommit(root, paths, snapshot); },
    async finishCommit({ root, paths, snapshot, messageFile, push }) { return finishCommit(root, paths, snapshot, messageFile, push); },
    async fileAction({ root, path: file, action }) {
      const relative = inside(path.resolve(root), path.resolve(file));
      const canonicalRoot = await realpath(root);
      // Validate the parent: unlink removes a symlink itself, never its target.
      const key = path.join(await realpath(path.dirname(file)), path.basename(file));
      inside(canonicalRoot, key);
      if (action === "delete") return mutateFile(key, async () => {
        await unlink(key); // Refuses directories; no recursive deletion.
        return null;
      });
      if (/[\r\n]/.test(relative)) throw new Error("Gitignore entries cannot contain newlines");
      const escape = (value: string) => value.replace(/[\\*?\[\] #!]/g, "\\$&");
      if (action.endsWith("-directory") && path.dirname(relative) === ".") throw new Error("Cannot ignore the whole workspace");
      let patternPath = relative;
      let ignore = path.join(canonicalRoot, ".gitignore");
      if (action.startsWith("ignore-local")) {
        const git = (args: string[]) => promisify(execFile)("git", ["-C", canonicalRoot, "rev-parse", ...args]);
        const [top, exclude] = await Promise.all([git(["--show-toplevel"]), git(["--git-path", "info/exclude"])]);
        const gitRoot = top.stdout.replace(/\r?\n$/, "");
        patternPath = inside(gitRoot, path.join(canonicalRoot, relative));
        // Ask Git for the path: linked worktrees use a .git file, not a directory.
        ignore = path.resolve(canonicalRoot, exclude.stdout.replace(/\r?\n$/, ""));
        await mkdir(path.dirname(ignore), { recursive: true });
      }
      const directory = path.dirname(patternPath);
      let pattern = `/${escape(patternPath)}`;
      if (action.endsWith("-directory")) {
        pattern = `/${escape(directory)}/`;
      } else if (action.endsWith("-extension")) {
        const extension = path.extname(patternPath);
        if (!extension) throw new Error("This file has no extension to ignore");
        pattern = `/${directory === "." ? "" : `${escape(directory)}/`}*${escape(extension)}`;
      }
      return mutateFile(ignore, async () => {
        // O_NOFOLLOW prevents an ignore-file symlink from redirecting the write.
        const handle = await open(ignore, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o666);
        try {
          const content = await handle.readFile("utf8");
          if (!content.split(/\r?\n/).includes(pattern)) {
            await handle.writeFile(`${content && !content.endsWith("\n") ? "\n" : ""}${pattern}\n`, "utf8");
          }
        } finally {
          await handle.close();
        }
        return null;
      });
    },
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
    async definition({ root, path: file, line, column, content }) {
      const spec = SERVERS[path.extname(file).toLowerCase()];
      if (spec === undefined) return { locations: [] };
      const locations = await serverFor(root, spec.cmd).definition(file, line, column, spec.languageId, content);
      return { locations };
    },
    // Opens one file per language server so it indexes the project before the first click.
    async warm({ root, paths }) {
      const warmed = new Set<LanguageServer>();
      await Promise.all(paths.map(async (file) => {
        const spec = SERVERS[path.extname(file).toLowerCase()];
        if (spec === undefined) return;
        const server = serverFor(root, spec.cmd);
        if (warmed.has(server)) return;
        warmed.add(server);
        await server.open(file, spec.languageId);
      }));
      return null;
    },
    async read({ path: file }) {
      return { content: await readFile(file, "utf8") };
    },
    async write({ path: file, content, expected }) {
      const key = await realpath(file);
      return mutateFile(key, async () => {
        if ((await readFile(key, "utf8")) !== expected) {
          throw new Error(`${path.basename(file)} changed on disk since it was loaded. Use “Discard edit and reload” to replace your edit with the disk version.`);
        }
        await writeFile(key, content, "utf8");
        return null;
      });
    },
  },
  async dispose() {
    for (const server of servers.values()) server.dispose();
    servers.clear();
    await Promise.all([...watches.values()].map((watch) => watch.then((w) => w.dispose(), () => undefined)));
    watches.clear();
  },
});
