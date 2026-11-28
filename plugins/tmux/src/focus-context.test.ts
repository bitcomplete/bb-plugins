// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFocus,
  detectSurface,
  isInOverlay,
  isInTextField,
} from "./focus-context";

const THREAD_COMPOSER = `
  <div data-app-composer="" data-app-composer-role="primary" data-promptbox-shell="">
    <form data-promptbox="">
      <div data-promptbox-editor-scroll="">
        <div data-promptbox-editor-content="">
          <div id="thread-detail-follow-up-composer" class="ProseMirror"
            contenteditable="true" role="textbox" aria-label="Reply">
            <p>Hello <span data-mention="" contenteditable="false">@thread</span></p>
          </div>
        </div>
      </div>
      <button type="submit" aria-label="Send">Send</button>
    </form>
  </div>`;

const NEW_THREAD_COMPOSER = `
  <div data-app-composer="" data-app-composer-role="primary" data-promptbox-shell="">
    <div data-composer-box="">
      <div id="root-compose-prompt" class="ProseMirror" contenteditable="true"
        role="textbox" aria-label="Ask anything"><p></p></div>
    </div>
    <div data-new-thread-footer=""><button type="button">Project</button></div>
  </div>`;

function paneActions(): string {
  return `
    <div data-thread-header-pane-actions="">
      <button type="button" aria-pressed="false" aria-label="Full Screen"></button>
      <button type="button" aria-label="Close pane"></button>
    </div>`;
}

function threadWindow(name: string): string {
  return `
    <div data-thread-window="">
      <header>${paneActions()}</header>
      <div data-page-scroll-viewport="">
        <div data-timeline-row-list="top-level">
          <div data-timeline-row-id="${name}-row-1" tabindex="-1">
            <p data-message-text="">Message in ${name}</p>
            <a href="https://example.com/docs">Docs link</a>
            <details><summary>Tool call</summary><pre>output</pre></details>
            <span tabindex="0" data-mention="">@someone</span>
          </div>
        </div>
        <div data-scroll-footer="">
          ${THREAD_COMPOSER}
          <button type="button" aria-label="Scroll to latest event"></button>
        </div>
      </div>
    </div>`;
}

function newThreadContent(): string {
  return `
    <header><p>New thread</p>${paneActions()}</header>
    <div data-pane-content="">${NEW_THREAD_COMPOSER}</div>`;
}

function pluginContent(inner = "<h1>Cascade</h1><button type=\"button\">Refresh</button>"): string {
  return `
    <header><p>Cascade</p><button type="button" aria-label="Close pane"></button></header>
    <div data-pane-content="">
      <div data-bb-plugin-root="" data-bb-plugin="cascade">${inner}</div>
    </div>`;
}

interface PaneOptions {
  focused?: boolean;
  hidden?: boolean;
  maximized?: boolean;
}

function splitPane(paneId: string, content: string, options: PaneOptions = {}): string {
  const attributes = [
    `data-split-pane-id="${paneId}"`,
    `data-focused="${options.focused ? "true" : "false"}"`,
    'tabindex="-1"',
    options.maximized ? 'data-maximized="true"' : "",
    options.hidden ? 'aria-hidden="true"' : "",
  ].join(" ");
  return `<div ${attributes}><div data-pane-focus-scrim=""></div>${content}</div>`;
}

function singlePane(content: string, paneId = "pane-1"): string {
  return `<div data-split-pane-id="${paneId}">${content}</div>`;
}

const SIDE_PANEL = `
  <div data-sidebar-split-container="">
    <div data-split-pane-id="pane-primary" data-focused="true">
      <section aria-label="Terminal" data-app-terminal="">
        <div class="xterm">
          <textarea class="xterm-helper-textarea" aria-label="Terminal input"></textarea>
        </div>
        <input type="text" aria-label="Find in terminal" />
      </section>
    </div>
    <div data-split-pane-id="pane-secondary" data-focused="false">
      <div data-app-browser="">
        <div role="region" aria-label="Browser navigation">
          <button type="button" aria-label="Reload"></button>
          <input type="text" aria-label="Address" />
        </div>
        <div data-browser-content=""></div>
      </div>
    </div>
    <div data-split-pane-id="pane-editor" data-focused="false">
      <div class="monaco-editor" role="code">
        <div class="overflow-guard">
          <div class="native-edit-context" tabindex="0"></div>
        </div>
      </div>
    </div>
  </div>`;

