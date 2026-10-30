import { describe, expect, it } from "vitest";
import { MAX_THREAD_PRS, ruleFor, suggestEfforts, type ClassifyInput, type ClassifyPr, type Rule } from "./effort-classify.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const pr = (repo: string, number: number, title: string, headRefName: string, extra: Partial<ClassifyPr> = {}): ClassifyPr =>
  ({ url: url(repo, number), repo: `inkwell/${repo}`, number, title, headRefName, baseRefName: "main", effortId: null, areas: [], ...extra });

/**
 * The real mix, in Inkwell words: most PRs name no ticket in the title, branches carry lowercase keys, stacks hang off owned and
 * unowned PRs, one housekeeping thread links many PRs, and one theme shows only in code areas or the board's own groups.
 */
function inkwell(): ClassifyInput {
  const owned = [
    pr("spine", 150, "ABC-330 Reserve books for store pickup", "abc-330-reserve", { effortId: "pickup" }),
    pr("spine", 151, "ABC-331 Notify readers when holds arrive", "abc-331-notify", { effortId: "pickup" }),
    pr("atlas", 405, "Let readers update their email", "abc-205-email", { effortId: "accounts" }),
    pr("atlas", 406, "Confirm email changes by link", "reader/confirm-email", { effortId: "accounts" }),
    pr("folio", 311, "Rotate vault audit keys", "ops-41-keys", { effortId: "vault" }),
    pr("folio", 312, "Record vault access reviews", "ops-42-reviews", { effortId: "vault" }),
    pr("catalog", 95, "Sort series by publication order", "series-order", { effortId: "search", areas: ["inkwell/catalog:search/ranking"] }),
    pr("folio", 314, "Group shelves by genre", "shelf-genre", { effortId: "shelf" }),
    // Owned by an effort that is done, so it points nowhere.
    pr("quill", 300, "Export notes as EPUB", "abc-900-epub", { effortId: "export-done" }),
  ];
  const loose = [
    pr("spine", 152, "Expire unclaimed holds", "reader/abc-331-expire"),
    pr("spine", 153, "Show pickup hours per store", "reader/pickup-hours", { baseRefName: "reader/abc-331-expire" }),
    pr("atlas", 410, "Keep email in sync after sign-in", "reader/email-sync", { baseRefName: "reader/confirm-email" }),
    pr("quill", 209, "Log vault token use", "ops-43-token-log"),
    pr("catalog", 101, "Rerank by availability", "rerank", { areas: ["inkwell/catalog:search/ranking", "inkwell/catalog:."] }),
    pr("folio", 420, "Gift card balance page", "abc-801-balance"),
    pr("quill", 220, "Gift card receipts", "abc-801-receipts"),
    pr("atlas", 420, "Batch shelf sync", "shelf-sync-batch"),
    pr("atlas", 421, "Retry shelf sync on conflict", "shelf-sync-retry", { baseRefName: "shelf-sync-batch" }),
    pr("folio", 430, "Count reading streak days", "streak-count"),
    pr("folio", 431, "Reset streaks at midnight", "streak-reset"),
    pr("folio", 440, "Show page counts on book cards", "abc-879-page-counts"),
    pr("folio", 441, "Tidy reader settings", "wip"),
    pr("folio", 442, "Keep UTF-8 author names", "utf-8-names"),
    pr("catalog", 102, "Tidy stale labels", "tidy-labels"),
    pr("folio", 450, "Shelf drag handles", "shelf-drag"),
    pr("folio", 461, "Fix email change copy", "abc-205-copy"),
    pr("folio", 462, "Shared toolbar", "toolbar"),
    pr("quill", 301, "EPUB cover images", "abc-900-covers"),
  ];
  return {
    prs: [...owned, ...loose],
    efforts: [{ id: "pickup", name: "Store pickup", tickets: ["ABC-330"] }, { id: "accounts", name: "Reader accounts", tickets: [] },
      { id: "vault", name: "Vault audits", tickets: [] }, { id: "search", name: "Catalog search", tickets: [] }, { id: "shelf", name: "Shelf order", tickets: [] }],
    groups: [{ key: "Reading streaks", name: "Reading streaks", prUrls: [url("folio", 430), url("folio", 431)] }],
    threads: [
      // A housekeeping thread that touched Store pickup's PRs while it tidied an unrelated one.
      { id: "thr-tidy", title: "Weekly tidy-up", prUrls: [url("catalog", 102), url("spine", 150), url("spine", 151), url("spine", 152), url("spine", 153)] },
      { id: "thr-shelf", title: "Shelf work", prUrls: [url("folio", 450), url("folio", 314)] },
      { id: "thr-pickup", title: "Pickup pairing", prUrls: [url("folio", 461), url("spine", 150)] },
      { id: "thr-toolbar-a", title: "Toolbar spike", prUrls: [url("folio", 462), url("spine", 151)] },
      { id: "thr-toolbar-b", title: "Toolbar polish", prUrls: [url("folio", 462), url("folio", 314)] },
    ],
    ticketTitles: new Map([["ABC-801", "Gift cards"]]),
    // Uppercase only: suggestions must still read the lowercase keys branches carry.
    pattern: /([A-Z]{2,5})-(\d{1,6})/u,
  };
}

