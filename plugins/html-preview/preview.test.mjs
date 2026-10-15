import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("HTML toolbar renders from source, survives file changes, and cleans up", async () => {
  const dom = new JSDOM('<body><div id="toolbar"><div><button aria-label="Open in editor">Open</button></div><div><div role="tablist" aria-label="HTML view mode"><button>Preview</button><button>Raw</button></div></div></div></body>');
  try {
    const { document, MutationObserver, AbortController } = dom.window;
    const exports = {};
    vm.runInNewContext(ts.transpileModule(await readFile(new URL("./preview.ts", import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, { document, MutationObserver, exports });
    const controller = new AbortController();
    const dispose = exports.mountPreviewButtons({ signal: controller.signal });
    const tabs = document.querySelector('[role="tablist"]');
    const open = document.querySelector('[aria-label="Open in editor"]');
    let rendered = 0;
    tabs.firstElementChild.addEventListener("click", () => rendered++);
    const button = document.querySelector('[data-html-preview]');
    assert.equal(open.nextElementSibling, button);
    assert.equal(button.getAttribute("aria-label"), "Render HTML preview");
    button.click();
    assert.equal(rendered, 1);
    tabs.innerHTML = '<button>Preview</button><button>Raw</button>';
    tabs.firstElementChild.addEventListener("click", () => rendered++);
    await Promise.resolve();
    assert.equal(document.querySelectorAll('[data-html-preview]').length, 1);
    button.click();
    assert.equal(rendered, 2);
    tabs.setAttribute("aria-label", "Markdown view mode");
    await Promise.resolve();
    assert.equal(document.querySelector('[data-html-preview]'), null);
    tabs.setAttribute("aria-label", "HTML view mode");
    await Promise.resolve();
    assert.equal(document.querySelectorAll('[data-html-preview]').length, 1);
    controller.abort();
    dispose();
    tabs.append(document.createElement("span"));
    await Promise.resolve();
    assert.equal(document.querySelector('[data-html-preview]'), null);
  } finally {
    dom.window.close();
  }
});
