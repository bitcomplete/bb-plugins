import assert from "node:assert/strict";
import { test } from "node:test";
import { flushFile, flushFiles, reconcileFile, reloadFile, releaseFile, type FileModels } from "./file-models";

function model(text: string) {
  let disposed = false;
  return {
    getValue: () => text,
    setValue: (value: string) => { text = value; },
    dispose: () => { disposed = true; },
    isDisposed: () => disposed,
  };
}

function file() {
  return {
    original: model("old"), modified: model("base"), saved: "base", saving: Promise.resolve(),
    timer: undefined, listener: { dispose() {} },
  } as unknown as FileModels;
}

test("conflict recovery preserves edits on normal refresh and deliberately reloads without writing them", async () => {
  const m = file();
  let disk = "external";
  const conflicts: boolean[] = [];
  let writes = 0;
  const callbacks = { current: {
    async save(_path: string, content: string, expected: string) {
      writes++;
      if (disk !== expected) throw new Error("file.ts changed on disk since it was loaded. Use Discard edit and reload.");
      disk = content;
    },
    onError() {},
    onConflict(_path: string, conflicted: boolean) { conflicts.push(conflicted); },
  } };
  m.modified.setValue("local edit");
  flushFile("file.ts", m, callbacks);
  await m.saving;
  assert.deepEqual(conflicts, [true]);
  reconcileFile(m, "old", disk);
  assert.equal(m.modified.getValue(), "local edit");
  assert.equal(m.saved, "base");
  // A queued save captured before the click must not put discarded text back.
  flushFile("file.ts", m, callbacks);
  m.timer = setTimeout(() => assert.fail("Discard must cancel autosave"), 1000);
  await reloadFile(m, async () => disk);
  assert.equal(writes, 1);
  assert.equal(m.modified.getValue(), "external");
  assert.equal(m.saved, "external");
  assert.equal(m.timer, undefined);
  assert.equal(m.reloading, false);
  m.modified.setValue("new edit after reload");
  flushFile("file.ts", m, callbacks);
  await m.saving;
  assert.equal(disk, "new edit after reload");
  assert.equal(conflicts.at(-1), false);
});

test("discard waits for an in-flight save and retains the edit if reading fails", async () => {
  const m = file();
  m.modified.setValue("local edit");
  let finish!: () => void;
  m.saving = new Promise<void>((resolve) => { finish = resolve; });
  let read = false;
  const reloading = reloadFile(m, async () => { read = true; throw new Error("Host unavailable"); });
  assert.equal(read, false);
  finish();
  await assert.rejects(reloading, /Host unavailable/);
  assert.equal(m.modified.getValue(), "local edit");
  assert.equal(m.saved, "base");
  assert.equal(m.reloading, false);
});

test("commit flush waits for saves and rejects unsaved or deleting files", async () => {
  const m = file();
  m.modified.setValue("pending");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const callbacks = { current: { save: async () => { await pending; }, onError() {} } };
  const models = new Map([["file.ts", m]]);
  const flushed = flushFiles(models, callbacks);
  assert.equal(m.saved, "base");
  finish();
  await flushed;
  assert.equal(m.saved, "pending");
  m.modified.setValue("conflict");
  callbacks.current.save = async () => { throw new Error("Changed on disk"); };
  await assert.rejects(flushFiles(models, callbacks), /Save all editor changes/);
  m.deleting = true;
  await assert.rejects(flushFiles(models, callbacks), /file action/);
});

test("queued saves use the preceding saved value and recover after a conflict", async () => {
  const m = file();
  const calls: string[][] = [];
  const errors: (string | null)[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const callbacks = { current: {
    async save(path: string, content: string, expected: string) {
      calls.push([path, content, expected]);
      if (content === "first") await pending;
      if (content === "conflict") throw new Error("changed on disk");
    },
    onError: (message: string | null) => errors.push(message),
  } };
  m.modified.setValue("first");
  flushFile("file.ts", m, callbacks);
  m.modified.setValue("second");
  flushFile("file.ts", m, callbacks);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  finish();
  await m.saving;
  assert.deepEqual(calls, [["file.ts", "first", "base"], ["file.ts", "second", "first"]]);
  assert.equal(m.saved, "second");
  m.modified.setValue("conflict");
  flushFile("file.ts", m, callbacks);
  await m.saving;
  assert.equal(m.saved, "second");
  assert.equal(errors.at(-1), "changed on disk");
  m.modified.setValue("recovered");
  flushFile("file.ts", m, callbacks);
  await m.saving;
  assert.deepEqual(calls.at(-1), ["file.ts", "recovered", "second"]);
  assert.equal(errors.at(-1), null);
});

test("reconciliation updates clean models and preserves unsaved edits", () => {
  const m = file();
  reconcileFile(m, "new original", "external");
  assert.equal(m.original.getValue(), "new original");
  assert.equal(m.modified.getValue(), "external");
  assert.equal(m.saved, "external");
  m.modified.setValue("local edit");
  reconcileFile(m, "new original", "another external edit");
  assert.equal(m.modified.getValue(), "local edit");
  assert.equal(m.saved, "external");
  reconcileFile(m, "new original", "local edit");
  assert.equal(m.saved, "local edit");
});

test("release flushes a pending edit before disposing its models", async () => {
  const m = file();
  let detached = false;
  m.listener.dispose = () => { detached = true; };
  m.modified.setValue("pending");
  m.timer = setTimeout(() => assert.fail("Pending debounce must be cancelled"), 1000);
  const calls: string[][] = [];
  releaseFile("file.ts", m, { current: {
    async save(path, content, expected) { calls.push([path, content, expected]); }, onError() {},
  } });
  await m.saving;
  assert.deepEqual(calls, [["file.ts", "pending", "base"]]);
  assert.equal(m.timer, undefined);
  assert.ok(detached && m.original.isDisposed() && m.modified.isDisposed());
});