const summary = (input: ClassifyInput) => suggestEfforts(input).map((group) => [group.target?.kind === "effort" ? group.target.name : group.target?.kind === "new"
  ? `new: ${group.target.name}` : group.target?.kind ?? null, group.confidence, group.prs.map((row) => `${row.repo.split("/")[1]} #${row.number}`)]);

describe("effort suggestions", () => {
  it("sorts the Inkwell mix into efforts, new efforts, and one-offs, strongest first, with the rest left to pick", () => {
    expect(summary(inkwell())).toEqual([
      ["Store pickup", "high", ["spine #152", "spine #153"]],
      ["Reader accounts", "high", ["atlas #410"]],
      ["new: Gift cards (ABC-801)", "medium", ["folio #420", "quill #220"]],
      ["new: Batch shelf sync", "medium", ["atlas #420", "atlas #421"]],
      ["Shelf order", "medium", ["folio #450"]],
      ["new: Reading streaks", "low", ["folio #430", "folio #431"]],
      // quill #209 shares only the OPS prefix with Vault audits, which never suggests an effort alone; its ticket is its own.
      ["one-off", "low", ["folio #440", "quill #209"]],
      // Its own group: accepting Reader accounts' high group never carries a PR whose signals disagree.
      ["Reader accounts", "low", ["folio #461"]],
      ["Catalog search", "low", ["catalog #101"]],
      [null, null, ["catalog #102", "folio #441", "folio #442", "folio #462", "quill #301"]],
    ]);
  });

  it("reads a lowercase ticket in a branch as the ticket an effort's PR names in its title", () => {
    const group = suggestEfforts(inkwell()).find((candidate) => candidate.key === "effort:pickup:high")!;
    expect(group.reason).toBe("Shared ticket");
    expect(group.prs.find((row) => row.number === 152)!.signals).toEqual([{ kind: "ticket", effortId: "pickup", text: "ticket ABC-331" }]);
  });

  it("files a stacked PR with its base: in the base's effort, or beside a base that is still to sort", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.key === "effort:accounts:high")!.prs).toEqual([{ prUrl: url("atlas", 410), repo: "inkwell/atlas", number: 410,
      title: "Keep email in sync after sign-in", signals: [{ kind: "stack", effortId: "accounts", text: "stacked on atlas #406" }] }]);
    // #153 carries no signal of its own; it rides with #152, whose head it builds on.
    expect(groups.find((group) => group.key === "effort:pickup:high")!.prs.find((row) => row.number === 153)!.signals).toEqual([]);
  });

  it("ignores a thread that links more PRs than one piece of work would", () => {
    const input = inkwell();
    expect(input.threads[0]!.prUrls.length).toBeGreaterThan(MAX_THREAD_PRS);
    expect(suggestEfforts(input).find((group) => group.target === null)!.prs.map((row) => row.number)).toContain(102);
    const focused = { ...input, threads: [{ id: "thr-tidy", title: "Weekly tidy-up", prUrls: [url("catalog", 102), url("folio", 314)] }] };
    expect(suggestEfforts(focused).find((group) => group.prs.some((row) => row.number === 102))).toMatchObject({ key: "effort:shelf:medium", reason: "Linked thread" });
  });

  it("lets a shared ticket outweigh a thread that disagrees, at low confidence, and suggests nothing on a tie", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.key === "effort:accounts:low")!.prs[0]!.signals).toEqual([
      { kind: "ticket", effortId: "accounts", text: "ticket ABC-205" }, { kind: "thread", effortId: "pickup", text: "thread “Pickup pairing”" }]);
    expect(groups.find((group) => group.target === null)!.prs.find((row) => row.number === 462)!.signals).toEqual([
      { kind: "thread", effortId: "pickup", text: "thread “Toolbar spike”" }, { kind: "thread", effortId: "shelf", text: "thread “Toolbar polish”" }]);
  });

  // Done efforts and One-offs aren't in `efforts`: a PR they own says nothing, and a ticket it shares isn't standalone either.
  it("never points at an effort you can't add to, and calls a PR standalone only when nothing else carries its ticket", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.target === null)!.prs.find((row) => row.number === 301)!.signals).toEqual([]);
    // UTF-8 matches the ticket pattern, but no other work uses a UTF prefix, so it isn't a ticket that makes #442 standalone.
    expect(groups.find((group) => group.target === null)!.prs.map((row) => row.number)).toContain(442);
    expect(groups.find((group) => group.key === "one-off")).toMatchObject({ reason: "Standalone ticket that nothing else carries", tickets: ["ABC-879", "OPS-43"],
      prs: [{ number: 440, signals: [{ kind: "ticket", effortId: null, text: "standalone ticket ABC-879" }] },
        { number: 209, signals: [{ kind: "ticket", effortId: null, text: "standalone ticket OPS-43" }] }] });
  });

  it("names a proposed effort from Linear, or its board group, or its first PR, and offers the tickets that tie it", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.target?.kind === "new" && group.target.name === "Gift cards (ABC-801)")).toMatchObject({ key: "new:ABC-801",
      reason: "Shared ticket ABC-801, no effort yet", tickets: ["ABC-801"], prs: [{ signals: [{ kind: "ticket", effortId: null, text: "ticket ABC-801" }] }, {}] });
    expect(groups.find((group) => group.key === "new:Reading streaks")).toMatchObject({ reason: "Board group, no effort yet", tickets: [] });
    expect(groups.find((group) => group.target?.kind === "new" && group.target.name === "Batch shelf sync")).toMatchObject({ reason: "Stacked PRs, no effort yet",
      prs: [{ number: 420, signals: [] }, { number: 421, signals: [{ kind: "stack", effortId: null, text: "stacked on atlas #420" }] }] });
  });

  // You check a group's signals before you accept it, so each group names the ones behind its target, strongest first, and none that point elsewhere.
  it("lists the specific signals behind each group's target, strongest first", () => {
    const signals = new Map(suggestEfforts(inkwell()).map((group) => [group.key, group.signals]));
    expect(signals.get("effort:pickup:high")).toEqual(["ticket ABC-331"]);
    // folio #461's thread points at Store pickup, not Reader accounts, so it isn't why the group goes there.
    expect(signals.get("effort:accounts:low")).toEqual(["ticket ABC-205"]);
    expect(signals.get("new:https://github.com/inkwell/atlas/pull/420")).toEqual(["stacked on atlas #420"]);
    expect(signals.get("one-off")).toEqual(["standalone ticket ABC-879", "standalone ticket OPS-43"]);
    expect(signals.get("none")).toEqual([]);
  });
});

