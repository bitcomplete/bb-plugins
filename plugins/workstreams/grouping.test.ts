// The grouping signals: code areas (repo is deliberately NOT a signal), the
// two-signal merge rule, thread co-occurrence, Linear as context, and the
// stable candidate labels that keep a rename from forcing re-asks.
import { describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import { planClusterAsks } from "./asks.js";
import { candidatesFrom, clusterContext, decideWithJev, nameGroups, namingContext, seedAssignables, type JevClient, type NamingClient } from "./enrich.js";
import { THREAD_SPAN_MAX, threadWeights, type ThreadTier } from "./threads.js";
import {
  AREA_COMMON_SHARE,
  MERGE_THRESHOLD,
  areaProfile,
  areaWeights,
  clusterInputHash,
  codeArea,
  groupingRole,
  mostUrgent,
  placeClusters,
  seedGroups,
  signalsBetween,
  similarity,
  summaryCandidates,
  summaryChoices,
  unitLifecycle,
  type Cluster,
  type ClusterLinear,
  type SeedItem,
} from "./workstreams.js";

function pr(title: string): Pr {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checkConclusions: [],
    url: "https://github.com/inkwell/quill/pull/7",
    title,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "dev/x",
    latestReviewStates: [],
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    latestReviews: [],
    unresolvedReviewThreads: 0,
  };
}

function cluster(ticket: string, repo: string, changedPaths: string[], title = `Work on ${ticket.toLowerCase()} alone`): Cluster {
  const raw: RawUnit = {
    path: `/c/${ticket}`,
    dirName: ticket,
    repo,
    branch: `dev/${ticket.toLowerCase()}`,
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: "2030-01-01T00:00:00Z",
    defaultBranch: "main",
    pr: pr(title),
    shipped: null,
    changedPaths,
  };
  return {
    ticket,
    lifecycle: mostUrgent([unitLifecycle(raw)]),
    staleness: "fresh",
    surfaces: [],
    risk: "none",
    units: [{ ...raw, ticket, ticketSource: "branch", lifecycle: unitLifecycle(raw), stack: null, staleness: "fresh", surfaces: [], risk: "none" }],
  };
}

function item(key: string, overrides: Partial<SeedItem> = {}): SeedItem {
  return { key, areas: new Map(), vocab: new Set(), projects: new Set(), parents: new Set(), threads: new Map(), ...overrides };
}

const linear = (overrides: Partial<ClusterLinear> = {}): ClusterLinear => ({
  title: null,
  state: null,
  project: null,
  parentIdentifier: null,
  parentTitle: null,
  url: null,
  ...overrides,
});

describe("codeArea", () => {
  it("strips container directories and keeps the next two named ones", () => {
    expect(codeArea("quill", "packages/reader-web/src/shelves/Form.tsx")).toBe("quill:reader-web/shelves");
    expect(codeArea("quill", "apps/reader/app/shelves/list/page.tsx")).toBe("quill:reader/shelves");
    expect(codeArea("quill", "services/typeset/internal/kerning/pairs.go")).toBe("quill:typeset/kerning");
  });

  it("ignores lockfiles and generated files entirely, because they change with any work and say nothing about which", () => {
    for (const path of ["package-lock.json", "apps/reader/pnpm-lock.yaml", "go.sum", "src/__generated__/types.ts", "dist/index.js", "api/v1/spine.pb.go", "src/schema.generated.ts"]) {
      expect(codeArea("quill", path)).toBeNull();
    }
  });

  it("files a root-level file under the repo's root area", () => {
    expect(codeArea("quill", "README.md")).toBe("quill:.");
  });

  it("keeps identical areas in two repos distinct, so a polyrepo's `src/search` in two services is not one area", () => {
    expect(codeArea("folio", "src/search/rank.ts")).not.toBe(codeArea("margin", "src/search/rank.ts"));
  });
});