const SIDEBAR = `
  <div data-state="expanded" data-collapsible="" data-variant="sidebar" data-side="left">
    <div data-sidebar="panel">
      <div data-sidebar="sidebar">
        <button type="button" data-sidebar="trigger" aria-expanded="true"></button>
        <div data-sidebar="content">
          <div data-testid="app-sidebar-body">
            <div data-sidebar-windowed-item="">
              <div data-sidebar-rename-row="">
                <a href="/threads/thr_a" draggable="false"
                  data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="thr_a"
                  data-sidebar-rename-anchor="" aria-label="Open Thread A"></a>
                <span class="bb-thread-title" title="Thread A">Thread A</span>
                <button type="button" aria-label="Thread actions"></button>
              </div>
            </div>
            <div data-sidebar-windowed-item="">
              <div data-sidebar-rename-row="">
                <input aria-label="Rename thread" value="Thread B" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

function mountApp(mainContent: string, extra = ""): void {
  document.body.innerHTML = `
    <div data-testid="app-layout-root">
      ${SIDEBAR}
      <main>${mainContent}</main>
      ${SIDE_PANEL}
    </div>
    <div data-bb-plugin-app-overlays=""></div>
    ${extra}`;
}

function mountSplit(): void {
  mountApp(
    splitPane("pane-1", threadWindow("left"), { focused: true }) +
      splitPane("pane-2", newThreadContent()) +
      splitPane("pane-3", pluginContent()),
  );
}

function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`fixture has no ${selector}`);
  return element;
}

function setPathname(pathname: string): void {
  window.history.replaceState(null, "", pathname);
}

beforeEach(() => {
  document.body.innerHTML = "";
  setPathname("/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyFocus overlay", () => {
  beforeEach(mountSplit);

  it("is overlay everywhere while a dialog is open elsewhere in the document", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog" data-state="open" data-bb-portaled-overlay=""><input id="palette" role="combobox" /></div>',
    );
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("overlay");
    expect(classifyFocus(find("#thread-detail-follow-up-composer"))).toBe("overlay");
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("overlay");
    expect(classifyFocus(find("[data-sidebar-thread-id]"))).toBe("overlay");
    expect(classifyFocus(find("#palette"))).toBe("overlay");
    expect(classifyFocus(document.body)).toBe("overlay");
  });

  it("tells an element of the open dialog from the page behind it, which classifyFocus does not", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-radix-popper-content-wrapper=""><div role="dialog" data-state="open"><button id="card-button" type="button">Details</button></div></div>',
    );

    expect(isInOverlay(find("#card-button"))).toBe(true);
    expect(isInOverlay(find("#thread-detail-follow-up-composer"))).toBe(false);
    expect(isInOverlay(find(".xterm-helper-textarea"))).toBe(false);
    expect(isInOverlay(document.body)).toBe(false);
    expect(isInOverlay(null)).toBe(false);
    expect(isInOverlay(window)).toBe(false);
  });

  it("is overlay while an aria-modal element is open", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div aria-modal="true" data-state="open"><button type="button">Close</button></div>',
    );
    expect(classifyFocus(document.body)).toBe("overlay");
  });

  it("ignores closed and inert modals", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div role="dialog" aria-modal="true" data-state="closed" inert=""></div>
       <div role="dialog" data-state="closed"></div>
       <div inert=""><div role="dialog" data-state="open"></div></div>
       <div inert=""><div aria-modal="true"></div></div>`,
    );
    expect(classifyFocus(document.body)).toBe("normal");
    expect(classifyFocus(find("#thread-detail-follow-up-composer"))).toBe("typing");
  });

  it("is overlay inside a menu, and only there", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="menu" data-state="open"><div role="menuitem" tabindex="-1" id="rename">Rename</div></div>',
    );
    expect(classifyFocus(find("#rename"))).toBe("overlay");
    expect(classifyFocus(find('[role="menu"]'))).toBe("overlay");
    expect(classifyFocus(document.body)).toBe("normal");
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("normal");
  });

  it("is overlay inside a listbox", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="listbox"><div role="option" tabindex="-1" id="option">One</div></div>',
    );
    expect(classifyFocus(find("#option"))).toBe("overlay");
  });

  it("is overlay inside an alert dialog and inside a dialog without a state", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div role="alertdialog"><button type="button" id="confirm">Delete</button></div>
       <div role="dialog"><input id="dialog-input" /></div>`,
    );
    expect(classifyFocus(find("#confirm"))).toBe("overlay");
    expect(classifyFocus(find("#dialog-input"))).toBe("overlay");
    expect(classifyFocus(document.body)).toBe("normal");
  });

  it("is overlay inside a Radix popper wrapper", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-radix-popper-content-wrapper=""><div><button type="button" id="popper-button">Pick</button></div></div>',
    );
    expect(classifyFocus(find("#popper-button"))).toBe("overlay");
  });

  it("is overlay inside an overlay that bb portaled", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-bb-portaled-overlay=""><input id="portaled-input" /></div>',
    );
    expect(classifyFocus(find("#portaled-input"))).toBe("overlay");
  });
});

// TimelineSelectionMenu.tsx: a Radix popover that bb portals into a layer
// inside the conversation scroller whenever text is selected in one message.
// For text selected in the terminal, a file preview or the diff view bb 0.50.1
// renders the same menu without that layer, so it lands on the page body.
describe("classifyFocus with bb's selection menu", () => {
  const SELECTION_MENU = `
    <div data-radix-popper-content-wrapper="">
      <div role="dialog" data-state="open" data-bb-portaled-overlay="">
        <button type="button" id="add-to-chat">Add to chat</button>
      </div>
    </div>`;
  const OTHER_POPOVER = `
    <div data-radix-popper-content-wrapper="">
      <div role="dialog" data-state="open" data-bb-portaled-overlay="" aria-label="Notifications">
        <button type="button" id="mark-read">Mark all as read</button>
      </div>
    </div>`;

  beforeEach(mountSplit);

  function showSelectionMenu(): void {
    find("[data-page-scroll-viewport]").insertAdjacentHTML("afterbegin", SELECTION_MENU);
  }

  it("keeps classifying the page as usual while the menu is showing", () => {
    showSelectionMenu();

    expect(classifyFocus(document.body)).toBe("normal");
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("normal");
    expect(classifyFocus(find("#thread-detail-follow-up-composer"))).toBe("typing");
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("typing");
    expect(classifyFocus(find("[data-sidebar-thread-id]"))).toBe("sidebar");
  });

  it("is overlay on the menu's own button", () => {
    showSelectionMenu();

    expect(classifyFocus(find("#add-to-chat"))).toBe("overlay");
  });

  it("is overlay everywhere once a real dialog opens next to the menu", () => {
    showSelectionMenu();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog" data-state="open" data-bb-portaled-overlay=""></div>',
    );

    expect(classifyFocus(document.body)).toBe("overlay");
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("overlay");
  });

  it("keeps classifying the page as usual while the menu shows on the page body", () => {
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU);

    expect(classifyFocus(document.body)).toBe("normal");
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("normal");
    expect(classifyFocus(find("#thread-detail-follow-up-composer"))).toBe("typing");
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("typing");
    expect(classifyFocus(find("[data-sidebar-thread-id]"))).toBe("sidebar");
  });

  it("is overlay on the button of the menu on the page body", () => {
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU);

    expect(classifyFocus(find("#add-to-chat"))).toBe("overlay");
  });

  it.each([
    ["on the page body, where bb puts its other popovers", "body"],
    ["in the pane outside the conversation scroller", "[data-thread-window] header"],
  ])("still counts another popover %s as an open dialog", (_place, selector) => {
    find(selector).insertAdjacentHTML("beforeend", OTHER_POPOVER);

    expect(classifyFocus(document.body)).toBe("overlay");
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("overlay");
  });

  it("is overlay everywhere once another popover opens next to the menu on the page body", () => {
    document.body.insertAdjacentHTML("beforeend", SELECTION_MENU + OTHER_POPOVER);

    expect(classifyFocus(document.body)).toBe("overlay");
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("overlay");
  });

  it("still counts a dialog inside the conversation that is not a popover", () => {
    find("[data-page-scroll-viewport]").insertAdjacentHTML(
      "afterbegin",
      '<div role="dialog" data-state="open"></div>',
    );

    expect(classifyFocus(document.body)).toBe("overlay");
  });
});

describe("classifyFocus in the terminal, the browser toolbar and a frame", () => {
  beforeEach(mountSplit);

  it("is typing inside the terminal, including its text fields", () => {
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("typing");
    expect(classifyFocus(find('[aria-label="Find in terminal"]'))).toBe("typing");
    expect(classifyFocus(find("[data-app-terminal]"))).toBe("typing");
  });

  it("is typing inside a terminal that bb renders without its marker, as in the setup guide", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-onboarding="">
        <div class="xterm">
          <textarea id="sign-in-terminal" class="xterm-helper-textarea"></textarea>
        </div>
      </div>`,
    );
    expect(classifyFocus(find("#sign-in-terminal"))).toBe("typing");
  });

  it("is typing inside the embedded browser's toolbar, on its buttons as well", () => {
    expect(classifyFocus(find('[aria-label="Address"]'))).toBe("typing");
    expect(classifyFocus(find('[aria-label="Reload"]'))).toBe("typing");
  });

  it("is frame while an iframe is the active element", () => {
    const iframe = document.createElement("iframe");
    find('[data-split-pane-id="pane-3"]').append(iframe);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe);
    expect(classifyFocus(document.body)).toBe("frame");
    expect(classifyFocus(iframe)).toBe("frame");
    expect(classifyFocus(null)).toBe("frame");
  });

  it("is frame while a webview is the active element", () => {
    const webview = document.createElement("webview");
    document.body.append(webview);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(webview);
    expect(classifyFocus(document.body)).toBe("frame");
  });
});

