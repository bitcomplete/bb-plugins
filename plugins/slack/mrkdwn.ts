// Markdown → Slack mrkdwn. Models write Markdown by habit, but Slack renders
// `**bold**`, `# Heading`, `- item` and `[label](url)` as literal characters.
// This converter turns the common Markdown constructs into the mrkdwn Slack
// actually renders, and escapes the three characters Slack reserves (`&`, `<`,
// `>`) everywhere except inside an existing Slack `<…>` token.
//
// It is deliberately small and dependency-free, and it never touches code: the
// text inside inline backticks or a fenced block is emitted verbatim, except
// that a fence's language tag is dropped. A construct it does not know is left
// exactly as written.

/**
 * Whether the inside of a `<…>` is a Slack control token that must pass
 * through unescaped and unformatted: `<@U…>` and `<#C…>` mentions, `<!here>`
 * and friends, and `<url|label>` links.
 */
function isSlackToken(inner: string): boolean {
  if (inner === "" || /\s/u.test(inner)) return false;
  if (/^[@#!]/u.test(inner)) return true;
  if (inner.includes("|")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(inner); // <https://…>, <mailto:…>
}

/** Escape the three characters Slack reserves; `&` first so its entities are not doubled. */
function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * Convert the inline Markdown in one run of text, escaping everything else.
 * The alternatives are ordered so a longer marker wins: link, then `**`/`__`
 * bold, `~~` strike, and last `*`/`_` italic. The inner text of emphasis may
 * not start or end with a space, so "2 * 3 * 4" is not read as italics.
 */
function convertText(text: string): string {
  const pattern = /\[([^\]]*)\]\(([^)\s]+)\)|\*\*(\S(?:[^*]*?\S)?)\*\*|__(\S(?:[^_]*?\S)?)__|~~(\S(?:[^~]*?\S)?)~~|\*(\S(?:[^*]*?\S)?)\*|_(\S(?:[^_]*?\S)?)_/gu;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out += escapeText(text.slice(last, match.index));
    const [, label, url, boldStars, boldUnders, strike, italicStar, italicUnders] = match;
    if (url !== undefined) out += `<${url.replace(/[<>|]/gu, (c) => encodeURIComponent(c))}|${escapeText(label ?? "")}>`;
    else if (boldStars !== undefined || boldUnders !== undefined) out += `*${escapeText(boldStars ?? boldUnders ?? "")}*`;
    else if (strike !== undefined) out += `~${escapeText(strike)}~`;
    else out += `_${escapeText(italicStar ?? italicUnders ?? "")}_`;
    last = match.index + match[0].length;
  }
  return out + escapeText(text.slice(last));
}

/**
 * Convert one line's inline Markdown, leaving code spans and existing Slack
 * tokens exactly as written. Everything between them is converted as text.
 */
function convertInline(line: string): string {
  let out = "";
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 0;
      while (line[i + run] === "`") run += 1;
      const close = line.indexOf("`".repeat(run), i + run);
      if (close !== -1) {
        out += convertText(text);
        text = "";
        out += line.slice(i, close + run);
        i = close + run;
        continue;
      }
      text += line.slice(i, i + run);
      i += run;
      continue;
    }
    if (line[i] === "<") {
      const close = line.indexOf(">", i + 1);
      if (close !== -1 && isSlackToken(line.slice(i + 1, close))) {
        out += convertText(text);
        text = "";
        out += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    text += line[i];
    i += 1;
  }
  return out + convertText(text);
}

/**
 * Convert one line: a heading or a `- `/`* ` list marker first, so a leading
 * `*` is read as a bullet rather than the start of italics, then the inline
 * Markdown of the remainder. Numbered lists are left as typed.
 */
function convertLine(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  const heading = /^#{1,6}[ \t]+(.+)$/u.exec(trimmed);
  if (heading !== null) {
    const converted = convertInline(heading[1]!);
    // Slack has no nested bold. If the content is already emphasis, or carries
    // its own bold, do not wrap it again: `# **Title**` would otherwise become
    // `**Title**` and render with stray asterisks.
    if (converted.includes("*") || /^[*_].*[*_]$/su.test(converted)) return `${indent}${converted}`;
    return `${indent}*${converted}*`;
  }
  const list = /^[-*][ \t]+(.+)$/u.exec(trimmed);
  if (list !== null) return `${indent}• ${convertInline(list[1]!)}`;
  return indent + convertInline(trimmed);
}

/**
 * Convert Markdown to Slack mrkdwn. Fenced code keeps its triple backticks but
 * loses the language tag, and everything inside a fence or an inline code span
 * is left as written.
 */
export function toMrkdwn(input: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of input.split("\n")) {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);
    const marks = /^(`{3,})(.*)$/u.exec(trimmed);
    if (fence === null) {
      if (marks !== null) {
        fence = marks[1]!;
        out.push(`${indent}${fence}`);
        continue;
      }
      // A CRLF line ending would otherwise hide the heading or list marker.
      out.push(convertLine(line.replace(/\r$/u, "")));
      continue;
    }
    if (marks !== null && marks[2]!.trim() === "" && marks[1]!.length >= fence.length) fence = null;
    out.push(line);
  }
  return out.join("\n");
}