describe("code areas as a signal", () => {
  it("gives two clusters in ONE repo but different areas no area agreement: in a monorepo the repo is shared by everything", () => {
    const a = cluster("ABC-1", "quill", ["packages/reader-web/src/shelves/Form.tsx"]);
    const b = cluster("ABC-2", "quill", ["packages/reader-web/src/receipts/Print.tsx"]);
    const items = [a, b].map((one) => item(one.ticket, { areas: areaProfile(one) }));
    expect(signalsBetween(items[0]!, items[1]!, areaWeights(items)).area).toBe(0);
  });

  it("agrees when two clusters change the same area", () => {
    const a = cluster("ABC-1", "quill", ["packages/reader-web/src/shelves/Form.tsx"]);
    const b = cluster("ABC-2", "quill", ["packages/reader-web/src/shelves/Sort.tsx"]);
    const items = [a, b].map((one) => item(one.ticket, { areas: areaProfile(one) }));
    expect(signalsBetween(items[0]!, items[1]!, areaWeights(items)).area).toBeCloseTo(1, 10);
  });

  it("gives a cluster with no changed paths no area signal at all", () => {
    expect(areaProfile(cluster("ABC-1", "quill", []))).toEqual(new Map());
  });

  it("weighs a rarely touched area above a common one, and an area over a quarter of the board at zero", () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      item(`ABC-${index}`, {
        areas: new Map([
          ...(index < 2 ? [["quill:shelves", 1] as const] : []),
          ...(index < 3 ? [["quill:spine", 1] as const] : []),
          ...(index < 4 ? [["quill:config", 1] as const] : []),
        ]),
      }),
    );
    const weights = areaWeights(items);
    expect(AREA_COMMON_SHARE * items.length).toBe(3);
    expect(weights.get("quill:shelves")!).toBeGreaterThan(weights.get("quill:spine")!);
    expect(weights.get("quill:config")).toBe(0);
  });

  it("never zeroes an area shared by exactly two items, however small the board: that is the most specific evidence there is", () => {
    const items = [item("a", { areas: new Map([["quill:shelves", 1]]) }), item("b", { areas: new Map([["quill:shelves", 1]]) }), item("c")];
    expect(areaWeights(items).get("quill:shelves")).toBeGreaterThan(0);
  });
});

describe("the two-signal merge rule", () => {
  const area = new Map([["quill:shelves", 3]]);
  const vocab = new Set(["shelves", "reading"]);

  it("lets NO single signal merge a pair, whichever signal it is", () => {
    const pairs: [SeedItem, SeedItem][] = [
      [item("a", { areas: area }), item("b", { areas: area })],
      [item("a", { vocab }), item("b", { vocab })],
      [item("a", { projects: new Set(["Print run"]), parents: new Set(["ABC-0"]) }), item("b", { projects: new Set(["Print run"]), parents: new Set(["ABC-0"]) })],
      [item("a", { threads: new Map([["thr-1", 1]]) }), item("b", { threads: new Map([["thr-1", 1]]) })],
    ];
    for (const [a, b] of pairs) expect(similarity(a, b)).toBe(0);
  });

  it("merges when two independent signals agree", () => {
    expect(similarity(item("a", { areas: area, vocab }), item("b", { areas: area, vocab }))).toBeGreaterThan(MERGE_THRESHOLD);
    const linearAndThread = similarity(
      item("a", { parents: new Set(["ABC-0"]), threads: new Map([["thr-1", 1]]) }),
      item("b", { parents: new Set(["ABC-0"]), threads: new Map([["thr-1", 1]]) }),
    );
    expect(linearAndThread).toBeGreaterThan(MERGE_THRESHOLD);
  });

  it("keeps a pair sharing ONLY a Linear project apart: with no second signal at all, Linear merges nothing", () => {
    const a = { ...cluster("ABC-1", "quill", ["src/shelves/a.ts"], "Tune search ranking weights"), linear: linear({ project: "Print run" }) };
    const b = { ...cluster("ABC-9", "folio", ["src/spine/b.ts"], "Refresh the seasonal reading list"), linear: linear({ project: "Print run" }) };
    expect(seedGroups([a, b])).toHaveLength(2);
  });

  it("keeps two clusters apart that share only a repo, because a repo is not a grouping signal", () => {
    const a = cluster("ABC-1", "quill", [], "Tune search ranking weights");
    const b = cluster("ABC-2", "quill", [], "Refresh the seasonal reading list");
    expect(seedGroups([a, b])).toHaveLength(2);
  });

  it("merges a pair a shared Linear parent AND a shared code area both point at", () => {
    const a = { ...cluster("ABC-1", "quill", ["src/shelves/a.ts"], "Tune search ranking weights"), linear: linear({ parentIdentifier: "ABC-0" }) };
    const b = { ...cluster("ABC-2", "quill", ["src/shelves/b.ts"], "Refresh the seasonal reading list"), linear: linear({ parentIdentifier: "ABC-0" }) };
    expect(seedGroups([a, b])).toHaveLength(1);
  });

  it("uses a shared strong thread as one of the two signals", () => {
    const a = cluster("ABC-1", "quill", ["src/shelves/a.ts"], "Tune search ranking weights");
    const b = cluster("ABC-2", "quill", ["src/shelves/b.ts"], "Refresh the seasonal reading list");
    expect(seedGroups([a, b])).toHaveLength(2);
    const threads = new Map([["ABC-1", new Map([["thr-1", 1]])], ["ABC-2", new Map([["thr-1", 1]])]]);
    expect(seedGroups([a, b], { threads })).toHaveLength(1);
  });
});