describe("classifyFocus in the message box and other text fields", () => {
  beforeEach(mountSplit);

  it("is typing in the message box of a thread pane and of the New thread screen", () => {
    expect(classifyFocus(find("#thread-detail-follow-up-composer"))).toBe("typing");
    expect(classifyFocus(find("#root-compose-prompt"))).toBe("typing");
  });

  it("is typing on a non-editable chip inside the message box", () => {
    expect(classifyFocus(find("#thread-detail-follow-up-composer [data-mention]"))).toBe(
      "typing",
    );
  });

  it("is typing for a plain textarea inside a composer shell", () => {
    const shell = find("[data-app-composer]");
    shell.insertAdjacentHTML("beforeend", '<textarea id="plain-composer"></textarea>');
    expect(classifyFocus(find("#plain-composer"))).toBe("typing");
  });

  it("is typing for text fields outside the composer", () => {
    expect(classifyFocus(find('[aria-label="Rename thread"]'))).toBe("typing");
    const host = find("main");
    host.insertAdjacentHTML(
      "beforeend",
      `<textarea id="textarea"></textarea>
       <select id="select"><option>One</option></select>
       <input id="typeless" />
       <input id="text" type="text" />
       <input id="search" type="search" />
       <input id="url" type="url" />
       <input id="tel" type="tel" />
       <input id="email" type="email" />
       <input id="password" type="password" />
       <input id="number" type="number" />
       <input id="date" type="date" />
       <input id="unknown" type="made-up" />
       <div id="editable" contenteditable="true"><b id="editable-child">bold</b></div>
       <div id="plaintext" contenteditable="plaintext-only"></div>
       <div id="textbox" role="textbox" tabindex="0"></div>
       <div id="searchbox" role="searchbox" tabindex="0"></div>
       <button id="combobox" type="button" role="combobox"></button>`,
    );
    for (const id of [
      "textarea",
      "select",
      "typeless",
      "text",
      "search",
      "url",
      "tel",
      "email",
      "password",
      "number",
      "date",
      "unknown",
      "editable",
      "editable-child",
      "plaintext",
      "textbox",
      "searchbox",
      "combobox",
    ]) {
      expect(classifyFocus(find(`#${id}`)), id).toBe("typing");
    }
  });

  it("is typing inside a Monaco editor that has no textarea or contenteditable", () => {
    expect(classifyFocus(find(".native-edit-context"))).toBe("typing");
    expect(classifyFocus(find(".monaco-editor"))).toBe("typing");
  });

  it("is typing for an element that takes typing through an EditContext", () => {
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    Object.defineProperty(surface, "editContext", { value: {} });
    find("main").append(surface);
    expect(classifyFocus(surface)).toBe("typing");
  });

  it("does not treat contenteditable false as a text field", () => {
    find("main").insertAdjacentHTML(
      "beforeend",
      '<div id="readonly" contenteditable="false" tabindex="-1">read only</div>',
    );
    expect(classifyFocus(find("#readonly"))).toBe("normal");
  });
});

