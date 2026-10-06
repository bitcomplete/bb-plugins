import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

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