describe("threadWeights", () => {
  const links = (entries: [string, [string, ThreadTier][]][]) =>
    new Map(entries.map(([thread, clusters]) => [thread, new Map(clusters)]));

  it("gives each pair a thread strongly links 1/(n−1), so a focused thread counts more than a sprawling one", () => {
    const weights = threadWeights(
      links([
        ["thr-pair", [["ABC-1", "started"], ["ABC-2", "environment"]]],
        ["thr-four", [["ABC-1", "ticket"], ["ABC-3", "ticket"], ["ABC-4", "ticket"], ["ABC-5", "ticket"]]],
      ]),
    );
    expect(weights.get("ABC-1")?.get("thr-pair")).toBe(1);
    expect(weights.get("ABC-1")?.get("thr-four")).toBeCloseTo(1 / 3, 10);
  });

  it("ignores paths links, so a broad planning thread cannot glue the board together", () => {
    const weights = threadWeights(links([["thr-plan", [["ABC-1", "paths"], ["ABC-2", "paths"], ["ABC-3", "ticket"]]]]));
    expect(weights.size).toBe(0);
  });

  it("gives nothing for a thread linking one cluster, or more than the span cutoff", () => {
    const wide = Array.from({ length: THREAD_SPAN_MAX + 1 }, (_, index): [string, ThreadTier] => [`ABC-${index}`, "ticket"]);
    const atCap = wide.slice(0, THREAD_SPAN_MAX);
    expect(threadWeights(links([["thr-solo", [["ABC-1", "started"]]], ["thr-wide", wide]])).size).toBe(0);
    expect(threadWeights(links([["thr-cap", atCap]])).size).toBe(THREAD_SPAN_MAX);
  });

  it("is deterministic: the same links give the same weights whatever order they arrive in", () => {
    const a = threadWeights(links([["t1", [["ABC-1", "ticket"], ["ABC-2", "ticket"]]], ["t2", [["ABC-2", "ticket"], ["ABC-3", "ticket"]]]]));
    const b = threadWeights(links([["t2", [["ABC-3", "ticket"], ["ABC-2", "ticket"]]], ["t1", [["ABC-2", "ticket"], ["ABC-1", "ticket"]]]]));
    for (const key of ["ABC-1", "ABC-2", "ABC-3"]) expect([...(a.get(key) ?? [])].sort()).toEqual([...(b.get(key) ?? [])].sort());
  });
});

describe("stable candidate labels one level up", () => {
  it("keeps every candidate label when an effort is renamed, so no cached program assignment vanishes and nothing is re-asked", () => {
    const members = (names: string[]) =>
      ["effort-a", "effort-b", "effort-c"].map((id, index) => ({
        key: `hash-${id}`,
        id,
        name: names[index]!,
        description: "",
        item: item(`hash-${id}`, { areas: new Map([["quill:shelves", 1]]), vocab: new Set(["shelves"]) }),
      }));
    const before = seedAssignables(members(["Shelf sorting", "Shelf search", "Shelf export"]));
    const after = seedAssignables(members(["Reading list tidy-up", "Shelf search", "Shelf export"]));
    const cached = new Map(before.flatMap((candidate) => candidate.members.map((name) => [name, candidate.label])));
    const labels = new Set(after.map((candidate) => candidate.label));
    const reAsked = [...cached.values()].filter((label) => !labels.has(label));
    expect(reAsked).toEqual([]);
    expect(after.map((candidate) => candidate.label)).toEqual(before.map((candidate) => candidate.label));
  });
});

