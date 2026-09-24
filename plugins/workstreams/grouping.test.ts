// The grouping signals: code areas (repo is deliberately NOT a signal), the
// two-signal merge rule, and Linear in the semantic hash.
import { describe, expect, it } from "vitest";
import type { Pr, RawUnit } from "./contract.js";
import {
  AREA_COMMON_SHARE,
  MERGE_THRESHOLD,
  areaProfile,
  areaWeights,
  clusterInputHash,
  codeArea,
  mostUrgent,
  seedGroups,
  signalsBetween,
  similarity,
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
    units: [{ ...raw, ticket, lifecycle: unitLifecycle(raw), stack: null, staleness: "fresh", surfaces: [], risk: "none" }],
  };
}

function item(key: string, overrides: Partial<SeedItem> = {}): SeedItem {
  return { key, areas: new Map(), vocab: new Set(), projects: new Set(), parents: new Set(), ...overrides };
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
    ];
    for (const [a, b] of pairs) expect(similarity(a, b)).toBe(0);
  });

  it("merges when two independent signals agree", () => {
    expect(similarity(item("a", { areas: area, vocab }), item("b", { areas: area, vocab }))).toBeGreaterThan(MERGE_THRESHOLD);
  });

  it("keeps a pair sharing ONLY a Linear project apart: Linear informs, it never decides", () => {
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
});

describe("Linear in the semantic hash", () => {
  it("hashes a cluster with no Linear detail exactly as before, and a state change never re-asks", () => {
    const plain = cluster("ABC-1", "quill", []);
    expect(clusterInputHash({ ...plain, linear: null })).toBe(clusterInputHash(plain));
    const todo = { ...plain, linear: linear({ title: "Gift cards", state: "Todo" }) };
    const done = { ...plain, linear: linear({ title: "Gift cards", state: "Done" }) };
    expect(clusterInputHash(todo)).not.toBe(clusterInputHash(plain));
    expect(clusterInputHash(todo)).toBe(clusterInputHash(done));
  });
});
