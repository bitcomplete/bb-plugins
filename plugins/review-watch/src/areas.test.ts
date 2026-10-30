import { describe, expect, it } from "vitest";
import { groupByArea, groupByOrganization, scopeKey, titleScope } from "./areas.js";
import { itemKey, type QueueItem } from "./types.js";

let next = 0;

/** A queued row; each call gets its own node so keys never collide. */
function queueItem(title: string, repo: string, updatedAt = "2026-09-22T12:00:00Z"): QueueItem {
  const nodeId = `PR_node${++next}`;
  return {
    key: itemKey("review-requested", nodeId, "sha-head"),
    rule: "review-requested",
    state: "queued",
    repo,
    number: next,
    title,
    author: "alice",
    url: `https://github.com/${repo}/pull/${next}`,
    baseBranch: "main",
    headBranch: "alice/work",
    headSha: "sha-head",
    nodeId,
    reason: "@alice requested your review",
    noticedAt: "2026-09-22T12:00:00Z",
    updatedAt,
  };
}

describe("titleScope", () => {
  it("reads the scope behind a ticket prefix, since Linear titles lead with the ticket", () => {
    expect(titleScope("ABC-3774: fix(purchases): commit immediate checkout before charging Stripe")).toBe("purchases");
  });

  it("reads a breaking-change scope, which is still the same area", () => {
    expect(titleScope("refactor(join)!: split the join flow")).toBe("join");
  });

  it("finds no scope in a plain sentence, so the row falls back to its repo", () => {
    expect(titleScope("Show correct feedback attribution for reverse-shadow interviewers")).toBeNull();
  });
});

describe("scopeKey", () => {
  it("folds plural and compound scopes so one area is not split across headings", () => {
    expect(scopeKey("tags")).toBe("tag");
    expect(scopeKey("tag-review")).toBe("tag");
    expect(scopeKey("photo-id")).toBe("photo");
    expect(scopeKey("Catalog")).toBe("catalog");
  });

  it("keeps a double s, which is not a plural", () => {
    expect(scopeKey("access")).toBe("access");
  });
});

describe("groupByArea", () => {
  it("merges one scope across repos, because an area is product work, not a repository", () => {
    const groups = groupByArea([
      queueItem("feat(catalog): list every shelf on the start page", "inkwell/folio"),
      queueItem("fix(catalog): tell the extension when the browser changes readers", "inkwell/quill"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "scope:catalog", label: "catalog", repos: ["folio", "quill"] });
  });

  it("puts tags and tag-review under one heading named by the scope most items used", () => {
    const groups = groupByArea([
      queueItem("feat(tags): drag, block moves and one save for tag order", "inkwell/folio"),
      queueItem("feat(tag-review): spaced ranks for every tag", "inkwell/folio"),
      queueItem("fix(tags): keep the tag order after a reload", "inkwell/folio"),
    ]);
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([["tags", 3]]);
  });

  it("names a tied group by its shortest scope", () => {
    const groups = groupByArea([
      queueItem("feat(tag-review): spaced ranks for every tag", "inkwell/folio"),
      queueItem("feat(tags): drag, block moves and one save for tag order", "inkwell/folio"),
    ]);
    expect(groups[0]?.label).toBe("tags");
  });

  it("files a ticket-prefixed title under its scope, not its repo", () => {
    const groups = groupByArea([
      queueItem("ABC-3774: fix(purchases): commit immediate checkout before charging Stripe", "inkwell/spine"),
    ]);
    expect(groups[0]).toMatchObject({ key: "scope:purchase", label: "purchases", repos: ["spine"] });
  });

  it("falls back to the repo for an unscoped title", () => {
    const groups = groupByArea([
      queueItem("Show correct feedback attribution for reverse-shadow interviewers", "bitcomplete/hiringloop"),
    ]);
    expect(groups[0]).toMatchObject({ key: "repo:bitcomplete/hiringloop", label: "hiringloop", repos: ["hiringloop"] });
  });

  it("keeps an unscoped repo group apart from a same-named scope elsewhere, which only matches by accident", () => {
    const groups = groupByArea([
      queueItem("Show correct feedback attribution for reverse-shadow interviewers", "bitcomplete/hiringloop"),
      queueItem("feat(hiringloop): link the candidate portal", "bitcomplete/website"),
    ]);
    expect(groups.map((group) => group.key).sort()).toEqual(["repo:bitcomplete/hiringloop", "scope:hiringloop"]);
  });

  it("orders groups by size, then by the most recent update, so the busiest area leads", () => {
    const groups = groupByArea([
      queueItem("Show correct feedback attribution for reverse-shadow interviewers", "bitcomplete/hiringloop", "2026-09-22T15:00:00Z"),
      queueItem("ABC-3774: fix(purchases): commit immediate checkout before charging Stripe", "inkwell/spine", "2026-09-22T14:00:00Z"),
      queueItem("feat(catalog): list every shelf on the start page", "inkwell/folio", "2026-09-20T10:00:00Z"),
      queueItem("fix(catalog): tell the extension when the browser changes readers", "inkwell/quill", "2026-09-21T10:00:00Z"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["catalog", "hiringloop", "purchases"]);
    expect(groups[0]?.items.map((item) => item.title)).toEqual([
      "fix(catalog): tell the extension when the browser changes readers",
      "feat(catalog): list every shelf on the start page",
    ]);
  });

  it("returns no groups for an empty queue", () => {
    expect(groupByArea([])).toEqual([]);
  });
});

it("groups owners case-insensitively without merging shared scopes across owners", () => {
  const parsley = queueItem("fix(catalog): one", "ParsleyHealth/sage");
  const otherParsley = queueItem("feat(catalog): two", "parsleyhealth/store");
  const bit = queueItem("fix(catalog): three", "bitcomplete/hiringloop");
  const groups = groupByOrganization([parsley, bit, otherParsley]);
  expect(groups.map((group) => group.label)).toEqual(["bitcomplete", "parsleyhealth"]);
  expect(groups.map((group) => group.areas[0]?.items)).toEqual([[bit], [parsley, otherParsley]]);
  expect(groupByOrganization([])).toEqual([]);
});
