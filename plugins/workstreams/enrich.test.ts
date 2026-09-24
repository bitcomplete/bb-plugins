// The model paths, exercised against stubbed clients. There is no API key in
// this environment and these tests must not need one: what they check is the
// plugin's own policy — what gets asked, what does not, and what happens to an
// answer once it arrives.
import { describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import {
  assignToCandidates,
  candidatesFrom,
  decideWithJev,
  nameEfforts,
  nameGroups,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
  type NamingClient,
} from "./enrich.js";
import {
  buildEfforts,
  clusterInputHash,
  effortMemberHash,
  unitLifecycle,
  type Cluster,
} from "./workstreams.js";

function unit(overrides: Partial<RawUnit> = {}): RawUnit {
  return {
    path: "/c/quill",
    dirName: "quill",
    repo: "quill",
    branch: "dev/abc-101-gift-card-balance",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: "2029-12-24T00:00:00Z",
    defaultBranch: "main",
    pr: null,
    shipped: null,
    changedPaths: [],
    ...overrides,
  };
}

function pr(overrides: Partial<Pr> = {}): Pr {
  return {
    number: 42,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checkConclusions: [],
    url: "https://github.com/inkwell/quill/pull/42",
    title: "Show gift card balance in the cart",
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "dev/abc-101-gift-card-balance",
    latestReviewStates: [],
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    latestReviews: [],
    unresolvedReviewThreads: 0,
    resolvedReviewThreads: 0,
    ...overrides,
  };
}

function cluster(ticket: string, units: RawUnit[]): Cluster {
  return {
    ticket,
    lifecycle: unitLifecycle(units[0] as RawUnit),
    staleness: "fresh",
    surfaces: [],
    risk: "none",
    units: units.map((raw) => ({
      ...raw,
      ticket,
      ticketSource: "branch" as const,
      lifecycle: unitLifecycle(raw),
      stack: null,
      staleness: "fresh" as const,
      surfaces: [],
      risk: "none" as const,
    })),
  };
}

/** A Jev that records what it was asked and answers from a fixed script. */
function stubJev(reply: (name: string, question: JevQuestion) => JevAnswer | undefined) {
  const asks: Record<string, JevQuestion>[] = [];
  const client: JevClient = {
    async ask(_state, questions) {
      asks.push(questions);
      const answers: Record<string, JevAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const answer = reply(name, question);
        if (answer !== undefined) answers[name] = answer;
      }
      return { answers, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  return { client, asks };
}

const balance = cluster("ABC-101", [
  unit({ path: "/c/a", pr: pr({ title: "ABC-101: Show gift card balance in the cart" }) }),
  unit({
    path: "/c/b",
    repo: "margin",
    pr: pr({ number: 43, title: "ABC-101: Add dark mode to the reader app" }),
  }),
]);
const typeface = cluster("OPS-1111", [
  unit({
    path: "/c/c",
    repo: "colophon",
    branch: "dev/ops-1111-serif-typeface",
    pr: pr({ number: 44, title: "OPS-1111: Swap the default typeface for a serif" }),
  }),
]);

describe("decideWithJev", () => {
  it("asks nothing when nothing changed, because a rescan of an unchanged board must cost zero model calls", async () => {
    const { client, asks } = stubJev(() => undefined);
    const result = await decideWithJev({
      pending: [],
      candidates: candidatesFrom([balance, typeface]),
      jev: client,
    });
    expect(asks).toHaveLength(0);
    expect(result.usage.calls).toBe(0);
  });

  it("batches every stale cluster into shared calls, because one call per cluster would multiply cost by board size for no extra signal", async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      cluster(`ABC-${index}`, [
        unit({ path: `/c/${index}`, pr: pr({ number: index, title: `ABC-${index}: Do the thing number ${index}` }) }),
      ]),
    );
    const { client, asks } = stubJev(() => undefined);
    const result = await decideWithJev({
      pending: many,
      candidates: candidatesFrom(many),
      jev: client,
    });
    expect(asks.length).toBeLessThan(many.length);
    expect(result.usage.calls).toBe(asks.length);
  });

  it("only ever offers the cluster's own pull request titles as summary choices, because the point is to show words the user wrote", async () => {
    const { client, asks } = stubJev(() => undefined);
    await decideWithJev({ pending: [balance], candidates: candidatesFrom([balance, typeface]), jev: client });
    const question = asks[0]?.["c0_summary"];
    expect(question?.type).toBe("choice");
    expect(Object.keys(question?.type === "choice" ? question.criteria : {})).toEqual([
      "Show gift card balance in the cart",
      "Add dark mode to the reader app",
    ]);
  });

  it("asks no summary question for a cluster with one usable title, because code already knows the answer", async () => {
    const { client, asks } = stubJev(() => undefined);
    await decideWithJev({ pending: [typeface], candidates: candidatesFrom([balance, typeface]), jev: client });
    expect(asks[0]).not.toHaveProperty("c0_summary");
    const decided = (
      await decideWithJev({ pending: [typeface], candidates: candidatesFrom([balance, typeface]), jev: client })
    ).decisions;
    expect(decided.get(clusterInputHash(typeface))?.summary).toBe(
      "Swap the default typeface for a serif",
    );
  });

  it("normalizes the rubric score into the 0-1 range the confidence threshold is expressed in, so the setting means what it says", async () => {
    const { client } = stubJev((name) => {
      if (name.endsWith("_effort")) return { type: "choice", choice: "Show gift card balance in the cart", confidence: 0.9 };
      if (name.endsWith("_fit")) return { type: "score", score: 3, confidence: 0.8 };
      return undefined;
    });
    const result = await decideWithJev({
      pending: [balance],
      candidates: candidatesFrom([balance, typeface]),
      jev: client,
    });
    // Three on a five-level rubric is 0.75, which clears the 0.6 default.
    expect(result.decisions.get(clusterInputHash(balance))?.assignment?.fit).toBeCloseTo(0.75);
  });

  it("records a bottom-of-rubric score as a near-zero fit, so the threshold can route it to Unsorted rather than force-fitting it", async () => {
    const { client } = stubJev((name) => {
      if (name.endsWith("_effort")) return { type: "choice", choice: "Show gift card balance in the cart", confidence: 0.3 };
      if (name.endsWith("_fit")) return { type: "score", score: 0, confidence: 0.9 };
      return undefined;
    });
    const result = await decideWithJev({
      pending: [balance],
      candidates: candidatesFrom([balance, typeface]),
      jev: client,
    });
    const fit = result.decisions.get(clusterInputHash(balance))?.assignment?.fit ?? 1;
    expect(fit).toBeLessThan(0.6);
  });

  it("ignores a summary that is not one of the offered titles, because a title nobody wrote is exactly what selection is meant to prevent", async () => {
    const { client } = stubJev((name) => {
      if (name.endsWith("_summary")) {
        return { type: "choice", choice: "Some invented description of the work", confidence: 0.99 };
      }
      return undefined;
    });
    const result = await decideWithJev({
      pending: [balance],
      candidates: candidatesFrom([balance, typeface]),
      jev: client,
    });
    expect(result.decisions.get(clusterInputHash(balance))?.summary).toBeNull();
  });

  it("turns a Jev outage into a warning and no decisions, because the previous board is better than no board", async () => {
    const client: JevClient = {
      ask: () => Promise.reject(new Error("503 service unavailable")),
    };
    const result = await decideWithJev({
      pending: [balance],
      candidates: candidatesFrom([balance, typeface]),
      jev: client,
    });
    expect(result.decisions.size).toBe(0);
    expect(result.warnings[0]).toContain("Jev grouping failed");
  });
});

describe("nameEfforts", () => {
  function stubNaming(
    names: { label: string; name: string; cohesion?: "cohesive" | "mixed"; reason?: string }[],
  ) {
    const seen: string[][] = [];
    const levels: string[] = [];
    const candidates: string[][] = [];
    const client: NamingClient = {
      async name(level, groups) {
        levels.push(level);
        seen.push(groups.map((group) => group.label));
        candidates.push(groups.flatMap((group) => group.candidates));
        return {
          names: names.map((entry) => ({
            label: entry.label,
            name: entry.name,
            cohesion: entry.cohesion ?? ("cohesive" as const),
            reason: entry.reason ?? null,
          })),
          warnings: [],
          calls: 1,
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    };
    return { client, seen, levels, candidates };
  }

  const efforts = new Map([["gift-cards", [balance]]]);
  const summaryOf = () => "Show gift card balance in the cart";

  it("spends nothing when every effort's member set is already named, which is what keeps an unchanged rescan free", async () => {
    const { client, seen } = stubNaming([]);
    const result = await nameEfforts({
      efforts,
      cachedName: () => ({ name: "Gift cards across the store", cohesion: null }),
      summaryOf,
      naming: client,
    });
    expect(seen).toHaveLength(0);
    expect(result.usage.calls).toBe(0);
  });

  it("asks once for every changed effort rather than once per effort, because the naming call is the expensive one", async () => {
    const { client, seen } = stubNaming([
      { label: "a", name: "Gift cards across the store" },
      { label: "b", name: "Seasonal reading list" },
    ]);
    await nameEfforts({
      efforts: new Map([
        ["a", [balance]],
        ["b", [typeface]],
      ]),
      cachedName: () => undefined,
      summaryOf,
      naming: client,
    });
    expect(seen).toEqual([["a", "b"]]);
  });

  it("keys the name by the member set, so an effort that neither gained nor lost a cluster is never paid for twice", async () => {
    const { client } = stubNaming([
      { label: "gift-cards", name: "Gift cards across the store" },
    ]);
    const result = await nameEfforts({
      efforts,
      cachedName: () => undefined,
      summaryOf,
      naming: client,
    });
    expect([...result.names.keys()]).toEqual([effortMemberHash([balance])]);
  });

  it("drops a name outside the 3-8 word window, because a name worse than the title it replaces is not worth showing", async () => {
    const { client } = stubNaming([{ label: "gift-cards", name: "Platform" }]);
    const result = await nameEfforts({
      efforts,
      cachedName: () => undefined,
      summaryOf,
      naming: client,
    });
    // The name is empty, so the effort falls back to a member's own summary…
    expect([...result.names.values()].map((named) => named.name)).toEqual([""]);
  });

  it("caches the REJECTION rather than nothing, because re-asking about a group whose name keeps coming back unusable would cost a call on every single scan", async () => {
    const first = stubNaming([{ label: "gift-cards", name: "Platform" }]);
    const rejected = await nameEfforts({
      efforts,
      cachedName: () => undefined,
      summaryOf,
      naming: first.client,
    });
    const cache = rejected.names;
    const second = stubNaming([]);
    const again = await nameEfforts({
      efforts,
      cachedName: (hash) => cache.get(hash),
      summaryOf,
      naming: second.client,
    });
    expect(second.seen).toHaveLength(0);
    expect(again.usage.calls).toBe(0);
  });

  it("retries a label the call omitted, because an incomplete response is not a successful answer", async () => {
    const { client } = stubNaming([]);
    const result = await nameEfforts({
      efforts,
      cachedName: () => undefined,
      summaryOf,
      naming: client,
    });
    expect(result.names.size).toBe(0);
    expect(result.usage.calls).toBe(1);
  });

  it("strips a trailing period and an accidental ticket prefix from a written name, because effort names are labels and not sentences", async () => {
    const { client } = stubNaming([
      { label: "gift-cards", name: "ABC-101: Gift cards across the store." },
    ]);
    const result = await nameEfforts({
      efforts,
      cachedName: () => undefined,
      summaryOf,
      naming: client,
    });
    expect([...result.names.values()].map((named) => named.name)).toEqual([
      "Gift cards across the store",
    ]);
  });
});

// ---------------------------------------------------------------------------
// v4: the levels above an effort, and the cohesion verdict that rides with the
// name it was asked for.
// ---------------------------------------------------------------------------

describe("assignToCandidates", () => {
  function stubJev(answers: Record<string, JevAnswer>) {
    const asked: Record<string, JevQuestion>[] = [];
    const client: JevClient = {
      async ask(_state, questions) {
        asked.push(questions);
        return { answers, usage: { input_tokens: 40, output_tokens: 8 } };
      },
    };
    return { client, asked };
  }

  const members = [
    { key: "h1", name: "Author pages refresh", description: "ABC-1, ABC-2" },
    { key: "h2", name: "Wishlist sharing for readers", description: "ABC-3" },
    { key: "h3", name: "Seasonal reading list", description: "ABC-9" },
  ];

  it("asks nothing when every member's assignment is already cached, which is what keeps an unchanged rescan free at THIS level and not just the bottom one", async () => {
    const { client, asked } = stubJev({});
    const result = await assignToCandidates({
      pending: [],
      candidates: [
        { label: "Gift cards", members: ["a"] },
        { label: "Events", members: ["b"] },
      ],
      jev: client,
      level: "program",
    });
    expect(asked).toHaveLength(0);
    expect(result.usage.calls).toBe(0);
  });

  it("asks nothing when only one candidate exists, because there is no choice to make and code already has the answer", async () => {
    const { client, asked } = stubJev({});
    await assignToCandidates({
      pending: members,
      candidates: [{ label: "Everything", members: ["a"] }],
      jev: client,
      level: "program",
    });
    expect(asked).toHaveLength(0);
  });

  it("batches every pending member into shared calls, because one call per effort would multiply cost by the size of the board", async () => {
    const { client, asked } = stubJev({});
    await assignToCandidates({
      pending: members,
      candidates: [
        { label: "Gift cards", members: ["a"] },
        { label: "Events", members: ["b"] },
      ],
      jev: client,
      level: "program",
    });
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0] ?? {})).toEqual([
      "g0_group",
      "g0_fit",
      "g1_group",
      "g1_fit",
      "g2_group",
      "g2_fit",
    ]);
  });

  it("normalizes the rubric score into the 0-1 range the confidence threshold is expressed in, so one setting governs every level", async () => {
    const { client } = stubJev({
      g0_group: { type: "choice", choice: "Gift cards", confidence: 0.9 },
      g0_fit: { type: "score", score: 4, confidence: 0.9 },
      g1_group: { type: "choice", choice: "Gift cards", confidence: 0.4 },
      g1_fit: { type: "score", score: 0, confidence: 0.4 },
    });
    const result = await assignToCandidates({
      pending: members.slice(0, 2),
      candidates: [
        { label: "Gift cards", members: ["a"] },
        { label: "Events", members: ["b"] },
      ],
      jev: client,
      level: "program",
    });
    // Top of the rubric is a certain fit; the bottom is one the threshold will
    // route to Unsorted rather than force-fitting into a confident-looking program.
    expect(result.assignments.get("h1")).toEqual({ label: "Gift cards", fit: 1 });
    expect(result.assignments.get("h2")).toEqual({ label: "Gift cards", fit: 0 });
  });

  it("ignores a label nobody offered, because a program the seeding never produced has no members and no cache row", async () => {
    const { client } = stubJev({
      g0_group: { type: "choice", choice: "Something else", confidence: 0.9 },
      g0_fit: { type: "score", score: 4, confidence: 0.9 },
    });
    const result = await assignToCandidates({
      pending: members.slice(0, 1),
      candidates: [
        { label: "Gift cards", members: ["a"] },
        { label: "Events", members: ["b"] },
      ],
      jev: client,
      level: "program",
    });
    expect(result.assignments.size).toBe(0);
  });

  it("turns an outage into a warning and no assignments, because the previous hierarchy is better than no hierarchy", async () => {
    const client: JevClient = {
      async ask() {
        throw new Error("upstream down");
      },
    };
    const result = await assignToCandidates({
      pending: members,
      candidates: [
        { label: "Gift cards", members: ["a"] },
        { label: "Events", members: ["b"] },
      ],
      jev: client,
      level: "domain",
    });
    expect(result.assignments.size).toBe(0);
    expect(result.warnings[0]).toContain("domain");
  });
});

