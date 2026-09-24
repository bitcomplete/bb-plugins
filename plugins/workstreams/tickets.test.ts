// Where a checkout's ticket is found: the branch, a Linear linkback comment,
// the PR title, the PR description, then the directory. Prose sources only
// count for known prefixes, because prose is full of things shaped like tickets.
import { describe, expect, it } from "vitest";
import { parseLinkback, parsePrList } from "./gh.js";
import {
  BODY_SCAN_CHARS,
  LINKBACK_RECHECK_MS,
  linkbackTicketOf,
  linkbacksDue,
  ticketFinder,
  ticketRefsOf,
  type TicketFacts,
} from "./tickets.js";
import { buildBoard } from "./workstreams.js";
import type { RawUnit } from "./contract.js";

const PATTERN = /([A-Za-z]{2,5})-(\d{1,6})/u;
const URL = "https://github.com/inkwell/quill/pull/7";

function facts(overrides: { branch?: string | null; dirName?: string; title?: string; body?: string } = {}): TicketFacts {
  return {
    branch: overrides.branch ?? "chore/shelf-index",
    dirName: overrides.dirName ?? "quill",
    pr: { url: URL, title: overrides.title ?? "Rebuild the shelf index", ticketRefs: ticketRefsOf(overrides.body ?? "") },
  };
}

const find = (unit: TicketFacts, options: Parameters<typeof ticketFinder>[2] = {}) => ticketFinder(PATTERN, [unit], options)(unit);

describe("each source", () => {
  it("reads a ticket leading the PR title, the team's usual convention", () => {
    expect(find(facts({ title: "OPS-42: Add gift card wrapping" }))).toEqual({ ticket: "OPS-42", source: "title" });
    expect(find(facts({ title: "[OPS-42] Add gift card wrapping" }))).toEqual({ ticket: "OPS-42", source: "title" });
  });

  it("reads a ticket later in a title only when its prefix is known elsewhere on the board", () => {
    const branchWithOps: TicketFacts = { branch: "ops-3-gift-wrap", dirName: "quill-2", pr: null };
    const later = facts({ title: "feat: wrap gift cards (OPS-4)" });
    expect(ticketFinder(PATTERN, [later])(later)).toBeNull();
    expect(ticketFinder(PATTERN, [later, branchWithOps])(later)).toEqual({ ticket: "OPS-4", source: "title" });
  });

  it("accepts a dashless ID only for an allowlisted prefix", () => {
    const unit = facts({ title: "ABC12: feat!: gift card wrapping" });
    expect(find(unit)).toBeNull();
    expect(find(unit, { teams: ["ABC"] })).toEqual({ ticket: "ABC-12", source: "title" });
  });

  it("never turns HTTP2, ES2020, UTF8, K8S or a mid-title UTF-8 into a ticket", () => {
    const unit = facts({ title: "Serve HTTP2, target ES2020, read UTF8 and UTF-8, deploy to K8S" });
    expect(find(unit, { teams: ["ABC", "OPS"] })).toBeNull();
    expect(find(facts({ body: "Fixes UTF8 decoding. Closes ES2020 target." }), { teams: ["ABC"] })).toBeNull();
  });

  it("reads a Linear issue URL in the description, whatever its prefix", () => {
    expect(find(facts({ body: "Context: https://linear.app/inkwell/issue/OPS-7/gift-wrap" }))).toEqual({ ticket: "OPS-7", source: "description-url" });
  });

  it("reads a Linear magic word in the description for a known prefix, dashed or not", () => {
    expect(find(facts({ body: "Fixes OPS-9" }))).toBeNull();
    expect(find(facts({ body: "Fixes OPS-9" }), { teams: ["OPS"] })).toEqual({ ticket: "OPS-9", source: "description-mention" });
    expect(find(facts({ body: "Part of ABC12" }), { teams: ["ABC"] })).toEqual({ ticket: "ABC-12", source: "description-mention" });
  });

  it("reads the issue a Linear linkback comment names, by its marker and URL rather than its author", () => {
    const linkback = { author: { login: "renamed-bot" }, body: "<!-- linear-linkback -->\n[OPS-7 Gift wrap](https://linear.app/inkwell/issue/OPS-7/some-slug)" };
    expect(linkbackTicketOf([{ author: { login: "sam" }, body: "Looks good" }, linkback])).toBe("OPS-7");
    expect(linkbackTicketOf([{ author: { login: "linear-code" }, body: "<!-- linear-linkback --> no link here" }])).toBeNull();
    expect(linkbackTicketOf([{ author: { login: "sam" }, body: "see https://linear.app/inkwell/issue/OPS-8/x" }])).toBeNull();
    expect(parseLinkback(JSON.stringify({ comments: [linkback] }))).toBe("OPS-7");
    expect(parseLinkback("not json")).toBeUndefined();
  });
});

