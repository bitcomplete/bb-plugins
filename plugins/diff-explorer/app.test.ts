import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("Monaco initialization cleans up a failed attempt and retries a fresh URL while sharing success", async () => {
  const text = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("app.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "loadMonaco");
  assert.ok(fn);
  const links: { remove(): void }[] = [];
  const urls: string[] = [];
  let installed = 0;
  const bundle = {};
  const context = vm.createContext({
    bundlePromise: null, bundleAttempt: 0,
    document: {
      createElement: () => { const link = { remove() { links.splice(links.indexOf(link), 1); } }; return link; },
      head: { appendChild: (link: typeof links[number]) => links.push(link) },
    },
    installNavigation: () => installed++,
    importBundle: async (url: string) => {
      urls.push(url);
      if (urls.length === 1) throw new Error("Temporary network outage");
      return bundle;
    },
  });
  vm.runInContext(ts.transpileModule(fn.getText(source).replace("import(/* @vite-ignore */ ", "importBundle("), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const failed = context.loadMonaco("/assets", {});
  assert.equal(context.loadMonaco("/assets", {}), failed);
  await assert.rejects(failed, /Temporary network outage/);
  assert.equal(context.bundlePromise, null);
  assert.equal(links.length, 0);
  assert.equal(await context.loadMonaco("/assets", {}), bundle);
  assert.equal(await context.loadMonaco("/assets", {}), bundle);
  assert.deepEqual(urls, ["/assets/editor.js", "/assets/editor.js?retry=1"]);
  assert.equal(links.length, 1);
  assert.equal(installed, 1);
});

test("refresh keeps the editor data mounted and ignores superseded loads", async () => {
  // Exercise the panel's actual loading callbacks without a DOM or another test framework.
  const text = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("app.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panel = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DiffsPanel");
  assert.ok(panel?.body);
  const callbacks = panel.body.statements.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ["useEffect", "useRealtime"].includes(node.expression.expression.getText(source))).slice(0, 3);
  const effects: (() => void | (() => void))[] = [];
  const loads: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  let changed: (payload: unknown) => void;
  let data: unknown = null;
  let error: unknown = null;
  let reload = 0;
  let stack: unknown = ["definition"];
  const context = vm.createContext({
    threadId: "thread", target: "uncommitted", reload,
    rpc: { call: (method: string) => method === "assets" ? Promise.resolve({ baseUrl: "/assets" })
      : new Promise((resolve, reject) => loads.push({ resolve, reject })) },
    loadMonaco: async () => ({}),
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useRealtime: (_name: string, callback: typeof changed) => { changed = callback; },
    setBundle: () => {},
    setData: (value: unknown) => { data = typeof value === "function" ? value(data) : value; context.data = data; },
    setError: (value: unknown) => { error = value; },
    setStack: (value: unknown) => { stack = value; },
    setReload: (update: (value: number) => number) => { reload = update(reload); },
  });
  vm.runInContext(ts.transpileModule(callbacks.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);

  effects[0](); // A new thread or target clears the old context.
  assert.equal(data, null);
  assert.equal((stack as unknown[]).length, 0);
  effects[1]();
  const initial = { root: "/workspace", files: [] };
  loads[0].resolve(initial);
  await setImmediate();
  assert.equal(data, initial);

  changed!({ root: "/other" });
  assert.equal(reload, 0);
  changed!({ root: "/workspace" });
  assert.equal(reload, 1);
  assert.equal(loads.length, 1); // The event only requests a reload; the effect owns loading.
  const cancel = effects[1]() as () => void;
  assert.equal(data, initial);
  cancel();
  effects[1]();
  const latest = { root: "/workspace", files: ["latest"] };
  loads[2].resolve(latest);
  await setImmediate();
  loads[1].reject(new Error("obsolete error"));
  await setImmediate();
  assert.equal(data, latest);
  assert.equal(error, null);

  const cancelOlder = effects[1]() as () => void;
  cancelOlder();
  effects[1]();
  loads[4].resolve(latest);
  loads[3].resolve(initial);
  await setImmediate();
  assert.equal(data, latest);
});

test("issue reports save bounded diagnostics to the inbox without sending thread messages", async () => {
  const text = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("app.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panel = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DiffsPanel");
  const declaration = panel?.body?.statements.filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(source) === "reportIssue");
  assert.ok(declaration?.initializer);
  let saved: Record<string, any> | undefined;
  let status: string;
  const context = vm.createContext({
    reportStatus: "idle", pluginVersion: "test", threadId: "current-thread", target: "all", mode: "dark", name: "test-theme", error: null,
    data: { root: "/workspace", environmentId: "env", baseBranch: "main", skipped: [], files: Array.from({ length: 45 }, (_, i) => ({
      path: `file-${i}`, changeKind: "modified", oldText: "PRIVATE_CONTENT", newText: "PRIVATE_CONTENT",
    })) },
    root: { current: { clientWidth: 800, clientHeight: 600, querySelectorAll: () => [{ className: "line-insert" }] } },
    navigator: { userAgent: "test-browser" }, matchMedia: () => ({ matches: false }),
    window: { location: { origin: "https://example.test" } }, workerStatus: null,
    document: { querySelectorAll: () => [{ href: "https://example.test/editor.css?token=PRIVATE_TOKEN", sheet: {} }] }, URL,
    getComputedStyle: () => ({ backgroundColor: "rgba(155, 185, 85, 0.2)", getPropertyValue: () => "color" }),
    rpc: { call: async (method: string, setup: typeof saved) => {
      assert.equal(method, "report"); saved = setup;
      return { id: "saved-report", createdAt: "2026-10-06T00:00:00Z", threadId: "current-thread" };
    } },
    sdk: { threads: { send: () => { throw new Error("Reports must not send thread messages"); } } },
    setReportStatus: (value: string) => { status = value; }, setError: (error: unknown) => { throw error; },
  });
  const report = vm.runInContext(ts.transpileModule(`(${declaration.initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await report();
  assert.equal(saved?.threadId, "current-thread");
  const body = JSON.stringify(saved);
  assert.ok(!body.includes("PRIVATE_CONTENT") && !body.includes("PRIVATE_TOKEN"));
  const setup = JSON.parse(body);
  assert.equal(setup.files.length, 40);
  assert.equal(setup.fileCount, 45);
  assert.equal(setup.decorations[0].background, "rgba(155, 185, 85, 0.2)");
  assert.equal(status!, "saved");
});

test("worker restarts request fresh assets instead of the cached bundle URL", async () => {
  const text = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("app.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let getter: ts.PropertyAssignment | undefined;
  const find = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "getWorker") getter = node;
    ts.forEachChild(node, find);
  };
  find(source);
  assert.ok(getter);
  let calls = 0;
  const urls: string[] = [];
  const context = vm.createContext({
    baseUrl: "/expired", workerStatus: null, URL, window: { location: { origin: "https://example.test" } },
    rpc: { call: async (method: string, input: unknown) => {
      assert.equal(method, "assets"); assert.equal(input, null);
      return { baseUrl: `/fresh-${++calls}` };
    } },
    Worker: class {
      constructor(url: URL) { urls.push(url.href); }
      addEventListener() {}
    },
  });
  const getWorker = vm.runInContext(ts.transpileModule(`(${getter.initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await getWorker();
  await getWorker();
  assert.deepEqual(urls, ["https://example.test/fresh-1/editor.worker.js", "https://example.test/fresh-2/editor.worker.js"]);
});