// A page built with web components keeps its fields in shadow roots. The
// browser then names the host element as the target of a key press and as
// the active element.
describe("classifyFocus with the cursor inside a shadow root", () => {
  beforeEach(mountSplit);

  function shadowHost(parent: ParentNode, mode: ShadowRootMode = "open"): ShadowRoot {
    const host = document.createElement("div");
    host.id = "host";
    parent.append(host);
    const root = host.attachShadow({ mode });
    root.innerHTML = '<input id="field" /><button id="action" type="button"></button>';
    return root;
  }

  function focusInside(root: ShadowRoot, selector: string): void {
    root.querySelector<HTMLElement>(selector)?.focus();
  }

  it("is typing on the host while a text field inside it has the cursor", () => {
    const root = shadowHost(find("[data-bb-plugin-root]"));
    focusInside(root, "#field");

    expect(document.activeElement).toBe(root.host);
    expect(classifyFocus(root.host)).toBe("typing");
    expect(classifyFocus(null)).toBe("typing");
  });

  it("goes by the host while a button inside it has the cursor, or nothing has", () => {
    const root = shadowHost(find("[data-bb-plugin-root]"));

    expect(classifyFocus(root.host)).toBe("normal");
    focusInside(root, "#action");
    expect(document.activeElement).toBe(root.host);
    expect(classifyFocus(root.host)).toBe("normal");
  });

  it("is typing on the outer host when the text field is in a shadow root inside another", () => {
    const outer = shadowHost(find("[data-bb-plugin-root]"));
    const inner = shadowHost(outer);
    focusInside(inner, "#field");

    expect(document.activeElement).toBe(outer.host);
    expect(classifyFocus(outer.host)).toBe("typing");
  });

  it("is typing on a host inside a button and inside a sidebar thread row too", () => {
    const inButton = shadowHost(find("[data-bb-plugin-root] button"));
    expect(classifyFocus(inButton.host)).toBe("control");
    focusInside(inButton, "#field");
    expect(classifyFocus(inButton.host)).toBe("typing");

    const inRow = shadowHost(find('a[data-sidebar-thread-id="thr_a"]'));
    expect(classifyFocus(inRow.host)).toBe("sidebar");
    focusInside(inRow, "#field");
    expect(classifyFocus(inRow.host)).toBe("typing");
  });

  it("stays overlay when the host is in a menu", () => {
    find("main").insertAdjacentHTML("beforeend", '<div id="menu" role="menu"></div>');
    const root = shadowHost(find("#menu"));
    focusInside(root, "#field");

    expect(classifyFocus(root.host)).toBe("overlay");
  });

  it("cannot see a text field in a closed shadow root", () => {
    const root = shadowHost(find("[data-bb-plugin-root]"), "closed");
    focusInside(root, "#field");

    expect(document.activeElement).toBe(root.host);
    expect(classifyFocus(root.host)).toBe("normal");
  });
});

