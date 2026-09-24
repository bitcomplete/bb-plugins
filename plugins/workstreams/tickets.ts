// Where a checkout's ticket is found. The branch and directory names were the
// only places looked, which left real work ticketless whenever the ticket was
// written in the pull request instead. Pure, and shared by the host (which
// reduces a PR description or comment to ticket IDs and drops the text) and
// the server (which resolves the IDs in precedence order).

/**
 * Every place a ticket can come from, strongest first. The branch is what the
 * author typed for this work; a Linear linkback comment is Linear's own record
 * of the link; a title is the author's claim; a description is looser still;
 * and a directory is often reused under a stale name.
 */
export const TICKET_SOURCES = ["branch", "linkback", "title", "description-url", "description-mention", "directory"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];
export type TicketMatch = { ticket: string; source: TicketSource };

/** How much of a PR description is read. The rest is never scanned. */
export const BODY_SCAN_CHARS = 8_192;
/** How many IDs of each kind are kept from one description. */
const MAX_REFS = 10;

/** What a PR description is reduced to on the host. The description itself is never kept. */
export type TicketRefs = { urls: string[]; mentions: string[] };

const LINEAR_ISSUE_URL = /linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})/giu;
/** Linear's magic words, followed by an ID with or without its dash. */
const MAGIC_WORD = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|part of|refs?)\b[\s:]+([A-Za-z]{2,5}-?\d{1,6})\b/giu;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].slice(0, MAX_REFS);
}

/** Ticket IDs a PR description states, read from its first BODY_SCAN_CHARS only. */
export function ticketRefsOf(body: unknown): TicketRefs {
  if (typeof body !== "string") return { urls: [], mentions: [] };
  const text = body.slice(0, BODY_SCAN_CHARS);
  return {
    urls: unique([...text.matchAll(LINEAR_ISSUE_URL)].map((match) => (match[1] ?? "").toUpperCase())),
    mentions: unique([...text.matchAll(MAGIC_WORD)].map((match) => (match[1] ?? "").toUpperCase())),
  };
}

/** Marks the comment Linear's GitHub integration leaves on a PR it links to an issue. */
export const LINKBACK_MARKER = "linear-linkback";

/**
 * The issue a Linear linkback comment names, or null. The marker and the issue
 * URL are the signal; the bot's login can change, so it only breaks a tie
 * between two marked comments.
 */
export function linkbackTicketOf(comments: unknown): string | null {
  if (!Array.isArray(comments)) return null;
  const found: { ticket: string; byLinear: boolean }[] = [];
  for (const comment of comments) {
    if (comment === null || typeof comment !== "object") continue;
    const { body, author } = comment as { body?: unknown; author?: { login?: unknown } | null };
    if (typeof body !== "string" || !body.includes(LINKBACK_MARKER)) continue;
    const ticket = ticketRefsOf(body).urls[0];
    if (ticket === undefined) continue;
    const login = author?.login;
    found.push({ ticket, byLinear: typeof login === "string" && login.toLowerCase().startsWith("linear") });
  }
  return (found.find((entry) => entry.byLinear) ?? found[0])?.ticket ?? null;
}

/** The facts ticket resolution reads from one checkout. */
export type TicketFacts = {
  branch: string | null;
  dirName: string;
  pr: { url: string; title: string; ticketRefs?: TicketRefs } | null;
};