describe("cohesion verdicts", () => {
  function stubNaming(
    names: { label: string; name: string; cohesion?: "cohesive" | "mixed"; reason?: string }[],
  ) {
    const calls: { level: string; labels: string[] }[] = [];
    const client: NamingClient = {
      async name(level, groups) {
        calls.push({ level, labels: groups.map((group) => group.label) });
        return {
          names: names.map((entry) => ({
            label: entry.label,
            name: entry.name,
            cohesion: entry.cohesion ?? ("cohesive" as const),
            reason: entry.reason ?? null,
          })),
          warnings: [],
          calls: 1,
          inputTokens: 200,
          outputTokens: 40,
        };
      },
    };
    return { client, calls };
  }

  const groups = new Map([
    ["giftcards", [{ ticket: "ABC-1", summary: "Show gift card balance", repos: ["folio"] }]],
  ]);

  it("returns a verdict alongside the name in the SAME call, so a flag costs no extra model spend and no extra round trip", async () => {
    const { client, calls } = stubNaming([
      {
        label: "giftcards",
        name: "Author pages refresh",
        cohesion: "mixed",
        reason: "ABC-1 is about author bios; the rest are about checkout speed",
      },
    ]);
    const result = await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h-giftcards",
      cached: () => undefined,
      candidatesFor: () => [],
      naming: client,
    });
    expect(calls).toEqual([{ level: "program", labels: ["giftcards"] }]);
    expect(result.usage.calls).toBe(1);
    expect(result.names.get("h-giftcards")).toEqual({
      name: "Author pages refresh",
      cohesion: {
        verdict: "mixed",
        reason: "ABC-1 is about author bios; the rest are about checkout speed",
      },
    });
  });

  it("never alters membership when the verdict is low, because the whole value of the flag is that it DISAGREES with the grouping rather than silently fixing it", async () => {
    const { client } = stubNaming([
      { label: "giftcards", name: "Author pages refresh", cohesion: "mixed", reason: "mixed bag" },
    ]);
    const before = JSON.stringify([...groups]);
    await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h-giftcards",
      cached: () => undefined,
      candidatesFor: () => [],
      naming: client,
    });
    // The naming call has no channel to change membership at all: it returns
    // names and verdicts, and the map it was handed is untouched.
    expect(JSON.stringify([...groups])).toBe(before);
  });

  it("caches the verdict on the same member hash as the name, so it costs nothing on a rescan and goes stale at exactly the moment the name does", async () => {
    const { client, calls } = stubNaming([]);
    const result = await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h-giftcards",
      cached: (hash) =>
        hash === "h-giftcards"
          ? { name: "Author pages refresh", cohesion: { verdict: "mixed", reason: "mixed bag" } }
          : undefined,
      candidatesFor: () => [],
      naming: client,
    });
    expect(calls).toHaveLength(0);
    expect(result.usage.calls).toBe(0);
  });

  it("drops a name outside the level's own word budget, because a program name is broader than an effort name and a wrong-width name is worse than the phrase it replaces", async () => {
    const tooLong = stubNaming([
      { label: "giftcards", name: "Author pages and reader accounts refreshed across every part of the store" },
    ]);
    const long = await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h",
      cached: () => undefined,
      candidatesFor: () => [],
      naming: tooLong.client,
    });
    expect(long.names.get("h")?.name).toBe("");

    const fits = stubNaming([{ label: "giftcards", name: "Author pages refresh" }]);
    const ok = await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h",
      cached: () => undefined,
      candidatesFor: () => [],
      naming: fits.client,
    });
    expect(ok.names.get("h")?.name).toBe("Author pages refresh");
  });

  it("carries no reason on a cohesive verdict, because a reason is the explanation for a disagreement and there is none", async () => {
    const { client } = stubNaming([
      { label: "giftcards", name: "Author pages refresh", cohesion: "cohesive", reason: "looks fine" },
    ]);
    const result = await nameGroups({
      level: "program",
      groups,
      hashOf: () => "h",
      cached: () => undefined,
      candidatesFor: () => [],
      naming: client,
    });
    expect(result.names.get("h")?.cohesion).toEqual({ verdict: "cohesive", reason: null });
  });

  it("offers Linear project names as naming candidates rather than as the answer, so a project informs the theme without deciding it", async () => {
    const { client } = stubNaming([]);
    const seen: string[][] = [];
    await nameGroups({
      level: "effort",
      groups,
      hashOf: () => "h",
      cached: () => undefined,
      candidatesFor: () => {
        seen.push(["Reader accounts", "Show gift card balance"]);
        return ["Reader accounts", "Show gift card balance"];
      },
      naming: client,
    });
    expect(seen[0]).toContain("Reader accounts");
    expect(seen[0]).toContain("Show gift card balance");
  });
});

describe("mode boundaries", () => {
  it("produces no verdict at all when no naming client runs, because `basic` and `jev` have nothing to report and a synthesized verdict would be a claim nobody made", () => {
    // `buildEfforts` is given an empty name map in those modes, so `cohesion`
    // is null by construction rather than derived from Jev's fit score — which
    // measures fit to a candidate, not internal coherence, and is a different
    // thing entirely.
    const named = buildEfforts(
      [{ label: "x", cluster: { ...balance, summary: "Show gift card balance" }, fit: 0.9 }],
      {},
      false,
    );
    expect(named[0]?.cohesion).toBeNull();
    const grouped = buildEfforts(
      [{ label: "x", cluster: { ...balance, summary: "Show gift card balance" }, fit: 0.9 }],
      {},
      true,
    );
    expect(grouped[0]?.cohesion).toBeNull();
  });
});
