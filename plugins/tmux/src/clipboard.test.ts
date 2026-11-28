// @vitest-environment jsdom
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copySelection } from "./clipboard";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_copyToClipboard: vi.fn(),
}));

type ExecCommand = (commandId: string) => boolean;

const sdkCopy = vi.mocked(experimental_copyToClipboard);

function stubExecCommand(implementation: ExecCommand): ReturnType<typeof vi.fn<ExecCommand>> {
  const execCommand = vi.fn<ExecCommand>(implementation);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function textOf(id: string): Text {
  const node = document.getElementById(id)?.firstChild;
  if (!(node instanceof Text)) throw new Error(`fixture text ${id} is missing`);
  return node;
}

function select(id: string, start: number, end: number): void {
  const text = textOf(id);
  document.getSelection()?.setBaseAndExtent(text, start, text, end);
}

function selectBetween(fromId: string, start: number, toId: string, end: number): void {
  document.getSelection()?.setBaseAndExtent(textOf(fromId), start, textOf(toId), end);
}

// The text that was handed to the SDK. The fixture has line breaks and
// blanks between its rows, which a selection over several of them picks up.
// jsdom joins the texts of blocks that follow each other directly, where a
// browser puts a line break.
function writtenText(): string {
  const [payload] = sdkCopy.mock.calls[0] ?? [];
  if (payload === undefined) throw new Error("nothing was written through the SDK");
  return payload.text.replace(/\s+/g, " ").trim();
}

function selectionEnds(): [Node | null, number, Node | null, number] {
  const selection = document.getSelection();
  if (selection === null) throw new Error("the document has no selection");
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  return [anchorNode, anchorOffset, focusNode, focusOffset];
}

// Mirrors bb 0.50.1 markup: ThreadTimelineRows.tsx (rows),
// ConversationMessageContent.tsx (a message of the agent, whose text is in
// the element of SelectableMessageProse.tsx, and a message of the user, which
// has no such element) and markdown-preview.tsx (a code block with the header
// that bb leaves out of a copy).
const PAGE_HTML = `
  <div data-timeline-row-id="row-1">
    <div data-message-column="">
      <div data-sidebar-swipe-selectable=""><p id="greeting">Hello world</p><p id="blank">   </p><div><div data-clipboard-ignore=""><span id="language">ts</span><div><button type="button" aria-label="Copy code"></button></div></div><pre><code id="code">const one = 1;</code></pre></div><p id="closing">Closing words</p></div>
      <div id="blank-behind">   </div>
    </div>
  </div>
  <div data-timeline-row-id="row-2">
    <div data-message-column=""><p id="question">A question of the user</p></div>
  </div>
  <div data-timeline-row-id="row-3">
    <div data-message-column="">
      <div id="blank-in-front">   </div>
      <div data-sidebar-swipe-selectable=""><p id="answer">The answer</p><div><div data-clipboard-ignore=""><span id="other-language">py</span></div><pre><code id="other-code">two = 2</code></pre></div></div>
    </div>
  </div>`;

type ClipboardFormats = Record<string, string>;

// What a browser does for the copy command: it fires a "copy" event at the
// element that holds the start of the selection, the event bubbles up to the
// document, and the clipboard gets what a listener set when one called
// preventDefault, or the plain selected text otherwise. jsdom has no
// ClipboardEvent, so a plain event carries the clipboardData.
function stubBrowserCopyCommand(clipboard: ClipboardFormats): ReturnType<typeof vi.fn<ExecCommand>> {
  return stubExecCommand(() => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) return false;
    const start = selection.getRangeAt(0).startContainer;
    const target = start instanceof Element ? start : start.parentElement;
    if (target === null) return false;
    const formats: ClipboardFormats = {};
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData: (format: string, data: string) => {
          formats[format] = data;
        },
      },
    });
    const isLeftToBrowser = target.dispatchEvent(event);
    Object.assign(
      clipboard,
      isLeftToBrowser ? { "text/plain": selection.toString() } : formats,
    );
    return true;
  });
}