describe("precedence when sources disagree", () => {
  it("takes branch, then linkback, then title, then description URL, then magic word, then directory", () => {
    const all = (branch: string | null, title: string, body: string, dirName = "ops-6-quill") =>
      ({ branch, dirName, pr: { url: URL, title, ticketRefs: ticketRefsOf(body) } }) satisfies TicketFacts;
    const linkbacks = new Map([[URL, "OPS-2"]]);
    const options = { teams: ["OPS"], linkbacks };
    const body = "Fixes OPS-5. https://linear.app/inkwell/issue/OPS-4/x";
    expect(find(all("ops-1-wrap", "OPS-3: Wrap", body), options)?.source).toBe("branch");
    expect(find(all(null, "OPS-3: Wrap", body), options)).toEqual({ ticket: "OPS-2", source: "linkback" });
    expect(find(all(null, "OPS-3: Wrap", body), { teams: ["OPS"] })).toEqual({ ticket: "OPS-3", source: "title" });
    expect(find(all(null, "Wrap", body), { teams: ["OPS"] })).toEqual({ ticket: "OPS-4", source: "description-url" });
    expect(find(all(null, "Wrap", "Fixes OPS-5"), { teams: ["OPS"] })).toEqual({ ticket: "OPS-5", source: "description-mention" });
    expect(find(all(null, "Wrap", ""), { teams: ["OPS"] })).toEqual({ ticket: "OPS-6", source: "directory" });
  });

  it("files a checkout whose ticket is only in its PR title under that ticket's cluster, and records the source", () => {
    const raw = (path: string, branch: string, title: string): RawUnit => ({
      path, dirName: path.slice(1), repo: "inkwell/quill", branch, dirty: false, ahead: 0, behind: 0, lastCommitAt: null,
      defaultBranch: "main", shipped: null, changedPaths: [],
      pr: { number: 7, state: "OPEN", isDraft: false, reviewDecision: null, checkConclusions: [], url: `${URL}${path}`, title, mergeable: null,
        baseRefName: "main", headRefName: branch, latestReviewStates: [], mergedAt: null, mergeStateStatus: "UNKNOWN", reviewRequests: [], latestReviews: [], unresolvedReviewThreads: null },
    });
    const board = buildBoard([raw("/a", "ops-42-wrap", "Wrap gift cards"), raw("/b", "fix/wrap-copy", "OPS-42: Fix the wrap copy")], {
      pattern: PATTERN, overrides: {}, linearProjects: {},
    });
    const cluster = board.flatMap((ws) => ws.clusters).find((c) => c.ticket === "OPS-42");
    expect(cluster?.units.map((unit) => unit.ticketSource).sort()).toEqual(["branch", "title"]);
  });
});

describe("the PR description is client content", () => {
  const listed = (body: string) =>
    JSON.stringify([{ number: 7, state: "OPEN", url: URL, title: "Wrap gift cards", body }]);

  it("is reduced to ticket IDs on the host and never kept", () => {
    const parsed = parsePrList(listed("Confidential roadmap notes. Resolves OPS-9. https://linear.app/inkwell/issue/OPS-7/wrap"));
    expect(parsed?.pr.ticketRefs).toEqual({ urls: ["OPS-7"], mentions: ["OPS-9"] });
    expect(JSON.stringify(parsed)).not.toContain("Confidential");
  });

  it("is read only up to the size cap", () => {
    const late = `${"x".repeat(BODY_SCAN_CHARS)} https://linear.app/inkwell/issue/OPS-8/wrap`;
    expect(parsePrList(listed(late))?.pr.ticketRefs).toEqual({ urls: [], mentions: [] });
  });
});

describe("when a PR's comments are read again", () => {
  const now = 10 * LINKBACK_RECHECK_MS;

  it("reads a PR never read before", () => {
    expect(linkbacksDue([{ url: URL }], new Map(), now)).toEqual([URL]);
  });

  it("never re-reads a PR that was merged or closed when read", () => {
    expect(linkbacksDue([{ url: URL }], new Map([[URL, { checkedAt: 0, final: true }]]), now)).toEqual([]);
  });

  it("re-reads an open PR only once the interval has passed", () => {
    const at = (checkedAt: number) => linkbacksDue([{ url: URL }], new Map([[URL, { checkedAt, final: false }]]), now);
    expect(at(now - LINKBACK_RECHECK_MS + 1)).toEqual([]);
    expect(at(now - LINKBACK_RECHECK_MS)).toEqual([URL]);
  });
});
