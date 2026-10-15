import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";

const source = ts.transpileModule(await readFile(new URL("./image-copy.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(write = async () => {}) {
  const dom = new JSDOM('<body><a href="https://example.test/outside.png">Outside chat</a><div data-message-column><a href="https://example.test/one.png">Graph one<svg data-icon="ExternalLink"></svg></a><a href="https://example.test/two.png">Graph two<svg data-icon="ExternalLink"></svg></a><a href="https://example.test/results.md">Results</a><img data-markdown-image src="https://example.test/inline.png"><button class="cursor-zoom-in"><img></button></div></body>');
  const { document, MutationObserver, AbortController, navigator } = dom.window;
  Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
  const exports = {};
  const fetches = [];
  const png = new Blob(["image pixels"], { type: "image/png" });
  vm.runInNewContext(source, {
    document, MutationObserver, navigator, exports, URL, Blob, atob,
    ClipboardItem: class { constructor(data) { this.data = data; } },
    fetch: async (src) => { fetches.push(src); return { ok: true, blob: async () => png }; },
  });
  const controller = new AbortController();
  const dispose = exports.mountImageCopyButtons({ signal: controller.signal });
  return { dom, document, navigator, controller, dispose, fetches, png, exports };
}

test("copy sits after each image link's external-link icon and copies that image without navigation", async () => {
  const writes = [];
  const f = fixture(async (items) => { writes.push(items); await items[0].data["image/png"]; });
  try {
    const links = f.document.querySelectorAll('[data-message-column] a[href$=".png"]');
    const buttons = f.document.querySelectorAll('[aria-label="Copy image"]');
    assert.equal(buttons.length, 2);
    for (const link of links) {
      assert.equal(link.lastElementChild.dataset.icon, "ExternalLink");
      assert.equal(link.nextElementSibling.dataset.bbPlugin, "image-copy");
      assert.equal(link.nextElementSibling.firstElementChild.closest("a"), null);
    }
    let navigated = false;
    links[1].onclick = () => { navigated = true; };
    buttons[1].click();
    assert.equal(writes.length, 1);
    assert.equal(buttons[1].disabled, true);
    await tick();
    assert.equal(await writes[0][0].data["image/png"], f.png);
    assert.deepEqual(f.fetches, ["https://example.test/two.png"]);
    assert.equal(buttons[1].nextElementSibling.textContent, "Copied");
    assert.equal(buttons[1].disabled, false);
    assert.equal(navigated, false);
  } finally { f.controller.abort(); f.dispose(); f.dom.window.close(); }
});

test("handles streamed links, href changes, rerenders, and cleanup without duplicate controls", async () => {
  const f = fixture();
  try {
    const column = f.document.querySelector("[data-message-column]");
    column.insertAdjacentHTML("beforeend", '<a href="file:///workspace/three.png">Graph three</a>');
    await tick();
    assert.equal(f.document.querySelectorAll("[data-image-copy]").length, 3);
    column.querySelector('a[href$="three.png"]').href = "file:///workspace/results.md";
    await tick();
    assert.equal(f.document.querySelectorAll("[data-image-copy]").length, 2);
    column.innerHTML = '<a href="https://example.test/new.png">New graph</a>';
    await tick();
    assert.equal(f.document.querySelectorAll("[data-image-copy]").length, 1);
    column.querySelector("[data-image-copy]").remove();
    await tick();
    assert.equal(f.document.querySelectorAll("[data-image-copy]").length, 1);
    f.controller.abort();
    f.dispose();
    column.insertAdjacentHTML("beforeend", '<a href="https://example.test/late.png">Late</a>');
    await tick();
    assert.equal(f.document.querySelectorAll("[data-image-copy]").length, 0);
  } finally { f.dom.window.close(); }
});

test("unrelated page changes and our own controls do not rescan chat links", async () => {
  const f = fixture();
  try {
    let scans = 0;
    const query = f.document.querySelectorAll.bind(f.document);
    f.document.querySelectorAll = (...args) => { scans++; return query(...args); };
    await tick(); // Initial control insertions must be ignored.
    assert.equal(scans, 0);
    f.document.body.insertAdjacentHTML("beforeend", '<div id="monaco"><span>Editor update</span><a href="https://example.test/unrelated.png">Outside chat</a></div>');
    await tick();
    assert.equal(scans, 0);
    f.document.querySelector('[aria-label="Copy image"]').click();
    await tick(); // Clipboard status text is not a link mutation.
    assert.equal(scans, 0);
    const message = f.document.createElement("div");
    message.dataset.messageColumn = "";
    message.innerHTML = '<a href="https://example.test/new.png">Streamed graph</a>';
    f.document.body.append(message);
    await tick();
    assert.equal(scans, 1);
    assert.ok(message.querySelector('[aria-label="Copy image"]'));
    message.remove();
    await tick();
    assert.equal(scans, 2);
  } finally { f.controller.abort(); f.dispose(); f.dom.window.close(); }
});

test("reports rejected and unavailable clipboard access without claiming success", async () => {
  const f = fixture(async () => { throw new Error("Permission denied"); });
  try {
    const button = f.document.querySelector('[aria-label="Copy image"]');
    button.click();
    await tick();
    assert.match(button.nextElementSibling.textContent, /Copy failed/);
    assert.equal(button.disabled, false);
    Object.defineProperty(f.navigator, "clipboard", { value: undefined });
    button.click();
    assert.match(button.nextElementSibling.textContent, /unavailable/);
  } finally { f.controller.abort(); f.dispose(); f.dom.window.close(); }
});

test("local image links use the owning workspace host or thread storage with a confined file read", async () => {
  const f = fixture();
  try {
    const reads = [];
    const sdk = {
      threads: {
        storageLocation: async () => ({ hostId: "storage-host", storageRootPath: "/storage/thread" }),
        get: async () => ({ environmentId: "environment" }),
      },
      environments: { get: async () => ({ hostId: "workspace-host", path: "/workspace" }) },
      files: { read: async (args) => { reads.push(args); return { content: btoa("pixels"), contentEncoding: "base64", mimeType: "image/png" }; } },
    };
    const signal = f.controller.signal;
    const blob = await f.exports.readLinkedImage(sdk, "thread", "file:///workspace/graph%20one.png", signal);
    assert.equal(await blob.text(), "pixels");
    assert.equal(blob.type, "image/png");
    assert.equal(reads[0].path, "/workspace/graph one.png");
    assert.equal(reads[0].hostId, "workspace-host");
    assert.equal(reads[0].rootPath, "/workspace");
    await f.exports.readLinkedImage(sdk, "thread", "file:///storage/thread/graph.png", signal);
    assert.equal(reads[1].hostId, "storage-host");
    assert.equal(reads[1].rootPath, "/storage/thread");
    sdk.files.read = async () => { throw new Error("Path escapes read root"); };
    await assert.rejects(f.exports.readLinkedImage(sdk, "thread", "file:///outside/graph.png", signal), /escapes read root/);
  } finally { f.controller.abort(); f.dispose(); f.dom.window.close(); }
});