describe("Linear as context", () => {
  it("adds the Linear title to the summary choices, and changes nothing without Linear", () => {
    const plain = cluster("ABC-1", "quill", [], "Show gift card balance in the cart");
    expect(summaryChoices(plain)).toEqual(summaryCandidates(plain));
    const withLinear = { ...plain, linear: linear({ title: "Gift card balances on the cart page" }) };
    expect(summaryChoices(withLinear)).toEqual(["Show gift card balance in the cart", "Gift card balances on the cart page"]);
  });

  it("hashes a cluster with no Linear detail exactly as before, and a state change never re-asks", () => {
    const plain = cluster("ABC-1", "quill", []);
    expect(clusterInputHash({ ...plain, linear: null })).toBe(clusterInputHash(plain));
    const todo = { ...plain, linear: linear({ title: "Gift cards", state: "Todo" }) };
    const done = { ...plain, linear: linear({ title: "Gift cards", state: "Done" }) };
    expect(clusterInputHash(todo)).not.toBe(clusterInputHash(plain));
    expect(clusterInputHash(todo)).toBe(clusterInputHash(done));
  });

  it("labels each context line by what it is, and bounds and dedupes the set", () => {
    const one = { ...cluster("ABC-1", "quill", []), linear: linear({ title: "Gift cards", parentTitle: "Checkout", project: "Print run" }) };
    expect(clusterContext(one, ["Tidy the cart"])).toEqual([
      "Linear ABC-1: Gift cards",
      "Linear parent: Checkout",
      "Linear project: Print run",
      "Thread: Tidy the cart",
    ]);
    expect(namingContext(["a", " a ", "", ...Array.from({ length: 40 }, (_, index) => `line ${index}`)])).toHaveLength(20);
  });

  it("sends naming context only when there is some, keeps the Linear project one candidate among several, and never names from context", async () => {
    const sent: unknown[] = [];
    const naming: NamingClient = {
      async name(_level, groups) {
        sent.push(...groups);
        return { names: groups.map((group) => ({ label: group.label, name: "Gift card balances in checkout", cohesion: "cohesive" as const, reason: null })), warnings: [], calls: 1, inputTokens: 1, outputTokens: 1 };
      },
    };
    const members = [{ ticket: "ABC-1", summary: "Show gift card balance", repos: ["quill"] }];
    await nameGroups({
      level: "effort",
      groups: new Map([["with", members], ["without", members]]),
      hashOf: (label) => label,
      cached: () => undefined,
      candidatesFor: () => ["Print run", "Show gift card balance"],
      contextFor: (label) => (label === "with" ? ["Linear project: Print run"] : []),
      naming,
    });
    expect(sent).toEqual([
      expect.objectContaining({ label: "with", context: ["Linear project: Print run"], candidates: ["Print run", "Show gift card balance"] }),
      expect.not.objectContaining({ context: expect.anything() }),
    ]);
  });
});