describe("a ticket prefix", () => {
  // The real failure: one team prefix on every ticket pulled 11 unrelated PRs into the one effort that held the others, as one low group.
  const owned = [pr("atlas", 405, "ABC-201 Let readers update their email", "abc-201-email", { effortId: "accounts" }),
    pr("atlas", 406, "ABC-202 Confirm email changes by link", "abc-202-confirm", { effortId: "accounts" }),
    pr("spine", 150, "ABC-203 Sign in with a library card", "abc-203-card", { effortId: "accounts" })];
  const repos = ["folio", "quill", "spine", "catalog", "atlas"];
  const unrelated = Array.from({ length: 11 }, (_, index) => pr(repos[index % repos.length]!, 500 + index, `ABC-${610 + index} Change ${index + 1}`, `abc-${610 + index}`));
  const input = (prs: ClassifyPr[], threads: ClassifyInput["threads"] = []): ClassifyInput => ({ ...inkwell(), prs: [...owned, ...prs], groups: [], threads,
    efforts: [{ id: "accounts", name: "Reader accounts", tickets: [] }] });

  it("never suggests an effort for PRs that share only a team prefix with its work", () => {
    const groups = suggestEfforts(input(unrelated));
    expect(groups.filter((group) => group.target?.kind === "effort")).toEqual([]);
    expect(groups.flatMap((group) => group.prs.flatMap((row) => row.signals)).filter((signal) => signal.kind === "prefix")).toEqual([]);
    // Each ticket is its own, so they're offered as one-offs, weakly, which the deck asks about again before it marks them.
    expect(summary(input(unrelated))).toEqual([["one-off", "low", unrelated.map((row) => `${row.repo.split("/")[1]} #${row.number}`).sort()]]);
    // A standing rule can still name the prefix: that placement is yours, on purpose.
    expect(ruleFor([{ id: "r", kind: "ticket-prefix", value: "ABC", effortId: "accounts", createdAt: 0 }], unrelated[0]!, null)?.effortId).toBe("accounts");
  });

  it("adds weight to another signal for the same effort", () => {
    const badge = pr("folio", 470, "Show reader badges", "abc-230-badges");
    const thread = [{ id: "thr-badges", title: "Reader badges", prUrls: [badge.url, url("atlas", 405)] }];
    expect(suggestEfforts(input([badge], thread))).toMatchObject([{ key: "effort:accounts:high", signals: ["thread “Reader badges”", "prefix ABC"] }]);
    // The same thread without the prefix is a medium suggestion.
    const other = { ...badge, headRefName: "xyz-5-badges" };
    expect(suggestEfforts(input([other], thread))).toMatchObject([{ key: "effort:accounts:medium", signals: ["thread “Reader badges”"] }]);
  });

  // A weak group asks before it moves anything, so two faint signals must not add up to a moderate one that moves on one click.
  it("adds nothing to a lone code area, which is as faint", () => {
    const shell = pr("atlas", 700, "Tidy the app shell", "abc-700-shell", { areas: ["inkwell/atlas:app"] });
    const prs = [{ ...owned[0]!, areas: ["inkwell/atlas:app"] }, ...owned.slice(1), shell];
    expect(suggestEfforts({ ...input([]), prs })).toMatchObject([{ key: "effort:accounts:low", signals: ["area inkwell/atlas:app"],
      prs: [{ number: 700, signals: [{ kind: "area" }] }] }]);
  });

  it("counts only for the effort the other signal points at", () => {
    // OPS is Vault audits' prefix, but the thread ties quill #500 to Reader accounts, so OPS says nothing about where it goes.
    const vault = [pr("folio", 311, "OPS-41 Rotate vault audit keys", "ops-41-keys", { effortId: "vault" }),
      pr("folio", 312, "OPS-42 Record vault access reviews", "ops-42-reviews", { effortId: "vault" })];
    const token = pr("quill", 500, "Log token use", "ops-77-token-log");
    const efforts = [{ id: "accounts", name: "Reader accounts", tickets: [] }, { id: "vault", name: "Vault audits", tickets: [] }];
    const thread = [{ id: "thr-token", title: "Token log", prUrls: [token.url, url("atlas", 405)] }];
    expect(suggestEfforts({ ...input([...vault, token], thread), efforts })).toMatchObject([{ key: "effort:accounts:medium", signals: ["thread “Token log”"],
      prs: [{ number: 500, signals: [{ kind: "thread", effortId: "accounts" }] }] }]);
  });
});