// The shape of bb's own listener in SelectableMessageProse.tsx (handleSharedCopy,
// registered on the document): it answers a copy of message text with its own
// text/plain and text/html.
function listenLikeBb(seen: string[]): () => void {
  const onCopy = (event: Event): void => {
    const selected = document.getSelection()?.toString() ?? "";
    seen.push(`${selected} from ${(event.target as Element).id}`);
    const data = (event as ClipboardEvent).clipboardData;
    data?.setData("text/plain", `**${selected}**`);
    data?.setData("text/html", `<strong>${selected}</strong>`);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}

beforeEach(() => {
  document.body.innerHTML = PAGE_HTML;
  sdkCopy.mockResolvedValue(true);
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "execCommand");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("copySelection with nothing to copy", () => {
  it("is empty and leaves the clipboard alone when there is no selection", async () => {
    const execCommand = stubExecCommand(() => true);

    await expect(copySelection()).resolves.toBe("empty");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("is empty for a collapsed selection", async () => {
    const execCommand = stubExecCommand(() => true);
    document.getSelection()?.collapse(textOf("greeting"), 3);

    await expect(copySelection()).resolves.toBe("empty");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("is empty for a collapsed selection that still reports text, as one in a text field does", async () => {
    const execCommand = stubExecCommand(() => true);
    const selection = document.getSelection();
    selection?.collapse(textOf("greeting"), 3);
    if (selection !== null) vi.spyOn(selection, "toString").mockReturnValue("field text");

    await expect(copySelection()).resolves.toBe("empty");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("is empty for a selection of nothing but white space", async () => {
    const execCommand = stubExecCommand(() => true);
    select("blank", 0, 3);

    await expect(copySelection()).resolves.toBe("empty");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
  });
});

describe("copySelection through the browser's copy command", () => {
  it("is copied when the copy command succeeds, without calling the SDK", async () => {
    const execCommand = stubExecCommand(() => true);
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("runs the copy command before it returns, while the key press still counts", () => {
    const execCommand = stubExecCommand(() => true);
    select("greeting", 0, 5);

    void copySelection();

    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  it("reads the selection of the document it is given", async () => {
    const other = document.implementation.createHTMLDocument("other");
    const getSelection = vi.spyOn(other, "getSelection").mockReturnValue(null);

    select("greeting", 0, 5);

    await expect(copySelection(other)).resolves.toBe("empty");
    expect(getSelection).toHaveBeenCalled();
  });
});

describe("copySelection and the page's own copy listener", () => {
  let clipboard: ClipboardFormats;
  let seen: string[];
  let stopListening: () => void;

  beforeEach(() => {
    clipboard = {};
    seen = [];
    stopListening = () => {};
  });

  afterEach(() => {
    stopListening();
  });

  it("lets a copy listener on the document format the clipboard, as Cmd+C does", async () => {
    stopListening = listenLikeBb(seen);
    stubBrowserCopyCommand(clipboard);
    select("greeting", 0, 5);

    const copying = copySelection();

    expect(seen).toEqual(["Hello from greeting"]);
    await expect(copying).resolves.toBe("copied");
    expect(clipboard).toEqual({
      "text/plain": "**Hello**",
      "text/html": "<strong>Hello</strong>",
    });
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("leaves the selection as it was, for the listener to read and for the user to see", async () => {
    stopListening = listenLikeBb(seen);
    stubBrowserCopyCommand(clipboard);
    select("greeting", 6, 11);

    await copySelection();

    expect(seen).toEqual(["world from greeting"]);
    expect(document.getSelection()?.toString()).toBe("world");
  });

  it("copies the plain selected text where no listener answers", async () => {
    stubBrowserCopyCommand(clipboard);
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("copied");

    expect(clipboard).toEqual({ "text/plain": "Hello" });
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("fires no copy event when there is nothing to copy", async () => {
    stopListening = listenLikeBb(seen);
    stubBrowserCopyCommand(clipboard);
    document.getSelection()?.collapse(textOf("greeting"), 3);

    await expect(copySelection()).resolves.toBe("empty");

    expect(seen).toEqual([]);
    expect(clipboard).toEqual({});
  });
});

// bb's handler (handleSharedCopy in SelectableMessageProse.tsx of bb 0.50.1)
// answers a selection that starts in one message and ends in another with
// the Markdown of the two messages, and leaves out what is between them.
describe("copySelection and the messages that the selection is in", () => {
  let clipboard: ClipboardFormats;
  let seen: string[];
  let stopListening: () => void;
  let execCommand: ReturnType<typeof vi.fn<ExecCommand>>;

  beforeEach(() => {
    clipboard = {};
    seen = [];
    stopListening = listenLikeBb(seen);
    execCommand = stubBrowserCopyCommand(clipboard);
  });

  afterEach(() => {
    stopListening();
  });

  it("leaves a selection that starts and ends in one message to bb's handler, across a code block as well", async () => {
    selectBetween("greeting", 6, "closing", 7);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(seen).toHaveLength(1);
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("writes the selected text itself when the selection runs from one message into another, with the text between them", async () => {
    selectBetween("greeting", 6, "answer", 3);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(clipboard).toEqual({});
    expect(sdkCopy).toHaveBeenCalledTimes(1);
    expect(writtenText()).toBe("world const one = 1;Closing words A question of the user The");
  });

  it("writes the selected text itself when only one end of the selection is in a message of the agent", async () => {
    selectBetween("question", 2, "answer", 3);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).not.toHaveBeenCalled();
    expect(writtenText()).toBe("question of the user The");
  });

  it("writes the selected text itself for a selection in a message of the user, which bb's handler does not answer", async () => {
    select("question", 2, 10);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).toHaveBeenCalledExactlyOnceWith({ text: "question" });
  });

  it("writes before it returns, while the key press still counts", () => {
    selectBetween("greeting", 6, "answer", 3);

    void copySelection();

    expect(sdkCopy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["behind the message, as a triple click on its last paragraph does", "closing", 0, "blank-behind", 2],
    ["in front of the message", "blank-in-front", 1, "answer", 3],
  ])(
    "leaves a selection to bb's handler that reaches out of one message over blanks only, %s",
    async (_name, fromId, start, toId, end) => {
      selectBetween(fromId, start, toId, end);

      await expect(copySelection()).resolves.toBe("copied");

      expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
      expect(seen).toHaveLength(1);
      expect(sdkCopy).not.toHaveBeenCalled();
    },
  );

  it("leaves a selection to bb's handler that starts in the blank end of the message before, with all of its text in one message", async () => {
    document.body.innerHTML = `
      <div data-sidebar-swipe-selectable=""><p id="before">One   </p></div>
      <div data-sidebar-swipe-selectable=""><p id="after">Two words</p></div>`;
    selectBetween("before", 3, "after", 3);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("is failed when it writes the text itself and the SDK cannot write", async () => {
    sdkCopy.mockResolvedValue(false);
    selectBetween("greeting", 6, "answer", 3);

    await expect(copySelection()).resolves.toBe("failed");

    expect(execCommand).not.toHaveBeenCalled();
  });
});

// bb marks the header above a code block, with the name of the language and
// the buttons, so that its own copy leaves it out (omittedElements in
// lib/markdown-clipboard.ts of bb 0.50.1).
describe("copySelection and the header of a code block", () => {
  it("leaves the header out of the text that it writes itself", async () => {
    selectBetween("question", 0, "other-code", 3);
    expect(document.getSelection()?.toString()).toContain("py");

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe("A question of the user The answertwo");
  });

  it("leaves out the header of every code block in the selection", async () => {
    selectBetween("greeting", 0, "other-code", 7);

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe(
      "Hello world const one = 1;Closing words A question of the user The answertwo = 2",
    );
  });

  it("puts the selection back as it was after reading the text around the headers", async () => {
    selectBetween("question", 0, "other-code", 3);
    const before = selectionEnds();

    await copySelection();

    expect(selectionEnds()).toEqual(before);
    expect(document.getSelection()?.toString()).toContain("py");
  });

  it("puts a selection back that was made backward", async () => {
    selectBetween("other-code", 3, "question", 0);
    const before = selectionEnds();

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe("A question of the user The answertwo");
    expect(selectionEnds()).toEqual(before);
    expect(before[0]).toBe(textOf("other-code"));
  });

  it("leaves out the part of a header that the selection starts in", async () => {
    selectBetween("language", 1, "answer", 3);

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe("const one = 1;Closing words A question of the user The");
  });

  it("leaves out the part of a header that the selection ends in", async () => {
    selectBetween("question", 0, "other-language", 1);

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe("A question of the user The answer");
  });

  it("does not set the selection when it holds no header", async () => {
    selectBetween("greeting", 6, "blank", 1);
    const setBaseAndExtent = vi.spyOn(Selection.prototype, "setBaseAndExtent");
    stubExecCommand(() => false);

    await expect(copySelection()).resolves.toBe("copied");

    expect(setBaseAndExtent).not.toHaveBeenCalled();
    expect(writtenText()).toBe("world");
  });

  it("is empty, and writes nothing, when the selection runs from a message into one of the user and holds nothing but blanks and a header", async () => {
    document.body.innerHTML = `
      <div data-message-column=""><div data-sidebar-swipe-selectable=""><p id="blank-end">   </p></div></div>
      <div data-message-column=""><div><div data-clipboard-ignore=""><span id="lone-language">ts</span></div><pre><code>code</code></pre></div></div>`;
    const execCommand = stubExecCommand(() => true);
    selectBetween("blank-end", 0, "lone-language", 2);

    await expect(copySelection()).resolves.toBe("empty");

    expect(execCommand).not.toHaveBeenCalled();
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("leaves a selection of nothing but the name of the language to the copy command, as before", async () => {
    const execCommand = stubExecCommand(() => true);
    select("language", 0, 2);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  // bb's handler answers such a selection with an empty code block.
  it.each([
    ["from the end of the text in front of a code block to the start of the code", "greeting", 11, "code", 0],
    ["made backward, from the start of the code to the end of the text in front of the block", "code", 0, "greeting", 11],
  ])(
    "is empty, and leaves the clipboard and the selection alone, for a selection in one message that holds nothing but blanks and a header, %s",
    async (_name, fromId, start, toId, end) => {
      const execCommand = stubExecCommand(() => true);
      selectBetween(fromId, start, toId, end);
      const before = selectionEnds();
      expect(document.getSelection()?.toString().trim()).toBe("ts");

      await expect(copySelection()).resolves.toBe("empty");

      expect(execCommand).not.toHaveBeenCalled();
      expect(sdkCopy).not.toHaveBeenCalled();
      expect(selectionEnds()).toEqual(before);
    },
  );

  it("hands a selection in one message with a header and text in it to bb's handler as it was selected", async () => {
    const seen: string[] = [];
    const stopListening = listenLikeBb(seen);
    stubBrowserCopyCommand({});
    selectBetween("greeting", 6, "code", 5);
    const before = selectionEnds();

    await expect(copySelection()).resolves.toBe("copied");
    stopListening();

    expect(seen).toHaveLength(1);
    expect(seen[0].replace(/\s+/g, " ")).toBe("world tsconst from greeting");
    expect(selectionEnds()).toEqual(before);
    expect(sdkCopy).not.toHaveBeenCalled();
  });

  it("leaves the header out as well when bb's handler cannot be reached for a selection in one message", async () => {
    stubExecCommand(() => false);
    selectBetween("greeting", 0, "closing", 7);

    await expect(copySelection()).resolves.toBe("copied");

    expect(writtenText()).toBe("Hello world const one = 1;Closing");
  });
});

describe("copySelection falling back to the SDK", () => {
  it("writes the selected text through the SDK when the copy command fails", async () => {
    const execCommand = stubExecCommand(() => false);
    select("greeting", 6, 11);

    await expect(copySelection()).resolves.toBe("copied");

    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(sdkCopy).toHaveBeenCalledExactlyOnceWith({ text: "world" });
  });

  it("is failed when the copy command throws and the SDK cannot write either", async () => {
    stubExecCommand(() => {
      throw new Error("copy is not allowed");
    });
    sdkCopy.mockResolvedValue(false);
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("failed");

    expect(sdkCopy).toHaveBeenCalledExactlyOnceWith({ text: "Hello" });
  });

  it("uses the SDK where the document has no copy command", async () => {
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("copied");

    expect(sdkCopy).toHaveBeenCalledExactlyOnceWith({ text: "Hello" });
  });

  it("is failed, not rejected, when the SDK rejects", async () => {
    stubExecCommand(() => false);
    sdkCopy.mockRejectedValue(new Error("clipboard is gone"));
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("failed");
  });

  it("is failed, not rejected, when the SDK throws before it returns a promise", async () => {
    stubExecCommand(() => false);
    sdkCopy.mockImplementation(() => {
      throw new Error("the plugin runtime is not installed");
    });
    select("greeting", 0, 5);

    await expect(copySelection()).resolves.toBe("failed");
  });
});