describe("classifyFocus sidebar, control and normal", () => {
  beforeEach(mountSplit);

  it("is sidebar on a thread row anchor", () => {
    expect(classifyFocus(find('a[data-sidebar-thread-id="thr_a"]'))).toBe("sidebar");
  });

  it("is sidebar for an element inside a thread row anchor", () => {
    const anchor = find('a[data-sidebar-thread-id="thr_a"]');
    anchor.insertAdjacentHTML("beforeend", '<span id="row-label">Thread A</span>');
    expect(classifyFocus(find("#row-label"))).toBe("sidebar");
  });

  it("is control, not sidebar, on other sidebar widgets", () => {
    expect(classifyFocus(find('[aria-label="Thread actions"]'))).toBe("control");
    expect(classifyFocus(find('[data-sidebar="trigger"]'))).toBe("control");
  });

  it("is control on buttons, links, summaries and focusable widgets", () => {
    expect(classifyFocus(find('[aria-label="Close pane"]'))).toBe("control");
    expect(classifyFocus(find('[data-timeline-row-id] a[href]'))).toBe("control");
    expect(classifyFocus(find("summary"))).toBe("control");
    expect(classifyFocus(find('[data-timeline-row-id] [tabindex="0"]'))).toBe("control");
    expect(classifyFocus(find('[data-app-composer] button[type="submit"]'))).toBe(
      "control",
    );
  });

  it("is control on a checkbox and other inputs that take no text", () => {
    find("main").insertAdjacentHTML(
      "beforeend",
      `<input id="checkbox" type="checkbox" />
       <input id="radio" type="radio" />
       <input id="range" type="range" />
       <input id="file" type="file" />
       <input id="color" type="color" />
       <input id="submit" type="submit" />
       <input id="button" type="button" />`,
    );
    for (const id of ["checkbox", "radio", "range", "file", "color", "submit", "button"]) {
      expect(classifyFocus(find(`#${id}`)), id).toBe("control");
    }
  });

  it("is control on elements with a widget role", () => {
    const roles = [
      "button",
      "link",
      "tab",
      "menuitem",
      "option",
      "checkbox",
      "switch",
      "radio",
      "slider",
      "treeitem",
    ];
    find("main").insertAdjacentHTML(
      "beforeend",
      roles.map((role) => `<div id="role-${role}" role="${role}" tabindex="-1"></div>`).join(""),
    );
    for (const role of roles) {
      expect(classifyFocus(find(`#role-${role}`)), role).toBe("control");
    }
  });

  it("is control for an element inside a button", () => {
    const button = find('[aria-label="Close pane"]');
    button.insertAdjacentHTML("beforeend", '<svg id="close-icon"></svg>');
    expect(classifyFocus(find("#close-icon"))).toBe("control");
  });

  it("is normal on a pane root with tabindex -1", () => {
    expect(classifyFocus(find('[data-split-pane-id="pane-1"]'))).toBe("normal");
    expect(classifyFocus(find('[data-split-pane-id="pane-3"]'))).toBe("normal");
  });

  it("is normal on the body and on plain content", () => {
    expect(classifyFocus(document.body)).toBe("normal");
    expect(classifyFocus(find("[data-message-text]"))).toBe("normal");
    expect(classifyFocus(find("[data-timeline-row-id]"))).toBe("normal");
    expect(classifyFocus(find("[data-page-scroll-viewport]"))).toBe("normal");
  });

  it("is normal on a link without an href", () => {
    find("main").insertAdjacentHTML("beforeend", '<a id="placeholder-link">soon</a>');
    expect(classifyFocus(find("#placeholder-link"))).toBe("normal");
  });
});