describe("the Linear project signal", () => {
  // Lists was seeded from Reading lists. Two of Shelf order's three tickets are in the Shelf order project, so that is its project; Store
  // pickup's two tickets are in two projects, so it has none.
  const projects = new Map([["ABC-341", { id: "proj-shelves", name: "Shelf order" }], ["ABC-342", { id: "proj-shelves", name: "Shelf order" }],
    ["ABC-343", { id: "proj-hours", name: "Store hours" }], ["ABC-360", { id: "proj-pickup", name: "Store pickup" }], ["ABC-361", { id: "proj-lists", name: "Reading lists" }],
    ["ABC-370", { id: "proj-lists", name: "Reading lists" }], ["ABC-371", { id: "proj-shelves", name: "Shelf order" }], ["ABC-372", { id: "proj-pickup", name: "Store pickup" }]]);
  const input = (loose: ClassifyPr[]): ClassifyInput => ({ ...inkwell(), projects, prs: [
    pr("folio", 314, "ABC-341 Group shelves by genre", "shelf-genre", { effortId: "shelf" }), pr("folio", 315, "ABC-342 Sort shelves", "shelf-sort", { effortId: "shelf" }),
    pr("spine", 160, "ABC-360 Reserve at a store", "reserve", { effortId: "pickup" }), ...loose],
    efforts: [{ id: "lists", name: "Reading lists", tickets: [], seededFrom: { id: "proj-lists", name: "Reading lists" } },
      { id: "shelf", name: "Shelf order", tickets: ["ABC-343"] }, { id: "pickup", name: "Store pickup", tickets: ["ABC-361"] }] });

  it("suggests the effort seeded from a PR's Linear project, or the one most of whose tickets are in it, with high confidence", () => {
    const groups = suggestEfforts(input([pr("folio", 501, "Reorder a reading list", "abc-370-reorder"), pr("folio", 502, "Shelve by author", "abc-371-author")]));
    expect(groups.map((group) => [group.target, group.confidence, group.reason, group.prs.map((item) => [item.number, item.signals.map((signal) => signal.text)])])).toEqual([
      [{ kind: "effort", effortId: "lists", name: "Reading lists" }, "high", "Linear project", [[501, ["Linear project “Reading lists”"]]]],
      [{ kind: "effort", effortId: "shelf", name: "Shelf order" }, "high", "Linear project", [[502, ["Linear project “Shelf order”"]]]],
    ]);
  });

  it("points at no effort whose tickets split between projects, so one ticket never decides an effort's project", () => {
    const [group] = suggestEfforts(input([pr("folio", 503, "Print pickup slips", "abc-372-slips")]));
    expect(group!.prs[0]!.signals.filter((signal) => signal.kind === "project")).toEqual([]);
  });
});

