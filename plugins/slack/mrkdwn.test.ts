import { describe, expect, it } from "vitest";
import { toMrkdwn } from "./mrkdwn.js";

describe("toMrkdwn", () => {
  it("converts bold written with stars and with underscores", () => {
    expect(toMrkdwn("**bold**")).toBe("*bold*");
    expect(toMrkdwn("__bold__")).toBe("*bold*");
    expect(toMrkdwn("a **b** c")).toBe("a *b* c");
  });

  it("converts italic written with stars and with underscores", () => {
    expect(toMrkdwn("*italic*")).toBe("_italic_");
    expect(toMrkdwn("_italic_")).toBe("_italic_");
    expect(toMrkdwn("a *b* c")).toBe("a _b_ c");
  });

  it("converts strikethrough", () => {
    expect(toMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("turns a heading line into a bold line", () => {
    expect(toMrkdwn("# Heading")).toBe("*Heading*");
    expect(toMrkdwn("### Deep")).toBe("*Deep*");
    expect(toMrkdwn("  ## Indented")).toBe("  *Indented*");
    expect(toMrkdwn("not # a heading")).toBe("not # a heading");
    expect(toMrkdwn("#no space is not a heading")).toBe("#no space is not a heading");
  });

  it("does not double the bold on a heading that is already bold", () => {
    expect(toMrkdwn("# **Title**")).toBe("*Title*");
    expect(toMrkdwn("# a **b**")).toBe("a *b*");
    expect(toMrkdwn("# _Title_")).toBe("_Title_");
  });

  it("turns a Markdown link into a Slack link and leaves a bare URL alone", () => {
    expect(toMrkdwn("[label](https://example.com)")).toBe("<https://example.com|label>");
    expect(toMrkdwn("see https://example.com now")).toBe("see https://example.com now");
    expect(toMrkdwn("[a](https://x.test) and [b](https://y.test)")).toBe("<https://x.test|a> and <https://y.test|b>");
  });

  it("keeps a link token well-formed when the URL holds >, < or |", () => {
    expect(toMrkdwn("[x](https://e.test/a>b)")).toBe("<https://e.test/a%3Eb|x>");
    expect(toMrkdwn("[x](https://e.test/a|b)")).toBe("<https://e.test/a%7Cb|x>");
  });

  it("escapes &, < and > in plain text", () => {
    expect(toMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(toMrkdwn("a lone <angle")).toBe("a lone &lt;angle");
  });

  it("leaves existing Slack tokens exactly as written", () => {
    const tokens = "<@U123> <#C123|general> <!here> <https://example.com|site>";
    expect(toMrkdwn(tokens)).toBe(tokens);
  });

  it("does not touch text inside inline code", () => {
    expect(toMrkdwn("use `**bold** < & >` here")).toBe("use `**bold** < & >` here");
    expect(toMrkdwn("`- item` and `# heading`")).toBe("`- item` and `# heading`");
  });

  it("keeps a fenced block, dropping the language tag and leaving the body alone", () => {
    expect(toMrkdwn("```js\nconst x = 1 < 2 && 3 > 2;\n- not a list\n# not a heading\n```")).toBe(
      "```\nconst x = 1 < 2 && 3 > 2;\n- not a list\n# not a heading\n```",
    );
    expect(toMrkdwn("```\n**x**\n```")).toBe("```\n**x**\n```");
  });

  it("turns - and * list markers into bullets and leaves numbered lists as typed", () => {
    expect(toMrkdwn("- one\n- two")).toBe("• one\n• two");
    expect(toMrkdwn("* one\n* two")).toBe("• one\n• two");
    expect(toMrkdwn("1. one\n2. two")).toBe("1. one\n2. two");
  });

  it("reads a leading * as a bullet, not as the start of italics", () => {
    expect(toMrkdwn("* a *b*")).toBe("• a _b_");
    expect(toMrkdwn("*bold* at the start is italic, not a bullet")).toBe("_bold_ at the start is italic, not a bullet");
  });

  it("converts several constructs in one message", () => {
    expect(toMrkdwn("# Title\n\nSome **bold** and *italic* and ~~old~~.\n\n- [docs](https://x.test)\n\n```py\nprint(1)\n```")).toBe(
      "*Title*\n\nSome *bold* and _italic_ and ~old~.\n\n• <https://x.test|docs>\n\n```\nprint(1)\n```",
    );
  });

  it("leaves an unmatched marker and unrelated text alone", () => {
    expect(toMrkdwn("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(toMrkdwn("plain text, no Markdown")).toBe("plain text, no Markdown");
  });

  it("still reads headings and lists when the lines end with CRLF", () => {
    expect(toMrkdwn("# Head\r\n- item\r\n**bold**")).toBe("*Head*\n• item\n*bold*");
  });
});