describe("classifyFocus target fallback", () => {
  beforeEach(mountSplit);

  it("uses the active element when the target is not an element", () => {
    find("#thread-detail-follow-up-composer").focus();
    expect(document.activeElement?.id).toBe("thread-detail-follow-up-composer");
    expect(classifyFocus(null)).toBe("typing");
    expect(classifyFocus(window)).toBe("typing");
    expect(classifyFocus(document)).toBe("typing");
  });

  it("prefers the event target over the active element", () => {
    find("#thread-detail-follow-up-composer").focus();
    expect(classifyFocus(find(".xterm-helper-textarea"))).toBe("typing");
  });

  it("uses the body when nothing is focused", () => {
    vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    expect(classifyFocus(null)).toBe("normal");
  });

  it("classifies against the document it is given", () => {
    const other = document.implementation.createHTMLDocument("other");
    other.body.innerHTML = '<div role="dialog" data-state="open"></div><p id="text">x</p>';
    const text = other.querySelector("#text");
    expect(classifyFocus(text, other)).toBe("overlay");
    expect(classifyFocus(document.body)).toBe("normal");
  });
});

describe("detectSurface with one pane", () => {
  it("is thread for a single thread view", () => {
    setPathname("/projects/proj_1/threads/thr_a");
    mountApp(singlePane(threadWindow("only")));
    expect(detectSurface()).toBe("thread");
  });

  it("is compose for the single New thread screen", () => {
    mountApp(singlePane(newThreadContent()));
    expect(detectSurface()).toBe("compose");
  });

  it("is other for a single plugin page", () => {
    setPathname("/plugins/cascade/board");
    mountApp(singlePane(pluginContent()));
    expect(detectSurface()).toBe("other");
  });

  it("does not count a thread screen in the side panel as the pane's content", () => {
    setPathname("/plugins/cascade/board");
    mountApp(
      singlePane(pluginContent()),
      `<div data-sidebar-split-container="">
         <div data-split-pane-id="pane-side" data-focused="true">${threadWindow("side")}</div>
       </div>`,
    );
    expect(detectSurface()).toBe("other");
  });
});

