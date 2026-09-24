import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_CHARS,
  detailQuery,
  parseDetails,
  parseLinearKeys,
  parseWorkspace,
  planFetch,
  projectNameOf,
  routeTeams,
  ticketPrefix,
} from "./linear.js";

describe("parseLinearKeys", () => {
  it("splits on commas and any whitespace, because a secret setting cannot be multi-line", () => {
    expect(parseLinearKeys("lin_api_a, lin_api_b\tlin_api_c  ,lin_api_d")).toEqual([
      "lin_api_a",
      "lin_api_b",
      "lin_api_c",
      "lin_api_d",
    ]);
  });

  it("merges the old single-key setting with the new list, so a key entered before the list existed keeps working", () => {
    expect(parseLinearKeys("lin_api_new", "lin_api_old")).toEqual(["lin_api_new", "lin_api_old"]);
  });

  it("drops duplicates and blanks, and reads a missing setting as no keys", () => {
    expect(parseLinearKeys("lin_api_a,,lin_api_a", "lin_api_a", undefined, "")).toEqual(["lin_api_a"]);
    expect(parseLinearKeys(undefined, "")).toEqual([]);
  });
});

describe("team routing", () => {
  const inkwell = { keyIndex: 0, name: "Inkwell", urlKey: "inkwell", teams: ["ABC", "OPS"] };
  const press = { keyIndex: 1, name: "Inkwell Press", urlKey: "inkwell-press", teams: ["WEB", "OPS"] };

  it("routes each ticket to the key whose workspace owns its prefix", () => {
    const { owner } = routeTeams([inkwell, press]);
    const plan = planFetch(["ABC-101", "WEB-7", "ABC-102"], owner);
    expect(plan.byKey.get(0)).toEqual(["ABC-101", "ABC-102"]);
    expect(plan.byKey.get(1)).toEqual(["WEB-7"]);
    expect(plan.unowned).toEqual([]);
  });

  it("leaves a prefix no key owns unowned rather than guessing a workspace, because a wrong workspace answers about a different ticket", () => {
    const { owner } = routeTeams([inkwell]);
    expect(planFetch(["SHOP-12"], owner)).toEqual({ byKey: new Map(), unowned: ["SHOP-12"] });
  });

  it("gives a team two keys claim to the first key, whatever order discovery finished in, and reports it once", () => {
    const forward = routeTeams([inkwell, press]);
    const backward = routeTeams([press, inkwell]);
    expect(forward.owner.get("OPS")).toBe(0);
    expect(backward.owner.get("OPS")).toBe(0);
    expect(forward.duplicates).toEqual(["OPS"]);
  });

  it("routes by the prefix before the last dash, uppercased", () => {
    expect(ticketPrefix("abc-101")).toBe("ABC");
  });

  it("reads a workspace response by key index and never needs the key itself", () => {
    const workspace = parseWorkspace(3, {
      data: { viewer: { organization: { name: "Inkwell", urlKey: "inkwell" } }, teams: { nodes: [{ key: "abc" }, { key: "OPS" }] } },
    });
    expect(workspace).toEqual({ keyIndex: 3, name: "Inkwell", urlKey: "inkwell", teams: ["ABC", "OPS"] });
    expect(parseWorkspace(0, { errors: [{ message: "Authentication required" }] })).toBeNull();
  });
});

describe("the batched detail query", () => {
  it("aliases one issue per ticket in a single query, so a batch costs one request", () => {
    const query = detailQuery(["ABC-101", "ABC-102"]);
    expect(query).toContain('t0: issue(id: "ABC-101")');
    expect(query).toContain('t1: issue(id: "ABC-102")');
    expect(query.match(/issue\(/gu)).toHaveLength(2);
    for (const field of ["title", "description", "state { name type }", "project { id name }", "parent { identifier title }", "labels { nodes { name } }", "url", "updatedAt"]) {
      expect(query).toContain(field);
    }
  });

  it("reads every field, caps the description, and caches a missing issue as null so it is not re-asked every scan", () => {
    const details = parseDetails(["ABC-101", "ABC-404"], {
      data: {
        t0: {
          identifier: "ABC-101",
          title: "Gift card balances",
          description: "x".repeat(2_000),
          state: { name: "In Progress", type: "started" },
          project: { id: "p1", name: "Checkout polish" },
          parent: { identifier: "ABC-100", title: "Gift cards" },
          labels: { nodes: [{ name: "frontend" }] },
          url: "https://linear.app/inkwell/issue/ABC-101",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        t1: null,
      },
    });
    const found = details?.get("ABC-101");
    expect(found?.title).toBe("Gift card balances");
    expect(found?.description).toHaveLength(DESCRIPTION_CHARS);
    expect(found?.project).toEqual({ id: "p1", name: "Checkout polish" });
    expect(found?.parent).toEqual({ identifier: "ABC-100", title: "Gift cards" });
    expect(found?.labels).toEqual(["frontend"]);
    expect(found?.source).toBe("key");
    expect(details?.get("ABC-404")).toBeNull();
    expect(parseDetails(["ABC-1"], { errors: [] })).toBeNull();
  });

  it("names a ticket by its project, else its parent's title, exactly as the old single-key path did", () => {
    const base = parseDetails(["ABC-1"], { data: { t0: { identifier: "ABC-1", parent: { identifier: "ABC-0", title: "Gift cards" } } } })?.get("ABC-1");
    expect(projectNameOf(base)).toBe("Gift cards");
    expect(projectNameOf(null)).toBeNull();
  });
});