describe("with no Linear detail, nothing changes", () => {
  it("sends Jev exactly the cluster state it always did, and the Linear title only when one is known", async () => {
    const states: unknown[] = [];
    const jev: JevClient = {
      async ask(state) {
        states.push(state);
        return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    const plain = cluster("ABC-1", "quill", ["src/shelves/a.ts"]);
    const other = cluster("ABC-2", "quill", ["src/spine/b.ts"]);
    await decideWithJev({ pending: [plain], candidates: candidatesFrom([plain, other]), jev });
    await decideWithJev({ pending: [{ ...plain, linear: linear({ title: "Shelf sorting" }) }], candidates: candidatesFrom([plain, other]), jev });
    const [without, withLinear] = states as { clusters: Record<string, unknown>[] }[];
    expect(Object.keys(without!.clusters[0]!)).toEqual(["ticket", "repos", "prTitles"]);
    expect(withLinear!.clusters[0]!.linear).toEqual({ title: "Shelf sorting", project: null, parent: null });
  });
});

describe("ticketless checkouts, keyed on their pull request", () => {
  /** A checkout with no ticket: its cluster is keyed by directory, as buildBoard keys it. */
  function ticketless(dirName: string, state: "OPEN" | "MERGED" | "CLOSED" | null, paths = ["src/shelves/a.ts"]): Cluster {
    const base = cluster(dirName, "quill", paths, `Bump the ${dirName} shelf index`);
    const unit = { ...base.units[0]!, ticket: null, ticketSource: null, branch: `chore/${dirName}`, pr: state === null ? null : { ...pr(`Bump the ${dirName} shelf index`), state } };
    const lifecycle = unitLifecycle(unit);
    return { ...base, lifecycle, units: [{ ...unit, lifecycle }] };
  }
  const open = ticketless("quill-fix", "OPEN");
  const merged = ticketless("quill-bump", "MERGED");
  const closed = ticketless("quill-try", "CLOSED");
  const clone = ticketless("quill", null);

  it("groups a ticketed cluster or an OPEN ticketless PR, sets aside a finished one, and leaves a bare clone out", () => {
    expect(groupingRole(cluster("ABC-1", "quill", []))).toBe("grouped");
    expect(groupingRole(open)).toBe("grouped");
    expect(groupingRole(merged)).toBe("finished");
    expect(groupingRole(closed)).toBe("finished");
    expect(groupingRole(clone)).toBe("clone");
  });

  it("seeds candidates from grouped work only, so no slot is held by something that can never be placed in it", () => {
    const members = candidatesFrom([cluster("ABC-1", "quill", ["src/shelves/b.ts"]), open, merged, closed, clone]).flatMap((c) => c.members.map((m) => m.ticket));
    expect(members.sort()).toEqual(["ABC-1", "quill-fix"]);
  });

  it("never plans an ask for a finished PR or a bare clone, and an open PR that merges leaves the asked set without a re-ask", () => {
    const plan = planClusterAsks({
      clusters: [open, merged, clone].map((c) => ({ key: c.ticket, hash: clusterInputHash(c), decision: undefined, grouped: groupingRole(c) === "grouped" })),
      labels: new Set(),
      memory: new Map(),
    });
    expect(plan.ask.map((ask) => ask.key)).toEqual(["quill-fix"]);
    // The same checkout, a scan later, with its PR merged: same key, same hash, nothing asked.
    const after = ticketless("quill-fix", "MERGED");
    expect(clusterInputHash(after)).toBe(clusterInputHash(open));
    const next = planClusterAsks({
      clusters: [{ key: after.ticket, hash: clusterInputHash(after), decision: undefined, grouped: groupingRole(after) === "grouped" }],
      labels: new Set(),
      memory: plan.next,
    });
    expect(next.ask).toEqual([]);
  });

  it("places an open ticketless PR like any grouped cluster, files finished PRs under No ticket and keeps clones in Unsorted, whatever was cached", () => {
    const placed = placeClusters({
      workstreams: [{ name: "Unsorted", clusters: [open, merged, clone] }],
      decisionFor: () => ({ summary: null, assignment: { label: "Shelf index", fit: 0.9 } }),
      overrides: {},
      threshold: 0.6,
      grouped: true,
    });
    expect(Object.fromEntries(placed.map((entry) => [entry.cluster.ticket, entry.label]))).toEqual({
      "quill-fix": "Shelf index",
      "quill-bump": "No ticket",
      quill: "Unsorted",
    });
  });
});

describe("a shared Linear parent or project merges with any second signal", () => {
  // One shared word out of twelve: nonzero, but far below the signal floor.
  const weakVocab = (own: string) => new Set(["shelves", ...Array.from({ length: 11 }, (_, i) => `${own}${i}`)]);
  // One small shared area beside two large private ones.
  const weakArea = (own: string) => new Map([["quill:shelves", 1], [`quill:${own}`, 20]]);

  it("merges a parent share whose only other agreement is weak vocabulary", () => {
    const a = item("a", { parents: new Set(["ABC-0"]), vocab: weakVocab("a") });
    const b = item("b", { parents: new Set(["ABC-0"]), vocab: weakVocab("b") });
    expect(signalsBetween(a, b, areaWeights([a, b])).vocab).toBeLessThan(0.1);
    expect(similarity(a, b)).toBeGreaterThan(MERGE_THRESHOLD);
  });

  it("merges a project share whose only other agreement is a weak code area", () => {
    const a = item("a", { projects: new Set(["Print run"]), areas: weakArea("a") });
    const b = item("b", { projects: new Set(["Print run"]), areas: weakArea("b") });
    const weights = areaWeights([a, b]);
    expect(signalsBetween(a, b, weights).area).toBeGreaterThan(0);
    expect(signalsBetween(a, b, weights).area).toBeLessThan(0.1);
    expect(similarity(a, b, weights)).toBeGreaterThan(MERGE_THRESHOLD);
  });

  it("does NOT merge a Linear share when every other signal is zero", () => {
    const a = item("a", { parents: new Set(["ABC-0"]), projects: new Set(["Print run"]), vocab: new Set(["shelves"]) });
    const b = item("b", { parents: new Set(["ABC-0"]), projects: new Set(["Print run"]), vocab: new Set(["spine"]) });
    expect(similarity(a, b)).toBe(0);
  });

  it("leaves pairs with no Linear share on the two-signal rule and the threshold", () => {
    expect(similarity(item("a", { vocab: weakVocab("a") }), item("b", { vocab: weakVocab("b") }))).toBe(0);
    const a = item("a", { parents: new Set(["ABC-0"]), vocab: weakVocab("a") });
    const b = item("b", { parents: new Set(["ABC-5"]), vocab: weakVocab("b") });
    expect(similarity(a, b)).toBe(0);
  });
});