describe("detectSurface with several panes", () => {
  function mountPanes(focusedPaneId: string): void {
    mountApp(
      splitPane("pane-1", threadWindow("left"), { focused: focusedPaneId === "pane-1" }) +
        splitPane("pane-2", newThreadContent(), { focused: focusedPaneId === "pane-2" }) +
        splitPane("pane-3", pluginContent(), { focused: focusedPaneId === "pane-3" }),
    );
  }

  it("is thread when the focused pane shows a thread", () => {
    setPathname("/threads/thr_left");
    mountPanes("pane-1");
    expect(detectSurface()).toBe("thread");
  });

  it("is compose when the focused pane shows the New thread screen", () => {
    setPathname("/");
    mountPanes("pane-2");
    expect(detectSurface()).toBe("compose");
  });

  it("is other when the focused pane shows a plugin page", () => {
    setPathname("/plugins/cascade/board");
    mountPanes("pane-3");
    expect(detectSurface()).toBe("other");
  });

  it("ignores the focused tab group of the side panel", () => {
    setPathname("/plugins/cascade/board");
    document.body.innerHTML = `
      <div data-sidebar-split-container="">
        <div data-split-pane-id="pane-side" data-focused="true">${threadWindow("side")}</div>
      </div>
      <main>
        ${splitPane("pane-1", threadWindow("left"))}
        ${splitPane("pane-3", pluginContent(), { focused: true })}
      </main>`;
    expect(detectSurface()).toBe("other");
  });

  it("falls back to the main element when no pane is marked focused", () => {
    setPathname("/threads/thr_left");
    mountApp(
      splitPane("pane-1", threadWindow("left")) + splitPane("pane-3", pluginContent()),
    );
    expect(detectSurface()).toBe("thread");
  });
});