function global(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/** Every `PREFIX-NUMBER` the ticket pattern finds in a text, in order. */
function dashed(pattern: RegExp, text: string): { ticket: string; prefix: string; index: number }[] {
  return [...text.matchAll(global(pattern))].flatMap((match) =>
    match[1] === undefined || match[2] === undefined
      ? []
      : [{ ticket: `${match[1].toUpperCase()}-${match[2]}`, prefix: match[1].toUpperCase(), index: match.index ?? 0 }],
  );
}

function prefixOf(ticket: string): string {
  return ticket.slice(0, ticket.lastIndexOf("-"));
}

/** A dashless ID ("IT35"), accepted only for a prefix known to be a ticket prefix. */
const DASHLESS = /\b([A-Z]{2,5})(\d{1,6})\b/gu;

function dashless(text: string, known: ReadonlySet<string>): { ticket: string; index: number }[] {
  return [...text.matchAll(DASHLESS)].flatMap((match) =>
    match[1] !== undefined && match[2] !== undefined && known.has(match[1])
      ? [{ ticket: `${match[1]}-${match[2]}`, index: match.index ?? 0 }]
      : [],
  );
}

/** Only brackets and space before it: the "OPS-42: ..." title convention. */
function leads(text: string, index: number): boolean {
  return /^[\s[(]*$/u.test(text.slice(0, index));
}

/**
 * Resolve tickets over a whole board. Prose is where false tickets come from
 * ("UTF-8", "HTTP2", "ES2020"), so an ID found in prose is accepted only when
 * its prefix is KNOWN: a Linear team key, or a prefix found in its dashed form
 * somewhere unambiguous on this board (a branch, a directory, a Linear URL or
 * linkback, or the head of a PR title). A dashless ID is never accepted on any
 * other terms.
 */
export function ticketFinder(
  pattern: RegExp,
  units: readonly TicketFacts[],
  options: { teams?: Iterable<string>; linkbacks?: ReadonlyMap<string, string> } = {},
): (unit: TicketFacts) => TicketMatch | null {
  const linkbacks = options.linkbacks ?? new Map<string, string>();
  const known = new Set([...(options.teams ?? [])].map((team) => team.toUpperCase()));
  for (const unit of units) {
    for (const text of [unit.branch, unit.dirName]) {
      if (text !== null) for (const match of dashed(pattern, text)) known.add(match.prefix);
    }
    if (unit.pr === null) continue;
    const linked = linkbacks.get(unit.pr.url);
    if (linked !== undefined) known.add(prefixOf(linked));
    for (const ticket of unit.pr.ticketRefs?.urls ?? []) known.add(prefixOf(ticket));
    const title = unit.pr.title;
    for (const match of dashed(pattern, title)) if (leads(title, match.index)) known.add(match.prefix);
  }

  return (unit) => {
    const branch = unit.branch === null ? undefined : dashed(pattern, unit.branch)[0];
    if (branch !== undefined) return { ticket: branch.ticket, source: "branch" };
    const pr = unit.pr;
    if (pr !== null) {
      const linked = linkbacks.get(pr.url);
      if (linked !== undefined) return { ticket: linked, source: "linkback" };
      const title = [
        ...dashed(pattern, pr.title).filter((match) => leads(pr.title, match.index) || known.has(match.prefix)),
        ...dashless(pr.title, known),
      ].sort((a, b) => a.index - b.index)[0];
      if (title !== undefined) return { ticket: title.ticket, source: "title" };
      const url = pr.ticketRefs?.urls[0];
      if (url !== undefined) return { ticket: url, source: "description-url" };
      for (const mention of pr.ticketRefs?.mentions ?? []) {
        const ticket = mention.includes("-") ? mention : dashless(mention, known)[0]?.ticket;
        if (ticket !== undefined && known.has(prefixOf(ticket))) return { ticket, source: "description-mention" };
      }
    }
    const directory = dashed(pattern, unit.dirName)[0];
    return directory === undefined ? null : { ticket: directory.ticket, source: "directory" };
  };
}

/** An open PR's linkback comment is re-read at most this often; a finished PR's, once. */
export const LINKBACK_RECHECK_MS = 6 * 60 * 60 * 1_000;

export type LinkbackCheck = { checkedAt: number; final: boolean };

/** The PR URLs whose comments are due a (re)read. */
export function linkbacksDue(
  prs: readonly { url: string }[],
  checked: ReadonlyMap<string, LinkbackCheck>,
  now: number,
): string[] {
  return [
    ...new Set(
      prs
        .filter((pr) => {
          const last = checked.get(pr.url);
          return last === undefined || (!last.final && now - last.checkedAt >= LINKBACK_RECHECK_MS);
        })
        .map((pr) => pr.url),
    ),
  ];
}