describe("standing rules", () => {
  const rule = (kind: Rule["kind"], value: string, effortId: string | null): Rule => ({ id: `${kind}:${value}`, kind, value, effortId, createdAt: 0 });
  /** The effort the rules put a PR in: a stack rule's is its base's. */
  const placed = (rules: Rule[], title: string, headRefName: string, repo = "inkwell/quill", base: string | null = null) => {
    const match = ruleFor(rules, { repo, title, headRefName }, base);
    return match ? match.effortId ?? base : null;
  };

  it("matches a ticket prefix in the title or branch, in any case and without its dash, but never inside a word", () => {
    const vault = [rule("ticket-prefix", "OPS", "vault")];
    expect(placed(vault, "Log vault token use", "reader/ops-43-token-log")).toBe("vault");
    expect(placed(vault, "OPS43 Log vault token use", "token-log")).toBe("vault");
    expect(placed(vault, "Stops-2 retries", "stops-2-retries")).toBeNull();
  });

  it("matches part of a branch, a * pattern over the whole branch, and a repository by full name or name", () => {
    expect(placed([rule("branch", "streak", "streaks")], "Count reading streak days", "reader/Streak-count")).toBe("streaks");
    expect(placed([rule("branch", "billing/*", "seat")], "Seat ledger", "billing/seat-ledger")).toBe("seat");
    expect(placed([rule("branch", "billing/*", "seat")], "Seat ledger", "reader/billing/seat-ledger")).toBeNull();
    expect(placed([rule("repo", "inkwell/quill", "tools")], "Upgrade lint config", "lint")).toBe("tools");
    expect(placed([rule("repo", "quill", "tools")], "Upgrade lint config", "lint")).toBe("tools");
    expect(placed([rule("repo", "quill", "tools")], "Upgrade lint config", "lint", "inkwell/folio")).toBeNull();
  });

  it("matches a Linear project of the PR's tickets by name, in any case", () => {
    const lists = [rule("linear-project", "Reading lists", "lists")];
    expect(ruleFor(lists, { repo: "inkwell/folio", title: "Reorder a list", headRefName: "abc-370", projects: ["reading Lists"] }, null)?.effortId).toBe("lists");
    expect(ruleFor(lists, { repo: "inkwell/folio", title: "Reorder a list", headRefName: "abc-370", projects: ["Reading rooms"] }, null)).toBeNull();
    expect(ruleFor(lists, { repo: "inkwell/folio", title: "Reorder a list", headRefName: "abc-370" }, null)).toBeNull();
  });

  it("files a stacked PR with its base's effort, and places nothing when matching rules name different efforts", () => {
    expect(placed([rule("stack", "", null)], "Show pickup hours", "pickup-hours", "inkwell/spine", "pickup")).toBe("pickup");
    expect(placed([rule("stack", "", null)], "Show pickup hours", "pickup-hours", "inkwell/spine", null)).toBeNull();
    expect(placed([rule("ticket-prefix", "OPS", "vault"), rule("repo", "quill", "tools")], "Log vault token use", "ops-43")).toBeNull();
    expect(placed([rule("ticket-prefix", "OPS", "vault"), rule("repo", "quill", "vault")], "Log vault token use", "ops-43")).toBe("vault");
  });
});