describe("detectSurface with a zoomed layout", () => {
  it("uses the zoomed pane and not the panes it hides", () => {
    setPathname("/plugins/cascade/board");
    mountApp(
      splitPane("pane-1", threadWindow("left"), { hidden: true }) +
        splitPane("pane-2", threadWindow("right"), { hidden: true }) +
        splitPane("pane-3", pluginContent(), { focused: true, maximized: true }),
    );
    expect(detectSurface()).toBe("other");
  });

  it("is thread when the zoomed pane shows a thread", () => {
    setPathname("/threads/thr_left");
    mountApp(
      splitPane("pane-1", threadWindow("left"), { focused: true, maximized: true }) +
        splitPane("pane-2", newThreadContent(), { hidden: true }),
    );
    expect(detectSurface()).toBe("thread");
  });

  it("is compose when the zoomed pane shows the New thread screen", () => {
    setPathname("/");
    mountApp(
      splitPane("pane-1", threadWindow("left"), { hidden: true }) +
        splitPane("pane-2", newThreadContent(), { focused: true, maximized: true }),
    );
    expect(detectSurface()).toBe("compose");
  });

  it("does not use a pane that is marked focused but hidden", () => {
    setPathname("/plugins/cascade/board");
    mountApp(
      splitPane("pane-1", threadWindow("left"), { focused: true, hidden: true }) +
        splitPane("pane-3", pluginContent(), { focused: true, maximized: true }),
    );
    expect(detectSurface()).toBe("other");
  });
});

describe("detectSurface without pane elements", () => {
  it("is compose for the New thread screen directly under main", () => {
    mountApp(`<div data-pane-content="">${NEW_THREAD_COMPOSER}</div>`);
    expect(detectSurface()).toBe("compose");
  });

  it("is thread for a thread screen directly under main", () => {
    setPathname("/threads/thr_a");
    mountApp(threadWindow("only"));
    expect(detectSurface()).toBe("thread");
  });

  it("is other on the settings pages", () => {
    setPathname("/settings/general");
    mountApp('<h1>Settings</h1><input aria-label="Name" />');
    expect(detectSurface()).toBe("other");
  });

  it("is other for a plugin page that embeds a new-thread composer", () => {
    setPathname("/plugins/cascade/board");
    mountApp(singlePane(pluginContent(NEW_THREAD_COMPOSER)));
    expect(detectSurface()).toBe("other");
  });

  it("is other on the New thread route while its composer is not rendered", () => {
    mountApp('<p class="text-destructive">Failed to load projects.</p>');
    expect(detectSurface()).toBe("other");
  });

  it("uses the body when the document has no main element", () => {
    document.body.innerHTML = `<div data-pane-content="">${NEW_THREAD_COMPOSER}</div>`;
    expect(detectSurface()).toBe("compose");
    document.body.innerHTML = threadWindow("only");
    expect(detectSurface()).toBe("thread");
    document.body.innerHTML = "";
    expect(detectSurface()).toBe("other");
  });

  it("reads the document it is given", () => {
    const other = document.implementation.createHTMLDocument("other");
    other.body.innerHTML = `<main>${threadWindow("other")}</main>`;
    expect(detectSurface(other)).toBe("thread");
    other.body.innerHTML = `<main>${NEW_THREAD_COMPOSER}</main>`;
    expect(detectSurface(other)).toBe("other");
  });
});

describe("isInTextField", () => {
  function elementFrom(html: string, selector: string): Element {
    document.body.innerHTML = html;
    const element = document.body.querySelector(selector);
    if (element === null) throw new Error(`the fixture has no ${selector}`);
    return element;
  }

  it.each([
    ["the editor of the message box", THREAD_COMPOSER, ".ProseMirror"],
    ["a paragraph inside that editor", THREAD_COMPOSER, ".ProseMirror p"],
    ["a multi-line field", "<textarea></textarea>", "textarea"],
    ["a one-line field", '<input type="text" />', "input"],
    ["a field without a type", "<input />", "input"],
  ])("is true for %s", (_name, html, selector) => {
    expect(isInTextField(elementFrom(html, selector))).toBe(true);
  });

  it.each([
    ["the Send button of the message box", THREAD_COMPOSER, "button"],
    ["the frame of the message box", THREAD_COMPOSER, "[data-app-composer]"],
    ["a button that is a combobox", '<button role="combobox">Model</button>', "button"],
    ["a select", "<select><option>One</option></select>", "select"],
    ["a checkbox", '<input type="checkbox" />', "input"],
    ["text that cannot be edited", '<div contenteditable="false"><p>Sent</p></div>', "p"],
  ])("is false for %s", (_name, html, selector) => {
    expect(isInTextField(elementFrom(html, selector))).toBe(false);
  });
});
